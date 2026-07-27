import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collections } from '../../apps/api/src/config.mjs';
import { collectContextVersions, materializeContextDocumentsInState } from '../../apps/api/src/context-projection.mjs';
import {
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_STATE_ADAPTERS,
  assertContextImmutability,
  buildContextSearchIndex,
  compareContextNodes,
  contextHash,
  contextSourceRecordId,
  createContextSelection,
  ensureContextCollections,
  loadContextSearchIndex,
  reconcileContextProjectionState,
  renderContextMarkdown,
  sanitizeContextFacts,
  searchContextSearchIndex,
  serializeContextSearchIndex,
  tokenizeContextText,
  validateContextState
} from '../../packages/system-context/src/index.mjs';

const sourceCollections = collections.filter((name) => !CONTEXT_INTERNAL_COLLECTIONS.includes(name));
assert.deepEqual(Object.keys(CONTEXT_STATE_ADAPTERS).sort(), sourceCollections.slice().sort());

assert.equal(contextSourceRecordId('projects', { id: 'project-1' }), 'project-1');
assert.equal(
  contextSourceRecordId('integration_statuses', { key: 'codex_probe', profile_id: 'profile-1' }),
  'codex_probe:profile-1'
);
assert.notEqual(
  contextSourceRecordId('integration_statuses', { key: 'codex_probe', profile_id: 'profile-1' }),
  contextSourceRecordId('integration_statuses', { key: 'codex_probe', profile_id: 'profile-2' })
);
assert.equal(
  contextSourceRecordId('webhook_deliveries', { delivery_id: 'delivery-1', event: 'push' }),
  contextSourceRecordId('webhook_deliveries', { delivery_id: 'delivery-1', event: 'pull_request' })
);
assert.notEqual(
  contextSourceRecordId('webhook_deliveries', { delivery_id: 'delivery-1' }),
  contextSourceRecordId('webhook_deliveries', { delivery_id: 'delivery-2' })
);

const state = Object.fromEntries(sourceCollections.map((name) => [name, []]));
state.projects.push({ id: 'project-1', title: '上下文项目', status: 'active', order_index: 1 });
state.integration_statuses.push(
  { key: 'codex_probe', profile_id: 'profile-1', status: 'failed' },
  { key: 'codex_probe', profile_id: 'profile-2', status: 'ready' }
);
const projection = reconcileContextProjectionState(state, {
  sourceCollections,
  timestamp: '2026-07-26T00:00:00.000Z'
});
assert.equal(projection.warnings.length, 0);
assert.equal(state.context_nodes.filter((node) => node.source_collection === 'integration_statuses').length, 2);
assert.equal(
  state.context_nodes.find((node) => node.source_collection === 'projects').project_id,
  'project-1',
  'a project root belongs to its own project scope'
);
assert.equal(
  state.context_nodes.find((node) => node.source_id === 'codex_probe:profile-1').freshness.status,
  'current',
  'a failed execution or health result is still a current fact'
);

const unknownState = { future_records: [{ id: 'future-1', title: 'Future' }] };
reconcileContextProjectionState(unknownState, {
  sourceCollections: ['future_records'],
  timestamp: '2026-07-26T00:00:00.000Z'
});
assert.equal(unknownState.context_projection_coverage.warnings[0].code, 'context_adapter_uncategorized');
assert.equal(
  unknownState.context_nodes
    .find((node) => node.source_collection === 'future_records')
    .parent_id.startsWith('ctxdir_'),
  true
);
assert.equal(unknownState.context_nodes.find((node) => node.kind === 'uncategorized').title, '未分类');

const secret = 'sentinel-secret-value';
const fineGrainedToken = `github_pat_${'A'.repeat(30)}`;
const { facts, redactions } = sanitizeContextFacts({
  title: '完整事实',
  password: secret,
  encrypted_value: 'encrypted-secret-payload',
  credential_ref: 'vault:github-client',
  vault_ref: 'vault:device-credential',
  repo_path: 'C:\\Users\\owner\\private-repo',
  description: 'token=free-text-secret-value',
  npm_config: `//registry.npmjs.org/:_authToken=${secret}`,
  request_header: `Authorization: Bearer ${secret}`,
  browser_header: `Cookie: session=${secret}; csrf=another-secret-value`,
  json_config: `{"accessToken":"${secret}"}`,
  provider_output: fineGrainedToken,
  payload: Buffer.from([0, 1, 2, 3])
});
assert.equal(facts.password, '[已脱敏]');
assert.equal(facts.encrypted_value, '[已脱敏]');
assert.deepEqual(facts.credential_ref, { reference: 'vault:github-client', redacted: true });
assert.deepEqual(facts.vault_ref, { reference: 'vault:device-credential', redacted: true });
assert.equal(facts.repo_path, '[宿主机路径已隐藏]');
assert.equal(facts.description.includes('free-text-secret-value'), false);
assert.deepEqual(Object.keys(facts.payload).sort(), ['binary', 'description', 'media_type', 'sha256', 'size_bytes']);
assert.equal(JSON.stringify(facts).includes(secret), false);
assert.equal(JSON.stringify(facts).includes(fineGrainedToken), false);
assert.deepEqual(
  new Set(redactions.map((item) => item.reason)),
  new Set(['sensitive_field', 'sensitive_value', 'secret_reference_only', 'host_path_hidden', 'binary_manifest_only'])
);

const renderNode = state.context_nodes.find((node) => node.source_collection === 'projects');
const firstMarkdown = renderContextMarkdown({
  node: renderNode,
  record: { id: 'project-1', z: 1, a: 2, password: secret }
});
const secondMarkdown = renderContextMarkdown({
  node: renderNode,
  record: { password: secret, a: 2, z: 1, id: 'project-1' }
});
assert.equal(firstMarkdown, secondMarkdown);
assert.equal(firstMarkdown.includes(secret), false);
assert.ok(firstMarkdown.indexOf('## 身份') < firstMarkdown.indexOf('## 摘要'));
assert.ok(firstMarkdown.indexOf('## 摘要') < firstMarkdown.indexOf('## 状态'));
assert.ok(firstMarkdown.indexOf('## 状态') < firstMarkdown.indexOf('## 完整事实'));
assert.match(firstMarkdown, /"a": 2[\s\S]*"id": "project-1"[\s\S]*"password": "\[已脱敏\]"[\s\S]*"z": 1/);
const protectedMetadataMarkdown = renderContextMarkdown({
  node: {
    ...renderNode,
    title: 'sk-proj-1234567890abcdefghijkl',
    deterministic_summary: '来源 C:\\Users\\owner\\private-repo'
  },
  record: { id: 'project-1' }
});
assert.equal(protectedMetadataMarkdown.includes('sk-proj-1234567890abcdefghijkl'), false);
assert.equal(protectedMetadataMarkdown.includes('C:\\Users\\owner'), false);
const systemRoot = state.context_nodes.find((node) => node.id === 'ctx_root_system');
const systemRootMarkdown = renderContextMarkdown({
  node: systemRoot,
  edges: state.context_edges.filter(
    (edge) => edge.source_node_id === systemRoot.id || edge.target_node_id === systemRoot.id
  ),
  relatedNodes: [renderNode]
});
assert.equal(
  systemRootMarkdown.includes(renderNode.title),
  false,
  'a global canonical document must not embed project-scoped relation metadata'
);

const left = { id: 'ctx-a', title: 'Z', kind: 'record', sort: { type_order: 120, order_index: 1, stable_id: 'a' } };
const right = { id: 'ctx-b', title: 'A', kind: 'record', sort: { type_order: 120, order_index: 1, stable_id: 'b' } };
assert.ok(compareContextNodes(left, right) < 0);
left.title = 'A changed title';
right.title = 'Z changed title';
assert.ok(compareContextNodes(left, right) < 0, 'titles do not affect stable ordering');

const cjkTokens = tokenizeContextText('项目上下文 Context Search');
assert.ok(cjkTokens.includes('上下'));
assert.ok(cjkTokens.includes('context'));
assert.ok(cjkTokens.includes('search'));

const indexedNode = {
    ...renderNode,
    id: 'ctx-indexed',
    title: '项目上下文',
    current_version_id: 'ctx-version-indexed'
  },
  secretNode = {
    ...renderNode,
    id: 'ctx-secret',
    title: 'sentinel-secret-title',
    sensitivity: 'secret',
    current_version_id: 'ctx-version-secret'
  },
  builtIndex = await buildContextSearchIndex({
    nodes: [indexedNode, secretNode],
    documentVersions: [
      { id: 'ctx-version-indexed', node_id: indexedNode.id },
      { id: 'ctx-version-secret', node_id: secretNode.id }
    ],
    edges: [
      {
        id: 'edge-secret',
        type: 'depends_on',
        source_node_id: indexedNode.id,
        target_node_id: secretNode.id
      }
    ],
    readDocument: async (_version, node) => `${node.title} 完整事实 Context Search`
  });
assert.deepEqual(
  searchContextSearchIndex(builtIndex.index, '上下文').map((item) => item.id),
  [indexedNode.id]
);
assert.equal(searchContextSearchIndex(builtIndex.index, 'sentinel-secret-title').length, 0);
const serializedIndex = serializeContextSearchIndex(builtIndex.index, {
  snapshotHash: builtIndex.snapshot_hash,
  rebuiltAt: '2026-07-26T00:00:00.000Z'
});
const restoredIndex = loadContextSearchIndex(JSON.parse(JSON.stringify(serializedIndex)));
assert.deepEqual(
  searchContextSearchIndex(restoredIndex, 'Context Search').map((item) => item.id),
  [indexedNode.id]
);

const selectionState = selectionFixture();
const selection = createContextSelection(selectionState, {
  id: 'selection-1',
  actorId: 'user-1',
  projectId: 'project-1',
  candidateNodeIds: ['allowed', 'foreign', 'secret', 'stale', 'excluded', 'oversized', 'missing-scope'],
  tokenBudget: 10,
  scopes: ['context:read', 'project:read'],
  allowedProjectIds: ['project-1'],
  timestamp: '2026-07-26T00:00:00.000Z'
});
assert.deepEqual(
  selection.included.map((item) => item.node_id),
  ['allowed']
);
assert.deepEqual(Object.fromEntries(selection.excluded.map((item) => [item.node_id, item.reason])), {
  foreign: 'permission_denied',
  secret: 'sensitive',
  stale: 'stale',
  excluded: 'user_excluded',
  oversized: 'budget_exceeded',
  'missing-scope': 'permission_denied'
});
assert.equal(selection.token_used, 4);
const receiptSelection = createContextSelection(selectionState, {
  id: 'selection-receipt',
  actorId: 'user-1',
  projectId: 'project-1',
  candidateNodeIds: ['allowed'],
  tokenBudget: 0,
  scopes: ['context:read', 'project:read'],
  allowedProjectIds: ['project-1'],
  alreadyBudgetedDocumentVersionIds: [
    selectionState.context_nodes.find((item) => item.id === 'allowed').current_version_id
  ]
});
assert.deepEqual(
  receiptSelection.included.map((item) => item.node_id),
  ['allowed']
);
assert.equal(receiptSelection.token_used, 0);

const rankedState = ensureContextCollections({}),
  stableFirst = selectableNode('rank-a'),
  fulltextFirst = selectableNode('rank-b');
rankedState.context_nodes.push(stableFirst, fulltextFirst);
for (const node of rankedState.context_nodes) {
  const version = selectableVersion(node.id, 1);
  node.current_version_id = version.id;
  rankedState.context_document_versions.push(version);
}
const rankedSelection = createContextSelection(rankedState, {
  id: 'selection-ranked',
  actorId: 'user-1',
  projectId: 'project-1',
  candidateNodeIds: [stableFirst.id, fulltextFirst.id],
  candidateRanks: new Map([
    [fulltextFirst.id, 0],
    [stableFirst.id, 1]
  ]),
  tokenBudget: 10,
  allowedProjectIds: ['project-1']
});
assert.deepEqual(
  rankedSelection.included.map((item) => item.node_id),
  [fulltextFirst.id, stableFirst.id],
  'selection keeps the server-adjudicated full-text rank before stable order'
);

const immutableBefore = {
  context_document_versions: structuredClone(selectionState.context_document_versions),
  context_selections: [structuredClone(selection)]
};
const immutableAfter = structuredClone(immutableBefore);
assertContextImmutability(immutableBefore, immutableAfter);
immutableAfter.context_selections[0].token_used += 1;
assert.throws(
  () => assertContextImmutability(immutableBefore, immutableAfter),
  code('context_immutable_record_changed')
);
const immutableDeletion = structuredClone(immutableBefore);
immutableDeletion.context_selections.length = 0;
assert.throws(
  () => assertContextImmutability(immutableBefore, immutableDeletion),
  code('context_immutable_record_changed')
);
assert.doesNotThrow(() =>
  assertContextImmutability(immutableBefore, immutableDeletion, {
    allowDeletion: true
  })
);

const cycle = ensureContextCollections({});
cycle.context_nodes.push(bareNode('a', 'b'), bareNode('b', 'a'));
cycle.context_edges.push(contains('b', 'a'), contains('a', 'b'));
assert.throws(() => validateContextState(cycle), code('context_contains_cycle'));

const retainedVersions = collectContextVersions(
  {
    context_nodes: [{ current_version_id: 'current' }],
    context_document_versions: [
      versionForRetention('current', '2020-01-01T00:00:00.000Z'),
      versionForRetention('selected', '2020-01-01T00:00:00.000Z'),
      versionForRetention('executed-pack', '2020-01-01T00:00:00.000Z'),
      versionForRetention('asset-provenance', '2020-01-01T00:00:00.000Z'),
      versionForRetention('summary-source', '2020-01-01T00:00:00.000Z'),
      versionForRetention('explicit-retention', '2020-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
      versionForRetention('fresh', '2026-07-10T00:00:00.000Z'),
      versionForRetention('expired', '2020-01-01T00:00:00.000Z')
    ],
    context_selections: [{ id: 'selection-retained', included: [{ document_version_id: 'selected' }] }],
    context_packs: [
      {
        context_selection_id: 'selection-retained',
        context_document_versions: ['executed-pack'],
        content_json: { document_versions: [{ document_version_id: 'executed-pack' }] }
      }
    ],
    context_summaries: [{ document_version_id: 'summary-source' }],
    asset_versions: [{ provenance: { consumed_context_document_versions: ['asset-provenance'] } }]
  },
  { timestamp: '2026-07-26T00:00:00.000Z' }
);
assert.deepEqual(
  retainedVersions.map((item) => item.id),
  ['current', 'selected', 'executed-pack', 'asset-provenance', 'summary-source', 'explicit-retention', 'fresh']
);

const recurringState = { projects: [{ id: 'project-recurring', title: '版本 A' }] };
reconcileContextProjectionState(recurringState, {
  sourceCollections: ['projects'],
  timestamp: '2026-07-26T02:00:00.000Z'
});
const recurringNode = recurringState.context_nodes.find((node) => node.source_id === 'project-recurring');
const sourceHashA = recurringNode.source_hash;
recurringState.context_document_versions.push({
  id: 'version-a',
  node_id: recurringNode.id,
  source_hash: sourceHashA,
  version: 1,
  created_at: '2026-07-26T02:00:00.000Z'
});
recurringNode.current_version_id = 'version-a';
recurringState.context_projection_jobs.find((job) => job.node_id === recurringNode.id).status = 'completed';
recurringState.projects[0].title = '版本 B';
reconcileContextProjectionState(recurringState, {
  sourceCollections: ['projects'],
  timestamp: '2026-07-26T02:01:00.000Z'
});
const sourceHashB = recurringNode.source_hash;
assert.notEqual(sourceHashB, sourceHashA);
recurringState.context_document_versions.push({
  id: 'version-b',
  node_id: recurringNode.id,
  source_hash: sourceHashB,
  version: 2,
  created_at: '2026-07-26T02:01:00.000Z'
});
recurringNode.current_version_id = 'version-b';
recurringState.context_projection_jobs.find(
  (job) => job.node_id === recurringNode.id && job.expected_source_hash === sourceHashB
).status = 'completed';
recurringState.projects[0].title = '版本 A';
reconcileContextProjectionState(recurringState, {
  sourceCollections: ['projects'],
  timestamp: '2026-07-26T02:02:00.000Z'
});
assert.equal(recurringNode.source_hash, sourceHashA);
assert.equal(recurringNode.current_version_id, 'version-a');

const relationState = { projects: [{ id: 'project-relations', title: '关系项目' }], workflows: [] };
reconcileContextProjectionState(relationState, {
  sourceCollections: ['projects', 'workflows'],
  timestamp: '2026-07-26T03:00:00.000Z'
});
const relationProject = relationState.context_nodes.find(
  (node) => node.source_collection === 'projects' && node.source_id === 'project-relations'
);
const relationHashBefore = relationProject.source_hash;
relationState.context_document_versions.push({
  id: 'version-relations-before',
  node_id: relationProject.id,
  source_hash: relationHashBefore,
  version: 1,
  created_at: '2026-07-26T03:00:00.000Z'
});
relationProject.current_version_id = 'version-relations-before';
relationState.context_projection_jobs.find((job) => job.node_id === relationProject.id).status = 'completed';
relationState.workflows.push({
  id: 'workflow-related',
  project_id: 'project-relations',
  title: '新增工作流'
});
reconcileContextProjectionState(relationState, {
  sourceCollections: ['projects', 'workflows'],
  timestamp: '2026-07-26T03:01:00.000Z'
});
assert.notEqual(
  relationProject.source_hash,
  relationHashBefore,
  'canonical relation changes must invalidate the document projection hash'
);
assert.ok(
  relationState.context_projection_jobs.some(
    (job) =>
      job.node_id === relationProject.id &&
      job.expected_source_hash === relationProject.source_hash &&
      job.status === 'pending'
  )
);

const retryState = { projects: [{ id: 'project-retry', title: '重试项目' }] };
reconcileContextProjectionState(retryState, {
  sourceCollections: ['projects'],
  timestamp: '2026-07-26T03:10:00.000Z'
});
const retryNode = retryState.context_nodes.find(
    (node) => node.source_collection === 'projects' && node.source_id === 'project-retry'
  ),
  retryJob = retryState.context_projection_jobs.find((job) => job.node_id === retryNode.id);
Object.assign(retryJob, {
  status: 'failed',
  attempts: 1,
  error_code: 'context_projection_test_failure',
  next_retry_at: '2999-01-01T00:00:00.000Z'
});
reconcileContextProjectionState(retryState, {
  sourceCollections: ['projects'],
  timestamp: '2026-07-26T03:11:00.000Z'
});
assert.equal(retryJob.status, 'failed', 'reconciliation must preserve a same-source failed job');
assert.equal(retryJob.error_code, 'context_projection_test_failure');
const deferredRetry = await materializeContextDocumentsInState(retryState, { nodeIds: [retryNode.id] });
assert.equal(deferredRetry.attempted, 0, 'projection retry must honor next_retry_at');
retryJob.attempts = 3;
retryJob.next_retry_at = '2000-01-01T00:00:00.000Z';
const exhaustedRetry = await materializeContextDocumentsInState(retryState, { nodeIds: [retryNode.id] });
assert.equal(exhaustedRetry.attempted, 0, 'projection retry must stop after three attempts');

const recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-context-recovery-'));
try {
  const recoveryState = ensureContextCollections({}),
    recoveryNode = {
      id: 'ctx-recovery',
      uri: 'aiws://context/nodes/ctx-recovery',
      kind: 'record',
      source_type: 'projection',
      source_collection: null,
      source_id: null,
      source_version: 1,
      project_id: null,
      parent_id: null,
      title: '恢复投影任务',
      deterministic_summary: '验证崩溃后的 running 任务可重试。',
      sensitivity: 'internal',
      required_scopes: ['context:read'],
      freshness: { status: 'current' },
      authority: 'authoritative',
      status: 'active',
      source_hash: contextHash('recovery-source'),
      current_version_id: null
    };
  recoveryState.context_nodes.push(recoveryNode);
  recoveryState.context_projection_jobs.push({
    id: 'ctxjob-recovery',
    node_id: recoveryNode.id,
    expected_source_hash: recoveryNode.source_hash,
    status: 'running',
    attempts: 0,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z'
  });
  const recovered = await materializeContextDocumentsInState(recoveryState, { casRoot: recoveryRoot });
  assert.equal(recovered.materialized, 1);
  assert.equal(recoveryState.context_projection_jobs[0].status, 'completed');
  assert.ok(recoveryNode.current_version_id);
} finally {
  await fs.rm(recoveryRoot, { recursive: true, force: true });
}

const contextReadScopeState = {
  context_nodes: [
    {
      id: 'ctx_scope_guard',
      uri: 'aiws://context/nodes/ctx_scope_guard',
      kind: 'record',
      project_id: 'project-scope-guard',
      parent_id: null,
      source_hash: 'a'.repeat(64),
      current_version_id: 'ctxv_scope_guard',
      status: 'active',
      sensitivity: 'internal',
      required_scopes: ['context:read', 'project:read'],
      freshness: { status: 'current' },
      authority: 'authoritative',
      sort: { type_order: 120, order_index: 0, stable_id: 'ctx_scope_guard' }
    }
  ],
  context_document_versions: [
    {
      id: 'ctxv_scope_guard',
      node_id: 'ctx_scope_guard',
      source_hash: 'a'.repeat(64),
      content_sha256: 'b'.repeat(64),
      token_estimate: 10
    }
  ],
  context_edges: [],
  context_selections: [],
  context_policies: [],
  context_projection_jobs: [],
  context_summaries: []
};
const missingContextReadSelection = createContextSelection(contextReadScopeState, {
  id: 'selection-missing-context-read',
  actorId: 'actor-scope-guard',
  projectId: 'project-scope-guard',
  candidateNodeIds: ['ctx_scope_guard'],
  scopes: ['project:read'],
  allowedProjectIds: ['project-scope-guard']
});
assert.equal(missingContextReadSelection.included.length, 0);
assert.equal(missingContextReadSelection.excluded[0]?.reason, 'permission_denied');
const unauthorizedStaleState = structuredClone(contextReadScopeState);
unauthorizedStaleState.context_nodes[0].freshness.status = 'stale';
const unauthorizedStaleSelection = createContextSelection(unauthorizedStaleState, {
  id: 'selection-unauthorized-stale',
  actorId: 'actor-scope-guard',
  projectId: 'project-scope-guard',
  candidateNodeIds: ['ctx_scope_guard'],
  scopes: ['project:read'],
  allowedProjectIds: ['project-scope-guard']
});
assert.equal(unauthorizedStaleSelection.excluded[0]?.reason, 'permission_denied');
const completeScopeSelection = createContextSelection(contextReadScopeState, {
  id: 'selection-complete-scopes',
  actorId: 'actor-scope-guard',
  projectId: 'project-scope-guard',
  candidateNodeIds: ['ctx_scope_guard'],
  scopes: ['context:read', 'project:read'],
  allowedProjectIds: ['project-scope-guard']
});
assert.equal(completeScopeSelection.included.length, 1);

console.log('V2.0 system context protocol unit tests passed');

function selectionFixture() {
  const value = ensureContextCollections({});
  value.context_nodes.push(
    selectableNode('allowed'),
    selectableNode('foreign', { project_id: 'project-2' }),
    selectableNode('secret', { sensitivity: 'secret' }),
    selectableNode('stale', { freshness: { status: 'stale' } }),
    selectableNode('excluded'),
    selectableNode('oversized'),
    selectableNode('missing-scope', { required_scopes: ['context:read', 'assets:read'] })
  );
  for (const node of value.context_nodes) {
    const version = selectableVersion(node.id, node.id === 'oversized' ? 20 : 4);
    value.context_document_versions.push(version);
    node.current_version_id = version.id;
  }
  value.context_policies.push({
    id: 'policy-1',
    actor_id: 'user-1',
    session_id: null,
    project_id: 'project-1',
    pinned_node_ids: ['foreign'],
    excluded_node_ids: ['excluded']
  });
  return value;
}

function selectableNode(id, patch = {}) {
  const sourceHash = contextHash({ id });
  return {
    id,
    uri: `aiws://context/nodes/${id}`,
    kind: 'record',
    project_id: 'project-1',
    status: 'active',
    sensitivity: 'internal',
    freshness: { status: 'current' },
    authority: 'authoritative',
    required_scopes: ['context:read', 'project:read'],
    source_hash: sourceHash,
    sort: { type_order: 120, order_index: 0, stable_id: id },
    ...patch
  };
}

function selectableVersion(nodeId, tokens) {
  const hash = contextHash(nodeId);
  return {
    id: `version-${nodeId}`,
    node_id: nodeId,
    source_hash: contextHash({ id: nodeId }),
    content_sha256: hash,
    token_estimate: tokens
  };
}

function versionForRetention(id, createdAt, retainedUntil = null) {
  return { id, created_at: createdAt, retained_until: retainedUntil };
}

function bareNode(id, parentId) {
  return {
    id,
    uri: `aiws://context/nodes/${id}`,
    parent_id: parentId,
    sensitivity: 'internal'
  };
}

function contains(source, target) {
  return {
    id: `edge-${source}-${target}`,
    type: 'contains',
    source_node_id: source,
    target_node_id: target
  };
}

function code(expected) {
  return (error) => error?.code === expected;
}
