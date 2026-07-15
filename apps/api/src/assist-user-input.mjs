import { HttpError } from './http.mjs';
import { mutate, owner, readState } from './state.mjs';
import { id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { cleanText, requireSession, requireTurn, TERMINAL_TURN_STATES } from './assist-v3-domain.mjs';
import { pushV3Event } from './assist-v3-events.mjs';

const waiters = new Map();

export async function waitForAssistUserInput(sessionId, turnId, request = {}, signal) {
  const itemId = cleanText(request.itemId, 300);
  if (!itemId) throw new HttpError(400, { error: 'runtime_user_input_item_required' });
  const questions = normalizeQuestions(request.questions);
  const autoResolutionMs = normalizeAutoResolution(request.autoResolutionMs);
  const containsSecret = questions.some((item) => item.isSecret);
  const createdResult = await mutate((state) => {
    const turn = requireTurn(state, turnId), session = requireSession(state, sessionId);
    if (turn.session_id !== sessionId || TERMINAL_TURN_STATES.has(turn.status)) throw new HttpError(409, { error: 'runtime_user_input_turn_unavailable' });
    const existing = state.runtime_user_inputs.find((item) => item.turn_id === turn.id && item.item_id === itemId);
    if (existing) return { item: existing, automaticAnswers: existing.status === 'auto_resolved' ? autoRecommendedAnswers(existing.questions) : null };
    const automaticAnswers = session.clarification_policy === 'auto_recommend' ? autoRecommendedAnswers(questions) : null;
    const at = now(), item = {
      id: id('rui'), session_id: sessionId, turn_id: turnId, item_id: itemId,
      external_request_id: cleanText(request.requestId, 300) || null, questions,
      status: automaticAnswers ? 'auto_resolved' : 'pending', contains_secret: containsSecret, auto_resolution_ms: autoResolutionMs,
      expires_at: autoResolutionMs == null ? null : new Date(Date.now() + autoResolutionMs).toISOString(),
      responded_at: null, cancelled_at: null, created_at: at, updated_at: at
    };
    state.runtime_user_inputs.push(item);
    if (automaticAnswers) Object.assign(item, { responded_at: at, updated_at: at });
    else Object.assign(turn, { status: 'waiting_user_input', waiting_user_input_id: item.id, updated_at: at });
    pushV3Event(state, sessionId, turnId, 'request_user_input', publicInput(item));
    if (automaticAnswers) pushV3Event(state, sessionId, turnId, 'request_user_input_resolved', { id: item.id, item_id: item.item_id, status: item.status, automatic: true });
    return { item, automaticAnswers };
  });
  const created = createdResult.item;
  if (createdResult.automaticAnswers) return { answers: createdResult.automaticAnswers };
  if (created.status !== 'pending') throw new HttpError(409, { error: 'runtime_user_input_not_pending', status: created.status });
  return new Promise((resolve, reject) => {
    let settled = false, timer = null;
    const finish = (error, value) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const group = waiters.get(created.id); group?.delete(waiter); if (group && !group.size) waiters.delete(created.id);
      error ? reject(error) : resolve(value);
    };
    const abort = () => {
      void cancelRuntimeUserInput(created.id, 'turn_aborted').finally(() => finish(new HttpError(409, { error: 'runtime_user_input_cancelled' })));
    };
    const waiter = { finish, questions }, group = waiters.get(created.id) || new Set(); group.add(waiter); waiters.set(created.id, group);
    signal?.addEventListener('abort', abort, { once: true });
    if (autoResolutionMs != null) timer = setTimeout(() => { void resolveRuntimeUserInput(created.id, {}, { automatic: true }).catch((error) => finish(error)); }, autoResolutionMs);
    if (signal?.aborted) abort();
  });
}

export async function respondToAssistUserInput(turnId, itemId, input = {}) {
  const snapshot = await readState(), turn = requireTurn(snapshot, turnId);
  const item = snapshot.runtime_user_inputs.find((entry) => entry.turn_id === turn.id && entry.item_id === itemId);
  if (!item) throw new HttpError(404, { error: 'runtime_user_input_not_found' });
  const waiter = waiters.get(item.id)?.values().next().value;
  if (!waiter) throw new HttpError(409, { error: 'runtime_user_input_process_unavailable', action: 'retry_turn' });
  const answers = normalizeAnswers(input.answers, waiter.questions, input.notes);
  await resolveRuntimeUserInput(item.id, answers, { automatic: false });
  return { ...publicInput(item), status: 'responded' };
}

async function resolveRuntimeUserInput(idValue, answers, { automatic }) {
  const group = waiters.get(idValue), waiter = group?.values().next().value;
  if (!waiter) throw new HttpError(409, { error: 'runtime_user_input_process_unavailable' });
  const result = await mutate((state) => {
    const item = state.runtime_user_inputs.find((entry) => entry.id === idValue);
    if (!item) throw new HttpError(404, { error: 'runtime_user_input_not_found' });
    if (item.status !== 'pending') throw new HttpError(409, { error: 'runtime_user_input_not_pending', status: item.status });
    const at = now(); Object.assign(item, { status: automatic ? 'auto_resolved' : 'responded', responded_at: at, updated_at: at });
    const turn = state.assist_turns.find((entry) => entry.id === item.turn_id);
    if (turn && turn.status === 'waiting_user_input') Object.assign(turn, { status: 'running', waiting_user_input_id: null, updated_at: at });
    pushV3Event(state, item.session_id, item.turn_id, 'request_user_input_resolved', { id: item.id, item_id: item.item_id, status: item.status, automatic });
    return item;
  });
  // Answers, including Secret answers, are deliberately never passed through state/event/logging.
  for (const current of [...group]) current.finish(null, { answers });
  return result;
}

export async function cancelRuntimeUserInput(idValue, reason = 'cancelled') {
  const result = await mutate((state) => {
    const item = state.runtime_user_inputs.find((entry) => entry.id === idValue);
    if (!item || item.status !== 'pending') return item || null;
    const at = now(); Object.assign(item, { status: 'cancelled', cancelled_reason: cleanText(reason, 200), cancelled_at: at, updated_at: at });
    const turn = state.assist_turns.find((entry) => entry.id === item.turn_id);
    if (turn?.waiting_user_input_id === item.id) Object.assign(turn, { waiting_user_input_id: null, updated_at: at });
    pushV3Event(state, item.session_id, item.turn_id, 'request_user_input_resolved', { id: item.id, item_id: item.item_id, status: 'cancelled' });
    return item;
  });
  for (const waiter of [...(waiters.get(idValue) || [])]) waiter.finish(new HttpError(409, { error: 'runtime_user_input_cancelled' }));
  return result;
}

export async function cancelTurnUserInputs(turnId, reason) {
  const state = await readState();
  for (const item of state.runtime_user_inputs.filter((entry) => entry.turn_id === turnId && entry.status === 'pending')) await cancelRuntimeUserInput(item.id, reason);
}

function normalizeQuestions(values) {
  if (!Array.isArray(values) || !values.length || values.length > 3) throw new HttpError(400, { error: 'runtime_user_input_questions_invalid' });
  const seen = new Set();
  return values.map((item) => {
    const questionId = cleanText(item?.id, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(questionId) || seen.has(questionId)) throw new HttpError(400, { error: 'runtime_user_input_question_id_invalid' });
    seen.add(questionId);
    const options = item.options == null ? null : Array.isArray(item.options) ? item.options.slice(0, 20).map((option) => ({ label: cleanText(option?.label, 200), description: cleanText(option?.description, 1000), recommended: option?.recommended === true || /(?:\(recommended\)|（推荐）|\[recommended\])\s*$/i.test(String(option?.label || '')) })).filter((option) => option.label) : null;
    return { id: questionId, header: cleanText(item.header, 100), question: cleanText(item.question, 4000), isOther: item.isOther !== false && item.is_other !== false, isSecret: item.isSecret === true, allow_note: item.allowNote !== false && item.allow_note !== false, options };
  });
}

function normalizeAnswers(value, questions, notes = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, { error: 'runtime_user_input_answers_invalid' });
  const allowed = new Map(questions.map((item) => [item.id, item]));
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const question = allowed.get(key); if (!question) throw new HttpError(400, { error: 'runtime_user_input_answer_unknown', question_id: key });
    const answers = Array.isArray(raw?.answers) ? raw.answers : Array.isArray(raw) ? raw : [raw];
    if (!answers.length || answers.length > 20) throw new HttpError(400, { error: 'runtime_user_input_answer_invalid', question_id: key });
    const cleaned = answers.map((item) => cleanText(item, 10_000)).filter(Boolean);
    if (!cleaned.length) throw new HttpError(400, { error: 'runtime_user_input_answer_invalid', question_id: key });
    const optionLabels = new Set((question.options || []).map((option) => option.label));
    if (optionLabels.size && !question.isOther && cleaned.some((answer) => !optionLabels.has(answer))) throw new HttpError(400, { error: 'runtime_user_input_answer_not_allowed', question_id: key });
    const note = cleanText(raw?.note ?? notes?.[key], 10_000);
    result[key] = { answers: cleaned, ...(note && question.allow_note ? { note } : {}) };
  }
  for (const question of questions) if (!Object.hasOwn(result, question.id)) throw new HttpError(400, { error: 'runtime_user_input_answer_required', question_id: question.id });
  return result;
}

export function autoRecommendedAnswers(questions) {
  const result = {};
  for (const question of questions) {
    if (question.isSecret || requiresHumanConfirmation(question)) return null;
    const recommended = (question.options || []).filter((option) => option.recommended === true);
    if (recommended.length !== 1) return null;
    result[question.id] = { answers: [recommended[0].label] };
  }
  return Object.keys(result).length ? result : null;
}

function requiresHumanConfirmation(question) {
  const text = [question.header, question.question, ...(question.options || []).flatMap((option) => [option.label, option.description])].join(' ');
  return /credential|password|secret|token|api[ _-]?key|approval|approve|delete|remove|destroy|purge|erase|permanent|irreversible|overwrite|conflict|force|凭据|密码|密钥|令牌|审批|批准|删除|移除|销毁|清空|擦除|永久|不可逆|覆盖|冲突|强制/i.test(text);
}

function normalizeAutoResolution(value) { if (value == null) return null; const number = Number(value); return Number.isSafeInteger(number) && number >= 0 && number <= 24 * 60 * 60 * 1000 ? number : null; }
function publicInput(item) { return maskSecretsDeep({ id: item.id, session_id: item.session_id, turn_id: item.turn_id, item_id: item.item_id, questions: item.questions, status: item.status, contains_secret: item.contains_secret, auto_resolution_ms: item.auto_resolution_ms, expires_at: item.expires_at, created_at: item.created_at, updated_at: item.updated_at }); }
