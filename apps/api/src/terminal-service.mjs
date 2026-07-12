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
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from './codex-service.mjs';
import { materializeDeviceAuth } from './codex-device-auth.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { assertProfileAllowed, buildCodexContainerInvocation } from './container-runtime-config.mjs';
import { registerManagedProcessHandle, releaseManagedProcessHandle } from './container-runtime.mjs';

const runtimes = new Map();
const runtimeStarts = new Map();
const MAX_PREVIEW_CHARS = 30000;

export function terminalCapability() {
  return { available: typeof pty.spawn === 'function', transport: 'node-pty+websocket', protocols: ['input', 'resize', 'signal', 'reconnect'], max_preview_chars: MAX_PREVIEW_CHARS };
}

export async function createTerminalSession(body) {
  if (!terminalCapability().available) throw new HttpError(501, { error: 'pty_capability_unavailable' });
  const snapshot = await readState(), project = snapshot.projects.find((item) => item.id === body.project_id);
  assertManagedProjectWritable(project);
  const assistSession = body.assist_session_id ? snapshot.assist_sessions.find((item) => item.id === body.assist_session_id && item.version === 3 && item.project_id === project.id && !item.archived_at) : null;
  if (body.assist_session_id && !assistSession) throw new HttpError(404, { error: 'assist_session_not_found' });
  const turn = body.turn_id ? snapshot.assist_turns.find((item) => item.id === body.turn_id && item.project_id === project.id) : null;
  if (body.turn_id && !turn) throw new HttpError(404, { error: 'assist_turn_not_found' });
  const requestedProfile = body.profile_id ? snapshot.codex_profiles.find((item) => item.id === body.profile_id && item.status === 'validated') : null;
  if (body.profile_id && !requestedProfile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  const profile = requestedProfile || snapshot.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw new HttpError(409, { error: 'active_codex_profile_required' });
  assertProfileAllowed(profile);
  const sessionId = id('tty');
  const prepared = body.worktree_id ? resolveExistingWorktree(snapshot, body.worktree_id, project.id) : { record: { ...await createAssistWorktree(project, { id: `cli-${sessionId}` }), turn_id: null, kind: 'cli' } };
  const session = await mutate((state) => {
    const actor = owner(state);
    if (!body.worktree_id) state.worktrees.push(prepared.record);
    const item = {
      id: sessionId, project_id: project.id, assist_session_id: assistSession?.id || turn?.session_id || null, turn_id: body.turn_id || null, worktree_id: prepared.record.id, profile_id: profile.id,
      runtime: profile.kind === 'docker' ? 'docker' : 'host', status: 'ready', cols: clamp(body.cols, 40, 300, 120), rows: clamp(body.rows, 10, 120, 32),
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
  const state = await readState(), worktree = state.worktrees.find((item) => item.id === session.worktree_id), profile = state.codex_profiles.find((item) => item.id === session.profile_id);
  if (!worktree || !profile || !fs.existsSync(worktree.path)) throw new HttpError(409, { error: 'terminal_worktree_unavailable' });
  assertProfileAllowed(profile);
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_profile_mismatch' });
  if (auth.home && !isThirdPartyProvider(profile.provider)) await materializeDeviceAuth(auth.home, profile.codex_home);
  const credential = await readSecret(auth?.refs?.credential);
  const invocation = terminalInvocation(profile, worktree.path, credential, session.id);
  let processHandle;
  try { processHandle = pty.spawn(invocation.command, invocation.args, { name: 'xterm-256color', cols: session.cols, rows: session.rows, cwd: worktree.path, env: invocation.env, useConpty: process.platform === 'win32' }); }
  catch (error) { await mutate((data) => { const current = data.terminal_sessions.find((item) => item.id === session.id); if (current) Object.assign(current, { status: 'failed', error_code: 'terminal_spawn_failed', updated_at: now() }); }); throw error; }
  if (invocation.runtime === 'docker') registerManagedProcessHandle(invocation, processHandle);
  const artifactDir = path.join(ARTIFACT_DIR, 'terminal'); await fsp.mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${Date.now()}_${safe(session.id)}.log`), outputStream = fs.createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 });
  let resolveDone; const done = new Promise((resolve) => { resolveDone = resolve; });
  const runtime = { process: processHandle, clients: new Set(), preview: '', redactionPending: '', sessionId: session.id, artifactPath, outputStream, outputHash: crypto.createHash('sha256'), outputBytes: 0, outputError: null, done };
  outputStream.on('error', (error) => { runtime.outputError = error; });
  runtimes.set(session.id, runtime);
  processHandle.onData((chunk) => {
    const redacted = redactKnownSecretStream(chunk, runtime.redactionPending); runtime.redactionPending = redacted.pending;
    appendOutput(runtime, redacted.text);
  });
  processHandle.onExit(({ exitCode, signal }) => { if (invocation.containerName) releaseManagedProcessHandle(invocation.containerName, processHandle); runtime.finalizing ||= finalizeTerminal(runtime, exitCode, signal).finally(resolveDone); });
  await mutate((data) => { const current = data.terminal_sessions.find((item) => item.id === session.id); if (current) { Object.assign(current, { status: 'running', pid: processHandle.pid, started_at: now(), updated_at: now() }); if (current.assist_session_id) pushV3Event(data, current.assist_session_id, current.turn_id, 'terminal', { terminal_session_id: current.id, runtime: current.runtime, status: current.status }); } });
  return runtime;
}

async function finalizeTerminal(runtime, exitCode, signal) {
  runtimes.delete(runtime.sessionId);
  if (runtime.redactionPending) { appendOutput(runtime, redactKnownSecretsSync(runtime.redactionPending)); runtime.redactionPending = ''; }
  const artifact = await finishTerminalArtifact(runtime);
  const session = await mutate((state) => {
    const actor = owner(state), current = state.terminal_sessions.find((item) => item.id === runtime.sessionId);
    if (!current) return null;
    state.file_refs.push(artifact);
    Object.assign(current, { status: current.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'exited' : 'failed', exit_code: exitCode, exit_signal: signal || null, pid: null, output_preview: runtime.preview, output_truncated: runtime.outputBytes > Buffer.byteLength(runtime.preview), artifact_file_ref_id: artifact.id, completed_at: now(), updated_at: now() });
    if (current.assist_session_id) pushV3Event(state, current.assist_session_id, current.turn_id, 'terminal', { terminal_session_id: current.id, runtime: current.runtime, status: current.status, exit_code: current.exit_code, artifact_file_ref_id: artifact.id });
    addTrace(state, 'terminal.session.completed', { project_id: current.project_id, target_type: 'terminal_session', target_id: current.id, raw_file_ref_id: artifact.id, summary: `Codex CLI Session ${current.status} (${exitCode})。` }, actor.id);
    return current;
  });
  broadcast(runtime, { type: 'exit', session: session ? publicSession(session) : null });
  for (const client of runtime.clients) client.close(1000, 'terminal_exited');
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
  if (profile.kind !== 'docker') return { ...prepareCodexInvocation(process.env.AIWS_CODEX_BIN || 'codex'), env };
  return {
    ...buildCodexContainerInvocation({
      kind: 'terminal', sessionId, profileId: profile.id, image: profile.image || profile.config?.image,
      interactive: true, codexHome, workspace: cwd, workspaceMode: 'rw', extraMounts: profile.mounts || [],
      containerEnv: { TERM: 'xterm-256color', COLORTERM: 'truecolor', CODEX_HOME: '/codex-home', ...(credential ? { OPENAI_API_KEY: null } : {}), ...Object.fromEntries(Object.keys(proxy).map((key) => [key, null])) },
      commandArgs: []
    }), env
  };
}

function resolveExistingWorktree(state, worktreeId, projectId) { const record = state.worktrees.find((item) => item.id === worktreeId && item.project_id === projectId), assistRoot = path.join(WORKSPACE_DIR, safe(projectId), 'worktrees'); if (!record || (!isWithin(WORKTREE_DIR, record.path) && !isWithin(assistRoot, record.path))) throw new HttpError(404, { error: 'worktree_not_found' }); return { record }; }
function publicSession(value) { return { id: value.id, project_id: value.project_id, assist_session_id: value.assist_session_id || null, turn_id: value.turn_id, worktree_id: value.worktree_id, profile_id: value.profile_id, runtime: value.runtime, status: value.status, cols: value.cols, rows: value.rows, exit_code: value.exit_code, error_code: value.error_code || null, output_preview: value.output_preview || '', output_truncated: Boolean(value.output_truncated), artifact_file_ref_id: value.artifact_file_ref_id || null, created_at: value.created_at, updated_at: value.updated_at }; }
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
