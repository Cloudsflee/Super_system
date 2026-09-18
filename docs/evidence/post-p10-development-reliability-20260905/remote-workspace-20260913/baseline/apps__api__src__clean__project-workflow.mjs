import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { treeManifest } from './runner-input-provider.mjs';
import { canonicalJson, opaqueId, parseCanonicalJson, sha256Hex, utcNow } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { projectCommandOwner } from './project-domain-helpers.mjs';
import { ProjectService } from './project-service.mjs';
import { RepositoryService } from './repository-service.mjs';
import { WorkflowService } from './workflow-service.mjs';
import { OutcomeService } from './outcome-service.mjs';

const PROJECT_STATUSES = new Set(['draft', 'confirming', 'active', 'archived']);
const GENERATION_TERMINAL = new Set(['applied', 'rejected', 'failed', 'cancelled']);

/**
 * Clean P3 domain service.  It intentionally keeps external repository,
 * generator and critic calls behind small deterministic adapters; only their
 * bounded hashes and lifecycle results enter the clean database.
 */
class ProjectWorkflowCore {
  constructor({
    db,
    events,
    operations,
    policy,
    authorization,
    clock = utcNow,
    repositoryAdapter = null,
    generator = null,
    critic = null, identity = null, cas = null, config = {}
  } = {}) {
    if (!db || !events || !operations) throw new TypeError('project_workflow_dependencies_required');
    this.db = db;
    this.events = events;
    this.operations = operations;
    this.policy = policy;
    this.authorization = authorization;
    this.clock = clock;
    this.identity = identity; this.cas = cas; this.config = config;
    this.repositoryAdapter = repositoryAdapter || deterministicRepositoryAdapter();
    this.generator = generator || deterministicGenerator;
    this.critic = critic || deterministicCritic;
    this.db.__cleanOperations = operations;
    if (this.events) this.events.operations = operations;
  }

  // ----- Project and intake -------------------------------------------------

  listProjects(principal, { includeArchived = false, status = null } = {}) {
    requirePrincipal(principal);
    const rows = this.db
      .query(`SELECT * FROM projects WHERE (? = 1 OR status<>'archived') AND (? IS NULL OR status=?) ORDER BY created_at,id`, [includeArchived ? 1 : 0, status == null ? null : String(status), status == null ? null : String(status)])
      .filter((row) => this.#allowed(principal, 'read', row.id))
      .map((row) => this.#projectView(row));
    return rows;
  }

  getProject(projectId, principal) {
    const row = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', row.id);
    return this.#projectView(row, true);
  }

  createProject(input = {}, principal) {
    requirePrincipal(principal);
    this.#assertGlobalManager(principal);
    const name = requiredName(input.name);
    const description = boundedString(input.description, 65536);
    const teamId = String(input.team_id || this.#defaultTeam(principal));
    this.#assertTeamMember(principal, teamId, true);
    const key = requireKey(input.idempotency_key);
    const request = { name, description, team_id: teamId, metadata: input.metadata || {} };
    const hash = requestHash(request);
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'project.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('project');
      const intakeId = opaqueId('intake');
      const briefId = opaqueId('brief');
      const workflowId = opaqueId('workflow');
      const membershipId = opaqueId('project_membership');
      const metadata = this.#safe({ ...(input.metadata || {}) });
      const metadataJson = canonicalJson(metadata);
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'project.create',
        resourceType: 'project',
        resourceId: id,
        projectId: id,
        requestHash: hash,
        now
      });
      tx.run(
        `INSERT INTO projects(id,team_id,owner_actor_id,name,description,status,onboarding_state,current_brief_revision,confirmed_brief_revision,confirmed_brief_hash,current_workflow_revision,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,'draft','collecting',0,NULL,'',0,?,?,1,?,?,?,?)`,
        [
          id,
          teamId,
          principal.actorId,
          name,
          description,
          metadataJson,
          sha256Hex(metadataJson),
          now,
          now,
          principal.actorId,
          principal.actorId
        ]
      );
      const payload = canonicalJson({
        id,
        team_id: teamId,
        owner_actor_id: principal.actorId,
        name,
        status: 'draft',
        revision: 1
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: id,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: id,
        type: 'project.created',
        data: { project_id: id, team_id: teamId },
        payload,
        now
      });
      tx.run(
        `INSERT INTO project_intakes(id,project_id,status,mode,payload_json,payload_sha256,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?, 'collecting','brainstorm','{}',?, ?,?,?,?)`,
        [intakeId, id, sha256Hex('{}'), now, now, principal.actorId, principal.actorId]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'project_intake',
        aggregateId: intakeId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: id,
        type: 'intake.created',
        data: { intake_id: intakeId, project_id: id },
        payload: { id: intakeId, project_id: id, status: 'collecting', revision: 1 },
        now
      });
      tx.run(
        `INSERT INTO briefs(id,project_id,status,current_revision,confirmed_revision,confirmed_hash,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?, 'draft',0,NULL,'',1,?,?,?,?)`,
        [briefId, id, now, now, principal.actorId, principal.actorId]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'brief',
        aggregateId: briefId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: id,
        type: 'brief.created',
        data: { brief_id: briefId, project_id: id },
        payload: { id: briefId, project_id: id, status: 'draft', current_revision: 0, revision: 1 },
        now
      });
      tx.run(
        `INSERT INTO workflows(id,project_id,status,current_revision,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?, 'draft',0,1,?,?,?,?)`,
        [workflowId, id, now, now, principal.actorId, principal.actorId]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow',
        aggregateId: workflowId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: id,
        type: 'project.workflow_initialized',
        data: { workflow_id: workflowId, project_id: id },
        payload: { id: workflowId, project_id: id, status: 'draft', current_revision: 0, revision: 1 },
        now
      });
      tx.run(
        `INSERT INTO project_memberships(id,project_id,actor_id,role,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,'owner','active',1,?,?,?,?)`,
        [membershipId, id, principal.actorId, now, now, principal.actorId, principal.actorId]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'project_membership',
        aggregateId: membershipId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: id,
        type: 'membership.granted',
        data: { membership_id: membershipId, project_id: id, actor_id: principal.actorId, role: 'owner' },
        payload: {
          id: membershipId,
          project_id: id,
          actor_id: principal.actorId,
          role: 'owner',
          status: 'active',
          revision: 1
        },
        now
      });
      linkOperation(
        tx,
        operation.id,
        [
          ['project', id],
          ['project_intake', intakeId],
          ['brief', briefId],
          ['workflow', workflowId],
          ['project_membership', membershipId]
        ],
        now
      );
      const response = this.#projectView(tx.get('SELECT * FROM projects WHERE id=?', [id]), true, tx);
      response.operation = operationView(operation);
      saveIdempotency(tx, principal.actorId, 'project.create', key, hash, response, operation.id, now);
      return response;
    });
  }

  updateProject(projectId, input = {}, principal) {
    const current = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', current.id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const name = input.name == null ? current.name : requiredName(input.name);
    const description = input.description == null ? current.description : boundedString(input.description, 65536);
    const hash = requestHash({ project_id: current.id, name, description, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'project.update', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const row = tx.get('SELECT * FROM projects WHERE id=?', [current.id]);
      assertRevision(row, expected);
      tx.run(
        `UPDATE projects SET name=?,description=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [name, description, now, principal.actorId, current.id, expected],
        1
      );
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'project.update',
        resourceType: 'project',
        resourceId: current.id,
        projectId: current.id,
        requestHash: hash,
        now
      });
      const next = expected + 1;
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: current.id,
        revision: next,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: current.id,
        type: 'project.updated',
        data: { project_id: current.id, revision: next },
        payload: { id: current.id, name, status: row.status, revision: next },
        now
      });
      linkOperation(tx, operation.id, [['project', current.id]], now);
      const response = {
        project: this.#projectView(tx.get('SELECT * FROM projects WHERE id=?', [current.id]), true, tx),
        operation: operationView(operation)
      };
      saveIdempotency(tx, principal.actorId, 'project.update', key, hash, response, operation.id, now);
      return response;
    });
  }

  archiveProject(projectId, input = {}, principal) {
    return this.#projectLifecycle(projectId, 'archived', 'project.archived', input, principal);
  }
  restoreProject(projectId, input = {}, principal) {
    return this.#projectLifecycle(projectId, 'active', 'project.restored', input, principal);
  }

  getIntake(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    const row = this.db.get('SELECT * FROM project_intakes WHERE project_id=?', [project.id]);
    return row ? this.#intakeView(row) : null;
  }

  submitIntake(projectId, input = {}, principal, commandId = 'intake.submit') {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const intake = this.db.get('SELECT * FROM project_intakes WHERE project_id=?', [project.id]);
    if (!intake) throw notFound('intake');
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const mode = input.mode === 'existing' ? 'existing' : 'brainstorm';
    const source = sanitizeSource(this.repositoryAdapter.bindSource?.(input.source || {}) || input.source || {});
    const hash = requestHash({ project_id: project.id, mode, source, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, commandId, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const row = tx.get('SELECT * FROM project_intakes WHERE project_id=?', [project.id]);
      assertRevision(row, expected);
      if (['processing', 'submitted'].includes(row.status))
        throw stateConflict('intake is already processing', { status: row.status });
      const operation = this.operations.createInTransaction(
        tx,
        {
          actorId: principal.actorId,
          commandId,
          kind: 'intake.submit',
          resourceType: 'project_intake',
          resourceId: row.id,
          projectId: project.id,
          request: { mode, source },
          requestHash: hash,
          idempotencyKey: `op-${key}`
        },
        now
      );
      const payload = canonicalJson(input.content && typeof input.content === 'object' ? input.content : {});
      tx.run(
        `UPDATE project_intakes SET status='processing',mode=?,source_kind=?,source_locator=?,source_revision=?,source_hash=?,payload_json=?,payload_sha256=?,operation_id=?,attempt=attempt+1,revision=revision+1,updated_at=?,updated_by_actor_id=?,error_code='' WHERE id=? AND revision=?`,
        [
          mode,
          source.kind,
          source.locator,
          source.revision,
          source.hash,
          payload,
          sha256Hex(payload),
          operation.operation_id,
          now,
          principal.actorId,
          row.id,
          expected
        ],
        1
      );
      const next = expected + 1;
      appendAggregate(tx, this.events, {
        aggregateType: 'project_intake',
        aggregateId: row.id,
        revision: next,
        operationId: operation.operation_id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'intake.submitted',
        data: { intake_id: row.id, mode },
        payload: { id: row.id, project_id: project.id, status: 'processing', revision: next },
        now
      });
      linkOperation(tx, operation.operation_id, [['project_intake', row.id]], now);
      const response = {
        intake: this.#intakeView(tx.get('SELECT * FROM project_intakes WHERE id=?', [row.id])),
        operation: operationReceipt(operation)
      };
      saveIdempotency(tx, principal.actorId, commandId, key, hash, response, operation.operation_id, now);
      tx.afterCommit(() =>
        queueMicrotask(() => this.#runIntake(operation.operation_id, project.id, row.id, source).catch(() => undefined))
      );
      return response;
    });
  }

  retryIntake(projectId, input = {}, principal) {
    const intake = this.db.get('SELECT * FROM project_intakes WHERE project_id=?', [String(projectId)]);
    if (!intake) throw notFound('intake');
    if (intake.status !== 'failed') throw stateConflict('only failed intake can be retried', { status: intake.status });
    const expected = positiveRevision(input.expected_revision);
    assertRevision(intake, expected);
    return this.submitIntake(
      projectId,
      {
        ...input,
        mode: intake.mode,
        source: {
          kind: intake.source_kind,
          locator: intake.source_locator,
          revision: intake.source_revision,
          hash: intake.source_hash
        },
        expected_revision: expected
      },
      principal,
      'intake.retry'
    );
  }

  async cancelIntake(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const key = requireKey(input.idempotency_key);
    const expected = positiveRevision(input.expected_revision);
    const now = this.#time();
    const hash = requestHash({ project_id: project.id, expected_revision: expected });
    const response = await this.db.withTransaction((tx) => {
      const row = tx.get('SELECT * FROM project_intakes WHERE project_id=?', [project.id]);
      if (!row) throw notFound('intake');
      const prior = getIdempotency(tx, principal.actorId, 'intake.cancel', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      assertRevision(row, expected);
      if (!['processing', 'submitted'].includes(row.status))
        throw stateConflict('intake is not cancellable', { status: row.status });
      tx.run(
        `UPDATE project_intakes SET status='cancelled',revision=revision+1,updated_at=?,updated_by_actor_id=?,completed_at=? WHERE id=? AND revision=?`,
        [now, principal.actorId, now, row.id, expected],
        1
      );
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'intake.cancel',
        resourceType: 'project_intake',
        resourceId: row.id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'project_intake',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'intake.cancelled',
        data: { intake_id: row.id },
        payload: { id: row.id, project_id: project.id, status: 'cancelled', revision: expected + 1 },
        now
      });
      const response = {
        intake: this.#intakeView(tx.get('SELECT * FROM project_intakes WHERE id=?', [row.id])),
        operation: operationView(operation)
      };
      saveIdempotency(tx, principal.actorId, 'intake.cancel', key, hash, response, operation.id, now);
      return response;
    });
    if (!response.replayed && response.intake?.operation_id) {
      await this.#cancelExternalOperation(response.intake.operation_id, principal, `intake-cancel-${key}`);
    }
    return response;
  }

  // ----- Brief --------------------------------------------------------------

  listBriefs(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC', [project.id])
      .map((row) => this.#briefRevisionView(row));
  }

  getBrief(projectId, revision, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    const row =
      revision == null
        ? this.db.get('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [project.id])
        : this.db.get('SELECT * FROM brief_revisions WHERE project_id=? AND revision=?', [
            project.id,
            Number(revision)
          ]);
    if (!row) throw notFound('brief revision');
    return this.#briefRevisionView(row);
  }

  createBrief(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const content = normalizeBrief(input);
    const template = boundedString(input.template || 'default', 80);
    const templateId = input.template_id == null ? null : String(input.template_id);
    let templateSnapshot = null;
    if (templateId) {
      const templateRow = this.db.get("SELECT * FROM brief_templates WHERE id=? AND team_id=? AND status='active'", [templateId, project.team_id]);
      if (!templateRow) throw new PlatformError('brief_template_not_found', 'active Brief template not found', {}, 404);
      const templateRevision = Number(input.template_revision ?? templateRow.current_revision);
      if (!Number.isInteger(templateRevision) || templateRevision < 1) throw new PlatformError('schema_invalid', 'Brief template revision is invalid', {}, 422);
      const revisionRow = this.db.get('SELECT * FROM brief_template_revisions WHERE template_id=? AND revision=?', [templateId, templateRevision]);
      if (!revisionRow) throw new PlatformError('brief_template_revision_not_found', 'Brief template revision not found', {}, 404);
      templateSnapshot = { id: templateId, revision: templateRevision, sha256: revisionRow.content_sha256 };
    }
    const hash = requestHash({ project_id: project.id, content, template, template_snapshot: templateSnapshot, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'brief.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const p = tx.get('SELECT * FROM projects WHERE id=?', [project.id]);
      assertRevision(p, expected);
      const brief = tx.get('SELECT * FROM briefs WHERE project_id=?', [project.id]);
      if (!brief) throw notFound('brief');
      const revision = Number(brief.current_revision) + 1;
      const contentJson = canonicalJson(content);
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'brief.create',
        resourceType: 'brief',
        resourceId: brief.id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      const revisionId = opaqueId('brief_revision');
      if (templateSnapshot) {
        tx.run(
          `INSERT INTO brief_revisions(id,brief_id,project_id,revision,content_json,content_sha256,template,created_at,created_by_actor_id,template_id,template_revision,template_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [revisionId, brief.id, project.id, revision, contentJson, sha256Hex(contentJson), template, now, principal.actorId, templateSnapshot.id, templateSnapshot.revision, templateSnapshot.sha256]
        );
      } else {
        tx.run(
          `INSERT INTO brief_revisions(id,brief_id,project_id,revision,content_json,content_sha256,template,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?)`,
          [revisionId, brief.id, project.id, revision, contentJson, sha256Hex(contentJson), template, now, principal.actorId]
        );
      }
      appendAggregate(tx, this.events, {
        aggregateType: 'brief_revision',
        aggregateId: revisionId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'brief.revision.created',
        data: { brief_revision_id: revisionId, brief_id: brief.id, revision },
        payload: {
          id: revisionId,
          brief_id: brief.id,
          project_id: project.id,
          revision,
          content_sha256: sha256Hex(contentJson)
        },
        now
      });
      tx.run(
        `UPDATE briefs SET status='draft',current_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [revision, now, principal.actorId, brief.id, brief.revision],
        1
      );
      tx.run(
        `UPDATE projects SET current_brief_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [revision, now, principal.actorId, project.id, expected],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'brief',
        aggregateId: brief.id,
        revision: Number(brief.revision) + 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'brief.revised',
        data: { brief_id: brief.id, brief_revision: revision },
        payload: {
          id: brief.id,
          project_id: project.id,
          current_revision: revision,
          revision: Number(brief.revision) + 1
        },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: project.id,
        revision: expected + 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'project.brief_updated',
        data: { project_id: project.id, brief_revision: revision },
        payload: { id: project.id, current_brief_revision: revision, revision: expected + 1 },
        now
      });
      linkOperation(
        tx,
        operation.id,
        [
          ['brief', brief.id],
          ['brief_revision', revisionId],
          ['project', project.id]
        ],
        now
      );
      const response = {
        brief: this.#briefView(tx.get('SELECT * FROM briefs WHERE id=?', [brief.id]), tx),
        revision_record: this.#briefRevisionView(tx.get('SELECT * FROM brief_revisions WHERE id=?', [revisionId])),
        operation: operationView(operation)
      };
      saveIdempotency(tx, principal.actorId, 'brief.create', key, hash, response, operation.id, now);
      return response;
    });
  }

  confirmBrief(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'approve', project.id);
    const briefRevision = positiveRevision(input.brief_revision);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const hash = requestHash({ project_id: project.id, brief_revision: briefRevision, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'brief.confirm', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const p = tx.get('SELECT * FROM projects WHERE id=?', [project.id]);
      assertRevision(p, expected);
      const intake = tx.get('SELECT * FROM project_intakes WHERE project_id=?', [project.id]);
      if (!intake || intake.status !== 'ready')
        throw stateConflict('intake is not ready', { status: intake?.status || null });
      const brief = tx.get('SELECT * FROM briefs WHERE project_id=?', [project.id]);
      const rev = tx.get('SELECT * FROM brief_revisions WHERE project_id=? AND revision=?', [
        project.id,
        briefRevision
      ]);
      if (!brief || !rev) throw notFound('brief revision');
      if (brief.confirmed_revision === briefRevision)
        return { project: this.#projectView(p, true, tx), brief: this.#briefView(brief, tx), replayed: true };
      tx.run(
        `UPDATE briefs SET status='confirmed',confirmed_revision=?,confirmed_hash=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [briefRevision, rev.content_sha256, now, principal.actorId, brief.id, brief.revision],
        1
      );
      tx.run(
        `UPDATE projects SET status='active',onboarding_state='confirmed',confirmed_brief_revision=?,confirmed_brief_hash=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [briefRevision, rev.content_sha256, now, principal.actorId, project.id, expected],
        1
      );
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'brief.confirm',
        resourceType: 'project',
        resourceId: project.id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'brief',
        aggregateId: brief.id,
        revision: Number(brief.revision) + 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'brief.confirmed',
        data: { project_id: project.id, revision: briefRevision, brief_hash: rev.content_sha256 },
        payload: {
          id: brief.id,
          project_id: project.id,
          confirmed_revision: briefRevision,
          revision: Number(brief.revision) + 1
        },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: project.id,
        revision: expected + 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'project.confirmed',
        data: { project_id: project.id, brief_revision: briefRevision },
        payload: { id: project.id, status: 'active', confirmed_brief_revision: briefRevision, revision: expected + 1 },
        now
      });
      linkOperation(
        tx,
        operation.id,
        [
          ['project', project.id],
          ['brief', brief.id]
        ],
        now
      );
      const response = {
        project: this.#projectView(tx.get('SELECT * FROM projects WHERE id=?', [project.id]), true, tx),
        brief: this.#briefView(tx.get('SELECT * FROM briefs WHERE id=?', [brief.id]), tx),
        operation: operationView(operation)
      };
      saveIdempotency(tx, principal.actorId, 'brief.confirm', key, hash, response, operation.id, now);
      return response;
    });
  }

  previewBrief(projectId, revision, principal) {
    return this.getBrief(projectId, revision, principal);
  }

  // ----- Repository ---------------------------------------------------------

  listRepositoryConnections(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM repository_connections WHERE project_id=? ORDER BY created_at,id', [project.id])
      .map((row) => this.#connectionView(row));
  }

  async createRepositoryConnection(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const requested = { kind: input.source_kind, locator: input.source_locator, revision: input.source_revision, hash: input.source_hash };
    const bound = this.repositoryAdapter.bindSource?.(requested) || requested;
    const source = sanitizeSource(bound);
    if (source.kind === 'git' && String(input.provider || 'git') === 'git' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(source.locator || ''))) source.locator = `https://github.com/${source.locator}.git`;
    if (source.kind === 'git') source.branch = boundedString(input.branch || 'main', 256);
    const observed = ['local'].includes(source.kind) || (source.kind === 'git' && String(input.provider || 'git') === 'git')
      ? (this.repositoryAdapter?.probe ? await this.repositoryAdapter.probe(source) : null) : null;
    if (observed) { source.revision = observed.revision; source.hash = observed.hash; }
    const provider = boundedString(input.provider || (source.kind === 'github' ? 'git' : source.kind === 'local' ? 'local' : 'fixture'), 40);
    const providerProfileId = input.provider_profile_id ? String(input.provider_profile_id) : null;
    if (providerProfileId && this.identity) {
      const profile = this.identity.providerProfileSnapshot(providerProfileId, principal);
      if (profile.provider !== 'github' || profile.lifecycle_status === 'disabled' || profile.status !== 'available') throw new PlatformError('provider_profile_unavailable', 'GitHub Profile is not available', {}, 409);
    }
    const hash = requestHash({ project_id: project.id, provider, provider_profile_id: providerProfileId, source, branch: input.branch || 'main', read_only: input.read_only !== false });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'repository.connection.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('repository_connection');
      const targetId = opaqueId('repository_target');
      const lineId = opaqueId('repository_line');
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'repository.connection.create',
        resourceType: 'repository_connection',
        resourceId: id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      const metadataJson = canonicalJson({ provider, branch: boundedString(input.branch || 'main', 256), ...(providerProfileId ? { provider_profile_id: providerProfileId } : {}), ...(observed ? { manifest: observed } : {}) });
      tx.run(
        `INSERT INTO repository_connections(id,project_id,provider,credential_ref_id,status,source_kind,source_locator,source_revision,source_hash,read_only,metadata_json,metadata_sha256,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          project.id,
          provider,
          input.credential_ref_id || null,
          source.kind === 'none' ? 'pending' : 'ready',
          source.kind,
          source.locator,
          source.revision,
          source.hash,
          input.read_only === false ? 0 : 1,
          metadataJson,
          sha256Hex(metadataJson),
          now,
          now,
          principal.actorId,
          principal.actorId
        ]
      );
      tx.run(
        `INSERT INTO repository_targets(id,connection_id,name,branch,remote_ref,expected_head_sha,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          targetId,
          id,
          boundedString(input.name || 'default', 160),
          boundedString(input.branch || 'main', 256),
          '',
          source.revision,
          now,
          now,
          principal.actorId,
          principal.actorId
        ]
      );
      tx.run(
        `INSERT INTO repository_lines(id,project_id,target_id,line_kind,status,source_revision,source_hash,expected_head_sha,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'external_readonly',?,?,?,'',?,?,?,?)`,
        [
          lineId,
          project.id,
          targetId,
          source.kind === 'none' ? 'pending' : 'ready',
          source.revision,
          source.hash,
          now,
          now,
          principal.actorId,
          principal.actorId
        ]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_connection',
        aggregateId: id,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'repository.connection.created',
        data: { connection_id: id, line_id: lineId },
        payload: { id, project_id: project.id, status: source.kind === 'none' ? 'pending' : 'ready', revision: 1 },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_target',
        aggregateId: targetId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'repository.target.created',
        data: { target_id: targetId, connection_id: id },
        payload: { id: targetId, connection_id: id, revision: 1 },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_line',
        aggregateId: lineId,
        revision: 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'repository.line.created',
        data: { line_id: lineId, target_id: targetId },
        payload: {
          id: lineId,
          project_id: project.id,
          target_id: targetId,
          status: source.kind === 'none' ? 'pending' : 'ready',
          revision: 1
        },
        now
      });
      linkOperation(
        tx,
        operation.id,
        [
          ['repository_connection', id],
          ['repository_target', targetId],
          ['repository_line', lineId]
        ],
        now
      );
      const response = {
        connection: this.#connectionView(tx.get('SELECT * FROM repository_connections WHERE id=?', [id])),
        operation: operationView(operation)
      };
      saveIdempotency(tx, principal.actorId, 'repository.connection.create', key, hash, response, operation.id, now);
      return response;
    });
  }

  updateRepositoryConnection(connectionId, input = {}, principal) {
    const row = this.db.get('SELECT * FROM repository_connections WHERE id=?', [String(connectionId)]);
    if (!row) throw notFound('repository connection');
    this.#assertProject(principal, 'write', row.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const source = sanitizeSource({
      kind: input.source_kind ?? row.source_kind,
      locator: input.source_locator ?? row.source_locator,
      revision: input.source_revision ?? row.source_revision,
      hash: input.source_hash ?? row.source_hash
    });
    const now = this.#time();
    const hash = requestHash({ connection_id: row.id, source, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'repository.connection.update', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM repository_connections WHERE id=?', [row.id]);
      assertRevision(current, expected);
      tx.run(
        `UPDATE repository_connections SET source_kind=?,source_locator=?,source_revision=?,source_hash=?,status='ready',fault_code='',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [source.kind, source.locator, source.revision, source.hash, now, principal.actorId, row.id, expected],
        1
      );
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'repository.connection.update',
        resourceType: 'repository_connection',
        resourceId: row.id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_connection',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: 'repository.connection.updated',
        data: { connection_id: row.id },
        payload: { id: row.id, project_id: row.project_id, status: 'ready', revision: expected + 1 },
        now
      });
      const response = {
        connection: this.#connectionView(tx.get('SELECT * FROM repository_connections WHERE id=?', [row.id])),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'repository.connection.update', key, hash, response, op.id, now);
      return response;
    });
  }

  listRepositoryTargets(connectionId, principal) {
    const row = this.db.get('SELECT * FROM repository_connections WHERE id=?', [String(connectionId)]);
    if (!row) throw notFound('repository connection');
    this.#assertProject(principal, 'read', row.project_id);
    return this.db
      .query('SELECT * FROM repository_targets WHERE connection_id=? ORDER BY created_at,id', [row.id])
      .map((item) => this.#targetView(item));
  }

  createRepositoryTarget(connectionId, input = {}, principal) {
    const row = this.db.get('SELECT * FROM repository_connections WHERE id=?', [String(connectionId)]);
    if (!row) throw notFound('repository connection');
    this.#assertProject(principal, 'write', row.project_id);
    const key = requireKey(input.idempotency_key);
    const expected = positiveRevision(input.expected_revision);
    const name = requiredName(input.name);
    const now = this.#time();
    const hash = requestHash({ connection_id: row.id, name, branch: input.branch || 'main', expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'repository.target.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const connection = tx.get('SELECT * FROM repository_connections WHERE id=?', [row.id]);
      assertRevision(connection, expected);
      const id = opaqueId('repository_target');
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'repository.target.create',
        resourceType: 'repository_target',
        resourceId: id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      tx.run(
        `INSERT INTO repository_targets(id,connection_id,name,branch,remote_ref,expected_head_sha,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          row.id,
          name,
          boundedString(input.branch || 'main', 256),
          boundedString(input.remote_ref || '', 512),
          boundedString(input.expected_head_sha || '', 128),
          now,
          now,
          principal.actorId,
          principal.actorId
        ]
      );
      tx.run(
        `UPDATE repository_connections SET revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [now, principal.actorId, row.id, expected],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_target',
        aggregateId: id,
        revision: 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: 'repository.target.created',
        data: { target_id: id },
        payload: { id, connection_id: row.id, revision: 1 },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_connection',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: 'repository.target.created',
        data: { target_id: id, connection_id: row.id },
        payload: {
          id: row.id,
          project_id: row.project_id,
          status: connection.status,
          revision: expected + 1
        },
        now
      });
      linkOperation(tx, op.id, [['repository_connection', row.id]], now);
      const response = {
        target: this.#targetView(tx.get('SELECT * FROM repository_targets WHERE id=?', [id])),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'repository.target.create', key, hash, response, op.id, now);
      return response;
    });
  }

  synchronizeRepositoryBaselineInTransaction(tx, targetId, { projectId, expectedHeadSha, operationId, actorId, now } = {}) {
    const target = tx.get(`SELECT t.*,c.project_id,c.revision AS connection_revision,c.status AS connection_status
      FROM repository_targets t JOIN repository_connections c ON c.id=t.connection_id WHERE t.id=?`, [String(targetId)]);
    if (!target || target.project_id !== String(projectId)) throw notFound('repository target');
    const head = boundedString(expectedHeadSha, 128);
    if (head.length < 7) throw new PlatformError('schema_invalid', 'repository baseline SHA is invalid', {}, 422);
    const targetRevision = Number(target.revision) + 1;
    tx.run('UPDATE repository_targets SET expected_head_sha=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [head, targetRevision, now, actorId, target.id, target.revision], 1);
    appendAggregate(tx, this.events, {
      aggregateType: 'repository_target', aggregateId: target.id, revision: targetRevision, operationId, actorId,
      projectId: target.project_id, type: 'repository.baseline.synchronized', data: { target_id: target.id, expected_head_sha: head },
      payload: { id: target.id, connection_id: target.connection_id, expected_head_sha: head, revision: targetRevision }, now
    });
    const connectionRevision = Number(target.connection_revision) + 1;
    tx.run('UPDATE repository_connections SET source_revision=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [head, connectionRevision, now, actorId, target.connection_id, target.connection_revision], 1);
    appendAggregate(tx, this.events, {
      aggregateType: 'repository_connection', aggregateId: target.connection_id, revision: connectionRevision, operationId, actorId,
      projectId: target.project_id, type: 'repository.baseline.synchronized', data: { target_id: target.id, expected_head_sha: head },
      payload: { id: target.connection_id, project_id: target.project_id, status: target.connection_status, source_revision: head, revision: connectionRevision }, now
    });
    const lines = tx.query("SELECT * FROM repository_lines WHERE target_id=? AND status<>'removed' ORDER BY id", [target.id]);
    for (const line of lines) {
      const revision = Number(line.revision) + 1;
      tx.run("UPDATE repository_lines SET status='ready',source_revision=?,expected_head_sha=?,fault_code='',fault_json='{}',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [head, head, revision, now, actorId, line.id, line.revision], 1);
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_line', aggregateId: line.id, revision, operationId, actorId, projectId: target.project_id,
        type: 'repository.baseline.synchronized', data: { line_id: line.id, target_id: target.id, expected_head_sha: head },
        payload: { id: line.id, project_id: target.project_id, target_id: target.id, status: 'ready', source_revision: head, expected_head_sha: head, revision }, now
      });
    }
    return this.#targetView(tx.get('SELECT * FROM repository_targets WHERE id=?', [target.id]));
  }

  listRepositoryLines(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM repository_lines WHERE project_id=? ORDER BY created_at,id', [project.id])
      .map((row) => this.#lineView(row));
  }

  reconcileRepositoryLine(lineId, input = {}, principal) {
    const row = this.db.get('SELECT * FROM repository_lines WHERE id=?', [String(lineId)]);
    if (!row) throw notFound('repository line');
    this.#assertProject(principal, 'write', row.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const observed = sanitizeSource({ revision: input.source_revision, hash: input.source_hash });
    const now = this.#time();
    const drift = Boolean(
      (observed.revision && row.source_revision && observed.revision !== row.source_revision) ||
      (observed.hash && row.source_hash && observed.hash !== row.source_hash)
    );
    const hash = requestHash({ line_id: row.id, observed, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'repository.line.reconcile', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM repository_lines WHERE id=?', [row.id]);
      assertRevision(current, expected);
      const status = drift ? 'faulted' : 'ready';
      const faultCode = drift ? 'source_drift' : '';
      tx.run(
        `UPDATE repository_lines SET status=?,source_revision=?,source_hash=?,fault_code=?,fault_json=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [
          status,
          observed.revision || current.source_revision,
          observed.hash || current.source_hash,
          faultCode,
          canonicalJson(
            drift ? { expected_revision: current.source_revision, observed_revision: observed.revision || null } : {}
          ),
          now,
          principal.actorId,
          row.id,
          expected
        ],
        1
      );
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'repository.line.reconcile',
        resourceType: 'repository_line',
        resourceId: row.id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_line',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: drift ? 'repository.line.drifted' : 'repository.line.reconciled',
        data: { line_id: row.id, status },
        payload: { id: row.id, project_id: row.project_id, status, revision: expected + 1 },
        now
      });
      const response = {
        line: this.#lineView(tx.get('SELECT * FROM repository_lines WHERE id=?', [row.id])),
        operation: operationView(op),
        source_drift: drift
      };
      saveIdempotency(tx, principal.actorId, 'repository.line.reconcile', key, hash, response, op.id, now);
      return response;
    });
  }

  listRepositoryWorkspaces(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM repository_workspaces WHERE project_id=? ORDER BY created_at,id', [project.id])
      .map((row) => this.#workspaceView(row));
  }

  createRepositoryWorkspace(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const line = this.db.get('SELECT * FROM repository_lines WHERE id=? AND project_id=?', [
      String(input.line_id || ''),
      project.id
    ]);
    if (!line) throw notFound('repository line');
    const connection = this.db.get('SELECT c.* FROM repository_connections c JOIN repository_targets t ON t.connection_id=c.id WHERE t.id=?', [line.target_id]);
    if (connection?.source_kind === 'local' || (connection?.source_kind === 'git' && this.repositoryAdapter?.materialize)) return this.createLocalWorkspace(project, line, connection, input, principal);
    const key = requireKey(input.idempotency_key);
    const relative = safeRelative(input.relative_path || `projects/${project.id}/workspace`);
    const now = this.#time();
    const hash = requestHash({ project_id: project.id, line_id: line.id, relative });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'repository.workspace.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('repository_workspace');
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'repository.workspace.create',
        resourceType: 'repository_workspace',
        resourceId: id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      tx.run(
        `INSERT INTO repository_workspaces(id,project_id,line_id,status,relative_path,owner_operation_id,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'ready',?,?, ?,?,?,?)`,
        [id, project.id, line.id, relative, op.id, now, now, principal.actorId, principal.actorId]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_workspace',
        aggregateId: id,
        revision: 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'workspace.created',
        data: { workspace_id: id, line_id: line.id },
        payload: { id, project_id: project.id, line_id: line.id, status: 'ready', revision: 1 },
        now
      });
      const response = {
        workspace: this.#workspaceView(tx.get('SELECT * FROM repository_workspaces WHERE id=?', [id])),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'repository.workspace.create', key, hash, response, op.id, now);
      return response;
    });
  }

  async createLocalWorkspace(project, line, connection, input, principal) {
    const key = requireKey(input.idempotency_key), now = this.#time();
    const relative = safeRelative(input.relative_path || `projects/${project.id}/workspace`);
    const hash = requestHash({ project_id: project.id, line_id: line.id, relative });
    const pending = await this.db.withTransaction((tx) => {
      const replay = getIdempotency(tx, principal.actorId, 'repository.workspace.create', key, hash, now);
      if (replay) return { replay: JSON.parse(replay.response_json) };
      const id = opaqueId('repository_workspace');
      const op = this.operations.createInTransaction(tx, { actorId: principal.actorId, commandId: 'repository.workspace.create', resourceType: 'repository_workspace', resourceId: id, projectId: project.id, requestHash: hash, idempotencyKey: `op-${key}`, status: 'running' }, now);
      tx.run("INSERT INTO repository_workspaces(id,project_id,line_id,status,relative_path,owner_operation_id,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'requested',?,?,?,?,?,?)", [id,project.id,line.id,relative,op.operation_id,now,now,principal.actorId,principal.actorId]);
      appendAggregate(tx,this.events,{ aggregateType:'repository_workspace', aggregateId:id, revision:1, operationId:op.operation_id,actorId:principal.actorId,projectId:project.id,type:'workspace.created',data:{workspace_id:id,status:'requested'},payload:{id,status:'requested',revision:1},now });
      return { id, operation:op };
    });
    if (pending.replay) return pending.replay;
    const transition = (status, revision) => this.db.withTransaction((tx) => {
      tx.run('UPDATE repository_workspaces SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',[status,this.#time(),pending.id,revision],1);
      appendAggregate(tx,this.events,{aggregateType:'repository_workspace',aggregateId:pending.id,revision:revision+1,operationId:pending.operation.operation_id,actorId:principal.actorId,projectId:project.id,type:'workspace.refreshed',data:{workspace_id:pending.id,status},payload:{id:pending.id,status,revision:revision+1},now:this.#time()});
    });
    try {
      await transition('provisioning',1);
      const root = path.resolve(this.config.workspaceRoot), destination = path.resolve(root,relative);
      if (!destination.startsWith(root + path.sep)) throw new PlatformError('runner_path_invalid','managed workspace path is invalid',{},422);
      const source = { kind: connection.source_kind || 'local', locator: connection.source_locator, revision: line.source_revision, hash: line.source_hash, branch: connection.metadata_json ? parseCanonicalJson(connection.metadata_json, {}).branch : undefined };
      const observed = await this.repositoryAdapter.materialize(source,destination,source);
      await this.db.withTransaction((tx) => {
        const payload = canonicalJson({ workspace_id:pending.id,commit_sha:observed.commit_sha,tree_sha:observed.tree_sha,workspace_hash:observed.workspace_hash,manifest_hash:observed.manifest_hash });
        tx.run("INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,created_at) VALUES(?,'repository.materialization','verified',?,?,?)",[opaqueId('receipt'),payload,sha256Hex(payload),this.#time()]);
      });
      await transition('ready',2);
      return await this.db.withTransaction((tx) => {
        const operation = this.operations.transitionInTransaction(tx,pending.operation.operation_id,'succeeded',{actorId:principal.actorId,expectedRevision:pending.operation.revision,result:{workspace_id:pending.id,workspace_hash:observed.workspace_hash}},this.#time());
        const response = {workspace:this.#workspaceView(tx.get('SELECT * FROM repository_workspaces WHERE id=?',[pending.id])),operation};
        saveIdempotency(tx,principal.actorId,'repository.workspace.create',key,hash,response,pending.operation.operation_id,this.#time()); return response;
      });
    } catch (error) {
      // v9 has no faulted workspace state. Orphaned plus a failed Operation is the existing contract.
      const current = this.db.get('SELECT * FROM repository_workspaces WHERE id=?',[pending.id]);
      await transition('orphaned',Number(current.revision));
      await this.operations.fail(pending.operation.operation_id,{actorId:principal.actorId,expectedRevision:pending.operation.revision,errorCode:error.code || 'repository_materialization_failed'});
      throw error;
    }
  }

  async refreshRepositoryWorkspace(workspaceId, input = {}, principal) {
    const row = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [String(workspaceId)]);
    if (!row) throw notFound('repository workspace');
    this.#assertProject(principal, 'write', row.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const line = this.db.get('SELECT * FROM repository_lines WHERE id=? AND project_id=?', [row.line_id, row.project_id]);
    const connection = line ? this.db.get('SELECT c.* FROM repository_connections c JOIN repository_targets t ON t.connection_id=c.id WHERE t.id=?', [line.target_id]) : null;
    if (row.status === 'locked') throw stateConflict('locked workspace cannot be refreshed', { status: row.status });
    if (['local', 'git'].includes(connection?.source_kind) && this.repositoryAdapter?.probe) {
      const source = { kind: connection.source_kind, locator: connection.source_locator, revision: line.source_revision, hash: line.source_hash, branch: connection.metadata_json ? parseCanonicalJson(connection.metadata_json, {}).branch : undefined };
      const observed = await this.repositoryAdapter.probe(source);
      const root = path.resolve(this.config.workspaceRoot || process.cwd());
      const destination = path.resolve(root, row.relative_path);
      if (fs.existsSync(destination) && this.repositoryAdapter.materialize) {
        const temporary = `${destination}.refresh-${randomUUID()}`;
        await this.repositoryAdapter.materialize(source, temporary, { ...source, revision: observed.revision, hash: observed.hash });
        const backup = `${destination}.previous-${randomUUID()}`;
        try { fs.renameSync(destination, backup); fs.renameSync(temporary, destination); fs.rmSync(backup, { recursive: true, force: true }); }
        catch (error) { if (fs.existsSync(destination) && fs.existsSync(backup)) fs.rmSync(destination, { recursive: true, force: true }); if (fs.existsSync(backup)) fs.renameSync(backup, destination); if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
      }
    }
    const hash = requestHash({ workspace_id: row.id, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'repository.workspace.refresh', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM repository_workspaces WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (current.status === 'locked') throw stateConflict('locked workspace cannot be refreshed', { status: current.status });
      tx.run(
        `UPDATE repository_workspaces SET status='ready',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [now, principal.actorId, row.id, expected],
        1
      );
      const operation = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'repository.workspace.refresh',
        resourceType: 'repository_workspace',
        resourceId: row.id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_workspace',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: operation.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: 'workspace.refreshed',
        data: { workspace_id: row.id },
        payload: { id: row.id, project_id: row.project_id, status: 'ready', revision: expected + 1 },
        now
      });
      const response = {
        workspace: this.#workspaceView(tx.get('SELECT * FROM repository_workspaces WHERE id=?', [row.id])),
        lock: null,
        operation: operationView(operation)
      };
      saveIdempotency(tx, principal.actorId, 'repository.workspace.refresh', key, hash, response, operation.id, now);
      return response;
    });
  }

  lockRepositoryWorkspace(workspaceId, input = {}, principal) {
    return this.#workspaceLock(workspaceId, input, principal, true);
  }
  releaseRepositoryWorkspace(workspaceId, input = {}, principal) {
    return this.#workspaceLock(workspaceId, input, principal, false);
  }

  // ----- Workflow, generation and critic -----------------------------------

  listWorkflows(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM workflows WHERE project_id=?', [project.id])
      .map((row) => this.#workflowView(row));
  }
  getWorkflow(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    const row = this.db.get('SELECT * FROM workflows WHERE project_id=?', [project.id]);
    if (!row) throw notFound('workflow');
    return this.#workflowView(row, true);
  }

  reviseWorkflow(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const workflow = this.db.get('SELECT * FROM workflows WHERE project_id=?', [project.id]);
    if (!workflow) throw notFound('workflow');
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const graph = normalizeGraph(input.graph || { nodes: input.nodes || [] });
    const layout = input.layout && typeof input.layout === 'object' ? input.layout : {};
    const graphJson = canonicalJson(graph);
    const layoutJson = canonicalJson(layout);
    const now = this.#time();
    const hash = requestHash({ project_id: project.id, graph, layout, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'workflow.revise', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM workflows WHERE id=?', [workflow.id]);
      assertRevision(current, expected);
      const revision = Number(current.current_revision) + 1;
      const revisionId = opaqueId('workflow_revision');
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'workflow.revise',
        resourceType: 'workflow',
        resourceId: workflow.id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      const childLinks = [];
      tx.run(
        `INSERT INTO workflow_revisions(id,workflow_id,project_id,revision,graph_json,graph_sha256,layout_json,layout_sha256,source_brief_revision,source_brief_hash,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          revisionId,
          workflow.id,
          project.id,
          revision,
          graphJson,
          sha256Hex(graphJson),
          layoutJson,
          sha256Hex(layoutJson),
          Number(project.confirmed_brief_revision || 0),
          project.confirmed_brief_hash || '',
          now,
          principal.actorId
        ]
      );
      for (const node of graph.nodes) {
        const nodeId = opaqueId('workflow_node');
        const contractId = opaqueId('node_contract');
        const configJson = canonicalJson(node.config || {});
        tx.run(
          `INSERT INTO workflow_nodes(id,workflow_revision_id,node_key,parent_key,node_kind,title,config_json,config_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            nodeId,
            revisionId,
            String(node.id || node.node_key),
            node.parent_id || null,
            node.kind === 'workstream' ? 'workstream' : 'task',
            requiredName(node.title || node.name || node.id),
            configJson,
            sha256Hex(configJson),
            now
          ]
        );
        const contractJson = canonicalJson(node.contract || {});
        tx.run(
          `INSERT INTO node_contracts(id,workflow_revision_id,node_id,contract_json,contract_sha256,created_at) VALUES(?,?,?,?,?,?)`,
          [contractId, revisionId, nodeId, contractJson, sha256Hex(contractJson), now]
        );
        childLinks.push({ nodeId, contractId, nodeKey: String(node.id || node.node_key) });
      }
      tx.run(
        `UPDATE workflows SET status='proposed',current_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [revision, now, principal.actorId, workflow.id, expected],
        1
      );
      tx.run(
        `UPDATE projects SET current_workflow_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [revision, now, principal.actorId, project.id, project.revision],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow',
        aggregateId: workflow.id,
        revision: Number(current.revision) + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'workflow.revised',
        data: { workflow_id: workflow.id, workflow_revision: revision },
        payload: {
          id: workflow.id,
          project_id: project.id,
          status: 'proposed',
          current_revision: revision,
          revision: Number(current.revision) + 1
        },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_revision',
        aggregateId: revisionId,
        revision: 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'workflow.revision.created',
        data: { workflow_revision_id: revisionId, workflow_id: workflow.id, revision },
        payload: { id: revisionId, workflow_id: workflow.id, project_id: project.id, revision },
        now
      });
      for (const child of childLinks) {
        appendAggregate(tx, this.events, {
          aggregateType: 'workflow_node',
          aggregateId: child.nodeId,
          revision: 1,
          operationId: op.id,
          actorId: principal.actorId,
          projectId: project.id,
          type: 'workflow.node.created',
          data: { node_id: child.nodeId, workflow_revision_id: revisionId },
          payload: { id: child.nodeId, workflow_revision_id: revisionId, node_key: child.nodeKey, revision: 1 },
          now
        });
        appendAggregate(tx, this.events, {
          aggregateType: 'node_contract',
          aggregateId: child.contractId,
          revision: 1,
          operationId: op.id,
          actorId: principal.actorId,
          projectId: project.id,
          type: 'workflow.contract.created',
          data: { contract_id: child.contractId, node_id: child.nodeId },
          payload: { id: child.contractId, node_id: child.nodeId, workflow_revision_id: revisionId, revision: 1 },
          now
        });
      }
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: project.id,
        revision: Number(project.revision) + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'workflow.revised',
        data: { project_id: project.id, workflow_revision: revision },
        payload: { id: project.id, current_workflow_revision: revision, revision: Number(project.revision) + 1 },
        now
      });
      linkOperation(
        tx,
        op.id,
        [
          ['workflow', workflow.id],
          ['workflow_revision', revisionId],
          ['project', project.id]
        ],
        now
      );
      for (const child of childLinks) {
        linkOperation(tx, op.id, [['workflow_node', child.nodeId], ['node_contract', child.contractId]], now);
      }
      const response = {
        workflow: this.#workflowView(tx.get('SELECT * FROM workflows WHERE id=?', [workflow.id]), true, tx),
        revision_record: this.#workflowRevisionView(
          tx.get('SELECT * FROM workflow_revisions WHERE id=?', [revisionId])
        ),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'workflow.revise', key, hash, response, op.id, now);
      return response;
    });
  }

  listGenerations(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM workflow_generations WHERE project_id=? ORDER BY created_at DESC,id DESC', [project.id])
      .map((row) => this.#generationView(row));
  }
  getGeneration(generationId, principal) {
    const row = this.db.get('SELECT * FROM workflow_generations WHERE id=?', [String(generationId)]);
    if (!row) throw notFound('workflow generation');
    this.#assertProject(principal, 'read', row.project_id);
    return this.#generationView(row, true);
  }

  startGeneration(projectId, input = {}, principal, commandId = 'generation.start') {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'run', project.id);
    const workflow = this.db.get('SELECT * FROM workflows WHERE project_id=?', [project.id]);
    if (!workflow || Number(workflow.current_revision) < 1)
      throw stateConflict('workflow draft is required before generation');
    const brief = this.db.get('SELECT * FROM briefs WHERE project_id=?', [project.id]);
    const sourceBriefRevision = Number(brief?.confirmed_revision || brief?.current_revision || 0);
    if (sourceBriefRevision < 1) throw stateConflict('brief revision is required before generation');
    const sourceBrief = this.db.get('SELECT content_sha256 FROM brief_revisions WHERE project_id=? AND revision=?', [project.id, sourceBriefRevision]);
    if (!sourceBrief) throw stateConflict('brief revision is unavailable for generation');
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const source = this.#sourceSnapshot(project.id);
    if (this.generator.requiresCredentialLease && !input.provider_profile_id) throw new PlatformError('provider_profile_required', 'Codex profile selection is required', {}, 422);
    const profilePin = input.provider_profile_id ? this.identity.providerProfileSnapshot(input.provider_profile_id, principal) : null;
    const requestedWorkspaceId = input.repository_workspace_id ? String(input.repository_workspace_id) : null;
    const workspace = requestedWorkspaceId
      ? this.db.get("SELECT * FROM repository_workspaces WHERE id=? AND project_id=? AND status IN ('ready','released','locked')", [requestedWorkspaceId, project.id])
      : this.db.get("SELECT * FROM repository_workspaces WHERE project_id=? AND status IN ('ready','released','locked') ORDER BY updated_at DESC,id LIMIT 1", [project.id]);
    if (requestedWorkspaceId && !workspace) throw new PlatformError('repository_workspace_required', 'the selected repository workspace is not ready', {}, 409);
    const requestedPackId = input.context_pack_id ? String(input.context_pack_id) : null;
    const contextPack = (this.generator.requiresCredentialLease || requestedPackId)
      ? (requestedPackId ? this.db.get("SELECT * FROM context_packs WHERE id=? AND project_id=? AND status='sealed'", [requestedPackId, project.id]) : this.db.get("SELECT * FROM context_packs WHERE project_id=? AND status='sealed' ORDER BY created_at DESC,id DESC LIMIT 1", [project.id]))
      : null;
    if (requestedPackId && !contextPack) throw new PlatformError('context_pack_stale', 'the selected Context Pack is unavailable or expired', {}, 409);
    if (this.generator.requiresCredentialLease && !contextPack) throw new PlatformError('context_pack_required', 'a sealed Context Pack is required', {}, 409);

    const candidateInput = input.candidate && typeof input.candidate === 'object' ? input.candidate : {};
    const snapshot = {
      brief_revision: sourceBriefRevision,
      brief_hash: brief.confirmed_revision ? brief.confirmed_hash : sourceBrief.content_sha256,
      workflow_revision: Number(workflow.current_revision),
      repository_revision: source.revision,
      repository_hash: source.hash,
      provider_profile_id: input.provider_profile_id || null,
      principal_actor_id: principal.actorId,
      provider_pin: profilePin,
      brief: parseCanonicalJson(this.db.get('SELECT content_json FROM brief_revisions WHERE project_id=? AND revision=?', [project.id, sourceBriefRevision])?.content_json, {}),
      context_pack: contextPack ? { id: contextPack.id, revision: Number(contextPack.revision), hash: contextPack.pack_hash, content: JSON.parse(this.cas.read(contextPack.payload_cas_hash).toString('utf8')) } : {},
      repository_snapshot: source,
      repository_workspace_id: workspace?.id || null,
      context_pack_id: contextPack?.id || null,
      policy_revision: 1,
      candidate: candidateInput,
      attempt: Number(input.attempt || 1),
      retry_of_generation_id: input.retry_of_generation_id || null
    };
    const inputJson = canonicalJson(snapshot);
    const hash = requestHash({ project_id: project.id, snapshot, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, commandId, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const p = tx.get('SELECT * FROM projects WHERE id=?', [project.id]);
      assertRevision(p, expected);
      const id = opaqueId('workflow_generation');
      const operation = this.operations.createInTransaction(
        tx,
        {
          actorId: principal.actorId,
          commandId,
          kind: 'generation.start',
          resourceType: 'workflow_generation',
          resourceId: id,
          projectId: project.id,
          request: snapshot,
          requestHash: hash,
          idempotencyKey: `op-${key}`
        },
        now
      );
      tx.run(
        `INSERT INTO workflow_generations(id,project_id,workflow_id,operation_id,phase,source_brief_revision,source_brief_hash,source_workflow_revision,source_workflow_hash,source_repository_revision,source_repository_hash,input_json,input_sha256,candidate_json,candidate_sha256,attempt,retry_of_generation_id,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'{}','',?,?,1,?,?,?,?)`,
        [
          id,
          project.id,
          workflow.id,
          operation.operation_id,
          'queued',
          snapshot.brief_revision,
          snapshot.brief_hash,
          snapshot.workflow_revision,
          this.#workflowHash(project.id, snapshot.workflow_revision),
          snapshot.repository_revision,
          snapshot.repository_hash,
          inputJson,
          sha256Hex(inputJson),
          snapshot.attempt,
          snapshot.retry_of_generation_id,
          now,
          now,
          principal.actorId,
          principal.actorId
        ]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation',
        aggregateId: id,
        revision: 1,
        operationId: operation.operation_id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'generation.queued',
        data: { generation_id: id },
        payload: { id, project_id: project.id, phase: 'queued', revision: 1 },
        now
      });
      linkOperation(tx, operation.operation_id, [['workflow_generation', id]], now);
      const response = {
        generation: this.#generationView(tx.get('SELECT * FROM workflow_generations WHERE id=?', [id])),
        operation: operationReceipt(operation)
      };
      saveIdempotency(tx, principal.actorId, commandId, key, hash, response, operation.operation_id, now);
      tx.afterCommit(() =>
        queueMicrotask(() => this.#runGeneration(operation.operation_id, id, project.id).catch(() => undefined))
      );
      return response;
    });
  }

  retryGeneration(generationId, input = {}, principal) {
    const row = this.db.get('SELECT * FROM workflow_generations WHERE id=?', [String(generationId)]);
    if (!row) throw notFound('workflow generation');
    this.#assertProject(principal, 'run', row.project_id);
    if (!GENERATION_TERMINAL.has(row.phase)) throw stateConflict('generation is not retryable', { phase: row.phase });
    const expectedGenerationRevision = positiveRevision(input.expected_revision);
    assertRevision(row, expectedGenerationRevision);
    const projectRevision = this.#projectRow(row.project_id).revision;
    return this.startGeneration(
      row.project_id,
      {
        ...input,
        expected_revision: projectRevision,
        candidate: input.candidate || parseCanonicalJson(row.candidate_json, {}),
        attempt: Number(row.attempt) + 1,
        retry_of_generation_id: row.id,
        provider_profile_id: input.provider_profile_id || parseCanonicalJson(row.input_json, {}).provider_profile_id
      },
      principal,
      'generation.retry'
    );
  }

  async cancelGeneration(generationId, input = {}, principal) {
    const row = this.db.get('SELECT * FROM workflow_generations WHERE id=?', [String(generationId)]);
    if (!row) throw notFound('workflow generation');
    this.#assertProject(principal, 'run', row.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const hash = requestHash({ generation_id: row.id, expected_revision: expected });
    const underlyingOperationId = row.operation_id;
    const response = this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'generation.cancel', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM workflow_generations WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (GENERATION_TERMINAL.has(current.phase))
        throw stateConflict('generation is terminal', { phase: current.phase });
      tx.run(
        `UPDATE workflow_generations SET phase='cancelled',cancelled_at=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [now, now, principal.actorId, row.id, expected],
        1
      );
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'generation.cancel',
        resourceType: 'workflow_generation',
        resourceId: row.id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: 'generation.cancelled',
        data: { generation_id: row.id },
        payload: { id: row.id, project_id: row.project_id, phase: 'cancelled', revision: expected + 1 },
        now
      });
      const response = {
        generation: this.#generationView(tx.get('SELECT * FROM workflow_generations WHERE id=?', [row.id])),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'generation.cancel', key, hash, response, op.id, now);
      return response;
    });
    if (!response.replayed && underlyingOperationId) {
      await this.#cancelExternalOperation(underlyingOperationId, principal, `generation-cancel-${key}`);
    }
    return response;
  }

  async evaluateCritic(generationId, input = {}, principal) {
    const generation = this.db.get('SELECT * FROM workflow_generations WHERE id=?', [String(generationId)]);
    if (!generation) throw notFound('workflow generation');
    this.#assertProject(principal, 'approve', generation.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const candidate = this.critic.requiresCredentialLease ? parseCanonicalJson(generation.candidate_json, {}) : (input.candidate && typeof input.candidate === 'object' ? input.candidate : parseCanonicalJson(generation.candidate_json, {}));
    const hash = requestHash({ generation_id: generation.id, candidate, requested_status: input.status || null, expected_revision: expected });
    const now = this.#time();
    const prior = await this.db.withTransaction((tx) => getIdempotency(tx, principal.actorId, 'critic.evaluate', key, hash, now));
    if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
    assertRevision(generation, expected);
    if (generation.phase !== 'critic_pending') throw stateConflict('generation is not awaiting critic');
    let assessed;
    try {
      const controlled = parseCanonicalJson(generation.input_json, {});
      assessed = typeof this.critic === 'function' ? await this.critic(candidate) : await this.critic.evaluate({ ...controlled, candidate, generation_id: generation.id });
      if (controlled.provider_pin && canonicalJson(this.identity.providerProfileSnapshot(controlled.provider_profile_id, principal)) !== canonicalJson(controlled.provider_pin)) throw new PlatformError('provider_rebind_required', 'provider profile changed during review', {}, 409);
    } catch (error) {
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM workflow_generations WHERE id=?', [generation.id]); assertRevision(current, expected);
        const op = this.operations.createInTransaction(tx, { actorId: principal.actorId, commandId: 'critic.evaluate', resourceType: 'workflow_generation', resourceId: generation.id, projectId: generation.project_id, requestHash: hash, idempotencyKey: key, status: 'running' }, now);
        this.operations.transitionInTransaction(tx, op.operation_id, 'failed', { actorId: principal.actorId, expectedRevision: op.revision, errorCode: error.code || 'critic_failed' }, now);
        tx.run("UPDATE workflow_generations SET phase='failed',error_code=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", [error.code || 'critic_failed',now,generation.id,expected],1);
        appendAggregate(tx, this.events, { aggregateType: 'workflow_generation', aggregateId: generation.id, revision: expected + 1, operationId: op.operation_id, actorId: principal.actorId, projectId: generation.project_id, type: 'generation.failed', data: { generation_id: generation.id, error_code: error.code || 'critic_failed' }, payload: { id: generation.id, phase: 'failed', revision: expected + 1 }, now });
      });
      throw error;
    }
    const status = assessed.status === 'passed' && !(typeof this.critic === 'function' && input.status === 'rejected') ? 'passed' : 'rejected';
    const issues = assessed.issues || [];
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'critic.evaluate', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const row = tx.get('SELECT * FROM workflow_generations WHERE id=?', [generation.id]);
      assertRevision(row, expected);
      if (row.phase !== 'critic_pending')
        throw stateConflict('generation is not awaiting critic', { phase: row.phase });
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'critic.evaluate',
        resourceType: 'workflow_generation',
        resourceId: row.id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      const candidateJson = canonicalJson(candidate);
      const inputJson = row.input_json;
      const issuesJson = canonicalJson(issues);
      const criticId = opaqueId('critic');
      if (assessed.coverage && this.cas) {
        const payload = { critic_id: criticId, candidate_sha256: sha256Hex(candidateJson), input_sha256: row.input_sha256, coverage: assessed.coverage, coverage_sha256: sha256Hex(canonicalJson(assessed.coverage)), provider_receipt: assessed.provider_receipt || null };
        const object = this.cas.putCanonical(payload);
        tx.run("INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at) VALUES(?,'workflow.critic','verified',?,?,?,?)", [criticId,canonicalJson(payload),sha256Hex(canonicalJson(payload)),object.hash,now]);
      }
      tx.run(
        `INSERT INTO workflow_critic_receipts(id,generation_id,project_id,status,candidate_sha256,input_sha256,issues_json,issues_sha256,policy_revision,provider,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          criticId,
          row.id,
          row.project_id,
          status,
          sha256Hex(candidateJson),
          row.input_sha256,
          issuesJson,
          sha256Hex(issuesJson),
          1,
          String(assessed.provider || (this.critic === deterministicCritic ? 'deterministic-critic' : 'workflow-critic')),
          now,
          principal.actorId
        ]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_critic_receipt',
        aggregateId: criticId,
        revision: 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: 'critic.evaluated',
        data: { critic_id: criticId, generation_id: row.id, status },
        payload: {
          id: criticId,
          generation_id: row.id,
          project_id: row.project_id,
          status,
          candidate_sha256: sha256Hex(candidateJson),
          revision: 1
        },
        now
      });
      let proposalId = null;
      let phase = status === 'passed' ? 'proposed' : 'rejected';
      if (status === 'passed') {
        proposalId = opaqueId('workflow_proposal');
        const proposalPayload = {
          generation_id: row.id,
          candidate_sha256: sha256Hex(candidateJson),
          base_workflow_revision: row.source_workflow_revision,
          critic_receipt_id: criticId
        };
        const proposalHash = sha256Hex(canonicalJson(proposalPayload));
        tx.run(
          `INSERT INTO workflow_generation_proposals(id,generation_id,project_id,base_workflow_revision,candidate_json,candidate_sha256,critic_receipt_id,proposal_sha256,status,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?,?)`,
          [
            proposalId,
            row.id,
            row.project_id,
            row.source_workflow_revision,
            candidateJson,
            sha256Hex(candidateJson),
            criticId,
            proposalHash,
            now,
            now,
            principal.actorId,
            principal.actorId
          ]
        );
        appendAggregate(tx, this.events, {
          aggregateType: 'workflow_generation_proposal',
          aggregateId: proposalId,
          revision: 1,
          operationId: op.id,
          actorId: principal.actorId,
          projectId: row.project_id,
          type: 'workflow.proposal.created',
          data: { proposal_id: proposalId, generation_id: row.id, critic_id: criticId },
          payload: {
            id: proposalId,
            generation_id: row.id,
            project_id: row.project_id,
            status: 'pending',
            base_workflow_revision: row.source_workflow_revision,
            revision: 1
          },
          now
        });
      }
      tx.run(
        `UPDATE workflow_generations SET phase=?,candidate_json=?,candidate_sha256=?,critic_receipt_id=?,proposal_id=?,revision=revision+1,updated_at=?,updated_by_actor_id=?,completed_at=? WHERE id=? AND revision=?`,
        [
          phase,
          candidateJson,
          sha256Hex(candidateJson),
          criticId,
          proposalId,
          now,
          principal.actorId,
          status === 'passed' ? null : now,
          row.id,
          expected
        ],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: status === 'passed' ? 'generation.proposed' : 'generation.rejected',
        data: { generation_id: row.id, critic_id: criticId, status },
        payload: {
          id: row.id,
          project_id: row.project_id,
          phase,
          critic_receipt_id: criticId,
          proposal_id: proposalId,
          revision: expected + 1
        },
        now
      });
      linkOperation(
        tx,
        op.id,
        [
          ['workflow_generation', row.id],
          ['workflow_critic_receipt', criticId],
          ...(proposalId ? [['workflow_generation_proposal', proposalId]] : [])
        ],
        now
      );
      const response = {
        generation: this.#generationView(tx.get('SELECT * FROM workflow_generations WHERE id=?', [row.id])),
        critic: this.#criticView(tx.get('SELECT * FROM workflow_critic_receipts WHERE id=?', [criticId])),
        proposal: proposalId
          ? this.#proposalView(tx.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]))
          : null,
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'critic.evaluate', key, hash, response, op.id, now);
      return response;
    });
  }

  getProposal(proposalId, principal) {
    const row = this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [String(proposalId)]);
    if (!row) throw notFound('workflow proposal');
    this.#assertProject(principal, 'read', row.project_id);
    return this.#proposalView(row);
  }

  async applyProposal(proposalId, input = {}, principal) {
    const proposal = this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [String(proposalId)]);
    if (!proposal) throw notFound('workflow proposal');
    this.#assertProject(principal, 'write', proposal.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const hash = requestHash({ proposal_id: proposal.id, expected_revision: expected });
    const result = await this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'workflow.proposal.apply', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const p = tx.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposal.id]);
      if (p.status === 'applied') return { proposal: this.#proposalView(p), replayed: true };
      if (p.status !== 'pending') throw stateConflict('workflow proposal is not pending', { status: p.status });
      const workflow = tx.get('SELECT * FROM workflows WHERE project_id=?', [p.project_id]);
      assertRevision(workflow, expected);
      const generationBefore = tx.get('SELECT * FROM workflow_generations WHERE id=?', [p.generation_id]);
      if (!generationBefore) throw notFound('workflow generation');
      if (generationBefore.phase !== 'proposed') throw stateConflict('workflow generation is not proposed', { phase: generationBefore.phase });
      const briefHead = tx.get('SELECT current_revision FROM briefs WHERE project_id=?', [p.project_id]);
      const workflowDrift = Number(workflow.current_revision) !== Number(p.base_workflow_revision);
      const briefDrift = Number(briefHead?.current_revision || 0) !== Number(generationBefore.source_brief_revision);
      const pinnedInput = parseCanonicalJson(generationBefore.input_json, {});
      const sourceNow = this.#sourceSnapshot(p.project_id);
      const repositoryDrift = Number(sourceNow.revision) !== Number(generationBefore.source_repository_revision) || sourceNow.hash !== generationBefore.source_repository_hash || (pinnedInput.repository_snapshot?.workspace_hash && sourceNow.workspace_hash !== pinnedInput.repository_snapshot.workspace_hash);
      const packNow = pinnedInput.context_pack?.id ? tx.get('SELECT * FROM context_packs WHERE id=?', [pinnedInput.context_pack.id]) : null;
      const contextDrift = pinnedInput.context_pack?.id && (!packNow || packNow.status !== 'sealed' || packNow.pack_hash !== pinnedInput.context_pack.hash || Number(packNow.revision) !== pinnedInput.context_pack.revision);
      let providerDrift = false;
      if (pinnedInput.provider_pin) { try { providerDrift = canonicalJson(this.identity.providerProfileSnapshot(pinnedInput.provider_profile_id, principal)) !== canonicalJson(pinnedInput.provider_pin); } catch { providerDrift = true; } }
      if (workflowDrift || briefDrift || repositoryDrift || contextDrift || providerDrift) {
        const staleOperation = this.operations.createInTransaction(
          tx,
          {
            actorId: principal.actorId,
            commandId: 'workflow.proposal.apply',
            kind: 'workflow.proposal.apply',
            status: 'failed',
            resourceType: 'workflow_proposal',
            resourceId: p.id,
            projectId: p.project_id,
            request: { proposal_id: p.id, expected_revision: expected },
            requestHash: hash,
            idempotencyKey: `stale-${key}`
          },
          now
        );
        const staleRevision = Number(p.revision) + 1;
        tx.run(
          `UPDATE workflow_generation_proposals SET status='stale',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
          [staleRevision, now, principal.actorId, p.id, p.revision],
          1
        );
        appendAggregate(tx, this.events, {
          aggregateType: 'workflow_generation_proposal',
          aggregateId: p.id,
          revision: staleRevision,
          operationId: staleOperation.operation_id,
          actorId: principal.actorId,
          projectId: p.project_id,
          type: 'workflow.proposal.stale',
          data: { proposal_id: p.id, current_revision: workflow.current_revision, base_revision: p.base_workflow_revision, brief_revision: briefHead?.current_revision || 0, source_brief_revision: generationBefore.source_brief_revision },
          payload: { id: p.id, project_id: p.project_id, status: 'stale', revision: staleRevision },
          now
        });
        linkOperation(tx, staleOperation.operation_id, [['workflow_generation_proposal', p.id]], now);
        return {
          stale: true,
          details: { current_revision: workflow.current_revision, base_revision: p.base_workflow_revision, brief_revision: briefHead?.current_revision || 0, source_brief_revision: generationBefore.source_brief_revision }
        };
      }
      const project = tx.get('SELECT * FROM projects WHERE id=?', [p.project_id]);
      if (!project) throw notFound('project');
      const candidate = parseCanonicalJson(p.candidate_json, {});
      const graph = normalizeGraph(candidate);
      const graphJson = canonicalJson(graph);
      const revision = Number(workflow.current_revision) + 1;
      const revisionId = opaqueId('workflow_revision');
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'workflow.proposal.apply',
        resourceType: 'workflow_proposal',
        resourceId: p.id,
        projectId: p.project_id,
        requestHash: hash,
        now
      });
      const childLinks = [];
      tx.run(
        `INSERT INTO workflow_revisions(id,workflow_id,project_id,revision,graph_json,graph_sha256,layout_json,layout_sha256,source_brief_revision,source_brief_hash,proposal_id,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          revisionId,
          workflow.id,
          p.project_id,
          revision,
          graphJson,
          sha256Hex(graphJson),
          '{}',
          sha256Hex('{}'),
          Number(generationBefore.source_brief_revision),
          generationBefore.source_brief_hash,
          p.id,
          now,
          principal.actorId
        ]
      );
      for (const node of graph.nodes) {
        const nodeId = opaqueId('workflow_node');
        const contractId = opaqueId('node_contract');
        const configJson = canonicalJson(node.config || {});
        tx.run(
          `INSERT INTO workflow_nodes(id,workflow_revision_id,node_key,parent_key,node_kind,title,config_json,config_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            nodeId,
            revisionId,
            String(node.id || node.node_key),
            node.parent_id || null,
            node.kind === 'workstream' ? 'workstream' : 'task',
            requiredName(node.title || node.name || node.id),
            configJson,
            sha256Hex(configJson),
            now
          ]
        );
        const contractJson = canonicalJson(node.contract || {});
        tx.run(
          `INSERT INTO node_contracts(id,workflow_revision_id,node_id,contract_json,contract_sha256,created_at) VALUES(?,?,?,?,?,?)`,
          [contractId, revisionId, nodeId, contractJson, sha256Hex(contractJson), now]
        );
        childLinks.push({ nodeId, contractId, nodeKey: String(node.id || node.node_key) });
      }
      tx.run(
        `UPDATE workflows SET status='active',current_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [revision, now, principal.actorId, workflow.id, expected],
        1
      );
      tx.run(
        `UPDATE projects SET current_workflow_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [revision, now, principal.actorId, p.project_id, project.revision],
        1
      );
      const nextProposalRevision = Number(p.revision) + 1;
      tx.run(
        `UPDATE workflow_generation_proposals SET status='applied',applied_workflow_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND status='pending' AND revision=?`,
        [revision, now, principal.actorId, p.id, p.revision],
        1
      );
      tx.run(
        `UPDATE workflow_generations SET phase='applied',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND phase='proposed' AND revision=?`,
        [now, principal.actorId, p.generation_id, generationBefore.revision],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow',
        aggregateId: workflow.id,
        revision: Number(workflow.revision) + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: p.project_id,
        type: 'workflow.proposal.applied',
        data: { proposal_id: p.id, workflow_revision: revision },
        payload: {
          id: workflow.id,
          project_id: p.project_id,
          status: 'active',
          current_revision: revision,
          revision: Number(workflow.revision) + 1
        },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_revision',
        aggregateId: revisionId,
        revision: 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: p.project_id,
        type: 'workflow.revision.created',
        data: { workflow_revision_id: revisionId, workflow_id: workflow.id, revision },
        payload: { id: revisionId, workflow_id: workflow.id, project_id: p.project_id, revision },
        now
      });
      for (const child of childLinks) {
        appendAggregate(tx, this.events, {
          aggregateType: 'workflow_node',
          aggregateId: child.nodeId,
          revision: 1,
          operationId: op.id,
          actorId: principal.actorId,
          projectId: p.project_id,
          type: 'workflow.node.created',
          data: { node_id: child.nodeId, workflow_revision_id: revisionId },
          payload: { id: child.nodeId, workflow_revision_id: revisionId, node_key: child.nodeKey, revision: 1 },
          now
        });
        appendAggregate(tx, this.events, {
          aggregateType: 'node_contract',
          aggregateId: child.contractId,
          revision: 1,
          operationId: op.id,
          actorId: principal.actorId,
          projectId: p.project_id,
          type: 'workflow.contract.created',
          data: { contract_id: child.contractId, node_id: child.nodeId },
          payload: { id: child.contractId, node_id: child.nodeId, workflow_revision_id: revisionId, revision: 1 },
          now
        });
      }
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation_proposal',
        aggregateId: p.id,
        revision: nextProposalRevision,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: p.project_id,
        type: 'workflow.proposal.applied',
        data: { proposal_id: p.id, workflow_revision: revision },
        payload: { id: p.id, project_id: p.project_id, status: 'applied', applied_workflow_revision: revision, revision: nextProposalRevision },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation',
        aggregateId: p.generation_id,
        revision: Number(generationBefore.revision) + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: p.project_id,
        type: 'generation.applied',
        data: { generation_id: p.generation_id, proposal_id: p.id, workflow_revision: revision },
        payload: { id: p.generation_id, project_id: p.project_id, phase: 'applied', revision: Number(generationBefore.revision) + 1 },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: p.project_id,
        revision: Number(project.revision) + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: p.project_id,
        type: 'workflow.proposal.applied',
        data: { project_id: p.project_id, workflow_revision: revision },
        payload: { id: p.project_id, current_workflow_revision: revision, revision: Number(project.revision) + 1 },
        now
      });
      linkOperation(
        tx,
        op.id,
        [
          ['workflow', workflow.id],
          ['workflow_revision', revisionId],
          ['workflow_generation_proposal', p.id],
          ['workflow_generation', p.generation_id],
          ['project', p.project_id]
        ],
        now
      );
      for (const child of childLinks) {
        linkOperation(tx, op.id, [['workflow_node', child.nodeId], ['node_contract', child.contractId]], now);
      }
      const response = {
        proposal: this.#proposalView(tx.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [p.id])),
        workflow: this.#workflowView(tx.get('SELECT * FROM workflows WHERE id=?', [workflow.id]), true, tx),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'workflow.proposal.apply', key, hash, response, op.id, now);
      return response;
    });
    if (result?.stale) {
      throw new PlatformError(
        'workflow_proposal_stale',
        'workflow proposal source revision changed',
        result.details,
        409
      );
    }
    return result;
  }

  listOutcomeRequirements(projectId, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'read', project.id);
    return this.db
      .query('SELECT * FROM outcome_requirements WHERE project_id=? ORDER BY requirement_key', [project.id])
      .map((row) => this.#outcomeView(row));
  }
  createOutcomeRequirement(projectId, input = {}, principal) {
    const project = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', project.id);
    const key = requireKey(input.idempotency_key);
    const requirementKey = requiredName(input.requirement_key);
    const rubric = input.rubric && typeof input.rubric === 'object' ? input.rubric : {};
    const now = this.#time();
    const hash = requestHash({ project_id: project.id, requirement_key: requirementKey, rubric });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'outcome.requirement.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('outcome_requirement');
      const json = canonicalJson(rubric);
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: 'outcome.requirement.create',
        resourceType: 'outcome_requirement',
        resourceId: id,
        projectId: project.id,
        requestHash: hash,
        now
      });
      tx.run(
        `INSERT INTO outcome_requirements(id,project_id,workflow_revision,requirement_key,rubric_json,rubric_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?)`,
        [
          id,
          project.id,
          Number(input.workflow_revision || 0),
          requirementKey,
          json,
          sha256Hex(json),
          now,
          principal.actorId
        ]
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'outcome_requirement',
        aggregateId: id,
        revision: 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: project.id,
        type: 'outcome.requirement.created',
        data: { requirement_id: id },
        payload: { id, project_id: project.id, requirement_key: requirementKey, revision: 1 },
        now
      });
      const response = {
        requirement: this.#outcomeView(tx.get('SELECT * FROM outcome_requirements WHERE id=?', [id])),
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, 'outcome.requirement.create', key, hash, response, op.id, now);
      return response;
    });
  }

  // ----- Recovery and internal async work ----------------------------------

  async recoverPending() {
    const intakes = this.db.query(
      "SELECT * FROM project_intakes WHERE status='processing' ORDER BY created_at,id"
    );
    const generations = this.db.query(
      "SELECT * FROM workflow_generations WHERE phase IN ('queued','running') ORDER BY created_at,id"
    );
    const resumable = new Set(['accepted', 'queued', 'running']);
    const tasks = [];
    for (const row of intakes) {
      const operation = row.operation_id ? this.operations.get(row.operation_id) : null;
      if (operation?.status === 'cancelled') {
        tasks.push(this.#settleIntakeCancellation(row.operation_id, row.project_id, row.id));
      } else if (!operation || !resumable.has(operation.status)) {
        tasks.push(
          this.#settleIntakeFailure(row.operation_id, row.project_id, row.id, {
            error_code: operation?.error_code || 'recovery_result_unconfirmed'
          })
        );
      } else {
        tasks.push(
          this.#runIntake(row.operation_id, row.project_id, row.id, {
            kind: row.source_kind,
            locator: row.source_locator,
            revision: row.source_revision,
            hash: row.source_hash
          })
        );
      }
    }
    for (const row of generations) {
      const operation = row.operation_id ? this.operations.get(row.operation_id) : null;
      if (operation?.status === 'cancelled') {
        tasks.push(this.#settleGenerationCancellation(row.operation_id, row.id, row.project_id));
      } else if (!operation || !resumable.has(operation.status)) {
        tasks.push(
          this.#settleGenerationFailure(row.operation_id, row.id, row.project_id, {
            error_code: operation?.error_code || 'recovery_result_unconfirmed'
          })
        );
      } else {
        tasks.push(this.#runGeneration(row.operation_id, row.id, row.project_id));
      }
    }
    await Promise.all(tasks);
    return intakes.length + generations.length;
  }

  async #cancelExternalOperation(operationId, principal, idempotencyKey) {
    const current = this.db.get('SELECT id,revision,status,project_id FROM operations WHERE id=?', [String(operationId)]);
    if (!current || ['succeeded', 'failed', 'cancelled', 'expired'].includes(current.status)) return current;
    try {
      return await this.operations.cancel(String(operationId), {
        actorId: principal.actorId,
        projectId: current.project_id,
        expectedRevision: Number(current.revision),
        idempotencyKey,
        requestHash: requestHash({ operation_id: String(operationId), reason: 'domain_cancel' }),
        reason: 'domain_cancel'
      });
    } catch (error) {
      if (['state_conflict', 'revision_conflict', 'operation_not_found'].includes(String(error?.code || ''))) return null;
      throw error;
    }
  }

  async #runIntake(operationId, projectId, intakeId, source) {
    if (!operationId) return;
    const result = await this.operations.run(operationId, async (ctx) => {
      ctx.ensureActive();
      const observed = await this.repositoryAdapter.probe(source);
      const row = this.db.get('SELECT * FROM project_intakes WHERE id=?', [intakeId]);
      if (!row || row.status !== 'processing')
        throw new PlatformError('state_conflict', 'intake is no longer processing', {}, 409);
      if (
        (source.hash && observed.hash && source.hash !== observed.hash) ||
        (source.revision && observed.revision && source.revision !== observed.revision)
      ) {
        await this.db.withTransaction((tx) => {
          const current = tx.get('SELECT * FROM project_intakes WHERE id=?', [intakeId]);
          if (!current || current.status !== 'processing') return;
          tx.run(
            `UPDATE project_intakes SET status='failed',error_code='source_drift',result_json=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='processing' AND revision=?`,
            [canonicalJson({ expected: source, observed }), this.#time(), this.#time(), intakeId, current.revision],
            1
          );
          appendAggregate(tx, this.events, {
            aggregateType: 'project_intake',
            aggregateId: intakeId,
            revision: Number(current.revision) + 1,
            operationId,
            actorId: current.updated_by_actor_id,
            projectId,
            type: 'intake.source_drift',
            data: { intake_id: intakeId },
            payload: { id: intakeId, project_id: projectId, status: 'failed', revision: Number(current.revision) + 1 },
            now: this.#time()
          });
        });
        throw new PlatformError('source_drift', 'repository source changed during intake', { retryable: true }, 409);
      }
      const now = this.#time();
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM project_intakes WHERE id=?', [intakeId]);
        if (!current || current.status !== 'processing') return;
        tx.run(
          `UPDATE project_intakes SET status='ready',source_revision=?,source_hash=?,result_json=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='processing' AND revision=?`,
          [observed.revision, observed.hash, canonicalJson({ ready: true }), now, now, intakeId, current.revision],
          1
        );
        appendAggregate(tx, this.events, {
          aggregateType: 'project_intake',
          aggregateId: intakeId,
          revision: Number(current.revision) + 1,
          operationId,
          actorId: current.updated_by_actor_id,
          projectId,
          type: 'intake.ready',
          data: { intake_id: intakeId, source_revision: observed.revision },
          payload: { id: intakeId, project_id: projectId, status: 'ready', revision: Number(current.revision) + 1 },
          now
        });
      });
      return { intake_id: intakeId, status: 'ready' };
    });
    if (result?.status === 'failed') await this.#settleIntakeFailure(operationId, projectId, intakeId, result);
    return result;
  }

  async #runGeneration(operationId, generationId, projectId) {
    if (!operationId) return;
    const result = await this.operations.run(operationId, async (ctx) => {
      ctx.ensureActive();
      const row = this.db.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
      if (!row || GENERATION_TERMINAL.has(row.phase))
        return { generation_id: generationId, phase: row?.phase || 'cancelled' };
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
        if (!current || current.phase !== 'queued') return;
        tx.run(
          `UPDATE workflow_generations SET phase='running',revision=revision+1,updated_at=? WHERE id=? AND phase='queued' AND revision=?`,
          [this.#time(), generationId, current.revision],
          1
        );
        appendAggregate(tx, this.events, {
          aggregateType: 'workflow_generation',
          aggregateId: generationId,
          revision: Number(current.revision) + 1,
          operationId,
          actorId: current.updated_by_actor_id,
          projectId,
          type: 'generation.running',
          data: { generation_id: generationId },
          payload: {
            id: generationId,
            project_id: projectId,
            phase: 'running',
            revision: Number(current.revision) + 1
          },
          now: this.#time()
        });
      });
      const latest = this.db.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
      const input = parseCanonicalJson(latest.input_json, {});
      const candidateResult = typeof this.generator === 'function'
        ? await this.generator(input)
        : await this.generator.generate(input);
      const candidate = candidateResult?.candidate || candidateResult;
      if (input.provider_pin && canonicalJson(this.identity.providerProfileSnapshot(input.provider_profile_id, { actorId: latest.created_by_actor_id })) !== canonicalJson(input.provider_pin)) throw new PlatformError('provider_rebind_required', 'provider profile changed during generation', {}, 409);
      this.#safe(candidate);
      if (candidateResult?.provider_receipt && this.cas) {
        const payload = canonicalJson({ generation_id: generationId, ...candidateResult.provider_receipt }); const object = this.cas.put(payload);
        await this.db.withTransaction((tx) => tx.run("INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at) VALUES(?,'workflow.provider','verified',?,?,?,?)", [opaqueId('receipt'),payload,sha256Hex(payload),object.hash,this.#time()]));
      }
      ctx.ensureActive();
      const candidateJson = canonicalJson(candidate);
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
        if (!current || current.phase !== 'running') return;
        tx.run(
          `UPDATE workflow_generations SET phase='critic_pending',candidate_json=?,candidate_sha256=?,revision=revision+1,updated_at=? WHERE id=? AND phase='running' AND revision=?`,
          [candidateJson, sha256Hex(candidateJson), this.#time(), generationId, current.revision],
          1
        );
        appendAggregate(tx, this.events, {
          aggregateType: 'workflow_generation',
          aggregateId: generationId,
          revision: Number(current.revision) + 1,
          operationId,
          actorId: current.updated_by_actor_id,
          projectId,
          type: 'generation.critic_pending',
          data: { generation_id: generationId, candidate_sha256: sha256Hex(candidateJson) },
          payload: {
            id: generationId,
            project_id: projectId,
            phase: 'critic_pending',
            revision: Number(current.revision) + 1
          },
          now: this.#time()
        });
      });
      return { generation_id: generationId, phase: 'critic_pending', candidate_sha256: sha256Hex(candidateJson) };
    });
    if (result?.status === 'failed')
      await this.#settleGenerationFailure(operationId, generationId, projectId, result);
    return result;
  }

  async #settleIntakeFailure(operationId, projectId, intakeId, receipt) {
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM project_intakes WHERE id=?', [intakeId]);
      if (!current || current.status !== 'processing') return null;
      const now = this.#time();
      const next = Number(current.revision) + 1;
      tx.run(
        `UPDATE project_intakes SET status='failed',error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='processing' AND revision=?`,
        [receipt.error_code || 'operation_failed', now, now, intakeId, current.revision],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'project_intake',
        aggregateId: intakeId,
        revision: next,
        operationId,
        actorId: current.updated_by_actor_id,
        projectId,
        type: 'intake.failed',
        data: { intake_id: intakeId, error_code: receipt.error_code || 'operation_failed' },
        payload: { id: intakeId, project_id: projectId, status: 'failed', revision: next },
        now
      });
      return next;
    });
  }

  async #settleGenerationFailure(operationId, generationId, projectId, receipt) {
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
      if (!current || GENERATION_TERMINAL.has(current.phase)) return null;
      const now = this.#time();
      const next = Number(current.revision) + 1;
      tx.run(
        `UPDATE workflow_generations SET phase='failed',error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?`,
        [receipt.error_code || 'operation_failed', now, now, generationId, current.revision],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation',
        aggregateId: generationId,
        revision: next,
        operationId,
        actorId: current.updated_by_actor_id,
        projectId,
        type: 'generation.failed',
        data: { generation_id: generationId, error_code: receipt.error_code || 'operation_failed' },
        payload: { id: generationId, project_id: projectId, phase: 'failed', revision: next },
        now
      });
      return next;
    });
  }

  async #settleIntakeCancellation(operationId, projectId, intakeId) {
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM project_intakes WHERE id=?', [intakeId]);
      if (!current || current.status !== 'processing') return null;
      const now = this.#time();
      const next = Number(current.revision) + 1;
      tx.run(
        `UPDATE project_intakes SET status='cancelled',error_code='',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='processing' AND revision=?`,
        [now, now, intakeId, current.revision],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'project_intake',
        aggregateId: intakeId,
        revision: next,
        operationId,
        actorId: current.updated_by_actor_id,
        projectId,
        type: 'intake.cancelled',
        data: { intake_id: intakeId, recovered: true },
        payload: { id: intakeId, project_id: projectId, status: 'cancelled', revision: next },
        now
      });
      return next;
    });
  }

  async #settleGenerationCancellation(operationId, generationId, projectId) {
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
      if (!current || GENERATION_TERMINAL.has(current.phase)) return null;
      const now = this.#time();
      const next = Number(current.revision) + 1;
      tx.run(
        `UPDATE workflow_generations SET phase='cancelled',error_code='',revision=revision+1,updated_at=?,completed_at=?,cancelled_at=? WHERE id=? AND revision=?`,
        [now, now, now, generationId, current.revision],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'workflow_generation',
        aggregateId: generationId,
        revision: next,
        operationId,
        actorId: current.updated_by_actor_id,
        projectId,
        type: 'generation.cancelled',
        data: { generation_id: generationId, recovered: true },
        payload: { id: generationId, project_id: projectId, phase: 'cancelled', revision: next },
        now
      });
      return next;
    });
  }

  #projectLifecycle(projectId, status, eventType, input, principal) {
    const row = this.#projectRow(projectId);
    this.#assertProject(principal, 'write', row.id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const command = status === 'archived' ? 'project.archive' : 'project.restore';
    const hash = requestHash({ project_id: row.id, status, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, command, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM projects WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (
        (status === 'archived' && current.status === 'archived') ||
        (status === 'active' && current.status !== 'archived')
      )
        throw stateConflict('project lifecycle transition is invalid', { status: current.status });
      tx.run(
        `UPDATE projects SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=?,archived_at=? WHERE id=? AND revision=?`,
        [status, now, principal.actorId, status === 'archived' ? now : null, row.id, expected],
        1
      );
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: command,
        resourceType: 'project',
        resourceId: row.id,
        projectId: row.id,
        requestHash: hash,
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'project',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.id,
        type: eventType,
        data: { project_id: row.id },
        payload: { id: row.id, project_id: row.id, status, revision: expected + 1 },
        now
      });
      const response = {
        project: this.#projectView(tx.get('SELECT * FROM projects WHERE id=?', [row.id]), true, tx),
        operation: operationView(op)
      };
      saveIdempotency(
        tx,
        principal.actorId,
        command,
        key,
        hash,
        response,
        op.id,
        now
      );
      return response;
    });
  }

  #workspaceLock(workspaceId, input, principal, acquire) {
    const row = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [String(workspaceId)]);
    if (!row) throw notFound('repository workspace');
    this.#assertProject(principal, 'write', row.project_id);
    const expected = positiveRevision(input.expected_revision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const command = acquire ? 'repository.workspace.lock' : 'repository.workspace.release';
    const hash = requestHash({ workspace_id: row.id, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, command, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM repository_workspaces WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (acquire && !['ready', 'released'].includes(current.status))
        throw stateConflict('workspace is not available', { status: current.status });
      if (!acquire && current.status !== 'locked')
        throw stateConflict('workspace is not locked', { status: current.status });
      const op = createInlineOperation(tx, this.events, {
        actorId: principal.actorId,
        commandId: command,
        resourceType: 'repository_workspace',
        resourceId: row.id,
        projectId: row.project_id,
        requestHash: hash,
        now
      });
      let lock = null;
      let lockRevision = null;
      if (acquire) {
        const lockId = opaqueId('repository_lock');
        const token = opaqueId('fence');
        const expires = new Date(Date.parse(now) + 15 * 60 * 1000).toISOString();
        tx.run(
          `INSERT INTO repository_locks(id,workspace_id,holder_operation_id,fencing_token,status,expires_at,created_at,updated_at) VALUES(?,?,? ,?,'active',?,?,?)`,
          [lockId, row.id, op.id, token, expires, now, now]
        );
        lock = tx.get('SELECT * FROM repository_locks WHERE id=?', [lockId]);
        lockRevision = 1;
      } else {
        const currentLock = tx.get(
          "SELECT * FROM repository_locks WHERE workspace_id=? AND status='active' ORDER BY created_at DESC,id DESC LIMIT 1",
          [row.id]
        );
        if (!currentLock) throw stateConflict('workspace lock is not active', { workspace_id: row.id });
        tx.run(
          `UPDATE repository_locks SET status='released',revision=revision+1,updated_at=? WHERE id=? AND status='active' AND revision=?`,
          [now, currentLock.id, currentLock.revision],
          1
        );
        lock = tx.get('SELECT * FROM repository_locks WHERE id=?', [currentLock.id]);
        lockRevision = Number(currentLock.revision) + 1;
      }
      tx.run(
        `UPDATE repository_workspaces SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`,
        [acquire ? 'locked' : 'released', now, principal.actorId, row.id, expected],
        1
      );
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_workspace',
        aggregateId: row.id,
        revision: expected + 1,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: acquire ? 'workspace.locked' : 'workspace.released',
        data: { workspace_id: row.id },
        payload: {
          id: row.id,
          project_id: row.project_id,
          status: acquire ? 'locked' : 'released',
          revision: expected + 1
        },
        now
      });
      appendAggregate(tx, this.events, {
        aggregateType: 'repository_lock',
        aggregateId: lock.id,
        revision: lockRevision,
        operationId: op.id,
        actorId: principal.actorId,
        projectId: row.project_id,
        type: acquire ? 'workspace.locked' : 'workspace.released',
        data: { workspace_id: row.id, lock_id: lock.id },
        payload: {
          id: lock.id,
          workspace_id: row.id,
          status: lock.status,
          revision: lockRevision
        },
        now
      });
      linkOperation(tx, op.id, [['repository_lock', lock.id]], now);
      const response = {
        workspace: this.#workspaceView(tx.get('SELECT * FROM repository_workspaces WHERE id=?', [row.id])),
        lock: lock ? this.#lockView(lock) : null,
        operation: operationView(op)
      };
      saveIdempotency(tx, principal.actorId, command, key, hash, response, op.id, now);
      return response;
    });
  }

  #projectRow(id) {
    const row = this.db.get('SELECT * FROM projects WHERE id=?', [String(id)]);
    if (!row) throw notFound('project');
    return row;
  }
  #assertProject(principal, action, projectId) {
    requirePrincipal(principal);
    const decision = this.authorization?.authorize(principal, action, projectId, { resource: 'project' });
    if (!decision?.allowed)
      throw new PlatformError(
        decision?.code || 'permission_denied',
        decision?.message || 'project access denied',
        decision?.details || {},
        decision?.code === 'authentication_required' ? 401 : 403
      );
  }
  #allowed(principal, action, projectId) {
    try {
      this.#assertProject(principal, action, projectId);
      return true;
    } catch {
      return false;
    }
  }
  #assertGlobalManager(principal) {
    const row = this.db.get(
      "SELECT 1 AS ok FROM team_memberships WHERE actor_id=? AND status='active' AND role IN ('owner','admin') LIMIT 1",
      [principal.actorId]
    );
    if (!row) throw new PlatformError('permission_denied', 'team management permission is required', {}, 403);
  }
  #defaultTeam(principal) {
    return (
      this.db.get(
        "SELECT team_id FROM team_memberships WHERE actor_id=? AND status='active' ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,created_at LIMIT 1",
        [principal.actorId]
      )?.team_id || ''
    );
  }
  #assertTeamMember(principal, teamId, manager = false) {
    const row = this.db.get(
      "SELECT tm.role,t.status FROM team_memberships tm JOIN teams t ON t.id=tm.team_id WHERE tm.team_id=? AND tm.actor_id=? AND tm.status='active'",
      [teamId, principal.actorId]
    );
    if (!row || (manager && !['owner', 'admin'].includes(row.role)) || row.status !== 'active')
      throw new PlatformError('permission_denied', 'team access denied', {}, 403);
  }
  #sourceSnapshot(projectId) {
    const row = this.db.get(
      "SELECT revision,source_hash FROM repository_lines WHERE project_id=? AND status<>'removed' ORDER BY created_at LIMIT 1",
      [projectId]
    );
    const connection = this.db.get('SELECT * FROM repository_connections WHERE project_id=?',[projectId]);
    const manifest = parseCanonicalJson(connection?.metadata_json,{}).manifest;
    const workspace = this.db.get("SELECT * FROM repository_workspaces WHERE project_id=? AND status IN ('ready','released') ORDER BY updated_at DESC LIMIT 1",[projectId]);
    const directory = workspace && this.config.workspaceRoot ? path.resolve(this.config.workspaceRoot, workspace.relative_path) : null;
    const workspaceHash = directory && fs.existsSync(directory) ? sha256Hex(canonicalJson(treeManifest(directory))) : '';
    return { revision: Number(row?.revision || 0), hash: row?.source_hash || '', commit_sha:manifest?.commit_sha || '',tree_sha:manifest?.tree_sha || '',workspace_hash:workspaceHash,manifest:manifest?.entries || [] };
  }
  #workflowHash(projectId, revision) {
    const row = this.db.get('SELECT graph_sha256 FROM workflow_revisions WHERE project_id=? AND revision=?', [
      projectId,
      Number(revision)
    ]);
    return row?.graph_sha256 || '';
  }
  #safe(value) {
    return this.policy?.assertSafe ? this.policy.assertSafe(value) : value;
  }
  #time() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
  #projectView(row, expanded = false, tx = this.db) {
    if (!row) return null;
    const view = {
      id: row.id,
      team_id: row.team_id,
      owner_actor_id: row.owner_actor_id,
      name: row.name,
      description: row.description,
      status: row.status,
      onboarding_state: row.onboarding_state,
      current_brief_revision: Number(row.current_brief_revision),
      confirmed_brief_revision: row.confirmed_brief_revision == null ? null : Number(row.confirmed_brief_revision),
      confirmed_brief_hash: row.confirmed_brief_hash || '',
      current_workflow_revision: Number(row.current_workflow_revision),
      metadata: parseCanonicalJson(row.metadata_json, {}),
      revision: Number(row.revision),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
    if (expanded) {
      view.intake = this.#intakeView(tx.get('SELECT * FROM project_intakes WHERE project_id=?', [row.id]));
      view.brief = this.#briefView(tx.get('SELECT * FROM briefs WHERE project_id=?', [row.id]), tx);
      view.workflow = this.#workflowView(tx.get('SELECT * FROM workflows WHERE project_id=?', [row.id]), false, tx);
    }
    return view;
  }
  #intakeView(row) {
    return row
      ? {
          id: row.id,
          project_id: row.project_id,
          status: row.status,
          mode: row.mode,
          source_kind: row.source_kind,
          source_revision: row.source_revision,
          source_hash: row.source_hash,
          result: parseCanonicalJson(row.result_json, {}),
          error_code: row.error_code,
          attempt: Number(row.attempt),
          revision: Number(row.revision),
          operation_id: row.operation_id || null,
          created_at: row.created_at,
          updated_at: row.updated_at,
          completed_at: row.completed_at || null
        }
      : null;
  }
  #briefRevisionView(row) {
    if (!row) return null;
    const value = {
      id: row.id,
      brief_id: row.brief_id,
      project_id: row.project_id,
      revision: Number(row.revision),
      content: parseCanonicalJson(row.content_json, {}),
      content_sha256: row.content_sha256,
      template: row.template,
      created_at: row.created_at
    };
    if (Object.hasOwn(row, 'template_id')) {
      value.template_id = row.template_id || null;
      value.template_revision = row.template_revision == null ? null : Number(row.template_revision);
      value.template_sha256 = row.template_sha256 || '';
    }
    return value;
  }
  #briefView(row, tx = this.db) {
    if (!row) return null;
    return {
      id: row.id,
      project_id: row.project_id,
      status: row.status,
      current_revision: Number(row.current_revision),
      confirmed_revision: row.confirmed_revision == null ? null : Number(row.confirmed_revision),
      confirmed_hash: row.confirmed_hash || '',
      revision: Number(row.revision),
      current: row.current_revision
        ? this.#briefRevisionView(
            tx.get('SELECT * FROM brief_revisions WHERE brief_id=? AND revision=?', [row.id, row.current_revision])
          )
        : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
  #connectionView(row) {
    return row
      ? {
          id: row.id,
          project_id: row.project_id,
          provider: row.provider,
          credential_ref_id: row.credential_ref_id || null,
          status: row.status,
          source_kind: row.source_kind,
          source_revision: row.source_revision,
          source_hash: row.source_hash,
          read_only: Boolean(row.read_only),
          fault_code: row.fault_code,
          metadata: parseCanonicalJson(row.metadata_json, {}),
          revision: Number(row.revision),
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : null;
  }
  #targetView(row) {
    return row
      ? {
          id: row.id,
          connection_id: row.connection_id,
          name: row.name,
          branch: row.branch,
          remote_ref: row.remote_ref,
          expected_head_sha: row.expected_head_sha,
          revision: Number(row.revision),
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : null;
  }
  #lineView(row) {
    return row
      ? {
          id: row.id,
          project_id: row.project_id,
          target_id: row.target_id,
          line_kind: row.line_kind,
          status: row.status,
          source_revision: row.source_revision,
          source_hash: row.source_hash,
          expected_head_sha: row.expected_head_sha,
          fault_code: row.fault_code,
          fault: parseCanonicalJson(row.fault_json, {}),
          revision: Number(row.revision),
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : null;
  }
  #workspaceView(row) {
    return row
      ? {
          id: row.id,
          project_id: row.project_id,
          line_id: row.line_id,
          status: row.status,
          relative_path: row.relative_path,
          owner_operation_id: row.owner_operation_id || null,
          revision: Number(row.revision),
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : null;
  }
  #lockView(row) {
    return row
      ? {
          id: row.id,
          workspace_id: row.workspace_id,
          holder_operation_id: row.holder_operation_id,
          fencing_token: row.fencing_token,
          status: row.status,
          expires_at: row.expires_at,
          revision: Number(row.revision),
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : null;
  }
  #workflowView(row, expanded = false, tx = this.db) {
    if (!row) return null;
    const current = row.current_revision
      ? tx.get('SELECT * FROM workflow_revisions WHERE workflow_id=? AND revision=?', [row.id, row.current_revision])
      : null;
    return {
      id: row.id,
      project_id: row.project_id,
      status: row.status,
      current_revision: Number(row.current_revision),
      revision: Number(row.revision),
      current: expanded && current ? this.#workflowRevisionView(current, tx) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
  #workflowRevisionView(row, tx = this.db) {
    return row
      ? {
          id: row.id,
          workflow_id: row.workflow_id,
          project_id: row.project_id,
          revision: Number(row.revision),
          graph: parseCanonicalJson(row.graph_json, {}),
          graph_sha256: row.graph_sha256,
          layout: parseCanonicalJson(row.layout_json, {}),
          layout_sha256: row.layout_sha256,
          source_brief_revision: Number(row.source_brief_revision),
          source_brief_hash: row.source_brief_hash,
          proposal_id: row.proposal_id || null,
          created_at: row.created_at
        }
      : null;
  }
  #generationView(row, expanded = false) {
    if (!row) return null;
    return {
      id: row.id,
      project_id: row.project_id,
      workflow_id: row.workflow_id,
      operation_id: row.operation_id || null,
      phase: row.phase,
      source_brief_revision: Number(row.source_brief_revision),
      source_brief_hash: row.source_brief_hash,
      source_workflow_revision: Number(row.source_workflow_revision),
      source_workflow_hash: row.source_workflow_hash,
      source_repository_revision: Number(row.source_repository_revision),
      source_repository_hash: row.source_repository_hash,
      input: parseCanonicalJson(row.input_json, {}),
      input_sha256: row.input_sha256,
      candidate: parseCanonicalJson(row.candidate_json, {}),
      candidate_sha256: row.candidate_sha256,
      attempt: Number(row.attempt),
      retry_of_generation_id: row.retry_of_generation_id || null,
      critic_receipt_id: row.critic_receipt_id || null,
      proposal_id: row.proposal_id || null,
      error_code: row.error_code,
      revision: Number(row.revision),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || null,
      ...(expanded
        ? {
            critic: row.critic_receipt_id
              ? this.#criticView(
                  this.db.get('SELECT * FROM workflow_critic_receipts WHERE id=?', [row.critic_receipt_id])
                )
              : null,
            proposal: row.proposal_id
              ? this.#proposalView(
                  this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [row.proposal_id])
                )
              : null
          }
        : {})
    };
  }
  #criticView(row) {
    return row
      ? {
          id: row.id,
          generation_id: row.generation_id,
          project_id: row.project_id,
          status: row.status,
          candidate_sha256: row.candidate_sha256,
          input_sha256: row.input_sha256,
          issues: parseCanonicalJson(row.issues_json, []),
          issues_sha256: row.issues_sha256,
          policy_revision: Number(row.policy_revision),
          provider: row.provider,
          created_at: row.created_at
        }
      : null;
  }
  #proposalView(row) {
    return row
      ? {
          id: row.id,
          generation_id: row.generation_id,
          project_id: row.project_id,
          base_workflow_revision: Number(row.base_workflow_revision),
          candidate: parseCanonicalJson(row.candidate_json, {}),
          candidate_sha256: row.candidate_sha256,
          critic_receipt_id: row.critic_receipt_id,
          proposal_sha256: row.proposal_sha256,
          status: row.status,
          applied_workflow_revision: Number(row.applied_workflow_revision),
          revision: Number(row.revision),
          created_at: row.created_at,
          updated_at: row.updated_at
        }
      : null;
  }
  #outcomeView(row) {
    return row
      ? {
          id: row.id,
          project_id: row.project_id,
          workflow_revision: Number(row.workflow_revision),
          requirement_key: row.requirement_key,
          rubric: parseCanonicalJson(row.rubric_json, {}),
          rubric_sha256: row.rubric_sha256,
          revision: Number(row.revision),
          created_at: row.created_at
        }
      : null;
  }
}

/**
 * Stable P3 facade.  It owns dependency assembly and the public method names;
 * domain SQL and transaction choreography live in ProjectWorkflowCore, while
 * the owner services provide the explicit command/table boundaries.
 */
export class ProjectWorkflowService {
  constructor(options = {}) {
    this.core = new ProjectWorkflowCore(options);
    this.db = this.core.db;
    this.events = this.core.events;
    this.operations = this.core.operations;
    this.policy = this.core.policy;
    this.authorization = this.core.authorization;
    this.clock = this.core.clock;
    this.projectService = new ProjectService({ core: this.core });
    this.repositoryService = new RepositoryService({ core: this.core });
    this.workflowService = new WorkflowService({ core: this.core });
    this.outcomeService = new OutcomeService({ core: this.core });
  }

  ownerForCommand(commandId) { return projectCommandOwner(commandId); }
  ownerInventory() {
    return Object.freeze({
      Project: this.projectService.tables,
      Repository: this.repositoryService.tables,
      Workflow: this.workflowService.tables,
      Outcome: this.outcomeService.tables
    });
  }

  listProjects(...args) { return this.projectService.list(...args); }
  getProject(...args) { return this.projectService.get(...args); }
  createProject(...args) { return this.projectService.create(...args); }
  updateProject(...args) { return this.projectService.update(...args); }
  archiveProject(...args) { return this.projectService.archive(...args); }
  restoreProject(...args) { return this.projectService.restore(...args); }
  getIntake(...args) { return this.projectService.intake(...args); }
  submitIntake(...args) { return this.projectService.submitIntake(...args); }
  retryIntake(...args) { return this.projectService.retryIntake(...args); }
  cancelIntake(...args) { return this.projectService.cancelIntake(...args); }
  listBriefs(...args) { return this.projectService.briefs(...args); }
  getBrief(...args) { return this.projectService.brief(...args); }
  createBrief(...args) { return this.projectService.createBrief(...args); }
  confirmBrief(...args) { return this.projectService.confirmBrief(...args); }
  previewBrief(...args) { return this.projectService.previewBrief(...args); }

  listRepositoryConnections(...args) { return this.repositoryService.listConnections(...args); }
  createRepositoryConnection(...args) { return this.repositoryService.createConnection(...args); }
  updateRepositoryConnection(...args) { return this.repositoryService.updateConnection(...args); }
  listRepositoryTargets(...args) { return this.repositoryService.listTargets(...args); }
  createRepositoryTarget(...args) { return this.repositoryService.createTarget(...args); }
  listRepositoryLines(...args) { return this.repositoryService.listLines(...args); }
  reconcileRepositoryLine(...args) { return this.repositoryService.reconcileLine(...args); }
  listRepositoryWorkspaces(...args) { return this.repositoryService.listWorkspaces(...args); }
  createRepositoryWorkspace(...args) { return this.repositoryService.createWorkspace(...args); }
  refreshRepositoryWorkspace(...args) { return this.repositoryService.refreshWorkspace(...args); }
  lockRepositoryWorkspace(...args) { return this.repositoryService.lockWorkspace(...args); }
  releaseRepositoryWorkspace(...args) { return this.repositoryService.releaseWorkspace(...args); }

  listWorkflows(...args) { return this.workflowService.list(...args); }
  getWorkflow(...args) { return this.workflowService.get(...args); }
  reviseWorkflow(...args) { return this.workflowService.revise(...args); }
  listGenerations(...args) { return this.workflowService.listGenerations(...args); }
  getGeneration(...args) { return this.workflowService.getGeneration(...args); }
  startGeneration(...args) { return this.workflowService.startGeneration(...args); }
  retryGeneration(...args) { return this.workflowService.retryGeneration(...args); }
  cancelGeneration(...args) { return this.workflowService.cancelGeneration(...args); }
  evaluateCritic(...args) { return this.workflowService.evaluateCritic(...args); }
  getProposal(...args) { return this.workflowService.getProposal(...args); }
  applyProposal(...args) { return this.workflowService.applyProposal(...args); }

  listOutcomeRequirements(...args) { return this.outcomeService.list(...args); }
  createOutcomeRequirement(...args) { return this.outcomeService.create(...args); }
  recoverPending(...args) { return this.core.recoverPending(...args); }
}

export const ProjectDomainService = ProjectWorkflowService;

function createInlineOperation(
  tx,
  events,
  { actorId, commandId, resourceType, resourceId, projectId = null, requestHash, now }
) {
  const operations = operationLedger(tx, events);
  return operations.createInTransaction(tx, {
    actorId,
    commandId,
    kind: commandId,
    resourceType,
    resourceId,
    projectId,
    requestHash,
    request: { resource_type: resourceType, resource_id: resourceId, project_id: projectId },
    idempotencyKey: `inline-${opaqueId('key')}`,
    status: 'succeeded'
  }, now);
}

function appendAggregate(
  tx,
  events,
  { aggregateType, aggregateId, revision, operationId, actorId, projectId, type, data, payload, now }
) {
  if (!events || typeof events.appendAggregateInTransaction !== 'function') throw new TypeError('clean_event_service_required');
  return events.appendAggregateInTransaction(tx, {
    aggregateType,
    aggregateId,
    revision,
    operationId: operationId || null,
    actorId,
    projectId,
    type,
    data,
    payload,
    now
  });
}
function linkOperation(tx, operationId, links, now) {
  const operations = operationLedger(tx);
  return operations.linkInTransaction(tx, operationId, links, now);
}
function operationView(op) {
  return {
    operation_id: op.operation_id || op.id,
    status: op.status || 'succeeded',
    revision: Number(op.revision || 1),
    resource_type: op.resourceType || op.resource_type || null,
    resource_id: op.resourceId || op.resource_id || null,
    audit_reference: op.audit_reference || null,
    terminal: ['succeeded', 'failed', 'cancelled', 'expired'].includes(op.status || 'succeeded')
  };
}
function operationReceipt(op) {
  return {
    ...operationView(op),
    operation: {
      id: op.operation_id || op.id,
      kind: op.kind || 'operation',
      status: op.status || 'accepted',
      resource_type: op.resourceType || op.resource_type || null,
      resource_id: op.resourceId || op.resource_id || null,
      accepted_revision: Number(op.revision || 1),
      poll_uri: `/api/v2/operations/${encodeURIComponent(op.operation_id || op.id)}`,
      events_uri: `/api/v2/operations/${encodeURIComponent(op.operation_id || op.id)}/events`,
      replay_uri: `/api/v2/operations/${encodeURIComponent(op.operation_id || op.id)}/events?format=json`
    }
  };
}
function getIdempotency(tx, actorId, commandId, key, hash, now) {
  return operationLedger(tx).getIdempotencyInTransaction(tx, {
    actorId,
    commandId,
    idempotencyKey: key,
    requestHash: hash,
    now
  });
}
function saveIdempotency(tx, actorId, commandId, key, hash, response, operationId, now) {
  return operationLedger(tx).saveIdempotencyInTransaction(tx, {
    actorId,
    commandId,
    idempotencyKey: key,
    requestHash: hash,
    response,
    operationId,
    responseStatus: 200,
    now
  });
}

function operationLedger(tx, events = null) {
  const operations = tx?.__cleanOperations || events?.operations;
  if (!operations
    || typeof operations.createInTransaction !== 'function'
    || typeof operations.linkInTransaction !== 'function'
    || typeof operations.getIdempotencyInTransaction !== 'function'
    || typeof operations.saveIdempotencyInTransaction !== 'function') {
    throw new TypeError('clean_operation_service_required');
  }
  // CleanDatabase passes the same transaction object to every domain call;
  // cache the one shared ledger instance for helpers invoked before creation.
  tx.__cleanOperations = operations;
  return operations;
}
function requestHash(value) {
  return sha256Hex(canonicalJson(value));
}
function requiredName(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) throw new PlatformError('schema_invalid', 'name is required', {}, 422);
  return text;
}
function boundedString(value, max) {
  const text = String(value ?? '');
  if (text.length > max) throw new PlatformError('schema_invalid', 'value exceeds the allowed length', {}, 422);
  return text;
}
function requireKey(value) {
  const key = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(key))
    throw new PlatformError('idempotency_required', 'Idempotency-Key is required', {}, 400);
  return key;
}
function positiveRevision(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new PlatformError('expected_revision_required', 'expected revision is required', {}, 400);
  return number;
}
function assertRevision(row, expected) {
  if (!row) throw notFound('resource');
  if (Number(row.revision) !== Number(expected))
    throw new PlatformError(
      'revision_conflict',
      'resource revision has changed',
      { expected_revision: Number(expected), actual_revision: Number(row.revision) },
      409
    );
}
function requirePrincipal(principal) {
  if (!principal?.actorId)
    throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
}
function notFound(resource) {
  return new PlatformError('not_found', `${resource} not found`, {}, 404);
}
function stateConflict(message, details = {}) {
  return new PlatformError('state_conflict', message, details, 409);
}
function sanitizeSource(value = {}) {
  const kind = boundedString(value.kind || 'none', 40);
  const locator = boundedString(value.locator || '', 512);
  if (kind !== 'git' && /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?(?:[\\/]|$))/.test(locator))
    throw new PlatformError('repository_source_invalid', 'source locator must be relative or opaque', {}, 422);
  if (kind === 'git' && locator && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(locator)) {
    let parsed; try { parsed = new URL(locator); } catch { throw new PlatformError('repository_source_invalid', 'remote Git URL is invalid', {}, 422); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new PlatformError('repository_source_invalid', 'remote Git URL is invalid', {}, 422);
  }
  const revision = boundedString(value.revision || '', 160);
  const hash = boundedString(value.hash || '', 64);
  if (hash && !/^[a-f0-9]{64}$/i.test(hash))
    throw new PlatformError('schema_invalid', 'source hash is invalid', {}, 422);
  return { kind, locator, revision, hash: hash.toLowerCase(), ...(value.branch ? { branch: boundedString(value.branch, 256) } : {}) };
}
function safeRelative(value) {
  const text = String(value || '');
  if (!text || text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.split(/[\\/]+/).includes('..'))
    throw new PlatformError('path_policy_denied', 'workspace path must be relative', {}, 422);
  return text.replaceAll('\\', '/');
}
function normalizeBrief(input) {
  if (input.content && typeof input.content === 'object' && !Array.isArray(input.content)) return input.content;
  return {
    objective: boundedString(input.objective || '', 20000),
    constraints: Array.isArray(input.constraints)
      ? input.constraints.slice(0, 100).map((item) => boundedString(item, 1000))
      : [],
    acceptance: Array.isArray(input.acceptance)
      ? input.acceptance.slice(0, 100).map((item) => boundedString(item, 1000))
      : []
  };
}
function normalizeGraph(value) {
  const graph = value && typeof value === 'object' ? value : {};
  const nodes = Array.isArray(graph.nodes)
    ? graph.nodes
        .slice(0, 500)
        .map((node) => ({
          id: String(node.id || node.node_key || opaqueId('node')),
          kind: node.kind === 'workstream' ? 'workstream' : 'task',
          title: String(node.title || node.name || node.id || 'Task').slice(0, 200),
          parent_id: node.parent_id == null ? null : String(node.parent_id),
          depends_on: Array.isArray(node.depends_on || node.dependencies) ? (node.depends_on || node.dependencies).map(String) : [],
          config: node.config && typeof node.config === 'object' ? node.config : {},
          contract: node.contract && typeof node.contract === 'object' ? node.contract : {}
        }))
    : [];
  return { ...graph, nodes };
}
function deterministicRepositoryAdapter() {
  return {
    async probe(source) {
      return {
        revision: source?.revision || 'fixture-revision-1',
        hash:
          source?.hash ||
          sha256Hex(
            canonicalJson({ source: source?.locator || '', revision: source?.revision || 'fixture-revision-1' })
          )
      };
    }
  };
}
async function deterministicGenerator(input) {
  const candidate =
    input?.candidate && Object.keys(input.candidate).length
      ? input.candidate
      : {
          name: 'Generated workflow',
          nodes: [
            {
              id: 'inspect',
              kind: 'workstream',
              title: 'Inspect',
              config: {},
              contract: { inputs: ['brief'], outputs: ['analysis'] }
            },
            {
              id: 'deliver',
              kind: 'task',
              title: 'Deliver',
              parent_id: 'inspect',
              config: { execution: { argv: ['node', '--version'], cwd_role: 'task', mode: 'read', input_paths: [], output_paths: [], check_ids: [], resource_profile: 'light', deadline_seconds: 60, capabilities: ['network:none'] } },
              contract: { inputs: ['analysis'], outputs: ['result'] }
            }
          ]
        };
  return candidate;
}
function deterministicCritic(candidate) {
  const nodes = Array.isArray(candidate?.nodes) ? candidate.nodes : [];
  return nodes.length > 0
    ? { status: 'passed', issues: [] }
    : { status: 'rejected', issues: [{ code: 'nodes_required' }] };
}

export { sanitizeSource, safeRelative, normalizeGraph };
