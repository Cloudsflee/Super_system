import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

test('runtime approvals, user inputs, and UI proposals persist decisions and audit events', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'Approval fixture' }, 'approval-project');
    await mutate(env.base, `/api/v1/projects/${project.json.id}/briefs`, { content: { objective: 'Exercise approval contracts' } }, 'approval-brief');
    await mutate(env.base, `/api/v1/projects/${project.json.id}/workflows`, { tasks: [{ id: 'inspect', title: 'Inspect', level: 1, mode: 'read', deps: [] }] }, 'approval-workflow');
    const execution = await mutate(env.base, `/api/v1/projects/${project.json.id}/executions`, {}, 'approval-execution');

    const approval = await mutate(env.base, `/api/v1/projects/${project.json.id}/approvals`, {
      execution_id: execution.json.id, action: 'runner.network.enable', request: { network: 'model' }, ttl_seconds: 600
    }, 'approval-create');
    assert.equal(approval.response.status, 201);
    assert.equal(approval.json.decision, 'pending');
    assert.deepEqual(approval.json.request, { network: 'model' });
    const approved = await mutate(env.base, `/api/v1/approvals/${approval.json.id}/decision`, { decision: 'approved' }, 'approval-decide');
    assert.equal(approved.response.status, 201);
    assert.equal(approved.json.decision, 'approved');
    const duplicateDecision = await mutate(env.base, `/api/v1/approvals/${approval.json.id}/decision`, { decision: 'rejected' }, 'approval-decide-again');
    assert.equal(duplicateDecision.response.status, 409);

    const expiring = await mutate(env.base, `/api/v1/projects/${project.json.id}/approvals`, { action: 'terminal.open', ttl_seconds: 60 }, 'approval-expiring');
    await env.app.database.run("UPDATE runtime_approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [expiring.json.id]);
    const approvalList = await request(env.base, `/api/v1/approvals?project_id=${project.json.id}`);
    assert.equal(approvalList.json.find((item) => item.id === expiring.json.id).decision, 'expired');

    const input = await mutate(env.base, `/api/v1/executions/${execution.json.id}/user-inputs`, { prompt: 'Select the verification mode' }, 'runtime-input-create');
    assert.equal(input.response.status, 201);
    assert.equal(input.json.status, 'pending');
    const answered = await mutate(env.base, `/api/v1/user-inputs/${input.json.id}/answer`, { response: 'full' }, 'runtime-input-answer');
    assert.equal(answered.json.status, 'answered');
    assert.equal(answered.json.response, 'full');
    const duplicateInput = await mutate(env.base, `/api/v1/user-inputs/${input.json.id}/cancel`, {}, 'runtime-input-cancel-after-answer');
    assert.equal(duplicateInput.response.status, 409);

    const intent = await mutate(env.base, `/api/v1/projects/${project.json.id}/ui-action-intents`, { action: 'open.diff', payload: { path: 'README.md' } }, 'ui-intent-create');
    assert.equal(intent.response.status, 201);
    const accepted = await mutate(env.base, `/api/v1/ui-action-intents/${intent.json.id}/resolve`, { status: 'accepted' }, 'ui-intent-resolve');
    assert.equal(accepted.json.status, 'accepted');

    const events = await env.app.database.query('SELECT type FROM events WHERE execution_id=? ORDER BY cursor', [execution.json.id]);
    assert.ok(events.some((event) => event.type === 'runtime.approval.requested'));
    assert.ok(events.some((event) => event.type === 'runtime.approval.approved'));
    assert.ok(events.some((event) => event.type === 'runtime.user_input.answered'));
    const audits = await request(env.base, '/api/v1/audit?limit=100');
    assert.ok(audits.json.some((event) => event.action === 'ui_action_intent.resolved'));
  } finally { await env.close(); }
});
