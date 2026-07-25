import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.144.0\n');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write('app-server exec --json resume reasoning summary\n');
  process.exit(0);
}

const home = process.env.CODEX_HOME || process.cwd();
const goalFile = path.join(home, 'fake-goal.json');
const logFile = path.join(home, 'fake-protocol.jsonl');
const threadId = 'fake-native-thread-v15';
let activeThreadId = threadId;
let nativeTurnSequence = 0;
let forkSequence = 0;
let activeTurnId = null;
const pendingServerRequests = new Map();
fs.mkdirSync(home, { recursive: true });

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  append({ direction: 'from_aiws', message });
  handle(message);
});

function handle(message) {
  if (message.id !== undefined && !message.method) return handleServerResponse(message);
  if (message.method === 'initialized') return;
  if (handleDiscoveryRequest(message)) return;
  if (handleThreadRequest(message)) return;
  if (handleGoalRequest(message)) return;
  if (message.method === 'turn/interrupt') return reply(message.id, {});
  if (message.method !== 'turn/start') return reply(message.id, {});

  activeTurnId = `fake-turn-${process.pid}-${++nativeTurnSequence}`;
  reply(message.id, { turn: { id: activeTurnId, status: 'inProgress' } });
  const prompt = (message.params?.input || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  setTimeout(() => startTurnScenario(prompt), 15);
}

function handleDiscoveryRequest(message) {
  if (message.method === 'initialize') {
    reply(message.id, { userAgent: 'aiws-v15-integration-fixture' });
    return true;
  }
  if (message.method === 'collaborationMode/list') {
    reply(message.id, {
      data: [
        { name: 'Default', mode: 'default' },
        { name: 'Plan', mode: 'plan' }
      ]
    });
    return true;
  }
  if (message.method !== 'model/list') return false;
  reply(message.id, {
    data: [
      {
        id: 'gpt-v15-native',
        model: 'gpt-v15-native',
        displayName: 'V1.5 Native',
        description: 'integration fixture',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'max',
        supportedReasoningEfforts: [
          { reasoningEffort: 'max', description: 'maximum' },
          { reasoningEffort: 'ultra', description: 'ultra' }
        ]
      }
    ],
    nextCursor: null
  });
  return true;
}

function handleThreadRequest(message) {
  if (message.method === 'thread/start') {
    activeThreadId = threadId;
    reply(message.id, { thread: { id: activeThreadId } });
    return true;
  }
  if (message.method === 'thread/resume') {
    if (message.params?.threadId === 'missing-native-thread')
      replyError(message.id, 'no rollout found for thread id missing-native-thread');
    else {
      activeThreadId = message.params?.threadId || threadId;
      reply(message.id, { thread: { id: activeThreadId } });
    }
    return true;
  }
  if (message.method === 'thread/fork') {
    if (message.params?.turnId === 'fork-failure-turn') replyError(message.id, 'fixture fork failure');
    else {
      activeThreadId = `fake-native-fork-${process.pid}-${++forkSequence}`;
      reply(message.id, { thread: { id: activeThreadId }, ephemeral: message.params?.ephemeral === true });
    }
    return true;
  }
  if (message.method !== 'thread/delete') return false;
  reply(message.id, { deleted: true, threadId: activeThreadId });
  return true;
}

function handleGoalRequest(message) {
  if (message.method === 'thread/goal/set') {
    const previous = readGoal();
    const goal = {
      objective: message.params?.objective ?? previous?.objective ?? '',
      status: message.params?.status ?? previous?.status ?? 'active',
      tokenBudget: message.params?.tokenBudget ?? previous?.tokenBudget ?? null,
      tokensUsed: previous?.tokensUsed ?? 17,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 3,
      createdAt: previous?.createdAt || new Date(0).toISOString(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(goalFile, JSON.stringify(goal));
    reply(message.id, { goal });
    return true;
  }
  if (message.method === 'thread/goal/get') {
    reply(message.id, { goal: readGoal() });
    return true;
  }
  if (message.method !== 'thread/goal/clear') return false;
  fs.rmSync(goalFile, { force: true });
  reply(message.id, {});
  return true;
}

function startTurnScenario(prompt) {
  if (prompt.includes('SLOW_TURN')) return setTimeout(() => finishTurn('native slow turn completed'), 1000);
  if (prompt.includes('ASK_INPUT')) {
    const id = `request-user-input-${process.pid}`;
    pendingServerRequests.set(id, 'user-input');
    return send({
      id,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId: 'native-question-v15',
        requestId: 'request-v15',
        autoResolutionMs: 120000,
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Choose the integration answer',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'alpha', description: 'Use alpha' },
              { label: 'beta', description: 'Use beta' }
            ]
          }
        ]
      }
    });
  }
  if (prompt.includes('PAGE_TOOL')) {
    const id = `dynamic-tool-${process.pid}`;
    pendingServerRequests.set(id, 'dynamic-tool');
    return send({
      id,
      method: 'item/tool/call',
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        callId: 'native-page-call-v15',
        namespace: 'aiws_page',
        tool: 'set_field',
        arguments: { target_id: 'brief.goal', value: 'native tool value' }
      }
    });
  }
  finishTurn('native turn completed');
}

function handleServerResponse(message) {
  const kind = pendingServerRequests.get(message.id);
  if (!kind) return;
  pendingServerRequests.delete(message.id);
  if (kind === 'user-input') {
    const answer = message.result?.answers?.choice?.answers?.[0] || 'empty';
    send({ method: 'turn/plan/updated', params: { plan: [{ step: `Use ${answer}`, status: 'completed' }] } });
    return finishTurn(`native input answer:${answer}`);
  }
  const success = message.result?.success === true;
  finishTurn(success ? 'native page tool committed' : 'native page tool failed');
}

function finishTurn(text) {
  send({
    method: 'item/agentMessage/delta',
    params: { threadId: activeThreadId, turnId: activeTurnId, itemId: 'message-v15', delta: text }
  });
  send({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: activeThreadId,
      turnId: activeTurnId,
      itemId: 'reason-v15',
      summaryIndex: 0,
      delta: 'public native summary'
    }
  });
  send({
    method: 'turn/completed',
    params: { threadId: activeThreadId, turn: { id: activeTurnId, status: 'completed' } }
  });
}
function readGoal() {
  try {
    return JSON.parse(fs.readFileSync(goalFile, 'utf8'));
  } catch {
    return null;
  }
}
function reply(id, result) {
  send({ id, result });
}
function replyError(id, message) {
  send({ id, error: { message } });
}
function send(message) {
  append({ direction: 'to_aiws', message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function append(value) {
  fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`);
}
