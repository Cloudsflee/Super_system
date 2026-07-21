import path from 'node:path';
import { spawn } from 'node:child_process';
import { AIWS_VERSION } from '../../../packages/shared/index.mjs';
import { AIWS_HOME } from './config.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { readSecret, redactKnownSecretsSync } from './vault.mjs';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
import { assertProfileAllowed, buildCodexContainerInvocation } from './container-runtime-config.mjs';
import { spawnContainerProcess } from './container-runtime.mjs';
import { withCodexRuntimeStateRecovery } from './codex-home-recovery.mjs';
import { codexMcpConfigArgs, issueCodexMcpAccess, withCodexMcpEnvironment } from './codex-mcp-runtime.mjs';
import { codexTimeoutTtlSeconds, resolveCodexTimeoutMs } from './codex-timeout.mjs';

const APP_SERVER_ARGS = ['app-server', '--stdio', '--disable', 'code_mode_host', '--disable', 'plugins', '--disable', 'apps'];

export async function runCodexAppServer(options) {
  return withCodexRuntimeStateRecovery(options.profile, () => runCodexAppServerOnce(options));
}

async function runCodexAppServerOnce({ state, profile, prompt, userInput, additionalContext = [], dynamicTools = [], attachmentMounts = [], cwd, resumeId, sandbox, mode = 'default', projectId = null, onEvent, onApproval, onUserInput, onDynamicTool, signal, spawnProcess = spawn }) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential), mcpAccess = await issueCodexMcpAccess(projectId, profile, { ttlSeconds: codexTimeoutTtlSeconds(profile.timeout_ms) }), invocation = appServerInvocation(profile, cwd, sandbox, credential, attachmentMounts, mcpAccess);
  try { return await new Promise((resolve, reject) => {
    let child;
    try {
      child = invocation.runtime === 'docker'
        ? spawnContainerProcess(invocation, { cwd, env: invocation.env, spawnProcess })
        : spawnProcess(invocation.command, invocation.args, { cwd, env: invocation.env, shell: false, windowsHide: true });
    }
    catch (error) { reject(taggedError(error.message, 'app_server_start_failed')); return; }
    let buffer = '', stderr = '', settled = false, requestId = 0, threadId = resumeId || null, turnId = null, turnStarted = false;
    const pending = new Map(), deltaItems = new Set();
    const timer = setTimeout(() => finish(taggedError('codex_app_server_timeout', turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')), resolveCodexTimeoutMs(profile.timeout_ms));
    const abort = () => { if (threadId && turnId) void request('turn/interrupt', { threadId, turnId }).catch(() => undefined); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) consume(line); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + redactKnownSecretsSync(chunk)).slice(-16000); });
    child.on('error', (error) => finish(taggedError(error.message, turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')));
    child.on('close', (code) => { if (!settled) finish(taggedError(stderr || `codex_app_server_exit_${code}`, turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')); });
    start().catch((error) => finish(error));

    async function start() {
      await request('initialize', { clientInfo: { name: 'aiws', title: 'AI Workspace', version: AIWS_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
      notify('initialized');
      if (mode === 'plan') {
        let available;
        try { available = await request('collaborationMode/list', {}); }
        catch { throw taggedError('codex_native_plan_unavailable', 'native_plan_unavailable'); }
        if (!available?.data?.some((item) => item?.mode === 'plan')) throw taggedError('codex_native_plan_unavailable', 'native_plan_unavailable');
      }
      const runtimeCwd = invocation.cwd || cwd;
      const threadOptions = { cwd: runtimeCwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox, dynamicTools };
      let thread;
      if (resumeId) {
        try { thread = await request('thread/resume', { threadId: resumeId, ...threadOptions }); }
        catch (error) {
          if (!isCodexThreadUnavailable(error)) throw error;
          thread = await request('thread/start', { model: profile.model || null, ...threadOptions, ephemeral: false });
          onEvent?.({ type: 'thread.recreated' });
        }
      } else {
        thread = await request('thread/start', { model: profile.model || null, ...threadOptions, ephemeral: false });
      }
      threadId = thread.thread?.id || resumeId; if (!threadId) throw taggedError('app_server_thread_missing', 'app_server_start_failed');
      onEvent?.({ type: 'thread.started', thread_id: threadId });
      turnStarted = true;
      const started = await request('turn/start', { threadId, input: userInput?.length ? userInput : [{ type: 'text', text: prompt, text_elements: [] }], additionalContext: nativeAdditionalContext(additionalContext), cwd: runtimeCwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: sandboxPolicy(sandbox, runtimeCwd), collaborationMode: nativeCollaborationMode(mode, profile), summary: 'concise' });
      turnId = started.turn?.id; if (!turnId) throw taggedError('app_server_turn_missing', 'app_server_turn_failed');
    }
    function request(method, params) {
      const id = ++requestId;
      return new Promise((resolveRequest, rejectRequest) => { pending.set(id, { resolve: resolveRequest, reject: rejectRequest }); write({ method, id, params }); });
    }
    function notify(method, params) { write(params === undefined ? { method } : { method, params }); }
    function write(message) { if (!child.stdin?.writable) throw taggedError('app_server_stdin_closed', turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed'); child.stdin.write(`${JSON.stringify(message)}\n`); }
    function consume(line) {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) { const target = pending.get(message.id); if (!target) return; pending.delete(message.id); if (message.error) target.reject(taggedError(message.error.message || 'app_server_rpc_error', turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')); else target.resolve(message.result); return; }
      if (message.id !== undefined && message.method) { void answerServerRequest(message).catch((error) => { if (!settled) finish(error); }); return; }
      const mapped = mapNotification(message, deltaItems); if (mapped) onEvent?.(mapped);
      if (message.method === 'turn/completed' && (!turnId || message.params?.turn?.id === turnId)) {
        const status = message.params?.turn?.status;
        if (status !== 'completed') return finish(taggedError(message.params?.turn?.error?.message || `app_server_turn_${status}`, 'app_server_turn_failed'));
        finish(null, { ok: true, code: 0, stdout: '', stderr, thread_id: threadId, turn_id: turnId, transport: 'app-server' });
      }
    }
    async function answerServerRequest(message) {
      try {
        if (message.method === 'item/tool/requestUserInput') {
          const result = await onUserInput?.(message.params || {});
          if (!result || typeof result.answers !== 'object') throw taggedError('request_user_input_unhandled', 'app_server_turn_failed');
          write({ id: message.id, result: { answers: result.answers } }); return;
        }
        if (message.method === 'item/tool/call') {
          const result = await onDynamicTool?.(message.params || {});
          write({ id: message.id, result: dynamicToolResponse(result) }); return;
        }
        const approval = approvalRequest(message), approved = approval ? await onApproval?.(approval) : false;
        write({ id: message.id, result: approvalResponse(message.method, approved === true || approved?.approved === true, message.params) });
      } catch (error) {
        if (settled) return;
        if (message.method === 'item/tool/requestUserInput') { finish(error); return; }
        if (message.method === 'item/tool/call') { write({ id: message.id, result: dynamicToolResponse({ success: false, message: publicToolError(error) }) }); return; }
        write({ id: message.id, result: approvalResponse(message.method, false, message.params) });
      }
    }
    function finish(error, result) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); for (const item of pending.values()) item.reject(error || taggedError('app_server_closed', 'app_server_turn_failed')); pending.clear(); if (child.exitCode === null) child.kill(); error ? reject(error) : resolve(result);
    }
  }); } finally { await mcpAccess?.release(); }
}

export async function runCodexAppServerRpc(options) {
  return withCodexRuntimeStateRecovery(options.profile, () => runCodexAppServerRpcOnce(options));
}

async function runCodexAppServerRpcOnce({ state, profile, cwd, sandbox = 'read-only', resumeId = null, method, params = {}, createThread = false, projectId = null, signal, spawnProcess = spawn }) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential), mcpAccess = await issueCodexMcpAccess(projectId, profile, { ttlSeconds: codexTimeoutTtlSeconds(profile.timeout_ms) }), invocation = appServerInvocation(profile, cwd, sandbox, credential, [], mcpAccess);
  try { return await new Promise((resolve, reject) => {
    let child;
    try { child = invocation.runtime === 'docker' ? spawnContainerProcess(invocation, { cwd, env: invocation.env, spawnProcess }) : spawnProcess(invocation.command, invocation.args, { cwd, env: invocation.env, shell: false, windowsHide: true }); }
    catch (error) { reject(taggedError(error.message, 'app_server_start_failed')); return; }
    let buffer = '', stderr = '', settled = false, requestId = 0, threadId = resumeId;
    const pending = new Map();
    const timer = setTimeout(() => finish(taggedError('codex_app_server_control_timeout', 'app_server_turn_failed')), resolveCodexTimeoutMs(profile.timeout_ms));
    const abort = () => { child.kill(); finish(taggedError('codex_app_server_control_aborted', 'app_server_turn_failed')); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) consume(line); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + redactKnownSecretsSync(chunk)).slice(-16000); });
    child.on('error', (error) => finish(taggedError(error.message, 'app_server_start_failed')));
    child.on('close', (code) => { if (!settled) finish(taggedError(stderr || `codex_app_server_exit_${code}`, 'app_server_turn_failed')); });
    start().catch(finish);

    async function start() {
      await request('initialize', { clientInfo: { name: 'aiws', title: 'AI Workspace', version: AIWS_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
      notify('initialized');
      if (createThread && !threadId) {
        const runtimeCwd = invocation.cwd || cwd;
        const started = await request('thread/start', { model: profile.model || null, cwd: runtimeCwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox, ephemeral: false });
        threadId = started.thread?.id;
        if (!threadId) throw taggedError('app_server_thread_missing', 'app_server_start_failed');
      }
      const result = await request(method, { ...params, ...(threadId ? { threadId } : {}) });
      finish(null, { result, thread_id: threadId, transport: 'app-server' });
    }
    function request(requestMethod, requestParams) { const id = ++requestId; return new Promise((resolveRequest, rejectRequest) => { pending.set(id, { resolve: resolveRequest, reject: rejectRequest }); write({ method: requestMethod, id, params: requestParams }); }); }
    function notify(notificationMethod, notificationParams) { write(notificationParams === undefined ? { method: notificationMethod } : { method: notificationMethod, params: notificationParams }); }
    function write(message) { if (!child.stdin?.writable) throw taggedError('app_server_stdin_closed', 'app_server_start_failed'); child.stdin.write(`${JSON.stringify(message)}\n`); }
    function consume(line) { let message; try { message = JSON.parse(line); } catch { return; } if (message.id === undefined || message.method) return; const target = pending.get(message.id); if (!target) return; pending.delete(message.id); if (message.error) target.reject(taggedError(message.error.message || 'app_server_rpc_error', 'app_server_turn_failed')); else target.resolve(message.result); }
    function finish(error, result) { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); for (const item of pending.values()) item.reject(error || taggedError('app_server_closed', 'app_server_turn_failed')); pending.clear(); if (child.exitCode === null) child.kill(); error ? reject(error) : resolve(result); }
  }); } finally { await mcpAccess?.release(); }
}

export function appServerInvocation(profile, cwd, sandbox, credential, attachmentMounts = [], mcpAccess = null) {
  const proxy = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {}, env = withCodexMcpEnvironment({ ...process.env, ...proxy, CODEX_HOME: profile.codex_home }, mcpAccess), commandArgs = [...codexMcpConfigArgs(mcpAccess), ...APP_SERVER_ARGS];
  if (credential) env.OPENAI_API_KEY = credential;
  else delete env.OPENAI_API_KEY;
  if (profile.kind !== 'docker') return { ...prepareCodexInvocation(process.env.AIWS_CODEX_BIN || 'codex', commandArgs), env };
  const home = profile.codex_home || path.join(AIWS_HOME, 'codex-homes', profile.id);
  return {
    ...buildCodexContainerInvocation({
      kind: 'assist-app-server', sessionId: `rpc-${Date.now().toString(36)}`, profileId: profile.id,
      image: profile.image || profile.config?.image, stdin: true, codexHome: home,
      nestedSandbox: true,
      workspace: path.resolve(cwd), workspaceMode: sandbox === 'read-only' ? 'ro' : 'rw', extraMounts: [...(profile.mounts || []), ...attachmentMounts],
      containerEnv: { CODEX_HOME: '/codex-home', ...(credential ? { OPENAI_API_KEY: null } : {}), ...(mcpAccess?.containerEnv || {}), ...Object.fromEntries(Object.keys(proxy).map((key) => [key, null])) },
      commandArgs
    }), env
  };
}
export function sandboxPolicy(mode, cwd) { return mode === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }; }
function approvalRequest(message) { const params = message.params || {}; if (!/approval|elicitation/i.test(message.method)) return null; return { external_id: String(params.approvalId || params.itemId || message.id), approval_type: message.method, status: 'pending', command: params.command || null, path: params.grantRoot || params.cwd || null, host: params.networkApprovalContext?.host || null, tool: params.tool || null, request: params }; }
export function approvalResponse(method, approved, params) {
  if (method === 'item/commandExecution/requestApproval') return { decision: approved ? 'accept' : 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: approved ? 'accept' : 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: approved ? 'approved' : 'denied' };
  if (method === 'item/permissions/requestApproval') return { permissions: approved ? grantedPermissions(params.permissions) : {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: approved ? 'accept' : 'decline', content: null, _meta: null };
  return { success: false, contentItems: [] };
}
export function mapNotification(message, deltaItems) {
  const params = message.params || {}, item = params.item || {};
  if (message.method === 'item/agentMessage/delta') { deltaItems.add(params.itemId); return { aiws_type: 'text', data: { text: params.delta || '' }, output_text: params.delta || '' }; }
  if (message.method === 'item/plan/delta') return { aiws_type: 'plan', data: { text: params.delta || '', status: 'streaming', source: 'codex-native' } };
  if (message.method === 'item/reasoning/summaryTextDelta') return { aiws_type: 'reasoning_summary', data: { summary: params.delta || '' } };
  if (message.method === 'turn/plan/updated') return { aiws_type: 'plan', data: { text: (params.plan || []).map((step) => `${step.status}: ${step.step}`).join('\n'), status: 'updated', source: 'codex-native' } };
  if (message.method === 'turn/diff/updated') return { aiws_type: 'diff', data: { diff: params.diff || '', status: 'updated' } };
  if (message.method === 'item/commandExecution/outputDelta') return { aiws_type: 'command', data: { item_id: params.itemId, output: params.delta || '', status: 'running' } };
  if (message.method === 'item/fileChange/outputDelta' || message.method === 'item/fileChange/patchUpdated') return { aiws_type: 'file_change', data: { item_id: params.itemId, patch: params.delta || params.patch || '', status: 'running' } };
  if (message.method === 'thread/tokenUsage/updated') { const usage = params.tokenUsage?.total || {}; return { aiws_type: 'usage', data: { input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens, reasoning_output_tokens: usage.reasoningOutputTokens, total_tokens: usage.totalTokens } }; }
  if (message.method !== 'item/completed') return null;
  if (item.type === 'agentMessage') return deltaItems.has(item.id) ? null : { aiws_type: 'text', data: { text: item.text || '' }, output_text: item.text || '' };
  if (item.type === 'plan') return { aiws_type: 'plan', data: { text: item.text || '', status: 'completed', source: 'codex-native' } };
  if (item.type === 'commandExecution') return { aiws_type: 'command', data: { command: item.command, status: item.status, exit_code: item.exitCode, output: item.aggregatedOutput } };
  if (item.type === 'fileChange') return { aiws_type: 'file_change', data: { status: item.status, changes: item.changes || [] } };
  if (item.type === 'mcpToolCall') return { aiws_type: 'mcp', data: { server: item.server, tool: item.tool, status: item.status } };
  if (item.type === 'webSearch') return { aiws_type: 'search', data: { query: item.query || '', status: 'completed' } };
  if (item.type === 'reasoning' && Array.isArray(item.summary)) return { aiws_type: 'reasoning_summary', data: { summary: item.summary.join('\n') } };
  return null;
}
export function nativeCollaborationMode(mode, profile) {
  return {
    mode: mode === 'plan' ? 'plan' : 'default',
    settings: { model: String(profile?.model || ''), reasoning_effort: profile?.reasoning || null, developer_instructions: null }
  };
}
export function isCodexThreadUnavailable(error) {
  return /(?:thread not found|no rollout found for thread id)/i.test(String(error?.message || error || ''));
}
export function nativeAdditionalContext(entries) {
  const result = {};
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!entry || !['application', 'untrusted'].includes(entry.kind) || typeof entry.value !== 'string') continue;
    result[`aiws.${entry.kind}.${index + 1}`] = { kind: entry.kind, value: entry.value };
  }
  return result;
}
function grantedPermissions(value = {}) { const result = {}; if (value.network) result.network = value.network; if (value.fileSystem) result.fileSystem = value.fileSystem; return result; }
export function taggedError(message, code) { const error = new Error(message); error.code = code; return error; }
export function dynamicToolResponse(value) {
  if (value?.success === true && Array.isArray(value.contentItems)) return { success: true, contentItems: value.contentItems };
  const text = String(value?.message || value?.error || 'AIWS semantic tool failed.').slice(0, 4000);
  return { success: false, contentItems: [{ type: 'inputText', text }] };
}
function publicToolError(error) { return /^[a-z0-9_.-]{1,200}$/i.test(String(error?.code || error?.message || '')) ? String(error.code || error.message) : 'aiws_page_tool_failed'; }
