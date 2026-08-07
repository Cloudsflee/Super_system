import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { asJson, id, now, parseJson } from './crypto.mjs';
import { AppError, assert } from './errors.mjs';
import { normalizeRelativePath } from './path-policy.mjs';

export const MAX_TERMINAL_PREVIEW_CHARS = 30_000;
export const MAX_TERMINAL_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_TERMINAL_EVENT_BYTES = 1024 * 1024;
const CLOSED_STATUSES = new Set(['exited', 'failed', 'stopped', 'orphaned']);

function clamp(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed))) : fallback;
}

function auditStatement(action, entityId, payload, actor = 'local-user') {
  return {
    sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)',
    params: [id('aud'), actor || 'local-user', action, 'terminal_session', entityId, asJson(payload), now()]
  };
}

function terminalEventStatement(sessionId, type, data) {
  return {
    sql: 'INSERT INTO terminal_events(session_id,type,data_json,created_at) VALUES(?,?,?,?)',
    params: [sessionId, type, asJson(data), now()]
  };
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    assist_session_id: row.assist_session_id || null,
    approval_id: row.approval_id,
    runtime: row.runtime,
    cwd: row.cwd || '',
    status: row.status,
    cols: Number(row.cols),
    rows: Number(row.rows),
    output_preview: row.output_preview || '',
    output_bytes: Number(row.output_bytes || 0),
    output_sha256: row.output_sha256 || '',
    output_truncated: Boolean(row.output_truncated),
    artifact_asset_id: row.artifact_asset_id || null,
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    error_code: row.error_code || null,
    revision: Number(row.revision),
    latest_cursor: Number(row.latest_cursor || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null
  };
}

function safeErrorCode(value, fallback = 'terminal_runtime_failed') {
  const normalized = String(value || '');
  return /^[a-z][a-z0-9_.-]{0,119}$/.test(normalized) ? normalized : fallback;
}

function minimalEnvironment() {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME',
    'USERPROFILE', 'LANG', 'LC_ALL', 'SHELL', 'PSModulePath'
  ];
  return {
    ...Object.fromEntries(allowed.filter((name) => process.env[name] != null).map((name) => [name, process.env[name]])),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  };
}

function shellInvocation() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/q'],
      runtime: 'windows_native',
      engine: 'conpty'
    };
  }
  return { command: '/bin/sh', args: ['-i'], runtime: 'linux_native', engine: 'forkpty' };
}

// node-pty's natural ConPTY exit path already has a native process-exit
// callback. Calling `kill()` from that callback invokes the process-list helper
// a second time and can leave a short-lived native worker behind. Release the
// handles owned by the terminal object directly for natural exits; explicit
// stops still use the public kill path below.
function releaseNaturalPtyHandles(processHandle) {
  if (process.platform !== 'win32') return;
  const agent = processHandle?._agent;
  if (!agent) return;
  try { agent._inSocket?.destroy(); } catch { /* The native handle may be closed already. */ }
  try { agent._outSocket?.destroy(); } catch { /* The native handle may be closed already. */ }
  try { agent._conoutSocketWorker?.dispose(); } catch { /* Cleanup is best effort after exit. */ }
}

function terminatePtyProcess(processHandle) {
  if (process.platform !== 'win32' || !processHandle?._agent?._useConpty) {
    try { processHandle.kill(); } catch { /* The process may already be exiting. */ }
    return;
  }
  const agent = processHandle._agent;
  try { agent._inSocket.readable = false; } catch { /* Native handle cleanup is best effort. */ }
  try { agent._outSocket.readable = false; } catch { /* Native handle cleanup is best effort. */ }
  try { agent._ptyNative.kill(agent._pty, agent._useConptyDll); } catch { /* Native cleanup is idempotent after exit. */ }
  try {
    const pid = Number(agent._innerPid);
    if (Number.isInteger(pid) && pid > 0) process.kill(pid);
  } catch { /* The child may have exited between status and teardown. */ }
  try { agent._conoutSocketWorker?.dispose(); } catch { /* Drain worker may already be disposed. */ }
  try { agent._inSocket.destroy(); } catch { /* Socket may already be closed. */ }
}

function rejectUpgrade(socket, status, reason) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function trustedLocalOrigin(origin, host) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const expected = String(host || '').toLowerCase();
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
      && parsed.host.toLowerCase() === expected;
  } catch {
    return false;
  }
}

function terminalDirectory(root, relative = '') {
  const base = path.resolve(root);
  const target = relative ? path.resolve(base, normalizeRelativePath(relative)) : base;
  assert(target === base || target.startsWith(`${base}${path.sep}`), 'terminal_path_invalid', 'terminal path escapes the managed workspace', { status: 422 });
  let realBase;
  let realTarget;
  try {
    realBase = fs.realpathSync(base);
    realTarget = fs.realpathSync(target);
  } catch {
    throw new AppError('terminal_path_unavailable', 'terminal working directory is unavailable', { status: 409 });
  }
  assert(realTarget === realBase || realTarget.startsWith(`${realBase}${path.sep}`), 'terminal_path_invalid', 'terminal path escapes the managed workspace', { status: 422 });
  const stat = fs.lstatSync(target);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'terminal_path_invalid', 'terminal working directory must be a regular directory', { status: 422 });
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    assert(!fs.lstatSync(current).isSymbolicLink(), 'terminal_path_invalid', 'terminal working directory cannot contain symbolic links', { status: 422 });
  }
  return realTarget;
}

function splitOutput(value, maximumBytes = 16 * 1024) {
  const output = [];
  let remaining = String(value || '');
  while (remaining) {
    let end = Math.min(remaining.length, maximumBytes);
    while (end > 1 && Buffer.byteLength(remaining.slice(0, end), 'utf8') > maximumBytes) end = Math.floor(end * 0.8);
    output.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return output;
}

function maskGenericSecrets(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s\x1b]{4,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(\s*[:=]\s*)([^\s,;]{4,})/gi, '$1$2[redacted]');
}

class TerminalControlFilter {
  constructor() {
    this.state = 'text';
  }

  push(value) {
    let output = '';
    for (const character of String(value || '')) {
      const code = character.charCodeAt(0);
      if (this.state === 'text') {
        if (character === '\x1b') this.state = 'escape';
        else if (character === '\r' || character === '\n' || character === '\t' || code >= 0x20) output += character;
      } else if (this.state === 'escape') {
        if (character === '[') this.state = 'csi';
        else if (character === ']') this.state = 'osc';
        else this.state = 'text';
      } else if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.state = 'text';
      } else if (this.state === 'osc') {
        if (character === '\x07') this.state = 'text';
        else if (character === '\x1b') this.state = 'osc_escape';
      } else if (this.state === 'osc_escape') {
        this.state = character === '\\' ? 'text' : 'osc';
      }
    }
    return output;
  }

  flush() {
    this.state = 'text';
    return '';
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TerminalRedactor {
  constructor(secrets = []) {
    this.secrets = [...new Set(secrets.map(String).filter((secret) => secret.length >= 4))];
    this.pending = '';
    this.controls = new TerminalControlFilter();
  }

  redact(value) {
    let text = maskGenericSecrets(value);
    for (const secret of this.secrets) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      text = text.replaceAll(secret, '[redacted]');
      if (encoded !== secret) text = text.replace(new RegExp(escapeRegex(encoded), 'g'), '[redacted]');
    }
    return text;
  }

  push(value) {
    const raw = `${this.pending}${this.controls.push(value)}`;
    let overlap = '';
    for (const secret of this.secrets) {
      for (const candidate of [secret, JSON.stringify(secret).slice(1, -1)]) {
        const limit = Math.min(raw.length, candidate.length - 1);
        for (let size = limit; size > overlap.length; size -= 1) {
          if (raw.endsWith(candidate.slice(0, size))) {
            overlap = raw.slice(-size);
            break;
          }
        }
      }
    }
    this.pending = overlap;
    return this.redact(raw.slice(0, raw.length - overlap.length));
  }

  flush() {
    this.controls.flush();
    const value = this.redact(this.pending);
    this.pending = '';
    return value;
  }
}

export class TerminalService {
  constructor({ db, config, resolveWorkspace, secrets = async () => [], captureArtifact = async () => null }) {
    this.db = db;
    this.config = config;
    this.resolveWorkspace = resolveWorkspace;
    this.secrets = secrets;
    this.captureArtifact = captureArtifact;
    this.runtimes = new Map();
    this.starts = new Map();
    this.sockets = new Set();
    this.accepting = true;
  }

  capabilities() {
    const available = typeof pty.spawn === 'function';
    const current = shellInvocation();
    return {
      available,
      transport: 'node-pty+websocket',
      protocols: ['input', 'resize', 'signal', 'cursor_replay'],
      default_runtime: current.runtime,
      max_preview_chars: MAX_TERMINAL_PREVIEW_CHARS,
      linux_native: {
        available: available && process.platform !== 'win32',
        runtime: 'linux_native',
        engine: 'forkpty',
        reason: process.platform === 'win32' ? 'linux_pty_unavailable' : available ? null : 'pty_unavailable'
      },
      windows_native: {
        available: available && process.platform === 'win32',
        runtime: 'windows_native',
        engine: 'conpty',
        git_bundle: true,
        reason: process.platform !== 'win32' ? 'windows_conpty_unavailable' : available ? null : 'conpty_unavailable'
      }
    };
  }

  async recover() {
    this.accepting = true;
    const running = await this.db.query("SELECT id,project_id FROM terminal_sessions WHERE status='running' ORDER BY created_at,id");
    for (const session of running) {
      const timestamp = now();
      await this.db.transaction([
        { sql: "UPDATE terminal_sessions SET status='orphaned',pid=NULL,error_code='terminal_process_lost',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='running'", params: [timestamp, timestamp, session.id], expect_changes: 1 },
        terminalEventStatement(session.id, 'terminal.orphaned', { error_code: 'terminal_process_lost' }),
        auditStatement('terminal_session.orphaned', session.id, { project_id: session.project_id }, 'system-recovery')
      ]);
    }
    return running.length;
  }

  async isProjectLocked(projectId) {
    const active = await this.db.get("SELECT id FROM terminal_sessions WHERE project_id=? AND status IN ('ready','running') LIMIT 1", [projectId]);
    return Boolean(active);
  }

  async list(projectId = null) {
    const rows = projectId
      ? await this.db.query(`SELECT s.*,(SELECT COALESCE(MAX(cursor),0) FROM terminal_events e WHERE e.session_id=s.id) AS latest_cursor
          FROM terminal_sessions s WHERE project_id=? ORDER BY updated_at DESC,id`, [projectId])
      : await this.db.query(`SELECT s.*,(SELECT COALESCE(MAX(cursor),0) FROM terminal_events e WHERE e.session_id=s.id) AS latest_cursor
          FROM terminal_sessions s ORDER BY updated_at DESC,id LIMIT 300`);
    return rows.map(publicSession);
  }

  async get(sessionId) {
    const row = await this.db.get(`SELECT s.*,(SELECT COALESCE(MAX(cursor),0) FROM terminal_events e WHERE e.session_id=s.id) AS latest_cursor
      FROM terminal_sessions s WHERE s.id=?`, [sessionId]);
    if (!row) throw new AppError('not_found', 'terminal session not found', { status: 404 });
    return publicSession(row);
  }

  async create(projectId, input = {}, ctx = {}) {
    assert(this.accepting, 'terminal_shutting_down', 'terminal runtime is shutting down', { status: 503, retryable: true });
    const capability = this.capabilities();
    assert(capability.available, 'terminal_unavailable', 'terminal capability is unavailable', { status: 503 });
    const runtime = String(input.runtime || capability.default_runtime);
    assert(['linux_native', 'windows_native'].includes(runtime), 'invalid_input', 'terminal runtime is invalid', { status: 422 });
    assert(capability[runtime]?.available, 'terminal_runtime_unavailable', 'terminal runtime is unavailable on this host', { status: 409, details: { runtime, reason: capability[runtime]?.reason } });
    const approvalId = String(input.approval_id || '').trim();
    assert(approvalId, 'terminal_approval_required', 'an approved terminal.open request is required', { status: 403 });
    await this.db.run("UPDATE runtime_approvals SET decision='expired',decided_at=COALESCE(decided_at,?) WHERE decision='pending' AND expires_at IS NOT NULL AND expires_at<=?", [now(), now()]);
    const approval = await this.db.get("SELECT * FROM runtime_approvals WHERE id=? AND project_id=? AND action='terminal.open'", [approvalId, projectId]);
    assert(approval?.decision === 'approved', 'terminal_approval_required', 'an approved terminal.open request is required', { status: 403 });
    assert(!approval.expires_at || Date.parse(approval.expires_at) > Date.now(), 'terminal_approval_expired', 'terminal approval has expired', { status: 409 });
    const assistSessionId = String(input.assist_session_id || '').trim() || null;
    if (assistSessionId) {
      const assist = await this.db.get("SELECT id FROM assist_sessions WHERE id=? AND project_id=? AND status IN ('active','paused')", [assistSessionId, projectId]);
      assert(assist, 'invalid_input', 'Assist session does not belong to the project', { status: 422 });
    }
    const workspace = await this.resolveWorkspace(projectId);
    const cwd = String(input.cwd || '').trim() ? normalizeRelativePath(String(input.cwd).trim()) : '';
    terminalDirectory(workspace.root, cwd);
    const sessionId = id('tty');
    const timestamp = now();
    const cols = clamp(input.cols, 20, 400, 120);
    const rows = clamp(input.rows, 5, 200, 32);
    try {
      await this.db.transaction([
        { sql: `INSERT INTO terminal_sessions(id,project_id,assist_session_id,approval_id,runtime,cwd,status,cols,rows,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'ready',?,?,?,?)`, params: [sessionId, projectId, assistSessionId, approvalId, runtime, cwd, cols, rows, timestamp, timestamp] },
        terminalEventStatement(sessionId, 'terminal.opened', { project_id: projectId, runtime, cwd, cols, rows }),
        ...(assistSessionId ? [{ sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [assistSessionId, null, 'assist.terminal.opened', asJson({ terminal_session_id: sessionId, runtime }), timestamp] }] : []),
        auditStatement('terminal_session.opened', sessionId, { project_id: projectId, runtime, approval_id: approvalId }, ctx.actor)
      ]);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('terminal_write_locked', 'the project already has an active terminal or the approval was consumed', { status: 409 });
      throw error;
    }
    return this.get(sessionId);
  }

  async events(sessionId, cursor = 0) {
    await this.get(sessionId);
    const after = Math.max(0, Number(cursor) || 0);
    return (await this.db.query('SELECT cursor,session_id,type,data_json,created_at FROM terminal_events WHERE session_id=? AND cursor>? ORDER BY cursor LIMIT 1000', [sessionId, after])).map((row) => ({
      cursor: Number(row.cursor), session_id: row.session_id, type: row.type,
      data: parseJson(row.data_json, {}), created_at: row.created_at
    }));
  }

  async action(sessionId, action, input = {}, ctx = {}) {
    if (action === 'stop') return this.stop(sessionId, ctx);
    assert(['input', 'resize', 'signal'].includes(action), 'invalid_input', 'terminal action is invalid', { status: 422 });
    const session = await this.get(sessionId);
    assert(!CLOSED_STATUSES.has(session.status), 'terminal_session_closed', 'terminal session is closed', { status: 409, details: { status: session.status } });
    const runtime = await this.ensureRuntime(sessionId);
    if (action === 'input') {
      const data = typeof input.data === 'string' ? input.data : '';
      assert(data.length > 0 && Buffer.byteLength(data, 'utf8') <= 64 * 1024, 'invalid_input', 'terminal input must contain at most 64 KiB', { status: 422 });
      runtime.process.write(data);
      await this.appendEvent(sessionId, 'terminal.input', { byte_size: Buffer.byteLength(data, 'utf8') });
    } else if (action === 'resize') {
      const cols = clamp(input.cols, 20, 400, session.cols);
      const rows = clamp(input.rows, 5, 200, session.rows);
      runtime.process.resize(cols, rows);
      await this.db.transaction([
        { sql: 'UPDATE terminal_sessions SET cols=?,rows=?,revision=revision+1,updated_at=? WHERE id=?', params: [cols, rows, now(), sessionId] },
        terminalEventStatement(sessionId, 'terminal.resized', { cols, rows })
      ]);
    } else {
      assert(input.signal === 'SIGINT', 'invalid_input', 'only SIGINT is allowed', { status: 422 });
      runtime.process.write('\x03');
      await this.appendEvent(sessionId, 'terminal.signalled', { signal: 'SIGINT' });
    }
    return this.get(sessionId);
  }

  async ensureRuntime(sessionId) {
    const active = this.runtimes.get(sessionId);
    if (active) return active;
    const pending = this.starts.get(sessionId);
    if (pending) return pending;
    const start = this.startRuntime(sessionId).finally(() => this.starts.delete(sessionId));
    this.starts.set(sessionId, start);
    return start;
  }

  async startRuntime(sessionId) {
    assert(this.accepting, 'terminal_shutting_down', 'terminal runtime is shutting down', { status: 503, retryable: true });
    const session = await this.get(sessionId);
    assert(session.status === 'ready', 'terminal_session_closed', 'terminal session is not ready', { status: 409, details: { status: session.status } });
    const workspace = await this.resolveWorkspace(session.project_id);
    const cwd = terminalDirectory(workspace.root, session.cwd);
    const invocation = shellInvocation();
    assert(invocation.runtime === session.runtime, 'terminal_runtime_unavailable', 'terminal runtime is unavailable on this host', { status: 409 });
    let processHandle;
    try {
      processHandle = pty.spawn(invocation.command, invocation.args, {
        name: 'xterm-256color', cols: session.cols, rows: session.rows, cwd,
        env: { ...minimalEnvironment(), AIWS_TERMINAL_SESSION_ID: session.id },
        useConpty: process.platform === 'win32'
      });
    } catch (error) {
      const errorCode = safeErrorCode(error?.code, 'terminal_spawn_failed');
      await this.db.transaction([
        { sql: "UPDATE terminal_sessions SET status='failed',error_code=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='ready'", params: [errorCode, now(), now(), sessionId], expect_changes: 1 },
        terminalEventStatement(sessionId, 'terminal.failed', { error_code: errorCode }),
        auditStatement('terminal_session.failed', sessionId, { project_id: session.project_id, error_code: errorCode }, 'system')
      ]);
      throw new AppError('terminal_spawn_failed', 'terminal process failed to start', { status: 503, retryable: true });
    }
    let resolveDone;
    const runtime = {
      sessionId,
      projectId: session.project_id,
      process: processHandle,
      clients: new Set(),
      redactor: new TerminalRedactor(await this.secrets()),
      preview: session.output_preview || '',
      totalBytes: Number(session.output_bytes || 0),
      eventBytes: 0,
      artifactBytes: 0,
      artifactChunks: [],
      digest: createHash('sha256'),
      outputTruncated: Boolean(session.output_truncated),
      stopRequested: false,
      outputError: null,
      finalizing: null,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      resolveDone
    };
    this.runtimes.set(sessionId, runtime);
    runtime.queue = this.db.transaction([
      { sql: "UPDATE terminal_sessions SET status='running',pid=?,started_at=?,updated_at=?,revision=revision+1 WHERE id=? AND status='ready'", params: [Number(processHandle.pid) || null, now(), now(), sessionId], expect_changes: 1 },
      terminalEventStatement(sessionId, 'terminal.started', { runtime: session.runtime, engine: invocation.engine }),
      auditStatement('terminal_session.started', sessionId, { project_id: session.project_id, runtime: session.runtime }, 'system')
    ]);
    processHandle.onData((chunk) => {
      runtime.queue = runtime.queue.then(() => this.handleRawOutput(runtime, chunk)).catch((error) => this.handleOutputFailure(runtime, error));
    });
    processHandle.onExit(({ exitCode, signal }) => {
      releaseNaturalPtyHandles(processHandle);
      runtime.finalizing ||= runtime.queue
        .then(() => this.finalizeRuntime(runtime, Number(exitCode), signal))
        .catch((error) => this.finalizeRuntime(runtime, Number(exitCode) || 1, safeErrorCode(error?.code)))
        .finally(resolveDone);
    });
    await runtime.queue;
    this.broadcast(runtime, { type: 'status', session: await this.get(sessionId) });
    return runtime;
  }

  async handleRawOutput(runtime, raw) {
    const safe = runtime.redactor.push(raw);
    if (safe) await this.persistOutput(runtime, safe);
  }

  async persistOutput(runtime, safeOutput) {
    const bytes = Buffer.from(safeOutput, 'utf8');
    runtime.totalBytes += bytes.byteLength;
    runtime.digest.update(bytes);
    runtime.preview = `${runtime.preview}${safeOutput}`.slice(-MAX_TERMINAL_PREVIEW_CHARS);
    const remainingArtifact = Math.max(0, MAX_TERMINAL_ARTIFACT_BYTES - runtime.artifactBytes);
    if (remainingArtifact) {
      const portion = bytes.subarray(0, remainingArtifact);
      runtime.artifactChunks.push(Buffer.from(portion));
      runtime.artifactBytes += portion.byteLength;
    }
    if (bytes.byteLength > remainingArtifact || runtime.totalBytes > Buffer.byteLength(runtime.preview, 'utf8')) runtime.outputTruncated = true;
    for (const segment of splitOutput(safeOutput)) {
      const segmentBytes = Buffer.byteLength(segment, 'utf8');
      if (runtime.eventBytes + segmentBytes > MAX_TERMINAL_EVENT_BYTES) {
        runtime.outputTruncated = true;
        this.broadcast(runtime, { type: 'output', data: segment, cursor: null, replay: false });
        continue;
      }
      runtime.eventBytes += segmentBytes;
      const cursor = await this.appendEvent(runtime.sessionId, 'terminal.output', { data: segment });
      this.broadcast(runtime, { type: 'output', data: segment, cursor, replay: false });
    }
    await this.db.run('UPDATE terminal_sessions SET output_preview=?,output_bytes=?,output_truncated=?,updated_at=? WHERE id=?', [runtime.preview, runtime.totalBytes, runtime.outputTruncated ? 1 : 0, now(), runtime.sessionId]);
  }

  async handleOutputFailure(runtime, error) {
    runtime.outputError = safeErrorCode(error?.code, 'terminal_output_persist_failed');
    terminatePtyProcess(runtime.process);
  }

  async finalizeRuntime(runtime, exitCode, signal) {
    if (!this.runtimes.has(runtime.sessionId)) return this.get(runtime.sessionId);
    const tail = runtime.redactor.flush();
    if (tail) await this.persistOutput(runtime, tail);
    this.runtimes.delete(runtime.sessionId);
    let artifact = null;
    try {
      artifact = await this.captureArtifact(runtime.projectId, runtime.sessionId, Buffer.concat(runtime.artifactChunks));
    } catch {
      runtime.outputError ||= 'terminal_artifact_failed';
    }
    const current = await this.get(runtime.sessionId);
    const status = runtime.stopRequested ? 'stopped' : exitCode === 0 && !runtime.outputError ? 'exited' : 'failed';
    const errorCode = runtime.outputError || (status === 'failed' ? safeErrorCode(signal, 'terminal_process_failed') : '');
    const timestamp = now();
    const digest = runtime.digest.digest('hex');
    await this.db.transaction([
      { sql: `UPDATE terminal_sessions SET status=?,pid=NULL,output_preview=?,output_bytes=?,output_sha256=?,output_truncated=?,artifact_asset_id=?,exit_code=?,error_code=?,revision=revision+1,updated_at=?,completed_at=?
        WHERE id=? AND status IN ('ready','running')`, params: [status, runtime.preview, runtime.totalBytes, digest, runtime.outputTruncated ? 1 : 0, artifact?.id || null, Number.isInteger(exitCode) ? exitCode : null, errorCode, timestamp, timestamp, runtime.sessionId], expect_changes: 1 },
      terminalEventStatement(runtime.sessionId, 'terminal.closed', { status, exit_code: Number.isInteger(exitCode) ? exitCode : null, error_code: errorCode || null, artifact_asset_id: artifact?.id || null, output_sha256: digest }),
      auditStatement('terminal_session.closed', runtime.sessionId, { project_id: current.project_id, status, exit_code: Number.isInteger(exitCode) ? exitCode : null, artifact_asset_id: artifact?.id || null }, 'system')
    ]);
    const session = await this.get(runtime.sessionId);
    this.broadcast(runtime, { type: 'exit', session });
    for (const client of runtime.clients) client.close(1000, 'terminal_closed');
    return session;
  }

  async stop(sessionId, ctx = {}) {
    const session = await this.get(sessionId);
    if (CLOSED_STATUSES.has(session.status)) return session;
    const runtime = this.runtimes.get(sessionId);
    if (!runtime && session.status === 'ready') {
      const timestamp = now();
      await this.db.transaction([
        { sql: "UPDATE terminal_sessions SET status='stopped',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='ready'", params: [timestamp, timestamp, sessionId], expect_changes: 1 },
        terminalEventStatement(sessionId, 'terminal.closed', { status: 'stopped', exit_code: null }),
        auditStatement('terminal_session.stopped', sessionId, { project_id: session.project_id }, ctx.actor)
      ]);
      return this.get(sessionId);
    }
    const active = runtime || await this.ensureRuntime(sessionId);
    active.stopRequested = true;
    terminatePtyProcess(active.process);
    await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    return this.get(sessionId);
  }

  async appendEvent(sessionId, type, data) {
    const result = await this.db.run('INSERT INTO terminal_events(session_id,type,data_json,created_at) VALUES(?,?,?,?)', [sessionId, type, asJson(data), now()]);
    return Number(result.lastInsertRowid);
  }

  broadcast(runtime, message) {
    const encoded = JSON.stringify(message);
    for (const client of runtime.clients) if (client.readyState === 1) client.send(encoded);
  }

  attach(server) {
    const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 128 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      let parsed;
      try { parsed = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`); }
      catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
      const match = parsed.pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/ws$/);
      if (!match) return;
      if (!trustedLocalOrigin(request.headers.origin, request.headers.host)) return rejectUpgrade(socket, 403, 'Forbidden');
      let sessionId;
      try { sessionId = decodeURIComponent(match[1]); }
      catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
      sockets.handleUpgrade(request, socket, head, (websocket) => {
        this.connect(websocket, sessionId, parsed).catch(() => websocket.close(1011, 'terminal_unavailable'));
      });
    });
    this.sockets.add(sockets);
    return sockets;
  }

  async connect(websocket, sessionId, parsed) {
    const initial = Math.max(0, Number(parsed.searchParams.get('after')) || 0);
    let session;
    try { session = await this.get(sessionId); }
    catch { websocket.close(1008, 'terminal_session_not_found'); return; }
    if (CLOSED_STATUSES.has(session.status)) {
      websocket.send(JSON.stringify({ type: 'status', session }));
      for (const event of await this.events(sessionId, initial)) this.sendReplay(websocket, event);
      websocket.close(1000, 'terminal_closed');
      return;
    }
    let runtime;
    try { runtime = await this.ensureRuntime(sessionId); }
    catch (error) { websocket.send(JSON.stringify({ type: 'error', error: { code: safeErrorCode(error?.code), message: 'terminal runtime unavailable' } })); websocket.close(1011, 'terminal_unavailable'); return; }
    runtime.clients.add(websocket);
    session = await this.get(sessionId);
    websocket.send(JSON.stringify({ type: 'status', session }));
    for (const event of await this.events(sessionId, initial)) this.sendReplay(websocket, event);
    websocket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); }
      catch { websocket.send(JSON.stringify({ type: 'error', error: { code: 'invalid_json', message: 'terminal frame must be JSON' } })); return; }
      if (message.type === 'ping') { websocket.send(JSON.stringify({ type: 'pong', at: now() })); return; }
      this.action(sessionId, message.type, message, { actor: 'local-user' })
        .then((value) => websocket.readyState === 1 && websocket.send(JSON.stringify({ type: 'ack', action: message.type, session: value })))
        .catch((error) => websocket.readyState === 1 && websocket.send(JSON.stringify({ type: 'error', error: { code: safeErrorCode(error?.code, 'terminal_action_failed'), message: String(error?.message || 'terminal action failed').slice(0, 200) } })));
    });
    websocket.on('close', () => runtime.clients.delete(websocket));
  }

  sendReplay(websocket, event) {
    if (event.type === 'terminal.output') websocket.send(JSON.stringify({ type: 'output', data: String(event.data?.data || ''), cursor: event.cursor, replay: true }));
    else websocket.send(JSON.stringify({ type: 'event', event }));
  }

  async shutdown() {
    if (!this.accepting) return;
    this.accepting = false;
    await Promise.allSettled([...this.starts.values()]);
    for (const runtime of this.runtimes.values()) for (const client of runtime.clients) client.close(1012, 'server_shutdown');
    await Promise.allSettled([...this.runtimes.keys()].map((sessionId) => this.stop(sessionId, { actor: 'system-shutdown' })));
    for (const sockets of this.sockets) {
      try { sockets.close(); } catch { /* noServer transports may already be closed. */ }
    }
    this.sockets.clear();
  }
}
