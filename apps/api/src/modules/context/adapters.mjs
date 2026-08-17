import { asJson, hashJson, parseJson, sha256 } from '../../crypto.mjs';

const SAFE_PROJECT_FIELDS = ['id', 'name', 'description', 'status', 'revision', 'onboarding_state', 'confirmed_brief_revision', 'confirmed_brief_hash'];

/* Adapters expose a small, stable projection of upstream records.  They never
 * pass through raw rows, credentials, absolute paths, or arbitrary metadata. */
export class ContextAdapterRegistry {
  constructor({ repository, projectWorkspace = null } = {}) {
    this.store = repository;
    this.projectWorkspace = projectWorkspace;
    this.adapters = new Map([
      ['project', (projectId) => this.project(projectId)],
      ['confirmed_brief', (projectId) => this.brief(projectId)],
      ['repository_manifest', (projectId) => this.repository(projectId)],
      ['applied_workflow', (projectId) => this.workflow(projectId)],
      ['node_contract', (projectId) => this.contracts(projectId)],
      ['context_source', (projectId, options) => this.sources(projectId, options)]
    ]);
  }

  register(name, adapter) {
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(String(name)) || typeof adapter !== 'function') throw new Error('context_adapter_invalid');
    this.adapters.set(String(name), adapter);
    return this;
  }

  async collect(projectId, options = {}) {
    const records = [];
    const names = Array.isArray(options.adapters) && options.adapters.length
      ? options.adapters.map(String)
      : ['project', 'confirmed_brief', 'repository_manifest', 'applied_workflow', 'node_contract', 'context_source'];
    for (const name of names) {
      const adapter = this.adapters.get(name);
      if (!adapter) continue;
      const value = await adapter(projectId, options);
      if (Array.isArray(value)) records.push(...value);
      else if (value) records.push(value);
    }
    return records
      .filter((record) => record && record.project_id === String(projectId))
      .sort((left, right) => String(left.source_type).localeCompare(String(right.source_type)) || String(left.source_id).localeCompare(String(right.source_id)));
  }

  async project(projectId) {
    const row = await this.store.projectProjection(projectId);
    if (!row) return null;
    const value = Object.fromEntries(SAFE_PROJECT_FIELDS.filter((field) => field in row).map((field) => [field, row[field]]));
    return record({ project_id: projectId, source_type: 'project', source_id: projectId, source_revision: String(row.revision || 1), title: row.name, kind: 'project', content: JSON.stringify(value), path: '', authority: 'authoritative', required_scopes: ['context:read'], sensitivity: 'normal', resource: { fields: Object.keys(value) } });
  }

  async brief(projectId) {
    const row = await this.store.briefProjection(projectId);
    if (!row) return null;
    const content = parseJson(row.content_json, {});
    return record({ project_id: projectId, source_type: 'confirmed_brief', source_id: `${projectId}:${row.revision}`, source_revision: String(row.revision), title: 'Confirmed Brief', kind: 'brief', content: JSON.stringify(content), path: '', authority: 'authoritative', required_scopes: ['context:read'], sensitivity: 'normal', resource: { content_hash: row.content_hash } });
  }

  async repository(projectId) {
    const row = await this.store.repositoryProjection(projectId);
    if (!row) return null;
    const workspace = typeof this.projectWorkspace === 'function' ? await this.projectWorkspace(projectId).catch(() => null) : null;
    const manifest = { revision: Number(row.revision || 1), head_sha: String(row.head_sha || ''), remote: Boolean(row.remote_url), source_kind: row.source_kind || 'local', status: row.status || 'ready', workspace_available: Boolean(workspace) };
    return record({ project_id: projectId, source_type: 'repository_manifest', source_id: row.id, source_revision: String(row.revision || 1), title: 'Repository Manifest', kind: 'repository', content: JSON.stringify(manifest), path: '', authority: 'observed', required_scopes: ['context:read', 'files:read'], sensitivity: 'normal', resource: { manifest } });
  }

  async workflow(projectId) {
    const row = await this.store.workflowProjection(projectId);
    if (!row) return null;
    const tasks = parseJson(row.tasks_json, []).map((task) => ({ id: task.id, title: task.title, level: task.level, deps: task.deps || [], mode: task.mode, inputs: task.inputs || [], outputs: task.outputs || [], acceptance: task.acceptance || [] }));
    return record({ project_id: projectId, source_type: 'applied_workflow', source_id: `${projectId}:${row.revision}`, source_revision: String(row.revision), title: row.name || 'Applied Workflow', kind: 'workflow', content: JSON.stringify({ revision: row.revision, name: row.name, hierarchy_mode: row.hierarchy_mode || 'legacy_compat', tasks }), path: '', authority: 'authoritative', required_scopes: ['context:read', 'workflow:read'], sensitivity: 'normal', resource: { revision: row.revision } });
  }

  async contracts(projectId) {
    const rows = await this.store.contractProjections(projectId);
    return rows.map((row) => record({ project_id: projectId, source_type: 'node_contract', source_id: `${row.workflow_revision}:${row.node_id}`, source_revision: `${row.workflow_revision}:${row.revision}`, title: `Contract ${row.node_id}`, kind: 'node_contract', content: JSON.stringify({ node_id: row.node_id, workflow_revision: row.workflow_revision, contract: parseJson(row.contract_json, {}) }), path: '', authority: 'authoritative', required_scopes: ['context:read', 'workflow:read'], sensitivity: 'normal', resource: { contract_hash: row.contract_hash } }));
  }

  async sources(projectId, options = {}) {
    const ids = Array.isArray(options.sourceIds) ? new Set(options.sourceIds.map(String)) : null;
    const rows = await this.store.sourceProjections(projectId, ids);
    return rows.filter((row) => !ids || ids.has(String(row.id))).map((row) => record({ project_id: projectId, source_type: 'context_source', source_id: row.id, source_revision: row.created_at, title: row.title, kind: row.kind, content: row.content, path: row.path, source_hash: row.content_hash, authority: 'observed', required_scopes: ['context:read'], sensitivity: row.kind === 'image' ? 'internal' : 'normal', resource: { legacy: true } }));
  }
}

export function record(input) {
  const content = String(input.content || '');
  const normalized = {
    project_id: String(input.project_id),
    source_type: String(input.source_type),
    source_id: String(input.source_id),
    source_revision: String(input.source_revision || ''),
    title: String(input.title || input.source_id).slice(0, 240),
    kind: String(input.kind || 'record'),
    content,
    path: String(input.path || '').slice(0, 1024),
    authority: String(input.authority || 'observed'),
    required_scopes: [...new Set((input.required_scopes || ['context:read']).map(String))].sort(),
    sensitivity: ['normal', 'internal', 'sensitive', 'restricted', 'secret'].includes(input.sensitivity) ? input.sensitivity : 'normal',
    resource: input.resource && typeof input.resource === 'object' ? input.resource : {}
  };
  normalized.source_hash = /^[a-f0-9]{64}$/.test(String(input.source_hash || '')) ? String(input.source_hash) : sha256(content);
  normalized.record_hash = hashJson({ ...normalized, content: undefined });
  return normalized;
}

export function allowlistedRecordJson(recordValue) {
  return asJson({ source_type: recordValue.source_type, source_id: recordValue.source_id, source_revision: recordValue.source_revision, title: recordValue.title, kind: recordValue.kind, path: recordValue.path, authority: recordValue.authority, sensitivity: recordValue.sensitivity, required_scopes: recordValue.required_scopes, resource: recordValue.resource });
}
