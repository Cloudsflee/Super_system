import { randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { cleanText, requireSession, requireTurn } from './assist-v3-domain.mjs';
import { pushV3Event } from './assist-v3-events.mjs';
import { actionForTool, capabilityForTool, executionPayload, operationEvent, publicOperation, requiresConfirmation, semanticSummary, toolDefinition, toolMatchesKind, toolName, toolSuccess } from './assist-operation-metadata.mjs';
import { PROJECT_TOOL_NAMESPACE, projectCapabilityToolSpec } from './assist-project-tools.mjs';
import { handleProjectCapabilityTool, reviseProjectOperation, undoProjectOperation } from './assist-project-operation-ledger.mjs';
import { assertLedgerValue, canonicalHash, exposedControls, pageIdentity, rejectDangerousArguments, sanitizeLedgerValue, validateToolValue } from './assist-operation-utils.mjs';
import { settleOperationApproval, settleOperationResult, waitForOperationApproval, waitForOperationResult } from './assist-operation-waiters.mjs';

const OPERATION_TIMEOUT_MS = 30_000;
const TOOLS = new Set(['set_field', 'set_filter', 'select_tab']);
export function dynamicPageToolSpec(viewContext, collaborationMode = 'default', options = {}) {
  if (collaborationMode === 'plan') return [];
  const namespaces = [];
  const controls = exposedControls(viewContext);
  const page = pageIdentity(viewContext);
  if (controls.length && page.route && page.surfaceId && page.revision && page.browserInstanceId) {
    const targetIds = controls.map((item) => item.id);
    namespaces.push({
      type: 'namespace', name: 'aiws_page',
      description: 'Reversible semantic operations on the currently registered AIWS page controls. Only declared target_id values are accepted.',
      tools: [
        toolDefinition('set_field', 'Set a declared reversible page field and wait for persistence.', targetIds.filter((idValue) => controls.some((item) => item.id === idValue && item.kind === 'field'))),
        toolDefinition('set_filter', 'Set a declared reversible page filter and wait for persistence.', targetIds.filter((idValue) => controls.some((item) => item.id === idValue && item.kind === 'filter'))),
        toolDefinition('select_tab', 'Select a declared reversible page tab.', targetIds.filter((idValue) => controls.some((item) => item.id === idValue && item.kind === 'tab')))
      ].filter((item) => item.inputSchema.properties.target_id.enum.length)
    });
  }
  const projectTools = options.state && options.projectId ? projectCapabilityToolSpec(options.state, options.projectId, viewContext) : null;
  if (projectTools) namespaces.push(projectTools);
  return namespaces;
}
export async function handleDynamicPageTool(sessionId, turnId, params = {}, signal) {
  const snapshot = await readState(), session = requireSession(snapshot, sessionId, true), turn = requireTurn(snapshot, turnId);
  if (turn.session_id !== session.id) throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
  const namespace = cleanText(params.namespace, 100), tool = cleanText(params.tool, 100);
  if (namespace === PROJECT_TOOL_NAMESPACE) return handleProjectCapabilityTool(session.id, turn.id, params, signal, waitForOperationApproval);
  if (turn.collaboration_mode === 'plan' || turn.mode === 'plan') throw new HttpError(409, { error: 'assist_plan_page_write_forbidden' });
  if (namespace !== 'aiws_page' || !TOOLS.has(tool)) throw new HttpError(400, { error: 'assist_dynamic_tool_not_allowed' });
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  rejectDangerousArguments(args);
  const targetId = cleanText(args.target_id, 128), controls = exposedControls(turn.view_context), control = controls.find((item) => item.id === targetId && toolMatchesKind(tool, item.kind));
  if (!control) throw new HttpError(409, { error: 'assist_dynamic_tool_target_not_allowed', target_id: targetId });
  const value = validateToolValue(tool, args.value, control);
  assertLedgerValue(value);
  const page = pageIdentity(turn.view_context);
  if (!page.route || !page.surfaceId || !page.revision || !page.browserInstanceId) throw new HttpError(409, { error: 'assist_page_surface_revision_required' });
  const callId = cleanText(params.callId, 300) || id('call');
  const duplicate = snapshot.assist_operations.some((item) => item.turn_id === turn.id && item.tool_call_id === callId);
  if (!duplicate && snapshot.assist_operations.some((item) => item.turn_id === turn.id && item.execution_layer !== 'server' && item.failure_code === 'browser_claim_timeout')) throw new HttpError(409, { error: 'assist_browser_executor_unavailable', message: '当前页面没有可用的浏览器执行器', action: '保持目标页面打开后重试。', phase: 'browser_operation', retryable: true });
  const at = now(), deadline = new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString();
  const operation = await mutate((state) => {
    const currentTurn = requireTurn(state, turn.id);
    const duplicate = state.assist_operations.find((item) => item.turn_id === currentTurn.id && item.tool_call_id === callId);
    if (duplicate) return duplicate;
    const item = {
      id: id('aop'), session_id: session.id, turn_id: currentTurn.id, tool_call_id: callId, tool: `aiws_page.${tool}`,
      project_id: currentTurn.project_id, capability_id: capabilityForTool(tool), action: actionForTool(tool),
      route: page.route, surface_id: page.surfaceId, surface_revision: page.revision, browser_instance_id: page.browserInstanceId,
      target_id: targetId, requested_value: value, allowed_values: control.allowedValues,
      target_label: control.label || targetId, summary: semanticSummary(tool, control.label || targetId), input_schema: toolDefinition(tool, '', [targetId]).inputSchema,
      locator: { route: page.route, project_id: currentTurn.project_id, surface_id: page.surfaceId, surface_revision: page.revision, target_id: targetId, target_label: control.label || targetId },
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
  return waitForOperationResult(operation.id, signal, expireOperation, OPERATION_TIMEOUT_MS);
}

export async function listAssistOperations(query = {}) {
  const state = await readState();
  let items = state.assist_operations;
  if (query.session_id) items = items.filter((item) => item.session_id === query.session_id);
  if (query.turn_id) items = items.filter((item) => item.turn_id === query.turn_id);
  if (query.status) items = items.filter((item) => item.status === query.status);
  return items.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, clampInt(query.limit, 1, 500, 100)).map((item) => publicOperation(item, state));
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
  settleOperationApproval(operationId, approved);
  return publicOperation(result);
}

export async function claimAssistOperation(operationId, input = {}) {
  const browserId = cleanText(input.browser_instance_id, 200);
  if (!browserId) throw new HttpError(400, { error: 'assist_browser_instance_required' });
  return mutate((state) => {
    const operation = requireOperation(state, operationId);
    assertBrowserLocator(operation, input);
    if (operation.execution_layer === 'server') throw new HttpError(409, { error: 'assist_operation_server_executed' });
    if (operation.status === 'claimed' && operation.claimed_by === browserId) return executionPayload(operation);
    if (operation.status !== 'pending') throw new HttpError(409, { error: 'assist_operation_not_claimable', status: operation.status });
    if (operation.browser_instance_id && operation.browser_instance_id !== browserId) throw new HttpError(409, { error: 'assist_operation_wrong_browser' });
    if (Date.parse(operation.claim_expires_at) <= Date.now()) throw new HttpError(410, { error: 'assist_operation_expired' });
    const at = now();
    Object.assign(operation, { status: 'claimed', claimed_by: browserId, claimed_at: at, claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(), revision: operation.revision + 1, updated_at: at });
    pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
    return executionPayload(operation);
  });
}

export async function submitAssistOperationResult(operationId, input = {}) {
  const browserId = cleanText(input.browser_instance_id, 200);
  if (!browserId) throw new HttpError(400, { error: 'assist_browser_instance_required' });
  const result = await mutate((state) => {
    const operation = requireOperation(state, operationId);
    assertBrowserLocator(operation, input);
    if (operation.status === 'committed') {
      if (operation.claimed_by && operation.claimed_by !== browserId) throw new HttpError(409, { error: 'assist_operation_claim_mismatch' });
      return operation;
    }
    if (operation.status !== 'claimed' || operation.claimed_by !== browserId) throw new HttpError(409, { error: 'assist_operation_claim_mismatch' });
    if (input.ok !== true || input.persisted !== true) return failOperation(state, operation, cleanText(input.error, 200) || 'browser_execution_failed');
    const before = sanitizeLedgerValue(input.before), after = sanitizeLedgerValue(input.after), current = input.current === undefined ? after : sanitizeLedgerValue(input.current);
    assertLedgerValue(before); assertLedgerValue(after); assertLedgerValue(current);
    const beforeHash = canonicalHash(before), afterHash = canonicalHash(after), currentHash = canonicalHash(current);
    if (input.before_hash && input.before_hash !== beforeHash || input.after_hash && input.after_hash !== afterHash) return failOperation(state, operation, 'browser_hash_mismatch');
    if (afterHash !== currentHash) return failOperation(state, operation, 'browser_persistence_mismatch');
    const referenceId = operation.inverse_of || operation.operation_reference_id, reference = referenceId ? state.assist_operations.find((item) => item.id === referenceId) : null;
    if (operation.inverse_of && !reference) return failOperation(state, operation, 'inverse_operation_missing');
    if (operation.expected_current_hash && !operation.forced && beforeHash !== operation.expected_current_hash) {
      Object.assign(operation, { status: 'conflicted', before_value: before, current_value: before, current_hash: beforeHash, conflict: { before: reference?.before_value ?? null, after: reference?.after_value ?? operation.requested_value, current: before }, revision: operation.revision + 1, updated_at: now() });
      pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation)); return operation;
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
  settleOperationResult(operationId, result);
  return publicOperation(result);
}

export async function undoAssistOperation(operationId, input = {}) {
  const snapshot = await readState(), selected = requireOperation(snapshot, operationId);
  if (selected.execution_layer === 'server') return undoProjectOperation(operationId, input);
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
      project_id: original.project_id || null, capability_id: original.capability_id || capabilityForTool(toolName(original.tool)), action: 'undo',
      tool: original.tool, route: original.route, surface_id: original.surface_id, surface_revision: original.surface_revision, browser_instance_id: original.browser_instance_id,
      target_id: original.target_id, requested_value: original.before_value, allowed_values: original.allowed_values || null,
      target_label: original.target_label || original.target_id, summary: `已撤销 · ${original.target_label || original.target_id}`, input_schema: original.input_schema || null, locator: original.locator || null,
      before_value: null, after_value: null, current_value: null, before_hash: null, after_hash: null, current_hash: null,
      status: 'pending', risk: original.risk, revision: 1, inverse_of: original.id, expected_current_hash: original.after_hash, forced: force, conflict: null,
      claimed_by: null, claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(), approved_at: force ? at : null,
      committed_at: null, failed_at: null, created_at: at, updated_at: at
    };
    state.assist_operations.push(inverse); pushV3Event(state, inverse.session_id, inverse.turn_id, 'operation', operationEvent(inverse));
    return publicOperation(inverse);
  });
}

export async function reviseAssistOperation(operationId, input = {}) {
  const snapshot = await readState(), selected = requireOperation(snapshot, operationId);
  if (selected.execution_layer === 'server') return reviseProjectOperation(operationId, input);
  return mutate((state) => {
    const original = requireOperation(state, operationId);
    const retryingConflict = original.status === 'conflicted' && original.operation_reference_id;
    if (!['committed', 'undone'].includes(original.status) && !retryingConflict) throw new HttpError(409, { error: 'assist_operation_not_revisionable', status: original.status });
    const session = requireSession(state, original.session_id, true), turn = input.turn_id ? requireTurn(state, input.turn_id) : requireTurn(state, original.turn_id);
    if (turn.session_id !== session.id || turn.project_id !== original.project_id && original.project_id) throw new HttpError(409, { error: 'assist_operation_revision_scope_mismatch' });
    if (input.session_id && input.session_id !== session.id) throw new HttpError(409, { error: 'assist_operation_revision_scope_mismatch' });
    if (input.route && cleanText(input.route, 2_000) !== original.route) throw new HttpError(409, { error: 'assist_operation_revision_route_mismatch' });
    if (input.surface_id && cleanText(input.surface_id, 200) !== original.surface_id) throw new HttpError(409, { error: 'assist_operation_revision_surface_mismatch' });
    if (original.surface_revision && cleanText(input.surface_revision, 200) !== original.surface_revision) throw new HttpError(409, { error: 'assist_operation_revision_surface_revision_mismatch' });
    if (original.browser_instance_id && cleanText(input.browser_instance_id, 200) !== original.browser_instance_id) throw new HttpError(409, { error: 'assist_operation_revision_browser_mismatch' });
    if (!Object.hasOwn(input, 'value')) throw new HttpError(400, { error: 'assist_operation_revision_value_required' });
    const value = sanitizeLedgerValue(input.value);
    assertLedgerValue(value);
    if (original.allowed_values?.length && !original.allowed_values.some((item) => canonicalHash(item) === canonicalHash(value))) throw new HttpError(400, { error: 'assist_dynamic_tool_value_not_allowed' });
    const at = now(), revised = {
      id: id('aop'), session_id: session.id, turn_id: turn.id, project_id: original.project_id || turn.project_id,
      tool_call_id: `revision:${original.id}:${randomBytes(6).toString('hex')}`, tool: original.tool,
      capability_id: original.capability_id || capabilityForTool(toolName(original.tool)), action: 'revise', operation_reference_id: original.operation_reference_id || original.id,
      route: original.route, surface_id: original.surface_id, surface_revision: cleanText(input.surface_revision, 200) || original.surface_revision,
      browser_instance_id: original.browser_instance_id, target_id: original.target_id, target_label: original.target_label || original.target_id,
      summary: `继续修改 · ${original.target_label || original.target_id}`, input_schema: original.input_schema || null,
      locator: { ...(original.locator || {}), surface_revision: cleanText(input.surface_revision, 200) || original.surface_revision },
      requested_value: value, allowed_values: original.allowed_values || null, before_value: null, after_value: null, current_value: null,
      before_hash: null, after_hash: null, current_hash: null, status: requiresConfirmation(original.risk) ? 'pending_confirmation' : 'pending',
      risk: original.risk, revision: 1, inverse_of: null, expected_current_hash: retryingConflict ? original.current_hash : original.current_hash || original.after_hash, forced: false, conflict: null, claimed_by: null,
      claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(), approved_at: null, committed_at: null, failed_at: null, created_at: at, updated_at: at
    };
    state.assist_operations.push(revised); pushV3Event(state, revised.session_id, revised.turn_id, 'operation', operationEvent(revised));
    return publicOperation(revised);
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

async function expireOperation(operationId, code) {
  return mutate((state) => { const operation = state.assist_operations.find((item) => item.id === operationId); if (operation && ['pending', 'claimed', 'pending_confirmation'].includes(operation.status)) failOperation(state, operation, code); });
}

function failOperation(state, operation, code) { const at = now(); Object.assign(operation, { status: 'failed', failure_code: code, failed_at: at, revision: operation.revision + 1, updated_at: at }); pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation)); return operation; }
function assertBrowserLocator(operation, input) { const route = cleanText(input.route, 2_000), surfaceId = cleanText(input.surface_id, 200), revision = cleanText(input.surface_revision, 200); if (!route || !surfaceId || !revision) throw new HttpError(400, { error: 'assist_operation_locator_required' }); if (route !== operation.route || surfaceId !== operation.surface_id || revision !== operation.surface_revision) throw new HttpError(409, { error: 'assist_operation_surface_changed' }); }
function requireOperation(state, operationId) { const item = state.assist_operations.find((entry) => entry.id === operationId); if (!item) throw new HttpError(404, { error: 'assist_operation_not_found' }); return item; }
function clampInt(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
