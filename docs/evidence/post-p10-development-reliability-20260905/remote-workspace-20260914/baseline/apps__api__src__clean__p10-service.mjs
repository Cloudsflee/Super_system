import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate,
  assertRevision,
  boundedString,
  createOperation,
  parseJson,
  priorResponse,
  requestHash,
  requireIdempotency,
  requirePrincipal,
  requireRevision,
  saveResponse,
  time
} from './p5-domain-helpers.mjs';

const PROJECT_BLOCKERS = Object.freeze([
  ['assist', "SELECT id FROM assist_sessions WHERE project_id=? AND deleted_at IS NULL AND status IN ('active','paused')"],
  ['execution', "SELECT id FROM executions WHERE project_id=? AND status NOT IN ('completed','failed','cancelled')"],
  ['terminal', "SELECT id FROM terminal_sessions WHERE project_id=? AND status IN ('ready','running','orphaned')"],
  ['parser', "SELECT id FROM parser_runs WHERE project_id=? AND status IN ('queued','running','external_result_unknown')"],
  ['quality', "SELECT id FROM quality_review_runs WHERE project_id=? AND status NOT IN ('completed','failed','cancelled','stale')"],
  ['delivery', "SELECT id FROM deliveries WHERE project_id=? AND status NOT IN ('merged','failed','cancelled')"]
]);

export class CleanP10Service {
  constructor({ db, cas, events, operations, authorization, vault, assist, githubAdapter = null, repositoryDeletionAdapter = null, clock } = {}) {
    if (!db || !cas || !events || !operations || !authorization || !vault || !assist) throw new TypeError('p10_service_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.vault = vault;
    this.assist = assist;
    this.github = githubAdapter;
    this.repositoryDeletionAdapter = repositoryDeletionAdapter;
    this.clock = clock;
  }

  // Brief templates ---------------------------------------------------------

  listBriefTemplates(input = {}, principal) {
    requirePrincipal(principal);
    const teamId = input.team_id ? String(input.team_id) : null;
    const memberships = this.db.query("SELECT team_id FROM team_memberships WHERE actor_id=? AND status='active'", [principal.actorId]).map((row) => row.team_id);
    if (teamId && !memberships.includes(teamId)) throw new PlatformError('permission_denied', 'team access is denied', {}, 403);
    if (!memberships.length) return { templates: [] };
    const ids = teamId ? [teamId] : memberships;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.query(`SELECT * FROM brief_templates WHERE team_id IN (${placeholders}) ${input.include_archived ? '' : "AND status='active'"} ORDER BY updated_at DESC,id`, ids);
    return { templates: rows.map((row) => this.briefTemplateView(row)) };
  }

  createBriefTemplate(input = {}, principal) {
    requirePrincipal(principal);
    const teamId = String(input.team_id || this.defaultTeam(principal));
    this.assertTeamEditor(teamId, principal);
    const expected = requireRevision(input.expected_revision, { allowZero: true });
    if (expected !== 0) throw new PlatformError('revision_conflict', 'new template parent revision must be zero', { expected_revision: 0, actual_revision: expected }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const name = boundedString(input.name, 160, { required: true });
    const description = boundedString(input.description || '', 2000);
    const content = objectValue(input.content, 'template content');
    const now = time(this.clock);
    const hash = requestHash({ team_id: teamId, name, description, content });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.create', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const templateId = opaqueId('brief_template');
      const revisionId = opaqueId('brief_template_revision');
      const contentJson = canonicalJson(content);
      const contentHash = sha256Hex(contentJson);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.create', resourceType: 'brief_template', resourceId: templateId, projectId: null, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO brief_templates(id,team_id,name,description,status,current_revision,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,'active',1,1,?,?,?,?)`, [templateId, teamId, name, description, now, now, principal.actorId, principal.actorId]);
      tx.run('INSERT INTO brief_template_revisions(id,template_id,revision,content_json,content_sha256,created_at,created_by_actor_id) VALUES(?,?,1,?,?,?,?)', [revisionId, templateId, contentJson, contentHash, now, principal.actorId]);
      const row = tx.get('SELECT * FROM brief_templates WHERE id=?', [templateId]);
      appendAggregate(this.events, tx, templateAggregate(row, operation.id, principal.actorId, 'brief_template.created', now, contentHash));
      this.operations.linkInTransaction(tx, operation.id, [['brief_template', templateId], ['brief_template_revision', revisionId]], now);
      const response = { template: this.briefTemplateView(row, tx), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.create', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  updateBriefTemplate(id, input = {}, principal) {
    const row = this.briefTemplateRow(id, principal, true);
    const expected = requireRevision(input.expected_revision);
    assertRevision(row, expected);
    const key = requireIdempotency(input.idempotency_key);
    const name = input.name == null ? row.name : boundedString(input.name, 160, { required: true });
    const description = input.description == null ? row.description : boundedString(input.description, 2000);
    const content = input.content == null ? parseJson(this.db.get('SELECT content_json FROM brief_template_revisions WHERE template_id=? ORDER BY revision DESC LIMIT 1', [row.id])?.content_json, {}) : objectValue(input.content, 'template content');
    const nextTemplateRevision = Number(row.current_revision) + 1;
    const now = time(this.clock);
    const hash = requestHash({ template_id: row.id, expected_revision: expected, name, description, content });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.update', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM brief_templates WHERE id=?', [row.id]); assertRevision(current, expected);
      if (current.status !== 'active') throw new PlatformError('state_conflict', 'archived Brief template is read-only', {}, 409);
      const contentJson = canonicalJson(content);
      const contentHash = sha256Hex(contentJson);
      const revisionId = opaqueId('brief_template_revision');
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.update', resourceType: 'brief_template', resourceId: row.id, requestHash: hash, status: 'succeeded', now });
      tx.run('INSERT INTO brief_template_revisions(id,template_id,revision,content_json,content_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?)', [revisionId, row.id, nextTemplateRevision, contentJson, contentHash, now, principal.actorId]);
      tx.run('UPDATE brief_templates SET name=?,description=?,current_revision=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [name, description, nextTemplateRevision, now, principal.actorId, row.id, expected], 1);
      const next = tx.get('SELECT * FROM brief_templates WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, templateAggregate(next, operation.id, principal.actorId, 'brief_template.updated', now, contentHash));
      this.operations.linkInTransaction(tx, operation.id, [['brief_template', row.id], ['brief_template_revision', revisionId]], now);
      const response = { template: this.briefTemplateView(next, tx), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.update', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  archiveBriefTemplate(id, input = {}, principal) {
    const row = this.briefTemplateRow(id, principal, true);
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ template_id: row.id, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.archive', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM brief_templates WHERE id=?', [row.id]); assertRevision(current, expected);
      if (current.status === 'archived') throw new PlatformError('state_conflict', 'Brief template is already archived', {}, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.archive', resourceType: 'brief_template', resourceId: row.id, requestHash: hash, status: 'succeeded', now });
      tx.run("UPDATE brief_templates SET status='archived',archived_at=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, principal.actorId, row.id, expected], 1);
      const next = tx.get('SELECT * FROM brief_templates WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, templateAggregate(next, operation.id, principal.actorId, 'brief_template.archived', now));
      const response = { template: this.briefTemplateView(next, tx), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'brief.template.archive', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  // Project deletion --------------------------------------------------------

  prepareProjectDeletion(projectId, input = {}, principal) {
    const project = this.projectRow(projectId, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(project, expected);
    const key = requireIdempotency(input.idempotency_key);
    const targetName = boundedString(input.target_name || input.confirmation || '', 160, { required: true });
    if (targetName !== project.name) throw new PlatformError('confirmation_mismatch', 'project name confirmation does not match', {}, 409);
    const blockers = this.projectBlockers(project.id);
    const blockersJson = canonicalJson(blockers);
    const now = time(this.clock);
    const hash = requestHash({ project_id: project.id, expected_revision: expected, target_name: targetName });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.prepare', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM projects WHERE id=?', [project.id]); assertRevision(current, expected);
      const id = opaqueId('project_deletion');
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.prepare', resourceType: 'project_deletion_intent', resourceId: id, projectId: project.id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO project_deletion_intents(id,project_id,operation_id,status,expected_project_revision,target_name,blockers_json,blockers_sha256,creator_actor_id,revision,created_at,updated_at)
        VALUES(?,?,?, 'prepared',?,?,?,?,?,1,?,?)`, [id, project.id, operation.id, expected, targetName, blockersJson, sha256Hex(blockersJson), principal.actorId, now, now]);
      const row = tx.get('SELECT * FROM project_deletion_intents WHERE id=?', [id]);
      appendAggregate(this.events, tx, deletionAggregate('project_deletion_intent', row, operation.id, principal.actorId, project.id, 'project.deletion.prepared', now));
      this.operations.linkInTransaction(tx, operation.id, [['project', project.id], ['project_deletion_intent', id]], now);
      const response = { intent: projectDeletionView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.prepare', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  getProjectDeletion(id, principal) {
    const row = this.projectDeletionRow(id, principal, 'read');
    return { intent: projectDeletionView(row) };
  }

  confirmProjectDeletion(id, input = {}, principal) {
    const row = this.projectDeletionRow(id, principal, 'approve');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (String(input.target_name || '') !== row.target_name) throw new PlatformError('confirmation_mismatch', 'project name confirmation does not match', {}, 409);
    const session = this.ownerSession(principal, row.project_id);
    const key = requireIdempotency(input.idempotency_key);
    const blockers = this.projectBlockers(row.project_id);
    const blockersJson = canonicalJson(blockers);
    const now = time(this.clock);
    const hash = requestHash({ intent_id: row.id, expected_revision: expected, target_name: row.target_name, session_revision: session.revision });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.confirm', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM project_deletion_intents WHERE id=?', [row.id]); assertRevision(current, expected);
      if (!['prepared','blocked'].includes(current.status)) throw new PlatformError('state_conflict', 'project deletion intent cannot be confirmed', { status: current.status }, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.confirm', resourceType: 'project_deletion_intent', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`UPDATE project_deletion_intents SET status=?,blockers_json=?,blockers_sha256=?,creator_session_id=?,creator_session_proof_sha256=?,creator_confirmed_at=?,owner_actor_id=?,owner_session_id=?,owner_session_proof_sha256=?,owner_confirmed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`, [blockers.length ? 'blocked' : 'ready', blockersJson, sha256Hex(blockersJson), session.id, session.proof_hash, now, principal.actorId, session.id, session.proof_hash, now, now, row.id, expected], 1);
      const next = tx.get('SELECT * FROM project_deletion_intents WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, deletionAggregate('project_deletion_intent', next, operation.id, principal.actorId, row.project_id, blockers.length ? 'project.deletion.blocked' : 'project.deletion.confirmed', now));
      const response = { intent: projectDeletionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.confirm', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  executeProjectDeletion(id, input = {}, principal) {
    const row = this.projectDeletionRow(id, principal, 'approve');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    this.ownerSession(principal, row.project_id);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ intent_id: row.id, expected_revision: expected, project_revision: row.expected_project_revision });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.execute', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM project_deletion_intents WHERE id=?', [row.id]); assertRevision(current, expected);
      if (!['ready','blocked'].includes(current.status)) throw new PlatformError('state_conflict', 'project deletion intent is not ready', { status: current.status }, 409);
      const project = tx.get('SELECT * FROM projects WHERE id=?', [row.project_id]);
      if (!project || Number(project.revision) !== Number(row.expected_project_revision)) throw new PlatformError('revision_conflict', 'project changed after deletion preparation', { expected_revision: Number(row.expected_project_revision), actual_revision: Number(project?.revision || 0) }, 409);
      const blockers = this.projectBlockers(row.project_id, tx);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.execute', resourceType: 'project_deletion_intent', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      if (blockers.length) {
        const blockersJson = canonicalJson(blockers);
        tx.run("UPDATE project_deletion_intents SET status='blocked',blockers_json=?,blockers_sha256=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", [blockersJson, sha256Hex(blockersJson), now, row.id, expected], 1);
        const blocked = tx.get('SELECT * FROM project_deletion_intents WHERE id=?', [row.id]);
        appendAggregate(this.events, tx, deletionAggregate('project_deletion_intent', blocked, operation.id, principal.actorId, row.project_id, 'project.deletion.blocked', now));
        const response = { intent: projectDeletionView(blocked), operation: this.operations.summary(operation) };
        saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.execute', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 409, now });
        return response;
      }
      const tombstone = sha256Hex(canonicalJson({ project_id: project.id, project_revision: project.revision, intent_id: row.id, deleted_at: now }));
      tx.run("UPDATE repository_locks SET status='released',revision=revision+1,updated_at=? WHERE workspace_id IN (SELECT id FROM repository_workspaces WHERE project_id=?) AND status='active'", [now, project.id]);
      tx.run("UPDATE repository_workspaces SET status='released',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE project_id=? AND status IN ('requested','provisioning','ready','locked','orphaned')", [now, principal.actorId, project.id]);
      tx.run("UPDATE project_memberships SET status='revoked',revision=revision+1,updated_at=?,updated_by_actor_id=?,deleted_at=? WHERE project_id=? AND status<>'revoked'", [now, principal.actorId, now, project.id]);
      tx.run('UPDATE project_acl_entries SET revision=revision+1,updated_at=?,updated_by_actor_id=?,deleted_at=? WHERE project_id=? AND deleted_at IS NULL', [now, principal.actorId, now, project.id]);
      tx.run("UPDATE projects SET status='archived',deleted_at=?,archived_at=COALESCE(archived_at,?),revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, now, principal.actorId, project.id, project.revision], 1);
      tx.run("UPDATE project_deletion_intents SET status='completed',tombstone_sha256=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?", [tombstone, now, now, row.id, expected], 1);
      const next = tx.get('SELECT * FROM project_deletion_intents WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, deletionAggregate('project_deletion_intent', next, operation.id, principal.actorId, row.project_id, 'project.deletion.completed', now));
      appendAggregate(this.events, tx, { aggregateType: 'project', aggregateId: project.id, revision: Number(project.revision) + 1, operationId: operation.id, actorId: principal.actorId, projectId: project.id, type: 'project.tombstoned', data: { project_id: project.id, tombstone_sha256: tombstone }, payload: { id: project.id, status: 'archived', deleted_at: now, revision: Number(project.revision) + 1 }, now });
      this.operations.linkInTransaction(tx, operation.id, [['project', project.id], ['project_deletion_intent', row.id]], now);
      const response = { intent: projectDeletionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'project.deletion.execute', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  cancelProjectDeletion(id, input = {}, principal) {
    return this.cancelDeletionIntent('project', id, input, principal);
  }

  // Repository deletion -----------------------------------------------------

  prepareRepositoryDeletion(targetId, input = {}, principal) {
    const target = this.repositoryTargetRow(targetId, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(target, expected);
    const fullName = repositoryName(input.target_full_name);
    const expectedName = repositoryName(target.source_locator || target.remote_ref || target.name);
    if (fullName !== expectedName) throw new PlatformError('confirmation_mismatch', 'repository full-name confirmation does not match', {}, 409);
    const head = boundedString(input.expected_head_sha, 128, { required: true });
    if (head !== target.expected_head_sha) throw new PlatformError('repository_head_conflict', 'repository HEAD changed', { expected_head_sha: head, actual_head_sha: target.expected_head_sha }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ repository_target_id: target.id, target_full_name: fullName, expected_head_sha: head, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.prepare', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      assertRevision(tx.get('SELECT * FROM repository_targets WHERE id=?', [target.id]), expected);
      const id = opaqueId('repository_deletion');
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.prepare', resourceType: 'repository_deletion_intent', resourceId: id, projectId: target.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO repository_deletion_intents(id,project_id,repository_target_id,operation_id,status,target_full_name,expected_head_sha,expected_target_revision,creator_actor_id,revision,created_at,updated_at)
        VALUES(?,?,?,?,'prepared',?,?,?,?,1,?,?)`, [id, target.project_id, target.id, operation.id, fullName, head, expected, principal.actorId, now, now]);
      const row = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [id]);
      appendAggregate(this.events, tx, deletionAggregate('repository_deletion_intent', row, operation.id, principal.actorId, target.project_id, 'repository.deletion.prepared', now));
      this.operations.linkInTransaction(tx, operation.id, [['repository_target', target.id], ['repository_deletion_intent', id]], now);
      const response = { intent: repositoryDeletionView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.prepare', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  getRepositoryDeletion(id, principal) {
    const row = this.repositoryDeletionRow(id, principal, 'read');
    return { intent: repositoryDeletionView(row) };
  }

  confirmRepositoryDeletion(id, role, input = {}, principal) {
    const row = this.repositoryDeletionRow(id, principal, role === 'owner' ? 'approve' : 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    confirmRepositorySnapshot(row, input);
    const session = role === 'owner' ? this.ownerSession(principal, row.project_id) : this.activeSession(principal);
    if (role === 'creator' && principal.actorId !== row.creator_actor_id) throw new PlatformError('permission_denied', 'only the deletion creator can provide creator confirmation', {}, 403);
    if (role === 'owner' && (!row.creator_session_id || row.status !== 'creator_confirmed')) throw new PlatformError('state_conflict', 'creator confirmation is required first', {}, 409);
    if (role === 'owner' && session.id === row.creator_session_id) throw new PlatformError('independent_session_required', 'owner confirmation requires a second active session', {}, 409);
    const commandId = `repository.deletion.${role}_confirm`;
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ intent_id: row.id, role, expected_revision: expected, target_full_name: row.target_full_name, expected_head_sha: row.expected_head_sha, session_revision: session.revision });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]); assertRevision(current, expected);
      const requiredStatus = role === 'creator' ? 'prepared' : 'creator_confirmed';
      if (current.status !== requiredStatus) throw new PlatformError('state_conflict', 'repository deletion confirmation order changed', { status: current.status }, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'repository_deletion_intent', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      if (role === 'creator') tx.run("UPDATE repository_deletion_intents SET status='creator_confirmed',creator_session_id=?,creator_session_proof_sha256=?,creator_confirmed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", [session.id, session.proof_hash, now, now, row.id, expected], 1);
      else tx.run("UPDATE repository_deletion_intents SET status='ready',owner_actor_id=?,owner_session_id=?,owner_session_proof_sha256=?,owner_confirmed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", [principal.actorId, session.id, session.proof_hash, now, now, row.id, expected], 1);
      const next = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, deletionAggregate('repository_deletion_intent', next, operation.id, principal.actorId, row.project_id, `repository.deletion.${role}_confirmed`, now));
      const response = { intent: repositoryDeletionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  async executeRepositoryDeletion(id, input = {}, principal) {
    const row = this.repositoryDeletionRow(id, principal, 'approve');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    const session = this.ownerSession(principal, row.project_id);
    if (row.status !== 'ready' || session.id !== row.owner_session_id) throw new PlatformError('state_conflict', 'repository deletion intent is not ready for this owner session', { status: row.status }, 409);
    const target = this.repositoryTargetRow(row.repository_target_id, principal, 'approve');
    if (Number(target.revision) !== Number(row.expected_target_revision) || target.expected_head_sha !== row.expected_head_sha) throw new PlatformError('repository_head_conflict', 'repository target changed after confirmation', {}, 409);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ intent_id: row.id, expected_revision: expected, target_revision: target.revision, target_full_name: row.target_full_name, expected_head_sha: row.expected_head_sha });
    const started = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.execute', idempotencyKey: key, requestHash: hash, now });
      if (prior) return { replayed: prior };
      const current = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]); assertRevision(current, expected);
      if (current.status !== 'ready') throw new PlatformError('state_conflict', 'repository deletion intent is not ready', { status: current.status }, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.execute', resourceType: 'repository_deletion_intent', resourceId: row.id, projectId: row.project_id, requestHash: hash, idempotencyKey: `execute-${key}`, status: 'queued', now });
      tx.run("UPDATE repository_deletion_intents SET status='executing',revision=revision+1,updated_at=? WHERE id=? AND revision=?", [now, row.id, expected], 1);
      const next = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, deletionAggregate('repository_deletion_intent', next, operation.id, principal.actorId, row.project_id, 'repository.deletion.executing', now));
      return { operation, intent: next };
    });
    if (started.replayed) return started.replayed;
    await this.operations.start(started.operation.id, { actorId: principal.actorId, projectId: row.project_id, expectedRevision: started.operation.revision });
    let result;
    let finalStatus = 'completed';
    let errorCode = '';
    try {
      result = await this.deleteRemoteRepository(target, row, principal);
      if (result?.deleted !== true) throw new PlatformError('external_result_unknown', 'repository deletion result is unknown', {}, 503);
    } catch (error) {
      errorCode = String(error?.code || 'repository_delete_failed');
      finalStatus = errorCode === 'external_result_unknown' ? 'needs_reconcile' : 'failed';
      result = { deleted: false, error_code: errorCode };
    }
    return this.finishRepositoryDeletion({ row, target, principal, operationId: started.operation.id, idempotencyKey: key, requestSha: hash, status: finalStatus, result, errorCode });
  }

  async reconcileRepositoryDeletion(id, input = {}, principal) {
    const row = this.repositoryDeletionRow(id, principal, 'approve');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    this.ownerSession(principal, row.project_id);
    if (!['needs_reconcile','failed'].includes(row.status)) throw new PlatformError('state_conflict', 'repository deletion does not require reconciliation', { status: row.status }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ intent_id: row.id, expected_revision: expected, target_full_name: row.target_full_name });
    let observed;
    try { observed = await this.reconcileRemoteRepository(row, principal); }
    catch (error) { observed = { exists: null, error_code: String(error?.code || 'external_result_unknown') }; }
    const status = observed.exists === false ? 'completed' : observed.exists === true ? 'ready' : 'needs_reconcile';
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.reconcile', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]); assertRevision(current, expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.reconcile', resourceType: 'repository_deletion_intent', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      const receiptHash = sha256Hex(canonicalJson(observed));
      tx.run('UPDATE repository_deletion_intents SET status=?,external_repository_id=?,external_receipt_sha256=?,error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?', [status, String(observed.repository_id || row.external_repository_id || ''), receiptHash, String(observed.error_code || ''), now, status === 'completed' ? now : null, row.id, expected], 1);
      if (status === 'completed') {
        tx.run("UPDATE repository_lines SET status='removed',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE target_id=? AND status<>'removed'", [now, principal.actorId, row.repository_target_id]);
        tx.run("UPDATE repository_workspaces SET status='released',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE line_id IN (SELECT id FROM repository_lines WHERE target_id=?) AND status<>'released'", [now, principal.actorId, row.repository_target_id]);
      }
      const next = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, deletionAggregate('repository_deletion_intent', next, operation.id, principal.actorId, row.project_id, `repository.deletion.${status}`, now));
      const response = { intent: repositoryDeletionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.reconcile', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  cancelRepositoryDeletion(id, input = {}, principal) {
    return this.cancelDeletionIntent('repository', id, input, principal);
  }

  // Assist lifecycle and review --------------------------------------------

  updateAssistSession(id, input = {}, principal) {
    const row = this.assistSessionRow(id, principal, 'write');
    const title = input.title == null ? row.title : boundedString(input.title, 160);
    const mode = input.mode == null ? row.mode : String(input.mode);
    if (!['guided','agent','side_thread'].includes(mode)) throw new PlatformError('schema_invalid', 'Assist session mode is invalid', {}, 422);
    return this.mutateAssistSession(row, 'assist.session.metadata', input, principal, { title, mode, pinned_at: input.pinned == null ? row.pinned_at : input.pinned ? time(this.clock) : null }, 'assist_session.metadata_updated');
  }

  archiveAssistSession(id, input = {}, principal) {
    const row = this.assistSessionRow(id, principal, 'write');
    if (row.archived_at) throw new PlatformError('state_conflict', 'Assist session is already archived', {}, 409);
    return this.mutateAssistSession(row, 'assist.session.archive', input, principal, { archived_at: time(this.clock) }, 'assist_session.archived');
  }

  restoreAssistSession(id, input = {}, principal) {
    const row = this.assistSessionRow(id, principal, 'write');
    if (!row.archived_at || row.deleted_at) throw new PlatformError('state_conflict', 'Assist session is not restorable from archive', {}, 409);
    return this.mutateAssistSession(row, 'assist.session.restore', input, principal, { archived_at: null }, 'assist_session.restored');
  }

  deleteAssistSession(id, input = {}, principal) {
    const row = this.assistSessionRow(id, principal, 'write');
    if (row.deleted_at) throw new PlatformError('state_conflict', 'Assist session is already deleted', {}, 409);
    if (row.status === 'active' && this.db.get("SELECT 1 AS ok FROM assist_turns WHERE session_id=? AND status IN ('queued','running','awaiting_input') LIMIT 1", [row.id])) throw new PlatformError('assist_session_busy', 'active Assist work must finish before deletion', {}, 409);
    const now = time(this.clock);
    return this.mutateAssistSession(row, 'assist.session.delete', input, principal, { deleted_at: now, archived_at: row.archived_at || now }, 'assist_session.deleted');
  }

  restoreDeletedAssistSession(id, input = {}, principal) {
    const row = this.assistSessionRow(id, principal, 'write');
    if (!row.deleted_at) throw new PlatformError('state_conflict', 'Assist session is not deleted', {}, 409);
    return this.mutateAssistSession(row, 'assist.session.restore_deleted', input, principal, { deleted_at: null }, 'assist_session.delete_restored');
  }

  async forkAssistSession(id, input = {}, principal, mode = 'fork') {
    const source = this.assistSessionRow(id, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(source, expected);
    if (source.deleted_at) throw new PlatformError('state_conflict', 'deleted Assist session cannot be forked', {}, 409);
    const forkTurn = input.fork_source_turn_id ? this.db.get('SELECT * FROM assist_turns WHERE id=? AND session_id=?', [String(input.fork_source_turn_id), source.id]) : this.db.get('SELECT * FROM assist_turns WHERE session_id=? ORDER BY turn_no DESC LIMIT 1', [source.id]);
    if (input.fork_source_turn_id && !forkTurn) throw new PlatformError('not_found', 'fork source turn not found', {}, 404);
    const commandId = mode === 'side_thread' ? 'assist.session.side_thread' : 'assist.session.fork';
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ source_session_id: source.id, expected_revision: expected, fork_source_turn_id: forkTurn?.id || null, mode, title: input.title || '' });
    const prior = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }));
    if (prior) return prior;
    const created = await this.assist.createSession({
      project_id: source.project_id,
      scope: source.scope,
      scope_id: source.scope_id,
      context_pack_id: source.context_pack_id,
      profile_id: source.profile_id,
      repository_workspace_id: source.repository_workspace_id || undefined,
      idempotency_key: `p10-fork-${hash.slice(0, 48)}`
    }, principal);
    const sessionId = created.session?.id || created.id;
    return this.db.withTransaction((tx) => {
      const replay = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (replay) return replay;
      const currentSource = tx.get('SELECT * FROM assist_sessions WHERE id=?', [source.id]); assertRevision(currentSource, expected);
      const child = tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_session', resourceId: child.id, projectId: source.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run('UPDATE assist_sessions SET title=?,mode=?,parent_session_id=?,fork_source_turn_id=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [boundedString(input.title || `${mode === 'side_thread' ? 'Side thread' : 'Fork'} of ${source.title || source.id}`, 160), mode === 'side_thread' ? 'side_thread' : (input.mode || source.mode || 'guided'), source.id, forkTurn?.id || null, now, principal.actorId, child.id, child.revision], 1);
      const next = tx.get('SELECT * FROM assist_sessions WHERE id=?', [child.id]);
      appendAggregate(this.events, tx, assistAggregate(next, operation.id, principal.actorId, mode === 'side_thread' ? 'assist_session.side_thread_created' : 'assist_session.forked', now));
      this.operations.linkInTransaction(tx, operation.id, [['assist_session', source.id], ['assist_session', child.id], ...(forkTurn ? [['assist_turn', forkTurn.id]] : [])], now);
      const response = { session: assistSessionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  createAssistConfiguration(id, input = {}, principal) {
    const row = this.assistSessionRow(id, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    const key = requireIdempotency(input.idempotency_key);
    const snapshot = objectValue(input.configuration, 'Assist configuration');
    const now = time(this.clock);
    const hash = requestHash({ session_id: row.id, expected_revision: expected, configuration: snapshot });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.configuration.create', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [row.id]); assertRevision(current, expected);
      const revision = Number(tx.get('SELECT COALESCE(MAX(revision),0)+1 AS n FROM assist_configurations WHERE session_id=?', [row.id]).n);
      const snapshotJson = canonicalJson(snapshot);
      const configId = opaqueId('assist_config');
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.configuration.create', resourceType: 'assist_configuration', resourceId: configId, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run('INSERT INTO assist_configurations(id,session_id,revision,snapshot_json,snapshot_sha256,provider_schema_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?)', [configId, row.id, revision, snapshotJson, sha256Hex(snapshotJson), String(input.provider_schema_sha256 || sha256Hex(snapshotJson)), now, principal.actorId]);
      tx.run('UPDATE assist_sessions SET revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [now, principal.actorId, row.id, expected], 1);
      const next = tx.get('SELECT * FROM assist_sessions WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, assistAggregate(next, operation.id, principal.actorId, 'assist_configuration.created', now));
      const response = { session: assistSessionView(next), configuration: { id: configId, session_id: row.id, revision, snapshot, snapshot_sha256: sha256Hex(snapshotJson), created_at: now }, operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.configuration.create', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  listAssistReviewComments(turnId, principal) {
    const turn = this.assistTurnRow(turnId, principal, 'read');
    const rows = this.db.query('SELECT * FROM assist_review_comments WHERE turn_id=? ORDER BY created_at,id', [turn.id]);
    return { comments: rows.map((row) => this.assistCommentView(row)) };
  }

  createAssistReviewComment(turnId, input = {}, principal, forcedKind = null) {
    const turn = this.assistTurnRow(turnId, principal, forcedKind === 'request_changes' ? 'approve' : 'write');
    const session = this.db.get('SELECT * FROM assist_sessions WHERE id=?', [turn.session_id]);
    const expected = requireRevision(input.expected_revision); assertRevision(turn, expected);
    const key = requireIdempotency(input.idempotency_key);
    const kind = forcedKind || String(input.kind || 'comment');
    if (!['comment','request_changes','resolution'].includes(kind)) throw new PlatformError('schema_invalid', 'Assist review comment kind is invalid', {}, 422);
    const content = boundedString(input.content, 8000, { required: true });
    const parent = input.parent_comment_id ? this.db.get('SELECT * FROM assist_review_comments WHERE id=? AND turn_id=?', [String(input.parent_comment_id), turn.id]) : null;
    if (input.parent_comment_id && !parent) throw new PlatformError('not_found', 'parent review comment not found', {}, 404);
    const stored = this.cas.put(content, { mediaType: 'text/plain', metadata: { kind: 'assist.review.comment', turn_id: turn.id } });
    const now = time(this.clock);
    const hash = requestHash({ turn_id: turn.id, turn_revision: expected, kind, relative_path: input.relative_path || '', line_number: input.line_number || null, content_sha256: stored.hash, parent_comment_id: parent?.id || null });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: kind === 'request_changes' ? 'assist.review.request_changes' : 'assist.review.comment', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      assertRevision(tx.get('SELECT * FROM assist_turns WHERE id=?', [turn.id]), expected);
      const id = opaqueId('assist_review_comment');
      const commandId = kind === 'request_changes' ? 'assist.review.request_changes' : 'assist.review.comment';
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_review_comment', resourceId: id, projectId: session.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO assist_review_comments(id,project_id,session_id,turn_id,parent_comment_id,kind,relative_path,line_number,content_sha256,content_cas_sha256,created_at,created_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [id, session.project_id, session.id, turn.id, parent?.id || null, kind, boundedString(input.relative_path || '', 1024), input.line_number == null ? null : requireRevision(input.line_number), stored.hash, stored.hash, now, principal.actorId]);
      const row = tx.get('SELECT * FROM assist_review_comments WHERE id=?', [id]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_review_comment', aggregateId: id, revision: 1, operationId: operation.id, actorId: principal.actorId, projectId: session.project_id, type: kind === 'request_changes' ? 'assist_review.request_changes' : 'assist_review.comment_created', data: { comment_id: id, turn_id: turn.id, kind }, payload: { id, turn_id: turn.id, kind, content_sha256: stored.hash, revision: 1 }, now });
      this.operations.linkInTransaction(tx, operation.id, [['assist_session', session.id], ['assist_turn', turn.id], ['assist_review_comment', id]], now);
      const response = { comment: this.assistCommentView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 201, now });
      return response;
    });
  }

  async recoverPending() {
    const now = time(this.clock);
    const rows = this.db.query("SELECT * FROM repository_deletion_intents WHERE status='executing' ORDER BY created_at,id");
    for (const row of rows) {
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
        if (current?.status !== 'executing') return;
        tx.run("UPDATE repository_deletion_intents SET status='needs_reconcile',error_code='external_result_unknown',revision=revision+1,updated_at=? WHERE id=? AND revision=?", [now, row.id, row.revision], 1);
        const next = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
        appendAggregate(this.events, tx, deletionAggregate('repository_deletion_intent', next, null, row.creator_actor_id, row.project_id, 'repository.deletion.needs_reconcile', now));
      });
    }
    return rows.length;
  }

  // Internal helpers --------------------------------------------------------

  briefTemplateRow(id, principal, edit = false) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM brief_templates WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'Brief template not found', {}, 404);
    if (edit) this.assertTeamEditor(row.team_id, principal);
    else if (!this.db.get("SELECT 1 AS ok FROM team_memberships WHERE team_id=? AND actor_id=? AND status='active'", [row.team_id, principal.actorId])) throw new PlatformError('permission_denied', 'team access is denied', {}, 403);
    return row;
  }

  briefTemplateView(row, db = this.db) {
    const revision = db.get('SELECT * FROM brief_template_revisions WHERE template_id=? ORDER BY revision DESC LIMIT 1', [row.id]);
    return { id: row.id, team_id: row.team_id, name: row.name, description: row.description, status: row.status, current_revision: Number(row.current_revision), revision: Number(row.revision), content: parseJson(revision?.content_json, {}), content_sha256: revision?.content_sha256 || '', archived_at: row.archived_at || null, created_at: row.created_at, updated_at: row.updated_at };
  }

  defaultTeam(principal) {
    const row = this.db.get("SELECT team_id FROM team_memberships WHERE actor_id=? AND status='active' AND role IN ('owner','admin','editor') ORDER BY created_at,id LIMIT 1", [principal.actorId]);
    if (!row) throw new PlatformError('permission_denied', 'an editable team is required', {}, 403);
    return row.team_id;
  }

  assertTeamEditor(teamId, principal) {
    requirePrincipal(principal);
    const row = this.db.get("SELECT 1 AS ok FROM team_memberships WHERE team_id=? AND actor_id=? AND status='active' AND role IN ('owner','admin','editor')", [teamId, principal.actorId]);
    if (!row) throw new PlatformError('permission_denied', 'team template write is denied', {}, 403);
  }

  projectRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM projects WHERE id=?', [String(id)]);
    if (!row || row.deleted_at) throw new PlatformError('not_found', 'project not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), action, row.id, { resource: 'project' });
    return row;
  }

  projectBlockers(projectId, database = this.db) {
    return PROJECT_BLOCKERS.map(([domain, sql]) => {
      const rows = database.query(sql, [String(projectId)]);
      return rows.length ? { domain, count: rows.length, ids: rows.slice(0, 25).map((row) => row.id) } : null;
    }).filter(Boolean);
  }

  projectDeletionRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM project_deletion_intents WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'project deletion intent not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), action, row.project_id, { resource: 'project_deletion' });
    return row;
  }

  repositoryTargetRow(id, principal, action) {
    const row = this.db.get(`SELECT t.*,c.project_id,c.source_locator,c.credential_ref_id,c.metadata_json AS connection_metadata_json
      FROM repository_targets t JOIN repository_connections c ON c.id=t.connection_id WHERE t.id=?`, [String(id)]);
    if (!row) throw new PlatformError('not_found', 'repository target not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), action, row.project_id, { resource: 'repository' });
    return row;
  }

  repositoryDeletionRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM repository_deletion_intents WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'repository deletion intent not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), action, row.project_id, { resource: 'repository_deletion' });
    return row;
  }

  activeSession(principal) {
    requirePrincipal(principal);
    const session = this.db.get('SELECT * FROM sessions WHERE id=?', [String(principal.sessionId || '')]);
    if (!session || session.revoked_at || session.deleted_at || session.subject_actor_id !== principal.actorId || session.effective_actor_id !== principal.actorId || Date.parse(session.expires_at) <= Date.parse(time(this.clock))) throw new PlatformError('session_proof_required', 'an active revision-bound session proof is required', {}, 403);
    return session;
  }

  ownerSession(principal, projectId) {
    const session = this.activeSession(principal);
    const owner = this.db.get("SELECT 1 AS ok FROM projects p LEFT JOIN project_memberships m ON m.project_id=p.id AND m.actor_id=? AND m.status='active' AND m.role='owner' WHERE p.id=? AND (p.owner_actor_id=? OR m.id IS NOT NULL)", [principal.actorId, String(projectId), principal.actorId]);
    if (!owner) throw new PlatformError('owner_session_required', 'an active project owner session is required', {}, 403);
    return session;
  }

  cancelDeletionIntent(kind, id, input, principal) {
    const repository = kind === 'repository';
    const row = repository ? this.repositoryDeletionRow(id, principal, 'write') : this.projectDeletionRow(id, principal, 'write');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (['executing','completed','cancelled'].includes(row.status)) throw new PlatformError('state_conflict', 'deletion intent cannot be cancelled', { status: row.status }, 409);
    const commandId = `${kind}.deletion.cancel`;
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ intent_id: row.id, expected_revision: expected });
    const table = repository ? 'repository_deletion_intents' : 'project_deletion_intents';
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get(`SELECT * FROM ${table} WHERE id=?`, [row.id]); assertRevision(current, expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: `${kind}_deletion_intent`, resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`UPDATE ${table} SET status='cancelled',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?`, [now, now, row.id, expected], 1);
      const next = tx.get(`SELECT * FROM ${table} WHERE id=?`, [row.id]);
      appendAggregate(this.events, tx, deletionAggregate(`${kind}_deletion_intent`, next, operation.id, principal.actorId, row.project_id, `${kind}.deletion.cancelled`, now));
      const response = { intent: repository ? repositoryDeletionView(next) : projectDeletionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  async finishRepositoryDeletion({ row, target, principal, operationId, idempotencyKey, requestSha, status, result, errorCode }) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
      if (current.status !== 'executing') throw new PlatformError('state_conflict', 'repository deletion state changed', { status: current.status }, 409);
      const receiptHash = sha256Hex(canonicalJson(result || {}));
      tx.run('UPDATE repository_deletion_intents SET status=?,external_repository_id=?,external_receipt_sha256=?,error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=?', [status, String(result?.repository_id || ''), receiptHash, errorCode, now, status === 'completed' ? now : null, row.id, current.revision], 1);
      if (status === 'completed') {
        tx.run("UPDATE repository_lines SET status='removed',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE target_id=? AND status<>'removed'", [now, principal.actorId, target.id]);
        tx.run("UPDATE repository_workspaces SET status='released',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE line_id IN (SELECT id FROM repository_lines WHERE target_id=?) AND status<>'released'", [now, principal.actorId, target.id]);
      }
      const next = tx.get('SELECT * FROM repository_deletion_intents WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, deletionAggregate('repository_deletion_intent', next, operationId, principal.actorId, row.project_id, `repository.deletion.${status}`, now));
      const operation = tx.get('SELECT * FROM operations WHERE id=?', [operationId]);
      if (operation && !['succeeded','failed','cancelled','expired'].includes(operation.status)) this.operations.transitionInTransaction(tx, operation.id, status === 'completed' ? 'succeeded' : 'failed', { expectedRevision: operation.revision, actorId: principal.actorId, projectId: row.project_id, ...(status === 'completed' ? { result: { intent_id: row.id, repository_id: result?.repository_id || null } } : { errorCode: errorCode || 'repository_delete_failed' }) }, now);
      const response = { intent: repositoryDeletionView(next), operation: this.operations.summary(tx.get('SELECT * FROM operations WHERE id=?', [operationId])) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'repository.deletion.execute', idempotencyKey, requestHash: requestSha, response, operationId, status: 202, now });
      return response;
    });
  }

  async deleteRemoteRepository(target, intent, principal) {
    if (this.repositoryDeletionAdapter?.delete) return this.repositoryDeletionAdapter.delete({ target: publicTarget(target), intent: repositoryDeletionView(intent), principal: { actorId: principal.actorId } });
    if (!this.github?.deleteRepository) throw new PlatformError('repository_adapter_unavailable', 'remote repository deletion adapter is unavailable', {}, 503);
    const profile = this.githubProfile(target, principal);
    return this.withGithubLease(profile, (auth) => this.github.deleteRepository(auth, { repository: intent.target_full_name, repositoryId: intent.external_repository_id || null, branch: target.branch, expectedHeadSha: intent.expected_head_sha }));
  }

  async reconcileRemoteRepository(intent, principal) {
    if (this.repositoryDeletionAdapter?.reconcile) return this.repositoryDeletionAdapter.reconcile({ intent: repositoryDeletionView(intent), principal: { actorId: principal.actorId } });
    if (!this.github?.reconcileRepositoryDeletion) throw new PlatformError('repository_adapter_unavailable', 'remote repository reconciliation adapter is unavailable', {}, 503);
    const target = this.repositoryTargetRow(intent.repository_target_id, principal, 'approve');
    const profile = this.githubProfile(target, principal);
    return this.withGithubLease(profile, (auth) => this.github.reconcileRepositoryDeletion(auth, { repository: intent.target_full_name, branch: target.branch }));
  }

  githubProfile(target, principal) {
    const metadata = parseJson(target.connection_metadata_json, {});
    const profileId = metadata.github_profile_id || metadata.profile_id;
    let profile = profileId ? this.db.get("SELECT * FROM provider_profiles WHERE id=? AND provider='github'", [String(profileId)]) : null;
    if (!profile && target.credential_ref_id) profile = this.db.get("SELECT * FROM provider_profiles WHERE credential_ref_id=? AND provider='github' ORDER BY updated_at DESC,id LIMIT 1", [target.credential_ref_id]);
    if (!profile || profile.owner_actor_id !== principal.actorId || profile.status !== 'available' || profile.lifecycle_status === 'disabled') throw new PlatformError('github_profile_required', 'an enabled GitHub profile is required', {}, 409);
    return profile;
  }

  async withGithubLease(profile, callback) {
    const credential = this.db.get("SELECT * FROM credential_refs WHERE id=? AND provider='github' AND owner_actor_id=?", [profile.credential_ref_id, profile.owner_actor_id]);
    if (!credential || credential.status !== 'active' || !String(credential.external_ref).startsWith('vault:')) throw new PlatformError('credential_rebind_required', 'GitHub credential must be rebound', {}, 409);
    const lease = Buffer.from(this.vault.read(credential.external_ref));
    let privateKey = lease;
    try {
      let bundle = {};
      try { bundle = JSON.parse(lease.toString('utf8')); } catch { bundle = {}; }
      if (bundle.private_key) privateKey = Buffer.from(String(bundle.private_key), 'utf8');
      const config = parseJson(profile.config_json, {});
      const auth = { appId: config.app_id || bundle.app_id, installationId: config.installation_id || bundle.installation_id, privateKey };
      if (!auth.appId || !auth.installationId) throw new PlatformError('github_app_identity_missing', 'GitHub App and Installation identity are required', {}, 409);
      return await callback(auth);
    } finally {
      if (privateKey !== lease) privateKey.fill(0);
      lease.fill(0);
    }
  }

  assistSessionRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM assist_sessions WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'Assist session not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), action, row.project_id, { resource: 'assist' });
    return row;
  }

  assistTurnRow(id, principal, action) {
    const row = this.db.get('SELECT t.*,s.project_id FROM assist_turns t JOIN assist_sessions s ON s.id=t.session_id WHERE t.id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), action, row.project_id, { resource: 'assist_review' });
    return row;
  }

  mutateAssistSession(row, commandId, input, principal, updates, eventType) {
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ session_id: row.id, expected_revision: expected, updates });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [row.id]); assertRevision(current, expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_session', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      const fields = Object.keys(updates);
      tx.run(`UPDATE assist_sessions SET ${fields.map((field) => `${field}=?`).join(',')},revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [...fields.map((field) => updates[field]), now, principal.actorId, row.id, expected], 1);
      const next = tx.get('SELECT * FROM assist_sessions WHERE id=?', [row.id]);
      appendAggregate(this.events, tx, assistAggregate(next, operation.id, principal.actorId, eventType, now));
      const response = { session: assistSessionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  assistCommentView(row) {
    let content = '';
    try { content = this.cas.read(row.content_cas_sha256).toString('utf8'); } catch { content = ''; }
    return { id: row.id, project_id: row.project_id, session_id: row.session_id, turn_id: row.turn_id, parent_comment_id: row.parent_comment_id || null, kind: row.kind, relative_path: row.relative_path || '', line_number: row.line_number == null ? null : Number(row.line_number), content, content_sha256: row.content_sha256, created_at: row.created_at, created_by_actor_id: row.created_by_actor_id };
  }
}

export class DeterministicRepositoryDeletionAdapter {
  constructor({ repositories = [], deleteResult = 'deleted' } = {}) {
    this.repositories = new Map(repositories.map((row) => [String(row.full_name), { ...row }]));
    this.deleteResult = deleteResult;
    this.calls = [];
  }
  async delete({ target, intent }) {
    this.calls.push({ action: 'delete', target: target.id, full_name: intent.target_full_name });
    if (this.deleteResult === 'unknown') throw new PlatformError('external_result_unknown', 'repository deletion result is unknown', {}, 503);
    if (this.deleteResult === 'failed') throw new PlatformError('repository_delete_failed', 'repository deletion failed', {}, 502);
    const row = this.repositories.get(intent.target_full_name) || { id: `fixture-${intent.target_full_name}`, full_name: intent.target_full_name, head_sha: intent.expected_head_sha };
    if (row.head_sha && row.head_sha !== intent.expected_head_sha) throw new PlatformError('repository_head_conflict', 'repository HEAD changed', {}, 409);
    this.repositories.delete(intent.target_full_name);
    return { deleted: true, repository_id: String(row.id) };
  }
  async reconcile({ intent }) {
    this.calls.push({ action: 'reconcile', full_name: intent.target_full_name });
    const row = this.repositories.get(intent.target_full_name);
    return row ? { exists: true, repository_id: String(row.id), head_sha: row.head_sha || '' } : { exists: false, repository_id: intent.external_repository_id || '' };
  }
}

function templateAggregate(row, operationId, actorId, type, now, contentHash = '') {
  return { aggregateType: 'brief_template', aggregateId: row.id, revision: Number(row.revision), operationId, actorId, type, data: { template_id: row.id, status: row.status, current_revision: Number(row.current_revision) }, payload: { id: row.id, team_id: row.team_id, status: row.status, current_revision: Number(row.current_revision), content_sha256: contentHash, revision: Number(row.revision) }, now };
}
function deletionAggregate(type, row, operationId, actorId, projectId, eventType, now) { return { aggregateType: type, aggregateId: row.id, revision: Number(row.revision), operationId, actorId, projectId, type: eventType, data: { intent_id: row.id, status: row.status }, payload: { id: row.id, project_id: projectId, status: row.status, revision: Number(row.revision) }, now }; }
function assistAggregate(row, operationId, actorId, eventType, now) { return { aggregateType: 'assist_session', aggregateId: row.id, revision: Number(row.revision), operationId, actorId, projectId: row.project_id, type: eventType, data: { session_id: row.id }, payload: assistSessionView(row), now }; }
function projectDeletionView(row) { return { id: row.id, project_id: row.project_id, operation_id: row.operation_id, status: row.status, expected_project_revision: Number(row.expected_project_revision), target_name: row.target_name, blockers: parseJson(row.blockers_json, []), blockers_sha256: row.blockers_sha256, creator_actor_id: row.creator_actor_id, creator_confirmed_at: row.creator_confirmed_at || null, owner_actor_id: row.owner_actor_id || null, owner_confirmed_at: row.owner_confirmed_at || null, tombstone_sha256: row.tombstone_sha256 || '', revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null }; }
function repositoryDeletionView(row) { return { id: row.id, project_id: row.project_id, repository_target_id: row.repository_target_id, operation_id: row.operation_id, status: row.status, target_full_name: row.target_full_name, expected_head_sha: row.expected_head_sha, expected_target_revision: Number(row.expected_target_revision), creator_actor_id: row.creator_actor_id, creator_confirmed_at: row.creator_confirmed_at || null, owner_actor_id: row.owner_actor_id || null, owner_confirmed_at: row.owner_confirmed_at || null, external_repository_id: row.external_repository_id || '', external_receipt_sha256: row.external_receipt_sha256 || '', error_code: row.error_code || '', revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null }; }
function assistSessionView(row) { return { id: row.id, project_id: row.project_id, scope: row.scope, scope_id: row.scope_id, title: row.title || '', mode: row.mode || 'guided', parent_session_id: row.parent_session_id || null, fork_source_turn_id: row.fork_source_turn_id || null, pinned_at: row.pinned_at || null, archived_at: row.archived_at || null, deleted_at: row.deleted_at || null, context_pack_id: row.context_pack_id, profile_id: row.profile_id, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function confirmRepositorySnapshot(row, input) { if (repositoryName(input.target_full_name) !== row.target_full_name || String(input.expected_head_sha || '') !== row.expected_head_sha) throw new PlatformError('confirmation_mismatch', 'repository confirmation does not match the prepared name and HEAD', {}, 409); }
function repositoryName(value) { const result = String(value || '').trim(); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) throw new PlatformError('schema_invalid', 'repository full name is invalid', {}, 422); return result; }
function objectValue(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError('schema_invalid', `${label} must be an object`, {}, 422); return value; }
function publicTarget(row) { return { id: row.id, project_id: row.project_id, name: row.name, branch: row.branch, expected_head_sha: row.expected_head_sha, revision: Number(row.revision) }; }
