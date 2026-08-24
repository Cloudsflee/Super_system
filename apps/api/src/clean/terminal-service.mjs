import fs from 'node:fs';
import path from 'node:path';
import * as nodePty from 'node-pty';
import { opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, assertProject, assertRevision, createOperation, priorResponse, requestHash,
  requireIdempotency, requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 5 * 1024 * 1024;
const MAX_PREVIEW = 30_000;
const ACTIVE = new Set(['ready', 'running']);

/** Terminal owner backed by node-pty/ConPTY. terminal_events is only an index
 * over the canonical generic event stream and CAS chunks. */
export class CleanTerminalService {
  constructor({ db, cas, events, operations, authorization, projectWorkflow = null, clock, config = {}, pty = nodePty } = {}) {
    if (!db || !cas || !events || !operations || !authorization) throw new TypeError('terminal_service_dependencies_required');
    this.db = db; this.cas = cas; this.events = events; this.operations = operations;
    this.authorization = authorization; this.projectWorkflow = projectWorkflow; this.clock = clock;
    this.config = config; this.pty = pty; this.processes = new Map(); this.listeners = new Map(); this.outputBuffers = new Map(); this.closing = false;
    this.workspaceRoot = path.resolve(String(config.workspaceRoot || config.home || process.cwd()));
  }

  capabilities() {
    const windows = process.platform === 'win32';
    return {
      available: Boolean(this.pty?.spawn), transport: 'node-pty+websocket', protocols: ['input', 'resize', 'signal', 'cursor_replay'],
      default_runtime: windows ? 'windows_native' : 'linux_native', max_input_bytes: MAX_INPUT, max_output_bytes: MAX_OUTPUT, max_preview_chars: MAX_PREVIEW,
      linux_native: { available: !windows, runtime: 'linux_native', engine: 'forkpty', reason: windows ? 'platform_mismatch' : null },
      windows_native: { available: windows, runtime: 'windows_native', engine: 'conpty', git_bundle: windows, reason: windows ? null : 'platform_mismatch' }
    };
  }

  list(input = {}, principal) {
    requirePrincipal(principal); const projectId = input.project_id ? String(input.project_id) : null;
    if (projectId) assertProject(this.authorization, principal, 'read', projectId, { resource: 'terminal' });
    const rows = projectId ? this.db.query('SELECT * FROM terminal_sessions WHERE project_id=? ORDER BY updated_at DESC,id', [projectId]) : this.db.query('SELECT * FROM terminal_sessions WHERE created_by_actor_id=? ORDER BY updated_at DESC,id', [principal.actorId]);
    return { terminals: rows.map((row) => this.view(row)) };
  }

  get(id, principal) { const row = this.row(id); assertProject(this.authorization, principal, 'read', row.project_id, { resource: 'terminal' }); return this.view(row); }

  async open(input = {}, principal) {
    requirePrincipal(principal); const projectId = String(input.project_id || ''); assertProject(this.authorization, principal, 'run', projectId, { resource: 'terminal' });
    const approval = this.db.get('SELECT * FROM runtime_approvals WHERE id=? AND project_id=?', [String(input.approval_id || ''), projectId]);
    if (!approval || approval.status !== 'approved' || approval.action !== 'terminal.open') throw new PlatformError('approval_required', 'an approved terminal.open request is required', {}, 403);
    if (Date.parse(approval.expires_at) <= Date.parse(time(this.clock))) throw new PlatformError('approval_expired', 'terminal approval expired', {}, 409);
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=? AND project_id=?', [String(input.workspace_id || ''), projectId]);
    if (!workspace) throw new PlatformError('not_found', 'repository workspace not found', {}, 404);
    const requestedRuntime = String(input.runtime || this.capabilities().default_runtime); const capability = this.capabilities()[requestedRuntime];
    if (!capability?.available) throw new PlatformError('terminal_runtime_unavailable', 'requested terminal runtime is unavailable', { runtime: requestedRuntime }, 422);
    const cwdRelative = safeCwd(input.cwd || ''); const cwd = this.workspaceDirectory(workspace, cwdRelative); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); rejectReparse(cwd);
    const cols = boundedInt(input.cols, 20, 400, 120); const rows = boundedInt(input.rows, 5, 200, 32);
    const key = requireIdempotency(input.idempotency_key); const now = time(this.clock); const id = opaqueId('terminal');
    const hash = requestHash({ project_id: projectId, workspace_id: workspace.id, approval_id: approval.id, runtime: requestedRuntime, cwd: cwdRelative, cols, rows });
    const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'terminal.open', idempotencyKey: key, requestHash: hash, now }));
    if (replay) return replay;
    if (this.db.get('SELECT id FROM terminal_sessions WHERE approval_id=?', [approval.id])) throw new PlatformError('approval_consumed', 'terminal approval was already consumed', {}, 409);
    const lease = await this.acquireLease(workspace, principal);
    let child;
    try { child = this.spawn(requestedRuntime, cwd, cols, rows); }
    catch (error) { await this.releaseLease(workspace, principal).catch(() => undefined); throw new PlatformError('terminal_spawn_failed', 'terminal process did not start', { reason: String(error?.code || error?.message || '').slice(0, 120) }, 503); }
    try {
      const result = await this.db.withTransaction((tx) => {
        const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'terminal.open', idempotencyKey: key, requestHash: hash, now });
        if (prior) return prior;
        if (tx.get('SELECT id FROM terminal_sessions WHERE approval_id=?', [approval.id])) throw new PlatformError('approval_consumed', 'terminal approval was already consumed', {}, 409);
        const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'terminal.open', resourceType: 'terminal_session', resourceId: id, projectId, requestHash: hash, status: 'running', now });
        tx.run(`INSERT INTO terminal_sessions(id,project_id,workspace_id,approval_id,assist_session_id,operation_id,runtime,cwd_relative,status,cols,rows,last_client_sequence,output_bytes,output_preview,output_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
          VALUES(?,?,?,?,?,?,?,?,'running',?,?,0,0,'','',1,?,?,?,?)`, [id, projectId, workspace.id, approval.id, input.assist_session_id || null, op.id, requestedRuntime, cwdRelative, cols, rows, now, now, principal.actorId, principal.actorId]);
        const event = appendAggregate(this.events, tx, { aggregateType: 'terminal_session', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'terminal.opened', data: { terminal_id: id, runtime: requestedRuntime }, payload: { id, project_id: projectId, workspace_id: workspace.id, status: 'running', revision: 1 }, now });
        tx.run('INSERT INTO terminal_events(id,session_id,generic_event_id,generic_sequence,event_type,chunk_cas_hash,chunk_byte_length,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('terminal_event'), id, event.id, event.sequence, 'terminal.opened', null, 0, now]);
        this.operations.linkInTransaction(tx, op.id, [['terminal_session', id], ['repository_workspace', workspace.id]], now);
        const value = { terminal: this.view(tx.get('SELECT * FROM terminal_sessions WHERE id=?', [id])), operation: this.operations.summary(op), lease: { fencing_token_hash: sha256Hex(lease.token || '') } };
        saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'terminal.open', idempotencyKey: key, requestHash: hash, response: value, operationId: op.id, status: 201, now });
        return value;
      });
      if (result.replayed) { try { child.kill(); } catch {} await this.releaseLease(workspace, principal).catch(() => undefined); return result; }
      this.attach(id, child, principal);
      return result;
    } catch (error) { try { child.kill(); } catch {} await this.releaseLease(workspace, principal).catch(() => undefined); throw error; }
  }

  async input(id, frame = {}, principal) {
    const row = this.row(id); assertProject(this.authorization, principal, 'run', row.project_id, { resource: 'terminal' }); this.assertActive(row);
    const data = String(frame.data || ''); if (Buffer.byteLength(data) > MAX_INPUT) throw new PlatformError('terminal_input_too_large', 'terminal input frame exceeds 64 KiB', {}, 422);
    const accepted = this.acceptClientSequence(row, frame); const child = this.processes.get(row.id); if (!child) throw new PlatformError('terminal_orphaned', 'terminal process is no longer attached', {}, 409);
    child.write(data); return this.actionEvent(row.id, 'input', { client_sequence: accepted.sequence, byte_length: Buffer.byteLength(data) }, principal, accepted);
  }

  async resize(id, input = {}, principal) {
    const row = this.row(id); assertProject(this.authorization, principal, 'run', row.project_id, { resource: 'terminal' }); const cols = boundedInt(input.cols, 20, 400, row.cols); const rows = boundedInt(input.rows, 5, 200, row.rows); const request = await this.actionRequest(row, 'terminal.resize', input, { cols, rows }, principal); if (request.replay) return request.replay; this.assertActive(row); const accepted = this.acceptClientSequence(row, input); this.processes.get(row.id)?.resize(cols, rows); return this.actionEvent(row.id, 'resized', { client_sequence: accepted.sequence, cols, rows }, principal, { ...accepted, cols, rows }, request);
  }
  async signal(id, input = {}, principal) {
    const row = this.row(id); assertProject(this.authorization, principal, 'run', row.project_id, { resource: 'terminal' }); const signal = String(input.signal || 'SIGINT'); if (signal !== 'SIGINT') throw new PlatformError('signal_denied', 'only SIGINT is allowed', {}, 422); const request = await this.actionRequest(row, 'terminal.signal', input, { signal }, principal); if (request.replay) return request.replay; this.assertActive(row); const accepted = this.acceptClientSequence(row, input); const child = this.processes.get(row.id); if (!child) throw new PlatformError('terminal_orphaned', 'terminal process is no longer attached', {}, 409); child.write('\x03'); return this.actionEvent(row.id, 'signalled', { client_sequence: accepted.sequence, signal }, principal, accepted, request);
  }
  async stop(id, input = {}, principal) {
    const row = this.row(id); assertProject(this.authorization, principal, 'run', row.project_id, { resource: 'terminal' }); const request = await this.actionRequest(row, 'terminal.stop', input, {}, principal); if (request.replay) return request.replay; this.assertActive(row); const accepted = this.acceptClientSequence(row, input); await this.actionEvent(row.id, 'stop_requested', { client_sequence: accepted.sequence }, principal, accepted); const child = this.processes.get(row.id); if (child) { try { child.kill(); } catch {} } const result = await this.finish(id, 'stopped', null, principal); const response = { ...(result || { terminal: this.view(this.row(id)) }), action: 'stop' }; await this.db.withTransaction((tx) => saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: request.commandId, idempotencyKey: request.key, requestHash: request.hash, response, operationId: row.operation_id, status: 200, now: time(this.clock) })); return response;
  }

  eventsFor(id, input = {}, principal) {
    const row = this.row(id); assertProject(this.authorization, principal, 'read', row.project_id, { resource: 'terminal' });
    const replay = this.events.replay({ actorId: principal.actorId, projectId: row.project_id, aggregateType: 'terminal_session', aggregateId: row.id, cursor: input.cursor || 0, limit: input.limit || 500 });
    const byEvent = new Map(this.db.query(`SELECT * FROM terminal_events WHERE generic_event_id IN (${replay.events.map(() => '?').join(',') || "''"})`, replay.events.map((event) => event.id)).map((item) => [item.generic_event_id, item]));
    const hydrated = replay.events.map((event) => { const projection = byEvent.get(event.id); if (!projection?.chunk_cas_hash) return event; const bytes = this.cas.read(projection.chunk_cas_hash); return { ...event, data: { ...event.data, chunk: bytes.toString('utf8'), chunk_sha256: projection.chunk_cas_hash, chunk_byte_length: bytes.byteLength } }; });
    return { events: hydrated, next_cursor: replay.next_cursor, terminal: !ACTIVE.has(row.status), resource: { id: row.id, type: 'terminal_session', revision: Number(row.revision) }, cursor_sequence: replay.cursor_sequence };
  }

  subscribe(id, principal, listener) { const row = this.row(id); assertProject(this.authorization, principal, 'read', row.project_id, { resource: 'terminal' }); const key = String(id); const set = this.listeners.get(key) || new Set(); set.add(listener); this.listeners.set(key, set); return () => { set.delete(listener); if (!set.size) this.listeners.delete(key); }; }

  attach(id, child, principal) {
    this.processes.set(String(id), child);
    child.onData((data) => { if (!this.closing) this.recordOutput(id, data, principal).catch(() => this.finish(id, 'failed', null, principal, 'terminal_output_failed').catch(() => undefined)); });
    child.onExit(({ exitCode }) => { if (!this.closing) this.finish(id, 'closed', Number(exitCode), principal).catch(() => undefined); });
    this.publish(id, { type: 'status', session: this.view(this.row(id)) });
  }

  async recordOutput(id, value, principal) {
    const buffered = `${this.outputBuffers.get(String(id)) || ''}${String(value || '')}`;
    const split = outputSplit(buffered);
    this.outputBuffers.set(String(id), split.tail);
    if (!split.emit) return this.view(this.row(id));
    return this.persistOutput(id, split.emit, principal);
  }

  async persistOutput(id, value, principal) {
    const row = this.row(id); if (!ACTIVE.has(row.status)) return this.view(row);
    const clean = redactOutput(String(value || ''), this.workspaceRoot); const bytes = Buffer.from(clean, 'utf8'); if (!bytes.length) return this.view(row);
    if (Number(row.output_bytes) + bytes.byteLength > MAX_OUTPUT) { await this.finish(id, 'failed', null, principal, 'terminal_output_limit'); throw new PlatformError('terminal_output_limit', 'terminal output exceeded 5 MiB', {}, 422); }
    const chunk = this.cas.put(bytes, { mediaType: 'text/plain', metadata: { kind: 'terminal.output', terminal_id: row.id } }); const now = time(this.clock);
    const next = await this.db.withTransaction((tx) => { const current = tx.get('SELECT * FROM terminal_sessions WHERE id=?', [row.id]); if (!current || !ACTIVE.has(current.status)) return current; const revision = Number(current.revision) + 1; const preview = `${current.output_preview || ''}${clean}`.slice(-MAX_PREVIEW); const outputBytes = Number(current.output_bytes) + bytes.byteLength; const outputHash = sha256Hex(`${current.output_sha256 || ''}:${chunk.hash}`); tx.run('UPDATE terminal_sessions SET output_bytes=?,output_preview=?,output_sha256=?,revision=?,updated_at=? WHERE id=? AND revision=?', [outputBytes, preview, outputHash, revision, now, row.id, current.revision], 1); const event = appendAggregate(this.events, tx, { aggregateType: 'terminal_session', aggregateId: row.id, revision, operationId: current.operation_id, actorId: principal.actorId, projectId: current.project_id, type: 'terminal.output', data: { terminal_id: row.id, chunk_sha256: chunk.hash, chunk_byte_length: bytes.byteLength }, payload: { id: row.id, status: current.status, output_bytes: outputBytes, output_sha256: outputHash, revision }, now }); tx.run('INSERT INTO terminal_events(id,session_id,generic_event_id,generic_sequence,event_type,chunk_cas_hash,chunk_byte_length,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('terminal_event'), row.id, event.id, event.sequence, 'terminal.output', chunk.hash, bytes.byteLength, now]); return tx.get('SELECT * FROM terminal_sessions WHERE id=?', [row.id]); });
    this.publish(row.id, { type: 'output', data: clean, cursor: Number(this.db.get('SELECT MAX(generic_sequence) AS sequence FROM terminal_events WHERE session_id=?', [row.id])?.sequence || 0), session: this.view(next) }); return this.view(next);
  }

  async actionRequest(row, commandId, input, body, principal) {
    const expected = requireRevision(input.expected_revision); const sequence = Number(input.client_sequence); if (!Number.isInteger(sequence) || sequence < 1) throw new PlatformError('client_sequence_conflict', 'terminal client sequence must be positive', { actual_sequence: sequence }, 409); const key = requireIdempotency(input.idempotency_key); const hash = requestHash({ terminal_id: row.id, expected_revision: expected, client_sequence: sequence, ...body }); const now = time(this.clock); const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now })); return { commandId, key, hash, now, replay };
  }

  async actionEvent(id, action, data, principal, updates = {}, idempotency = null) {
    const now = time(this.clock); const result = await this.db.withTransaction((tx) => { if (idempotency) { const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: idempotency.commandId, idempotencyKey: idempotency.key, requestHash: idempotency.hash, now }); if (prior) return prior; } const current = tx.get('SELECT * FROM terminal_sessions WHERE id=?', [String(id)]); this.assertActive(current); assertRevision(current, updates.expectedRevision); if (Number(updates.sequence) !== Number(current.last_client_sequence) + 1) throw new PlatformError('client_sequence_conflict', 'terminal client sequence must be monotonic', { expected_sequence: Number(current.last_client_sequence) + 1, actual_sequence: Number(updates.sequence) }, 409); const revision = Number(current.revision) + 1; tx.run('UPDATE terminal_sessions SET cols=?,rows=?,last_client_sequence=?,revision=?,updated_at=? WHERE id=? AND revision=?', [updates.cols || current.cols, updates.rows || current.rows, updates.sequence, revision, now, current.id, current.revision], 1); const event = appendAggregate(this.events, tx, { aggregateType: 'terminal_session', aggregateId: current.id, revision, operationId: current.operation_id, actorId: principal.actorId, projectId: current.project_id, type: `terminal.${action}`, data: { terminal_id: current.id, ...data }, payload: { id: current.id, status: current.status, revision }, now }); tx.run('INSERT INTO terminal_events(id,session_id,generic_event_id,generic_sequence,event_type,chunk_cas_hash,chunk_byte_length,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('terminal_event'), current.id, event.id, event.sequence, `terminal.${action}`, null, 0, now]); const response = { terminal: this.view(tx.get('SELECT * FROM terminal_sessions WHERE id=?', [current.id])), operation: this.operations.summary(current.operation_id), cursor: event.sequence, action }; if (idempotency) saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: idempotency.commandId, idempotencyKey: idempotency.key, requestHash: idempotency.hash, response, operationId: current.operation_id, status: 200, now }); return response; }); this.publish(id, { type: 'ack', action, ...result }); return result;
  }

  async finish(id, status, exitCode, principal, errorCode = '') {
    const tail = this.outputBuffers.get(String(id)) || '';
    this.outputBuffers.delete(String(id));
    if (tail && errorCode !== 'terminal_output_limit') await this.persistOutput(id, tail, principal).catch(() => undefined);
    const row = this.db.get('SELECT * FROM terminal_sessions WHERE id=?', [String(id)]); if (!row || !ACTIVE.has(row.status)) return row ? { terminal: this.view(row) } : null; this.processes.delete(row.id); const now = time(this.clock);
    const result = await this.db.withTransaction((tx) => { const current = tx.get('SELECT * FROM terminal_sessions WHERE id=?', [row.id]); if (!current || !ACTIVE.has(current.status)) return { terminal: this.view(current) }; const revision = Number(current.revision) + 1; tx.run('UPDATE terminal_sessions SET status=?,exit_code=?,error_code=?,revision=?,updated_at=?,completed_at=? WHERE id=? AND revision=?', [status, exitCode, errorCode, revision, now, now, row.id, current.revision], 1); const event = appendAggregate(this.events, tx, { aggregateType: 'terminal_session', aggregateId: row.id, revision, operationId: current.operation_id, actorId: principal.actorId, projectId: current.project_id, type: `terminal.${status}`, data: { terminal_id: row.id, exit_code: exitCode, error_code: errorCode || undefined }, payload: { id: row.id, status, exit_code: exitCode, error_code: errorCode, revision }, now }); tx.run('INSERT INTO terminal_events(id,session_id,generic_event_id,generic_sequence,event_type,chunk_cas_hash,chunk_byte_length,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('terminal_event'), row.id, event.id, event.sequence, `terminal.${status}`, null, 0, now]); const op = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]); if (op?.status === 'running') this.operations.transitionInTransaction(tx, op.id, status === 'failed' ? 'failed' : 'succeeded', { expectedRevision: Number(op.revision), actorId: op.actor_id, projectId: current.project_id, ...(status === 'failed' ? { errorCode: errorCode || 'terminal_failed' } : { result: { terminal_id: row.id, exit_code: exitCode } }) }, now); return { terminal: this.view(tx.get('SELECT * FROM terminal_sessions WHERE id=?', [row.id])), cursor: event.sequence }; });
    await this.releaseLease(this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [row.workspace_id]), principal).catch(() => undefined); this.publish(row.id, { type: 'status', ...result }); return result;
  }

  acceptClientSequence(row, frame) { const sequence = Number(frame.client_sequence); if (!Number.isInteger(sequence) || sequence !== Number(row.last_client_sequence) + 1) throw new PlatformError('client_sequence_conflict', 'terminal client sequence must be monotonic', { expected_sequence: Number(row.last_client_sequence) + 1, actual_sequence: sequence }, 409); const expectedRevision = requireRevision(frame.expected_revision); assertRevision(row, expectedRevision); return { sequence, expectedRevision }; }
  assertActive(row) { if (!ACTIVE.has(row.status)) throw new PlatformError('terminal_inactive', 'terminal session is not active', { status: row.status }, 409); }
  row(id) { const row = this.db.get('SELECT * FROM terminal_sessions WHERE id=?', [String(id)]); if (!row) throw new PlatformError('not_found', 'terminal session not found', {}, 404); return row; }
  view(row) { if (!row) return null; return { id: row.id, project_id: row.project_id, workspace_id: row.workspace_id, approval_id: row.approval_id, assist_session_id: row.assist_session_id || null, operation_id: row.operation_id, runtime: row.runtime, cwd: row.cwd_relative, status: row.status, cols: Number(row.cols), rows: Number(row.rows), last_client_sequence: Number(row.last_client_sequence), output_bytes: Number(row.output_bytes), output_preview: row.output_preview || '', output_sha256: row.output_sha256 || null, output_truncated: Number(row.output_bytes) >= MAX_OUTPUT, exit_code: row.exit_code == null ? null : Number(row.exit_code), error_code: row.error_code || null, revision: Number(row.revision), latest_cursor: Number(this.db.get('SELECT MAX(generic_sequence) AS sequence FROM terminal_events WHERE session_id=?', [row.id])?.sequence || 0), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null }; }
  spawn(runtime, cwd, cols, rows) { const shell = runtime === 'windows_native' ? (process.env.COMSPEC || 'powershell.exe') : (process.env.SHELL || '/bin/sh'); const args = runtime === 'windows_native' && /powershell/i.test(shell) ? ['-NoLogo', '-NoProfile'] : []; return this.pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env: minimalEnvironment() }); }
  workspaceDirectory(workspace, cwd = '') { const base = resolveWithin(this.workspaceRoot, workspace.relative_path || `projects/${workspace.project_id}/workspace`); return cwd ? resolveWithin(base, cwd) : base; }
  async acquireLease(workspace, principal) { if (!this.projectWorkflow?.lockRepositoryWorkspace) throw new PlatformError('workspace_lease_unavailable', 'Repository workspace lease owner is unavailable', {}, 503); const result = await this.projectWorkflow.lockRepositoryWorkspace(workspace.id, { expected_revision: Number(workspace.revision), idempotency_key: `terminal-lease-${opaqueId('key')}` }, principal); return { token: String(result.lock?.fencing_token || ''), result }; }
  async releaseLease(workspace, principal) { if (!workspace || !this.projectWorkflow?.releaseRepositoryWorkspace) return; const current = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [workspace.id]); if (current?.status !== 'locked') return; await this.projectWorkflow.releaseRepositoryWorkspace(current.id, { expected_revision: Number(current.revision), idempotency_key: `terminal-release-${opaqueId('key')}` }, principal); }
  publish(id, frame) { for (const listener of this.listeners.get(String(id)) || []) { try { listener(frame); } catch {} } }

  async recoverPending() { const rows = this.db.query("SELECT * FROM terminal_sessions WHERE status IN ('ready','running')"); const now = time(this.clock); for (const row of rows) { await this.db.withTransaction((tx) => { const current = tx.get('SELECT * FROM terminal_sessions WHERE id=?', [row.id]); if (!current || !ACTIVE.has(current.status)) return; const revision = Number(current.revision) + 1; tx.run("UPDATE terminal_sessions SET status='orphaned',error_code='external_result_unknown',revision=?,updated_at=?,completed_at=? WHERE id=? AND revision=?", [revision, now, now, row.id, current.revision], 1); const event = appendAggregate(this.events, tx, { aggregateType: 'terminal_session', aggregateId: row.id, revision, operationId: current.operation_id, actorId: current.created_by_actor_id, projectId: current.project_id, type: 'terminal.orphaned', data: { terminal_id: row.id, error_code: 'external_result_unknown' }, payload: { id: row.id, status: 'orphaned', error_code: 'external_result_unknown', revision }, now }); tx.run('INSERT INTO terminal_events(id,session_id,generic_event_id,generic_sequence,event_type,chunk_cas_hash,chunk_byte_length,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('terminal_event'), row.id, event.id, event.sequence, 'terminal.orphaned', null, 0, now]); let op = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]); if (op && !['succeeded', 'failed', 'cancelled', 'expired'].includes(op.status)) { if (op.status === 'queued' || op.status === 'paused') { this.operations.transitionInTransaction(tx, op.id, 'running', { expectedRevision: Number(op.revision), actorId: op.actor_id, projectId: current.project_id }, now); op = tx.get('SELECT * FROM operations WHERE id=?', [op.id]); } if (op.status === 'running') this.operations.transitionInTransaction(tx, op.id, 'failed', { expectedRevision: Number(op.revision), actorId: op.actor_id, projectId: current.project_id, errorCode: 'external_result_unknown' }, now); } }); const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [row.workspace_id]); await this.releaseLease(workspace, { actorId: row.created_by_actor_id, effectiveActorId: row.created_by_actor_id, scopes: ['*'] }).catch(() => undefined); } return rows.length; }
  close() { this.closing = true; for (const child of this.processes.values()) { try { child.kill(); } catch {} } this.processes.clear(); this.listeners.clear(); this.outputBuffers.clear(); }
}

function boundedInt(value, minimum, maximum, fallback) { const number = value == null ? fallback : Number(value); if (!Number.isInteger(number) || number < minimum || number > maximum) throw new PlatformError('schema_invalid', 'terminal dimension is invalid', {}, 422); return number; }
function safeCwd(value) { const text = String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); if (!text) return ''; if (text.startsWith('/') || /^[A-Za-z]:\//.test(text) || text.split('/').includes('..') || text.split('/').includes('.git') || text.includes(':')) throw new PlatformError('path_policy_denied', 'terminal cwd must be a managed relative path', {}, 422); return text; }
function resolveWithin(root, relative) { const base = path.resolve(root); const clean = safeCwd(relative); const target = clean ? path.resolve(base, clean) : base; if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new PlatformError('path_policy_denied', 'path escapes the workspace', {}, 422); return target; }
function rejectReparse(target) { let current = path.parse(target).root; for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); if (!fs.existsSync(current)) continue; const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) throw new PlatformError('path_policy_denied', 'terminal cwd contains a link', {}, 422); } }
function redactOutput(value, root) { const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return String(value).replace(new RegExp(escaped, 'gi'), '[workspace]').replace(/(?:[A-Za-z]:\\|\/(?:home|Users|root)\/)[^\s"']+/g, '[path]').replace(/(?:sk-|ghp_|Bearer\s+)[A-Za-z0-9._~-]{8,}/gi, '[redacted]'); }
function outputSplit(value) { const text = String(value || ''); if (text.length <= 512) return { emit: '', tail: text }; const boundary = text.length - 256; let cut = -1; for (let index = boundary; index >= 0; index -= 1) { if (/\s/.test(text[index])) { cut = index + 1; break; } } if (cut < 0) return text.length <= 4096 ? { emit: '', tail: text } : { emit: '[redacted]', tail: text.slice(-256) }; return { emit: text.slice(0, cut), tail: text.slice(cut) }; }
function minimalEnvironment() { const allow = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'TERM', 'LANG']; return Object.fromEntries(allow.filter((key) => process.env[key] != null).map((key) => [key, String(process.env[key])]).concat([['AIWS_TERMINAL', '1']])); }
