import { randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';
import { readState } from './state.mjs';
import { createCodexEphemeralThread } from './codex-ephemeral-thread.mjs';
import { getSessionChangeBatch } from './assist-change-batches.mjs';
import { cleanText, readableProjectCwd, requireProject, requireSession } from './assist-v3-domain.mjs';
import { id, now } from '../../../packages/shared/index.mjs';

const BTW_TTL_MS = 15 * 60 * 1000;
const BTW_GLOBAL_LIMIT = 4;
const EVENT_LIMIT = 500;
const records = new Map();
const browserRecords = new Map();

const sweeper = setInterval(() => { void sweepExpiredBtw(); }, 30_000);
sweeper.unref?.();

export async function createAssistBtw(sessionId, input = {}, request = {}, dependencies = {}) {
  await sweepExpiredBtw();
  const browserId = normalizeBrowserId(input.browser_id || request.browserId);
  if (input.sensitive === true || /^(?:password|secret)$/i.test(String(input.control_type || ''))) throw new HttpError(403, { error: 'assist_btw_sensitive_selection' });
  const existingId = browserRecords.get(browserId);
  if (existingId) await disposeRecord(records.get(existingId), 'replaced');
  if (records.size >= BTW_GLOBAL_LIMIT) throw new HttpError(429, { error: 'assist_btw_capacity_reached', limit: BTW_GLOBAL_LIMIT });

  const state = await readState(), session = requireSession(state, sessionId), project = requireProject(state, session.project_id);
  const sourceTurn = state.assist_turns.filter((item) => item.session_id === session.id && item.status === 'completed' && item.codex_turn_id).sort((a, b) => String(a.completed_at || a.updated_at).localeCompare(String(b.completed_at || b.updated_at))).at(-1);
  if (!sourceTurn || !session.codex_thread_id || session.native_thread_repair_required || session.native_thread_generation === 1) throw new HttpError(409, { error: 'assist_btw_no_completed_turn' });
  const profile = state.codex_profiles.find((item) => item.id === session.runtime_profile_id && item.status === 'validated' && !item.assist_configuration);
  if (!profile) throw new HttpError(409, { error: 'assist_runtime_profile_unavailable' });
  const selection = cleanText(input.selection, 20_000), pageUrl = safePageUrl(input.page_url), createdAt = Date.now();
  const record = {
    id: id('btw'), browserId, sessionId: session.id, projectId: project.id,
    accessToken: randomBytes(32).toString('base64url'), conversation: null,
    status: 'initializing', createdAt, lastSeenAt: createdAt, sequence: 0,
    sourceTurnId: sourceTurn.id, sourceCodexTurnId: sourceTurn.codex_turn_id,
    events: [], listeners: new Set(), activeController: null
  };
  records.set(record.id, record); browserRecords.set(browserId, record.id);
  try {
    const batch = await getSessionChangeBatch(session.id), cwd = batch?.worktree?.path || readableProjectCwd(project);
    const createConversation = dependencies.createConversation || createCodexEphemeralThread;
    record.conversation = await createConversation({
      state, profile, cwd, sourceThreadId: session.codex_thread_id, sourceTurnId: sourceTurn.codex_turn_id,
      additionalContext: [{ kind: 'application', value: JSON.stringify({ schema: 'aiws.btw-context.v1', boundary: 'Read-only ephemeral BTW. Do not use tools, modify files, or delegate to sub-agents.', selection: selection || null, page_url: pageUrl }) }]
    });
    record.status = 'idle'; emit(record, 'ready', { source_turn_id: sourceTurn.id });
    return publicRecord(record, true);
  } catch (error) {
    await disposeRecord(record, 'initialization_failed');
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, { error: 'assist_btw_native_fork_failed', reason: safeErrorCode(error), retryable: true });
  }
}

export async function createAssistBtwTurn(btwId, input = {}, request = {}) {
  const record = requireRecord(btwId, input.access_token || request.accessToken);
  const content = cleanText(input.content ?? input.prompt, 100_000);
  if (!content) throw new HttpError(400, { error: 'assist_btw_turn_content_required' });
  if (record.status !== 'idle' || record.conversation?.busy) throw new HttpError(409, { error: 'assist_btw_busy' });
  touch(record); record.status = 'running';
  const turnId = id('btwt'), controller = new AbortController();
  record.activeController = controller;
  emit(record, 'user', { text: content }, turnId);
  const operation = record.conversation.sendTurn({
    prompt: content, signal: controller.signal,
    onEvent: (event) => {
      const type = event?.aiws_type || event?.type;
      if (!type || type === 'thread.started') return;
      emit(record, type, event.data || {}, turnId);
    }
  }).then((result) => {
    emit(record, 'completed', { output_text: result.output_text || '', codex_turn_id: result.turn_id || null }, turnId);
    record.status = 'idle'; record.activeController = null; touch(record);
  }).catch((error) => {
    emit(record, 'failed', { error: safeErrorCode(error) }, turnId);
    record.status = 'idle'; record.activeController = null; touch(record);
  });
  record.activeOperation = operation;
  return { id: turnId, btw_id: record.id, status: 'running', created_at: now() };
}

export async function streamAssistBtwEvents(req, res, btwId, { token, after = 0 } = {}) {
  const record = requireRecord(btwId, token);
  touch(record);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    connection: 'keep-alive', 'x-accel-buffering': 'no'
  });
  for (const event of record.events.filter((item) => item.sequence > Number(after || 0))) writeEvent(res, event);
  const listener = (event) => { if (!res.writableEnded) { writeEvent(res, event); if (event.type === 'closed') res.end(); } };
  record.listeners.add(listener);
  const heartbeat = setInterval(() => { if (!res.writableEnded) { touch(record); res.write(': heartbeat\n\n'); } }, 15_000);
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(heartbeat); record.listeners.delete(listener); resolve(); };
    req.once('close', finish); res.once('close', finish); res.once('finish', finish);
  });
}

export async function deleteAssistBtw(btwId, input = {}, request = {}) {
  const record = requireRecord(btwId, input.access_token || request.accessToken);
  await disposeRecord(record, 'closed');
  return { id: btwId, deleted: true };
}

export async function sweepExpiredBtw({ clock = () => Date.now() } = {}) {
  const expired = [...records.values()].filter((record) => clock() - record.lastSeenAt >= BTW_TTL_MS);
  for (const record of expired) await disposeRecord(record, 'expired');
  return expired.length;
}

export function attachBtwShutdown(server) {
  server.once('close', () => { void closeAllAssistBtw('service_stopped'); });
}

export async function closeAllAssistBtw(reason = 'service_stopped') {
  for (const record of [...records.values()]) await disposeRecord(record, reason);
}

export function assistBtwStatus() {
  return { active: records.size, limit: BTW_GLOBAL_LIMIT, ttl_ms: BTW_TTL_MS };
}

function requireRecord(idValue, tokenValue) {
  const record = records.get(String(idValue || ''));
  if (!record) throw new HttpError(404, { error: 'assist_btw_expired' });
  const token = String(tokenValue || '');
  if (!token || token.length !== record.accessToken.length || !timingSafeEqualText(token, record.accessToken)) throw new HttpError(403, { error: 'assist_btw_access_denied' });
  if (Date.now() - record.lastSeenAt >= BTW_TTL_MS) { void disposeRecord(record, 'expired'); throw new HttpError(410, { error: 'assist_btw_expired' }); }
  touch(record); return record;
}
function publicRecord(record, includeToken = false) { return { id: record.id, session_id: record.sessionId, browser_id: record.browserId, status: record.status, source_turn_id: record.sourceTurnId, expires_in_ms: BTW_TTL_MS, ...(includeToken ? { access_token: record.accessToken } : {}) }; }
function emit(record, type, data, turnId = null) {
  const event = { id: ++record.sequence, sequence: record.sequence, btw_id: record.id, turn_id: turnId, type, data, created_at: now() };
  record.events.push(event); if (record.events.length > EVENT_LIMIT) record.events.splice(0, record.events.length - EVENT_LIMIT);
  for (const listener of record.listeners) listener(event);
  return event;
}
async function disposeRecord(record, reason) {
  if (!record || !records.has(record.id)) return;
  records.delete(record.id); if (browserRecords.get(record.browserId) === record.id) browserRecords.delete(record.browserId);
  record.status = 'closed'; record.activeController?.abort();
  try { record.conversation?.close?.(); } catch { /* process is already closing */ }
  for (const listener of record.listeners) listener({ id: ++record.sequence, sequence: record.sequence, btw_id: record.id, turn_id: null, type: 'closed', data: { reason }, created_at: now() });
  record.listeners.clear();
}
function writeEvent(res, event) { res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
function touch(record) { record.lastSeenAt = Date.now(); }
function normalizeBrowserId(value) { const text = String(value || '').trim(); return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(text) ? text : `browser-${randomBytes(12).toString('hex')}`; }
function safePageUrl(value) { try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}${url.search}${url.hash}`.slice(0, 4000) : null; } catch { return null; } }
function timingSafeEqualText(left, right) { let different = left.length ^ right.length; for (let index = 0; index < Math.max(left.length, right.length); index++) different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0); return different === 0; }
function safeErrorCode(error) { const value = String(error?.payload?.error || error?.code || error?.message || 'assist_btw_failed'); return /^[a-z0-9_.-]{1,160}$/i.test(value) ? value : 'assist_btw_failed'; }

export { BTW_GLOBAL_LIMIT, BTW_TTL_MS };
