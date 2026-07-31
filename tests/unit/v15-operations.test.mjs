import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v15-operations-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const operations = await import('../../apps/api/src/assist-operations.mjs');
  const waiters = await import('../../apps/api/src/assist-operation-waiters.mjs');
  await stateApi.ensureRuntime();
  const viewContext = {
    route: '/projects/project-v15/brief',
    browser_instance_id: 'browser-one',
    surface: {
      id: 'brief-surface',
      revision: 'surface-r1',
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
  const locator = {
    browser_instance_id: 'browser-one',
    route: viewContext.route,
    surface_id: viewContext.surface.id,
    surface_revision: viewContext.surface.revision
  };
  await stateApi.mutate((state) => {
    state.projects = [{ id: 'project-v15', status: 'active', managed_workspace_state: 'ready' }];
    state.assist_sessions = [
      {
        id: 'session-v15',
        version: 3,
        project_id: 'project-v15',
        scope_type: 'project',
        scope_id: 'project-v15',
        scope_status: 'active',
        archived_at: null
      }
    ];
    state.assist_turns = [
      {
        id: 'turn-v15',
        session_id: 'session-v15',
        project_id: 'project-v15',
        status: 'running',
        mode: 'default',
        collaboration_mode: 'default',
        view_context: viewContext
      }
    ];
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
    namespace: 'aiws_page',
    tool: 'set_field',
    callId: 'call-first',
    arguments: { target_id: 'brief.goal', value: 'after' }
  });
  const first = await pendingOperation(stateApi, 'call-first');
  assert.equal(first.status, 'pending');
  await assert.rejects(
    () => operations.claimAssistOperation(first.id, { ...locator, surface_id: 'wrong-surface' }),
    (error) => error.payload?.error === 'assist_operation_surface_changed'
  );
  assert.equal(
    (await operations.listAssistOperations({ session_id: 'session-v15' })).find((item) => item.id === first.id).status,
    'pending'
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const claimed = await operations.claimAssistOperation(first.id, locator);
  assert.equal(claimed.value, 'after');
  assert.ok(
    Date.parse((await stateApi.readState()).assist_operations.find((item) => item.id === first.id).claim_expires_at) >
      Date.parse(first.claim_expires_at),
    'claim extends the browser execution deadline'
  );
  await operations.submitAssistOperationResult(first.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'before',
    after: 'after',
    current: 'after'
  });
  const toolResult = await firstPromise;
  assert.equal(toolResult.success, true);
  const committed = (await operations.listAssistOperations({ session_id: 'session-v15' })).find(
    (item) => item.id === first.id
  );
  assert.equal(committed.status, 'committed');
  assert.match(committed.before_hash, /^[a-f0-9]{64}$/);
  assert.match(committed.after_hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(committed, 'tool'), false, 'machine tool names stay out of public receipts');
  await assert.rejects(
    () =>
      operations.submitAssistOperationResult(first.id, {
        ...locator,
        surface_id: 'wrong-surface',
        ok: true,
        persisted: true,
        before: 'before',
        after: 'after'
      }),
    (error) => error.payload?.error === 'assist_operation_surface_changed'
  );
  await assert.rejects(
    () =>
      operations.submitAssistOperationResult(first.id, {
        route: locator.route,
        surface_id: locator.surface_id,
        surface_revision: locator.surface_revision
      }),
    (error) => error.payload?.error === 'assist_browser_instance_required'
  );

  const inverse = await operations.undoAssistOperation(first.id);
  assert.equal(inverse.inverse_of, first.id);
  await operations.claimAssistOperation(inverse.id, locator);
  const undone = await operations.submitAssistOperationResult(inverse.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'after',
    after: 'before',
    current: 'before'
  });
  assert.equal(undone.status, 'committed');
  assert.equal(
    (await operations.listAssistOperations({ session_id: 'session-v15' })).find((item) => item.id === first.id)
      .undone_by,
    inverse.id
  );

  const secondPromise = operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page',
    tool: 'set_field',
    callId: 'call-second',
    arguments: { target_id: 'brief.goal', value: 'after-two' }
  });
  const second = await pendingOperation(stateApi, 'call-second');
  await operations.claimAssistOperation(second.id, locator);
  await operations.submitAssistOperationResult(second.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'before-two',
    after: 'after-two'
  });
  await secondPromise;
  const conflictingInverse = await operations.undoAssistOperation(second.id);
  await operations.claimAssistOperation(conflictingInverse.id, locator);
  const conflict = await operations.submitAssistOperationResult(conflictingInverse.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'changed-elsewhere',
    after: 'before-two'
  });
  assert.equal(conflict.status, 'conflicted');
  assert.deepEqual(conflict.conflict, { before: 'before-two', after: 'after-two', current: 'changed-elsewhere' });
  const forced = await operations.undoAssistOperation(second.id, { force: true });
  assert.equal(forced.id, conflictingInverse.id);
  assert.equal(forced.forced, true);
  assert.equal(forced.status, 'pending');
  await operations.claimAssistOperation(forced.id, locator);
  const forceResult = await operations.submitAssistOperationResult(forced.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'changed-elsewhere',
    after: 'before-two',
    current: 'before-two'
  });
  assert.equal(forceResult.status, 'committed');
  assert.equal(forceResult.forced, true);
  assert.deepEqual(forceResult.conflict, { before: 'before-two', after: 'after-two', current: 'changed-elsewhere' });

  await assert.rejects(
    () => operations.reviseAssistOperation(second.id, { ...locator, value: 'not-allowed' }),
    (error) => error.payload?.error === 'assist_dynamic_tool_value_not_allowed'
  );
  const committedSecond = (await operations.listAssistOperations({ session_id: 'session-v15' })).find(
    (item) => item.id === second.id
  );
  const revision = await operations.reviseAssistOperation(second.id, { ...locator, value: 'after' });
  assert.equal(revision.operation_reference_id, second.id);
  assert.equal(revision.expected_current_hash, committedSecond.current_hash || committedSecond.after_hash);
  await operations.claimAssistOperation(revision.id, locator);
  const revisionConflict = await operations.submitAssistOperationResult(revision.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'before-two',
    after: 'before-two',
    current: 'before-two'
  });
  assert.equal(revisionConflict.status, 'conflicted');
  assert.deepEqual(revisionConflict.conflict, { before: 'before-two', after: 'after-two', current: 'before-two' });
  const retriedRevision = await operations.reviseAssistOperation(revision.id, { ...locator, value: 'after' });
  assert.equal(retriedRevision.expected_current_hash, revisionConflict.current_hash);
  await operations.claimAssistOperation(retriedRevision.id, locator);
  assert.equal(
    (
      await operations.submitAssistOperationResult(retriedRevision.id, {
        ...locator,
        ok: true,
        persisted: true,
        before: 'before-two',
        after: 'after',
        current: 'after'
      })
    ).status,
    'committed'
  );

  const persistencePromise = operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page',
    tool: 'set_field',
    callId: 'call-persistence-mismatch',
    arguments: { target_id: 'brief.goal', value: 'after' }
  });
  const persistence = await pendingOperation(stateApi, 'call-persistence-mismatch');
  await operations.claimAssistOperation(persistence.id, locator);
  const persistenceFailure = await operations.submitAssistOperationResult(persistence.id, {
    ...locator,
    ok: true,
    persisted: true,
    before: 'before',
    after: 'after',
    current: 'before'
  });
  assert.equal(persistenceFailure.status, 'failed');
  assert.equal(persistenceFailure.failure_code, 'browser_persistence_mismatch');
  await assert.rejects(persistencePromise, (error) => error.payload?.error === 'browser_persistence_mismatch');

  const approvalPromise = operations.handleDynamicPageTool('session-v15', 'turn-v15', {
    namespace: 'aiws_page',
    tool: 'set_field',
    callId: 'call-high-risk',
    arguments: { target_id: 'brief.admin', value: true }
  });
  const approval = await pendingOperation(stateApi, 'call-high-risk');
  assert.equal(approval.status, 'pending_confirmation');
  await operations.confirmAssistOperation(approval.id, { approved: false });
  await assert.rejects(approvalPromise, (error) => error.payload?.error === 'assist_operation_denied');
  assert.equal(
    (await waiters.waitForOperationResult(first.id, undefined, async () => undefined, 50)).success,
    true,
    'a result committed before waiter registration is reconciled'
  );
  await assert.rejects(
    () => waiters.waitForOperationApproval(approval.id),
    (error) => error.payload?.error === 'assist_operation_denied'
  );
  await stateApi.mutate((state) => {
    state.assist_operations.push({
      id: 'claimed-extension',
      status: 'claimed',
      claim_expires_at: new Date(Date.now() + 200).toISOString()
    });
  });
  let extensionExpired = false;
  const extendedWait = waiters.waitForOperationResult(
    'claimed-extension',
    undefined,
    async () => {
      extensionExpired = true;
    },
    10
  );
  setTimeout(
    () =>
      waiters.settleOperationResult('claimed-extension', {
        id: 'claimed-extension',
        status: 'committed',
        target_id: 'brief.goal'
      }),
    25
  );
  assert.equal((await extendedWait).success, true);
  assert.equal(extensionExpired, false, 'claimed operations retain their extended execution window');

  await assert.rejects(
    () =>
      operations.handleDynamicPageTool('session-v15', 'turn-v15', {
        namespace: 'aiws_page',
        tool: 'set_field',
        callId: 'call-selector',
        arguments: { target_id: 'brief.goal', value: 'after', selector: '#root' }
      }),
    (error) => error.payload?.error === 'assist_dynamic_tool_unsafe_argument'
  );
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool('session-v15', 'turn-v15', {
        namespace: 'aiws_page',
        tool: 'set_field',
        callId: 'call-nested-script',
        arguments: { target_id: 'brief.admin', value: [{ nested: [{ script: 'forbidden' }] }] }
      }),
    (error) => error.payload?.error === 'assist_dynamic_tool_unsafe_argument'
  );
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool('session-v15', 'turn-v15', {
        namespace: 'aiws_page',
        tool: 'set_field',
        callId: 'call-secret',
        arguments: { target_id: 'brief.secret', value: 'secret' }
      }),
    (error) => error.payload?.error === 'assist_dynamic_tool_target_not_allowed'
  );
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool('session-v15', 'turn-v15', {
        namespace: 'aiws_page',
        tool: 'set_field',
        callId: 'call-large',
        arguments: { target_id: 'brief.admin', value: 'x'.repeat(70_000) }
      }),
    (error) => error.payload?.error === 'assist_operation_value_too_large'
  );

  await stateApi.mutate((state) => {
    state.assist_operations.push({
      id: 'browser-timeout',
      turn_id: 'turn-v15',
      execution_layer: 'browser',
      status: 'failed',
      failure_code: 'browser_claim_timeout'
    });
  });
  const countBeforeFastFailure = (await stateApi.readState()).assist_operations.length;
  const fastFailureStarted = performance.now();
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool('session-v15', 'turn-v15', {
        namespace: 'aiws_page',
        tool: 'set_field',
        callId: 'call-browser-offline',
        arguments: { target_id: 'brief.goal', value: 'after' }
      }),
    (error) => error.payload?.error === 'assist_browser_executor_unavailable' && error.payload?.retryable === true
  );
  assert.ok(
    performance.now() - fastFailureStarted < 1_000,
    'same-turn browser operations fail in under one second after the first timeout'
  );
  assert.equal(
    (await stateApi.readState()).assist_operations.length,
    countBeforeFastFailure,
    'offline browser failures do not append repeated timeout operations'
  );

  await stateApi.mutate((state) => {
    const turn = state.assist_turns[0];
    turn.mode = 'plan';
    turn.collaboration_mode = 'plan';
  });
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool('session-v15', 'turn-v15', {
        namespace: 'aiws_page',
        tool: 'set_field',
        callId: 'call-plan',
        arguments: { target_id: 'brief.goal', value: 'after' }
      }),
    (error) => error.payload?.error === 'assist_plan_page_write_forbidden'
  );
  assert.ok(
    (await operations.listAssistOperations({ session_id: 'session-v15' })).length >= 5,
    'ledger remains append-only'
  );
  console.log('V1.5 operation ledger unit tests passed');
} finally {
  await import('../../apps/api/src/state.mjs').then((state) => state.checkpointAndCloseState()).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

async function pendingOperation(stateApi, callId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const item = (await stateApi.readState()).assist_operations.find((entry) => entry.tool_call_id === callId);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('operation_timeout');
}
