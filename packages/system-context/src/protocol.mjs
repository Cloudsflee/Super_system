import { createHash } from 'node:crypto';

export const CONTEXT_PROTOCOL_VERSION = 'aiws.system-context.v1';
export const CONTEXT_RENDERER_VERSION = 'aiws.context-markdown.v1';
export const CONTEXT_SELECTION_SCHEMA = 'aiws.context_selection.v1';
export const CONTEXT_PACK_SCHEMA = 'aiws.context_pack.v4';

export const CONTEXT_EDGE_TYPES = Object.freeze([
  'contains',
  'depends_on',
  'produces',
  'consumes',
  'derived_from',
  'executes',
  'discussed_in',
  'evidenced_by',
  'supersedes'
]);

export const CONTEXT_EXCLUSION_REASONS = Object.freeze([
  'permission_denied',
  'cross_scope',
  'sensitive',
  'stale',
  'budget_exceeded',
  'user_excluded'
]);

export const CONTEXT_INTERNAL_COLLECTIONS = Object.freeze([
  'context_nodes',
  'context_document_versions',
  'context_edges',
  'context_selections',
  'context_policies',
  'context_projection_jobs',
  'context_summaries'
]);

export const CONTEXT_CATEGORY_ORDER = Object.freeze([
  'contracts',
  'dependencies',
  'executions',
  'assets',
  'conversations',
  'audit',
  'uncategorized'
]);

export const TYPE_ORDER = Object.freeze({
  system: 0,
  project: 10,
  workflow: 20,
  outcome: 30,
  task: 40,
  contracts: 50,
  dependencies: 60,
  executions: 70,
  assets: 80,
  conversations: 90,
  audit: 100,
  uncategorized: 110,
  record: 120,
  tombstone: 130
});

export const CATEGORY_LABELS = Object.freeze({
  contracts: '契约',
  dependencies: '依赖',
  executions: '执行',
  assets: '资产',
  conversations: '对话',
  audit: '审计',
  uncategorized: '未分类'
});

const ADAPTER_CATEGORY_GROUPS = Object.freeze({
  contracts: [
    'node_contracts',
    'context_packs',
    'context_sufficiency_checks',
    'project_intakes',
    'project_briefs',
    'brief_templates',
    'workflow_drafts',
    'workflow_generations'
  ],
  dependencies: [
    'asset_relations',
    'exchange_requests',
    'exchange_grants',
    'github_repositories',
    'repository_bindings',
    'canonical_repositories',
    'project_repository_bindings'
  ],
  executions: [
    'workspaces',
    'node_runs',
    'agent_sessions',
    'test_results',
    'code_changes',
    'tools',
    'file_changes',
    'webhook_deliveries',
    'worktrees',
    'terminal_sessions',
    'import_jobs',
    'host_bridge_devices',
    'workflow_generation_events',
    'repository_connections',
    'repository_targets',
    'repository_workspaces',
    'repository_lines',
    'workflow_executions',
    'task_executions',
    'execution_events',
    'deliveries',
    'delivery_events',
    'delivery_policies',
    'pull_request_intents',
    'workflow_migration_batches',
    'workflow_migration_jobs'
  ],
  assets: [
    'assets',
    'asset_versions',
    'asset_blobs',
    'asset_attestations',
    'file_refs',
    'attachments',
    'submissions',
    'digests',
    'runner_memory_candidates',
    'node_workspace_data',
    'test_tasks'
  ],
  conversations: [
    'assist_sessions',
    'assist_turns',
    'assist_messages',
    'assist_events',
    'assist_configurations',
    'assist_operations',
    'assist_change_batches',
    'assist_checkpoints',
    'runtime_user_inputs',
    'ui_action_intents'
  ],
  audit: [
    'users',
    'sessions',
    'connected_accounts',
    'credential_refs',
    'traces',
    'decisions',
    'human_reviews',
    'runtime_approvals',
    'change_proposals',
    'codex_profiles',
    'integration_statuses',
    'setup_states',
    'github_app_configs',
    'github_installations',
    'config_revisions',
    'mcp_clients',
    'project_memberships',
    'project_invitations',
    'repository_deletion_intents'
  ]
});

export const COLLECTION_SCOPE = Object.freeze({
  projects: 'project:read',
  workspaces: 'project:read',
  workflows: 'workflow:read',
  workflow_nodes: 'workflow:read',
  node_contracts: 'workflow:read',
  workflow_drafts: 'workflow:read',
  workflow_generations: 'workflow:read',
  workflow_generation_events: 'workflow:read',
  workflow_executions: 'workflow:read',
  task_executions: 'runs:read',
  execution_events: 'runs:read',
  node_runs: 'runs:read',
  context_packs: 'runs:read',
  context_sufficiency_checks: 'runs:read',
  assets: 'assets:read',
  asset_versions: 'assets:read',
  asset_relations: 'assets:read',
  asset_blobs: 'assets:read',
  asset_attestations: 'assets:read',
  file_refs: 'files:read',
  attachments: 'files:read',
  assist_sessions: 'assist:read',
  assist_turns: 'assist:read',
  assist_messages: 'assist:read',
  assist_events: 'assist:read',
  terminal_sessions: 'terminal:read',
  repository_connections: 'github:read',
  repository_targets: 'github:read',
  repository_workspaces: 'github:read',
  repository_lines: 'github:read',
  deliveries: 'github:read',
  pull_request_intents: 'github:read',
  exchange_requests: 'exchange:read',
  exchange_grants: 'exchange:read',
  traces: 'governance:read',
  decisions: 'governance:read',
  human_reviews: 'approval:read',
  runtime_approvals: 'approval:read',
  change_proposals: 'governance:read'
});

export const CONTEXT_STATE_ADAPTERS = Object.freeze(
  Object.fromEntries([
    ['projects', { category: null, scope: 'project:read', kind: 'project' }],
    ['workflows', { category: null, scope: 'workflow:read', kind: 'workflow' }],
    ['workflow_nodes', { category: null, scope: 'workflow:read', kind: 'workflow_node' }],
    ...Object.entries(ADAPTER_CATEGORY_GROUPS).flatMap(([category, names]) =>
      names.map((name) => [
        name,
        { category, scope: COLLECTION_SCOPE[name] || defaultCollectionScope(name), kind: 'record' }
      ])
    )
  ])
);

export const SECRET_KEY =
  /(?:^|_)(?:password|passwd|secret|token|cookie|credential|encrypted_value|encrypted_data|ciphertext|private_key|client_secret|authorization|api_key|access_key|refresh_key)(?:_|$)/i;
// Runtime bookkeeping is intentionally excluded from the source fingerprint. These
// fields can be refreshed by a scheduler without changing the authoritative fact
// represented by the context document.
const VOLATILE_CONTEXT_KEYS = new Set(['updated_at', 'checked_at', 'last_seen_at', 'last_synced_at']);
const REFERENCE_KEY = /(?:^|_)(?:credential|secret|token|key|auth|vault)_ref(?:_id)?$/i;
const HOST_PATH_KEY =
  /(?:^|_)(?:absolute_path|workspace_root|repo_path|checkout_path|worktree_path|local_path|host_path)$/i;
const HOST_PATH_VALUE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/(?:Users|home|var|opt|private|mnt|srv|root)(?:\/|$))/;
const HOST_PATH_FRAGMENT =
  /(?:[a-zA-Z]:[\\/](?:[^\s`"'<>]| (?! ))+|\\\\[^\s`"'<>]+|\/(?:Users|home|var|opt|private|mnt|srv|root)(?:\/[^\s`"'<>]*)?)/g;
export const URI_PATTERN = /^aiws:\/\/context\/(?:map|nodes|directories)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

export function contextHash(value) {
  return createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value))
    .digest('hex');
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function contextNodeId(collection, sourceId) {
  return `ctx_${contextHash(`${collection}:${sourceId}`).slice(0, 24)}`;
}

export function contextSourceRecordId(collection, record) {
  if (!record || typeof record !== 'object') throw contextError('context_source_record_invalid', { collection });
  if (record.id != null && String(record.id).trim()) return String(record.id);
  if (record.key != null && String(record.key).trim()) {
    const qualifier = [record.profile_id, record.request_id, record.source_id, record.provider_id]
      .filter((value) => value != null && String(value).trim())
      .map(String)
      .join(':');
    return qualifier ? `${record.key}:${qualifier}` : String(record.key);
  }
  const legacyIdentity = Object.fromEntries(
    [
      'app_id',
      'client_id',
      'user_id',
      'project_id',
      'workflow_id',
      'node_id',
      'session_id',
      'turn_id',
      'delivery_id',
      'created_at'
    ]
      .filter((key) => record[key] != null && String(record[key]).trim())
      .map((key) => [key, record[key]])
  );
  if (Object.keys(legacyIdentity).length)
    return `legacy_${contextHash({ collection, identity: legacyIdentity }).slice(0, 24)}`;
  throw contextError('context_source_identity_missing', { collection });
}

export function contextDirectoryId(parentId, category) {
  return `ctxdir_${contextHash(`${parentId}:${category}`).slice(0, 20)}`;
}

export function contextNodeUri(nodeId) {
  return `aiws://context/nodes/${encodeURIComponent(String(nodeId))}`;
}

export function contextMapUri(projectId = null) {
  return `aiws://context/map/${projectId ? `projects/${encodeURIComponent(String(projectId))}` : 'global'}`;
}

export function sanitizeContextFacts(value) {
  const redactions = [];
  const visit = (input, path = '$', key = '') => {
    if (input == null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'bigint') return String(input);
    if (typeof input === 'string') {
      if (REFERENCE_KEY.test(key)) {
        redactions.push({ path, reason: 'secret_reference_only' });
        return { reference: safeReference(input), redacted: true };
      }
      if (SECRET_KEY.test(key)) {
        redactions.push({ path, reason: 'sensitive_field' });
        return '[已脱敏]';
      }
      if (HOST_PATH_KEY.test(key) || HOST_PATH_VALUE.test(input)) {
        redactions.push({ path, reason: 'host_path_hidden' });
        return '[宿主机路径已隐藏]';
      }
      const cleaned = input.replace(/\u0000/g, '');
      const withoutSecrets = maskContextSecretText(cleaned);
      if (withoutSecrets !== cleaned) redactions.push({ path, reason: 'sensitive_value' });
      const withoutHostPaths = withoutSecrets.replace(HOST_PATH_FRAGMENT, '[宿主机路径已隐藏]');
      if (withoutHostPaths !== withoutSecrets) redactions.push({ path, reason: 'host_path_hidden' });
      return withoutHostPaths;
    }
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      const bytes = Buffer.from(input);
      redactions.push({ path, reason: 'binary_manifest_only' });
      return {
        binary: true,
        size_bytes: bytes.length,
        sha256: contextHash(bytes),
        media_type: 'application/octet-stream',
        description: '二进制内容未写入文本投影'
      };
    }
    if (Array.isArray(input)) return input.map((item, index) => visit(item, `${path}[${index}]`, key));
    if (typeof input === 'object') {
      const output = {};
      for (const childKey of Object.keys(input).sort()) {
        const childPath = `${path}.${childKey}`;
        if (SECRET_KEY.test(childKey) && !REFERENCE_KEY.test(childKey)) {
          redactions.push({ path: childPath, reason: 'sensitive_field' });
          output[childKey] = '[已脱敏]';
        } else output[childKey] = visit(input[childKey], childPath, childKey);
      }
      return output;
    }
    return String(input);
  };
  return { facts: visit(value), redactions: uniqueRedactions(redactions) };
}

export function contextSourceHash(collection, record) {
  return contextHash({ collection, facts: stripVolatileContextFacts(sanitizeContextFacts(record).facts) });
}

function stripVolatileContextFacts(value) {
  if (Array.isArray(value)) return value.map(stripVolatileContextFacts);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (VOLATILE_CONTEXT_KEYS.has(key)) continue;
    result[key] = stripVolatileContextFacts(child);
  }
  return result;
}

export function tokenizeContextText(value, locales = ['zh-CN', 'en']) {
  const text = String(value || '')
    .normalize('NFKC')
    .toLowerCase();
  const localeList = Array.isArray(locales) ? locales : ['zh-CN', 'en'];
  const tokens = [];
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(localeList[0], { granularity: 'word' });
    for (const part of segmenter.segment(text))
      if (part.isWordLike && part.segment.trim()) tokens.push(part.segment.trim());
  } else tokens.push(...text.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  for (const block of text.match(/[\p{Script=Han}]{2,}/gu) || [])
    for (let index = 0; index < block.length - 1; index += 1) tokens.push(block.slice(index, index + 2));
  return [...new Set(tokens)];
}

export function compareContextNodes(left, right) {
  return (
    Number(left.sort?.type_order ?? TYPE_ORDER[left.kind] ?? TYPE_ORDER.record) -
      Number(right.sort?.type_order ?? TYPE_ORDER[right.kind] ?? TYPE_ORDER.record) ||
    Number(left.sort?.order_index || 0) - Number(right.sort?.order_index || 0) ||
    String(left.sort?.stable_id || left.id).localeCompare(String(right.sort?.stable_id || right.id))
  );
}

export function defaultCollectionScope(collection) {
  if (/^assist_|runtime_user_inputs$|ui_action_intents$/.test(collection)) return 'assist:read';
  if (/^asset_|^assets$/.test(collection)) return 'assets:read';
  if (/file|attachment|submission|digest|workspace_data|memory_candidate/.test(collection)) return 'files:read';
  if (/repository|github|delivery|pull_request|webhook/.test(collection)) return 'github:read';
  if (/workflow|node_contract|test_task/.test(collection)) return 'workflow:read';
  if (/execution|node_run|agent_session|test_result/.test(collection)) return 'runs:read';
  if (/terminal/.test(collection)) return 'terminal:read';
  if (/exchange/.test(collection)) return 'exchange:read';
  if (/approval|human_review/.test(collection)) return 'approval:read';
  if (/trace|decision|proposal|membership|invitation/.test(collection)) return 'governance:read';
  if (/setup|config|profile|integration|mcp_client|connected_account|credential/.test(collection)) return 'setup:read';
  return 'system:read';
}

function safeReference(value) {
  const text = String(value || '');
  if (/^(?:vault|env|memory):[A-Za-z0-9._:-]{1,240}$/.test(text)) return text;
  return `[引用:${contextHash(text).slice(0, 12)}]`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    );
  return value;
}

function uniqueRedactions(items) {
  return uniqueBy(items, (item) => `${item.path}:${item.reason}`).sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}

export function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export function contextError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function maskContextSecretText(value) {
  return String(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[已脱敏]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[已脱敏]')
    .replace(/\bnpm_[A-Za-z0-9_]{20,}\b/g, '[已脱敏]')
    .replace(/\baiws_mcp_[A-Za-z0-9_-]{30,}\b/g, '[已脱敏]')
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      '[已脱敏]'
    )
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, '[已脱敏]')
    .replace(/\b(authorization|cookie)\s*["']?\s*[:=]\s*[^\r\n]*/gi, '$1=[已脱敏]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [已脱敏]')
    .replace(
      /\b([a-z0-9_-]*(?:token|password|passwd|secret|credential|api[_-]?key|access[_-]?key|refresh[_-]?key|private[_-]?key))\s*["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
      '$1=[已脱敏]'
    );
}
