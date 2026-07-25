import { spawn } from 'node:child_process';
import { AIWS_VERSION } from '../../../packages/shared/index.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { readSecret, redactKnownSecretsSync } from './vault.mjs';
import { assertProfileAllowed } from './container-runtime-config.mjs';
import { spawnContainerProcess } from './container-runtime.mjs';
import {
  appServerInvocation,
  approvalResponse,
  dynamicToolResponse,
  mapNotification,
  nativeAdditionalContext,
  nativeCollaborationMode,
  sandboxPolicy,
  taggedError
} from './codex-app-server.mjs';
import { withCodexRuntimeStateRecovery } from './codex-home-recovery.mjs';
import { resolveCodexTimeoutMs } from './codex-timeout.mjs';

export async function createCodexEphemeralThread(options) {
  return withCodexRuntimeStateRecovery(options.profile, () => createCodexEphemeralThreadOnce(options));
}

async function createCodexEphemeralThreadOnce({
  state,
  profile,
  cwd,
  sourceThreadId,
  sourceTurnId,
  additionalContext = [],
  signal,
  spawnProcess = spawn
}) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile))
    throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential),
    invocation = appServerInvocation(profile, cwd, 'read-only', credential, [], null);
  let child;
  try {
    child =
      invocation.runtime === 'docker'
        ? spawnContainerProcess(invocation, { cwd, env: invocation.env, spawnProcess })
        : spawnProcess(invocation.command, invocation.args, {
            cwd,
            env: invocation.env,
            shell: false,
            windowsHide: true
          });
  } catch (error) {
    throw taggedError(error.message, 'app_server_start_failed');
  }
  const context = createEphemeralContext({
    profile,
    additionalContext,
    child,
    runtimeCwd: invocation.cwd || cwd
  });
  attachEphemeralListeners(context);
  const abortInitialize = () => closeEphemeralThread(context),
    initializeTimer = setTimeout(
      () =>
        terminateEphemeralContext(
          context,
          taggedError('codex_ephemeral_initialize_timeout', 'app_server_start_failed')
        ),
      resolveCodexTimeoutMs(profile.timeout_ms)
    );
  if (signal?.aborted) abortInitialize();
  else signal?.addEventListener('abort', abortInitialize, { once: true });
  try {
    await initializeEphemeralThread(context, sourceThreadId, sourceTurnId);
  } catch (error) {
    closeEphemeralThread(context);
    throw error;
  } finally {
    clearTimeout(initializeTimer);
    signal?.removeEventListener('abort', abortInitialize);
  }
  return createEphemeralClient(context);
}

function createEphemeralContext({ profile, additionalContext, child, runtimeCwd }) {
  return {
    profile,
    additionalContext,
    child,
    runtimeCwd,
    buffer: '',
    stderr: '',
    closed: false,
    requestId: 0,
    threadId: null,
    active: null,
    pending: new Map()
  };
}

function attachEphemeralListeners(context) {
  context.child.stdout.on('data', (chunk) => consumeEphemeralChunk(context, chunk));
  context.child.stderr.on('data', (chunk) => {
    context.stderr = (context.stderr + redactKnownSecretsSync(chunk)).slice(-16000);
  });
  context.child.on('error', (error) =>
    terminateEphemeralContext(context, taggedError(error.message, 'app_server_turn_failed'))
  );
  context.child.on('close', (code) =>
    closeEphemeralContext(
      context,
      taggedError(context.stderr || `codex_app_server_exit_${code}`, 'app_server_turn_failed')
    )
  );
}

async function initializeEphemeralThread(context, sourceThreadId, sourceTurnId) {
  await ephemeralRequest(context, 'initialize', {
    clientInfo: { name: 'aiws', title: 'AI Workspace', version: AIWS_VERSION },
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
  ephemeralNotify(context, 'initialized');
  const threadOptions = {
    cwd: context.runtimeCwd,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    ephemeral: true
  };
  const opened = sourceThreadId
    ? await ephemeralRequest(context, 'thread/fork', {
        threadId: sourceThreadId,
        ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
        ...threadOptions
      })
    : await ephemeralRequest(context, 'thread/start', {
        model: context.profile.model || null,
        ...threadOptions
      });
  context.threadId = opened?.thread?.id || opened?.threadId || opened?.thread_id;
  if (!context.threadId || (sourceThreadId && context.threadId === sourceThreadId))
    throw taggedError('app_server_ephemeral_thread_missing', 'app_server_start_failed');
}

function createEphemeralClient(context) {
  return {
    get threadId() {
      return context.threadId;
    },
    get busy() {
      return Boolean(context.active);
    },
    sendTurn(input) {
      return sendEphemeralTurn(context, input);
    },
    close() {
      closeEphemeralThread(context);
    }
  };
}

async function sendEphemeralTurn(context, { prompt, userInput, onEvent, signal }) {
  if (context.closed) throw taggedError('app_server_closed', 'app_server_turn_failed');
  if (context.active) throw taggedError('app_server_ephemeral_turn_busy', 'app_server_turn_failed');
  let resolveTurn, rejectTurn;
  const completion = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const abort = () => interruptEphemeralTurn(context, 'codex_ephemeral_turn_interrupted');
  context.active = {
    turnId: null,
    output: '',
    onEvent,
    deltaItems: new Set(),
    resolve: resolveTurn,
    reject: rejectTurn,
    timer: null,
    signal,
    abort
  };
  context.active.timer = setTimeout(
    () => interruptEphemeralTurn(context, 'codex_ephemeral_turn_timeout'),
    resolveCodexTimeoutMs(context.profile.timeout_ms)
  );
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const started = await ephemeralRequest(context, 'turn/start', ephemeralTurnParams(context, prompt, userInput));
    if (context.active) context.active.turnId = started?.turn?.id || context.active.turnId;
    if (!context.active?.turnId) throw taggedError('app_server_turn_missing', 'app_server_turn_failed');
  } catch (error) {
    finishEphemeralActive(context, error);
  }
  return completion;
}

function ephemeralTurnParams(context, prompt, userInput) {
  return {
    threadId: context.threadId,
    input: userInput?.length ? userInput : [{ type: 'text', text: String(prompt || ''), text_elements: [] }],
    additionalContext: nativeAdditionalContext(context.additionalContext),
    cwd: context.runtimeCwd,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicy('read-only', context.runtimeCwd),
    collaborationMode: nativeCollaborationMode('default', context.profile),
    summary: 'concise'
  };
}

function interruptEphemeralTurn(context, message) {
  if (context.threadId && context.active?.turnId)
    void ephemeralRequest(context, 'turn/interrupt', {
      threadId: context.threadId,
      turnId: context.active.turnId
    }).catch(() => undefined);
  finishEphemeralActive(context, taggedError(message, 'app_server_turn_failed'));
}

function ephemeralRequest(context, method, params) {
  if (context.closed || !context.child.stdin?.writable)
    return Promise.reject(taggedError('app_server_stdin_closed', 'app_server_turn_failed'));
  const requestKey = ++context.requestId;
  return new Promise((resolve, reject) => {
    context.pending.set(requestKey, { resolve, reject });
    context.child.stdin.write(`${JSON.stringify({ method, id: requestKey, params })}\n`);
  });
}

function ephemeralNotify(context, method, params) {
  if (context.child.stdin?.writable)
    context.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
}

function consumeEphemeralChunk(context, chunk) {
  context.buffer += chunk.toString();
  const lines = context.buffer.split(/\r?\n/);
  context.buffer = lines.pop() || '';
  for (const line of lines) consumeEphemeralLine(context, line);
}

function consumeEphemeralLine(context, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && !message.method) return resolveEphemeralResponse(context, message);
  if (message.id !== undefined && message.method) {
    answerEphemeralServerRequest(context, message);
    return;
  }
  if (!context.active) return;
  const mapped = mapNotification(message, context.active.deltaItems);
  if (mapped) {
    if (mapped.output_text) context.active.output += mapped.output_text;
    context.active.onEvent?.(mapped);
  }
  if (
    message.method === 'turn/completed' &&
    (!context.active.turnId || message.params?.turn?.id === context.active.turnId)
  )
    completeEphemeralTurn(context, message.params?.turn);
}

function resolveEphemeralResponse(context, message) {
  const target = context.pending.get(message.id);
  if (!target) return;
  context.pending.delete(message.id);
  if (message.error)
    target.reject(taggedError(message.error.message || 'app_server_rpc_error', 'app_server_turn_failed'));
  else target.resolve(message.result);
}

function completeEphemeralTurn(context, turn) {
  const status = turn?.status;
  if (status !== 'completed') {
    finishEphemeralActive(
      context,
      taggedError(turn?.error?.message || `app_server_turn_${status}`, 'app_server_turn_failed')
    );
    return;
  }
  finishEphemeralActive(context, null, {
    ok: true,
    thread_id: context.threadId,
    turn_id: context.active.turnId,
    output_text: context.active.output,
    transport: 'app-server'
  });
}

function answerEphemeralServerRequest(context, message) {
  if (!context.child.stdin?.writable) return;
  const result =
    message.method === 'item/tool/call'
      ? dynamicToolResponse({ success: false, message: 'assist_btw_tools_disabled' })
      : message.method === 'item/tool/requestUserInput'
        ? { answers: {} }
        : approvalResponse(message.method, false, message.params || {});
  context.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
}

function finishEphemeralActive(context, error, result) {
  const current = context.active;
  if (!current) return;
  context.active = null;
  clearTimeout(current.timer);
  current.signal?.removeEventListener('abort', current.abort);
  error ? current.reject(error) : current.resolve(result);
}

function closeEphemeralContext(context, error) {
  if (context.closed) return;
  context.closed = true;
  for (const item of context.pending.values()) item.reject(error);
  context.pending.clear();
  finishEphemeralActive(context, error);
}

function terminateEphemeralContext(context, error) {
  closeEphemeralContext(context, error);
  if (context.child.exitCode === null && !context.child.killed) context.child.kill();
}

function closeEphemeralThread(context) {
  if (context.closed) {
    if (context.child.exitCode === null && !context.child.killed) context.child.kill();
    return;
  }
  if (context.threadId && context.active?.turnId)
    void ephemeralRequest(context, 'turn/interrupt', {
      threadId: context.threadId,
      turnId: context.active.turnId
    }).catch(() => undefined);
  terminateEphemeralContext(context, taggedError('app_server_closed', 'app_server_turn_failed'));
}
