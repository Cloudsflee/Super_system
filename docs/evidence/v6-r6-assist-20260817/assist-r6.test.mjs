import assert from 'node:assert/strict';
import test from 'node:test';
import { eventually, fixture, mutate, onboardProject, request } from './helpers.mjs';

test('R6 native Assist completes through Broker, CAS, operation, retry, and cursor CAS', async () => {
  const env = await fixture({ config: { assistNativeV6: true } });
  try {
    const credential = await mutate(env.base, '/api/v1/credentials', { kind: 'codex_api_key', label: 'Assist key', secret: 'assist-fixture-secret-value' }, 'r6-assist-credential');
    assert.equal(credential.response.status, 201, JSON.stringify(credential.json));
    const profile = await mutate(env.base, '/api/v1/profiles/codex', {
      label: 'Assist profile', provider: 'openai', model: 'gpt-5.5', base_url: '', wire_api: 'responses',
      reasoning: 'medium', timeout_ms: 30000, credential_ref: credential.json.id
    }, 'r6-assist-profile');
    assert.equal(profile.response.status, 201, JSON.stringify(profile.json));
    const project = await mutate(env.base, '/api/v1/projects', { name: 'R6 Assist native' }, 'r6-assist-project');
    await onboardProject(env.base, project, { content: { objective: 'Run native Assist', acceptance: ['durable turn'] }, keyPrefix: 'r6-assist-onboard' });
    await mutate(env.base, `/api/v1/projects/${project.json.id}/workflows`, { tasks: [{ id: 'inspect', title: 'Inspect', level: 1, mode: 'read', deps: [], outputs: ['report.md'] }] }, 'r6-assist-workflow');
    const source = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/sources`, { kind: 'note', title: 'R6 input', content: 'Only hashes belong in events.' }, 'r6-assist-source');
    const rebuilt = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'r6-assist-rebuild');
    const node = rebuilt.json.map.nodes.find((item) => item.source_id === source.json.id);
    const selection = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/selections`, { node_ids: [node.id], retrieval_plan: { strategy: 'explicit', token_budget: 1024 } }, 'r6-assist-selection');
    const pack = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/packs`, { selection_id: selection.json.id, schema_version: 'aiws.context_pack.v5' }, 'r6-assist-pack');
    assert.equal(pack.response.status, 201);

    const session = await mutate(env.base, '/api/v1/assist/sessions', {
      project_id: project.json.id, scope: 'project', scope_id: project.json.id,
      context_pack_id: pack.json.id, mode: 'native', expected_revision: 0
    }, 'r6-assist-session');
    assert.equal(session.response.status, 201);
    assert.equal(session.json.compatibility, 'native_v6');
    assert.equal(session.json.snapshot.profile_id, profile.json.id);

    const started = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/turns`, {
      message: 'Produce a deterministic Assist response.', goal: { objective: 'complete' }, plan: [{ step: 'run' }], expected_revision: 1
    }, 'r6-assist-turn');
    assert.equal(started.response.status, 202);
    assert.match(started.json.operation_id, /^op_/);
    const operation = await eventually(
      async () => (await request(env.base, `/api/v1/operations/${started.json.operation_id}`)).json,
      (value) => ['completed', 'failed', 'cancelled'].includes(value.status), 10_000
    );
    assert.equal(operation.status, 'completed', JSON.stringify(operation));

    const turn = await request(env.base, `/api/v1/assist/turns/${started.json.resource_id}`);
    assert.equal(turn.response.status, 200);
    assert.equal(turn.json.status, 'completed');
    assert.equal(turn.json.attempt, 1);
    assert.deepEqual(turn.json.snapshots.map((item) => item.status), ['queued', 'running', 'completed']);
    assert.ok(turn.json.snapshots.at(-1).output_cas_hash);

    const retry = await mutate(env.base, `/api/v1/assist/turns/${turn.json.id}/retry`, { expected_revision: turn.json.revision }, 'r6-assist-retry');
    assert.equal(retry.response.status, 202);
    const retryOperation = await eventually(
      async () => (await request(env.base, `/api/v1/operations/${retry.json.operation_id}`)).json,
      (value) => ['completed', 'failed', 'cancelled'].includes(value.status), 10_000
    );
    assert.equal(retryOperation.status, 'completed', JSON.stringify(retryOperation));
    const retriedTurn = await request(env.base, `/api/v1/assist/turns/${turn.json.id}`);
    assert.equal(retriedTurn.json.attempt, 2);
    assert.equal(retriedTurn.json.status, 'completed');
    assert.deepEqual(retriedTurn.json.messages.filter((item) => item.role === 'user').map((item) => item.attempt), [1, 2]);

    const replay = await request(env.base, `/api/v1/assist/sessions/${session.json.id}/events?after=0`, { headers: { accept: 'application/json' } });
    assert.ok(replay.json.events.length >= 7);
    assert.equal(JSON.stringify(replay.json.events).includes('Produce a deterministic'), false);
    assert.equal(replay.json.events.some((event) => Object.hasOwn(event, 'data_json')), false);
    const ack = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/events/cursor`, { consumer_id: 'web', cursor: replay.json.cursor, expected_revision: 0 }, 'r6-assist-cursor', 'PUT');
    assert.equal(ack.response.status, 200);
    assert.equal(ack.json.revision, 1);
    const stale = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/events/cursor`, { consumer_id: 'web', cursor: replay.json.cursor, expected_revision: 0 }, 'r6-assist-cursor-stale', 'PUT');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'revision_conflict');

    const currentSession = await request(env.base, `/api/v1/assist/sessions/${session.json.id}`);
    const paused = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/interrupt`, { expected_revision: currentSession.json.revision }, 'r6-assist-pause');
    assert.equal(paused.response.status, 200);
    assert.equal(paused.json.status, 'paused');
    const repeatedPause = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/interrupt`, { expected_revision: paused.json.revision }, 'r6-assist-pause-again');
    assert.equal(repeatedPause.response.status, 409);
    assert.equal(repeatedPause.json.error.code, 'invalid_state');
    const blockedTurn = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/turns`, { message: 'must not be admitted', expected_revision: paused.json.revision }, 'r6-assist-paused-turn');
    assert.equal(blockedTurn.response.status, 409);
    assert.equal(blockedTurn.json.error.code, 'assist_session_inactive');
    const resumed = await mutate(env.base, `/api/v1/assist/sessions/${session.json.id}/resume`, { expected_revision: paused.json.revision }, 'r6-assist-resume');
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.json.status, 'active');
  } finally { await env.close(); }
});

test('R6 native Assist remains feature-gated by default', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'R6 gate' }, 'r6-gate-project');
    const response = await mutate(env.base, '/api/v1/assist/sessions', { project_id: project.json.id, scope: 'project', scope_id: project.json.id, mode: 'native', expected_revision: 0 }, 'r6-gate-session');
    assert.equal(response.response.status, 503);
    assert.equal(response.json.error.code, 'assist_runtime_unavailable');
  } finally { await env.close(); }
});
