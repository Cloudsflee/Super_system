import { spawn } from 'node:child_process';
import { AIWS_VERSION } from '../../../packages/shared/index.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { readSecret, redactKnownSecretsSync } from './vault.mjs';
import { assertProfileAllowed } from './container-runtime-config.mjs';
import { spawnContainerProcess } from './container-runtime.mjs';
import {
  appServerInvocation, approvalResponse, dynamicToolResponse, mapNotification,
  nativeAdditionalContext, nativeCollaborationMode, sandboxPolicy, taggedError
} from './codex-app-server.mjs';
import { withCodexRuntimeStateRecovery } from './codex-home-recovery.mjs';
import { issueCodexMcpAccess } from './codex-mcp-runtime.mjs';

export async function createCodexEphemeralThread(options) {
  return withCodexRuntimeStateRecovery(options.profile, () => createCodexEphemeralThreadOnce(options));
}

async function createCodexEphemeralThreadOnce({ state, profile, cwd, sourceThreadId, sourceTurnId, projectId = null, additionalContext = [], signal, spawnProcess = spawn }) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential), mcpAccess = await issueCodexMcpAccess(projectId, profile, { ttlSeconds: Math.ceil(Number(profile.timeout_ms || 120000) / 1000) + 1200 }), invocation = appServerInvocation(profile, cwd, 'read-only', credential, [], mcpAccess);
  let child;
  try {
    child = invocation.runtime === 'docker'
      ? spawnContainerProcess(invocation, { cwd, env: invocation.env, spawnProcess })
      : spawnProcess(invocation.command, invocation.args, { cwd, env: invocation.env, shell: false, windowsHide: true });
  } catch (error) { await mcpAccess?.release(); throw taggedError(error.message, 'app_server_start_failed'); }

  let buffer = '', stderr = '', closed = false, requestId = 0, threadId = null, active = null;
  const pending = new Map(), runtimeCwd = invocation.cwd || cwd;
  const closeError = (error) => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) item.reject(error); pending.clear();
    finishActive(error);
    void mcpAccess?.release();
  };
  const terminate = (error) => { closeError(error); if (child.exitCode === null && !child.killed) child.kill(); };
  child.stdout.on('data', (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) consume(line); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + redactKnownSecretsSync(chunk)).slice(-16000); });
  child.on('error', (error) => terminate(taggedError(error.message, 'app_server_turn_failed')));
  child.on('close', (code) => closeError(taggedError(stderr || `codex_app_server_exit_${code}`, 'app_server_turn_failed')));
  const abortInitialize = () => close(), initializeTimer = setTimeout(() => terminate(taggedError('codex_ephemeral_initialize_timeout', 'app_server_start_failed')), Math.max(1000, Math.min(300000, Number(profile.timeout_ms || 120000))));
  if (signal?.aborted) abortInitialize(); else signal?.addEventListener('abort', abortInitialize, { once: true });

  try {
    await request('initialize', { clientInfo: { name: 'aiws', title: 'AI Workspace', version: AIWS_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
    notify('initialized');
    const forked = await request('thread/fork', { threadId: sourceThreadId, ...(sourceTurnId ? { turnId: sourceTurnId } : {}), cwd: runtimeCwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true });
    threadId = forked?.thread?.id || forked?.threadId || forked?.thread_id;
    if (!threadId || threadId === sourceThreadId) throw taggedError('app_server_ephemeral_thread_missing', 'app_server_start_failed');
  } catch (error) {
    close(); throw error;
  } finally {
    clearTimeout(initializeTimer); signal?.removeEventListener('abort', abortInitialize);
  }

  return {
    get threadId() { return threadId; }, get busy() { return Boolean(active); },
    async sendTurn({ prompt, userInput, onEvent, signal: turnSignal }) {
      if (closed) throw taggedError('app_server_closed', 'app_server_turn_failed');
      if (active) throw taggedError('app_server_ephemeral_turn_busy', 'app_server_turn_failed');
      const deltaItems = new Set(); let resolveTurn, rejectTurn;
      const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      const timeout = Math.max(1000, Math.min(300000, Number(profile.timeout_ms || 120000)));
      const abort = () => { if (threadId && active?.turnId) void request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => undefined); finishActive(taggedError('codex_ephemeral_turn_interrupted', 'app_server_turn_failed')); };
      active = { turnId: null, output: '', onEvent, deltaItems, resolve: resolveTurn, reject: rejectTurn, timer: null, signal: turnSignal, abort };
      active.timer = setTimeout(() => {
        if (threadId && active?.turnId) void request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => undefined);
        finishActive(taggedError('codex_ephemeral_turn_timeout', 'app_server_turn_failed'));
      }, timeout);
      if (turnSignal?.aborted) abort(); else turnSignal?.addEventListener('abort', abort, { once: true });
      try {
        const started = await request('turn/start', {
          threadId, input: userInput?.length ? userInput : [{ type: 'text', text: String(prompt || ''), text_elements: [] }],
          additionalContext: nativeAdditionalContext(additionalContext), cwd: runtimeCwd, approvalPolicy: 'never', approvalsReviewer: 'user',
          sandboxPolicy: sandboxPolicy('read-only', runtimeCwd), collaborationMode: nativeCollaborationMode('default', profile), summary: 'concise'
        });
        if (active) active.turnId = started?.turn?.id || active.turnId;
        if (!active?.turnId) throw taggedError('app_server_turn_missing', 'app_server_turn_failed');
      } catch (error) { finishActive(error); }
      return completion;
    },
    close
  };

  function request(method, params) {
    if (closed || !child.stdin?.writable) return Promise.reject(taggedError('app_server_stdin_closed', 'app_server_turn_failed'));
    const requestKey = ++requestId;
    return new Promise((resolve, reject) => { pending.set(requestKey, { resolve, reject }); child.stdin.write(`${JSON.stringify({ method, id: requestKey, params })}\n`); });
  }
  function notify(method, params) { if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`); }
  function consume(line) {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) { const target = pending.get(message.id); if (!target) return; pending.delete(message.id); if (message.error) target.reject(taggedError(message.error.message || 'app_server_rpc_error', 'app_server_turn_failed')); else target.resolve(message.result); return; }
    if (message.id !== undefined && message.method) { answerServerRequest(message); return; }
    if (!active) return;
    const mapped = mapNotification(message, active.deltaItems);
    if (mapped) { if (mapped.output_text) active.output += mapped.output_text; active.onEvent?.(mapped); }
    if (message.method !== 'turn/completed' || (active.turnId && message.params?.turn?.id !== active.turnId)) return;
    const status = message.params?.turn?.status;
    if (status !== 'completed') finishActive(taggedError(message.params?.turn?.error?.message || `app_server_turn_${status}`, 'app_server_turn_failed'));
    else finishActive(null, { ok: true, thread_id: threadId, turn_id: active.turnId, output_text: active.output, transport: 'app-server' });
  }
  function answerServerRequest(message) {
    if (!child.stdin?.writable) return;
    const result = message.method === 'item/tool/call' ? dynamicToolResponse({ success: false, message: 'assist_btw_tools_disabled' }) : message.method === 'item/tool/requestUserInput' ? { answers: {} } : approvalResponse(message.method, false, message.params || {});
    child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }
  function finishActive(error, result) { const current = active; if (!current) return; active = null; clearTimeout(current.timer); current.signal?.removeEventListener('abort', current.abort); error ? current.reject(error) : current.resolve(result); }
  function close() { if (closed) { if (child.exitCode === null && !child.killed) child.kill(); return; } if (threadId && active?.turnId) void request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => undefined); terminate(taggedError('app_server_closed', 'app_server_turn_failed')); }
}
