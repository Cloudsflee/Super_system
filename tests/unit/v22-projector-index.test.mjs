import assert from 'node:assert/strict';

import {
  contextSearchIndexSnapshotHash,
  createContextSearchIndex,
  serializeContextSearchIndex
} from '../../packages/system-context/src/index.mjs';
import { finalizeClaimedContextProjectionsInState } from '../../apps/api/src/context-projection.mjs';

const node = {
    id: 'node-a',
    title: 'Node A',
    deterministic_summary: 'Summary',
    project_id: 'project-a',
    kind: 'record',
    uri: 'aiws://context/nodes/node-a',
    parent_id: null,
    status: 'active',
    sensitivity: 'internal',
    source_hash: 'a'.repeat(64),
    source_generation: 3,
    current_version_id: 'version-a'
  },
  version = { id: 'version-a', node_id: node.id, content_sha256: 'b'.repeat(64) },
  edge = { id: 'edge-a', type: 'contains', source_node_id: 'root', target_node_id: node.id, order_index: 0 },
  rootNode = {
    ...node,
    id: 'root',
    title: 'Root',
    uri: 'aiws://context/nodes/root',
    project_id: null,
    current_version_id: 'version-root'
  },
  rootVersion = { id: 'version-root', node_id: rootNode.id, content_sha256: 'c'.repeat(64) },
  snapshot = (nodes, versions, edges) => contextSearchIndexSnapshotHash({ nodes, documentVersions: versions, edges });

const first = snapshot([node, rootNode], [version, rootVersion], [edge]),
  reordered = snapshot([rootNode, node], [rootVersion, version], [edge]);
assert.equal(first, reordered);
assert.notEqual(first, snapshot([{ ...node, title: 'Changed' }, rootNode], [version, rootVersion], [edge]));
assert.notEqual(
  first,
  snapshot([node, rootNode], [{ ...version, content_sha256: 'd'.repeat(64) }, rootVersion], [edge])
);
assert.notEqual(first, snapshot([node, rootNode], [version, rootVersion], [{ ...edge, type: 'depends_on' }]));

const payload = serializeContextSearchIndex(createContextSearchIndex([]), { snapshotHash: first });
assert.equal(payload.schema_version, 'aiws.context_index.v2');
assert.equal(Object.hasOwn(payload, 'rebuilt_at'), false);

const state = {
  context_nodes: [{ ...node, source_hash: 'e'.repeat(64), source_generation: 5, current_version_id: null }],
  context_document_versions: [],
  context_projection_jobs: [
    {
      id: 'job-a',
      node_id: node.id,
      expected_source_hash: 'a'.repeat(64),
      expected_source_generation: 3,
      status: 'running',
      attempts: 1,
      lease: { holder: 'worker-a' }
    }
  ]
};
const finalized = finalizeClaimedContextProjectionsInState(state, {
  holder: 'worker-a',
  timestamp: '2026-07-31T00:00:00.000Z',
  artifacts: [
    {
      job_id: 'job-a',
      node_id: node.id,
      expected_source_hash: 'a'.repeat(64),
      expected_source_generation: 3,
      version: { id: 'stale-version', node_id: node.id, immutable: true }
    }
  ]
});
assert.equal(finalized.superseded, 1);
assert.equal(state.context_document_versions.length, 0);
assert.equal(state.context_projection_jobs[0].status, 'superseded');

console.log('V2.2 deterministic Context index and A-B-A projection finalization tests passed');
