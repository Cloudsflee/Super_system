import { randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { canonicalJson, sha256 } from './state-migration-v14.mjs';
import { id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { cleanText, requireSession, requireTurn } from './assist-v3-domain.mjs';
import { pushV3Event } from './assist-v3-events.mjs';

const OPERATION_TIMEOUT_MS = 30_000;
const MAX_LEDGER_VALUE_BYTES = 64 * 1024;
const operationWaiters = new Map();
const approvalWaiters = new Map();
const TOOLS = new Set(['set_field', 'set_filter', 'select_tab']);

export function dynamicPageToolSpec(viewContext, collaborationMode = 'default') {
  if (collaborationMode === 'plan') return [];
  const controls = exposedControls(viewContext);
  if (!controls.length) return [];
  const targetIds = controls.map((item) => item.id);
  return [{
    type: 'namespace', name: 'aiws_page',
    description: 'Reversible semantic operations on the currently registered AIWS page controls. Only declared target_id values are accepted.',
    tools: [
      toolDefinition('set_field', 'Set a declared reversible page field and wait for persistence.', targetIds.filter((idValue) => controls.some((item) => item.id === idValue && item.kind === 'field'))),
      toolDefinition('set_filter', 'Set a declared reversible page filter and wait for persistence.', targetIds.filter((idValue) => controls.some((item) => item.id === idValue && item.kind === 'filter'))),
      toolDefinition('select_tab', 'Select a declared reversible page tab.', targetIds.filter((idValue) => controls.some((item) => item.id === idValue && item.kind === 'tab')))
    ].filter((item) => item.inputSchema.properties.target_id.enum.length)
  }];
}

export async function handleDynamicPageTool(sessionId, turnId, params = {}, signal) {
  const snapshot = await readState(), session = requireSession(snapshot, sessionId, true), turn = requireTurn(snapshot, turnId);
  if (turn.session_id !== session.id) throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
  if (turn.collaboration_mode === 'plan' || turn.mode === 'plan') throw new HttpError(409, { error: 'assist_plan_page_write_forbidden' });
  const namespace = cleanText(params.namespace, 100), tool = cleanText(params.tool, 100);
  if (namespace !== 'aiws_page' || !TOOLS.has(tool)) throw new HttpError(400, { error: 'assist_dynamic_tool_not_allowed' });
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  rejectDangerousArguments(args);
  const targetId = cleanText(args.target_id, 128), controls = exposedControls(turn.view_context), control = controls.find((item) => item.id === targetId && toolMatchesKind(tool, item.kind));
  if (!control) throw new HttpError(409, { error: 'assist_dynamic_tool_target_not_allowed', target_id: targetId });
  const value = validateToolValue(tool, args.value, control);
  assertLedgerValue(value);
  const page = pageIdentity(turn.view_context);
  if (!page.route || !page.revision) throw new HttpError(409, { error: 'assist_page_surface_revision_required' });
  const callId = cleanText(params.callId, 300) || id('call');
  const at = now(), deadline = new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString();
  const operation = await mutate((state) => {
    const currentTurn = requireTurn(state, turn.id);
    const duplicate = state.assist_operations.find((item) => item.turn_id === currentTurn.id && item.tool_call_id === callId);
    if (duplicate) return duplicate;
    const item = {
      id: id('aop'), session_id: session.id, turn_id: currentTurn.id, tool_call_id: callId, tool: `aiws_page.${tool}`,
      route: page.route, surface_id: page.surfaceId, surface_revision: page.revision, browser_instance_id: page.browserInstanceId,
      target_id: targetId, requested_value: value, allowed_values: control.allowedValues,
      before_value: null, after_value: null, current_value: null, before_hash: null, after_hash: null, current_hash: null,
      status: requiresConfirmation(control.risk) ? 'pending_confirmation' : 'pending', risk: control.risk,
      revision: 1, inverse_of: null, forced: false, conflict: null, claimed_by: null, claim_expires_at: deadline,
      approved_at: null, committed_at: null, failed_at: null, created_at: at, updated_at: at
    };
    state.assist_operations.push(item);
    pushV3Event(state, session.id, currentTurn.id, 'operation', operationEvent(item));
    return item;
  });
  if (['committed', 'undone'].includes(operation.status)) return toolSuccess(operation);
  if (operation.status === 'pending_confirmation') await waitForOperationApproval(operation.id, signal);
  return waitForOperationResult(operation.id, signal);
}

export async function listAssistOperations(query = {}) {
  const state = await readState();
  let items = state.assist_operations;
  if (query.session_id) items = items.filter((item) => item.session_id === query.session_id);
  if (query.turn_id) items = items.filter((item) => item.turn_id === query.turn_id);
  if (query.status) items = items.filter((item) => item.status === query.status);
  return items.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, clampInt(query.limit, 1, 500, 100)).map(publicOperation);
}

export async function confirmAssistOperation(operationId, input = {}) {
  const approved = input.approved === true;
  const result = await mutate((state) => {
    const operation = requireOperation(state, operationId);
    if (operation.status !== 'pending_confirmation') {
      if (approved && ['pending', 'claimed', 'committed'].includes(operation.status)) return operation;
      throw new HttpError(409, { error: 'assist_operation_not_awaiting_confirmation', status: operation.status });
    }
    const at = now();
    if (approved) Object.assign(operation, { status: 'pending', approved_at: at, revision: operation.revision + 1, updated_at: at, claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString() });
    else Object.assign(operation, { status: 'failed', failure_code: 'user_denied', failed_at: at, revision: operation.revision + 1, updated_at: at });
    pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
    return operation;
  });
  const waiter = approvalWaiters.get(operationId);
  if (approved) waiter?.resolve(true); else waiter?.reject(new HttpError(409, { error: 'assist_operation_denied' }));
  return publicOperation(result);
}

export async function claimAssistOperation(operationId, input = {}) {
  const browserId = cleanText(input.browser_instance_id, 200);
  if (!browserId) throw new HttpError(400, { error: 'assist_browser_instance_required' });
  return mutate((state) => {
    const operation = requireOperation(state, operationId);
    if (operation.status === 'claimed' && operation.claimed_by === browserId) return executionPayload(operation);
    if (operation.status !== 'pending') throw new HttpError(409, { error: 'assist_operation_not_claimable', status: operation.status });
    if (operation.browser_instance_id && operation.browser_instance_id !== browserId) throw new HttpError(409, { error: 'assist_operation_wrong_browser' });
    if (Date.parse(operation.claim_expires_at) <= Date.now()) throw new HttpError(410, { error: 'assist_operation_expired' });
    Object.assign(operation, { status: 'claimed', claimed_by: browserId, claimed_at: now(), revision: operation.revision + 1, updated_at: now() });
    pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
    return executionPayload(operation);
  });
}

export async function submitAssistOperationResult(operationId, input = {}) {
  const browserId = cleanText(input.browser_instance_id, 200);
  const result = await mutate((state) => {
    const operation = requireOperation(state, operationId);
    if (operation.status === 'committed') return operation;
    if (operation.status !== 'claimed' || operation.claimed_by !== browserId) throw new HttpError(409, { error: 'assist_operation_claim_mismatch' });
    if (cleanText(input.route, 2_000) !== operation.route || cleanText(input.surface_revision, 200) !== operation.surface_revision) throw new HttpError(409, { error: 'assist_operation_surface_changed' });
    if (input.ok !== true || input.persisted !== true) return failOperation(state, operation, cleanText(input.error, 200) || 'browser_execution_failed');
    const before = sanitizeLedgerValue(input.before), after = sanitizeLedgerValue(input.after), current = input.current === undefined ? after : sanitizeLedgerValue(input.current);
    assertLedgerValue(before); assertLedgerValue(after); assertLedgerValue(current);
    const beforeHash = canonicalHash(before), afterHash = canonicalHash(after), currentHash = canonicalHash(current);
    if (input.before_hash && input.before_hash !== beforeHash || input.after_hash && input.after_hash !== afterHash) return failOperation(state, operation, 'browser_hash_mismatch');
    if (operation.inverse_of) {
      const original = state.assist_operations.find((item) => item.id === operation.inverse_of);
      if (!original) return failOperation(state, operation, 'inverse_operation_missing');
      if (!operation.forced && beforeHash !== original.after_hash) {
        Object.assign(operation, { status: 'conflicted', before_value: before, current_value: before, current_hash: beforeHash, conflict: { before: original.before_value, after: original.after_value, current: before }, revision: operation.revision + 1, updated_at: now() });
        pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation)); return operation;
      }
    }
    const at = now(); Object.assign(operation, { before_value: before, after_value: after, current_value: current, before_hash: beforeHash, after_hash: afterHash, current_hash: currentHash, status: 'committed', committed_at: at, revision: operation.revision + 1, updated_at: at });
    if (operation.inverse_of) {
      const original = state.assist_operations.find((item) => item.id === operation.inverse_of);
      if (original) { original.undone_by = operation.id; original.undone_at = at; original.updated_at = at; }
    }
    const actor = owner(state);
    addTrace(state, 'assist.action.confirmed', { project_id: state.assist_turns.find((item) => item.id === operation.turn_id)?.project_id, target_id: operation.id, summary: `${operation.tool} committed` }, actor.id);
    pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
    return operation;
  });
  const waiter = operationWaiters.get(operationId);
  if (result.status === 'committed') waiter?.resolve(toolSuccess(result));
  else if (result.status === 'conflicted') waiter?.reject(new HttpError(409, { error: 'assist_operation_undo_conflict', operation: publicOperation(result) }));
  else if (result.status === 'failed') waiter?.reject(new HttpError(409, { error: result.failure_code || 'assist_operation_failed' }));
  return publicOperation(result);
}

export async function undoAssistOperation(operationId, input = {}) {
  const force = input.force === true;
  return mutate((state) => {
    const original = requireOperation(state, operationId);
    if (original.status !== 'committed' || original.inverse_of) throw new HttpError(409, { error: 'assist_operation_not_undoable', status: original.status });
    if (original.undone_by) return publicOperation(state.assist_operations.find((item) => item.id === original.undone_by));
    const existing = state.assist_operations.find((item) => item.inverse_of === original.id && ['pending', 'claimed', 'conflicted', 'committed'].includes(item.status));
    if (existing && (!force || existing.forced)) return publicOperation(existing);
    if (existing && force && existing.status === 'conflicted') {
      Object.assign(existing, { status: 'pending', forced: true, claimed_by: null, claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(), revision: existing.revision + 1, updated_at: now() });
      pushV3Event(state, existing.session_id, existing.turn_id, 'operation', operationEvent(existing)); return publicOperation(existing);
    }
    const at = now(), inverse = {
      id: id('aop'), session_id: original.session_id, turn_id: original.turn_id, tool_call_id: `undo:${original.id}:${randomBytes(6).toString('hex')}`,
      tool: original.tool, route: original.route, surface_id: original.surface_id, surface_revision: original.surface_revision, browser_instance_id: original.browser_instance_id,
      target_id: original.target_id, requested_value: original.before_value, allowed_values: original.allowed_values || null,
      before_value: null, after_value: null, current_value: null, before_hash: null, after_hash: null, current_hash: null,
      status: 'pending', risk: original.risk, revision: 1, inverse_of: original.id, expected_current_hash: original.after_hash, forced: force, conflict: null,
      claimed_by: null, claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(), approved_at: force ? at : null,
      committed_at: null, failed_at: null, created_at: at, updated_at: at
    };
    state.assist_operations.push(inverse); pushV3Event(state, inverse.session_id, inverse.turn_id, 'operation', operationEvent(inverse));
    return publicOperation(inverse);
  });
}

export async function recoverAssistOperations() {
  return mutate((state) => {
    let count = 0;
    for (const operation of state.assist_operations.filter((item) => ['pending_confirmation', 'pending', 'claimed'].includes(item.status))) {
      failOperation(state, operation, 'service_restarted'); count++;
    }
    return count;
  });
}

function waitForOperationApproval(operationId, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { signal?.removeEventListener('abort', abort); if (approvalWaiters.get(operationId)?.resolve === approve) approvalWaiters.delete(operationId); };
    const approve = (value) => { cleanup(); resolve(value); }, fail = (error) => { cleanup(); reject(error); };
    const abort = () => fail(new HttpError(409, { error: 'assist_operation_cancelled' }));
    approvalWaiters.set(operationId, { resolve: approve, reject: fail }); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

function waitForOperationResult(operationId, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { void expireOperation(operationId, 'browser_claim_timeout'); finish(new HttpError(504, { error: 'assist_operation_timeout' })); }, OPERATION_TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); operationWaiters.delete(operationId); };
    const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
    const abort = () => { void expireOperation(operationId, 'turn_aborted'); finish(new HttpError(409, { error: 'assist_operation_cancelled' })); };
    operationWaiters.set(operationId, { resolve: (value) => finish(null, value), reject: finish }); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

async function expireOperation(operationId, code) {
  return mutate((state) => { const operation = state.assist_operations.find((item) => item.id === operationId); if (operation && ['pending', 'claimed', 'pending_confirmation'].includes(operation.status)) failOperation(state, operation, code); });
}

function failOperation(state, operation, code) { const at = now(); Object.assign(operation, { status: 'failed', failure_code: code, failed_at: at, revision: operation.revision + 1, updated_at: at }); pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation)); return operation; }
function requireOperation(state, operationId) { const item = state.assist_operations.find((entry) => entry.id === operationId); if (!item) throw new HttpError(404, { error: 'assist_operation_not_found' }); return item; }
function requiresConfirmation(risk) { return !['low', 'reversible'].includes(risk); }
function canonicalHash(value) { return sha256(Buffer.from(canonicalJson(value))); }
function assertLedgerValue(value) { if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_LEDGER_VALUE_BYTES) throw new HttpError(413, { error: 'assist_operation_value_too_large', max_bytes: MAX_LEDGER_VALUE_BYTES }); }
function sanitizeLedgerValue(value) { const safe = maskSecretsDeep(value); if (JSON.stringify(safe).includes('***MASKED')) throw new HttpError(409, { error: 'assist_operation_secret_value_forbidden' }); return safe; }
function publicOperation(item) { if (!item) return null; const result = { ...item }; delete result.browser_instance_id; delete result.requested_value; delete result.allowed_values; return result; }
function operationEvent(item) { return { operation_id: item.id, tool: item.tool, target_id: item.target_id, route: item.route, surface_id: item.surface_id, surface_revision: item.surface_revision, status: item.status, risk: item.risk, revision: item.revision, inverse_of: item.inverse_of, forced: item.forced, conflict: item.conflict, claimable: item.status === 'pending', requires_confirmation: item.status === 'pending_confirmation' }; }
function executionPayload(item) { return { operation_id: item.id, tool: item.tool, target_id: item.target_id, value: item.requested_value, route: item.route, surface_id: item.surface_id, surface_revision: item.surface_revision, inverse_of: item.inverse_of, expected_current_hash: item.expected_current_hash, forced: item.forced, revision: item.revision }; }
function toolSuccess(item) { return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ operation_id: item.id, status: item.status, target_id: item.target_id, before_hash: item.before_hash, after_hash: item.after_hash }) }] }; }
function validateToolValue(tool, value, control) { if (tool === 'select_tab') return control.id; if (value === undefined) throw new HttpError(400, { error: 'assist_dynamic_tool_value_required' }); const safe = sanitizeLedgerValue(value); if (control.allowedValues?.length && !control.allowedValues.some((item) => canonicalJson(item) === canonicalJson(safe))) throw new HttpError(400, { error: 'assist_dynamic_tool_value_not_allowed' }); return safe; }
function toolMatchesKind(tool, kind) { return tool === 'set_field' ? kind === 'field' : tool === 'set_filter' ? kind === 'filter' : kind === 'tab'; }
function toolDefinition(name, description, targetIds) { return { type: 'function', name, description, inputSchema: { type: 'object', additionalProperties: false, required: name === 'select_tab' ? ['target_id'] : ['target_id', 'value'], properties: { target_id: { type: 'string', enum: targetIds }, ...(name === 'select_tab' ? {} : { value: {} }) } } }; }
function rejectDangerousArguments(value) { for (const [key, item] of Object.entries(value)) { if (/selector|xpath|script|javascript|html|dom|credential|secret|token/i.test(key)) throw new HttpError(400, { error: 'assist_dynamic_tool_unsafe_argument', field: key }); if (item && typeof item === 'object' && !Array.isArray(item)) rejectDangerousArguments(item); } }
function pageIdentity(viewContext) { return { route: cleanText(viewContext?.route, 2_000), surfaceId: cleanText(viewContext?.surface?.id || viewContext?.surface?.surface_id, 200) || null, revision: cleanText(viewContext?.surface?.revision, 200), browserInstanceId: cleanText(viewContext?.browser_instance_id || viewContext?.surface?.browser_instance_id, 200) || null }; }
function exposedControls(viewContext) {
  const surface = viewContext?.surface && typeof viewContext.surface === 'object' ? viewContext.surface : {};
  const values = [
    ...normalizeControlList(surface.fields, 'field'), ...normalizeControlList(surface.filters, 'filter'), ...normalizeControlList(surface.tabs, 'tab'),
    ...normalizeControlList(surface.controls, null)
  ];
  const seen = new Set(); return values.filter((item) => { if (seen.has(item.id) || item.sensitivity === 'secret' || item.readable === false || item.reversible === false) return false; seen.add(item.id); return true; });
}
function normalizeControlList(values, fallbackKind) { if (!Array.isArray(values)) return []; return values.slice(0, 200).flatMap((value) => { const controlId = cleanText(value?.id || value?.target_id, 128), kind = fallbackKind || cleanText(value?.kind, 20); if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(controlId) || !['field', 'filter', 'tab'].includes(kind)) return []; return [{ id: controlId, kind, label: cleanText(value.label, 200) || controlId, allowedValues: Array.isArray(value.allowedValues || value.values) ? (value.allowedValues || value.values).slice(0, 200).map(sanitizeLedgerValue) : null, risk: cleanText(value.risk, 30) || 'low', sensitivity: cleanText(value.sensitivity, 30) || 'public', readable: value.readable !== false, reversible: value.reversible !== false }]; }); }
function clampInt(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
