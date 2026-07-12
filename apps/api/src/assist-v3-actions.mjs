import { HttpError } from './http.mjs';
import { addTrace, mutate, owner } from './state.mjs';
import { id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { cleanText, requireSession, requireTurn, safeViewContext } from './assist-v3-domain.mjs';
import { pushV3Event } from './assist-v3-events.mjs';

const ACTION_TAG = /<aiws_actions>\s*([\s\S]*?)\s*<\/aiws_actions>/gi;

export function assistPageActionInstruction(viewContext) {
  const fields = surfaceFields(viewContext);
  if (!fields.length) return '';
  return [
    `Editable page fields: ${JSON.stringify(fields.map(({ id: fieldId, label }) => ({ id: fieldId, label })))}`,
    'Answer the user in normal Markdown. When the user asks to fill or update page fields, append exactly one machine-readable block after the answer:',
    '<aiws_actions>{"actions":[{"name":"fill_field","label":"short change label","args":{"field_id":"one declared id","value":"replacement string"}}]}</aiws_actions>',
    'Use only declared field ids and string values. For list fields, separate items with newlines. Never use selectors, scripts, HTML, credentials, paths, or arbitrary URLs. These are proposed draft edits: do not claim they were already applied.'
  ].join('\n\n');
}

export function parseV3AssistOutput(value) {
  const raw = String(value || '').slice(0, 240_000);
  let payload = null;
  const withoutTags = raw.replace(ACTION_TAG, (_match, encoded) => { const parsed = parseJson(encoded); if (parsed) payload = parsed; return ''; }).trim();
  if (!payload) {
    const parsed = parseJson(stripJsonFence(raw));
    if (parsed && Array.isArray(parsed.actions)) payload = parsed;
  }
  const message = cleanText(payload?.message ?? withoutTags, 200_000) || 'Codex Turn 已完成。';
  return { message, actions: Array.isArray(payload?.actions) ? payload.actions.slice(0, 50) : [] };
}

export function materializeV3PageActions(state, { session, turn, sourceMessageId, inputs }) {
  const fields = new Map(surfaceFields(turn.view_context).map((item) => [item.id, item]));
  const actions = [];
  for (const input of inputs || []) {
    if (String(input?.name || '') !== 'fill_field' || forbiddenArgs(input?.args)) continue;
    const fieldId = cleanText(input.args?.field_id ?? input.args?.field, 128);
    const field = fields.get(fieldId);
    if (!field || typeof input.args?.value !== 'string') continue;
    const value = String(input.args.value).replace(/\0/g, '').slice(0, 100_000);
    actions.push({
      id: id('uia'), session_id: session.id, turn_id: turn.id, source_message_id: sourceMessageId,
      project_id: session.project_id, workspace_id: session.workspace_id, node_id: session.node_id,
      name: 'fill_field', label: cleanText(input.label, 100) || `填写${field.label}`,
      args: { field_id: fieldId, value }, risk: 'reversible', status: 'ready', created_at: now(), updated_at: now()
    });
  }
  state.ui_action_intents.push(...actions);
  return actions;
}

export async function recordV3PageActionResult(turnId, actionId, input = {}) {
  const result = safeResult(input.result);
  return mutate((state) => {
    const turn = requireTurn(state, turnId), session = requireSession(state, turn.session_id, true);
    const action = state.ui_action_intents.find((item) => item.id === actionId && item.turn_id === turn.id && item.session_id === session.id);
    if (!action) throw new HttpError(404, { error: 'assist_action_not_found' });
    if (action.risk !== 'reversible' || action.name !== 'fill_field') throw new HttpError(409, { error: 'assist_action_result_not_allowed' });
    if (['completed', 'failed'].includes(action.status)) return action;
    if (action.status !== 'ready') throw new HttpError(409, { error: 'assist_action_result_not_allowed' });
    Object.assign(action, { status: input.ok === false ? 'failed' : 'completed', result, updated_at: now() });
    const actor = owner(state);
    addTrace(state, action.status === 'completed' ? 'assist.action.confirmed' : 'assist.action.failed', { project_id: action.project_id, workspace_id: action.workspace_id, node_id: action.node_id, target_id: action.id, summary: `${action.status}: ${action.label}` }, actor.id);
    pushV3Event(state, session.id, turn.id, 'status', { status: action.status === 'completed' ? 'page_action_applied' : 'page_action_failed', action_id: action.id, field_id: action.args.field_id });
    return action;
  });
}

function surfaceFields(viewContext) {
  const safe = safeViewContext(viewContext), fields = safe?.surface?.fields;
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  return fields.slice(0, 100).flatMap((item) => {
    const fieldId = cleanText(item?.id, 128), label = cleanText(item?.label, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(fieldId) || seen.has(fieldId)) return [];
    seen.add(fieldId); return [{ id: fieldId, label: label || fieldId }];
  });
}
function stripJsonFence(value) { return String(value || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim(); }
function parseJson(value) { try { const parsed = JSON.parse(String(value || '').trim()); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; } }
function forbiddenArgs(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; return Object.entries(value).some(([key, item]) => /selector|script|javascript|html|credential|secret|token/i.test(key) || (item && typeof item === 'object' && forbiddenArgs(item))); }
function safeResult(value) {
  const masked = maskSecretsDeep(value && typeof value === 'object' && !Array.isArray(value) ? value : {}), encoded = JSON.stringify(masked);
  if (Buffer.byteLength(encoded, 'utf8') > 20_000) throw new HttpError(413, { error: 'assist_action_result_too_large' });
  return JSON.parse(encoded);
}
