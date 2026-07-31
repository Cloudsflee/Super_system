import {
  CATEGORY_LABELS,
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_PROTOCOL_VERSION,
  CONTEXT_STATE_ADAPTERS,
  SECRET_KEY,
  TYPE_ORDER,
  compareContextNodes,
  contextDirectoryId,
  contextHash,
  contextNodeId,
  contextNodeUri,
  contextSourceHash,
  contextSourceRecordId
} from './protocol.mjs';
import { cleanContextInline as cleanInline } from './rendering.mjs';

const DIRECT_PARENT_BUILDERS = {
  workflows: (record) => ref('projects', record.project_id),
  workflow_nodes: (record) =>
    record.parent_node_id ? ref('workflow_nodes', record.parent_node_id) : ref('workflows', record.workflow_id),
  node_contracts: (record) => ref('workflow_nodes', record.node_id),
  asset_versions: (record) => ref('assets', record.asset_id),
  asset_attestations: (record) => ref('asset_versions', record.asset_version_id),
  node_runs: (record) => ref('workflow_nodes', record.node_id),
  task_executions: (record) => ref('workflow_nodes', record.task_id),
  workflow_executions: (record) => ref('workflows', record.workflow_id),
  execution_events: (record) =>
    record.task_execution_id
      ? ref('task_executions', record.task_execution_id)
      : ref('workflow_executions', record.workflow_execution_id),
  repository_lines: (record) => ref('workflow_nodes', record.workstream_id),
  repository_targets: (record) => ref('workflow_nodes', record.task_id || record.workstream_id),
  deliveries: (record) => ref('workflow_nodes', record.task_id || record.workstream_id),
  assist_turns: (record) => ref('assist_sessions', record.session_id),
  assist_messages: (record) => ref('assist_turns', record.turn_id) || ref('assist_sessions', record.session_id),
  assist_events: (record) => ref('assist_turns', record.turn_id) || ref('assist_sessions', record.session_id),
  attachments: (record) => ref('assist_turns', record.turn_id) || ref('assist_sessions', record.session_id),
  workspaces: (record) => (record.workflow_node_id ? ref('workflow_nodes', record.workflow_node_id) : null)
};

export function buildDesiredNodes(state, collections, timestamp) {
  const desired = [systemRoot(timestamp)];
  for (const collection of collections)
    for (const record of state[collection]) desired.push(sourceNode(state, collection, record, timestamp));
  assignDesiredNodeParents(state, desired, timestamp);
  return desired.sort(compareContextNodes);
}

export function coverageWarnings(state, collections) {
  const warnings = (state.context_resource_coverage?.warnings || []).map((item) => JSON.parse(JSON.stringify(item)));
  for (const collection of collections) {
    if (knownCollection(collection)) continue;
    if (state[collection].length)
      warnings.push({ code: 'context_adapter_uncategorized', collection, record_count: state[collection].length });
  }
  return warnings.sort(
    (left, right) =>
      String(left.code || '').localeCompare(String(right.code || '')) ||
      String(left.project_id || left.collection || '').localeCompare(String(right.project_id || right.collection || ''))
  );
}

function assignDesiredNodeParents(state, desired, timestamp) {
  const lookup = new Map(desired.map((node) => [`${node.source_collection}:${node.source_id}`, node]));
  const categories = new Map();
  for (const node of desired.filter((item) => item.source_collection))
    assignDesiredNodeParent(state, node, lookup, categories, timestamp);
  desired.push(...categories.values());
  const desiredIds = new Set(desired.map((node) => node.id));
  for (const node of desired) if (node.parent_id && !desiredIds.has(node.parent_id)) node.parent_id = 'ctx_root_system';
}

function assignDesiredNodeParent(state, node, lookup, categories, timestamp) {
  const direct = directParentNode(state, node, lookup);
  if (direct) {
    node.parent_id = direct.id;
    return;
  }
  if (node.kind === 'project') {
    node.parent_id = 'ctx_root_system';
    return;
  }
  const projectNode = node.project_id ? lookup.get(`projects:${node.project_id}`) : null;
  const category = collectionCategory(node.source_collection);
  const baseParent = projectNode?.id || 'ctx_root_system';
  const categoryKey = `${baseParent}:${category}`;
  if (!categories.has(categoryKey))
    categories.set(categoryKey, directoryNode(baseParent, category, node.project_id, timestamp));
  node.parent_id = categories.get(categoryKey).id;
}

function systemRoot(timestamp) {
  const sourceHash = contextHash({ type: 'system', protocol: CONTEXT_PROTOCOL_VERSION });
  return {
    id: 'ctx_root_system',
    uri: 'aiws://context/map/global',
    kind: 'system',
    source_type: 'projection',
    source_collection: null,
    source_id: null,
    source_version: 1,
    project_id: null,
    parent_id: null,
    title: '系统',
    deterministic_summary: 'AI 工作空间系统上下文地图根目录。',
    sort: { type_order: TYPE_ORDER.system, order_index: 0, stable_id: 'ctx_root_system' },
    scope: { type: 'system', id: 'system', project_id: null },
    sensitivity: 'internal',
    required_scopes: ['context:read'],
    freshness: { status: 'current', source_updated_at: null },
    authority: 'authoritative',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}

function sourceNode(state, collection, record, timestamp) {
  const sourceId = contextSourceRecordId(collection, record);
  const id = contextNodeId(collection, sourceId);
  const projectId = resolveRecordProjectId(state, collection, record);
  const kind = sourceKind(collection, record);
  const title = sourceTitle(collection, record);
  const sourceHash = contextSourceHash(collection, record);
  const freshnessStatus = sourceFreshness(record);
  return {
    id,
    uri: contextNodeUri(id),
    kind,
    source_type: 'state',
    source_collection: collection,
    source_id: sourceId,
    source_version: Number(record.version || record.revision || record.workflow_revision || 1),
    project_id: projectId,
    parent_id: null,
    title,
    deterministic_summary: deterministicSummary(collection, record, title),
    sort: {
      type_order: TYPE_ORDER[kind] ?? TYPE_ORDER.record,
      order_index: Number(record.order_index || record.sequence || record.position || 0),
      stable_id: sourceId
    },
    scope: { type: projectId ? 'project' : 'system', id: projectId || 'system', project_id: projectId },
    sensitivity: sourceSensitivity(collection, record),
    required_scopes: [
      'context:read',
      CONTEXT_STATE_ADAPTERS[collection]?.scope || (projectId ? 'project:read' : 'system:read')
    ],
    freshness: {
      status: freshnessStatus,
      source_updated_at: record.updated_at || record.created_at || null,
      checked_at: timestamp
    },
    authority: sourceAuthority(collection, record),
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}

function directoryNode(parentId, category, projectId, timestamp) {
  const id = contextDirectoryId(parentId, category);
  const sourceHash = contextHash({ parentId, category, protocol: CONTEXT_PROTOCOL_VERSION });
  return {
    id,
    uri: `aiws://context/directories/${id}`,
    kind: category,
    source_type: 'projection',
    source_collection: null,
    source_id: null,
    source_version: 1,
    project_id: projectId || null,
    parent_id: parentId,
    title: CATEGORY_LABELS[category],
    deterministic_summary: `${CATEGORY_LABELS[category]}上下文的有序目录。`,
    sort: { type_order: TYPE_ORDER[category], order_index: 0, stable_id: id },
    scope: { type: projectId ? 'project' : 'system', id: projectId || 'system', project_id: projectId || null },
    sensitivity: 'internal',
    required_scopes: ['context:read', projectId ? 'project:read' : 'system:read'],
    freshness: { status: 'current', source_updated_at: null },
    authority: 'authoritative',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}

function directParentNode(state, node, lookup) {
  const record = state[node.source_collection]?.find(
    (item) => contextSourceRecordId(node.source_collection, item) === node.source_id
  );
  if (!record) return null;
  const reference = directParentReference(node.source_collection, record);
  return reference ? lookup.get(`${reference.collection}:${reference.id}`) || null : null;
}

function directParentReference(collection, record) {
  const direct = DIRECT_PARENT_BUILDERS[collection]?.(record);
  if (direct) return direct;
  if (record.node_id) return ref('workflow_nodes', record.node_id);
  if (record.task_id) return ref('workflow_nodes', record.task_id);
  if (record.workstream_id) return ref('workflow_nodes', record.workstream_id);
  return record.workflow_id ? ref('workflows', record.workflow_id) : null;
}

function sourceKind(collection, record) {
  if (collection === 'projects') return 'project';
  if (collection === 'workflows' || collection === 'workflow_drafts') return 'workflow';
  if (collection !== 'workflow_nodes') return 'record';
  if (record.role === 'workstream') return 'outcome';
  return record.role === 'task' ? 'task' : 'record';
}

function sourceTitle(collection, record) {
  const title =
    record.title ||
    record.name ||
    record.display_name ||
    record.summary ||
    record.label ||
    record.event_type ||
    record.type ||
    record.key;
  return cleanInline(title ? String(title) : `${collection}/${record.id}`);
}

function deterministicSummary(collection, record, title) {
  const summary = record.summary || record.goal || record.description || record.outcome || record.message;
  const status = record.status ? `状态：${record.status}。` : '';
  return cleanInline(
    summary ? `${summary}${status ? ` ${status}` : ''}` : `${title} 的 ${collection} 权威记录。${status}`
  );
}

function sourceFreshness(record) {
  const status = String(record.status || '').toLowerCase();
  if (
    ['superseded', 'archived', 'deleted', 'revoked', 'expired'].includes(status) ||
    record.deleted_at ||
    record.superseded_at
  )
    return 'superseded';
  if (['stale', 'corrupt'].includes(status) || record.stale === true) return 'stale';
  return 'current';
}

function sourceSensitivity(collection, record) {
  if (collection === 'credential_refs' || SECRET_KEY.test(String(record.type || ''))) return 'secret';
  if (['mcp_clients', 'sessions', 'connected_accounts', 'github_app_configs', 'codex_profiles'].includes(collection))
    return 'restricted';
  return record.sensitivity && ['public', 'internal', 'restricted', 'secret'].includes(record.sensitivity)
    ? record.sensitivity
    : 'internal';
}

function sourceAuthority(collection, record) {
  if (record.authority) return record.authority;
  if (collection === 'context_summaries') return 'non_authoritative';
  if (record.status === 'draft' || collection.includes('draft')) return 'draft';
  return 'authoritative';
}

function resolveRecordProjectId(state, collection, record, seen = new Set()) {
  const direct = directRecordProjectId(collection, record);
  if (direct) return direct;
  const marker = `${collection}:${contextSourceRecordId(collection, record)}`;
  if (seen.has(marker)) return null;
  seen.add(marker);
  const parentProject = parentRecordProjectId(state, collection, record, seen);
  return parentProject || linkedRecordProjectId(state, record, seen);
}

function directRecordProjectId(collection, record) {
  if (collection === 'projects' && record.id) return String(record.id);
  return record.project_id ? String(record.project_id) : null;
}

function parentRecordProjectId(state, collection, record, seen) {
  const parent = directParentReference(collection, record);
  if (!parent) return null;
  const target = state[parent.collection]?.find((item) => String(item.id) === String(parent.id));
  return target ? resolveRecordProjectId(state, parent.collection, target, seen) : null;
}

function linkedRecordProjectId(state, record, seen) {
  for (const resolver of LINKED_PROJECT_RESOLVERS) {
    const projectId = resolver(state, record, seen);
    if (projectId) return projectId;
  }
  return null;
}

const LINKED_PROJECT_RESOLVERS = [
  (state, record, seen) => (record.workspace_id ? workspaceProjectId(state, record.workspace_id, seen) : null),
  (state, record) =>
    record.session_id ? state.assist_sessions?.find((item) => item.id === record.session_id)?.project_id || null : null,
  (state, record, seen) => (record.turn_id ? assistTurnProjectId(state, record.turn_id, seen) : null),
  (state, record) =>
    record.asset_id ? state.assets?.find((item) => item.id === record.asset_id)?.project_id || null : null,
  (state, record) =>
    record.workflow_execution_id
      ? state.workflow_executions?.find((item) => item.id === record.workflow_execution_id)?.project_id || null
      : null,
  (_state, record) => (record.source_project_id && record.target_project_id ? String(record.target_project_id) : null)
];

function workspaceProjectId(state, workspaceId, seen) {
  const workspace = state.workspaces?.find((item) => item.id === workspaceId);
  return workspace ? workspace.project_id || resolveRecordProjectId(state, 'workspaces', workspace, seen) : null;
}

function assistTurnProjectId(state, turnId, seen) {
  const turn = state.assist_turns?.find((item) => item.id === turnId);
  return turn ? turn.project_id || resolveRecordProjectId(state, 'assist_turns', turn, seen) : null;
}

function collectionCategory(collection) {
  return CONTEXT_STATE_ADAPTERS[collection]?.category || 'uncategorized';
}

function knownCollection(collection) {
  return Boolean(CONTEXT_STATE_ADAPTERS[collection]);
}

function ref(collection, id) {
  return id ? { collection, id: String(id) } : null;
}
