import { randomBytes } from 'node:crypto';

import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { cleanText, requireSession, requireTurn } from './assist-v3-domain.mjs';
import { pushV3Event } from './assist-v3-events.mjs';
import {
  capabilityForTool,
  operationEvent,
  publicOperation,
  requiresConfirmation,
  toolName
} from './assist-operation-metadata.mjs';
import { assertLedgerValue, canonicalHash, sanitizeLedgerValue } from './assist-operation-utils.mjs';

const OPERATION_TIMEOUT_MS = 30_000;

export function reviseBrowserAssistOperation(state, operationId, input = {}) {
  const original = requireOperation(state, operationId),
    retryingConflict = Boolean(original.status === 'conflicted' && original.operation_reference_id);
  assertRevisionable(original, retryingConflict);
  const session = requireSession(state, original.session_id, true),
    turn = input.turn_id ? requireTurn(state, input.turn_id) : requireTurn(state, original.turn_id);
  assertRevisionScope(original, session, turn, input);
  const value = revisionValue(original, input),
    revised = buildRevisedOperation(original, session, turn, input, value, retryingConflict);
  state.assist_operations.push(revised);
  pushV3Event(state, revised.session_id, revised.turn_id, 'operation', operationEvent(revised));
  return publicOperation(revised);
}

function assertRevisionable(original, retryingConflict) {
  if (!['committed', 'undone'].includes(original.status) && !retryingConflict)
    throw new HttpError(409, { error: 'assist_operation_not_revisionable', status: original.status });
}

function assertRevisionScope(original, session, turn, input) {
  if (turn.session_id !== session.id || (turn.project_id !== original.project_id && original.project_id))
    throw new HttpError(409, { error: 'assist_operation_revision_scope_mismatch' });
  if (input.session_id && input.session_id !== session.id)
    throw new HttpError(409, { error: 'assist_operation_revision_scope_mismatch' });
  if (input.route && cleanText(input.route, 2_000) !== original.route)
    throw new HttpError(409, { error: 'assist_operation_revision_route_mismatch' });
  if (input.surface_id && cleanText(input.surface_id, 200) !== original.surface_id)
    throw new HttpError(409, { error: 'assist_operation_revision_surface_mismatch' });
  if (original.surface_revision && cleanText(input.surface_revision, 200) !== original.surface_revision)
    throw new HttpError(409, { error: 'assist_operation_revision_surface_revision_mismatch' });
  if (original.browser_instance_id && cleanText(input.browser_instance_id, 200) !== original.browser_instance_id)
    throw new HttpError(409, { error: 'assist_operation_revision_browser_mismatch' });
  if (!Object.hasOwn(input, 'value')) throw new HttpError(400, { error: 'assist_operation_revision_value_required' });
}

function revisionValue(original, input) {
  const value = sanitizeLedgerValue(input.value);
  assertLedgerValue(value);
  if (!allowedRevisionValue(original.allowed_values, value))
    throw new HttpError(400, { error: 'assist_dynamic_tool_value_not_allowed' });
  return value;
}

function allowedRevisionValue(allowedValues, value) {
  if (!allowedValues?.length) return true;
  const valueHash = canonicalHash(value);
  return allowedValues.some((item) => canonicalHash(item) === valueHash);
}

function buildRevisedOperation(original, session, turn, input, value, retryingConflict) {
  const at = now(),
    surfaceRevision = cleanText(input.surface_revision, 200) || original.surface_revision;
  return {
    id: id('aop'),
    session_id: session.id,
    turn_id: turn.id,
    project_id: original.project_id || turn.project_id,
    tool_call_id: `revision:${original.id}:${randomBytes(6).toString('hex')}`,
    tool: original.tool,
    capability_id: original.capability_id || capabilityForTool(toolName(original.tool)),
    action: 'revise',
    operation_reference_id: original.operation_reference_id || original.id,
    route: original.route,
    surface_id: original.surface_id,
    surface_revision: surfaceRevision,
    browser_instance_id: original.browser_instance_id,
    target_id: original.target_id,
    target_label: original.target_label || original.target_id,
    summary: `继续修改 · ${original.target_label || original.target_id}`,
    input_schema: original.input_schema || null,
    locator: { ...(original.locator || {}), surface_revision: surfaceRevision },
    requested_value: value,
    allowed_values: original.allowed_values || null,
    before_value: null,
    after_value: null,
    current_value: null,
    before_hash: null,
    after_hash: null,
    current_hash: null,
    status: requiresConfirmation(original.risk) ? 'pending_confirmation' : 'pending',
    risk: original.risk,
    revision: 1,
    inverse_of: null,
    expected_current_hash: retryingConflict ? original.current_hash : original.current_hash || original.after_hash,
    forced: false,
    conflict: null,
    claimed_by: null,
    claim_expires_at: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(),
    approved_at: null,
    committed_at: null,
    failed_at: null,
    created_at: at,
    updated_at: at
  };
}

function requireOperation(state, operationId) {
  const operation = state.assist_operations.find((item) => item.id === operationId);
  if (!operation) throw new HttpError(404, { error: 'assist_operation_not_found' });
  return operation;
}
