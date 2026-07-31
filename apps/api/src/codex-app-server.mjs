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
import { mapNotification } from './codex-app-server-notifications.mjs';

export { mapNotification } from './codex-app-server-notifications.mjs';

const APP_SERVER_ARGS = [
  'app-server',
  '--stdio',
  '--disable',
  'code_mode_host',
  '--disable',
  'plugins',
  '--disable',
  'apps'
];

export async function runCodexAppServer(options) {
  return withCodexRuntimeStateRecovery(options.profile, () => runCodexAppServerOnce(options));
}

async function runCodexAppServerOnce({
  state,
  profile,
  prompt,
  userInput,
  additionalContext = [],
  dynamicTools = [],
  attachmentMounts = [],
  cwd,
  resumeId,
  sandbox,
  mode = 'default',
  projectId = null,
  onEvent,
  onApproval,
  onUserInput,
  onDynamicTool,
  signal,
  spawnProcess = spawn
}) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile))
    throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential),
    mcpAccess = await issueCodexMcpAccess(projectId, profile, {
      ttlSeconds: codexTimeoutTtlSeconds(profile.timeout_ms)
    }),
    invocation = appServerInvocation(profile, cwd, sandbox, credential, attachmentMounts, mcpAccess);
  try {
    return await runAppServerSession({
      profile,
      prompt,
      userInput,
      additionalContext,
      dynamicTools,
      cwd,
      resumeId,
      sandbox,
      mode,
      onEvent,
      onApproval,
      onUserInput,
      onDynamicTool,
      signal,
      spawnProcess,
      invocation
    });
  } finally {
    await mcpAccess?.release();
  }
}

function runAppServerSession(options) {
  return new Promise((resolve, reject) => startAppServerTransport(options, resolve, reject));
}

function startAppServerTransport(options, resolve, reject) {
  let child;
  try {
    child = spawnAppServerProcess(options.invocation, options.cwd, options.spawnProcess);
  } catch (error) {
    reject(taggedError(error.message, 'app_server_start_failed'));
    return;
  }
  const context = createAppServerContext(options, child, resolve, reject);
  attachAppServerListeners(context);
  startAppServerTurn(context).catch((error) => finishAppServerSession(context, error));
}

function spawnAppServerProcess(invocation, cwd, spawnProcess) {
  return invocation.runtime === 'docker'
    ? spawnContainerProcess(invocation, { cwd, env: invocation.env, spawnProcess })
    : spawnProcess(invocation.command, invocation.args, {
        cwd,
        env: invocation.env,
        shell: false,
        windowsHide: true
      });
}

function createAppServerContext(options, child, resolve, reject) {
  const context = {
    ...options,
    child,
    resolve,
    reject,
    buffer: '',
    stderr: '',
    settled: false,
    requestId: 0,
    threadId: options.resumeId || null,
    turnId: null,
    turnStarted: false,
    pending: new Map(),
    deltaItems: new Set(),
    pendingCompletedTurn: null,
    timer: null,
    abort: null
  };
  context.timer = setTimeout(
    () => finishAppServerSession(context, taggedError('codex_app_server_timeout', appServerFailureCode(context))),
    resolveCodexTimeoutMs(options.profile.timeout_ms)
  );
  context.abort = () => {
    if (context.threadId && context.turnId)
      void appServerRequest(context, 'turn/interrupt', {
        threadId: context.threadId,
        turnId: context.turnId
      }).catch(() => undefined);
    child.kill();
  };
  return context;
}

function attachAppServerListeners(context) {
  context.signal?.addEventListener('abort', context.abort, { once: true });
  context.child.stdout.on('data', (chunk) => consumeAppServerChunk(context, chunk));
  context.child.stderr.on('data', (chunk) => {
    context.stderr = (context.stderr + redactKnownSecretsSync(chunk)).slice(-16000);
  });
  context.child.on('error', (error) =>
    finishAppServerSession(context, taggedError(error.message, appServerFailureCode(context)))
  );
  context.child.on('close', (code) => {
    if (!context.settled)
      finishAppServerSession(
        context,
        taggedError(context.stderr || `codex_app_server_exit_${code}`, appServerFailureCode(context))
      );
  });
}

function consumeAppServerChunk(context, chunk) {
  context.buffer += chunk.toString();
  const lines = context.buffer.split(/\r?\n/);
  context.buffer = lines.pop() || '';
  for (const line of lines) consumeAppServerLine(context, line);
}

async function startAppServerTurn(context) {
  await appServerRequest(context, 'initialize', {
    clientInfo: { name: 'aiws', title: 'AI Workspace', version: AIWS_VERSION },
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
  appServerNotify(context, 'initialized');
  await assertNativePlanAvailable(context);
  const runtimeCwd = context.invocation.cwd || context.cwd;
  const threadOptions = {
    cwd: runtimeCwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: context.sandbox,
    dynamicTools: context.dynamicTools
  };
  const thread = await openAppServerThread(context, threadOptions);
  context.threadId = thread.thread?.id || context.resumeId;
  if (!context.threadId) throw taggedError('app_server_thread_missing', 'app_server_start_failed');
  context.onEvent?.({ type: 'thread.started', thread_id: context.threadId });
  context.turnStarted = true;
  const started = await appServerRequest(context, 'turn/start', {
    threadId: context.threadId,
    input: context.userInput?.length ? context.userInput : [{ type: 'text', text: context.prompt, text_elements: [] }],
    additionalContext: nativeAdditionalContext(context.additionalContext),
    cwd: runtimeCwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicy(context.sandbox, runtimeCwd),
    collaborationMode: nativeCollaborationMode(context.mode, context.profile),
    summary: 'concise'
  });
  context.turnId = started.turn?.id;
  if (!context.turnId) throw taggedError('app_server_turn_missing', 'app_server_turn_failed');
  const pendingCompletedTurn = context.pendingCompletedTurn;
  context.pendingCompletedTurn = null;
  if (pendingCompletedTurn?.id === context.turnId) completeAppServerTurn(context, pendingCompletedTurn);
}

async function assertNativePlanAvailable(context) {
  if (context.mode !== 'plan') return;
  let available;
  try {
    available = await appServerRequest(context, 'collaborationMode/list', {});
  } catch {
    throw taggedError('codex_native_plan_unavailable', 'native_plan_unavailable');
  }
  if (!available?.data?.some((item) => item?.mode === 'plan'))
    throw taggedError('codex_native_plan_unavailable', 'native_plan_unavailable');
}

async function openAppServerThread(context, threadOptions) {
  if (!context.resumeId)
    return appServerRequest(context, 'thread/start', {
      model: context.profile.model || null,
      ...threadOptions,
      ephemeral: false
    });
  try {
    return await appServerRequest(context, 'thread/resume', {
      threadId: context.resumeId,
      ...threadOptions
    });
  } catch (error) {
    if (!isCodexThreadUnavailable(error)) throw error;
    const thread = await appServerRequest(context, 'thread/start', {
      model: context.profile.model || null,
      ...threadOptions,
      ephemeral: false
    });
    context.onEvent?.({ type: 'thread.recreated' });
    return thread;
  }
}

function appServerRequest(context, method, params) {
  const id = ++context.requestId;
  return new Promise((resolve, reject) => {
    context.pending.set(id, { resolve, reject });
    writeAppServerMessage(context, { method, id, params });
  });
}

function appServerNotify(context, method, params) {
  writeAppServerMessage(context, params === undefined ? { method } : { method, params });
}

function writeAppServerMessage(context, message) {
  if (!context.child.stdin?.writable) throw taggedError('app_server_stdin_closed', appServerFailureCode(context));
  context.child.stdin.write(`${JSON.stringify(message)}\n`);
}

function consumeAppServerLine(context, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && !message.method) return resolveAppServerResponse(context, message);
  if (message.id !== undefined && message.method) {
    void answerAppServerRequest(context, message).catch((error) => {
      if (!context.settled) finishAppServerSession(context, error);
    });
    return;
  }
  const mapped = mapNotification(message, context.deltaItems);
  if (mapped) context.onEvent?.(mapped);
  if (message.method === 'turn/completed') handleAppServerTurnCompleted(context, message.params?.turn);
}

function handleAppServerTurnCompleted(context, turn) {
  if (!context.turnId) {
    if (context.turnStarted && turn?.id) context.pendingCompletedTurn = turn;
    return;
  }
  if (turn?.id === context.turnId) completeAppServerTurn(context, turn);
}

function resolveAppServerResponse(context, message) {
  const target = context.pending.get(message.id);
  if (!target) return;
  context.pending.delete(message.id);
  if (message.error)
    target.reject(taggedError(message.error.message || 'app_server_rpc_error', appServerFailureCode(context)));
  else target.resolve(message.result);
}

function completeAppServerTurn(context, turn) {
  const status = turn?.status;
  if (status !== 'completed') {
    finishAppServerSession(
      context,
      taggedError(turn?.error?.message || `app_server_turn_${status}`, 'app_server_turn_failed')
    );
    return;
  }
  finishAppServerSession(context, null, {
    ok: true,
    code: 0,
    stdout: '',
    stderr: context.stderr,
    thread_id: context.threadId,
    turn_id: context.turnId,
    transport: 'app-server'
  });
}

async function answerAppServerRequest(context, message) {
  try {
    if (message.method === 'item/tool/requestUserInput') return await answerAppServerUserInput(context, message);
    if (message.method === 'item/tool/call') return await answerAppServerDynamicTool(context, message);
    const approval = approvalRequest(message);
    const approved = approval ? await context.onApproval?.(approval) : false;
    writeAppServerMessage(context, {
      id: message.id,
      result: approvalResponse(message.method, approved === true || approved?.approved === true, message.params)
    });
  } catch (error) {
    handleAppServerRequestError(context, message, error);
  }
}

async function answerAppServerUserInput(context, message) {
  const result = await context.onUserInput?.(message.params || {});
  if (!result || typeof result.answers !== 'object')
    throw taggedError('request_user_input_unhandled', 'app_server_turn_failed');
  writeAppServerMessage(context, { id: message.id, result: { answers: result.answers } });
}

async function answerAppServerDynamicTool(context, message) {
  const result = await context.onDynamicTool?.(message.params || {});
  writeAppServerMessage(context, { id: message.id, result: dynamicToolResponse(result) });
}

function handleAppServerRequestError(context, message, error) {
  if (context.settled) return;
  if (message.method === 'item/tool/requestUserInput') {
    finishAppServerSession(context, error);
    return;
  }
  const result =
    message.method === 'item/tool/call'
      ? dynamicToolResponse({ success: false, message: publicToolError(error) })
      : approvalResponse(message.method, false, message.params);
  writeAppServerMessage(context, { id: message.id, result });
}

function finishAppServerSession(context, error, result) {
  if (context.settled) return;
  context.settled = true;
  clearTimeout(context.timer);
  context.signal?.removeEventListener('abort', context.abort);
  for (const item of context.pending.values())
    item.reject(error || taggedError('app_server_closed', 'app_server_turn_failed'));
  context.pending.clear();
  if (context.child.exitCode === null) context.child.kill();
  error ? context.reject(error) : context.resolve(result);
}

function appServerFailureCode(context) {
  return context.turnStarted ? 'app_server_turn_failed' : 'app_server_start_failed';
}

export async function runCodexAppServerRpc(options) {
  return withCodexRuntimeStateRecovery(options.profile, () => runCodexAppServerRpcOnce(options));
}

async function runCodexAppServerRpcOnce({
  state,
  profile,
  cwd,
  sandbox = 'read-only',
  resumeId = null,
  method,
  params = {},
  createThread = false,
  projectId = null,
  signal,
  spawnProcess = spawn
}) {
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile))
    throw taggedError('codex_auth_profile_mismatch', 'app_server_start_failed');
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential),
    mcpAccess = await issueCodexMcpAccess(projectId, profile, {
      ttlSeconds: codexTimeoutTtlSeconds(profile.timeout_ms)
    }),
    invocation = appServerInvocation(profile, cwd, sandbox, credential, [], mcpAccess);
  try {
    return await new Promise((resolve, reject) => {
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
        reject(taggedError(error.message, 'app_server_start_failed'));
        return;
      }
      let buffer = '',
        stderr = '',
        settled = false,
        requestId = 0,
        threadId = resumeId;
      const pending = new Map();
      const timer = setTimeout(
        () => finish(taggedError('codex_app_server_control_timeout', 'app_server_turn_failed')),
        resolveCodexTimeoutMs(profile.timeout_ms)
      );
      const abort = () => {
        child.kill();
        finish(taggedError('codex_app_server_control_aborted', 'app_server_turn_failed'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) consume(line);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + redactKnownSecretsSync(chunk)).slice(-16000);
      });
      child.on('error', (error) => finish(taggedError(error.message, 'app_server_start_failed')));
      child.on('close', (code) => {
        if (!settled) finish(taggedError(stderr || `codex_app_server_exit_${code}`, 'app_server_turn_failed'));
      });
      start().catch(finish);

      async function start() {
        await request('initialize', {
          clientInfo: { name: 'aiws', title: 'AI Workspace', version: AIWS_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: false }
        });
        notify('initialized');
        if (createThread && !threadId) {
          const runtimeCwd = invocation.cwd || cwd;
          const started = await request('thread/start', {
            model: profile.model || null,
            cwd: runtimeCwd,
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox,
            ephemeral: false
          });
          threadId = started.thread?.id;
          if (!threadId) throw taggedError('app_server_thread_missing', 'app_server_start_failed');
        }
        const result = await request(method, { ...params, ...(threadId ? { threadId } : {}) });
        finish(null, { result, thread_id: threadId, transport: 'app-server' });
      }
      function request(requestMethod, requestParams) {
        const id = ++requestId;
        return new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
          write({ method: requestMethod, id, params: requestParams });
        });
      }
      function notify(notificationMethod, notificationParams) {
        write(
          notificationParams === undefined
            ? { method: notificationMethod }
            : { method: notificationMethod, params: notificationParams }
        );
      }
      function write(message) {
        if (!child.stdin?.writable) throw taggedError('app_server_stdin_closed', 'app_server_start_failed');
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
      function consume(line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.id === undefined || message.method) return;
        const target = pending.get(message.id);
        if (!target) return;
        pending.delete(message.id);
        if (message.error)
          target.reject(taggedError(message.error.message || 'app_server_rpc_error', 'app_server_turn_failed'));
        else target.resolve(message.result);
      }
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        for (const item of pending.values())
          item.reject(error || taggedError('app_server_closed', 'app_server_turn_failed'));
        pending.clear();
        if (child.exitCode === null) child.kill();
        error ? reject(error) : resolve(result);
      }
    });
  } finally {
    await mcpAccess?.release();
  }
}

export function appServerInvocation(profile, cwd, sandbox, credential, attachmentMounts = [], mcpAccess = null) {
  const proxy = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {},
    env = withCodexMcpEnvironment({ ...process.env, ...proxy, CODEX_HOME: profile.codex_home }, mcpAccess),
    commandArgs = [...codexMcpConfigArgs(mcpAccess), ...APP_SERVER_ARGS];
  if (credential) env.OPENAI_API_KEY = credential;
  else delete env.OPENAI_API_KEY;
  if (profile.kind !== 'docker')
    return { ...prepareCodexInvocation(process.env.AIWS_CODEX_BIN || 'codex', commandArgs), env };
  const home = profile.codex_home || path.join(AIWS_HOME, 'codex-homes', profile.id);
  return {
    ...buildCodexContainerInvocation({
      kind: 'assist-app-server',
      sessionId: `rpc-${Date.now().toString(36)}`,
      profileId: profile.id,
      image: profile.image || profile.config?.image,
      stdin: true,
      codexHome: home,
      nestedSandbox: true,
      workspace: path.resolve(cwd),
      workspaceMode: sandbox === 'read-only' ? 'ro' : 'rw',
      extraMounts: [...(profile.mounts || []), ...attachmentMounts],
      containerEnv: {
        CODEX_HOME: '/codex-home',
        ...(credential ? { OPENAI_API_KEY: null } : {}),
        ...(mcpAccess?.containerEnv || {}),
        ...Object.fromEntries(Object.keys(proxy).map((key) => [key, null]))
      },
      commandArgs
    }),
    env
  };
}
export function sandboxPolicy(mode, cwd) {
  return mode === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
}
function approvalRequest(message) {
  const params = message.params || {};
  if (!/approval|elicitation/i.test(message.method)) return null;
  return {
    external_id: String(params.approvalId || params.itemId || message.id),
    approval_type: message.method,
    status: 'pending',
    command: params.command || null,
    path: params.grantRoot || params.cwd || null,
    host: params.networkApprovalContext?.host || null,
    tool: params.tool || null,
    request: params
  };
}
export function approvalResponse(method, approved, params) {
  if (method === 'item/commandExecution/requestApproval') return { decision: approved ? 'accept' : 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: approved ? 'accept' : 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval')
    return { decision: approved ? 'approved' : 'denied' };
  if (method === 'item/permissions/requestApproval')
    return { permissions: approved ? grantedPermissions(params.permissions) : {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request')
    return { action: approved ? 'accept' : 'decline', content: null, _meta: null };
  return { success: false, contentItems: [] };
}
export function nativeCollaborationMode(mode, profile) {
  return {
    mode: mode === 'plan' ? 'plan' : 'default',
    settings: {
      model: String(profile?.model || ''),
      reasoning_effort: profile?.reasoning || null,
      developer_instructions: null
    }
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
function grantedPermissions(value = {}) {
  const result = {};
  if (value.network) result.network = value.network;
  if (value.fileSystem) result.fileSystem = value.fileSystem;
  return result;
}
export function taggedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
export function dynamicToolResponse(value) {
  if (value?.success === true && Array.isArray(value.contentItems))
    return { success: true, contentItems: value.contentItems };
  const text = String(value?.message || value?.error || 'AIWS semantic tool failed.').slice(0, 4000);
  return { success: false, contentItems: [{ type: 'inputText', text }] };
}
function publicToolError(error) {
  return /^[a-z0-9_.-]{1,200}$/i.test(String(error?.code || error?.message || ''))
    ? String(error.code || error.message)
    : 'aiws_page_tool_failed';
}
