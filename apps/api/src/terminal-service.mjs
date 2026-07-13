import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { AIWS_HOME, ARTIFACT_DIR, DATA_DIR, WORKSPACE_DIR, WORKTREE_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { assertManagedProjectWritable } from './project-lifecycle.mjs';
import { addTrace, mutate, owner, readState, saveArtifact } from './state.mjs';
import { readSecret, redactKnownSecretStream, redactKnownSecretsSync } from './vault.mjs';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { createAssistWorktree } from './assist-v3-worktree.mjs';
import { pushV3Event } from './assist-v3-events.mjs';
import { resolveAssistTurnConfiguration } from './assist-v3-domain.mjs';
import { bindSessionRuntimeProfile } from './assist-v3-domain.mjs';
import { acquireBatchWriteLock, createBatchCheckpoint, ensureSessionChangeBatch } from './assist-change-batches.mjs';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { assertProfileAllowed, buildCodexContainerInvocation } from './container-runtime-config.mjs';
import { registerManagedProcessHandle, releaseManagedProcessHandle } from './container-runtime.mjs';
import { hostBridgeCapability } from './host-bridge-service.mjs';
import { createWindowsBridgeProcess } from './terminal-windows-bridge.mjs';

const runtimes = new Map();
const runtimeStarts = new Map();
const MAX_PREVIEW_CHARS = 30000;

export function terminalCapability() {
  const linuxAvailable = typeof pty.spawn === 'function';
  return {
    available: linuxAvailable,
    transport: 'node-pty+websocket',
    protocols: ['input', 'resize', 'signal', 'reconnect'],
    linux_container: { available: linuxAvailable, default: true, runtime: 'linux_container', transport: 'node-pty+websocket', protocols: ['input', 'resize', 'signal', 'reconnect'], reason: linuxAvailable ? null : 'pty_capability_unavailable' },
    windows_bridge: { available: false, runtime: 'windows_bridge', reason: 'windows_bridge_not_paired' },
    host_dev: { available: process.env.NODE_ENV !== 'production' && linuxAvailable, runtime: 'host_dev', reason: process.env.NODE_ENV === 'production' ? 'host_dev_disabled_in_production' : null },
    max_preview_chars: MAX_PREVIEW_CHARS
  };
}

export async function createTerminalSession(body) {
  const requestedRuntime = body.runtime || 'linux_container';
  if (!['linux_container', 'windows_bridge', 'host_dev'].includes(requestedRuntime)) throw new HttpError(400, { error: 'terminal_runtime_invalid' });
  if (requestedRuntime !== 'windows_bridge' && !terminalCapability().linux_container.available) throw new HttpError(501, { error: 'pty_capability_unavailable' });
  const snapshot = await readState(), project = snapshot.projects.find((item) => item.id === body.project_id);
  assertManagedProjectWritable(project);
  const assistSession = body.assist_session_id ? snapshot.assist_sessions.find((item) => item.id === body.assist_session_id && item.version === 3 && item.project_id === project.id && !item.archived_at) : null;
  if (body.assist_session_id && !assistSession) throw new HttpError(404, { error: 'assist_session_not_found' });
  const turn = body.turn_id ? snapshot.assist_turns.find((item) => item.id === body.turn_id && item.project_id === project.id) : null;
  if (body.turn_id && !turn) throw new HttpError(404, { error: 'assist_turn_not_found' });
  const configuration = resolveAssistTurnConfiguration(snapshot, body), profile = configuration.profile;
  assertProfileAllowed(profile);
  let bridgeCapability = null;
  if (requestedRuntime === 'windows_bridge') { if (!assistSession) throw new HttpError(409, { error: 'windows_bridge_assist_session_required' }); bridgeCapability = await hostBridgeCapability(); if (!bridgeCapability.available) throw new HttpError(409, { error: bridgeCapability.reason, action: bridgeCapability.reason === 'windows_bridge_not_paired' ? 'install_bridge' : 'check_bridge' }); }
  if (requestedRuntime === 'host_dev' && process.env.NODE_ENV === 'production') throw new HttpError(409, { error: 'host_dev_disabled_in_production' });
  const sessionId = id('tty');
  const sharedBatch = assistSession ? await ensureSessionChangeBatch(assistSession.id) : null;
  const prepared = sharedBatch ? { record: sharedBatch.worktree, batch: sharedBatch.batch } : body.worktree_id ? resolveExistingWorktree(snapshot, body.worktree_id, project.id) : { record: { ...await createAssistWorktree(project, { id: `cli-${sessionId}` }), turn_id: null, kind: 'cli' }, batch: null };
  const session = await mutate((state) => {
    const actor = owner(state);
    if (!sharedBatch && !body.worktree_id) state.worktrees.push(prepared.record);
    if (assistSession) bindSessionRuntimeProfile(state.assist_sessions.find((item) => item.id === assistSession.id), state.codex_profiles.find((item) => item.id === profile.id));
    const item = {
      id: sessionId, project_id: project.id, assist_session_id: assistSession?.id || turn?.session_id || null, turn_id: body.turn_id || null, worktree_id: prepared.record.id, profile_id: profile.id,
      change_batch_id: prepared.batch?.id || null,
      host_bridge_device_id: bridgeCapability?.device_id || null,
      model: configuration.model, reasoning: configuration.reasoning,
      runtime: requestedRuntime, status: 'ready', cols: clamp(body.cols, 40, 300, 120), rows: clamp(body.rows, 10, 120, 32),
      reconnect_token_hash: hashString(`${sessionId}:${Date.now()}`), output_preview: '', output_truncated: false, exit_code: null,
      created_by_user_id: actor.id, created_at: now(), updated_at: now()
    };
    state.terminal_sessions.push(item);
    if (item.assist_session_id) pushV3Event(state, item.assist_session_id, item.turn_id, 'terminal', { terminal_session_id: item.id, runtime: item.runtime, status: item.status });
    addTrace(state, 'terminal.session.created', { project_id: project.id, target_type: 'terminal_session', target_id: item.id, summary: `创建 ${item.runtime} Codex CLI Session。` }, actor.id);
    return item;
  });
  return publicSession(session);
}

export async function getTerminalSession(sessionId) {
  const state = await readState(), session = state.terminal_sessions.find((item) => item.id === sessionId);
  if (!session) throw new HttpError(404, { error: 'terminal_session_not_found' });
  return publicSession(session);
}

export async function listTerminalSessions({ projectId = null, assistSessionId = null } = {}) {
  const state = await readState();
  return state.terminal_sessions.filter((item) => (!projectId || item.project_id === projectId) && (!assistSessionId || item.assist_session_id === assistSessionId)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map(publicSession);
}

export async function stopTerminalSession(sessionId) {
  const runtime = runtimes.get(sessionId);
  const stopped = await mutate((state) => {
    const session = state.terminal_sessions.find((item) => item.id === sessionId);
    if (!session) throw new HttpError(404, { error: 'terminal_session_not_found' });
    if (!['exited', 'failed', 'stopped'].includes(session.status)) Object.assign(session, { status: 'stopped', stopped_at: now(), updated_at: now() });
    return publicSession(session);
  });
  if (!runtime?.process) return stopped;
  runtime.process.kill();
  await Promise.race([runtime.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
  return getTerminalSession(sessionId);
}

export function attachTerminalWebSocket(server) {
  const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname.replace(/^\/api/, '');
    const match = pathname.match(/^\/assist\/v3\/terminal-sessions\/([^/]+)\/ws$/);
    if (!match) return;
    sockets.handleUpgrade(request, socket, head, (ws) => connectSocket(ws, decodeURIComponent(match[1])).catch(() => ws.close(1011, 'terminal_unavailable')));
  });
  return sockets;
}

async function connectSocket(ws, sessionId) {
  const state = await readState(), session = state.terminal_sessions.find((item) => item.id === sessionId);
  if (!session) { ws.close(1008, 'terminal_session_not_found'); return; }
  let runtime = runtimes.get(sessionId);
  if (!runtime && !['exited', 'failed', 'stopped', 'interrupted'].includes(session.status)) {
    let starting = runtimeStarts.get(sessionId);
    if (!starting) { starting = startTerminal(session).finally(() => runtimeStarts.delete(sessionId)); runtimeStarts.set(sessionId, starting); }
    runtime = await starting;
  }
  if (!runtime) { ws.send(JSON.stringify({ type: 'status', session: publicSession(session) })); ws.close(1000, 'terminal_closed'); return; }
  runtime.clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', session: publicSession({ ...session, status: 'connected' }) }));
  if (runtime.preview) ws.send(JSON.stringify({ type: 'output', data: runtime.preview, replay: true }));
  ws.on('message', (raw) => handleClientMessage(runtime, raw));
  ws.on('close', () => runtime.clients.delete(ws));
}

async function startTerminal(session) {
  const state = await readState(), worktree = state.worktrees.find((item) => item.id === session.worktree_id), storedProfile = state.codex_profiles.find((item) => item.id === session.profile_id);
  if (!worktree || !storedProfile || !fs.existsSync(worktree.path)) throw new HttpError(409, { error: 'terminal_worktree_unavailable' });
  const profile = { ...storedProfile, model: session.model || storedProfile.model, reasoning: session.reasoning || storedProfile.reasoning };
  assertProfileAllowed(profile);
  let releaseBatchLock = null;
  if (session.change_batch_id) {
    releaseBatchLock = await acquireBatchWriteLock(session.change_batch_id, { kind: session.runtime === 'windows_bridge' ? 'windows_cli' : 'linux_cli', id: session.id });
    await createBatchCheckpoint(session.change_batch_id, { source: session.runtime === 'windows_bridge' ? 'windows_cli' : 'linux_cli', sourceId: session.id, phase: 'before' });
  }
  let processHandle, invocation = null;
  try {
    if (session.runtime === 'windows_bridge') processHandle = await createWindowsBridgeProcess({ session, worktree, profile });
    else {
      const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
      if (!codexAuthMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_profile_mismatch' });
      if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
      const credential = await readSecret(auth?.refs?.credential), invocationProfile = session.runtime === 'host_dev' ? { ...profile, kind: 'host' } : { ...profile, kind: 'docker' };
      invocation = terminalInvocation(invocationProfile, worktree.path, credential, session.id);
      processHandle = pty.spawn(invocation.command, invocation.args, { name: 'xterm-256color', cols: session.cols, rows: session.rows, cwd: worktree.path, env: invocation.env, useConpty: process.platform === 'win32' });
    }
  }
  catch (error) { await releaseBatchLock?.(); await mutate((data) => { const current = data.terminal_sessions.find((item) => item.id === session.id); if (current) Object.assign(current, { status: 'failed', error_code: session.runtime === 'windows_bridge' && /^[a-z0-9_.-]{1,120}$/i.test(String(error?.message || '')) ? error.message : 'terminal_spawn_failed', updated_at: now() }); }); throw error; }
  if (invocation?.runtime === 'docker') registerManagedProcessHandle(invocation, processHandle);
  const artifactDir = path.join(ARTIFACT_DIR, 'terminal'); await fsp.mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${Date.now()}_${safe(session.id)}.log`), outputStream = fs.createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 });
  let resolveDone; const done = new Promise((resolve) => { resolveDone = resolve; });
  const runtime = { process: processHandle, clients: new Set(), preview: '', redactionPending: '', sessionId: session.id, source: session.runtime === 'windows_bridge' ? 'windows_cli' : 'linux_cli', changeBatchId: session.change_batch_id, releaseBatchLock, artifactPath, outputStream, outputHash: crypto.createHash('sha256'), outputBytes: 0, outputError: null, done };
  outputStream.on('error', (error) => { runtime.outputError = error; });
  runtimes.set(session.id, runtime);
  processHandle.onData((chunk) => {
    const redacted = redactKnownSecretStream(chunk, runtime.redactionPending); runtime.redactionPending = redacted.pending;
    appendOutput(runtime, redacted.text);
  });
  processHandle.onExit(({ exitCode, signal }) => { if (invocation?.containerName) releaseManagedProcessHandle(invocation.containerName, processHandle); runtime.finalizing ||= finalizeTerminal(runtime, exitCode, signal).finally(resolveDone); });
  await mutate((data) => { const current = data.terminal_sessions.find((item) => item.id === session.id); if (current) { Object.assign(current, { status: 'running', pid: processHandle.pid, started_at: now(), updated_at: now() }); if (current.assist_session_id) pushV3Event(data, current.assist_session_id, current.turn_id, 'terminal', { terminal_session_id: current.id, runtime: current.runtime, status: current.status }); } });
  return runtime;
}

async function finalizeTerminal(runtime, exitCode, signal) {
  runtimes.delete(runtime.sessionId);
  try {
    if (runtime.redactionPending) { appendOutput(runtime, redactKnownSecretsSync(runtime.redactionPending)); runtime.redactionPending = ''; }
    const artifact = await finishTerminalArtifact(runtime);
    if (runtime.changeBatchId) await createBatchCheckpoint(runtime.changeBatchId, { source: runtime.source, sourceId: runtime.sessionId, phase: 'after', status: exitCode === 0 ? 'completed' : 'interrupted' }).catch(() => undefined);
    const session = await mutate((state) => {
      const actor = owner(state), current = state.terminal_sessions.find((item) => item.id === runtime.sessionId);
      if (!current) return null;
      state.file_refs.push(artifact);
      Object.assign(current, { status: current.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'exited' : 'failed', exit_code: exitCode, exit_signal: signal || null, error_code: exitCode !== 0 && runtime.source === 'windows_cli' ? signal || 'windows_bridge_terminal_failed' : current.error_code || null, pid: null, output_preview: runtime.preview, output_truncated: runtime.outputBytes > Buffer.byteLength(runtime.preview), artifact_file_ref_id: artifact.id, completed_at: now(), updated_at: now() });
      if (current.assist_session_id) pushV3Event(state, current.assist_session_id, current.turn_id, 'terminal', { terminal_session_id: current.id, runtime: current.runtime, status: current.status, exit_code: current.exit_code, artifact_file_ref_id: artifact.id });
      addTrace(state, 'terminal.session.completed', { project_id: current.project_id, target_type: 'terminal_session', target_id: current.id, raw_file_ref_id: artifact.id, summary: `Codex CLI Session ${current.status} (${exitCode})。` }, actor.id);
      return current;
    });
    if (runtime.releaseBatchLock) { const release = runtime.releaseBatchLock; runtime.releaseBatchLock = null; await release().catch(() => undefined); }
    broadcast(runtime, { type: 'exit', session: session ? publicSession(session) : null });
    for (const client of runtime.clients) client.close(1000, 'terminal_exited');
  } finally {
    if (runtime.releaseBatchLock) await runtime.releaseBatchLock().catch(() => undefined);
  }
}

function handleClientMessage(runtime, raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.type === 'input' && typeof message.data === 'string') runtime.process.write(message.data.slice(0, 65536));
  else if (message.type === 'resize') runtime.process.resize(clamp(message.cols, 20, 400, 120), clamp(message.rows, 5, 200, 32));
  else if (message.type === 'signal' && message.signal === 'SIGINT') runtime.process.write('\x03');
  else if (message.type === 'ping') broadcast(runtime, { type: 'pong', at: now() });
}

function terminalInvocation(profile, cwd, credential, sessionId) {
  const codexHome = profile.codex_home || path.join(AIWS_HOME, 'codex-homes', profile.id);
  const proxy = profile.kind === 'docker' ? codexContainerProxyEnv(process.env) : {};
  const env = { ...minimalTerminalEnv(), ...proxy, TERM: 'xterm-256color', COLORTERM: 'truecolor', CODEX_HOME: codexHome, ...(credential ? { OPENAI_API_KEY: credential } : {}) };
  const requested = process.env.AIWS_CODEX_BIN || 'codex';
  const commandArgs = profile.kind === 'docker' || isCodexCliExecutable(requested) ? terminalCodexArgs(profile) : [];
  if (profile.kind !== 'docker') return { ...prepareCodexInvocation(requested, commandArgs), env };
  return {
    ...buildCodexContainerInvocation({
      kind: 'terminal', sessionId, profileId: profile.id, image: profile.image || profile.config?.image,
      interactive: true, codexHome, workspace: cwd, workspaceMode: 'rw', extraMounts: profile.mounts || [],
      containerEnv: { TERM: 'xterm-256color', COLORTERM: 'truecolor', CODEX_HOME: '/codex-home', ...(credential ? { OPENAI_API_KEY: null } : {}), ...Object.fromEntries(Object.keys(proxy).map((key) => [key, null])) },
      commandArgs
    }), env
  };
}

export function terminalCodexArgs(profile) { return ['--model', profile.model, '-c', `model_reasoning_effort=${JSON.stringify(profile.reasoning || 'high')}`]; }
function isCodexCliExecutable(value) { return /^codex(?:\.cmd|\.ps1|\.exe|\.js)?$/i.test(path.basename(String(value || ''))); }

function resolveExistingWorktree(state, worktreeId, projectId) { const record = state.worktrees.find((item) => item.id === worktreeId && item.project_id === projectId), assistRoot = path.join(WORKSPACE_DIR, safe(projectId), 'worktrees'); if (!record || (!isWithin(WORKTREE_DIR, record.path) && !isWithin(assistRoot, record.path))) throw new HttpError(404, { error: 'worktree_not_found' }); return { record }; }
function publicSession(value) { return { id: value.id, project_id: value.project_id, assist_session_id: value.assist_session_id || null, turn_id: value.turn_id, worktree_id: value.worktree_id, change_batch_id: value.change_batch_id || null, profile_id: value.profile_id, model: value.model, reasoning: value.reasoning, runtime: value.runtime, status: value.status, cols: value.cols, rows: value.rows, exit_code: value.exit_code, error_code: value.error_code || null, output_preview: value.output_preview || '', output_truncated: Boolean(value.output_truncated), artifact_file_ref_id: value.artifact_file_ref_id || null, created_at: value.created_at, updated_at: value.updated_at }; }
function broadcast(runtime, message) { const encoded = JSON.stringify(message); for (const client of runtime.clients) if (client.readyState === 1) client.send(encoded); }
function clamp(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback; }
function safe(value) { return String(value || 'item').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function isWithin(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function minimalTerminalEnv() { return Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])); }
function appendOutput(runtime, safeOutput) { if (!safeOutput) return; const bytes = Buffer.from(safeOutput); runtime.outputHash.update(bytes); runtime.outputBytes += bytes.length; runtime.outputStream.write(bytes); runtime.preview = (runtime.preview + safeOutput).slice(-MAX_PREVIEW_CHARS); broadcast(runtime, { type: 'output', data: safeOutput }); }
async function finishTerminalArtifact(runtime) {
  try {
    if (runtime.outputError) throw runtime.outputError;
    await new Promise((resolve, reject) => { runtime.outputStream.once('error', reject); runtime.outputStream.end(resolve); });
    if (runtime.outputError) throw runtime.outputError;
    return { id: id('fil'), kind: 'terminal', absolute_path: runtime.artifactPath, relative_path: path.relative(path.dirname(DATA_DIR), runtime.artifactPath), sha256: runtime.outputHash.digest('hex'), size_bytes: runtime.outputBytes, content_type: 'text/plain', meta: { terminal_session_id: runtime.sessionId, complete: true }, created_at: now() };
  } catch {
    runtime.outputStream.destroy(); await fsp.rm(runtime.artifactPath, { force: true }).catch(() => undefined);
    return saveArtifact('terminal', `${runtime.sessionId}.log`, runtime.preview, { terminal_session_id: runtime.sessionId, complete: false });
  }
}
