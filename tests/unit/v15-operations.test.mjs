import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v15-operations-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const operations = await import('../../apps/api/src/assist-operations.mjs');
  await stateApi.ensureRuntime();
  const viewContext = {
    route: '/projects/project-v15/brief', browser_instance_id: 'browser-one',
    surface: {
      id: 'brief-surface', revision: 'surface-r1',
      fields: [
        { id: 'brief.goal', label: 'Goal', risk: 'low', allowedValues: ['before', 'after', 'after-two', 'before-two'] },
        { id: 'brief.admin', label: 'Admin', risk: 'high' },
        { id: 'brief.secret', label: 'Secret', risk: 'low', sensitivity: 'secret' },
        { id: 'brief.unreadable', label: 'Unreadable', risk: 'low', readable: false }
      ],
      filters: [{ id: 'brief.status', label: 'Status', risk: 'low', allowedValues: ['open', 'closed'] }],
      tabs: [{ id: 'brief.review', label: 'Review', risk: 'low' }]
    }
  };
  await stateApi.mutate((state) => {
    state.projects = [{ id: 'project-v15', status: 'active', managed_workspace_state: 'ready' }];
    state.assist_sessions = [{ id: 'session-v15', version: 3, project_id: 'project-v15', archived_at: null }];
    state.assist_turns = [{ id: 'turn-v15', session_id: 'session-v15', project_id: 'project-v15', status: 'running', mode: 'default', collaboration_mode: 'default', view_context: viewContext }];
    state.assist_operations = [];
  });

  const tools = operations.dynamicPageToolSpec(viewContext, 'default');
  assert.equal(tools.length, 1);
  const fields = tools[0].tools.find((item) => item.name === 'set_field').inputSchema.properties.target_id.enum;
  assert.ok(fields.includes('brief.goal'));
  assert.equal(fields.includes('brief.secret'), false);
  assert.equal(fields.includes('brief.unreadable'), false);
  assert.deepEqual(operations.dynamicPageToolSpec(viewContext, 'plan'), []);

  const firstPromise = operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-first', arguments: { target_id: 'brief.goal', value: 'after' }
  });
  const first = await pendingOperation(stateApi, 'call-first');
  assert.equal(first.status, 'pending');
  const claimed = await operations.claimAssistOperation(first.id, { browser_instance_id: 'browser-one' });
  assert.equal(claimed.value, 'after');
  await operations.submitAssistOperationResult(first.id, {
    browser_instance_id: 'browser-one', route: viewContext.route, surface_revision: 'surface-r1', ok: true, persisted: true,
    before: 'before', after: 'after', current: 'after'
  });
  const toolResult = await firstPromise;
  assert.equal(toolResult.success, true);
  const committed = (await operations.listAssistOperations({ session_id: 'session-v15' })).find((item) => item.id === first.id);
  assert.equal(committed.status, 'committed');
  assert.match(committed.before_hash, /^[a-f0-9]{64}$/);
  assert.match(committed.after_hash, /^[a-f0-9]{64}$/);

  const inverse = await operations.undoAssistOperation(first.id);
  assert.equal(inverse.inverse_of, first.id);
  await operations.claimAssistOperation(inverse.id, { browser_instance_id: 'browser-one' });
  const undone = await operations.submitAssistOperationResult(inverse.id, {
    browser_instance_id: 'browser-one', route: viewContext.route, surface_revision: 'surface-r1', ok: true, persisted: true,
    before: 'after', after: 'before', current: 'before'
  });
  assert.equal(undone.status, 'committed');
  assert.equal((await operations.listAssistOperations({ session_id: 'session-v15' })).find((item) => item.id === first.id).undone_by, inverse.id);

  const secondPromise = operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-second', arguments: { target_id: 'brief.goal', value: 'after-two' }
  });
  const second = await pendingOperation(stateApi, 'call-second');
  await operations.claimAssistOperation(second.id, { browser_instance_id: 'browser-one' });
  await operations.submitAssistOperationResult(second.id, {
    browser_instance_id: 'browser-one', route: viewContext.route, surface_revision: 'surface-r1', ok: true, persisted: true,
    before: 'before-two', after: 'after-two'
  });
  await secondPromise;
  const conflictingInverse = await operations.undoAssistOperation(second.id);
  await operations.claimAssistOperation(conflictingInverse.id, { browser_instance_id: 'browser-one' });
  const conflict = await operations.submitAssistOperationResult(conflictingInverse.id, {
    browser_instance_id: 'browser-one', route: viewContext.route, surface_revision: 'surface-r1', ok: true, persisted: true,
    before: 'changed-elsewhere', after: 'before-two'
  });
  assert.equal(conflict.status, 'conflicted');
  assert.deepEqual(conflict.conflict, { before: 'before-two', after: 'after-two', current: 'changed-elsewhere' });
  const forced = await operations.undoAssistOperation(second.id, { force: true });
  assert.equal(forced.id, conflictingInverse.id); assert.equal(forced.forced, true); assert.equal(forced.status, 'pending');
  await operations.claimAssistOperation(forced.id, { browser_instance_id: 'browser-one' });
  const forceResult = await operations.submitAssistOperationResult(forced.id, {
    browser_instance_id: 'browser-one', route: viewContext.route, surface_revision: 'surface-r1', ok: true, persisted: true,
    before: 'changed-elsewhere', after: 'before-two', current: 'before-two'
  });
  assert.equal(forceResult.status, 'committed'); assert.equal(forceResult.forced, true);
  assert.deepEqual(forceResult.conflict, { before: 'before-two', after: 'after-two', current: 'changed-elsewhere' });

  const approvalPromise = operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-high-risk', arguments: { target_id: 'brief.admin', value: true }
  });
  const approval = await pendingOperation(stateApi, 'call-high-risk');
  assert.equal(approval.status, 'pending_confirmation');
  await operations.confirmAssistOperation(approval.id, { approved: false });
  await assert.rejects(approvalPromise, (error) => error.payload?.error === 'assist_operation_denied');

  await assert.rejects(() => operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-selector', arguments: { target_id: 'brief.goal', value: 'after', selector: '#root' }
  }), (error) => error.payload?.error === 'assist_dynamic_tool_unsafe_argument');
  await assert.rejects(() => operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-secret', arguments: { target_id: 'brief.secret', value: 'secret' }
  }), (error) => error.payload?.error === 'assist_dynamic_tool_target_not_allowed');
  await assert.rejects(() => operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-large', arguments: { target_id: 'brief.admin', value: 'x'.repeat(70_000) }
  }), (error) => error.payload?.error === 'assist_operation_value_too_large');

  await stateApi.mutate((state) => { const turn = state.assist_turns[0]; turn.mode = 'plan'; turn.collaboration_mode = 'plan'; });
  await assert.rejects(() => operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page', tool: 'set_field', callId: 'call-plan', arguments: { target_id: 'brief.goal', value: 'after' }
  }), (error) => error.payload?.error === 'assist_plan_page_write_forbidden');
  assert.ok((await operations.listAssistOperations({ session_id: 'session-v15' })).length >= 5, 'ledger remains append-only');
  console.log('V1.5 operation ledger unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function pendingOperation(stateApi, callId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const item = (await stateApi.readState()).assist_operations.find((entry) => entry.tool_call_id === callId);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('operation_timeout');
}
