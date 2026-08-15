import assert from 'node:assert/strict';
import test from 'node:test';
import { eventually, fixture, mutate, onboardProject, request } from '../integration/helpers.mjs';

test('workflow generation public records and streams expose only stable metadata', async () => {
  const env = await fixture();
  const secret = 'workflow-provider-secret-fixture';
  const prompt = 'workflow-private-prompt-fixture';
  const sourcePath = 'C:\\private\\workflow-source';
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'Workflow redaction' }, 'workflow-security-project');
    await onboardProject(env.base, project, {
      content: { objective: 'Verify workflow event redaction', acceptance: ['redaction verified'] },
      keyPrefix: 'workflow-security-onboard'
    });
    const started = await mutate(env.base, `/api/v1/projects/${project.json.id}/workflow-generations`, {
      provider: 'fixture', async: true, credential: secret, prompt, source_path: sourcePath
    }, 'workflow-security-generate');
    assert.equal(started.response.status, 202);
    const generation = await eventually(
      async () => (await request(env.base, `/api/v1/workflow-generations/${started.json.generation_id}`)).json,
      (value) => ['completed', 'rejected', 'failed', 'cancelled'].includes(value.phase),
      5000
    );
    const events = await request(env.base, `/api/v1/workflow-generations/${generation.id}/events`);
    const operation = await request(env.base, `/api/v1/operations/${started.json.operation_id}`);
    const operationEvents = await request(env.base, `/api/v1/operations/${started.json.operation_id}/events`);
    const stream = await fetch(`${env.base}/api/v1/workflow-generations/${generation.id}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '0' }
    });
    const serialized = JSON.stringify({ generation, events: events.json, operation: operation.json, operation_events: operationEvents.json, stream: await stream.text() });
    for (const value of [secret, prompt, sourcePath]) assert.equal(serialized.includes(value), false);
    for (const rawField of ['provider_snapshot_json', 'input_snapshot_json', 'candidate_json', 'issues_json', 'data_json']) assert.equal(serialized.includes(rawField), false);
    assert.equal(events.json.every((event) => Object.keys(event.data).every((key) => [
      'status', 'revision', 'draft_revision', 'layout_revision', 'attempt', 'input_hash',
      'candidate_hash', 'proposal_hash', 'error_code', 'critic_status'
    ].includes(key))), true);
  } finally { await env.close(); }
});

test('workflow candidates enforce the bounded public input contract', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'Workflow bounds' }, 'workflow-bounds-project');
    await onboardProject(env.base, project, {
      content: { objective: 'Bound candidate input', acceptance: ['bounded'] },
      keyPrefix: 'workflow-bounds-onboard'
    });
    const oversized = await mutate(env.base, `/api/v1/projects/${project.json.id}/workflow-generations`, {
      provider: 'fixture', async: true, candidate: { padding: 'x'.repeat(300 * 1024) }
    }, 'workflow-bounds-generate');
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.json.error.code, 'workflow_contract_invalid');
    assert.equal(JSON.stringify(oversized.json).includes('x'.repeat(1024)), false);
  } finally { await env.close(); }
});
