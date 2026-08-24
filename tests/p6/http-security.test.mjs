import assert from 'node:assert/strict';
import test from 'node:test';
import { close, closeServer, listen, open, prepare, waitOperation } from './helpers.mjs';

test('P6 HTTP exposes strict Runner and Execution v2 contracts with operation receipts', async () => {
  const state = await open(); const network = await listen(state.runtime);
  try {
    const fixture = await prepare(state, 'http'); const cookie = `aiws_session=${state.proof}`;
    const profiles = await json(await fetch(`${network.base}/api/v2/runners/profiles`, { headers: { cookie } })); assert.equal(profiles.response.status, 200); assert.ok(profiles.body.data.profiles.some((item) => item.id === fixture.profile.id));
    const profile = await json(await fetch(`${network.base}/api/v2/runners/profiles/${fixture.profile.id}`, { headers: { cookie } })); assert.equal(profile.response.status, 200); assert.equal(profile.body.data.profile.status, 'ready');
    const listed = await json(await fetch(`${network.base}/api/v2/projects/${fixture.project.id}/executions`, { headers: { cookie } })); assert.equal(listed.response.status, 200); assert.equal(listed.body.meta.api_version, '2'); assert.ok(listed.body.data.executions.some((item) => item.id === fixture.execution.id));
    const detail = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}`, { headers: { cookie } })); assert.equal(detail.response.status, 200); assert.equal(detail.body.data.execution.id, fixture.execution.id);

    const missingRevision = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/start`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'Idempotency-Key': 'p6-http-missing-revision' }, body: '{}' }));
    assert.equal(missingRevision.response.status, 400); assert.equal(missingRevision.body.error.code, 'expected_revision_required');
    const started = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/start`, { method: 'POST', headers: mutationHeaders(state.proof, 'p6-http-start', fixture.execution.revision), body: '{}' }));
    assert.equal(started.response.status, 202); assert.equal(started.body.data.command_id, 'execution.start'); assert.match(started.response.headers.get('etag'), /^rev-/);
    assert.equal((await waitOperation(state.runtime, started.body.data.operation_id, state.principal.actorId)).status, 'succeeded');
    const projections = {};
    for (const suffix of ['events', 'attempts', 'checkpoints']) { const response = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/${suffix}`, { headers: { cookie } })); assert.equal(response.response.status, 200, `${suffix}:${JSON.stringify(response.body)}`); projections[suffix] = response.body.data; }
    const completed = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}`, { headers: { cookie } }));
    const deliver = projections.checkpoints.checkpoints.find((checkpoint) => checkpoint.stage === 'deliver');
    assert.match(deliver.checkpoint_token, /^[A-Za-z0-9_-]{32,}$/);
    const replay = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/stages/deliver/replay`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p6-http-replay', completed.body.data.execution.revision),
      body: JSON.stringify({ generation: deliver.generation, checkpoint_token: deliver.checkpoint_token, workspace_hash: deliver.workspace_sha256, pins_hash: deliver.pins_sha256 })
    }));
    assert.equal(replay.response.status, 202, JSON.stringify(replay.body));
    assert.equal((await waitOperation(state.runtime, replay.body.data.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(state.runtime.execution.get(fixture.execution.id, state.principal).generation, 2);

    const stale = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/replan`, { method: 'POST', headers: mutationHeaders(state.proof, 'p6-http-stale-replan', 1), body: '{}' })); assert.equal(stale.response.status, 409); assert.equal(stale.body.error.code, 'revision_conflict');
    const unknown = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}?unexpected=1`, { headers: { cookie } })); assert.equal(unknown.response.status, 400); assert.equal(unknown.body.error.code, 'unknown_field');
  } finally { await closeServer(network.server); await close(state); }
});

test('P6 transport inventory keeps Runner mutations REST/Web-only and redacts fixture payloads and host paths', async () => {
  const state = await open(); const network = await listen(state.runtime);
  try {
    const fixture = await prepare(state, 'security'); const cookie = `aiws_session=${state.proof}`; const project = state.runtime.db.get('SELECT * FROM projects WHERE id=?', [fixture.project.id]);
    const secret = 'TOKEN_SHOULD_NOT_APPEAR'; const hostPath = 'C:\\Users\\private\\workspace';
    const created = await state.runtime.execution.create(project.id, { repository_workspace_id: fixture.workspace.id, context_pack_id: fixture.pack.id, runner_profile_id: fixture.profile.id, tasks: [{ id: 'redacted', input_paths: ['README.md'], fixture: { stdout: `${secret} ${hostPath}` } }], expected_revision: project.revision, idempotency_key: 'p6-security-redacted-execution' }, state.principal);
    const response = await fetch(`${network.base}/api/v2/executions/${created.execution.id}`, { headers: { cookie } }); const raw = await response.text(); assert.equal(response.status, 200); assert.doesNotMatch(raw, new RegExp(secret)); assert.doesNotMatch(raw, /C:\\\\Users/);
    const deniedEndpoint = await json(await fetch(`${network.base}/api/v2/runners/profiles`, { method: 'POST', headers: mutationHeaders(state.proof, 'p6-security-endpoint', 0), body: JSON.stringify({ label: 'Unsafe path', runner_type: 'host', endpoint_ref: hostPath }) })); assert.equal(deniedEndpoint.response.status, 422); assert.equal(deniedEndpoint.body.error.code, 'runner_endpoint_ref_invalid');
    const unauthenticated = await fetch(`${network.base}/api/v2/runners/profiles`); assert.equal(unauthenticated.status, 401);
    const retired = await fetch(`${network.base}/api/v1/executions/${created.execution.id}`); assert.equal(retired.status, 410);

    const entries = state.runtime.registry.entries.filter((entry) => entry.phase === 'p6'); assert.equal(entries.length, 18); assert.equal(new Set(entries.map((entry) => entry.command_id)).size, entries.length);
    for (const command of ['runner.profile.create', 'runner.profile.update', 'runner.profile.probe', 'runner.profile.disable']) { const entry = state.runtime.registry.get(command); assert.deepEqual(entry.transport_allowlist, ['rest', 'web']); assert.equal(entry.mcp.exposed, false); }
    for (const command of ['runner.profile.list', 'runner.profile.get', 'execution.list', 'execution.create', 'execution.get', 'execution.start', 'execution.stage.replay']) { const entry = state.runtime.registry.get(command); assert.equal(entry.mcp.exposed, true); assert.deepEqual(entry.transport_allowlist, ['rest', 'web', 'mcp', 'gateway']); }
    const tools = state.runtime.dispatcher.tools(); assert.equal(tools.some((tool) => tool.command_id === 'runner.profile.create'), false); assert.equal(tools.some((tool) => tool.command_id === 'execution.start'), true);
  } finally { await closeServer(network.server); await close(state); }
});

function mutationHeaders(proof, key, revision) { return { cookie: `aiws_session=${proof}`, accept: 'application/json', 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Expected-Revision': String(revision) }; }
async function json(response) { return { response, body: await response.json() }; }
