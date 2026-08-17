import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSelection } from '../../apps/api/src/modules/context/selection.mjs';
import { buildContextPack } from '../../apps/api/src/modules/context/pack.mjs';
import { buildIndex, loadIndex, searchIndex, serializeIndex, writeIndexAtomic } from '../../apps/api/src/modules/context/index-runtime.mjs';

function node(id, kind, overrides = {}) {
  return { id, project_id: 'prj_fixture', uri: `aiws://context/prj_fixture/${kind}/${id}`, title: id, kind, status: 'active', sensitivity: 'normal', authority: 'observed', required_scopes: ['context:read'], freshness: { status: 'current' }, current_document_version_id: `ver_${id}`, ...overrides };
}

function version(id, content, overrides = {}) {
  return { id: `ver_${id}`, node_id: id, version: 1, content_hash: `${id}`.padEnd(64, '0').slice(0, 64), token_estimate: Math.ceil(content.length / 4), content, ...overrides };
}

test('R5 selection filters policy before deterministic pin, rank, type, and id ordering', () => {
  const nodes = [node('n-note', 'note'), node('b-brief', 'brief'), node('a-project', 'project'), node('x-secret', 'note', { sensitivity: 'secret' }), node('z-excluded', 'note')];
  const versions = nodes.map((item) => version(item.id, `${item.id} content`));
  const selection = createSelection({
    id: 'sel_fixture', projectId: 'prj_fixture', nodes, versions,
    policy: { excluded_node_ids: ['z-excluded'], sensitivity_max: 'normal' },
    query: '', tokenBudget: 1000, timestamp: '2026-08-16T00:00:00.000Z'
  });
  assert.deepEqual(selection.included.map((item) => item.node_id), ['a-project', 'b-brief', 'n-note']);
  assert.deepEqual(selection.excluded.map((item) => [item.node_id, item.reason]), [['x-secret', 'sensitive'], ['z-excluded', 'user_excluded']]);
  assert.match(selection.selection_hash, /^[a-f0-9]{64}$/);
  assert.equal(selection.retrieval_plan.token_budget, 1000);
});

test('R5 Context Pack hashes normalized workflow contracts without executing outcome scoring', () => {
  const selection = {
    id: 'sel_pack', selection_hash: 'a'.repeat(64), policy_revision: 3,
    retrieval_plan: { strategy: 'minisearch_deterministic', token_budget: 500 },
    included: [{ node_id: 'n1', document_version_id: 'ver_n1', token_estimate: 2, reason: 'search_rank' }],
    excluded: []
  };
  const pack = buildContextPack({
    id: 'pack_fixture', projectId: 'prj_fixture', selection,
    documents: [{ node_id: 'n1', document_version_id: 'ver_n1', content_hash: 'b'.repeat(64), token_estimate: 2, content: 'fixture' }],
    brief: { revision: 2, content_hash: 'c'.repeat(64), content: { objective: 'fixture' } },
    repository: { revision: 4, head_sha: 'd'.repeat(40), status: 'ready' },
    workflow: { revision: 5, name: 'Fixture workflow', tasks: [{ id: 'n1', outputs: ['out.json'], acceptance: ['output exists'] }] },
    contracts: [{ node_id: 'n1', contract: { outputs: [{ name: 'report.json' }], acceptance: ['report valid'] } }],
    timestamp: '2026-08-16T00:00:00.000Z'
  });
  assert.equal(pack.schema_version, 'aiws.context_pack.v5');
  assert.equal(pack.memory_manifest.workflow_revision, 5);
  assert.deepEqual(pack.memory_manifest.document_version_ids, ['ver_n1']);
  assert.match(pack.outcome_contract_hash, /^[a-f0-9]{64}$/);
  assert.match(pack.quality_rubric_hash, /^[a-f0-9]{64}$/);
  assert.match(pack.pack_hash, /^[a-f0-9]{64}$/);
  assert.equal(pack.quality_rubric_hash, buildContextPack({
    id: 'pack_fixture_2', projectId: 'prj_fixture', selection,
    documents: [{ node_id: 'n1', document_version_id: 'ver_n1', content_hash: 'b'.repeat(64), token_estimate: 2, content: 'fixture' }],
    brief: { revision: 2, content_hash: 'c'.repeat(64), content: { objective: 'fixture' } },
    repository: { revision: 4, head_sha: 'd'.repeat(40), status: 'ready' },
    workflow: { revision: 5, name: 'Fixture workflow', tasks: [{ id: 'n1', outputs: ['out.json'], acceptance: ['output exists'] }] },
    contracts: [{ node_id: 'n1', contract: { acceptance: ['report valid'], outputs: [{ name: 'report.json' }] } }],
    timestamp: '2026-08-16T00:00:01.000Z'
  }).quality_rubric_hash);
});

test('R5 MiniSearch snapshot is deterministic, atomic, and rejects tampering', () => {
  const built = buildIndex({
    nodes: [node('n1', 'note'), node('n2', 'brief')],
    versions: [version('n1', 'CAS-backed architecture signal'), version('n2', 'confirmed brief')],
    edges: [{ parent_id: 'n1', child_id: 'n2', relation: 'contains', order_index: 0 }]
  });
  const payload = serializeIndex(built.index, { snapshotHash: built.snapshotHash, indexHash: built.indexHash, rebuiltAt: '2026-08-16T00:00:00.000Z' });
  const loaded = loadIndex(payload);
  assert.equal(searchIndex(loaded, 'architecture')[0].node_id, 'n1');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-context-index-'));
  try {
    const file = path.join(home, 'index.json');
    writeIndexAtomic(file, payload);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).snapshot_hash, built.snapshotHash);
    assert.throws(() => loadIndex({ ...payload, index_hash: 'f'.repeat(64) }), /context_index_hash_mismatch/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
