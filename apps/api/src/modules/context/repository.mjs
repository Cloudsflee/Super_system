import { parseJson } from '../../crypto.mjs';

/* Context is the only module that owns projection/index persistence.  The
 * repository deliberately returns plain records; policy and rendering stay in
 * the service layer so HTTP and MCP observe the same contract. */
export class ContextRepository {
  constructor(db) {
    this.db = db;
  }

  project(projectId) { return this.db.get('SELECT * FROM projects WHERE id=?', [String(projectId)]); }
  projectProjection(projectId) { return this.db.get('SELECT * FROM projects WHERE id=?', [String(projectId)]); }
  briefProjection(projectId) {
    return this.db.get(`SELECT b.* FROM projects p JOIN brief_revisions b
      ON b.project_id=p.id AND b.revision=p.confirmed_brief_revision WHERE p.id=?`, [String(projectId)]);
  }
  repositoryProjection(projectId) {
    return this.db.get('SELECT id,local_path,remote_url,head_sha,revision,status,source_kind,source_revision,source_hash FROM repository_bindings WHERE project_id=?', [String(projectId)]);
  }
  workflowProjection(projectId) {
    return this.db.get(`SELECT w.* FROM workflow_heads h JOIN workflow_revisions w
      ON w.project_id=h.project_id AND w.revision=h.revision WHERE h.project_id=?`, [String(projectId)]);
  }
  contractProjections(projectId) {
    return this.db.query(`SELECT n.project_id,n.workflow_revision,n.node_id,n.revision,n.contract_json,n.contract_hash
      FROM node_contract_revisions n
      JOIN workflow_heads h ON h.project_id=n.project_id AND h.revision=n.workflow_revision
      WHERE n.project_id=? AND n.revision=(
        SELECT MAX(latest.revision) FROM node_contract_revisions latest
        WHERE latest.project_id=n.project_id AND latest.workflow_revision=n.workflow_revision AND latest.node_id=n.node_id
      ) ORDER BY n.node_id`, [String(projectId)]);
  }
  sourceProjections(projectId, sourceIds = null) {
    const rows = this.db.query('SELECT id,kind,path,title,content,content_hash,created_at FROM context_sources WHERE project_id=? ORDER BY created_at,id', [String(projectId)]);
    return sourceIds == null ? rows : rows.then((values) => values.filter((row) => sourceIds.has(String(row.id))));
  }
  sources(projectId) { return this.db.query('SELECT * FROM context_sources WHERE project_id=? ORDER BY created_at,id', [String(projectId)]); }
  source(sourceId, projectId = null) {
    return projectId == null
      ? this.db.get('SELECT * FROM context_sources WHERE id=?', [String(sourceId)])
      : this.db.get('SELECT * FROM context_sources WHERE id=? AND project_id=?', [String(sourceId), String(projectId)]);
  }
  sourcesByIds(projectId, sourceIds) {
    const ids = [...new Set((sourceIds || []).map(String))];
    if (!ids.length) return Promise.resolve([]);
    return this.db.query(`SELECT * FROM context_sources WHERE project_id=? AND id IN (${placeholders(ids.length)})`, [String(projectId), ...ids]);
  }
  nodesByIds(projectId, nodeIds) {
    const ids = [...new Set((nodeIds || []).map(String))];
    if (!ids.length) return Promise.resolve([]);
    return this.db.query(`SELECT * FROM context_nodes WHERE project_id=? AND id IN (${placeholders(ids.length)})`, [String(projectId), ...ids]);
  }
  async searchSources(projectId, query) {
    const text = String(query || '').trim();
    if (!text) return this.sources(projectId);
    try {
      return await this.db.query(
        'SELECT s.* FROM context_source_fts f JOIN context_sources s ON s.id=f.source_id WHERE s.project_id=? AND f.context_source_fts MATCH ? ORDER BY s.created_at DESC,s.id',
        [String(projectId), text]
      );
    } catch {
      // FTS syntax is user input. A malformed operator falls back to a
      // deterministic bounded title/content scan instead of leaking SQL errors.
      const needle = text.toLowerCase();
      return (await this.sources(projectId)).filter((row) => `${row.title} ${row.content}`.toLowerCase().includes(needle));
    }
  }
  nodes(projectId) { return this.db.query('SELECT * FROM context_nodes WHERE project_id=? ORDER BY uri,id', [String(projectId)]); }
  nodeByUri(projectId, uri) { return this.db.get('SELECT * FROM context_nodes WHERE project_id=? AND uri=?', [String(projectId), String(uri)]); }
  node(nodeId, projectId = null) {
    return projectId == null
      ? this.db.get('SELECT * FROM context_nodes WHERE id=?', [String(nodeId)])
      : this.db.get('SELECT * FROM context_nodes WHERE id=? AND project_id=?', [String(nodeId), String(projectId)]);
  }
  versions(nodeId) { return this.db.query('SELECT * FROM context_document_versions WHERE node_id=? ORDER BY version', [String(nodeId)]); }
  version(versionId) { return this.db.get('SELECT * FROM context_document_versions WHERE id=?', [String(versionId)]); }
  versionsByIds(versionIds) {
    const ids = [...new Set((versionIds || []).map(String).filter(Boolean))];
    if (!ids.length) return Promise.resolve([]);
    return this.db.query(`SELECT * FROM context_document_versions WHERE id IN (${placeholders(ids.length)})`, ids);
  }
  latestVersion(nodeId) { return this.db.get('SELECT * FROM context_document_versions WHERE node_id=? ORDER BY version DESC LIMIT 1', [String(nodeId)]); }
  versionByHash(nodeId, sourceHash) { return this.db.get('SELECT * FROM context_document_versions WHERE node_id=? AND source_hash=? ORDER BY version DESC LIMIT 1', [String(nodeId), String(sourceHash)]); }
  edges(projectId) {
    return this.db.query(`SELECT e.* FROM context_edges e
      JOIN context_nodes p ON p.id=e.parent_id
      WHERE p.project_id=? ORDER BY e.parent_id,e.order_index,e.child_id,e.relation`, [String(projectId)]);
  }
  policies(projectId) { return this.db.query('SELECT * FROM context_policy_revisions WHERE project_id=? ORDER BY revision DESC', [String(projectId)]); }
  policyHead(projectId) { return this.db.get('SELECT * FROM context_policy_heads WHERE project_id=?', [String(projectId)]); }
  legacyPolicy(projectId) { return this.db.get('SELECT * FROM context_policies WHERE project_id=? ORDER BY revision DESC LIMIT 1', [String(projectId)]); }
  selections(projectId) { return this.db.query('SELECT * FROM context_selections WHERE project_id=? ORDER BY created_at DESC,id', [String(projectId)]); }
  selection(selectionId, projectId = null) {
    return projectId == null
      ? this.db.get('SELECT * FROM context_selections WHERE id=?', [String(selectionId)])
      : this.db.get('SELECT * FROM context_selections WHERE id=? AND project_id=?', [String(selectionId), String(projectId)]);
  }
  packs(projectId) { return this.db.query('SELECT * FROM context_packs WHERE project_id=? ORDER BY created_at DESC,id', [String(projectId)]); }
  pack(packId, projectId = null) {
    return projectId == null
      ? this.db.get('SELECT * FROM context_packs WHERE id=?', [String(packId)])
      : this.db.get('SELECT * FROM context_packs WHERE id=? AND project_id=?', [String(packId), String(projectId)]);
  }
  jobs(projectId) { return this.db.query('SELECT * FROM context_projection_jobs WHERE project_id=? ORDER BY created_at DESC,id', [String(projectId)]); }
  job(jobId, projectId = null) {
    return projectId == null
      ? this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [String(jobId)])
      : this.db.get('SELECT * FROM context_projection_jobs WHERE id=? AND project_id=?', [String(jobId), String(projectId)]);
  }
  events(jobId, after = 0, limit = 500) {
    return this.db.query('SELECT * FROM context_projection_events WHERE job_id=? AND cursor>? ORDER BY cursor LIMIT ?', [String(jobId), Number(after) || 0, Math.min(Math.max(Number(limit) || 500, 1), 1000)]);
  }
  async latestIndex(projectId) {
    const head = await this.db.get(`SELECT s.*,h.revision AS head_revision FROM context_index_heads h
      JOIN context_index_snapshots s ON s.id=h.snapshot_id WHERE h.project_id=?`, [String(projectId)]);
    return head || this.db.get('SELECT * FROM context_index_snapshots WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [String(projectId)]);
  }

  policyRevision(projectId, revision) {
    return this.db.get('SELECT * FROM context_policy_revisions WHERE project_id=? AND revision=?', [String(projectId), Number(revision)]);
  }

  createSource({ sourceId, projectId, kind, sourcePath, title, content, contentHash, timestamp, actor, auditId }) {
    return this.transaction([
      { sql: 'INSERT INTO context_sources(id,project_id,kind,path,title,content,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [sourceId, String(projectId), kind, sourcePath, title, content, contentHash, timestamp] },
      { sql: 'INSERT INTO context_source_fts(source_id,title,content) VALUES(?,?,?)', params: [sourceId, title, content] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context_source.created', 'context_source', sourceId, JSON.stringify({ project_id: projectId, kind }), timestamp] }
    ]);
  }

  updatePolicy({ projectId, revision, policyId, policyJson, policyHash, actor, timestamp, auditId }) {
    return this.transaction([
      { sql: 'INSERT INTO context_policy_revisions(id,project_id,revision,policy_json,policy_hash,actor,created_at) VALUES(?,?,?,?,?,?,?)', params: [policyId, String(projectId), revision, policyJson, policyHash, actor, timestamp] },
      { sql: 'INSERT INTO context_policy_heads(project_id,revision,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at', params: [String(projectId), revision, timestamp] },
      { sql: `INSERT INTO context_policies(id,project_id,policy_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET policy_json=excluded.policy_json,revision=excluded.revision,updated_at=excluded.updated_at`, params: [`policy_${projectId}`, String(projectId), policyJson, revision, timestamp, timestamp] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context.policy.updated', 'context_policy', String(projectId), JSON.stringify({ revision, policy_hash: policyHash }), timestamp] }
    ]);
  }

  createSelectionRecord({ selection, projectId, sessionId, actor, auditId }) {
    return this.transaction([
      { sql: `INSERT INTO context_selections(id,project_id,session_id,node_ids_json,retrieval_plan_json,created_at,selection_hash,policy_revision,included_json,excluded_json,revision,schema_version,compatibility)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [selection.id, String(projectId), sessionId || null, JSON.stringify(selection.candidate_node_ids), JSON.stringify(selection.retrieval_plan), selection.created_at, selection.selection_hash, selection.policy_revision, JSON.stringify(selection.included), JSON.stringify(selection.excluded), 1, selection.schema_version, 'native_v5'] },
      { sql: 'INSERT INTO context_selection_heads(project_id,selection_id,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET selection_id=excluded.selection_id,revision=excluded.revision,updated_at=excluded.updated_at', params: [String(projectId), selection.id, 1, selection.created_at] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context.selection.created', 'context_selection', selection.id, JSON.stringify({ project_id: projectId, selection_hash: selection.selection_hash, policy_revision: selection.policy_revision }), selection.created_at] }
    ]);
  }

  async packInputs(projectId, sourceIds = []) {
    const ids = [...new Set(sourceIds.map(String))];
    const [brief, workflow, repository, contracts, legacySources] = await Promise.all([
      this.briefProjection(projectId),
      this.workflowProjection(projectId),
      this.db.get('SELECT revision,head_sha,status FROM repository_bindings WHERE project_id=?', [String(projectId)]),
      this.contractProjections(projectId),
      ids.length ? this.db.query(`SELECT id,title,path,content FROM context_sources WHERE project_id=? AND id IN (${placeholders(ids.length)})`, [String(projectId), ...ids]) : Promise.resolve([])
    ]);
    return { brief, workflow, repository, contracts, legacySources };
  }

  createPackRecord({ pack, projectId, legacySourceIds, selection, actor, auditId }) {
    return this.transaction([
      { sql: `INSERT INTO context_packs(id,project_id,source_ids_json,pack_json,pack_hash,created_at,selection_id,selection_hash,policy_revision,schema_version,revision,immutable,compatibility)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [pack.id, String(projectId), JSON.stringify(legacySourceIds), JSON.stringify(pack), pack.pack_hash, pack.created_at, selection.id, selection.selection_hash, selection.policy_revision, pack.schema_version, 1, 1, 'native_v5'] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context_pack.created', 'context_pack', pack.id, JSON.stringify({ project_id: projectId, pack_hash: pack.pack_hash, selection_hash: selection.selection_hash }), pack.created_at] }
    ]);
  }

  createProjectionJob({ jobId, projectId, mode, attempt, retryOfJobId, timestamp, actor, auditId }) {
    return this.transaction([
      { sql: `INSERT INTO context_projection_jobs(id,project_id,status,cursor,error_code,created_at,updated_at,mode,phase,attempt,retry_of_job_id,stats_json,error_details_json,revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [jobId, String(projectId), 'queued', '', null, timestamp, timestamp, mode, 'queued', attempt, retryOfJobId || null, '{}', '{}', 1] },
      { sql: 'INSERT INTO context_projection_events(job_id,project_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [jobId, String(projectId), 'context.projection.queued', JSON.stringify({ status: 'queued', mode }), timestamp] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context.projection.queued', 'context_projection_job', jobId, JSON.stringify({ project_id: projectId, mode, attempt, retry_of_job_id: retryOfJobId || null }), timestamp] }
    ]);
  }

  setProjectionOperation(jobId, operationId) { return this.db.run('UPDATE context_projection_jobs SET operation_id=? WHERE id=?', [operationId, jobId]); }

  cancelProjection({ jobId, projectId, expectedRevision, timestamp, actor, auditId }) {
    return this.transaction([
      { sql: "UPDATE context_projection_jobs SET status='cancelled',phase='cancelled',cancelled_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND status IN ('queued','running','indexing')", params: [timestamp, timestamp, jobId, expectedRevision], expect_changes: 1 },
      { sql: 'INSERT INTO context_projection_events(job_id,project_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [jobId, String(projectId), 'context.projection.cancelled', JSON.stringify({ status: 'cancelled' }), timestamp] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context.projection.cancelled', 'context_projection_job', jobId, JSON.stringify({ project_id: projectId }), timestamp] }
    ]);
  }

  recoveryJobs() { return this.db.query("SELECT id,project_id FROM context_projection_jobs WHERE operation_id IS NULL AND status IN ('queued','running','indexing') ORDER BY created_at,id"); }
  markProjectionInputsChanged(jobId, timestamp) { return this.db.run("UPDATE context_projection_jobs SET status='failed',phase='failed',error_code='context_projection_inputs_changed',updated_at=?,revision=revision+1 WHERE id=?", [timestamp, jobId]); }

  persistProjection({ versionRows, nodeRows, tombstoneIds, edgeRows, timestamp }) {
    const statements = [];
    const pendingVersions = new Map((versionRows || []).map((row) => [String(row.node_id), row]));
    for (const row of nodeRows || []) {
      statements.push({ sql: `INSERT INTO context_nodes(id,project_id,parent_id,uri,title,kind,sensitivity,created_at,updated_at,stable_uri,source_type,source_id,source_revision,source_hash,path,current_document_version_id,authority,freshness_json,required_scopes_json,sort_json,resource_json,status,revision,tombstoned_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(uri) DO UPDATE SET parent_id=excluded.parent_id,title=excluded.title,kind=excluded.kind,sensitivity=excluded.sensitivity,updated_at=excluded.updated_at,stable_uri=excluded.stable_uri,source_type=excluded.source_type,source_id=excluded.source_id,source_revision=excluded.source_revision,source_hash=excluded.source_hash,path=excluded.path,current_document_version_id=excluded.current_document_version_id,authority=excluded.authority,freshness_json=excluded.freshness_json,required_scopes_json=excluded.required_scopes_json,sort_json=excluded.sort_json,resource_json=excluded.resource_json,status='active',revision=context_nodes.revision+1,tombstoned_at=NULL`, params: row.params });
      const version = pendingVersions.get(String(row.node_id));
      if (version) statements.push({ sql: `INSERT INTO context_document_versions(id,node_id,version,content_hash,content,created_at,source_type,source_id,source_revision,source_hash,token_estimate,renderer_version,cas_hash,cas_path,storage_kind,retention_until,immutable)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [version.id, version.node_id, version.version, version.content_hash, '', version.created_at, version.source_type, version.source_id, version.source_revision, version.source_hash, version.token_estimate, version.renderer_version, version.cas_hash, version.cas_path, 'cas', null, 1] });
    }
    for (const idValue of tombstoneIds || []) statements.push({ sql: "UPDATE context_nodes SET status='tombstone',tombstoned_at=?,revision=revision+1,updated_at=? WHERE id=?", params: [timestamp, timestamp, idValue] });
    for (const row of edgeRows || []) statements.push({ sql: 'INSERT OR IGNORE INTO context_edges(parent_id,child_id,relation,created_at,edge_id,order_index,metadata_json) VALUES(?,?,?,?,?,?,?)', params: [row.parent_id, row.child_id, 'contains', row.created_at, row.edge_id, row.order_index, '{}'] });
    return this.transaction(statements);
  }

  persistIndexSnapshot({ snapshotId, projectId, payload, documentCount, timestamp }) {
    return this.transaction([
      { sql: 'INSERT OR IGNORE INTO context_index_snapshots(id,project_id,schema_version,snapshot_hash,index_hash,index_path,document_count,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [snapshotId, String(projectId), payload.schema_version, payload.snapshot_hash, payload.index_hash, 'context-index', documentCount, timestamp] },
      { sql: `INSERT INTO context_index_heads(project_id,snapshot_id,revision,updated_at)
        SELECT ?,id,1,? FROM context_index_snapshots WHERE project_id=? AND snapshot_hash=?
        ON CONFLICT(project_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,revision=context_index_heads.revision+1,updated_at=excluded.updated_at`, params: [String(projectId), timestamp, String(projectId), payload.snapshot_hash] }
    ]);
  }

  completeProjection({ jobId, projectId, revision, cursor, inputHash, snapshotHash, indexHash, stats, timestamp, actor, auditId, nodeCount }) {
    return this.transaction([
      { sql: `UPDATE context_projection_jobs SET status='completed',phase='completed',cursor=?,input_hash=?,snapshot_hash=?,index_hash=?,stats_json=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND status IN ('running','indexing')`, params: [String(cursor), inputHash, snapshotHash, indexHash, JSON.stringify(stats), timestamp, timestamp, jobId, revision], expect_changes: 1 },
      { sql: 'INSERT INTO context_projection_events(job_id,project_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [jobId, String(projectId), 'context.projection.completed', JSON.stringify({ status: 'completed', input_hash: inputHash, snapshot_hash: snapshotHash, index_hash: indexHash, stats }), timestamp] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [auditId, actor, 'context.projection.completed', 'context_projection_job', jobId, JSON.stringify({ project_id: projectId, input_hash: inputHash, index_hash: indexHash, node_count: nodeCount }), timestamp] }
    ]);
  }

  failProjection({ jobId, projectId, status, code, timestamp }) {
    return this.transaction([
      { sql: `UPDATE context_projection_jobs SET status=?,phase=?,error_code=?,error_details_json=?,cancelled_at=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_at END,updated_at=?,revision=revision+1 WHERE id=? AND status IN ('queued','running','indexing')`, params: [status, status, code, JSON.stringify({ code }), status, timestamp, timestamp, jobId] },
      { sql: 'INSERT INTO context_projection_events(job_id,project_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [jobId, String(projectId), `context.projection.${status}`, JSON.stringify({ status, error_code: code }), timestamp] }
    ]).catch(() => undefined);
  }

  transitionProjection({ jobId, projectId, revision, status, inputHash, stats, timestamp }) {
    return this.transaction([
      { sql: "UPDATE context_projection_jobs SET status=?,phase=?,input_hash=COALESCE(NULLIF(?,''),input_hash),stats_json=COALESCE(?,stats_json),updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND status NOT IN ('completed','failed','cancelled')", params: [status === 'running' ? 'running' : status, status, inputHash, stats ? JSON.stringify(stats) : null, timestamp, jobId, revision], expect_changes: 1 },
      { sql: 'INSERT INTO context_projection_events(job_id,project_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [jobId, String(projectId), `context.projection.${status}`, JSON.stringify({ status, input_hash: inputHash }), timestamp] }
    ]);
  }

  transaction(statements) { return this.db.transaction(statements.filter(Boolean)); }
  query(sql, params = []) { return this.db.query(sql, params); }
  get(sql, params = []) { return this.db.get(sql, params); }
  run(sql, params = []) { return this.db.run(sql, params); }
}

function placeholders(count) {
  return Array.from({ length: Math.max(1, Number(count) || 1) }, () => '?').join(',');
}

export function jsonField(row, field, fallback) {
  return row?.[field] == null ? fallback : parseJson(row[field], fallback);
}

export function viewNode(row) {
  if (!row) return null;
  return {
    ...row,
    freshness: jsonField(row, 'freshness_json', {}),
    required_scopes: jsonField(row, 'required_scopes_json', []),
    sort: jsonField(row, 'sort_json', {}),
    resource: jsonField(row, 'resource_json', {})
  };
}

export function viewJob(row) {
  if (!row) return null;
  return {
    ...row,
    stats: jsonField(row, 'stats_json', {}),
    error_details: jsonField(row, 'error_details_json', {})
  };
}

export function viewSelection(row) {
  if (!row) return null;
  return {
    ...row,
    node_ids: jsonField(row, 'node_ids_json', []),
    retrieval_plan: jsonField(row, 'retrieval_plan_json', {}),
    included: jsonField(row, 'included_json', []),
    excluded: jsonField(row, 'excluded_json', [])
  };
}

export function viewPack(row) {
  if (!row) return null;
  return {
    ...row,
    source_ids: jsonField(row, 'source_ids_json', []),
    pack: jsonField(row, 'pack_json', {})
  };
}
