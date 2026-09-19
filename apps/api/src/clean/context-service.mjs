import { randomBytes } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import MiniSearch from 'minisearch';
import { canonicalJson, opaqueId, sha256Hex, utcNow } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

const HASH = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/;
const SENSITIVITY = new Set(['normal', 'sensitive', 'restricted', 'secret']);
const SOURCE_TYPES = new Set(['project', 'brief', 'repository', 'workflow', 'node_contract', 'note', 'file', 'diff', 'test_report']);
const TYPE_ORDER = Object.freeze({ project: 10, brief: 20, repository: 30, workflow: 40, node_contract: 50, note: 60, file: 70, diff: 80, test_report: 90 });
const INDEX_OPTIONS = Object.freeze({
  fields: Object.freeze(['title', 'text', 'kind', 'uri']),
  storeFields: Object.freeze(['id', 'uri', 'title', 'kind', 'token_estimate', 'source_id'])
});

/**
 * Clean Context owner. It deliberately uses synchronous database callbacks so
 * operation, aggregate revision, event and domain row updates share one
 * transaction. Expensive index payloads are written to CAS before the final
 * publish transaction, which leaves only unreachable garbage on a failed
 * publish and never a partially visible projection.
 */
export class CleanContextService {
  constructor({ db, cas, events, operations, authorization, policy, files = null, clock = utcNow, bootstrapActorId = 'actor_system_bootstrap', config = {} } = {}) {
    if (!db || !cas || !events || !operations) throw new TypeError('clean_context_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.files = files;
    this.redactionPolicy = policy;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.recoveryStarted = false;
  }

  time() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }

  assertProject(projectId, principal, action = 'read', resource = 'context') {
    const id = String(projectId || '');
    if (!id || !this.db.get('SELECT id FROM projects WHERE id=?', [id])) throw new PlatformError('not_found', 'project not found', {}, 404);
    if (this.authorization) this.authorization.assert(principal, action, id, { resource });
    return id;
  }

  listSources(projectId, principal, query = '') {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const text = String(query || '').trim().toLowerCase();
    const rows = this.db.query('SELECT * FROM context_sources WHERE project_id=? AND status=? ORDER BY canonical_uri,id', [id, 'active']);
    return rows.filter((row) => !text || `${row.title} ${row.canonical_uri} ${row.source_type}`.toLowerCase().includes(text)).map(sourceView);
  }

  async createSource(projectId, input = {}, principal, options = {}) {
    const id = this.assertProject(projectId, principal, 'write', 'context');
    const sourceType = normalizeSourceType(input.source_type || input.kind || 'note');
    const title = bounded(input.title || input.name || sourceType, 240);
    const canonicalUri = canonicalUriFor(id, input.canonical_uri || input.uri || input.path || `${sourceType}/${title}`);
    let content = String(input.content ?? input.body ?? '');
    let fileRef = null;
    if (input.file_ref_id) {
      if (!this.files?.readIndexedFile) throw new PlatformError('files_owner_unavailable', 'Files owner is unavailable for file-backed context', {}, 503);
      const checked = this.files.readIndexedFile(
        id,
        String(input.file_ref_id),
        input.expected_file_revision,
        input.expected_file_hash,
        principal
      );
      fileRef = checked.file;
      const bytes = checked.bytes;
      if (bytes.includes(0) || !isUtf8(bytes)) throw new PlatformError('file_not_previewable', 'binary files cannot be selected as context', {}, 422);
      content = bytes.toString('utf8');
    }
    if (content.length > 2_000_000) throw new PlatformError('invalid_input', 'context source is too large', {}, 422);
    const sensitivity = normalizeSensitivity(input.sensitivity);
    const metadata = safeObject(input.metadata);
    const metadataJson = canonicalJson(metadata);
    const contentHash = sha256Hex(content);
    const casObject = this.cas.put(content, { mediaType: input.media_type || 'text/plain; charset=utf-8', metadata: { project_id: id, source_type: sourceType, sensitivity } });
    const now = this.time();
    const actorId = actorOf(principal, this.bootstrapActorId);
    const key = requireKey(input.idempotency_key || options.idempotencyKey);
    const sourceRevision = fileRef ? String(fileRef.revision) : String(input.source_revision || '');
    const request = { project_id: id, source_type: sourceType, canonical_uri: canonicalUri, title, source_revision: sourceRevision, source_hash: contentHash, cas_hash: casObject.hash, sensitivity, metadata, file_ref_id: fileRef?.id || null };
    const requestHash = sha256Hex(canonicalJson(request));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'context.source.create', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      if (fileRef) this.files.readIndexedFile(id, fileRef.id, fileRef.revision, fileRef.content_sha256, principal);
      const existing = tx.get('SELECT * FROM context_sources WHERE project_id=? AND canonical_uri=?', [id, canonicalUri]);
      if (existing && existing.source_hash === contentHash && existing.source_revision === sourceRevision && existing.status === 'active') {
        const response = { source: sourceView(existing), operation: null, replayed: true };
        this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.source.create', idempotencyKey: key, requestHash, response, responseStatus: 200, now });
        return response;
      }
      const sourceId = existing?.id || opaqueId('ctxsrc');
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'context.source.create', kind: 'context.source.create', resourceType: 'context_source', resourceId: sourceId, projectId: id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      const revision = Number(existing?.revision || 0) + 1;
      if (existing) {
        tx.run(`UPDATE context_sources SET source_type=?,title=?,adapter=?,source_revision=?,source_hash=?,cas_hash=?,sensitivity=?,freshness_status='current',metadata_json=?,metadata_sha256=?,status='active',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [sourceType, title, String(input.adapter || sourceType), sourceRevision, contentHash, casObject.hash, sensitivity, metadataJson, sha256Hex(metadataJson), revision, now, actorId, sourceId, Number(existing.revision)], 1);
      } else {
        tx.run(`INSERT INTO context_sources(id,project_id,source_type,canonical_uri,title,adapter,source_revision,source_hash,cas_hash,sensitivity,freshness_status,metadata_json,metadata_sha256,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`, [sourceId, id, sourceType, canonicalUri, title, String(input.adapter || sourceType), sourceRevision, contentHash, casObject.hash, sensitivity, 'current', metadataJson, sha256Hex(metadataJson), now, now, actorId, actorId]);
      }
      const row = tx.get('SELECT * FROM context_sources WHERE id=?', [sourceId]);
      const payload = sourcePayload(row);
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_source', aggregateId: sourceId, revision, payload, operationId: operation.operation_id, actorId, projectId: id, type: existing ? 'context_source.updated' : 'context_source.created', data: { source_id: sourceId, project_id: id, source_hash: contentHash }, now, auditAction: 'context.source.create' });
      this.operations.linkInTransaction(tx, operation.operation_id, [['context_source', sourceId]], now);
      const response = { source: sourceView(row), operation: this.operations.summary(operation), replayed: false };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.source.create', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: existing ? 200 : 201, now });
      return response;
    });
  }

  map(projectId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const nodes = this.db.query('SELECT * FROM context_nodes WHERE project_id=? ORDER BY stable_uri,id', [id]).map(nodeView);
    const edges = this.db.query('SELECT id,parent_node_id AS parent_id,child_node_id AS child_id,relation,order_index,metadata_json,created_at FROM context_edges WHERE project_id=? ORDER BY parent_node_id,order_index,child_node_id,id', [id]).map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
    return { schema_version: 'aiws.context_map.v3', project_id: id, root_uri: `aiws://context/${id}`, nodes, edges, index: this.indexStatus(id) };
  }

  search(projectId, principal, query = '', options = {}) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const text = String(query || '').trim();
    if (!text) return [];
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const snapshot = this.db.get('SELECT * FROM context_index_snapshots WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [id]);
    if (!snapshot) return [];
    let payload;
    try { payload = JSON.parse(this.cas.read(snapshot.payload_cas_hash).toString('utf8')); }
    catch { throw new PlatformError('context_projection_unavailable', 'context index CAS content is unavailable', {}, 503); }
    if (payload?.index_hash !== snapshot.index_hash || !payload?.mini_search) throw new PlatformError('context_projection_unavailable', 'context index snapshot is invalid', {}, 503);
    let index;
    try { index = MiniSearch.loadJSON(JSON.stringify(payload.mini_search), INDEX_OPTIONS); }
    catch { throw new PlatformError('context_projection_unavailable', 'context index snapshot cannot be loaded', {}, 503); }
    const policy = normalizePolicy(this.policy(id, principal).policy);
    const rows = this.db.query(`SELECT n.*,v.token_estimate FROM context_nodes n
      LEFT JOIN context_document_versions v ON v.id=n.current_document_version_id
      WHERE n.project_id=? AND n.status='active'`, [id]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return index.search(text, { prefix: true, fuzzy: 0.2 })
      .map((match) => ({ match, row: byId.get(String(match.id)) }))
      .filter(({ row }) => row && row.sensitivity !== 'secret' && row.freshness_status !== 'missing'
        && !policy.excluded_node_ids.includes(row.id)
        && (!policy.source_allowlist.length || policy.source_allowlist.includes(row.source_id))
        && sensitivityRank(row.sensitivity) <= sensitivityRank(policy.sensitivity_max))
      .map(({ match, row }) => ({ node_id: row.id, source_id: row.source_id, uri: row.stable_uri, title: row.title, kind: row.node_kind, score: Number(match.score), token_estimate: Number(row.token_estimate || 0), sensitivity: row.sensitivity }))
      .sort((a, b) => b.score - a.score || typeOrder(a.kind) - typeOrder(b.kind) || a.uri.localeCompare(b.uri) || a.node_id.localeCompare(b.node_id))
      .slice(0, limit);
  }

  read(projectId, nodeId, principal, options = {}) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const row = this.db.get('SELECT * FROM context_nodes WHERE id=? AND project_id=?', [String(nodeId), id]);
    if (!row) throw new PlatformError('not_found', 'context node not found', {}, 404);
    const document = options.version_id || options.versionId
      ? this.db.get('SELECT * FROM context_document_versions WHERE id=? AND node_id=?', [String(options.version_id || options.versionId), row.id])
      : this.db.get('SELECT * FROM context_document_versions WHERE id=?', [row.current_document_version_id]);
    const value = nodeView(row);
    if (!document) return { ...value, document: null };
    let content;
    try { content = this.cas.read(document.cas_hash).toString('utf8'); } catch (error) { throw new PlatformError('context_projection_unavailable', 'context document CAS content is unavailable', { reason: String(error?.code || 'cas_missing') }, 503); }
    return { ...value, document: { ...document, content } };
  }

  versions(projectId, nodeId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    if (!this.db.get('SELECT id FROM context_nodes WHERE id=? AND project_id=?', [String(nodeId), id])) throw new PlatformError('not_found', 'context node not found', {}, 404);
    return this.db.query('SELECT id,project_id,node_id,version,source_revision,source_hash,content_hash,cas_hash,cas_relative_key,token_estimate,renderer_version,created_at FROM context_document_versions WHERE node_id=? ORDER BY version', [String(nodeId)]);
  }

  policy(projectId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const row = this.db.get('SELECT * FROM context_policies WHERE project_id=?', [id]);
    const value = row ? parseJson(row.policy_json, {}) : defaultPolicy();
    return { project_id: id, revision: Number(row?.revision || 0), hash: row?.policy_sha256 || sha256Hex(canonicalJson(value)), policy: value };
  }

  async updatePolicy(projectId, input = {}, principal, options = {}) {
    const id = this.assertProject(projectId, principal, 'write', 'context');
    const actorId = actorOf(principal, this.bootstrapActorId);
    const current = this.policy(id, principal);
    const expected = Number(input.expected_revision ?? options.expectedRevision);
    if (!Number.isInteger(expected) || expected < 0) throw new PlatformError('expected_revision_required', 'expected_revision is required', { current_revision: current.revision }, 400);
    if (expected !== current.revision) throw new PlatformError('context_policy_conflict', 'context policy revision has changed', { expected_revision: expected, current_revision: current.revision }, 409);
    const value = normalizePolicy(input.policy || input);
    const hash = sha256Hex(canonicalJson(value));
    const now = this.time();
    const key = requireKey(input.idempotency_key || options.idempotencyKey);
    const requestHash = sha256Hex(canonicalJson({ project_id: id, policy: value, expected_revision: expected }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'context.policy.update', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'context.policy.update', kind: 'context.policy.update', resourceType: 'context_policy', resourceId: id, projectId: id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      const revision = expected + 1;
      const existing = tx.get('SELECT * FROM context_policies WHERE project_id=?', [id]);
      if (existing) tx.run('UPDATE context_policies SET policy_json=?,policy_sha256=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE project_id=? AND revision=?', [canonicalJson(value), hash, revision, now, actorId, id, expected], 1);
      else tx.run('INSERT INTO context_policies(id,project_id,policy_json,policy_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?)', [opaqueId('ctxpol'), id, canonicalJson(value), hash, revision, now, now, actorId, actorId]);
      const payload = { project_id: id, revision, policy: value, policy_sha256: hash };
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_policy', aggregateId: id, revision, payload, operationId: operation.operation_id, actorId, projectId: id, type: 'context_policy.updated', data: { project_id: id, revision, policy_sha256: hash }, now, auditAction: 'context.policy.update' });
      this.operations.linkInTransaction(tx, operation.operation_id, [['context_policy', id]], now);
      const response = { ...this.policy(id, principal), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.policy.update', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 200, now });
      return response;
    });
  }

  listSelections(projectId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    return this.db.query('SELECT * FROM context_selections WHERE project_id=? ORDER BY created_at DESC,id DESC', [id]).map(selectionView);
  }

  async createSelection(projectId, input = {}, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const actorId = actorOf(principal, this.bootstrapActorId);
    const budget = Number(input.token_budget ?? input.retrieval_plan?.token_budget ?? 12000);
    if (!Number.isInteger(budget) || budget < 256 || budget > 128000) throw new PlatformError('invalid_input', 'token_budget must be between 256 and 128000', {}, 422);
    const policy = this.policy(id, principal);
    const nodes = this.db.query(`SELECT n.*,v.id AS version_id,v.content_hash,v.cas_hash,v.token_estimate
      FROM context_nodes n LEFT JOIN context_document_versions v ON v.id=n.current_document_version_id
      WHERE n.project_id=? AND n.status='active' ORDER BY n.stable_uri,n.id`, [id]);
    const explicit = new Set((Array.isArray(input.node_ids) ? input.node_ids : []).map(String));
    if (explicit.size && [...explicit].some((nodeId) => !nodes.some((row) => row.id === nodeId))) throw new PlatformError('project_denied', 'context node is outside the project scope', {}, 403);
    const normalized = normalizePolicy(policy.policy);
    const queryTerms = tokenize(input.query || '');
    const mandatory = new Set((Array.isArray(input.mandatory_node_ids) ? input.mandatory_node_ids : []).map(String));
    const candidates = nodes.filter((row) => row.sensitivity !== 'secret' && row.freshness_status !== 'missing' && !normalized.excluded_node_ids.includes(row.id) && (!normalized.source_allowlist.length || normalized.source_allowlist.includes(row.source_id)) && (!explicit.size || explicit.has(row.id)) && (!normalized.sensitivity_max || sensitivityRank(row.sensitivity) <= sensitivityRank(normalized.sensitivity_max)));
    const missingMandatory = [...mandatory].filter((nodeId) => !candidates.some((row) => row.id === nodeId));
    if (missingMandatory.length) throw new PlatformError('evidence_incomplete', 'mandatory context evidence is unavailable', { missing_node_ids: missingMandatory }, 409);
    const ranked = candidates.map((row) => {
      let score = queryTerms.length ? queryTerms.reduce((sum, term) => sum + countTerm(row.title.toLowerCase(), term), 0) : 0;
      if (normalized.pinned_node_ids.includes(row.id)) score += 100000;
      return { row, score };
    }).sort((a, b) => (normalized.pinned_node_ids.includes(b.row.id) ? 1 : 0) - (normalized.pinned_node_ids.includes(a.row.id) ? 1 : 0) || b.score - a.score || typeOrder(a.row.node_kind) - typeOrder(b.row.node_kind) || a.row.stable_uri.localeCompare(b.row.stable_uri) || a.row.id.localeCompare(b.row.id));
    const included = [];
    const excluded = [];
    let used = 0;
    for (const { row } of ranked) {
      const tokens = Number(row.token_estimate || 0);
      const item = { node_id: row.id, document_version_id: row.version_id || null, token_estimate: tokens, reason: normalized.pinned_node_ids.includes(row.id) ? 'pinned' : queryTerms.length ? 'query_score' : 'stable_order' };
      if (mandatory.has(row.id) || used + tokens <= budget) { included.push(item); used += tokens; } else excluded.push({ ...item, reason: 'token_budget' });
    }
    const snapshot = nodes.map((row) => [row.id, row.version_id || null, row.content_hash || null, row.source_hash]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const inputSnapshotHash = sha256Hex(canonicalJson({ nodes: snapshot, policy_revision: policy.revision }));
    const selectionPayload = { project_id: id, query: String(input.query || ''), token_budget: budget, policy_revision: policy.revision, input_snapshot_hash: inputSnapshotHash, included, excluded, token_used: used };
    const selectionHash = sha256Hex(canonicalJson(selectionPayload));
    const key = requireKey(input.idempotency_key);
    const requestHash = sha256Hex(canonicalJson(selectionPayload));
    const now = this.time();
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'context.selection.create', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const selectionId = opaqueId('ctxsel');
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'context.selection.create', kind: 'context.selection.create', resourceType: 'context_selection', resourceId: selectionId, projectId: id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`INSERT INTO context_selections(id,project_id,query,token_budget,policy_revision,input_snapshot_hash,included_json,excluded_json,token_used,selection_hash,revision,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`, [selectionId, id, String(input.query || ''), budget, policy.revision, inputSnapshotHash, canonicalJson(included), canonicalJson(excluded), used, selectionHash, now, actorId]);
      const row = tx.get('SELECT * FROM context_selections WHERE id=?', [selectionId]);
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_selection', aggregateId: selectionId, revision: 1, payload: selectionPayload, operationId: operation.operation_id, actorId, projectId: id, type: 'context_selection.created', data: { selection_id: selectionId, project_id: id, selection_hash: selectionHash }, now, auditAction: 'context.selection.create' });
      this.operations.linkInTransaction(tx, operation.operation_id, [['context_selection', selectionId]], now);
      const response = { selection: selectionView(row), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.selection.create', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 201, now });
      return response;
    });
  }

  listPacks(projectId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    return this.db.query('SELECT * FROM context_packs WHERE project_id=? ORDER BY created_at DESC,id DESC', [id]).map(packView);
  }

  getPack(projectId, packId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const row = this.db.get('SELECT * FROM context_packs WHERE id=? AND project_id=?', [String(packId), id]);
    if (!row) throw new PlatformError('not_found', 'context pack not found', {}, 404);
    return packView(row);
  }

  async createPack(projectId, input = {}, principal, options = {}) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const actorId = actorOf(principal, this.bootstrapActorId);
    const selectionId = String(input.selection_id || input.selectionId || '');
    const selection = selectionId ? this.db.get('SELECT * FROM context_selections WHERE id=? AND project_id=?', [selectionId, id]) : this.db.get('SELECT * FROM context_selections WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [id]);
    if (!selection) throw new PlatformError('evidence_incomplete', 'a context selection is required', {}, 409);
    const selectionValue = selectionView(selection);
    const currentHashes = this.db.query(`SELECT n.id,v.id AS version_id,v.content_hash,n.source_hash FROM context_nodes n LEFT JOIN context_document_versions v ON v.id=n.current_document_version_id WHERE n.project_id=? AND n.status='active' ORDER BY n.id`, [id]);
    const currentPolicy = this.policy(id, principal);
    const currentSnapshot = sha256Hex(canonicalJson({ nodes: currentHashes.map((row) => [row.id, row.version_id, row.content_hash, row.source_hash]), policy_revision: currentPolicy.revision }));
    if (currentSnapshot !== selection.input_snapshot_hash) throw new PlatformError('context_inputs_changed', 'context selection inputs changed', { expected_snapshot_hash: selection.input_snapshot_hash, actual_snapshot_hash: currentSnapshot }, 409);
    if (!selectionValue.included.length) throw new PlatformError('evidence_incomplete', 'context selection has no evidence', {}, 409);
    const documents = [];
    for (const item of selectionValue.included) {
      if (!item.document_version_id) throw new PlatformError('evidence_incomplete', 'selected evidence has no document version', { node_id: item.node_id }, 409);
      const version = this.db.get('SELECT * FROM context_document_versions WHERE id=? AND project_id=?', [item.document_version_id, id]);
      if (!version) throw new PlatformError('evidence_incomplete', 'selected document version is unavailable', { node_id: item.node_id }, 409);
      documents.push({ node_id: item.node_id, document_version_id: version.id, content_hash: version.content_hash, token_estimate: version.token_estimate });
    }
    const project = this.db.get('SELECT id,current_brief_revision,confirmed_brief_revision,confirmed_brief_hash,current_workflow_revision FROM projects WHERE id=?', [id]);
    const brief = project?.confirmed_brief_revision ? this.db.get('SELECT content_sha256 FROM brief_revisions WHERE project_id=? AND revision=?', [id, project.confirmed_brief_revision]) : null;
    const workflow = project?.current_workflow_revision ? this.db.get('SELECT graph_sha256,layout_sha256 FROM workflow_revisions WHERE project_id=? AND revision=?', [id, project.current_workflow_revision]) : null;
    if (input.require_authoritative !== false && (!brief || !workflow)) throw new PlatformError('evidence_incomplete', 'confirmed brief and workflow evidence are required', { brief_ready: Boolean(brief), workflow_ready: Boolean(workflow) }, 409);
    const memoryManifest = { schema_version: 'aiws.memory_manifest.v2', project_id: id, selection_id: selection.id, document_version_ids: documents.map((item) => item.document_version_id), source_hashes: documents.map((item) => item.content_hash), token_budget: selection.token_budget, token_used: selection.token_used };
    const payload = { schema_version: 'aiws.context_pack.v5', project_id: id, selection: selectionValue, memory_manifest: memoryManifest, brief_revision: Number(project?.confirmed_brief_revision || 0), brief_hash: brief?.content_sha256 || '', workflow_revision: Number(project?.current_workflow_revision || 0), workflow_hash: workflow ? sha256Hex(canonicalJson(workflow)) : '', outcome_contract_hash: this.outcomeHash(id), rubric_hash: this.rubricHash(id) };
    const payloadJson = canonicalJson(payload);
    const packHash = sha256Hex(payloadJson);
    const casObject = this.cas.put(payloadJson, { mediaType: 'application/json', metadata: { project_id: id, kind: 'context_pack', schema_version: 'aiws.context_pack.v5' } });
    const key = requireKey(input.idempotency_key || options.idempotencyKey);
    const requestHash = sha256Hex(canonicalJson({ project_id: id, selection_id: selection.id, pack_hash: packHash }));
    const now = this.time();
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'context.pack.create', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const packId = opaqueId('ctxpack');
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'context.pack.create', kind: 'context.pack.create', resourceType: 'context_pack', resourceId: packId, projectId: id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`INSERT INTO context_packs(id,project_id,selection_id,schema_version,pack_hash,payload_cas_hash,memory_manifest_json,status,revision,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,'sealed',1,?,?)`, [packId, id, selection.id, 'aiws.context_pack.v5', packHash, casObject.hash, canonicalJson(memoryManifest), now, actorId]);
      const row = tx.get('SELECT * FROM context_packs WHERE id=?', [packId]);
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_pack', aggregateId: packId, revision: 1, payload: { ...payload, pack_hash: packHash, payload_cas_hash: casObject.hash }, operationId: operation.operation_id, actorId, projectId: id, type: 'context_pack.created', data: { pack_id: packId, project_id: id, pack_hash: packHash, selection_hash: selection.selection_hash }, now, auditAction: 'context.pack.create' });
      this.operations.linkInTransaction(tx, operation.operation_id, [['context_pack', packId], ['context_selection', selection.id]], now);
      const response = { pack: packView(row), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.pack.create', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 201, now });
      return response;
    });
  }

  async rebuild(projectId, input = {}, principal) {
    const id = this.assertProject(projectId, principal, 'write', 'context');
    const actorId = actorOf(principal, this.bootstrapActorId);
    const mode = ['full', 'incremental', 'index_rebuild'].includes(input.mode) ? input.mode : 'full';
    const key = requireKey(input.idempotency_key);
    const retryOfJobId = input.retry_of_job_id ? String(input.retry_of_job_id) : null;
    const retryOf = retryOfJobId ? this.db.get('SELECT project_id,attempt FROM context_projection_jobs WHERE id=?', [retryOfJobId]) : null;
    if (retryOfJobId && (!retryOf || retryOf.project_id !== id)) throw new PlatformError('not_found', 'retry projection job not found', {}, 404);
    const attempt = Number(retryOf?.attempt || 0) + 1;
    const requestHash = sha256Hex(canonicalJson({ project_id: id, mode, retry_of_job_id: retryOfJobId }));
    const now = this.time();
    const created = await this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'context.projection.rebuild', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const jobId = opaqueId('ctxjob');
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'context.projection.rebuild', kind: 'context.projection', resourceType: 'context_projection_job', resourceId: jobId, projectId: id, requestHash, idempotencyKey: key, status: 'queued' }, now);
      tx.run(`INSERT INTO context_projection_jobs(id,project_id,operation_id,status,mode,retry_of_job_id,attempt,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,'queued',?,?,?,1,?,?,?,?)`, [jobId, id, operation.operation_id, mode, retryOfJobId, attempt, now, now, actorId, actorId]);
      const payload = { id: jobId, project_id: id, status: 'queued', mode, attempt, revision: 1 };
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_projection_job', aggregateId: jobId, revision: 1, payload, operationId: operation.operation_id, actorId, projectId: id, type: 'context_projection.queued', data: { job_id: jobId, project_id: id, mode }, now, auditAction: 'context.projection.rebuild' });
      this.operations.linkInTransaction(tx, operation.operation_id, [['context_projection_job', jobId]], now);
      const response = { job: jobView(tx.get('SELECT * FROM context_projection_jobs WHERE id=?', [jobId])), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.projection.rebuild', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 202, now });
      return response;
    });
    if (input.defer !== true) {
      try { await this.runJob(created.job.id, principal); } catch (error) { /* terminal job state records the failure */ }
    }
    return created;
  }

  async runJob(jobId, principal, options = {}) {
    const job = this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [String(jobId)]);
    if (!job) throw new PlatformError('not_found', 'context projection job not found', {}, 404);
    const projectId = job.project_id;
    this.assertProject(projectId, principal, 'write', 'context');
    const actorId = actorOf(principal, this.bootstrapActorId);
    if (['completed', 'cancelled'].includes(job.status)) return jobView(job);
    const now = this.time();
    const leaseOwner = String(options.leaseOwner || `worker_${process.pid}`);
    const fencingToken = randomBytes(16).toString('hex');
    const leaseExpiry = new Date(Date.parse(now) + 60_000).toISOString();
    let running;
    try {
      running = await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]);
        if (!current || !['queued', 'running', 'indexing'].includes(current.status)) return null;
        if (['running', 'indexing'].includes(current.status) && current.lease_expires_at && Date.parse(current.lease_expires_at) > Date.parse(now) && current.lease_owner !== leaseOwner) return null;
        tx.run(`UPDATE context_projection_jobs SET status='running',lease_owner=?,fencing_token=?,lease_expires_at=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=? AND status IN ('queued','running','indexing')`, [leaseOwner, fencingToken, leaseExpiry, now, actorId, job.id, Number(current.revision)], 1);
        const nextRevision = Number(current.revision) + 1;
        this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_projection_job', aggregateId: job.id, revision: nextRevision, payload: { id: job.id, project_id: projectId, status: 'running', fencing_token: fencingToken }, operationId: current.operation_id, actorId, projectId, type: 'context_projection.running', data: { job_id: job.id, project_id: projectId }, now, auditAction: 'context.projection.running' });
        return tx.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]);
      });
    } catch (error) { return this.failJob(job, error, actorId); }
    if (!running) return jobView(this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]));
    try {
      const records = this.collectRecords(projectId, actorId);
      const inputHash = inputHashForRecords(records);
      if (job.input_hash && job.input_hash !== inputHash) return this.failJob(running, new PlatformError('context_inputs_changed', 'context inputs changed', { expected_input_hash: job.input_hash, input_hash: inputHash }, 409), actorId);
      const projection = this.projectRecords(projectId, records, actorId, running);
      const index = this.buildIndex(projectId, projection.nodes, projection.versions, inputHash);
      await this.publishProjection(running, projection, index, inputHash, actorId, fencingToken);
      return jobView(this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]));
    } catch (error) {
      if (error?.code === 'context_projection_lease_lost') return jobView(this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]));
      return this.failJob(this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]), error, actorId);
    }
  }

  status(projectId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const jobs = this.db.query('SELECT * FROM context_projection_jobs WHERE project_id=? ORDER BY created_at DESC,id DESC', [id]);
    return { project_id: id, ...(jobView(jobs[0]) || { status: 'unavailable', phase: 'queued', revision: 0 }), index: this.indexStatus(id), jobs: jobs.map(jobView) };
  }

  jobs(projectId, principal) { return this.status(projectId, principal).jobs; }

  job(projectId, jobId, principal) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const row = this.db.get('SELECT * FROM context_projection_jobs WHERE id=? AND project_id=?', [String(jobId), id]);
    if (!row) throw new PlatformError('not_found', 'context projection job not found', {}, 404);
    return jobView(row);
  }

  eventsForJob(projectId, jobId, principal, cursor = 0, limit = 500) {
    const id = this.assertProject(projectId, principal, 'read', 'context');
    const job = this.db.get('SELECT id,revision,status FROM context_projection_jobs WHERE id=? AND project_id=?', [String(jobId), id]);
    if (!job) throw new PlatformError('not_found', 'context projection job not found', {}, 404);
    const replay = this.events.replay({ actorId: actorOf(principal, this.bootstrapActorId), projectId: id, aggregateType: 'context_projection_job', aggregateId: String(jobId), cursor, limit });
    return {
      events: replay.events,
      next_cursor: replay.next_cursor,
      terminal: replay.terminal || ['completed', 'failed', 'cancelled'].includes(job.status),
      resource: replay.resource || { id: job.id, type: 'context_projection_job', revision: Number(job.revision) }
    };
  }

  async cancel(projectId, jobId, input = {}, principal) {
    const id = this.assertProject(projectId, principal, 'write', 'context');
    const actorId = actorOf(principal, this.bootstrapActorId);
    const key = requireKey(input.idempotency_key);
    const expected = Number(input.expected_revision);
    const now = this.time();
    const requestHash = sha256Hex(canonicalJson({ project_id: id, job_id: String(jobId), expected_revision: expected }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'context.projection.cancel', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const row = tx.get('SELECT * FROM context_projection_jobs WHERE id=? AND project_id=?', [String(jobId), id]);
      if (!row) throw new PlatformError('not_found', 'context projection job not found', {}, 404);
      if (!Number.isInteger(expected) || expected !== Number(row.revision)) throw new PlatformError('revision_conflict', 'projection job revision has changed', { expected_revision: expected, actual_revision: row.revision }, 409);
      if (!['queued', 'running', 'indexing'].includes(row.status)) throw new PlatformError('state_conflict', 'projection job is terminal', { status: row.status }, 409);
      tx.run(`UPDATE context_projection_jobs SET status='cancelled',cancelled_at=?,updated_at=?,updated_by_actor_id=?,revision=revision+1 WHERE id=? AND revision=?`, [now, now, actorId, row.id, expected], 1);
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_projection_job', aggregateId: row.id, revision: expected + 1, payload: { id: row.id, project_id: id, status: 'cancelled' }, operationId: row.operation_id, actorId, projectId: id, type: 'context_projection.cancelled', data: { job_id: row.id, project_id: id }, now, auditAction: 'context.projection.cancel' });
      let operation = row.operation_id ? tx.get('SELECT * FROM operations WHERE id=?', [row.operation_id]) : null;
      if (operation && !['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) {
        this.operations.requestCancelInTransaction(tx, operation.id, {
          actorId,
          projectId: id,
          expectedRevision: Number(operation.revision),
          idempotencyKey: `ctxop-${sha256Hex(key).slice(0, 32)}`,
          requestHash,
          commandId: 'context.projection.cancel.request'
        }, now);
        operation = tx.get('SELECT * FROM operations WHERE id=?', [operation.id]);
        this.operations.transitionInTransaction(tx, operation.id, 'cancelled', {
          actorId,
          projectId: id,
          expectedRevision: Number(operation.revision),
          commandId: 'context.projection.cancel.acknowledge',
          result: { job_id: row.id, status: 'cancelled' }
        }, now);
      }
      const response = {
        job: jobView(tx.get('SELECT * FROM context_projection_jobs WHERE id=?', [row.id])),
        operation: row.operation_id ? this.operations.summary(tx.get('SELECT * FROM operations WHERE id=?', [row.operation_id])) : null
      };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'context.projection.cancel', idempotencyKey: key, requestHash, response, operationId: row.operation_id, responseStatus: 202, now });
      return response;
    });
  }

  async retry(projectId, jobId, input = {}, principal) {
    const id = this.assertProject(projectId, principal, 'write', 'context');
    const row = this.db.get('SELECT * FROM context_projection_jobs WHERE id=? AND project_id=?', [String(jobId), id]);
    if (!row) throw new PlatformError('not_found', 'context projection job not found', {}, 404);
    const expected = Number(input.expected_revision);
    if (expected !== Number(row.revision)) throw new PlatformError('revision_conflict', 'projection job revision has changed', { expected_revision: expected, actual_revision: row.revision }, 409);
    return this.rebuild(id, { ...input, mode: row.mode, retry_of_job_id: row.id, idempotency_key: input.idempotency_key }, principal);
  }

  async recover(principal = { actorId: this.bootstrapActorId, effectiveActorId: this.bootstrapActorId, scopes: ['*'] }) {
    if (this.recoveryStarted) return 0;
    this.recoveryStarted = true;
    let count = 0;
    const now = this.time();
    for (const row of this.db.query("SELECT id FROM context_projection_jobs WHERE status IN ('queued','running','indexing') AND (lease_expires_at IS NULL OR lease_expires_at<?) ORDER BY created_at,id", [now])) {
      try { await this.runJob(row.id, principal, { leaseOwner: 'recovery' }); count += 1; } catch { /* next restart will retry */ }
    }
    return count;
  }

  indexStatus(projectId) {
    const row = this.db.get('SELECT * FROM context_index_snapshots WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [String(projectId)]);
    if (!row) return { status: 'unavailable', schema_version: 'aiws.context_index.v3', snapshot_hash: null, index_hash: null, document_count: 0 };
    try { this.cas.read(row.payload_cas_hash); return { status: 'ready', schema_version: row.schema_version, snapshot_hash: row.snapshot_hash, index_hash: row.index_hash, document_count: Number(row.document_count) }; } catch { return { status: 'degraded', schema_version: row.schema_version, snapshot_hash: row.snapshot_hash, index_hash: row.index_hash, document_count: Number(row.document_count) }; }
  }

  collectRecords(projectId, actorId) {
    const manual = this.db.query("SELECT * FROM context_sources WHERE project_id=? AND status='active' AND adapter NOT LIKE 'clean:%' ORDER BY canonical_uri,id", [String(projectId)]);
    return [...manual, ...this.domainSourceRecords(this.db, projectId, actorId, true)]
      .sort((left, right) => left.canonical_uri.localeCompare(right.canonical_uri) || left.id.localeCompare(right.id));
  }

  domainSourceRecords(db, projectId, actorId, materialize) {
    const id = String(projectId);
    const project = db.get('SELECT * FROM projects WHERE id=?', [id]);
    if (!project) return [];
    const records = [];
    const add = (sourceType, key, title, sourceRevision, value, metadata = {}) => {
      const content = canonicalJson(value);
      const sourceHash = sha256Hex(content);
      const canonicalUri = `aiws://context/${id}/${sourceType}/${encodeURIComponent(String(key))}`;
      const existing = db.get('SELECT * FROM context_sources WHERE project_id=? AND canonical_uri=?', [id, canonicalUri]);
      const casObject = materialize ? this.cas.put(content, { mediaType: 'application/json', metadata: { project_id: id, source_type: sourceType, adapter: `clean:${sourceType}` } }) : null;
      const now = this.time();
      records.push({
        id: existing?.id || `ctxsrc_${sha256Hex(`${id}\n${sourceType}\n${key}`).slice(0, 32)}`,
        project_id: id,
        source_type: sourceType,
        canonical_uri: canonicalUri,
        title: bounded(title, 240),
        adapter: `clean:${sourceType}`,
        source_revision: String(sourceRevision || ''),
        source_hash: sourceHash,
        cas_hash: casObject?.hash || existing?.cas_hash || sourceHash,
        sensitivity: 'normal',
        freshness_status: 'current',
        metadata_json: canonicalJson(metadata),
        metadata_sha256: sha256Hex(canonicalJson(metadata)),
        status: 'active',
        revision: Number(existing?.revision || 0) + (existing?.source_hash === sourceHash && existing?.status === 'active' ? 0 : 1),
        created_at: existing?.created_at || now,
        updated_at: now,
        created_by_actor_id: existing?.created_by_actor_id || actorId,
        updated_by_actor_id: actorId,
        derived: true
      });
    };
    const projectUri = `aiws://context/${id}/project/${encodeURIComponent(id)}`;
    add('project', id, project.name, project.revision, {
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      onboarding_state: project.onboarding_state,
      revision: Number(project.revision)
    });
    const brief = db.get('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [id]);
    if (brief) add('brief', brief.id, `Brief r${brief.revision}`, brief.revision, parseJson(brief.content_json, {}), { parent_uri: projectUri });
    const repository = db.get('SELECT * FROM repository_connections WHERE project_id=?', [id]);
    if (repository) add('repository', repository.id, `${repository.provider} repository`, repository.revision, {
      id: repository.id,
      provider: repository.provider,
      status: repository.status,
      source_kind: repository.source_kind,
      source_revision: repository.source_revision,
      source_hash: repository.source_hash,
      read_only: Boolean(repository.read_only),
      revision: Number(repository.revision)
    }, { parent_uri: projectUri });
    const workflow = db.get(`SELECT r.*,w.status AS workflow_status FROM workflow_revisions r
      JOIN workflows w ON w.id=r.workflow_id WHERE r.project_id=? ORDER BY r.revision DESC LIMIT 1`, [id]);
    let workflowUri = null;
    if (workflow) {
      workflowUri = `aiws://context/${id}/workflow/${encodeURIComponent(workflow.id)}`;
      add('workflow', workflow.id, `Workflow r${workflow.revision}`, workflow.revision, {
        id: workflow.id,
        status: workflow.workflow_status,
        graph: parseJson(workflow.graph_json, {}),
        layout: parseJson(workflow.layout_json, {}),
        graph_sha256: workflow.graph_sha256,
        layout_sha256: workflow.layout_sha256,
        revision: Number(workflow.revision)
      }, { parent_uri: projectUri });
      for (const contract of db.query(`SELECT c.*,n.node_key,n.title FROM node_contracts c
        JOIN workflow_nodes n ON n.id=c.node_id WHERE c.workflow_revision_id=? ORDER BY n.node_key,c.id`, [workflow.id])) {
        add('node_contract', contract.id, `Contract: ${contract.title}`, contract.revision, {
          id: contract.id,
          node_key: contract.node_key,
          title: contract.title,
          contract: parseJson(contract.contract_json, {}),
          contract_sha256: contract.contract_sha256,
          revision: Number(contract.revision)
        }, { parent_uri: workflowUri });
      }
    }
    return records;
  }

  currentInputHash(db, projectId, actorId) {
    const manual = db.query("SELECT * FROM context_sources WHERE project_id=? AND status='active' AND adapter NOT LIKE 'clean:%' ORDER BY canonical_uri,id", [String(projectId)]);
    return inputHashForRecords([...manual, ...this.domainSourceRecords(db, projectId, actorId, false)]
      .sort((left, right) => left.canonical_uri.localeCompare(right.canonical_uri) || left.id.localeCompare(right.id)));
  }

  projectRecords(projectId, records, actorId, job) {
    const timestamp = this.time();
    const nodes = [];
    const versions = [];
    for (const source of [...records].sort((a, b) => a.canonical_uri.localeCompare(b.canonical_uri) || a.id.localeCompare(b.id))) {
      const nodeId = `ctxnode_${sha256Hex(`${projectId}\n${source.canonical_uri}`).slice(0, 32)}`;
      const stableUri = `aiws://context/${projectId}/${encodeURIComponent(source.canonical_uri)}`;
      let content = '';
      try { content = this.cas.read(source.cas_hash).toString('utf8'); } catch { throw new PlatformError('context_projection_unavailable', 'context source CAS content is unavailable', { source_id: source.id }, 503); }
      const tokenEstimate = estimateTokens(content);
      const previous = this.db.get('SELECT * FROM context_nodes WHERE id=?', [nodeId]);
      const priorVersion = previous?.current_document_version_id ? this.db.get('SELECT * FROM context_document_versions WHERE id=?', [previous.current_document_version_id]) : null;
      const matching = this.db.get('SELECT * FROM context_document_versions WHERE node_id=? AND content_hash=?', [nodeId, source.source_hash]);
      const version = matching || { id: opaqueId('ctxver'), version: Number(priorVersion?.version || 0) + (matching ? 0 : 1), node_id: nodeId, project_id: projectId, source_revision: source.source_revision, source_hash: source.source_hash, content_hash: source.source_hash, cas_hash: source.cas_hash, cas_relative_key: this.cas.keyFor(source.cas_hash), token_estimate: tokenEstimate, renderer_version: 'context-renderer-v1', created_at: timestamp, created_by_actor_id: actorId };
      nodes.push({ id: nodeId, project_id: projectId, stable_uri: stableUri, source_id: source.id, parent_id: null, node_kind: source.source_type, title: source.title, source_revision: source.source_revision, source_hash: source.source_hash, sensitivity: source.sensitivity, freshness_status: source.freshness_status, required_scopes_json: '["context:read"]', sort_json: canonicalJson({ type_order: typeOrder(source.source_type), stable_uri: stableUri }), current_document_version_id: version.id, token_estimate: Number(version.token_estimate || 0), status: 'active', revision: Number(previous?.revision || 0) + 1, created_at: previous?.created_at || timestamp, updated_at: timestamp, created_by_actor_id: previous?.created_by_actor_id || actorId, updated_by_actor_id: actorId, index_content: content });
      if (!matching) versions.push(version);
    }
    const nodeBySourceUri = new Map(records.map((source, index) => [source.canonical_uri, nodes[index]]));
    const edges = [];
    for (const source of records) {
      const child = nodeBySourceUri.get(source.canonical_uri);
      const metadata = parseJson(source.metadata_json, {});
      const relations = [
        ...(metadata.parent_uri ? [{ uri: String(metadata.parent_uri), relation: 'contains' }] : []),
        ...uniqueStrings(metadata.references).map((uri) => ({ uri, relation: 'references' }))
      ];
      for (const relation of relations) {
        const parent = nodeBySourceUri.get(relation.uri);
        if (!parent || parent.id === child.id) continue;
        if (relation.relation === 'contains') child.parent_id = parent.id;
        edges.push({
          id: `ctxedge_${sha256Hex(`${projectId}\n${parent.id}\n${child.id}\n${relation.relation}`).slice(0, 32)}`,
          project_id: projectId,
          parent_node_id: parent.id,
          child_node_id: child.id,
          relation: relation.relation,
          order_index: typeOrder(child.node_kind),
          metadata_json: '{}',
          created_at: timestamp
        });
      }
    }
    assertAcyclicContains(nodes, edges);
    edges.sort((left, right) => left.parent_node_id.localeCompare(right.parent_node_id) || left.order_index - right.order_index || left.child_node_id.localeCompare(right.child_node_id) || left.id.localeCompare(right.id));
    return { sources: records, nodes, versions, edges, timestamp, stats: { source_count: records.length, node_count: nodes.length, edge_count: edges.length, document_versions_created: versions.length } };
  }

  buildIndex(projectId, nodes, versions, inputHash) {
    const indexed = nodes.filter((node) => node.sensitivity !== 'secret').map((node) => ({ id: node.id, uri: node.stable_uri, title: node.title, text: node.index_content || '', kind: node.node_kind, source_id: node.source_id, source_hash: node.source_hash, document_version_id: node.current_document_version_id, token_estimate: Number(node.token_estimate || versions.find((item) => item.id === node.current_document_version_id)?.token_estimate || 0) })).sort((a, b) => a.uri.localeCompare(b.uri) || a.id.localeCompare(b.id));
    const miniSearch = new MiniSearch(INDEX_OPTIONS);
    miniSearch.addAll(indexed);
    const docs = indexed.map(({ text, ...document }) => document);
    const miniSearchPayload = miniSearch.toJSON();
    const indexHash = sha256Hex(canonicalJson({ engine: 'minisearch@7', index: miniSearchPayload }));
    const snapshotHash = sha256Hex(canonicalJson({ project_id: projectId, input_hash: inputHash, documents: docs.map((doc) => [doc.id, doc.document_version_id, doc.source_hash]) }));
    return { schema_version: 'aiws.context_index.v3', engine: 'minisearch@7', input_hash: inputHash, documents: docs, mini_search: miniSearchPayload, indexHash, snapshotHash, documentCount: docs.length };
  }

  async publishProjection(job, projection, index, inputHash, actorId, fencingToken) {
    const payload = { ...index, index_hash: index.indexHash, snapshot_hash: index.snapshotHash };
    const casObject = this.cas.put(canonicalJson(payload), { mediaType: 'application/json', metadata: { project_id: job.project_id, kind: 'context_index' } });
    const now = this.time();
    await this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]);
      if (!current || current.fencing_token !== fencingToken || Number(current.revision) !== Number(job.revision) || current.status !== 'running' || (current.lease_expires_at && Date.parse(current.lease_expires_at) <= Date.parse(now))) throw new PlatformError('context_projection_lease_lost', 'projection lease is no longer valid', {}, 409);
      const currentInputHash = this.currentInputHash(tx, job.project_id, actorId);
      if (currentInputHash !== inputHash) throw new PlatformError('context_inputs_changed', 'context inputs changed before projection publish', { expected_input_hash: inputHash, input_hash: currentInputHash }, 409);
      const derivedIds = new Set(projection.sources.filter((source) => source.derived).map((source) => source.id));
      for (const stale of tx.query("SELECT id,revision FROM context_sources WHERE project_id=? AND status='active' AND adapter LIKE 'clean:%' ORDER BY id", [job.project_id])) {
        if (!derivedIds.has(stale.id)) tx.run("UPDATE context_sources SET status='tombstone',freshness_status='missing',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, actorId, stale.id, Number(stale.revision)], 1);
      }
      for (const source of projection.sources.filter((item) => item.derived)) {
        const existing = tx.get('SELECT * FROM context_sources WHERE id=?', [source.id]);
        const changed = !existing || existing.source_hash !== source.source_hash || existing.source_revision !== source.source_revision || existing.status !== 'active' || existing.metadata_sha256 !== source.metadata_sha256;
        if (!changed) continue;
        if (existing) tx.run(`UPDATE context_sources SET source_type=?,canonical_uri=?,title=?,adapter=?,source_revision=?,source_hash=?,cas_hash=?,sensitivity=?,freshness_status=?,metadata_json=?,metadata_sha256=?,status='active',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [source.source_type, source.canonical_uri, source.title, source.adapter, source.source_revision, source.source_hash, source.cas_hash, source.sensitivity, source.freshness_status, source.metadata_json, source.metadata_sha256, source.revision, now, actorId, source.id, Number(existing.revision)], 1);
        else tx.run(`INSERT INTO context_sources(id,project_id,source_type,canonical_uri,title,adapter,source_revision,source_hash,cas_hash,sensitivity,freshness_status,metadata_json,metadata_sha256,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`, [source.id, source.project_id, source.source_type, source.canonical_uri, source.title, source.adapter, source.source_revision, source.source_hash, source.cas_hash, source.sensitivity, source.freshness_status, source.metadata_json, source.metadata_sha256, source.created_at, now, source.created_by_actor_id, actorId]);
        const row = tx.get('SELECT * FROM context_sources WHERE id=?', [source.id]);
        this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_source', aggregateId: source.id, revision: Number(row.revision), payload: sourcePayload(row), operationId: current.operation_id, actorId, projectId: job.project_id, type: existing ? 'context_source.updated' : 'context_source.created', data: { source_id: source.id, project_id: job.project_id, source_hash: source.source_hash, adapter: source.adapter }, now, auditAction: 'context.projection.adapter' });
        this.operations.linkInTransaction(tx, current.operation_id, [['context_source', source.id]], now);
      }
      const projectedIds = new Set(projection.nodes.map((node) => node.id));
      for (const stale of tx.query("SELECT id,revision FROM context_nodes WHERE project_id=? AND status='active' ORDER BY id", [job.project_id])) {
        if (!projectedIds.has(stale.id)) tx.run("UPDATE context_nodes SET status='tombstone',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, actorId, stale.id, Number(stale.revision)], 1);
      }
      for (const node of projection.nodes) {
        const existing = tx.get('SELECT * FROM context_nodes WHERE id=?', [node.id]);
        if (existing) tx.run(`UPDATE context_nodes SET stable_uri=?,source_id=?,parent_id=NULL,node_kind=?,title=?,source_revision=?,source_hash=?,sensitivity=?,freshness_status=?,required_scopes_json=?,sort_json=?,current_document_version_id=?,status='active',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=?`, [node.stable_uri, node.source_id, node.node_kind, node.title, node.source_revision, node.source_hash, node.sensitivity, node.freshness_status, node.required_scopes_json, node.sort_json, node.current_document_version_id, node.revision, now, actorId, node.id]);
        else tx.run(`INSERT INTO context_nodes(id,project_id,stable_uri,source_id,parent_id,node_kind,title,source_revision,source_hash,sensitivity,freshness_status,required_scopes_json,sort_json,current_document_version_id,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)`, [node.id, node.project_id, node.stable_uri, node.source_id, node.node_kind, node.title, node.source_revision, node.source_hash, node.sensitivity, node.freshness_status, node.required_scopes_json, node.sort_json, node.current_document_version_id, node.revision, node.created_at, now, node.created_by_actor_id, actorId]);
      }
      for (const node of projection.nodes) if (node.parent_id) tx.run('UPDATE context_nodes SET parent_id=? WHERE id=?', [node.parent_id, node.id]);
      for (const version of projection.versions) tx.run(`INSERT INTO context_document_versions(id,project_id,node_id,version,source_revision,source_hash,content_hash,cas_hash,cas_relative_key,token_estimate,renderer_version,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [version.id, version.project_id, version.node_id, version.version, version.source_revision, version.source_hash, version.content_hash, version.cas_hash, version.cas_relative_key, version.token_estimate, version.renderer_version, version.created_at, version.created_by_actor_id]);
      tx.run('DELETE FROM context_edges WHERE project_id=?', [job.project_id]);
      for (const edge of projection.edges) tx.run(`INSERT INTO context_edges(id,project_id,parent_node_id,child_node_id,relation,order_index,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`, [edge.id, edge.project_id, edge.parent_node_id, edge.child_node_id, edge.relation, edge.order_index, edge.metadata_json, edge.created_at]);
      tx.run(`INSERT OR IGNORE INTO context_index_snapshots(id,project_id,schema_version,snapshot_hash,index_hash,payload_cas_hash,document_count,created_at) VALUES(?,?,?,?,?,?,?,?)`, [opaqueId('ctxidx'), job.project_id, 'aiws.context_index.v3', index.snapshotHash, index.indexHash, casObject.hash, index.documentCount, now]);
      const nextRevision = Number(current.revision) + 1;
      tx.run(`UPDATE context_projection_jobs SET status='completed',input_hash=?,snapshot_hash=?,index_hash=?,cursor=?,stats_json=?,lease_owner='',fencing_token='',lease_expires_at=NULL,completed_at=?,updated_at=?,updated_by_actor_id=?,revision=? WHERE id=? AND revision=?`, [inputHash, index.snapshotHash, index.indexHash, projection.nodes.length, canonicalJson({ ...projection.stats, index_document_count: index.documentCount }), now, now, actorId, nextRevision, job.id, Number(current.revision)], 1);
      this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_projection_job', aggregateId: job.id, revision: nextRevision, payload: { id: job.id, project_id: job.project_id, status: 'completed', input_hash: inputHash, snapshot_hash: index.snapshotHash, index_hash: index.indexHash }, operationId: current.operation_id, actorId, projectId: job.project_id, type: 'context_projection.completed', data: { job_id: job.id, project_id: job.project_id, input_hash: inputHash, index_hash: index.indexHash, node_count: projection.nodes.length }, now, auditAction: 'context.projection.completed' });
      let operation = current.operation_id ? tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]) : null;
      if (operation?.status === 'queued') {
        this.operations.transitionInTransaction(tx, operation.id, 'running', { actorId, expectedRevision: Number(operation.revision), projectId: job.project_id }, now);
        operation = tx.get('SELECT * FROM operations WHERE id=?', [operation.id]);
      }
      if (operation?.status === 'running') {
        this.operations.transitionInTransaction(tx, operation.id, 'succeeded', { actorId, expectedRevision: Number(operation.revision), projectId: job.project_id, result: { job_id: job.id, status: 'completed', input_hash: inputHash, index_hash: index.indexHash } }, now);
      }
    });
  }

  async failJob(job, error, actorId) {
    const code = String(error?.code || 'context_projection_failed');
    const now = this.time();
    try {
      await this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]);
        if (!current || ['completed', 'cancelled'].includes(current.status)) return;
        const revision = Number(current.revision) + 1;
        tx.run(`UPDATE context_projection_jobs SET status='failed',error_code=?,error_details_json=?,lease_owner='',fencing_token='',lease_expires_at=NULL,updated_at=?,updated_by_actor_id=?,revision=? WHERE id=? AND revision=?`, [code, canonicalJson({ reason: error?.message || code }), now, actorId, revision, job.id, Number(current.revision)], 1);
        this.events.appendAggregateInTransaction(tx, { aggregateType: 'context_projection_job', aggregateId: job.id, revision, payload: { id: job.id, project_id: job.project_id, status: 'failed', error_code: code }, operationId: current.operation_id, actorId, projectId: job.project_id, type: 'context_projection.failed', data: { job_id: job.id, project_id: job.project_id, error_code: code }, now, auditAction: 'context.projection.failed' });
        let operation = current.operation_id ? tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]) : null;
        if (operation?.status === 'queued') {
          this.operations.transitionInTransaction(tx, operation.id, 'running', { actorId, expectedRevision: Number(operation.revision), projectId: job.project_id }, now);
          operation = tx.get('SELECT * FROM operations WHERE id=?', [operation.id]);
        }
        if (operation?.status === 'running') {
          this.operations.transitionInTransaction(tx, operation.id, 'failed', { actorId, expectedRevision: Number(operation.revision), projectId: job.project_id, errorCode: code, errorDetails: { reason: String(error?.message || code) } }, now);
        }
      });
    } catch { /* preserve the original projection failure */ }
    return jobView(this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [job.id]));
  }

  outcomeHash(projectId) {
    const rows = this.db.query('SELECT requirement_key,rubric_sha256 FROM outcome_requirements WHERE project_id=? ORDER BY requirement_key', [String(projectId)]);
    return rows.length ? sha256Hex(canonicalJson(rows)) : '';
  }

  rubricHash(projectId) { return this.outcomeHash(projectId); }
}

export function defaultPolicy() {
  return { pinned_node_ids: [], excluded_node_ids: [], source_allowlist: [], sensitivity_max: 'restricted', freshness: 'current_or_stale' };
}

export function normalizePolicy(value = {}) {
  const policy = { ...defaultPolicy(), ...safeObject(value) };
  policy.pinned_node_ids = uniqueStrings(policy.pinned_node_ids);
  policy.excluded_node_ids = uniqueStrings(policy.excluded_node_ids);
  policy.source_allowlist = uniqueStrings(policy.source_allowlist);
  policy.sensitivity_max = SENSITIVITY.has(String(policy.sensitivity_max)) ? String(policy.sensitivity_max) : 'restricted';
  if (policy.pinned_node_ids.some((id) => policy.excluded_node_ids.includes(id))) throw new PlatformError('context_policy_conflict', 'a node cannot be pinned and excluded', {}, 409);
  return policy;
}

function sourcePayload(row) { return { id: row.id, project_id: row.project_id, source_type: row.source_type, canonical_uri: row.canonical_uri, title: row.title, source_revision: row.source_revision, source_hash: row.source_hash, cas_hash: row.cas_hash, sensitivity: row.sensitivity, freshness_status: row.freshness_status, revision: Number(row.revision) }; }
function sourceView(row) { return { ...sourcePayload(row), adapter: row.adapter, metadata: parseJson(row.metadata_json, {}), status: row.status, created_at: row.created_at, updated_at: row.updated_at }; }
function nodeView(row) { return { id: row.id, project_id: row.project_id, stable_uri: row.stable_uri, uri: row.stable_uri, source_id: row.source_id, node_kind: row.node_kind, kind: row.node_kind, title: row.title, source_revision: row.source_revision, source_hash: row.source_hash, sensitivity: row.sensitivity, freshness: { status: row.freshness_status }, required_scopes: parseJson(row.required_scopes_json, ['context:read']), sort: parseJson(row.sort_json, {}), current_document_version_id: row.current_document_version_id, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function selectionView(row) { return { id: row.id, project_id: row.project_id, query: row.query, token_budget: Number(row.token_budget), policy_revision: Number(row.policy_revision), input_snapshot_hash: row.input_snapshot_hash, included: parseJson(row.included_json, []), excluded: parseJson(row.excluded_json, []), token_used: Number(row.token_used), selection_hash: row.selection_hash, revision: Number(row.revision), created_at: row.created_at }; }
function packView(row) {
  const manifest = parseJson(row.memory_manifest_json, {});
  return {
    id: row.id, project_id: row.project_id, selection_id: row.selection_id, schema_version: row.schema_version,
    pack_hash: row.pack_hash, payload_cas_hash: row.payload_cas_hash, memory_manifest: manifest,
    input_versions: { document_version_ids: manifest.document_version_ids || [], source_hashes: manifest.source_hashes || [], brief_revision: manifest.brief_revision ?? null, workflow_revision: manifest.workflow_revision ?? null },
    ready: row.status === 'sealed', status: row.status, revision: Number(row.revision), created_at: row.created_at
  };
}
function jobView(row) { if (!row) return null; return { id: row.id, project_id: row.project_id, operation_id: row.operation_id, status: row.status, phase: row.status, mode: row.mode, input_hash: row.input_hash, snapshot_hash: row.snapshot_hash, index_hash: row.index_hash, cursor: Number(row.cursor), attempt: Number(row.attempt), retry_of_job_id: row.retry_of_job_id, stats: parseJson(row.stats_json, {}), error_code: row.error_code || '', error_details: parseJson(row.error_details_json, {}), revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null, cancelled_at: row.cancelled_at || null }; }
function parseJson(value, fallback) { try { return value == null ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function actorOf(principal, fallback) { return String(principal?.effectiveActorId || principal?.actorId || fallback); }
function requireKey(value) { const key = String(value || ''); if (!KEY.test(key)) throw new PlatformError('idempotency_required', 'Idempotency-Key is required', {}, 400); return key; }
function bounded(value, max) { const text = String(value || '').trim(); if (!text || text.length > max) throw new PlatformError('invalid_input', 'context value is invalid', {}, 422); return text; }
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item)).filter(Boolean))].sort(); }
function normalizeSourceType(value) { const type = String(value || 'note'); if (!SOURCE_TYPES.has(type)) throw new PlatformError('schema_invalid', 'context source type is invalid', {}, 400); return type; }
function normalizeSensitivity(value) { const type = String(value || 'normal'); if (!SENSITIVITY.has(type)) throw new PlatformError('schema_invalid', 'context sensitivity is invalid', {}, 400); return type; }
function canonicalUriFor(projectId, value) { const text = String(value || '').trim(); if (!text || text.includes('\\') || text.includes('..')) throw new PlatformError('invalid_input', 'context URI is invalid', {}, 422); return text.startsWith('aiws://') ? text : `aiws://context/${projectId}/${encodeURIComponent(text.replace(/^\/+/, ''))}`; }
function tokenize(value) { return String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []; }
function countTerm(value, term) { let count = 0; let at = 0; while ((at = value.indexOf(term, at)) >= 0) { count += 1; at += term.length || 1; } return count; }
function estimateTokens(value) { return Math.max(0, Math.ceil(String(value || '').length / 4)); }
function sensitivityRank(value) { return ({ normal: 0, sensitive: 1, restricted: 2, secret: 3 }[String(value)] ?? 3); }
function typeOrder(value) { return TYPE_ORDER[String(value)] || 100; }
function inputHashForRecords(records) { return sha256Hex(canonicalJson(records.map((record) => [record.source_type, record.canonical_uri, record.source_revision, record.source_hash]))); }
function assertAcyclicContains(nodes, edges) {
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) if (edge.relation === 'contains') children.get(edge.parent_node_id)?.push(edge.child_node_id);
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new PlatformError('context_edge_cycle', 'context contains edges form a cycle', { node_id: id }, 409);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id) || []) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}
