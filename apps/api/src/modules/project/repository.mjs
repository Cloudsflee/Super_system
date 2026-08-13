import { asJson, id } from '../../crypto.mjs';
import { auditStatement } from '../platform/repository.mjs';

/* Persistence boundary for Project-owned records.  Cross-module statements
 * are accepted as data so a caller can compose one SQLite transaction without
 * moving another module's SQL into this repository. */
export class ProjectRepository {
  constructor(db) {
    this.db = db;
  }

  query(sql, params = []) { return this.db.query(sql, params); }
  get(sql, params = []) { return this.db.get(sql, params); }
  run(sql, params = []) { return this.db.run(sql, params); }
  transaction(statements) { return this.db.transaction(statements); }

  listProjects(includePurged = false) {
    return this.db.query(
      includePurged
        ? 'SELECT * FROM projects ORDER BY updated_at DESC,id'
        : "SELECT * FROM projects WHERE status <> 'purged' ORDER BY updated_at DESC,id"
    );
  }

  project(projectId) { return this.db.get('SELECT * FROM projects WHERE id=?', [String(projectId)]); }

  createDraft({ projectId, name, description, intakeId, mode, sourceKind, sourceLocator,
    workflowDraftStatement, briefHash, timestamp, bindingStatement, actor }) {
    return this.db.transaction([
      { sql: `INSERT INTO projects(
        id,name,description,status,revision,onboarding_state,confirmed_brief_revision,confirmed_brief_hash,
        workflow_draft_id,workflow_draft_revision,created_at,updated_at,archived_at,trashed_at,purged_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [projectId, name, description, 'draft', 1, 'draft', null, '', null, 1, timestamp, timestamp, null, null, null] },
      { sql: `INSERT INTO project_intakes(
        id,project_id,status,payload_json,created_at,updated_at,mode,revision,attempt,operation_id,
        source_kind,source_locator,source_revision,source_hash,result_json,error_code,completed_at,cancelled_at,interrupted_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [intakeId, projectId, 'draft', asJson({}), timestamp, timestamp, mode, 1, 0, null, sourceKind, sourceLocator, '', '', '{}', '', null, null, null] },
      workflowDraftStatement,
      { sql: 'UPDATE projects SET workflow_draft_id=? WHERE id=?', params: [workflowDraftStatement.params[0], projectId] },
      { sql: 'INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)', params: [projectId, 1, asJson({}), briefHash, timestamp] },
      { sql: `INSERT INTO brief_heads(project_id,revision,updated_at,confirmed_revision,confirmation_revision,confirmed_at,confirmed_by,confirmed_hash)
        VALUES(?,?,?,?,?,?,?,?)`, params: [projectId, 1, timestamp, null, 0, null, '', ''] },
      bindingStatement,
      auditStatement('project.created', 'project', projectId, { name, mode, source_kind: sourceKind }, actor, timestamp)
    ]);
  }

  updateProject({ projectId, expectedRevision, name, description, timestamp, audit }) {
    return this.db.transaction([
      { sql: `UPDATE projects SET name=COALESCE(?,name),description=COALESCE(?,description),revision=revision+1,updated_at=? WHERE id=? AND revision=?`, params: [name, description, timestamp, projectId, expectedRevision], expect_changes: 1 },
      audit || auditStatement('project.updated', 'project', projectId, { expected_revision: expectedRevision }, undefined, timestamp)
    ]);
  }

  briefs(projectId) { return this.db.query('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC', [projectId]); }

  brief(projectId, revision = null) {
    return revision == null
      ? this.db.get('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId])
      : this.db.get('SELECT * FROM brief_revisions WHERE project_id=? AND revision=?', [projectId, Number(revision)]);
  }

  nextBriefRevision(projectId) {
    return this.db.get('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM brief_revisions WHERE project_id=?', [projectId]);
  }

  createBrief({ projectId, revision, contentJson, contentHash, projectRevision, timestamp, actor, workflowStatement }) {
    return this.db.transaction([
      { sql: 'INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)', params: [projectId, revision, contentJson, contentHash, timestamp] },
      { sql: 'UPDATE brief_heads SET revision=?,updated_at=? WHERE project_id=?', params: [revision, timestamp, projectId], expect_changes: 1 },
      { sql: 'UPDATE projects SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [timestamp, projectId, projectRevision], expect_changes: 1 },
      workflowStatement,
      auditStatement('brief.created', 'project', projectId, { revision, brief_hash: contentHash, preview: true }, actor, timestamp)
    ].filter(Boolean));
  }

  intakes(projectId) { return this.db.query('SELECT * FROM project_intakes WHERE project_id=? ORDER BY created_at DESC,id', [projectId]); }
  intake(intakeId) { return this.db.get('SELECT * FROM project_intakes WHERE id=?', [intakeId]); }
  currentIntake(projectId) { return this.db.get('SELECT * FROM project_intakes WHERE project_id=? ORDER BY revision DESC,updated_at DESC LIMIT 1', [projectId]); }
  briefHead(projectId) { return this.db.get('SELECT * FROM brief_heads WHERE project_id=?', [projectId]); }

  startIntake({ intakeId, projectId, mode, operationId, sourceKind, sourceLocator, projectRevision, timestamp, actor }) {
    return this.db.transaction([
      { sql: `UPDATE project_intakes SET status='running',mode=?,revision=revision+1,attempt=attempt+1,operation_id=?,source_kind=?,source_locator=?,error_code='',cancelled_at=NULL,interrupted_at=NULL,updated_at=? WHERE id=? AND status IN ('draft','failed','cancelled')`, params: [mode, operationId, sourceKind, sourceLocator, timestamp, intakeId], expect_changes: 1 },
      { sql: `UPDATE projects SET onboarding_state='running',revision=revision+1,updated_at=? WHERE id=? AND revision=?`, params: [timestamp, projectId, projectRevision], expect_changes: 1 },
      auditStatement('project.intake.started', 'project_intake', intakeId, { project_id: projectId, mode, source_kind: sourceKind, operation_id: operationId }, actor, timestamp)
    ]);
  }

  cancelIntake({ intakeId, projectId, timestamp, actor, requireStatus = true }) {
    return this.db.transaction([
      { sql: `UPDATE project_intakes SET status='cancelled',revision=revision+1,cancelled_at=?,updated_at=? WHERE id=?${requireStatus ? " AND status IN ('running','draft')" : ''}`, params: [timestamp, timestamp, intakeId], ...(requireStatus ? { expect_changes: 1 } : {}) },
      { sql: 'UPDATE projects SET onboarding_state=\'cancelled\',revision=revision+1,updated_at=? WHERE id=?', params: [timestamp, projectId] },
      actor === undefined ? null : auditStatement('project.intake.cancelled', 'project_intake', intakeId, {}, actor, timestamp)
    ].filter(Boolean));
  }

  confirmBrief({ projectId, briefRevision, briefHash, projectRevision, timestamp, actor, workflowStatement, event }) {
    return this.db.transaction([
      { sql: 'UPDATE brief_heads SET confirmed_revision=?,confirmation_revision=confirmation_revision+1,confirmed_at=?,confirmed_by=?,confirmed_hash=?,updated_at=? WHERE project_id=? AND revision=?', params: [briefRevision, timestamp, actor || 'usr_local_owner', briefHash, timestamp, projectId, briefRevision], expect_changes: 1 },
      { sql: `UPDATE projects SET status='active',onboarding_state='confirmed',confirmed_brief_revision=?,confirmed_brief_hash=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`, params: [briefRevision, briefHash, timestamp, projectId, projectRevision], expect_changes: 1 },
      workflowStatement,
      auditStatement('brief.confirmed', 'project', projectId, { revision: briefRevision, brief_hash: briefHash }, actor, timestamp),
      event
    ].filter(Boolean));
  }

  pendingIntakes() {
    return this.db.query("SELECT * FROM project_intakes WHERE status='running'");
  }

  markIntakeInterrupted({ intakeId, projectId, timestamp }) {
    return this.db.transaction([
      { sql: "UPDATE project_intakes SET status='failed',error_code='operation_interrupted',interrupted_at=?,updated_at=? WHERE id=? AND status='running'", params: [timestamp, timestamp, intakeId] },
      { sql: 'UPDATE projects SET onboarding_state=\'failed\',revision=revision+1,updated_at=? WHERE id=?', params: [timestamp, projectId] }
    ]);
  }

  markReady({ intakeId, projectId, sourceKind, sourceLocator, sourceRevision, sourceHash, resultJson, timestamp, actor, extraStatements = [] }) {
    return this.db.transaction([
      { sql: "UPDATE project_intakes SET status='ready',revision=revision+1,source_kind=?,source_locator=?,source_revision=?,source_hash=?,result_json=?,error_code='',completed_at=?,updated_at=? WHERE id=?", params: [sourceKind, sourceLocator, sourceRevision, sourceHash, resultJson, timestamp, timestamp, intakeId] },
      { sql: "UPDATE projects SET onboarding_state='ready',revision=revision+1,updated_at=? WHERE id=?", params: [timestamp, projectId] },
      ...extraStatements,
      auditStatement('project.intake.ready', 'project_intake', intakeId, { project_id: projectId, source_kind: sourceKind, source_revision: sourceRevision, source_hash: sourceHash }, actor, timestamp)
    ]);
  }

  markFailed({ intakeId, projectId, errorCode, timestamp, actor }) {
    return this.db.transaction([
      { sql: "UPDATE project_intakes SET status='failed',revision=revision+1,error_code=?,result_json=?,updated_at=? WHERE id=? AND status='running'", params: [errorCode, asJson({ error_code: errorCode }), timestamp, intakeId] },
      { sql: "UPDATE projects SET onboarding_state='failed',revision=revision+1,updated_at=? WHERE id=?", params: [timestamp, projectId] },
      auditStatement('project.intake.failed', 'project_intake', intakeId, { project_id: projectId, error_code: errorCode }, actor, timestamp)
    ]);
  }

  markCancelledByOperation({ intakeId, projectId, timestamp }) {
    return this.db.transaction([
      { sql: "UPDATE project_intakes SET status='cancelled',revision=revision+1,cancelled_at=?,updated_at=? WHERE id=? AND status='running'", params: [timestamp, timestamp, intakeId] },
      { sql: "UPDATE projects SET onboarding_state='cancelled',revision=revision+1,updated_at=? WHERE id=?", params: [timestamp, projectId] }
    ]);
  }

  lifecycle({ projectId, action, expectedRevision, result = {}, timestamp, actor, repositoryStatement, event }) {
    const transition = { archive: ['active', 'active', 'archived'], trash: ['active', 'archived', 'trashed'], restore: ['trashed', 'trashed', 'active'], purge: ['trashed', 'trashed', 'purged'] }[action];
    if (!transition) throw new Error('invalid_project_lifecycle');
    const [fromA, fromB, to] = transition;
    const predicate = fromA === fromB ? `status='${fromA}'` : `status IN ('${fromA}','${fromB}')`;
    return this.db.transaction([
      { sql: `UPDATE projects SET status=?,onboarding_state=CASE WHEN ?='active' THEN 'confirmed' ELSE onboarding_state END,revision=revision+1,updated_at=?,archived_at=CASE WHEN ?='archived' THEN COALESCE(archived_at,?) ELSE archived_at END,trashed_at=CASE WHEN ?='trashed' THEN ? ELSE trashed_at END,purged_at=CASE WHEN ?='purged' THEN ? ELSE purged_at END WHERE id=? AND revision=? AND (${predicate})`, params: [to, to, timestamp, to, timestamp, to, timestamp, to, timestamp, projectId, expectedRevision], expect_changes: 1 },
      repositoryStatement,
      auditStatement(`project.${action}`, 'project', projectId, result, actor, timestamp),
      event
    ].filter(Boolean));
  }
}
