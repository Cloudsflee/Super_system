import { HttpError } from './http.mjs';
import { mutate, readState } from './state.mjs';
import { hashString, id, maskSecret, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { cleanText, requireSession, requireTurn, safeNumber, safeViewPath, TERMINAL_TURN_STATES } from './assist-v3-domain.mjs';

export function pushV3Event(state, sessionId, turnId, type, data = {}) {
  const sequence = Math.max(0, ...state.assist_events.filter((item) => item.session_id === sessionId).map((item) => Number(item.sequence) || 0)) + 1;
  const event = { id: sequence, sequence, session_id: sessionId, turn_id: turnId, type, data: maskSecretsDeep(data), created_at: now() };
  state.assist_events.push(event); return event;
}

export async function persistV3CodexEvent(sessionId, turnId, event) {
  const normalized = normalizeCodexEvent(event);
  if (!normalized) return;
  return mutate((state) => {
    const turn = state.assist_turns.find((item) => item.id === turnId);
    if (!turn || TERMINAL_TURN_STATES.has(turn.status)) return null;
    if (normalized.type === 'usage') turn.usage = normalized.data;
    if (normalized.type === 'approval') attachRuntimeApproval(state, turn, normalized);
    return pushV3Event(state, sessionId, turnId, normalized.type, normalized.data);
  });
}
export async function persistV3TypedEvent(sessionId, turnId, type, data = {}) {
  return mutate((state) => {
    const turn = state.assist_turns.find((item) => item.id === turnId);
    if (!turn || TERMINAL_TURN_STATES.has(turn.status)) return null;
    const normalized = { type, data: maskSecretsDeep(data) };
    if (type === 'usage') turn.usage = normalized.data;
    if (type === 'approval') attachRuntimeApproval(state, turn, normalized);
    return pushV3Event(state, sessionId, turnId, type, normalized.data);
  });
}

export async function streamV3Events(req, res, { sessionId, turnId = null, after = 0 } = {}) {
  let cursor = Number(after || req.headers['last-event-id'] || 0);
  const initial = await readState();
  const session = sessionId ? requireSession(initial, sessionId, true) : requireSession(initial, requireTurn(initial, turnId).session_id, true);
  if (turnId && requireTurn(initial, turnId).session_id !== session.id) throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  await new Promise((resolve) => {
    let closed = false;
    const finish = () => { if (closed) return; closed = true; clearInterval(timer); if (!res.writableEnded) res.end(); resolve(); };
    const timer = setInterval(async () => {
      try {
        const state = await readState();
        if (!state.assist_sessions.some((item) => item.id === session.id && item.version === 3)) return finish();
        const events = state.assist_events.filter((item) => item.session_id === session.id && (!turnId || item.turn_id === turnId) && Number(item.sequence) > cursor).sort((a, b) => a.sequence - b.sequence);
        for (const event of events) { cursor = event.sequence; res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
        if (turnId) { const turn = state.assist_turns.find((item) => item.id === turnId); if (turn && TERMINAL_TURN_STATES.has(turn.status) && !events.length) finish(); }
      } catch { finish(); }
    }, 125);
    req.on('close', finish);
  });
}

function attachRuntimeApproval(state, turn, normalized) {
  const externalId = normalized.data.external_id || null;
  let approval = state.runtime_approvals.find((item) => item.turn_id === turn.id && externalId && item.external_id === externalId);
  if (!approval) {
    approval = {
      id: id('rap'), project_id: turn.project_id, session_id: turn.session_id, turn_id: turn.id,
      approval_type: normalized.data.approval_type || 'runtime', external_id: externalId, request: normalized.data,
      status: 'pending', attention_state: 'interrupting', revision: 1,
      target_hash: hashString(JSON.stringify(normalized.data)), decision: null, created_at: now(), updated_at: now()
    };
    state.runtime_approvals.push(approval);
  }
  if (turn.status === 'running') Object.assign(turn, { status: 'waiting_approval', waiting_approval_id: approval.id, updated_at: now() });
  normalized.data = { ...normalized.data, approval_id: approval.id, revision: approval.revision, target_hash: approval.target_hash };
}

function normalizeCodexEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (['text', 'plan', 'command', 'file_change', 'diff', 'test', 'mcp', 'search', 'usage', 'reasoning_summary', 'status', 'terminal', 'request_user_input', 'operation'].includes(event.aiws_type) && event.data && typeof event.data === 'object') return { type: event.aiws_type, data: maskSecretsDeep(event.data) };
  const item = event.item && typeof event.item === 'object' ? event.item : {}, kind = String(item.type || '').toLowerCase();
  if (kind === 'agent_message') return { type: 'text', data: { text: cleanText(item.text, 100_000) } };
  if (kind === 'plan' || event.type === 'plan.updated') return { type: 'plan', data: { text: cleanText(item.text || event.plan, 100_000), status: cleanText(item.status || event.status, 100) } };
  if (kind.includes('command')) return { type: 'command', data: maskSecretsDeep({ command: cleanText(item.command, 20_000), status: cleanText(item.status, 100), exit_code: safeNumber(item.exit_code), output: cleanText(item.aggregated_output || item.output, 20_000) }) };
  if (kind.includes('file_change') || kind === 'patch') return { type: 'file_change', data: { status: cleanText(item.status, 100), changes: safeFileChanges(item.changes || item.files || []) } };
  if (kind.includes('mcp')) return { type: 'mcp', data: { server: cleanText(item.server || item.server_name, 200), tool: cleanText(item.tool || item.tool_name, 200), status: cleanText(item.status, 100) } };
  if (kind.includes('web_search') || event.type === 'web_search') return { type: 'search', data: { query: maskSecret(cleanText(item.query || event.query, 2000)), status: cleanText(item.status || event.status, 100) } };
  if (kind.includes('reasoning') && typeof item.summary === 'string') return { type: 'reasoning_summary', data: { summary: cleanText(item.summary, 20_000) } };
  if (/approval/i.test(String(event.type)) || /approval/i.test(kind)) return { type: 'approval', data: maskSecretsDeep({ external_id: cleanText(item.id || event.id, 300) || null, approval_type: cleanText(item.approval_type || event.approval_type || kind, 200), status: cleanText(item.status || event.status, 100), command: cleanText(item.command, 5000), path: safeViewPath(item.path), host: cleanText(item.host, 300), tool: cleanText(item.tool || item.tool_name, 300) }) };
  const usage = event.usage || item.usage;
  if (usage && typeof usage === 'object') return { type: 'usage', data: safeUsage(usage) };
  if (event.type === 'thread.started') return { type: 'status', data: { status: 'thread_started' } };
  return null;
}
function safeFileChanges(values) { return Array.isArray(values) ? values.slice(0, 500).map((item) => ({ path: safeViewPath(item?.path || item?.file), kind: cleanText(item?.kind || item?.type, 100) })).filter((item) => item.path) : []; }
function safeUsage(value) { return Object.fromEntries(Object.entries(value).filter(([key, item]) => /token|cached|input|output|total/i.test(key) && Number.isFinite(Number(item))).map(([key, item]) => [key, Number(item)])); }
