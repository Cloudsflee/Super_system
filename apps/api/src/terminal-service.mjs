import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { ARTIFACT_DIR, WORKSPACE_DIR, WORKTREE_DIR } from './config.mjs';
import { HttpError, isTrustedLocalOrigin } from './http.mjs';
import { assertManagedProjectWritable } from './project-lifecycle.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { readSecret, redactKnownSecretStream, redactKnownSecretsSync } from './vault.mjs';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { createAssistWorktree } from './assist-v3-worktree.mjs';
import { pushV3Event } from './assist-v3-events.mjs';
import { resolveAssistTurnConfiguration } from './assist-v3-domain.mjs';
import { bindSessionRuntimeProfile } from './assist-v3-domain.mjs';
import { acquireBatchWriteLock, createBatchCheckpoint, ensureSessionChangeBatch } from './assist-change-batches.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { assertProfileAllowed } from './container-runtime-config.mjs';
import { registerManagedProcessHandle, releaseManagedProcessHandle } from './container-runtime.mjs';
import { hostBridgeCapability } from './host-bridge-service.mjs';
import { createWindowsBridgeProcess } from './terminal-windows-bridge.mjs';
import { withProjectLifecycleLock } from './project-lifecycle-operations.mjs';
import { issueCodexMcpAccess } from './codex-mcp-runtime.mjs';
import { codexTimeoutTtlSeconds } from './codex-timeout.mjs';
import { terminalInvocation } from './terminal-invocation.mjs';
import {
  MAX_PREVIEW_CHARS,
  appendOutput,
  broadcast,
  clamp,
  finishTerminalArtifact,
  isWithin,
  publicSession,
  rejectWebSocket,
  safe
} from './terminal-runtime-helpers.mjs';
import { accessibleProjectIds, actorForRequest, assertProjectRun } from './project-governance-v19.mjs';
import { assertControlledProjectWrite, assertControlledTaskWrite } from './execution-governance.mjs';
export { terminalCodexArgs } from './terminal-invocation.mjs';
const runtimes = new Map();
const runtimeStarts = new Map();
export function terminalRuntimeStats() {
  return {
    active_count: runtimes.size,
    starting_count: runtimeStarts.size,
    active_session_ids: [...runtimes.keys()].sort()
  };
}
export function terminalCapability() {
  const linuxAvailable = typeof pty.spawn === 'function';
  return {
    available: linuxAvailable,
    transport: 'node-pty+websocket',
    protocols: ['input', 'resize', 'signal', 'reconnect'],
    linux_container: {
      available: linuxAvailable,
      default: true,
      runtime: 'linux_container',
      transport: 'node-pty+websocket',
      protocols: ['input', 'resize', 'signal', 'reconnect'],
      reason: linuxAvailable ? null : 'pty_capability_unavailable'
    },
    windows_bridge: { available: false, runtime: 'windows_bridge', reason: 'windows_bridge_not_paired' },
    host_dev: {
      available: process.env.NODE_ENV !== 'production' && linuxAvailable,
      runtime: 'host_dev',
      reason: process.env.NODE_ENV === 'production' ? 'host_dev_disabled_in_production' : null
    },
    max_preview_chars: MAX_PREVIEW_CHARS
  };
}
export function createTerminalSession(body) {
  return withProjectLifecycleLock(body.project_id, () => createTerminalSessionLocked(body));
}
async function createTerminalSessionLocked(body) {
  const requestedRuntime = body.runtime || 'linux_container';
  if (!['linux_container', 'windows_bridge', 'host_dev'].includes(requestedRuntime))
    throw new HttpError(400, { error: 'terminal_runtime_invalid' });
  if (requestedRuntime !== 'windows_bridge' && !terminalCapability().linux_container.available)
    throw new HttpError(501, { error: 'pty_capability_unavailable' });
  const snapshot = await readState(),
    project = snapshot.projects.find((item) => item.id === body.project_id);
  assertManagedProjectWritable(project);
  const assistSession = body.assist_session_id
    ? snapshot.assist_sessions.find(
        (item) =>
          item.id === body.assist_session_id &&
          item.version === 3 &&
          item.project_id === project.id &&
          !item.archived_at
      )
    : null;
  if (body.assist_session_id && !assistSession) throw new HttpError(404, { error: 'assist_session_not_found' });
  const turn = body.turn_id
    ? snapshot.assist_turns.find((item) => item.id === body.turn_id && item.project_id === project.id)
    : null;
  if (body.turn_id && !turn) throw new HttpError(404, { error: 'assist_turn_not_found' });
  if (assistSession && turn && turn.session_id !== assistSession.id)
    throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
  const scopedTaskId = body.node_id || (assistSession?.scope_type === 'task' ? assistSession.scope_id : null);
  if (scopedTaskId)
    assertControlledTaskWrite(
      snapshot,
      scopedTaskId,
      { task_execution_id: body.task_execution_id, lease_token: body.lease_token },
      'terminal'
    );
  else
    assertControlledProjectWrite(snapshot, {
      projectId: project.id,
      taskExecutionId: body.task_execution_id,
      leaseToken: body.lease_token,
      operation: 'terminal'
    });
  const configuration = resolveAssistTurnConfiguration(snapshot, body),
    profile = configuration.profile;
  assertProfileAllowed(profile);
  let bridgeCapability = null;
  if (requestedRuntime === 'windows_bridge') {
    if (!assistSession) throw new HttpError(409, { error: 'windows_bridge_assist_session_required' });
    bridgeCapability = await hostBridgeCapability();
    if (!bridgeCapability.available)
      throw new HttpError(409, {
        error: bridgeCapability.reason,
        action: bridgeCapability.reason === 'windows_bridge_not_paired' ? 'install_bridge' : 'check_bridge'
      });
  }
  if (requestedRuntime === 'host_dev' && process.env.NODE_ENV === 'production')
    throw new HttpError(409, { error: 'host_dev_disabled_in_production' });
  const sessionId = id('tty');
  const sharedBatch = assistSession ? await ensureSessionChangeBatch(assistSession.id) : null;
  const prepared = sharedBatch
    ? { record: sharedBatch.worktree, batch: sharedBatch.batch }
    : body.worktree_id
      ? resolveExistingWorktree(snapshot, body.worktree_id, project.id)
      : {
          record: { ...(await createAssistWorktree(project, { id: `cli-${sessionId}` })), turn_id: null, kind: 'cli' },
          batch: null
        };
  const session = await mutate((state) => {
    const actor = owner(state),
      currentProject = state.projects.find((item) => item.id === project.id);
    assertManagedProjectWritable(currentProject);
    if (scopedTaskId)
      assertControlledTaskWrite(
        state,
        scopedTaskId,
        { task_execution_id: body.task_execution_id, lease_token: body.lease_token },
        'terminal'
      );
    else
      assertControlledProjectWrite(state, {
        projectId: project.id,
        taskExecutionId: body.task_execution_id,
        leaseToken: body.lease_token,
        operation: 'terminal'
      });
    if (!sharedBatch && !body.worktree_id) state.worktrees.push(prepared.record);
    if (assistSession)
      bindSessionRuntimeProfile(
        state.assist_sessions.find((item) => item.id === assistSession.id),
        state.codex_profiles.find((item) => item.id === profile.id)
      );
    const item = {
      id: sessionId,
      project_id: project.id,
      assist_session_id: assistSession?.id || turn?.session_id || null,
      turn_id: body.turn_id || null,
      worktree_id: prepared.record.id,
      profile_id: profile.id,
      task_execution_id: body.task_execution_id || null,
      node_id: scopedTaskId || null,
      change_batch_id: prepared.batch?.id || null,
      host_bridge_device_id: bridgeCapability?.device_id || null,
      model: configuration.model,
      reasoning: configuration.reasoning,
      runtime: requestedRuntime,
      status: 'ready',
      cols: clamp(body.cols, 40, 300, 120),
      rows: clamp(body.rows, 10, 120, 32),
      reconnect_token_hash: hashString(`${sessionId}:${Date.now()}`),
      output_preview: '',
      output_truncated: false,
      exit_code: null,
      created_by_user_id: actor.id,
      created_at: now(),
      updated_at: now()
    };
    state.terminal_sessions.push(item);
    if (item.assist_session_id)
      pushV3Event(state, item.assist_session_id, item.turn_id, 'terminal', {
        terminal_session_id: item.id,
        runtime: item.runtime,
        status: item.status
      });
    addTrace(
      state,
      'terminal.session.created',
      {
        project_id: project.id,
        target_type: 'terminal_session',
        target_id: item.id,
        summary: `创建 ${item.runtime} Codex CLI Session。`
      },
      actor.id
    );
    return item;
  });
  return publicSession(session);
}
export async function getTerminalSession(sessionId) {
  const state = await readState(),
    session = state.terminal_sessions.find((item) => item.id === sessionId);
  if (!session) throw new HttpError(404, { error: 'terminal_session_not_found' });
  return publicSession(session);
}
export async function listTerminalSessions({ projectId = null, assistSessionId = null } = {}) {
  const state = await readState(),
    allowed = accessibleProjectIds(state);
  return state.terminal_sessions
    .filter(
      (item) =>
        allowed.has(item.project_id) &&
        (!projectId || item.project_id === projectId) &&
        (!assistSessionId || item.assist_session_id === assistSessionId)
    )
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map(publicSession);
}
export async function stopTerminalSession(sessionId) {
  const runtime = runtimes.get(sessionId);
  const stopped = await mutate((state) => {
    const session = state.terminal_sessions.find((item) => item.id === sessionId);
    if (!session) throw new HttpError(404, { error: 'terminal_session_not_found' });
    if (!['exited', 'failed', 'stopped'].includes(session.status))
      Object.assign(session, { status: 'stopped', stopped_at: now(), updated_at: now() });
    return publicSession(session);
  });
  if (!runtime?.process) return stopped;
  runtime.process.kill();
  await Promise.race([runtime.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
  return getTerminalSession(sessionId);
}

export async function terminalRuntimeAction(sessionId, action, input = {}) {
  const state = await readState(),
    session = state.terminal_sessions.find((item) => item.id === sessionId);
  if (!session) throw new HttpError(404, { error: 'terminal_session_not_found' });
  if (action === 'read') {
    const runtime = runtimes.get(sessionId);
    return {
      session: publicSession(session),
      output: runtime?.preview || session.output_preview || '',
      connected: Boolean(runtime),
      truncated: Boolean(session.output_truncated)
    };
  }
  if (action === 'stop') return { session: await stopTerminalSession(sessionId) };
  if (!['input', 'resize', 'signal'].includes(action))
    throw new HttpError(400, { error: 'terminal_runtime_action_invalid' });
  if (['exited', 'failed', 'stopped', 'interrupted'].includes(session.status))
    throw new HttpError(409, { error: 'terminal_session_closed', status: session.status });
  const runtime = await ensureTerminalRuntime(session);
  if (action === 'input') {
    const data = String(input.data || '');
    if (!data || Buffer.byteLength(data, 'utf8') > 65536)
      throw new HttpError(400, { error: 'terminal_input_invalid', max_bytes: 65536 });
    runtime.process.write(data);
  } else if (action === 'resize') {
    const cols = clamp(input.cols, 20, 400, session.cols || 120),
      rows = clamp(input.rows, 5, 200, session.rows || 32);
    runtime.process.resize(cols, rows);
    await mutate((data) => {
      const current = data.terminal_sessions.find((item) => item.id === sessionId);
      if (current) Object.assign(current, { cols, rows, updated_at: now() });
    });
  } else {
    if (input.signal !== 'SIGINT') throw new HttpError(400, { error: 'terminal_signal_invalid', allowed: ['SIGINT'] });
    runtime.process.write('\x03');
  }
  const current = await getTerminalSession(sessionId);
  return { session: current, output: runtime.preview, connected: true };
}

export function attachTerminalWebSocket(server) {
  const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname.replace(/^\/api/, '');
    const match = pathname.match(/^\/assist\/v3\/terminal-sessions\/([^/]+)\/ws$/);
    if (!match) return;
    if (request.headers.origin && !isTrustedLocalOrigin(request.headers.origin)) {
      rejectWebSocket(socket, 403, 'Forbidden');
      return;
    }
    let sessionId;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      rejectWebSocket(socket, 400, 'Bad Request');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      connectSocket(ws, sessionId, request).catch(() => ws.close(1011, 'terminal_unavailable'))
    );
  });
  return sockets;
}

export async function closeTerminalRuntimes() {
  await Promise.allSettled([...runtimeStarts.values()]);
  for (const runtime of runtimes.values()) for (const client of runtime.clients) client.close(1012, 'server_shutdown');
  await Promise.allSettled([...runtimes.keys()].map((sessionId) => stopTerminalSession(sessionId)));
}

async function connectSocket(ws, sessionId, request) {
  const state = await readState(),
    session = state.terminal_sessions.find((item) => item.id === sessionId);
  if (!session) {
    ws.close(1008, 'terminal_session_not_found');
    return;
  }
  try {
    const actor = actorForRequest(state, { headers: request.headers }, { strict: false });
    assertProjectRun(state, session.project_id, actor.id);
  } catch (error) {
    ws.close(1008, error?.payload?.error || 'terminal_project_access_denied');
    return;
  }
  const runtime = ['exited', 'failed', 'stopped', 'interrupted'].includes(session.status)
    ? null
    : await ensureTerminalRuntime(session);
  if (!runtime) {
    ws.send(JSON.stringify({ type: 'status', session: publicSession(session) }));
    ws.close(1000, 'terminal_closed');
    return;
  }
  runtime.clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', session: publicSession({ ...session, status: 'connected' }) }));
  if (runtime.preview) ws.send(JSON.stringify({ type: 'output', data: runtime.preview, replay: true }));
  ws.on('message', (raw) => handleClientMessage(runtime, raw));
  ws.on('close', () => runtime.clients.delete(ws));
}

async function ensureTerminalRuntime(session) {
  let runtime = runtimes.get(session.id);
  if (runtime) return runtime;
  let starting = runtimeStarts.get(session.id);
  if (!starting) {
    starting = startTerminal(session).finally(() => runtimeStarts.delete(session.id));
    runtimeStarts.set(session.id, starting);
  }
  return starting;
}

async function startTerminal(session) {
  const state = await readState(),
    project = state.projects.find((item) => item.id === session.project_id),
    worktree = state.worktrees.find((item) => item.id === session.worktree_id),
    storedProfile = state.codex_profiles.find((item) => item.id === session.profile_id);
  assertManagedProjectWritable(project);
  if (!worktree || !storedProfile || !fs.existsSync(worktree.path))
    throw new HttpError(409, { error: 'terminal_worktree_unavailable' });
  const profile = {
    ...storedProfile,
    model: session.model || storedProfile.model,
    reasoning: session.reasoning || storedProfile.reasoning
  };
  assertProfileAllowed(profile);
  let releaseBatchLock = null;
  if (session.change_batch_id) {
    releaseBatchLock = await acquireBatchWriteLock(session.change_batch_id, {
      kind: session.runtime === 'windows_bridge' ? 'windows_cli' : 'linux_cli',
      id: session.id
    });
    await createBatchCheckpoint(session.change_batch_id, {
      source: session.runtime === 'windows_bridge' ? 'windows_cli' : 'linux_cli',
      sourceId: session.id,
      phase: 'before'
    });
  }
  let processHandle,
    invocation = null,
    mcpAccess = null;
  try {
    if (session.runtime === 'windows_bridge')
      processHandle = await createWindowsBridgeProcess({ session, worktree, profile });
    else {
      const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
      if (!codexAuthMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_profile_mismatch' });
      if (auth.home && !isThirdPartyProvider(profile.provider))
        await materializeDeviceAuth(auth.home, profile.codex_home);
      const credential = await readSecret(auth?.refs?.credential),
        invocationProfile =
          session.runtime === 'host_dev' ? { ...profile, kind: 'host' } : { ...profile, kind: 'docker' };
      mcpAccess = await issueCodexMcpAccess(session.project_id, invocationProfile, {
        ttlSeconds: codexTimeoutTtlSeconds(profile.timeout_ms, 3600)
      });
      invocation = terminalInvocation(invocationProfile, worktree.path, credential, session.id, mcpAccess);
      processHandle = pty.spawn(invocation.command, invocation.args, {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd: worktree.path,
        env: invocation.env,
        useConpty: process.platform === 'win32'
      });
    }
  } catch (error) {
    await mcpAccess?.release();
    await releaseBatchLock?.();
    await mutate((data) => {
      const current = data.terminal_sessions.find((item) => item.id === session.id);
      if (current)
        Object.assign(current, {
          status: 'failed',
          error_code:
            session.runtime === 'windows_bridge' && /^[a-z0-9_.-]{1,120}$/i.test(String(error?.message || ''))
              ? error.message
              : 'terminal_spawn_failed',
          updated_at: now()
        });
    });
    throw error;
  }
  if (invocation?.runtime === 'docker') registerManagedProcessHandle(invocation, processHandle);
  const artifactDir = path.join(ARTIFACT_DIR, 'terminal');
  await fsp.mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${Date.now()}_${safe(session.id)}.log`),
    outputStream = fs.createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 });
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const runtime = {
    process: processHandle,
    clients: new Set(),
    preview: '',
    redactionPending: '',
    sessionId: session.id,
    source: session.runtime === 'windows_bridge' ? 'windows_cli' : 'linux_cli',
    changeBatchId: session.change_batch_id,
    releaseBatchLock,
    releaseMcp: mcpAccess?.release || null,
    artifactPath,
    outputStream,
    outputHash: crypto.createHash('sha256'),
    outputBytes: 0,
    outputError: null,
    done
  };
  outputStream.on('error', (error) => {
    runtime.outputError = error;
  });
  runtimes.set(session.id, runtime);
  processHandle.onData((chunk) => {
    const redacted = redactKnownSecretStream(chunk, runtime.redactionPending);
    runtime.redactionPending = redacted.pending;
    appendOutput(runtime, redacted.text);
  });
  processHandle.onExit(({ exitCode, signal }) => {
    if (invocation?.containerName) releaseManagedProcessHandle(invocation.containerName, processHandle);
    runtime.finalizing ||= finalizeTerminal(runtime, exitCode, signal).finally(resolveDone);
  });
  await mutate((data) => {
    const current = data.terminal_sessions.find((item) => item.id === session.id);
    if (current) {
      Object.assign(current, { status: 'running', pid: processHandle.pid, started_at: now(), updated_at: now() });
      if (current.assist_session_id)
        pushV3Event(data, current.assist_session_id, current.turn_id, 'terminal', {
          terminal_session_id: current.id,
          runtime: current.runtime,
          status: current.status
        });
    }
  });
  return runtime;
}

async function finalizeTerminal(runtime, exitCode, signal) {
  runtimes.delete(runtime.sessionId);
  try {
    if (runtime.redactionPending) {
      appendOutput(runtime, redactKnownSecretsSync(runtime.redactionPending));
      runtime.redactionPending = '';
    }
    const artifact = await finishTerminalArtifact(runtime);
    if (runtime.changeBatchId)
      await createBatchCheckpoint(runtime.changeBatchId, {
        source: runtime.source,
        sourceId: runtime.sessionId,
        phase: 'after',
        status: exitCode === 0 ? 'completed' : 'interrupted'
      }).catch(() => undefined);
    const session = await mutate((state) => {
      const actor = owner(state),
        current = state.terminal_sessions.find((item) => item.id === runtime.sessionId);
      if (!current) return null;
      state.file_refs.push(artifact);
      Object.assign(current, {
        status: current.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'exited' : 'failed',
        exit_code: exitCode,
        exit_signal: signal || null,
        error_code:
          exitCode !== 0 && runtime.source === 'windows_cli'
            ? signal || 'windows_bridge_terminal_failed'
            : current.error_code || null,
        pid: null,
        output_preview: runtime.preview,
        output_truncated: runtime.outputBytes > Buffer.byteLength(runtime.preview),
        artifact_file_ref_id: artifact.id,
        completed_at: now(),
        updated_at: now()
      });
      if (current.assist_session_id)
        pushV3Event(state, current.assist_session_id, current.turn_id, 'terminal', {
          terminal_session_id: current.id,
          runtime: current.runtime,
          status: current.status,
          exit_code: current.exit_code,
          artifact_file_ref_id: artifact.id
        });
      addTrace(
        state,
        'terminal.session.completed',
        {
          project_id: current.project_id,
          target_type: 'terminal_session',
          target_id: current.id,
          raw_file_ref_id: artifact.id,
          summary: `Codex CLI Session ${current.status} (${exitCode})。`
        },
        actor.id
      );
      return current;
    });
    if (runtime.releaseBatchLock) {
      const release = runtime.releaseBatchLock;
      runtime.releaseBatchLock = null;
      await release().catch(() => undefined);
    }
    broadcast(runtime, { type: 'exit', session: session ? publicSession(session) : null });
    for (const client of runtime.clients) client.close(1000, 'terminal_exited');
  } finally {
    if (runtime.releaseBatchLock) await runtime.releaseBatchLock().catch(() => undefined);
    if (runtime.releaseMcp) {
      const release = runtime.releaseMcp;
      runtime.releaseMcp = null;
      await release().catch(() => undefined);
    }
  }
}

function handleClientMessage(runtime, raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message.type === 'input' && typeof message.data === 'string') runtime.process.write(message.data.slice(0, 65536));
  else if (message.type === 'resize')
    runtime.process.resize(clamp(message.cols, 20, 400, 120), clamp(message.rows, 5, 200, 32));
  else if (message.type === 'signal' && message.signal === 'SIGINT') runtime.process.write('\x03');
  else if (message.type === 'ping') broadcast(runtime, { type: 'pong', at: now() });
}

function resolveExistingWorktree(state, worktreeId, projectId) {
  const record = state.worktrees.find((item) => item.id === worktreeId && item.project_id === projectId),
    assistRoot = path.join(WORKSPACE_DIR, safe(projectId), 'worktrees');
  if (!record || (!isWithin(WORKTREE_DIR, record.path) && !isWithin(assistRoot, record.path)))
    throw new HttpError(404, { error: 'worktree_not_found' });
  return { record };
}
