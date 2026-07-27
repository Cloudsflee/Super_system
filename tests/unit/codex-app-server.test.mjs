import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  isCodexThreadUnavailable,
  nativeCollaborationMode,
  runCodexAppServer
} from '../../apps/api/src/codex-app-server.mjs';
import { createCodexEphemeralThread } from '../../apps/api/src/codex-ephemeral-thread.mjs';

class FakeProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      writable: true,
      write: (chunk) => {
        for (const line of String(chunk).trim().split(/\r?\n/).filter(Boolean)) handler(JSON.parse(line), this);
        return true;
      }
    };
  }
  send(message) {
    queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  }
  kill() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.stdin.writable = false;
    queueMicrotask(() => this.emit('close', 0));
  }
}

const state = {
  integration_statuses: [
    { key: 'codex_auth', status: 'authenticated', provider: 'openai', auth_mode: 'device', refs: {} }
  ]
};
const profile = {
  id: 'cdx_app_server',
  kind: 'host',
  provider: 'openai',
  model: 'gpt-test',
  reasoning: 'high',
  codex_home: 'C:\\aiws-test-codex',
  timeout_ms: 5000
};
const events = [],
  approvals = [],
  protocol = [],
  responses = new Map();
let invocation;

const result = await runCodexAppServer({
  state,
  profile,
  prompt: 'Plan the requested change.',
  userInput: [
    { type: 'text', text: 'Plan the requested change.', text_elements: [] },
    { type: 'image', detail: 'auto', url: 'data:image/png;base64,AA==' }
  ],
  additionalContext: [{ kind: 'application', value: 'hidden application context' }],
  dynamicTools: [{ type: 'function', name: 'test_tool', description: 'Test', inputSchema: { type: 'object' } }],
  cwd: process.cwd(),
  sandbox: 'read-only',
  mode: 'plan',
  spawnProcess(command, args, options) {
    invocation = { command, args, options };
    return new FakeProcess((message, child) => handleProtocol(message, child));
  },
  onEvent: (event) => events.push(event),
  onApproval: async (request) => {
    approvals.push(request);
    return true;
  }
});

assert.deepEqual(invocation.args.slice(-8), [
  'app-server',
  '--stdio',
  '--disable',
  'code_mode_host',
  '--disable',
  'plugins',
  '--disable',
  'apps'
]);
assert.equal(invocation.options.shell, false);
assert.equal(result.ok, true);
assert.equal(result.transport, 'app-server');
assert.equal(result.thread_id, 'thread-1');
assert.equal(result.turn_id, 'turn-1');
assert.equal(protocol[0].method, 'initialize');
assert.equal(protocol[0].params.capabilities.experimentalApi, true);
assert.ok(protocol.some((item) => item.method === 'initialized'));
assert.ok(protocol.some((item) => item.method === 'collaborationMode/list'));
const threadStart = protocol.find((item) => item.method === 'thread/start');
assert.equal(threadStart.params.approvalsReviewer, 'user');
assert.equal(threadStart.params.sandbox, 'read-only');
assert.equal(threadStart.params.dynamicTools[0].name, 'test_tool');
assert.equal('runtimeWorkspaceRoots' in threadStart.params, false);
const turnStart = protocol.find((item) => item.method === 'turn/start');
assert.equal(turnStart.params.input[0].text_elements.length, 0);
assert.equal(turnStart.params.input[1].type, 'image');
assert.equal(turnStart.params.sandboxPolicy.type, 'readOnly');
assert.equal(turnStart.params.approvalsReviewer, 'user');
assert.equal(turnStart.params.summary, 'concise');
assert.equal('model' in turnStart.params, false);
assert.equal('effort' in turnStart.params, false);
assert.equal('dynamicTools' in turnStart.params, false);
assert.deepEqual(turnStart.params.additionalContext, {
  'aiws.application.1': { kind: 'application', value: 'hidden application context' }
});
assert.deepEqual(turnStart.params.collaborationMode, {
  mode: 'plan',
  settings: { model: 'gpt-test', reasoning_effort: 'high', developer_instructions: null }
});
assert.equal(nativeCollaborationMode('ask', profile).mode, 'default');

assert.equal(approvals.length, 3);
assert.equal(responses.get('approval-command').decision, 'accept');
assert.equal(responses.get('approval-file').decision, 'accept');
assert.deepEqual(responses.get('approval-permissions'), { permissions: { network: { enabled: true } }, scope: 'turn' });
assert.deepEqual(responses.get('dynamic-tool'), {
  success: false,
  contentItems: [{ type: 'inputText', text: 'AIWS semantic tool failed.' }]
});
assert.ok(events.some((item) => item.aiws_type === 'text' && item.output_text === 'Hello'));
assert.ok(events.some((item) => item.aiws_type === 'plan' && item.data.status === 'updated'));
assert.ok(events.some((item) => item.aiws_type === 'reasoning_summary' && item.data.summary === '公开摘要'));
assert.ok(events.some((item) => item.aiws_type === 'command' && item.data.exit_code === 0));
assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'), false);

const freshEphemeralProtocol = [];
const freshEphemeral = await createCodexEphemeralThread({
  state,
  profile,
  cwd: process.cwd(),
  sourceThreadId: null,
  sourceTurnId: null,
  spawnProcess() {
    return new FakeProcess((message, child) => {
      freshEphemeralProtocol.push(message);
      if (message.method === 'initialize') child.send({ id: message.id, result: {} });
      if (message.method === 'thread/start')
        child.send({ id: message.id, result: { thread: { id: 'fresh-ephemeral-thread' } } });
    });
  }
});
assert.equal(freshEphemeral.threadId, 'fresh-ephemeral-thread');
assert.deepEqual(freshEphemeralProtocol.find((item) => item.method === 'thread/start').params, {
  model: 'gpt-test',
  cwd: process.cwd(),
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandbox: 'read-only',
  ephemeral: true
});
assert.equal(
  freshEphemeralProtocol.some((item) => item.method === 'thread/fork'),
  false
);
freshEphemeral.close();

const forkedEphemeralProtocol = [];
const forkedEphemeral = await createCodexEphemeralThread({
  state,
  profile,
  cwd: process.cwd(),
  sourceThreadId: 'source-thread',
  sourceTurnId: 'source-turn',
  spawnProcess() {
    return new FakeProcess((message, child) => {
      forkedEphemeralProtocol.push(message);
      if (message.method === 'initialize') child.send({ id: message.id, result: {} });
      if (message.method === 'thread/fork')
        child.send({ id: message.id, result: { thread: { id: 'forked-ephemeral-thread' } } });
    });
  }
});
assert.equal(forkedEphemeral.threadId, 'forked-ephemeral-thread');
assert.deepEqual(forkedEphemeralProtocol.find((item) => item.method === 'thread/fork').params, {
  threadId: 'source-thread',
  turnId: 'source-turn',
  cwd: process.cwd(),
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandbox: 'read-only',
  ephemeral: true
});
forkedEphemeral.close();

const recoveryProtocol = [],
  recoveryEvents = [];
const recovered = await runCodexAppServer({
  state,
  profile,
  prompt: 'recover stale thread',
  resumeId: 'stale-thread',
  cwd: process.cwd(),
  sandbox: 'read-only',
  spawnProcess: () =>
    new FakeProcess((message, child) => {
      recoveryProtocol.push(message);
      if (message.method === 'initialize') return child.send({ id: message.id, result: { userAgent: 'fake' } });
      if (message.method === 'thread/resume')
        return child.send({ id: message.id, error: { message: 'thread not found: stale-thread' } });
      if (message.method === 'thread/start')
        return child.send({ id: message.id, result: { thread: { id: 'recovered-thread' } } });
      if (message.method === 'turn/start') {
        child.send({ id: message.id, result: { turn: { id: 'recovered-turn', status: 'inProgress' } } });
        setImmediate(() =>
          child.send({ method: 'turn/completed', params: { turn: { id: 'recovered-turn', status: 'completed' } } })
        );
      }
    }),
  onEvent: (event) => recoveryEvents.push(event)
});
assert.equal(recovered.thread_id, 'recovered-thread');
assert.deepEqual(
  recoveryProtocol.filter((item) => item.method?.startsWith('thread/')).map((item) => item.method),
  ['thread/resume', 'thread/start']
);
assert.equal(
  recoveryEvents.some((item) => item.type === 'thread.recreated'),
  true
);
assert.equal(isCodexThreadUnavailable(new Error('no rollout found for thread id stale-thread')), true);
assert.equal(isCodexThreadUnavailable(new Error('endpoint unavailable')), false);

const coalesced = await runCodexAppServer({
  state,
  profile,
  prompt: 'coalesced turn response and completion',
  cwd: process.cwd(),
  sandbox: 'read-only',
  spawnProcess: () =>
    new FakeProcess((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { userAgent: 'fake' } });
      if (message.method === 'thread/start')
        child.send({ id: message.id, result: { thread: { id: 'coalesced-thread' } } });
      if (message.method === 'turn/start') {
        const response = { id: message.id, result: { turn: { id: 'coalesced-turn', status: 'inProgress' } } };
        const completed = {
          method: 'turn/completed',
          params: { turn: { id: 'coalesced-turn', status: 'completed' } }
        };
        queueMicrotask(() =>
          child.stdout.emit('data', Buffer.from(`${JSON.stringify(response)}\n${JSON.stringify(completed)}\n`))
        );
      }
    })
});
assert.equal(coalesced.turn_id, 'coalesced-turn');

await assert.rejects(
  runCodexAppServer({
    state,
    profile,
    prompt: 'invalid turn request',
    cwd: process.cwd(),
    sandbox: 'read-only',
    spawnProcess: () =>
      new FakeProcess((message, child) => {
        if (message.method === 'initialize') child.send({ id: message.id, result: { userAgent: 'fake' } });
        if (message.method === 'thread/start')
          child.send({ id: message.id, result: { thread: { id: 'thread-invalid-turn' } } });
        if (message.method === 'turn/start')
          child.send({ id: message.id, error: { message: 'Invalid request: invalid type' } });
      })
  }),
  (error) => error.code === 'app_server_turn_failed' && /Invalid request/.test(error.message)
);

await assert.rejects(
  runCodexAppServer({
    state,
    profile,
    prompt: 'fail',
    cwd: process.cwd(),
    sandbox: 'read-only',
    spawnProcess: () =>
      new FakeProcess((message, child) => {
        if (message.method === 'initialize') child.send({ id: message.id, error: { message: 'unsupported protocol' } });
      })
  }),
  (error) => error.code === 'app_server_start_failed' && /unsupported protocol/.test(error.message)
);
await assert.rejects(
  runCodexAppServer({
    state,
    profile,
    prompt: 'plan',
    cwd: process.cwd(),
    sandbox: 'read-only',
    mode: 'plan',
    spawnProcess: () =>
      new FakeProcess((message, child) => {
        if (message.method === 'initialize') child.send({ id: message.id, result: { userAgent: 'fake' } });
        if (message.method === 'collaborationMode/list')
          child.send({ id: message.id, result: { data: [{ name: 'Default', mode: 'default' }] } });
      })
  }),
  (error) => error.code === 'native_plan_unavailable'
);
let resolveLateTool,
  unhandled = null;
const abortController = new AbortController();
const unhandledListener = (error) => {
  unhandled = error;
};
process.once('unhandledRejection', unhandledListener);
const lateToolTurn = runCodexAppServer({
  state,
  profile,
  prompt: 'late tool result',
  cwd: process.cwd(),
  sandbox: 'read-only',
  signal: abortController.signal,
  spawnProcess: () =>
    new FakeProcess((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { userAgent: 'fake' } });
      if (message.method === 'thread/start')
        child.send({ id: message.id, result: { thread: { id: 'thread-late-tool' } } });
      if (message.method === 'turn/start') {
        child.send({ id: message.id, result: { turn: { id: 'turn-late-tool', status: 'inProgress' } } });
        setImmediate(() => child.send({ id: 'late-tool', method: 'item/tool/call', params: { callId: 'late-tool' } }));
      }
    }),
  onDynamicTool: () =>
    new Promise((resolve) => {
      resolveLateTool = resolve;
    })
});
while (!resolveLateTool) await new Promise((resolve) => setImmediate(resolve));
abortController.abort();
await assert.rejects(lateToolTurn, (error) => error.code === 'app_server_turn_failed');
resolveLateTool({ success: true, contentItems: [] });
await new Promise((resolve) => setImmediate(resolve));
process.removeListener('unhandledRejection', unhandledListener);
assert.equal(unhandled, null);
console.log('Codex app-server protocol unit tests passed');

function handleProtocol(message, child) {
  protocol.push(message);
  if (message.method === 'initialize') return child.send({ id: message.id, result: { userAgent: 'fake' } });
  if (message.method === 'collaborationMode/list')
    return child.send({
      id: message.id,
      result: { data: [{ name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' }] }
    });
  if (message.method === 'thread/start') return child.send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  if (message.method === 'turn/start') {
    child.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    setImmediate(() => {
      child.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Hello' }
      });
      child.send({ method: 'item/reasoning/textDelta', params: { itemId: 'reason-1', delta: 'PRIVATE_REASONING' } });
      child.send({
        method: 'item/reasoning/summaryTextDelta',
        params: { itemId: 'reason-1', summaryIndex: 0, delta: '公开摘要' }
      });
      child.send({ method: 'turn/plan/updated', params: { plan: [{ step: 'Run tests', status: 'inProgress' }] } });
      child.send({
        id: 'approval-command',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'pnpm test', cwd: process.cwd() }
      });
      child.send({
        id: 'approval-file',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', grantRoot: process.cwd() }
      });
      child.send({
        id: 'approval-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'perm-1',
          permissions: { network: { enabled: true }, fileSystem: null }
        }
      });
      child.send({
        id: 'dynamic-tool',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: null,
          tool: 'exec',
          arguments: {}
        }
      });
    });
    return;
  }
  if (message.id && !message.method) {
    responses.set(message.id, message.result);
    if (responses.size === 4)
      setImmediate(() => {
        child.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'pnpm test',
              status: 'completed',
              exitCode: 0,
              aggregatedOutput: 'passed'
            }
          }
        });
        child.send({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'reasoning', id: 'reason-1', summary: ['公开摘要完成'], content: ['PRIVATE_REASONING'] }
          }
        });
        child.send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
      });
  }
}
