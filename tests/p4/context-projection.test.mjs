import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { close, closeServer, listen, open, project } from './helpers.mjs';

test('Context projection is deterministic, budgeted, CAS-backed and pack snapshots reject drift', async () => {
  const state = await open();
  try {
    const current = await project(state, 'context');
    const first = await state.runtime.context.createSource(current.id, {
      kind: 'note', title: 'Architecture', uri: 'notes/architecture', content: 'dispatcher ledger projection',
      source_revision: 'r1', idempotency_key: 'p4-context-source-first'
    }, state.principal);
    await state.runtime.context.createSource(current.id, {
      kind: 'note', title: 'Restricted plan', uri: 'notes/restricted', content: 'restricted evidence',
      sensitivity: 'restricted', source_revision: 'r1', idempotency_key: 'p4-context-source-second'
    }, state.principal);
    const secret = await state.runtime.context.createSource(current.id, {
      kind: 'note', title: 'Excluded source', uri: 'notes/excluded', content: 'private fixture value',
      sensitivity: 'secret', source_revision: 'r1', idempotency_key: 'p4-context-source-secret'
    }, state.principal);

    const hashes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await state.runtime.context.rebuild(current.id, { mode: 'full', idempotency_key: `p4-context-rebuild-${attempt}` }, state.principal);
      const status = state.runtime.context.status(current.id, state.principal);
      assert.equal(status.status, 'completed');
      hashes.push([status.snapshot_hash, status.index_hash]);
    }
    assert.deepEqual(hashes[1], hashes[0]);
    assert.deepEqual(hashes[2], hashes[0]);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM context_document_versions').count, 4);

    const map = state.runtime.context.map(current.id, state.principal);
    assert.equal(map.index.status, 'ready');
    assert.equal(map.nodes.some((node) => node.kind === 'project'), true);
    assert.deepEqual(map.nodes.map((node) => node.uri), [...map.nodes.map((node) => node.uri)].sort());
    assert.equal(state.runtime.context.search(current.id, state.principal, 'private').length, 0);
    assert.equal(state.runtime.context.search(current.id, state.principal, 'dispatcher')[0].title, 'Architecture');
    const indexRow = state.runtime.db.get('SELECT * FROM context_index_snapshots WHERE project_id=? ORDER BY created_at DESC LIMIT 1', [current.id]);
    const indexPayload = JSON.parse(state.runtime.cas.read(indexRow.payload_cas_hash).toString('utf8'));
    assert.equal(indexPayload.engine, 'minisearch@7');
    assert.equal(indexPayload.mini_search.serializationVersion, 2);

    const selection = await state.runtime.context.createSelection(current.id, {
      query: 'projection', token_budget: 256, idempotency_key: 'p4-context-selection-first'
    }, state.principal);
    assert.equal(selection.selection.included.some((item) => item.node_id === map.nodes.find((node) => node.source_id === secret.source.id)?.id), false);
    assert.ok(selection.selection.token_used <= 256);
    await assert.rejects(() => state.runtime.context.createSelection(current.id, {
      token_budget: 256,
      mandatory_node_ids: [map.nodes.find((node) => node.source_id === secret.source.id).id],
      idempotency_key: 'p4-context-selection-secret'
    }, state.principal), (error) => error.code === 'evidence_incomplete');

    const pack = await state.runtime.context.createPack(current.id, {
      selection_id: selection.selection.id, require_authoritative: false, idempotency_key: 'p4-context-pack-first'
    }, state.principal);
    const payload = JSON.parse(state.runtime.cas.read(pack.pack.payload_cas_hash).toString('utf8'));
    assert.equal(payload.schema_version, 'aiws.context_pack.v5');
    assert.equal(payload.selection.selection_hash, selection.selection.selection_hash);
    assert.equal(JSON.stringify(pack.pack).includes('dispatcher ledger projection'), false);

    const policy = await state.runtime.context.updatePolicy(current.id, {
      policy: { pinned_node_ids: [map.nodes[0].id], excluded_node_ids: [] },
      expected_revision: 0, idempotency_key: 'p4-context-policy-first'
    }, state.principal);
    assert.equal(policy.revision, 1);
    await assert.rejects(() => state.runtime.context.updatePolicy(current.id, {
      policy: { pinned_node_ids: [map.nodes[0].id], excluded_node_ids: [map.nodes[0].id] },
      expected_revision: 1, idempotency_key: 'p4-context-policy-conflict'
    }, state.principal), (error) => error.code === 'context_policy_conflict');
    await assert.rejects(() => state.runtime.context.createPack(current.id, {
      selection_id: selection.selection.id, require_authoritative: false, idempotency_key: 'p4-context-pack-stale'
    }, state.principal), (error) => error.code === 'context_inputs_changed');

    state.runtime.db.run("UPDATE context_sources SET status='tombstone' WHERE id=?", [first.source.id]);
    await state.runtime.context.rebuild(current.id, { mode: 'full', idempotency_key: 'p4-context-rebuild-tombstone' }, state.principal);
    assert.equal(state.runtime.context.map(current.id, state.principal).nodes.find((node) => node.source_id === first.source.id).status, 'tombstone');
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Projection leases fence concurrent workers and retry records lineage with a new operation', async () => {
  const state = await open();
  try {
    const current = await project(state, 'projection');
    await state.runtime.context.createSource(current.id, {
      kind: 'note', title: 'Lease', uri: 'notes/lease', content: 'fencing input',
      idempotency_key: 'p4-projection-source-key'
    }, state.principal);
    const queued = await state.runtime.context.rebuild(current.id, { defer: true, idempotency_key: 'p4-projection-queued-key' }, state.principal);
    const [one, two] = await Promise.all([
      state.runtime.context.runJob(queued.job.id, state.principal, { leaseOwner: 'worker-a' }),
      state.runtime.context.runJob(queued.job.id, state.principal, { leaseOwner: 'worker-b' })
    ]);
    const finished = state.runtime.context.job(current.id, queued.job.id, state.principal);
    assert.equal(finished.status, 'completed');
    assert.equal([one.status, two.status].includes('completed'), true);
    assert.equal(state.runtime.operations.get(queued.operation.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');

    const cancellable = await state.runtime.context.rebuild(current.id, { defer: true, idempotency_key: 'p4-projection-cancel-key' }, state.principal);
    await assert.rejects(() => state.runtime.context.cancel(current.id, cancellable.job.id, {
      expected_revision: 99, idempotency_key: 'p4-projection-cancel-stale'
    }, state.principal), (error) => error.code === 'revision_conflict');
    const cancelled = await state.runtime.context.cancel(current.id, cancellable.job.id, {
      expected_revision: cancellable.job.revision, idempotency_key: 'p4-projection-cancel-valid'
    }, state.principal);
    assert.equal(cancelled.job.status, 'cancelled');
    assert.equal(cancelled.operation.status, 'cancelled');
    const retried = await state.runtime.context.retry(current.id, cancellable.job.id, {
      expected_revision: cancelled.job.revision, idempotency_key: 'p4-projection-retry-valid'
    }, state.principal);
    assert.equal(retried.job.retry_of_job_id, cancellable.job.id);
    assert.equal(retried.job.attempt, 2);
    assert.notEqual(retried.operation.operation_id, cancellable.operation.operation_id);
    assert.equal(state.runtime.context.job(current.id, retried.job.id, state.principal).status, 'completed');

    const source = state.runtime.context.listSources(current.id, state.principal)[0];
    fs.writeFileSync(state.runtime.cas.fileFor(source.cas_hash), 'tampered');
    await state.runtime.context.rebuild(current.id, { idempotency_key: 'p4-projection-tamper-key' }, state.principal);
    const failed = state.runtime.context.status(current.id, state.principal);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error_code, /cas|context_projection/);
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Clean domain adapters project Project, Brief, Repository, Workflow and Node Contract with acyclic edges', async () => {
  const state = await open();
  try {
    const current = await project(state, 'adapters');
    await state.runtime.project.createBrief(current.id, {
      objective: 'adapter projection', acceptance: ['stable graph'], expected_revision: 1,
      idempotency_key: 'p4-adapter-brief-key'
    }, state.principal);
    await state.runtime.project.createRepositoryConnection(current.id, {
      provider: 'fixture', source_kind: 'git', source_locator: 'fixtures/private-repository',
      idempotency_key: 'p4-adapter-repository-key'
    }, state.principal);
    await state.runtime.project.reviseWorkflow(current.id, {
      graph: { nodes: [{ id: 'stream', kind: 'workstream', title: 'Stream' }, { id: 'task', parent_id: 'stream', kind: 'task', title: 'Task', contract: { acceptance: ['done'] } }] },
      expected_revision: 1, idempotency_key: 'p4-adapter-workflow-key'
    }, state.principal);
    await state.runtime.context.rebuild(current.id, { idempotency_key: 'p4-adapter-rebuild-key' }, state.principal);
    const map = state.runtime.context.map(current.id, state.principal);
    assert.deepEqual(new Set(map.nodes.map((node) => node.kind)), new Set(['project', 'brief', 'repository', 'workflow', 'node_contract']));
    assert.equal(map.edges.filter((edge) => edge.relation === 'contains').length, 5);
    const documents = map.nodes.map((node) => state.runtime.context.read(current.id, node.id, state.principal).document?.content || '');
    assert.equal(documents.some((content) => /[A-Za-z]:\\/.test(content)), false);
  } finally { await close(state); }
});

test('Projection rejects contains cycles without publishing edges', async () => {
  const state = await open();
  try {
    const current = await project(state, 'cycle');
    const uriA = `aiws://context/${current.id}/cycle/a`;
    const uriB = `aiws://context/${current.id}/cycle/b`;
    await state.runtime.context.createSource(current.id, { kind: 'note', title: 'A', canonical_uri: uriA, content: 'A', metadata: { parent_uri: uriB }, idempotency_key: 'p4-cycle-source-a' }, state.principal);
    await state.runtime.context.createSource(current.id, { kind: 'note', title: 'B', canonical_uri: uriB, content: 'B', metadata: { parent_uri: uriA }, idempotency_key: 'p4-cycle-source-b' }, state.principal);
    await state.runtime.context.rebuild(current.id, { idempotency_key: 'p4-cycle-rebuild-key' }, state.principal);
    const status = state.runtime.context.status(current.id, state.principal);
    assert.equal(status.status, 'failed');
    assert.equal(status.error_code, 'context_edge_cycle');
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM context_edges WHERE project_id=?', [current.id]).count, 0);
  } finally { await close(state); }
});

test('Projection cancellation HTTP returns the canonical operation receipt', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const current = await project(state, 'cancel-http');
    const queued = await state.runtime.context.rebuild(current.id, { defer: true, idempotency_key: 'p4-http-cancel-queued' }, state.principal);
    const response = await fetch(`${network.base}/api/v2/projects/${current.id}/context/jobs/${queued.job.id}/cancel`, {
      method: 'POST',
      headers: { cookie: `aiws_session=${encodeURIComponent(state.proof)}`, 'content-type': 'application/json', 'Idempotency-Key': 'p4-http-cancel-valid', 'X-Expected-Revision': String(queued.job.revision) },
      body: '{}'
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.equal(payload.data.operation_id, queued.operation.operation_id);
    assert.equal(payload.data.status, 'cancelled');
    assert.equal(payload.data.operation.status, 'cancelled');
  } finally { await closeServer(network.server); await close(state); }
});
