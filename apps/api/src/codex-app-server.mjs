import path from 'node:path';
import { spawn } from 'node:child_process';
import { AIWS_HOME } from './config.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { readSecret, redactKnownSecretsSync } from './vault.mjs';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';

export async function runCodexAppServer({ state, profile, prompt, userInput, cwd, resumeId, sandbox, onEvent, onApproval, signal, spawnProcess = spawn }) {
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential), invocation = appServerInvocation(profile, cwd, sandbox, credential);
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(invocation.command, invocation.args, { cwd, env: invocation.env, shell: false, windowsHide: true }); }
    catch (error) { reject(taggedError(error.message, 'app_server_start_failed')); return; }
    let buffer = '', stderr = '', settled = false, requestId = 0, threadId = resumeId || null, turnId = null, turnStarted = false;
    const pending = new Map(), deltaItems = new Set();
    const timer = setTimeout(() => finish(taggedError('codex_app_server_timeout', turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')), Math.max(1000, Math.min(1800000, Number(profile.timeout_ms || 120000))));
    const abort = () => { if (threadId && turnId) void request('turn/interrupt', { threadId, turnId }).catch(() => undefined); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) consume(line); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + redactKnownSecretsSync(chunk)).slice(-16000); });
    child.on('error', (error) => finish(taggedError(error.message, turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')));
    child.on('close', (code) => { if (!settled) finish(taggedError(stderr || `codex_app_server_exit_${code}`, turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed')); });
    start().catch((error) => finish(error));

    async function start() {
      await request('initialize', { clientInfo: { name: 'aiws', title: 'AI Workspace', version: '1.3.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
      notify('initialized');
      const thread = resumeId
        ? await request('thread/resume', { threadId: resumeId, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox })
        : await request('thread/start', { model: profile.model || null, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox, ephemeral: false });
      threadId = thread.thread?.id || resumeId; if (!threadId) throw taggedError('app_server_thread_missing', 'app_server_start_failed');
      onEvent?.({ type: 'thread.started', thread_id: threadId });
      const started = await request('turn/start', { threadId, input: userInput?.length ? userInput : [{ type: 'text', text: prompt, text_elements: [] }], cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: sandboxPolicy(sandbox, cwd), model: profile.model || null, effort: profile.reasoning || null, summary: 'concise' });
      turnId = started.turn?.id; if (!turnId) throw taggedError('app_server_turn_missing', 'app_server_start_failed'); turnStarted = true;
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
      if (message.id !== undefined && message.method) { void answerServerRequest(message); return; }
      const mapped = mapNotification(message, deltaItems); if (mapped) onEvent?.(mapped);
      if (message.method === 'turn/completed' && (!turnId || message.params?.turn?.id === turnId)) {
        const status = message.params?.turn?.status;
        if (status !== 'completed') return finish(taggedError(message.params?.turn?.error?.message || `app_server_turn_${status}`, 'app_server_turn_failed'));
        finish(null, { ok: true, code: 0, stdout: '', stderr, thread_id: threadId, turn_id: turnId, transport: 'app-server' });
      }
    }
    async function answerServerRequest(message) {
      try {
        const approval = approvalRequest(message), approved = approval ? await onApproval?.(approval) : false;
        write({ id: message.id, result: approvalResponse(message.method, approved === true || approved?.approved === true, message.params) });
      } catch { write({ id: message.id, result: approvalResponse(message.method, false, message.params) }); }
    }
    function finish(error, result) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); for (const item of pending.values()) item.reject(error || taggedError('app_server_closed', 'app_server_turn_failed')); pending.clear(); if (child.exitCode === null) child.kill(); error ? reject(error) : resolve(result);
    }
  });
}

function appServerInvocation(profile, cwd, sandbox, credential) {
  const proxy = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {}, env = { ...process.env, ...proxy, CODEX_HOME: profile.codex_home };
  if (credential) env.OPENAI_API_KEY = credential;
  else delete env.OPENAI_API_KEY;
  if (profile.kind !== 'docker') return { ...prepareCodexInvocation(process.env.AIWS_CODEX_BIN || 'codex', ['app-server', '--stdio']), env };
  const mode = sandbox === 'read-only' ? 'ro' : 'rw', home = profile.codex_home || path.join(AIWS_HOME, 'codex-homes', profile.id);
  const args = ['run', '--rm', '-i', '--add-host', 'host.docker.internal:host-gateway', '-e', 'CODEX_HOME=/codex-home'];
  if (credential) args.push('-e', 'OPENAI_API_KEY'); for (const key of Object.keys(proxy)) args.push('-e', key);
  args.push('-v', `${home}:/codex-home:rw`, '-v', `${path.resolve(cwd)}:/workspace:${mode}`, '-w', '/workspace');
  for (const [index, mount] of (profile.mounts || []).entries()) args.push('-v', `${path.resolve(mount)}:/aiws-mounts/${index}:ro`);
  args.push(profile.image || profile.config?.image || 'aiws-codex-runner:local', 'app-server', '--stdio'); return { command: 'docker', args, env };
}
function sandboxPolicy(mode, cwd) { return mode === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }; }
function approvalRequest(message) { const params = message.params || {}; if (!/approval|elicitation|requestUserInput/i.test(message.method)) return null; return { external_id: String(params.approvalId || params.itemId || message.id), approval_type: message.method, status: 'pending', command: params.command || null, path: params.grantRoot || params.cwd || null, host: params.networkApprovalContext?.host || null, tool: params.tool || null, request: params }; }
function approvalResponse(method, approved, params) {
  if (method === 'item/commandExecution/requestApproval') return { decision: approved ? 'accept' : 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: approved ? 'accept' : 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: approved ? 'approved' : 'denied' };
  if (method === 'item/permissions/requestApproval') return { permissions: approved ? grantedPermissions(params.permissions) : {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: approved ? 'accept' : 'decline', content: null, _meta: null };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  return { success: false, contentItems: [] };
}
function mapNotification(message, deltaItems) {
  const params = message.params || {}, item = params.item || {};
  if (message.method === 'item/agentMessage/delta') { deltaItems.add(params.itemId); return { aiws_type: 'text', data: { text: params.delta || '' }, output_text: params.delta || '' }; }
  if (message.method === 'item/plan/delta') return { aiws_type: 'plan', data: { text: params.delta || '', status: 'streaming' } };
  if (message.method === 'item/reasoning/summaryTextDelta') return { aiws_type: 'reasoning_summary', data: { summary: params.delta || '' } };
  if (message.method === 'turn/plan/updated') return { aiws_type: 'plan', data: { text: (params.plan || []).map((step) => `${step.status}: ${step.step}`).join('\n'), status: 'updated' } };
  if (message.method === 'thread/tokenUsage/updated') { const usage = params.tokenUsage?.total || {}; return { aiws_type: 'usage', data: { input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens, reasoning_output_tokens: usage.reasoningOutputTokens, total_tokens: usage.totalTokens } }; }
  if (message.method !== 'item/completed') return null;
  if (item.type === 'agentMessage') return deltaItems.has(item.id) ? null : { aiws_type: 'text', data: { text: item.text || '' }, output_text: item.text || '' };
  if (item.type === 'plan') return { aiws_type: 'plan', data: { text: item.text || '', status: 'completed' } };
  if (item.type === 'commandExecution') return { aiws_type: 'command', data: { command: item.command, status: item.status, exit_code: item.exitCode, output: item.aggregatedOutput } };
  if (item.type === 'fileChange') return { aiws_type: 'file_change', data: { status: item.status, changes: item.changes || [] } };
  if (item.type === 'mcpToolCall') return { aiws_type: 'mcp', data: { server: item.server, tool: item.tool, status: item.status } };
  if (item.type === 'webSearch') return { aiws_type: 'search', data: { query: item.query || '', status: 'completed' } };
  if (item.type === 'reasoning' && Array.isArray(item.summary)) return { aiws_type: 'reasoning_summary', data: { summary: item.summary.join('\n') } };
  return null;
}
function grantedPermissions(value = {}) { const result = {}; if (value.network) result.network = value.network; if (value.fileSystem) result.fileSystem = value.fileSystem; return result; }
function taggedError(message, code) { const error = new Error(message); error.code = code; return error; }
