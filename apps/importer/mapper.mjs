import path from 'node:path';
import { canonicalJson, opaqueId, sha256Hex } from '../api/src/clean/canonical.mjs';
import { CasStore } from '../api/src/clean/cas.mjs';
import { EventService } from '../api/src/clean/events.mjs';
import { OperationService } from '../api/src/clean/operations.mjs';
import { RedactionPolicy } from '../api/src/clean/redaction.mjs';
import { appendAggregate, createOperation } from '../api/src/clean/p5-domain-helpers.mjs';
import { sanitizeRow } from './planner.mjs';
import { SqliteSourceReader } from './reader.mjs';
import { writeCheckpoint } from './checkpoint.mjs';

export class V23DomainMapper {
  constructor({ db, batchId, sourceFile, sourceManifest, plan, mapping, targetCasRoot, checkpointKey, now = () => new Date().toISOString() }) {
    this.db = db;
    this.batchId = batchId;
    this.source = new SqliteSourceReader(sourceFile, { expectedVersion: 23 });
    this.sourceManifest = sourceManifest;
    this.plan = plan;
    this.mapping = mapping;
    this.checkpointKey = checkpointKey;
    this.now = now;
    this.policy = new RedactionPolicy();
    this.events = new EventService({ db, policy: this.policy, cursorSecret: `import-${plan.plan_sha256}` });
    this.operations = new OperationService({ db, events: this.events, policy: this.policy, bootstrapActorId: this.#systemActor(), clock: now });
    this.cas = new CasStore({ root: path.resolve(targetCasRoot), db, policy: this.policy, clock: now });
    this.systemActorId = this.#systemActor();
    this.context = null;
  }

  async mapAll({ failAfterDomain = null } = {}) {
    await this.#ensureOwnerContext();
    const results = [];
    for (const domain of this.plan.domain_order) {
      if (this.db.get("SELECT id FROM import_checkpoints WHERE batch_id=? AND domain=? AND last_source_key LIKE 'boundary:%'", [this.batchId, domain])) { results.push({ domain, status: 'checkpoint_reused' }); continue; }
      const result = await this.mapDomain(domain);
      results.push(result);
      if (String(failAfterDomain || '') === domain) throw new Error(`import_injected_failure:${domain}`);
    }
    return results;
  }

  async mapDomain(domain) {
    const declaredOrder = [...(this.mapping.domains?.[domain]?.live || []), ...(this.mapping.domains?.[domain]?.evidence || [])];
    const tables = this.plan.classifications.filter((item) => item.domain === domain && item.disposition === 'target').sort((left, right) => declaredOrder.indexOf(left.table) - declaredOrder.indexOf(right.table));
    let processed = 0;
    let mapped = 0;
    for (const table of tables) {
      for (let offset = 0;; offset += 500) {
        const rows = this.source.rows(table.table, { offset, limit: 500 });
        if (!rows.length) break;
        for (const row of rows) {
          processed += 1;
          if (await this.#mapRow(table, row)) mapped += 1;
        }
        if (rows.length === 500) writeCheckpoint(this.db, { batchId: this.batchId, domain, lastSourceKey: `${table.table}:${sourceKey(table, rows.at(-1))}`, rowCount: processed, plan: this.plan, key: this.checkpointKey, now: this.now() });
      }
    }
    await this.#finalizeDomain(domain);
    const checkpoint = writeCheckpoint(this.db, { batchId: this.batchId, domain, lastSourceKey: `boundary:${domain}`, rowCount: processed, plan: this.plan, key: this.checkpointKey, now: this.now() });
    return { domain, processed, mapped, checkpoint_sha256: checkpoint.checkpoint_sha256 };
  }

  close() { this.source.close(); }

  async #mapRow(classification, row) {
    const key = sourceKey(classification, row);
    if (this.#mapped(classification.table, key)) return false;
    if (classification.mode === 'live') {
      if (classification.table === 'users') return this.#mapUser(row, key);
      if (classification.table === 'credential_refs') return this.#mapCredential(row, key);
      if (classification.table === 'codex_profiles') return this.#mapProfile(row, key);
      if (classification.table === 'projects') return this.#mapProject(row, key);
      if (classification.table === 'brief_revisions') return this.#mapBriefRevision(row, key);
      if (classification.table === 'repository_bindings') return this.#mapRepository(row, key);
      if (classification.table === 'workflow_revisions') return this.#mapWorkflowRevision(row, key);
      if (classification.table === 'context_sources') return this.#mapContextSource(row, key);
    }
    return this.#mapEvidence(classification, row, key);
  }

  async #ensureOwnerContext() {
    if (this.context) return this.context;
    let actor = this.db.get("SELECT a.* FROM actors a JOIN team_memberships m ON m.actor_id=a.id WHERE a.status='active' AND m.status='active' AND m.role='owner' ORDER BY a.kind='user' DESC,a.id LIMIT 1");
    if (!actor) actor = this.db.get("SELECT * FROM actors WHERE kind='system' AND status='active' ORDER BY id LIMIT 1");
    if (!actor) throw new Error('import_system_actor_missing');
    let team = this.db.get("SELECT t.* FROM teams t JOIN team_memberships m ON m.team_id=t.id WHERE m.actor_id=? AND m.status='active' AND m.role='owner' ORDER BY t.id LIMIT 1", [actor.id]);
    if (!team) {
      const teamId = deterministicId('team', 'v23', 'import-owner', this.plan.source_v23_sha256);
      const now = this.now();
      await this.db.withTransaction((tx) => {
        const metadata = { imported: true, source_manifest_sha256: this.plan.source_v23_sha256 };
        const metadataJson = canonicalJson(metadata);
        const op = createOperation(this.operations, tx, { actorId: actor.id, commandId: 'import.identity.bootstrap', resourceType: 'team', resourceId: teamId, requestHash: sha256Hex(metadataJson), status: 'succeeded', now });
        tx.run('INSERT INTO teams(id,name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,\'active\',?,?,1,?,?,?,?)', [teamId, 'Imported workspace', metadataJson, sha256Hex(metadataJson), now, now, actor.id, actor.id]);
        appendAggregate(this.events, tx, aggregate('team', teamId, 1, op.id, actor.id, null, 'team.imported', { id: teamId, name: 'Imported workspace', status: 'active', revision: 1 }, now));
        const membershipId = deterministicId('team_membership', 'v23', 'import-owner', actor.id);
        tx.run("INSERT INTO team_memberships(id,team_id,actor_id,role,status,revision,invited_by_actor_id,accepted_by_actor_id,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'owner','active',1,?,?,?,?,?,?)", [membershipId, teamId, actor.id, actor.id, actor.id, now, now, actor.id, actor.id]);
        appendAggregate(this.events, tx, aggregate('team_membership', membershipId, 1, op.id, actor.id, null, 'membership.imported', { id: membershipId, team_id: teamId, actor_id: actor.id, role: 'owner', status: 'active', revision: 1 }, now));
      });
      team = this.db.get('SELECT * FROM teams WHERE id=?', [teamId]);
    }
    this.context = { actorId: actor.id, teamId: team.id, evidenceProjectId: null };
    return this.context;
  }

  async #mapUser(row, sourceId) {
    const source = String(row.id || sourceId);
    const existing = this.db.get('SELECT * FROM actors WHERE id=?', [source]);
    const targetId = existing ? deterministicId('actor', 'v23', 'user', source) : source;
    const now = timestamp(row.created_at, this.now());
    const metadata = { imported: true, source_family: 'v23', source_id: source, source_revision: Number(row.revision || 1) };
    const metadataJson = canonicalJson(metadata);
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.identity.user', resourceType: 'actor', resourceId: targetId, requestHash: sha256Hex(metadataJson), status: 'succeeded', now });
      tx.run('INSERT INTO actors(id,kind,display_name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,\'user\',?,?,?, ?,1,?,?,?,?)', [targetId, bounded(row.display_name || 'Imported user', 160), row.status === 'disabled' ? 'suspended' : 'active', metadataJson, sha256Hex(metadataJson), now, timestamp(row.updated_at, now), this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('actor', targetId, 1, op.id, this.systemActorId, null, 'actor.imported', { id: targetId, kind: 'user', display_name: bounded(row.display_name || 'Imported user', 160), status: row.status === 'disabled' ? 'suspended' : 'active', revision: 1 }, now));
      this.#recordMap(tx, 'users', sourceId, targetId, existing ? 'deterministic_remap' : 'preserved', now);
      if (existing) this.#recordConflict(tx, 'users', [sourceId], 'technical_remap', 'remapped', { source_id: source, target_id: targetId }, now);
    });
    return true;
  }

  async #mapCredential(row, sourceId) {
    const owner = await this.#ownerActorFor(row.user_id);
    const targetId = this.#targetId('credential_refs', sourceId, 'credential');
    const provider = ['codex', 'github', 'mcp'].includes(String(row.provider)) ? String(row.provider) : 'codex';
    const metadata = { imported: true, source_family: 'v23', source_id: sourceId, label: String(row.label || ''), source_fingerprint: sha256Hex(canonicalJson(row)) };
    const metadataJson = canonicalJson(metadata);
    const now = timestamp(row.created_at, this.now());
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.credential.metadata', resourceType: 'credential', resourceId: targetId, requestHash: sha256Hex(metadataJson), status: 'succeeded', now });
      tx.run("INSERT INTO credential_refs(id,owner_actor_id,provider,scope_json,status,external_ref,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'{}','rebind_required',?,?,?,?,?,?,?,?)", [targetId, owner, provider, `imported:${sha256Hex(String(sourceId)).slice(0, 24)}`, metadataJson, sha256Hex(metadataJson), 1, now, now, this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('credential', targetId, 1, op.id, this.systemActorId, null, 'credential.imported', { id: targetId, provider, status: 'rebind_required', revision: 1 }, now));
      this.#recordMap(tx, 'credential_refs', sourceId, targetId, targetId === String(row.id || '') ? 'preserved' : 'deterministic_remap', now);
      this.#recordConflict(tx, 'credential_refs', [sourceId], 'secret_omitted', 'omitted', { fields: ['secret_ref'], rebind_required: true }, now);
    });
    return true;
  }

  async #mapProfile(row, sourceId) {
    const owner = await this.#ownerActorFor(row.user_id);
    const credentialId = this.#lookupMap('credential_refs', String(row.credential_ref || ''));
    if (!credentialId) return this.#blocking('codex_profiles', sourceId, 'missing_reference', { field: 'credential_ref' });
    const targetId = this.#targetId('codex_profiles', sourceId, 'provider_profile');
    const config = { model: String(row.model || ''), wire_api: String(row.wire_api || 'responses'), reasoning: String(row.reasoning || 'medium'), timeout_ms: Number(row.timeout_ms || 120000), imported: true };
    const configJson = canonicalJson(config);
    const now = timestamp(row.created_at, this.now());
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.profile.metadata', resourceType: 'profile', resourceId: targetId, requestHash: sha256Hex(configJson), status: 'succeeded', now });
      tx.run("INSERT INTO provider_profiles(id,owner_actor_id,provider,label,credential_ref_id,config_json,config_sha256,status,last_probe_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,'codex',?,?,?,?, 'rebind_required',NULL,1,?,?,?,?)", [targetId, owner, bounded(row.label || 'Imported profile', 160), credentialId, configJson, sha256Hex(configJson), now, timestamp(row.updated_at, now), this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('profile', targetId, 1, op.id, this.systemActorId, null, 'profile.imported', { id: targetId, provider: 'codex', status: 'rebind_required', revision: 1 }, now));
      this.#recordMap(tx, 'codex_profiles', sourceId, targetId, 'deterministic_remap', now);
    });
    return true;
  }

  async #mapProject(row, sourceId) {
    const context = await this.#ensureOwnerContext();
    const targetId = this.#targetId('projects', sourceId, 'project');
    const owner = await this.#ownerActorFor(row.owner_user_id || row.user_id);
    const metadata = { imported: true, source_family: 'v23', source_id: sourceId, source_revision: Number(row.revision || 1) };
    const metadataJson = canonicalJson(metadata);
    const now = timestamp(row.created_at, this.now());
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.project', resourceType: 'project', resourceId: targetId, projectId: targetId, requestHash: sha256Hex(metadataJson), status: 'succeeded', now });
      tx.run("INSERT INTO projects(id,team_id,owner_actor_id,name,description,status,onboarding_state,current_brief_revision,confirmed_brief_revision,confirmed_brief_hash,current_workflow_revision,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id,archived_at) VALUES(?,?,?,?,?,?, 'confirmed',0,NULL,'',0,?,?,1,?,?,?,?,?)", [targetId, context.teamId, owner, bounded(row.name || 'Imported project', 160), String(row.description || '').slice(0, 65536), row.status === 'archived' ? 'archived' : 'active', metadataJson, sha256Hex(metadataJson), now, timestamp(row.updated_at, now), this.systemActorId, this.systemActorId, row.status === 'archived' ? timestamp(row.updated_at, now) : null]);
      appendAggregate(this.events, tx, aggregate('project', targetId, 1, op.id, this.systemActorId, targetId, 'project.imported', { id: targetId, team_id: context.teamId, owner_actor_id: owner, name: bounded(row.name || 'Imported project', 160), status: row.status === 'archived' ? 'archived' : 'active', revision: 1 }, now));
      const membershipId = deterministicId('project_membership', 'v23', targetId, owner);
      tx.run("INSERT INTO project_memberships(id,project_id,actor_id,role,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'owner','active',1,?,?,?,?)", [membershipId, targetId, owner, now, now, this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('project_membership', membershipId, 1, op.id, this.systemActorId, targetId, 'membership.imported', { id: membershipId, project_id: targetId, actor_id: owner, role: 'owner', status: 'active', revision: 1 }, now));
      this.#recordMap(tx, 'projects', sourceId, targetId, targetId === String(row.id || '') ? 'preserved' : 'deterministic_remap', now);
    });
    return true;
  }

  async #mapBriefRevision(row, sourceId) {
    const projectId = this.#lookupMap('projects', String(row.project_id || ''));
    if (!projectId) return this.#blocking('brief_revisions', sourceId, 'missing_reference', { field: 'project_id' });
    const now = timestamp(row.created_at, this.now());
    const briefId = deterministicId('brief', 'v23', 'project', projectId);
    const revisionId = deterministicId('brief_revision', 'v23', projectId, String(row.revision || sourceId));
    let content;
    try { content = JSON.parse(String(row.content_json || '{}')); } catch { return this.#blocking('brief_revisions', sourceId, 'semantic_block', { field: 'content_json' }); }
    const contentJson = canonicalJson(content);
    await this.db.withTransaction((tx) => {
      let brief = tx.get('SELECT * FROM briefs WHERE project_id=?', [projectId]);
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.brief', resourceType: 'brief_revision', resourceId: revisionId, projectId, requestHash: sha256Hex(contentJson), status: 'succeeded', now });
      if (!brief) {
        tx.run("INSERT INTO briefs(id,project_id,status,current_revision,confirmed_revision,confirmed_hash,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,'confirmed',?,?,?,1,?,?,?,?)", [briefId, projectId, Number(row.revision || 1), Number(row.revision || 1), sha256Hex(contentJson), now, now, this.systemActorId, this.systemActorId]);
        appendAggregate(this.events, tx, aggregate('brief', briefId, 1, op.id, this.systemActorId, projectId, 'brief.imported', { id: briefId, project_id: projectId, status: 'confirmed', current_revision: Number(row.revision || 1), revision: 1 }, now));
      } else if (Number(row.revision || 1) > Number(brief.current_revision)) tx.run('UPDATE briefs SET current_revision=?,confirmed_revision=?,confirmed_hash=?,updated_at=? WHERE id=?', [Number(row.revision), Number(row.revision), sha256Hex(contentJson), now, brief.id]);
      tx.run('INSERT INTO brief_revisions(id,brief_id,project_id,revision,content_json,content_sha256,template,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,\'imported-v23\',?,?)', [revisionId, briefId, projectId, Number(row.revision || 1), contentJson, sha256Hex(contentJson), now, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('brief_revision', revisionId, 1, op.id, this.systemActorId, projectId, 'brief.revision.imported', { id: revisionId, brief_id: briefId, project_id: projectId, revision: Number(row.revision || 1), content_sha256: sha256Hex(contentJson) }, now));
      this.#recordMap(tx, 'brief_revisions', sourceId, revisionId, 'deterministic_remap', now);
    });
    return true;
  }

  async #mapRepository(row, sourceId) {
    const projectId = this.#lookupMap('projects', String(row.project_id || ''));
    if (!projectId) return this.#blocking('repository_bindings', sourceId, 'missing_reference', { field: 'project_id' });
    const connectionId = deterministicId('repository_connection', 'v23', sourceId);
    const targetId = deterministicId('repository_target', 'v23', sourceId);
    const lineId = deterministicId('repository_line', 'v23', sourceId);
    const now = timestamp(row.created_at, this.now());
    const remote = sanitizeRemote(row.remote_url || '');
    const metadata = { imported: true, local_path_sha256: row.local_path ? sha256Hex(String(row.local_path)) : null, source_id: sourceId };
    const metadataJson = canonicalJson(metadata);
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.repository', resourceType: 'repository_connection', resourceId: connectionId, projectId, requestHash: sha256Hex(metadataJson), status: 'succeeded', now });
      tx.run("INSERT INTO repository_connections(id,project_id,provider,credential_ref_id,status,source_kind,source_locator,source_revision,source_hash,read_only,metadata_json,metadata_sha256,fault_code,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,'git',NULL,'ready','git',?,?,?,?,?,?, '',1,?,?,?,?)", [connectionId, projectId, remote, String(row.head_sha || ''), sha256Hex(canonicalJson(row)), 1, metadataJson, sha256Hex(metadataJson), now, timestamp(row.updated_at, now), this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('repository_connection', connectionId, 1, op.id, this.systemActorId, projectId, 'repository.connection.imported', { id: connectionId, project_id: projectId, status: 'ready', revision: 1 }, now));
      tx.run("INSERT INTO repository_targets(id,connection_id,name,branch,remote_ref,expected_head_sha,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,'imported','main',?,?,1,?,?,?,?)", [targetId, connectionId, remote, String(row.head_sha || ''), now, now, this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('repository_target', targetId, 1, op.id, this.systemActorId, projectId, 'repository.target.imported', { id: targetId, connection_id: connectionId, revision: 1 }, now));
      tx.run("INSERT INTO repository_lines(id,project_id,target_id,line_kind,status,source_revision,source_hash,expected_head_sha,fault_code,fault_json,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'external_readonly','ready',?,?,?,'','{}',1,?,?,?,?)", [lineId, projectId, targetId, String(row.head_sha || ''), sha256Hex(canonicalJson(row)), String(row.head_sha || ''), now, now, this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('repository_line', lineId, 1, op.id, this.systemActorId, projectId, 'repository.line.imported', { id: lineId, project_id: projectId, target_id: targetId, status: 'ready', revision: 1 }, now));
      this.#recordMap(tx, 'repository_bindings', sourceId, connectionId, 'deterministic_remap', now);
      if (row.local_path) this.#recordConflict(tx, 'repository_bindings', [sourceId], 'secret_omitted', 'omitted', { field: 'local_path', sha256: sha256Hex(String(row.local_path)) }, now);
    });
    return true;
  }

  async #mapWorkflowRevision(row, sourceId) {
    const projectId = this.#lookupMap('projects', String(row.project_id || ''));
    if (!projectId) return this.#blocking('workflow_revisions', sourceId, 'missing_reference', { field: 'project_id' });
    const workflowId = deterministicId('workflow', 'v23', projectId);
    const revisionId = deterministicId('workflow_revision', 'v23', projectId, String(row.revision || sourceId));
    let tasks;
    try { tasks = JSON.parse(String(row.tasks_json || '[]')); } catch { return this.#blocking('workflow_revisions', sourceId, 'semantic_block', { field: 'tasks_json' }); }
    const graph = { nodes: Array.isArray(tasks) ? tasks : [] };
    const graphJson = canonicalJson(graph);
    const layoutJson = canonicalJson({});
    const now = timestamp(row.created_at, this.now());
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.workflow', resourceType: 'workflow_revision', resourceId: revisionId, projectId, requestHash: sha256Hex(graphJson), status: 'succeeded', now });
      let workflow = tx.get('SELECT * FROM workflows WHERE project_id=?', [projectId]);
      if (!workflow) {
        tx.run("INSERT INTO workflows(id,project_id,status,current_revision,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,'active',?,1,?,?,?,?)", [workflowId, projectId, Number(row.revision || 1), now, now, this.systemActorId, this.systemActorId]);
        appendAggregate(this.events, tx, aggregate('workflow', workflowId, 1, op.id, this.systemActorId, projectId, 'workflow.imported', { id: workflowId, project_id: projectId, status: 'active', current_revision: Number(row.revision || 1), revision: 1 }, now));
      } else if (Number(row.revision || 1) > Number(workflow.current_revision)) tx.run('UPDATE workflows SET current_revision=?,updated_at=? WHERE id=?', [Number(row.revision), now, workflow.id]);
      tx.run("INSERT INTO workflow_revisions(id,workflow_id,project_id,revision,graph_json,graph_sha256,layout_json,layout_sha256,source_brief_revision,source_brief_hash,proposal_id,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,0,'',NULL,?,?)", [revisionId, workflowId, projectId, Number(row.revision || 1), graphJson, sha256Hex(graphJson), layoutJson, sha256Hex(layoutJson), now, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('workflow_revision', revisionId, 1, op.id, this.systemActorId, projectId, 'workflow.revision.imported', { id: revisionId, workflow_id: workflowId, project_id: projectId, revision: Number(row.revision || 1), graph_sha256: sha256Hex(graphJson) }, now));
      this.#recordMap(tx, 'workflow_revisions', sourceId, revisionId, 'deterministic_remap', now);
    });
    return true;
  }

  async #mapContextSource(row, sourceId) {
    const projectId = this.#lookupMap('projects', String(row.project_id || ''));
    if (!projectId) return this.#blocking('context_sources', sourceId, 'missing_reference', { field: 'project_id' });
    const content = Buffer.from(String(row.content || ''), 'utf8');
    let object;
    try { object = this.cas.put(content, { mediaType: 'text/plain', metadata: { kind: 'imported_context', source_id: sourceId } }); } catch (error) { return this.#blocking('context_sources', sourceId, 'semantic_block', { reason: String(error.code || error.message) }); }
    const sourceIdTarget = this.#targetId('context_sources', sourceId, 'context_source');
    const nodeId = deterministicId('context_node', 'v23', sourceId);
    const versionId = deterministicId('context_document', 'v23', sourceId);
    const sourceHash = isHash(row.content_hash) ? String(row.content_hash) : object.hash;
    const metadata = { imported: true, legacy_kind: String(row.kind || 'note'), legacy_path_sha256: row.path ? sha256Hex(String(row.path)) : null };
    const metadataJson = canonicalJson(metadata);
    const now = timestamp(row.created_at, this.now());
    const uri = `aiws://import/v23/context/${encodeURIComponent(sourceId)}`;
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.context', resourceType: 'context_source', resourceId: sourceIdTarget, projectId, requestHash: object.hash, status: 'succeeded', now });
      tx.run("INSERT INTO context_sources(id,project_id,source_type,canonical_uri,title,adapter,source_revision,source_hash,cas_hash,sensitivity,freshness_status,metadata_json,metadata_sha256,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?, 'note',?,?, 'note','1',?,?, 'normal','current',?,?,'active',1,?,?,?,?)", [sourceIdTarget, projectId, uri, bounded(row.title || 'Imported context', 240), sourceHash, object.hash, metadataJson, sha256Hex(metadataJson), now, now, this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('context_source', sourceIdTarget, 1, op.id, this.systemActorId, projectId, 'context_source.imported', { id: sourceIdTarget, project_id: projectId, source_hash: sourceHash, revision: 1 }, now));
      tx.run("INSERT INTO context_nodes(id,project_id,stable_uri,source_id,parent_id,node_kind,title,source_revision,source_hash,sensitivity,freshness_status,required_scopes_json,sort_json,current_document_version_id,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,NULL,'note',?,'1',?,'normal','current','[\"context:read\"]','{}',NULL,'active',1,?,?,?,?)", [nodeId, projectId, uri, sourceIdTarget, bounded(row.title || 'Imported context', 240), sourceHash, now, now, this.systemActorId, this.systemActorId]);
      appendAggregate(this.events, tx, aggregate('context_node', nodeId, 1, op.id, this.systemActorId, projectId, 'context.node.imported', { id: nodeId, project_id: projectId, source_id: sourceIdTarget, revision: 1 }, now));
      tx.run("INSERT INTO context_document_versions(id,project_id,node_id,version,source_revision,source_hash,content_hash,cas_hash,cas_relative_key,token_estimate,renderer_version,created_at,created_by_actor_id) VALUES(?,?,?,1,'1',?,?,?,?,?,'context-importer-v1',?,?)", [versionId, projectId, nodeId, sourceHash, object.hash, object.hash, object.relative_key, Math.ceil(content.length / 4), now, this.systemActorId]);
      tx.run('UPDATE context_nodes SET current_document_version_id=? WHERE id=?', [versionId, nodeId]);
      appendAggregate(this.events, tx, aggregate('context_document_version', versionId, 1, op.id, this.systemActorId, projectId, 'context.document.imported', { id: versionId, project_id: projectId, node_id: nodeId, content_hash: object.hash }, now));
      this.#recordMap(tx, 'context_sources', sourceId, sourceIdTarget, sourceIdTarget === String(row.id || '') ? 'preserved' : 'deterministic_remap', now);
      if (row.path) this.#recordConflict(tx, 'context_sources', [sourceId], 'secret_omitted', 'omitted', { field: 'path', sha256: sha256Hex(String(row.path)) }, now);
    });
    return true;
  }

  async #mapEvidence(classification, row, sourceId) {
    const sanitized = sanitizeRow(classification.table, row, this.mapping);
    const projectId = await this.#projectForEvidence(row.project_id);
    const payload = { schema_version: 'aiws.imported-row.v1', source_family: 'v23', source_table: classification.table, source_key: sourceId, domain: classification.domain, fields: sanitized.value, omitted: sanitized.omitted };
    let objectRef;
    try { objectRef = this.cas.putCanonical(payload, { metadata: { kind: 'imported_row', domain: classification.domain, table: classification.table } }); } catch (error) { return this.#blocking(classification.table, sourceId, 'semantic_block', { reason: String(error.code || error.message) }); }
    const assetId = deterministicId('asset', 'v23', classification.table, sourceId);
    const versionId = deterministicId('asset_version', 'v23', classification.table, sourceId);
    const now = this.now();
    await this.db.withTransaction((tx) => {
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: `import.${classification.domain.toLowerCase()}.preserve`, resourceType: 'asset', resourceId: assetId, projectId, requestHash: objectRef.hash, status: 'succeeded', now });
      let blob = tx.get('SELECT * FROM asset_blobs WHERE cas_sha256=?', [objectRef.hash]);
      if (!blob) {
        const blobId = deterministicId('asset_blob', 'v23', objectRef.hash);
        const manifest = { schema_version: 'evidence.asset-blob.v2', content_sha256: objectRef.hash, byte_length: objectRef.byte_length, media_type: 'application/json', cas_sha256: objectRef.hash };
        const manifestJson = canonicalJson(manifest);
        tx.run("INSERT INTO asset_blobs(id,cas_sha256,content_sha256,byte_length,media_type,encryption_kind,key_ref,manifest_json,manifest_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,'none','',?,?,?,?)", [blobId, objectRef.hash, objectRef.hash, objectRef.byte_length, 'application/json', manifestJson, sha256Hex(manifestJson), now, this.systemActorId]);
        blob = tx.get('SELECT * FROM asset_blobs WHERE id=?', [blobId]);
      }
      const sourceRef = `v23:${classification.table}:${sourceId}`.slice(0, 512);
      const logicalName = `legacy/${classification.domain}/${classification.table}/${sourceId}`.slice(0, 512);
      tx.run("INSERT INTO assets(id,project_id,execution_id,logical_name,asset_kind,source_type,source_ref,current_version_id,current_version,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,NULL,?,'other','manual',?,NULL,0,'active',1,?,?,?,?)", [assetId, projectId, logicalName, sourceRef, now, now, this.systemActorId, this.systemActorId]);
      const metadata = { imported: true, domain: classification.domain, source_table: classification.table, source_key: sourceId, omitted_fields: sanitized.omitted.map((item) => item.field) };
      const metadataJson = canonicalJson(metadata);
      tx.run('INSERT INTO asset_versions(id,asset_id,version_no,blob_id,parser_run_id,source_operation_id,source_revision,source_sha256,content_sha256,metadata_json,metadata_sha256,created_at,created_by_actor_id) VALUES(?,?,1,?,NULL,?,0,?,?,?,?,?,?)', [versionId, assetId, blob.id, op.id, objectRef.hash, objectRef.hash, metadataJson, sha256Hex(metadataJson), now, this.systemActorId]);
      tx.run('UPDATE assets SET current_version_id=?,current_version=1 WHERE id=?', [versionId, assetId]);
      appendAggregate(this.events, tx, aggregate('asset', assetId, 1, op.id, this.systemActorId, projectId, 'asset.imported', { id: assetId, project_id: projectId, content_sha256: objectRef.hash, source_table: classification.table }, now));
      this.#recordMap(tx, classification.table, sourceId, assetId, 'deterministic_remap', now);
      if (sanitized.omitted.length) this.#recordConflict(tx, classification.table, [sourceId], 'secret_omitted', 'omitted', { fields: sanitized.omitted }, now);
    });
    return true;
  }

  async #finalizeDomain(domain) {
    if (domain === 'Project') {
      const projects = this.db.query("SELECT target_id FROM import_id_map WHERE batch_id=? AND source_family='v23' AND entity_type='projects'", [this.batchId]);
      for (const { target_id: projectId } of projects) {
        const brief = this.db.get('SELECT * FROM briefs WHERE project_id=?', [projectId]);
        if (!brief) continue;
        await this.#updateProjectAggregate(projectId, { current_brief_revision: Number(brief.current_revision), confirmed_brief_revision: Number(brief.confirmed_revision), confirmed_brief_hash: brief.confirmed_hash }, 'project.brief.imported');
      }
    }
    if (domain === 'Workflow') {
      const projects = this.db.query("SELECT target_id FROM import_id_map WHERE batch_id=? AND source_family='v23' AND entity_type='projects'", [this.batchId]);
      for (const { target_id: projectId } of projects) {
        const workflow = this.db.get('SELECT * FROM workflows WHERE project_id=?', [projectId]);
        if (workflow) await this.#updateProjectAggregate(projectId, { current_workflow_revision: Number(workflow.current_revision) }, 'project.workflow.imported');
      }
    }
  }

  async #updateProjectAggregate(projectId, fields, eventType) {
    const now = this.now();
    await this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM projects WHERE id=?', [projectId]);
      const revision = Number(current.revision) + 1;
      const assignments = Object.keys(fields).map((field) => `${field}=?`).join(',');
      tx.run(`UPDATE projects SET ${assignments},revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [...Object.values(fields), revision, now, this.systemActorId, projectId, current.revision], 1);
      const next = tx.get('SELECT * FROM projects WHERE id=?', [projectId]);
      const op = createOperation(this.operations, tx, { actorId: this.systemActorId, commandId: 'import.project.aggregate', resourceType: 'project', resourceId: projectId, projectId, requestHash: sha256Hex(canonicalJson(fields)), status: 'succeeded', now });
      appendAggregate(this.events, tx, aggregate('project', projectId, revision, op.id, this.systemActorId, projectId, eventType, projectPayload(next), now));
    });
  }

  async #projectForEvidence(sourceProjectId) {
    const mapped = sourceProjectId == null ? null : this.#lookupMap('projects', String(sourceProjectId));
    if (mapped) return mapped;
    if (this.context.evidenceProjectId) return this.context.evidenceProjectId;
    const sourceId = '__import_evidence__';
    await this.#mapProject({ id: sourceId, name: 'Imported records', description: 'Preserved schema-23 records', status: 'active', created_at: this.now(), updated_at: this.now() }, sourceId);
    this.context.evidenceProjectId = this.#lookupMap('projects', sourceId);
    return this.context.evidenceProjectId;
  }

  async #ownerActorFor(sourceUserId) { return sourceUserId ? this.#lookupMap('users', String(sourceUserId)) || this.context.actorId : this.context.actorId; }
  #mapped(table, sourceId) { return Boolean(this.db.get("SELECT id FROM import_id_map WHERE batch_id=? AND source_family='v23' AND entity_type=? AND source_id=?", [this.batchId, table, String(sourceId)])); }
  #lookupMap(table, sourceId) { return this.db.get("SELECT target_id FROM import_id_map WHERE batch_id=? AND source_family='v23' AND entity_type=? AND source_id=?", [this.batchId, table, String(sourceId)])?.target_id || null; }
  #targetId(table, sourceId, prefix) { const requested = String(sourceId || ''); return requested && !this.db.get(`SELECT id FROM ${quoteTable(targetTable(table))} WHERE id=?`, [requested]) ? requested : deterministicId(prefix, 'v23', table, requested); }
  #systemActor() { return this.db.get("SELECT id FROM actors WHERE kind='system' ORDER BY id LIMIT 1")?.id || 'actor_system_bootstrap'; }

  #recordMap(tx, entityType, sourceId, targetId, reason, now) {
    const body = { batch_id: this.batchId, source_family: 'v23', entity_type: entityType, source_id: String(sourceId), target_id: String(targetId), mapping_reason: reason };
    tx.run('INSERT INTO import_id_map(id,batch_id,source_family,entity_type,source_id,target_id,mapping_reason,mapping_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [opaqueId('import_map'), this.batchId, 'v23', entityType, String(sourceId), String(targetId), reason, sha256Hex(canonicalJson(body)), now]);
  }

  #recordConflict(tx, entityType, sourceIds, kind, disposition, details, now) {
    tx.run('INSERT INTO import_conflicts(id,batch_id,entity_type,source_ids_json,conflict_kind,disposition,details_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('import_conflict'), this.batchId, entityType, canonicalJson(sourceIds.map(String)), kind, disposition, sha256Hex(canonicalJson(details)), now]);
  }

  async #blocking(entityType, sourceId, kind, details) {
    const now = this.now();
    await this.db.withTransaction((tx) => this.#recordConflict(tx, entityType, [sourceId], kind, 'blocked', details, now));
    return false;
  }
}

function sourceKey(classification, row) { const fields = classification.key_columns?.length ? classification.key_columns : Object.keys(row); return fields.map((field) => String(row[field] ?? '')).join('|') || sha256Hex(canonicalJson(row)); }
function deterministicId(prefix, ...parts) { return `${prefix}_${sha256Hex(canonicalJson(parts)).slice(0, 40)}`; }
function timestamp(value, fallback) { const parsed = Date.parse(String(value || '')); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback; }
function bounded(value, maximum) { const text = String(value || '').trim() || 'Imported'; return text.slice(0, maximum); }
function isHash(value) { return /^[a-f0-9]{64}$/i.test(String(value || '')); }
function sanitizeRemote(value) { const text = String(value || '').trim(); try { const url = new URL(text); url.username = ''; url.password = ''; return url.toString().slice(0, 512); } catch { return text.replace(/^[A-Za-z]:[\\/].*$/, '').replace(/^\/(?!\/).*/, '').slice(0, 512); } }
function aggregate(type, id, revision, operationId, actorId, projectId, eventType, payload, now) { return { aggregateType: type, aggregateId: id, revision, operationId, actorId, projectId, type: eventType, data: { id }, payload, now }; }
function projectPayload(row) { return { id: row.id, team_id: row.team_id, owner_actor_id: row.owner_actor_id, name: row.name, description: row.description, status: row.status, onboarding_state: row.onboarding_state, current_brief_revision: Number(row.current_brief_revision), confirmed_brief_revision: row.confirmed_brief_revision == null ? null : Number(row.confirmed_brief_revision), confirmed_brief_hash: row.confirmed_brief_hash, current_workflow_revision: Number(row.current_workflow_revision), revision: Number(row.revision) }; }
function quoteTable(value) { if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('target_table_invalid'); return `"${value}"`; }
function targetTable(source) { return ({ users: 'actors', credential_refs: 'credential_refs', codex_profiles: 'provider_profiles', projects: 'projects', brief_revisions: 'brief_revisions', repository_bindings: 'repository_connections', workflow_revisions: 'workflow_revisions', context_sources: 'context_sources' })[source] || 'assets'; }
