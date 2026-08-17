import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashJson } from '../../apps/api/src/crypto.mjs';
import { ContextAdapterRegistry, allowlistedRecordJson, record } from '../../apps/api/src/modules/context/adapters.mjs';
import { buildIndex, indexFile, loadIndex, readIndexPayload, searchIndex, serializeIndex, writeIndexAtomic } from '../../apps/api/src/modules/context/index-runtime.mjs';
import { buildContextPack } from '../../apps/api/src/modules/context/pack.mjs';
import { ContextProjectionWorker } from '../../apps/api/src/modules/context/projection-worker.mjs';
import { createSelection, normalizePolicy } from '../../apps/api/src/modules/context/selection.mjs';
import { fixture, eventually, mutate, request } from './helpers.mjs';

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

test('R5 Context projection preserves versions, rebuilds damaged indexes, and exposes durable cursors', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'R5 context projection' }, 'r5-context-project');
    const source = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/sources`, { kind: 'note', title: 'Versioned note', content: 'version one content' }, 'r5-context-source');
    const first = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'r5-context-rebuild-one');
    assert.equal(first.response.status, 201);
    const firstNode = first.json.map.nodes.find((node) => node.source_id === source.json.id);
    assert.ok(firstNode?.current_document_version_id);
    const firstVersion = firstNode.current_document_version_id;
    const before = Number((await env.app.database.get('SELECT count(*) AS count FROM context_document_versions WHERE node_id=?', [firstNode.id])).count);

    const changed = 'version two content';
    await env.app.database.run('UPDATE context_sources SET content=?,content_hash=? WHERE id=?', [changed, digest(changed), source.json.id]);
    const second = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'r5-context-rebuild-two');
    const secondNode = second.json.map.nodes.find((node) => node.source_id === source.json.id);
    assert.notEqual(secondNode.current_document_version_id, firstVersion);
    assert.equal(Number((await env.app.database.get('SELECT count(*) AS count FROM context_document_versions WHERE node_id=?', [firstNode.id])).count), before + 1);

    const original = 'version one content';
    await env.app.database.run('UPDATE context_sources SET content=?,content_hash=? WHERE id=?', [original, digest(original), source.json.id]);
    const restored = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'r5-context-rebuild-three');
    const restoredNode = restored.json.map.nodes.find((node) => node.source_id === source.json.id);
    assert.equal(restoredNode.current_document_version_id, firstVersion);
    assert.equal(Number((await env.app.database.get('SELECT count(*) AS count FROM context_document_versions WHERE node_id=?', [firstNode.id])).count), before + 1);

    const indexFile = path.join(env.home, 'context-index', `${encodeURIComponent(project.json.id)}.json`);
    fs.writeFileSync(indexFile, '{ damaged index');
    const rebuiltSearch = await request(env.base, `/api/v1/projects/${project.json.id}/context/search?q=version`);
    assert.equal(rebuiltSearch.response.status, 200);
    assert.ok(rebuiltSearch.json.some((row) => row.node_id === firstNode.id));
    const events = await request(env.base, `/api/v1/projects/${project.json.id}/context/jobs/${restored.json.job.id}/events?after=0`);
    assert.equal(events.response.status, 200);
    assert.ok(events.json.length >= 3);
    assert.deepEqual(events.json.map((event) => event.cursor), events.json.map((event) => event.cursor).toSorted((a, b) => a - b));

    const versionRow = await env.app.database.get('SELECT cas_path FROM context_document_versions WHERE id=?', [firstVersion]);
    const casFile = path.join(env.home, 'cas', ...String(versionRow.cas_path).split('/').slice(-2));
    const casBytes = fs.readFileSync(casFile);
    fs.rmSync(casFile);
    const unavailable = await request(env.base, `/api/v1/projects/${project.json.id}/context/nodes/${firstNode.id}`);
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.json.error.code, 'context_projection_unavailable');
    fs.mkdirSync(path.dirname(casFile), { recursive: true });
    fs.writeFileSync(casFile, casBytes);

    const cancelJob = 'cpj_r5_cancel';
    const future = new Date(Date.now() + 10_000).toISOString();
    await env.app.database.run('INSERT INTO context_projection_jobs(id,project_id,status,cursor,created_at,updated_at) VALUES(?,?,?,?,?,?)', [cancelJob, project.json.id, 'queued', '', future, future]);
    const cancelled = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/jobs/${cancelJob}/cancel`, { expected_revision: 1 }, 'r5-context-cancel');
    assert.equal(cancelled.response.status, 202);
    assert.equal(cancelled.json.status, 'cancelled');
    const retried = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/jobs/${cancelJob}/retry`, { expected_revision: 2 }, 'r5-context-retry');
    assert.equal(retried.response.status, 202);
    const operation = await eventually(async () => (await request(env.base, `/api/v1/operations/${retried.json.operation_id}`)).json, (value) => ['completed', 'failed', 'cancelled'].includes(value.status), 10_000);
    assert.equal(operation.status, 'completed');
    const retryJob = await request(env.base, `/api/v1/projects/${project.json.id}/context/jobs/${retried.json.resource_id}`);
    assert.equal(retryJob.json.retry_of_job_id, cancelJob);
    assert.equal(retryJob.json.attempt, 2);

    const driftJob = 'cpj_r5_drift';
    await env.app.database.run('INSERT INTO context_projection_jobs(id,project_id,status,cursor,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [driftJob, project.json.id, 'running', '0', 'f'.repeat(64), future, future]);
    await env.app.domain.recover();
    const drift = await request(env.base, `/api/v1/projects/${project.json.id}/context/jobs/${driftJob}`);
    assert.equal(drift.json.status, 'failed');
    assert.equal(drift.json.error_code, 'context_projection_inputs_changed');
  } finally { await env.close(); }
});

test('R5 selection, Pack, and index helpers cover policy denials and compatibility defaults', () => {
  const projectId = 'prj_branch_fixture';
  const makeNode = (id, overrides = {}) => ({
    id, project_id: projectId, uri: `aiws://context/${projectId}/note/${id}`, title: id,
    kind: 'note', status: 'active', sensitivity: 'normal', authority: 'observed',
    required_scopes: ['context:read'], freshness: { status: 'current' },
    current_document_version_id: `ver_${id}`, ...overrides
  });
  const nodes = [
    makeNode('pin'), makeNode('explicit'), makeNode('anchor'), makeNode('budget'),
    makeNode('scope', { required_scopes: ['context:read', 'files:read'] }),
    makeNode('cross', { project_id: 'prj_other' }), makeNode('secret', { sensitivity: 'secret' }),
    makeNode('internal', { sensitivity: 'internal' }), makeNode('tombstone', { status: 'tombstone' }),
    makeNode('old', { freshness: { status: 'stale' } }), makeNode('excluded'), makeNode('missing')
  ];
  const versions = nodes.filter((node) => node.id !== 'missing').map((node) => ({
    id: node.current_document_version_id, node_id: node.id, version: 1,
    content_hash: createHash('sha256').update(node.id).digest('hex'),
    token_estimate: node.id === 'budget' ? 9 : 1,
    content: node.id
  }));
  const selection = createSelection({
    id: 'csel_branches', projectId, nodes, versions,
    policy: {
      pinned: ['pin'], excluded: ['excluded'], allowed_project_ids: [projectId],
      required_scopes: ['context:read'], sensitivity_max: 'normal', freshness: 'current'
    },
    explicitNodeIds: ['explicit'], anchorNodeId: 'anchor', mandatoryNodeIds: ['pin', 'missing'],
    tokenBudget: 3, query: 'explicit', retrievalPlan: { source: 'branch-fixture' },
    timestamp: '2026-08-16T00:00:00.000Z'
  });
  assert.deepEqual(new Set(selection.included.map((item) => item.reason)), new Set(['user_pinned', 'explicit_reference', 'current_anchor']));
  assert.deepEqual(selection.mandatory_evidence.covered_node_ids, ['pin']);
  assert.deepEqual(selection.mandatory_evidence.missing_node_ids, ['missing']);
  const reasons = new Map(selection.excluded.map((item) => [item.node_id, item.reason]));
  assert.equal(reasons.get('scope'), 'permission_denied');
  assert.equal(reasons.get('cross'), 'permission_denied');
  assert.equal(reasons.get('secret'), 'sensitive');
  assert.equal(reasons.get('internal'), 'sensitive');
  assert.equal(reasons.get('tombstone'), 'stale');
  assert.equal(reasons.get('old'), 'stale');
  assert.equal(reasons.get('excluded'), 'user_excluded');
  assert.equal(reasons.get('missing'), 'stale');
  assert.equal(reasons.get('budget'), 'budget_exceeded');

  const crossScope = createSelection({
    id: 'csel_cross_scope', projectId, nodes: [makeNode('other', { project_id: 'prj_other' })],
    versions: [{ id: 'ver_other', node_id: 'other', content_hash: 'a'.repeat(64), token_estimate: 0, content: 'fallback token estimate' }]
  });
  assert.equal(crossScope.excluded[0].reason, 'cross_scope');
  assert.throws(() => normalizePolicy({ pinned_node_ids: ['same'], excluded_node_ids: ['same'] }), /context_policy_conflict/);
  assert.deepEqual(normalizePolicy({ pinned: 'invalid', excluded: null }).pinned_node_ids, []);
  assert.equal(createSelection().retrieval_plan.strategy, 'minisearch_deterministic');

  const defaultPack = buildContextPack({ projectId });
  assert.equal(defaultPack.id, null);
  assert.equal(defaultPack.brief_snapshot, null);
  assert.equal(defaultPack.repository_snapshot, null);
  assert.equal(defaultPack.workflow_snapshot, null);
  assert.equal(defaultPack.retrieval_plan.strategy, 'explicit');
  const richPack = buildContextPack({
    id: 'pack_branches', projectId, selection,
    documents: [{ node_id: 'pin', document_version_id: 'ver_pin', content_hash: 'b'.repeat(64), token_estimate: 0 }],
    brief: {}, repository: {},
    workflow: { revision: 2, tasks: [{ id: 'pin', outputs: ['report.json', null], acceptance: ['done'] }] },
    contracts: [
      { node_id: 'pin', contract: { outputs: [{ selector: 'artifact://report' }], output_slots: [{ name: 'slot.json' }], acceptance: ['done'] } },
      { node_id: 'contract-only', contract: { outputs: [{ name: 'extra.json' }], acceptance: ['verified'] } }
    ],
    legacySources: [{ id: 'src_legacy', title: 'Legacy', path: '', content: 'legacy' }]
  });
  assert.equal(richPack.sources[0].id, 'src_legacy');
  assert.equal(richPack.memory_manifest.workflow_revision, 2);

  const indexNodes = [
    makeNode('pin'),
    makeNode('no-version', { current_document_version_id: null, title: '', uri: '' }),
    makeNode('index-secret', { sensitivity: 'secret' }),
    makeNode('index-tombstone', { status: 'tombstone' })
  ];
  const indexVersions = [{ id: 'ver_pin', node_id: 'pin', content_hash: 'c'.repeat(64), content: 'searchable architecture' }];
  const indexed = buildIndex({
    nodes: indexNodes,
    versions: indexVersions,
    edges: [
      { parent_id: 'pin', child_id: 'no-version', relation: '', order_index: 0 },
      { parent_id: 'index-secret', child_id: 'pin', relation: 'contains', order_index: 1 }
    ]
  });
  assert.equal(indexed.documents.length, 1);
  assert.deepEqual(searchIndex(indexed.index, ''), []);
  assert.equal(searchIndex(indexed.index, 'arch')[0].node_id, 'pin');
  assert.equal(searchIndex(indexed.index, 'architecture')[0].node_id, 'pin');
  const payload = serializeIndex(indexed.index, { snapshotHash: indexed.snapshotHash });
  assert.ok(loadIndex({ ...payload, index_hash: '' }));
  assert.throws(() => loadIndex(null), /context_index_schema_invalid/);
  assert.throws(() => loadIndex({ ...payload, schema_version: 'wrong' }), /context_index_schema_invalid/);
  assert.throws(() => loadIndex({ ...payload, tokenizer_version: 'wrong' }), /context_index_schema_invalid/);
  assert.throws(() => loadIndex({ ...payload, index_options_version: 'wrong' }), /context_index_schema_invalid/);
  assert.throws(() => loadIndex({ ...payload, index: null }), /context_index_schema_invalid/);
  assert.throws(() => loadIndex({ ...payload, index_hash: 'f'.repeat(64) }), /context_index_hash_mismatch/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r5-index-branches-'));
  try {
    const file = indexFile(directory, 'project / branch');
    writeIndexAtomic(file, payload);
    assert.equal(readIndexPayload(file).snapshot_hash, indexed.snapshotHash);
    fs.writeFileSync(file, '{bad json');
    assert.equal(readIndexPayload(file), null);
    assert.equal(readIndexPayload(path.join(directory, 'missing.json')), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('R5 adapters and projection worker preserve allowlists across terminal branches', async () => {
  const projectId = 'prj_adapter_fixture';
  const store = {
    projectProjection: async () => ({ id: projectId, name: 'Adapter fixture', revision: 0, status: 'active', secret: 'excluded' }),
    briefProjection: async () => ({ revision: 1, content_json: '{bad', content_hash: 'a'.repeat(64) }),
    repositoryProjection: async () => ({ id: 'repo_fixture', revision: 0, remote_url: '', source_kind: '', status: '' }),
    workflowProjection: async () => ({ revision: 1, name: '', hierarchy_mode: '', tasks_json: JSON.stringify([{ id: 'task', title: 'Task' }]) }),
    contractProjections: async () => [{ workflow_revision: 1, node_id: 'task', revision: 1, contract_json: '', contract_hash: 'b'.repeat(64) }],
    sourceProjections: async () => [
      { id: 'src_note', created_at: 'now', title: 'Note', kind: 'note', content: 'body', path: '', content_hash: 'c'.repeat(64) },
      { id: 'src_image', created_at: 'now', title: 'Image', kind: 'image', content: '', path: 'image.png', content_hash: 'd'.repeat(64) }
    ]
  };
  const adapters = new ContextAdapterRegistry({ repository: store, projectWorkspace: async () => { throw new Error('workspace_missing'); } });
  assert.throws(() => adapters.register('X', () => null), /context_adapter_invalid/);
  assert.throws(() => adapters.register('valid_name', null), /context_adapter_invalid/);
  adapters.register('custom', async () => [
    record({ project_id: projectId, source_type: 'custom', source_id: 'one', content: 'one' }),
    record({ project_id: 'prj_other', source_type: 'custom', source_id: 'other', content: 'other' })
  ]);
  adapters.register('single', async () => record({ project_id: projectId, source_type: 'single', source_id: 'one' }));
  const custom = await adapters.collect(projectId, { adapters: ['missing', 'custom', 'single'] });
  assert.deepEqual(custom.map((item) => item.source_type), ['custom', 'single']);
  const projected = await adapters.collect(projectId);
  assert.ok(projected.some((item) => item.source_type === 'project'));
  assert.ok(projected.some((item) => item.source_type === 'repository_manifest'));
  assert.ok(projected.some((item) => item.source_id === 'src_image' && item.sensitivity === 'internal'));
  const filteredSources = await adapters.sources(projectId, { sourceIds: ['src_note'] });
  assert.deepEqual(filteredSources.map((item) => item.source_id), ['src_note']);
  const minimal = record({ project_id: 1, source_type: 'minimal', source_id: 'source', required_scopes: null, sensitivity: 'unknown', resource: 'invalid' });
  assert.equal(minimal.kind, 'record');
  assert.equal(minimal.sensitivity, 'normal');
  assert.equal(JSON.parse(allowlistedRecordJson(minimal)).content, undefined);
  const emptyAdapters = new ContextAdapterRegistry({
    repository: {
      projectProjection: async () => null, briefProjection: async () => null,
      repositoryProjection: async () => null, workflowProjection: async () => null,
      contractProjections: async () => [], sourceProjections: async () => []
    }
  });
  assert.deepEqual(await emptyAdapters.collect(projectId), []);

  const records = [record({ project_id: projectId, source_type: 'note', source_id: 'worker', source_revision: '1', content: 'worker' })];
  const inputHash = hashJson(records.map((item) => [item.source_type, item.source_id, item.source_revision, item.source_hash]));
  const transitions = [];
  const failures = [];
  const repository = {
    currentJob: { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: '' },
    job() { return this.currentJob; },
    async transitionProjection(value) { transitions.push(value); },
    async completeProjection(value) { transitions.push(value); },
    async failProjection(value) { failures.push(value); }
  };
  const project = {
    async result(jobId) { return { id: jobId, status: 'completed' }; },
    async projectRecords() { return { nodes: [{ id: 'node' }], versions: [], edges: [], stats: { source_count: 1 } }; }
  };
  const worker = new ContextProjectionWorker({
    repository, adapters: { collect: async () => records }, project,
    indexer: { rebuild: async () => ({ documents: [], snapshotHash: 'a'.repeat(64), indexHash: 'b'.repeat(64) }) }, cas: null
  });
  repository.currentJob = null;
  await assert.rejects(() => worker.run('job', projectId), (error) => error.code === 'not_found');
  repository.currentJob = { id: 'job', project_id: projectId, status: 'completed', revision: 2 };
  assert.equal((await worker.run('job', projectId)).status, 'completed');
  repository.currentJob = { id: 'job', project_id: projectId, status: 'cancelled', revision: 2 };
  await assert.rejects(() => worker.run('job', projectId), (error) => error.code === 'operation_cancelled');
  repository.currentJob = { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: '' };
  await assert.rejects(() => worker.run('job', projectId, { expectedInputHash: 'wrong' }), (error) => error.code === 'context_projection_inputs_changed');
  repository.currentJob = { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: 'wrong' };
  await assert.rejects(() => worker.run('job', projectId), (error) => error.code === 'context_projection_inputs_changed');

  repository.currentJob = { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: inputHash };
  await assert.rejects(() => worker.run('job', projectId, { signal: { aborted: true } }), (error) => error.code === 'operation_cancelled');
  assert.equal(failures.at(-1).status, 'cancelled');
  let abortReads = 0;
  const delayedAbort = { get aborted() { abortReads += 1; return abortReads > 1; } };
  repository.currentJob = { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: inputHash };
  await assert.rejects(() => worker.run('job', projectId, { signal: delayedAbort }), (error) => error.code === 'operation_cancelled');
  assert.equal(failures.at(-1).status, 'cancelled');
  const originalProjectRecords = project.projectRecords;
  project.projectRecords = async () => { throw new Error('projection_failed'); };
  repository.currentJob = { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: inputHash };
  await assert.rejects(() => worker.run('job', projectId), /projection_failed/);
  assert.equal(failures.at(-1).status, 'failed');
  project.projectRecords = originalProjectRecords;
  repository.currentJob = { id: 'job', project_id: projectId, status: 'queued', revision: 1, input_hash: inputHash };
  assert.equal((await worker.run('job', projectId, { expectedInputHash: inputHash })).status, 'completed');
  assert.ok(transitions.some((item) => item.status === 'running'));
  assert.ok(transitions.some((item) => item.status === 'indexing'));
});
