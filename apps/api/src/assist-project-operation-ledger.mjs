import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { randomBytes } from 'node:crypto';
import { id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner } from './state.mjs';
import { canonicalJson, sha256 } from './state-migration-v14.mjs';
import { cleanText, requireSession, requireTurn } from './assist-v3-domain.mjs';
import { pushV3Event } from './assist-v3-events.mjs';
import { operationEvent, publicOperation, requiresConfirmation, toolSuccess } from './assist-operation-metadata.mjs';
import {
  PROJECT_TOOL_NAMESPACE,
  currentProjectCapabilityValue,
  executeProjectCapabilityInState,
  prepareProjectCapabilityOperation,
  prepareProjectCapabilityRevision,
  undoProjectCapabilityInState
} from './assist-project-tools.mjs';

const MAX_LEDGER_VALUE_BYTES = 64 * 1024;

export async function handleProjectCapabilityTool(sessionId, turnId, params, signal, waitForApproval) {
  const args =
    params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
  rejectDangerousArguments(args);
  assertLedgerValue(sanitizeLedgerValue(args));
  const callId = cleanText(params.callId, 300) || id('call');
  const created = await mutate((state) => {
    const session = requireSession(state, sessionId, true),
      turn = requireTurn(state, turnId);
    const duplicate = state.assist_operations.find((item) => item.turn_id === turn.id && item.tool_call_id === callId);
    if (duplicate) return duplicate;
    const prepared = prepareProjectCapabilityOperation(state, session, turn, params),
      at = now();
    const item = makeProjectOperation(session, turn, prepared, callId, at);
    if (prepared.request.resource_type === 'workflow') {
      const actor = owner(state),
        outcome = executeProjectCapabilityInState(state, item, actor.id);
      applyOutcome(item, outcome);
      item.summary = `已创建工作流变更提案 · ${outcome.targetLabel}`;
      state.assist_operations.push(item);
      traceCommittedOutcome(state, item, outcome, actor.id);
      pushV3Event(state, session.id, turn.id, 'operation', operationEvent(item));
      return item;
    }
    state.assist_operations.push(item);
    pushV3Event(state, session.id, turn.id, 'operation', operationEvent(item));
    return item;
  });
  if (created.status === 'committed') return toolSuccess(created);
  if (created.status === 'pending_confirmation') await waitForApproval(created.id, signal);
  try {
    const committed = await mutate((state) => commitProjectOperation(state, created.id));
    return toolSuccess(committed);
  } catch (error) {
    await markProjectOperationFailed(created.id, error);
    throw error;
  }
}

export async function undoProjectOperation(operationId, input) {
  const force = input.force === true;
  return mutate((state) => {
    const original = requireOperation(state, operationId);
    assertProjectOperationLocator(original, input);
    if (original.result_kind === 'change_proposal')
      throw new HttpError(409, { error: 'assist_change_proposal_operation_not_undoable' });
    if (original.status !== 'committed' || original.inverse_of)
      throw new HttpError(409, { error: 'assist_operation_not_undoable', status: original.status });
    if (original.undone_by)
      return publicOperation(state.assist_operations.find((item) => item.id === original.undone_by));
    let inverse = state.assist_operations.find(
      (item) => item.inverse_of === original.id && item.execution_layer === 'server'
    );
    if (inverse?.status === 'committed' || (inverse?.status === 'conflicted' && !force))
      return publicOperation(inverse);
    const current = currentProjectCapabilityValue(state, original),
      currentHash = canonicalHash(current.value),
      at = now();
    if (!inverse) {
      inverse = makeProjectInverse(original, current, currentHash, force, at);
      state.assist_operations.push(inverse);
    }
    if (!force && currentHash !== original.after_hash) {
      Object.assign(inverse, {
        status: 'conflicted',
        before_value: current.value,
        current_value: current.value,
        before_hash: currentHash,
        current_hash: currentHash,
        conflict: { before: original.before_value, after: original.after_value, current: current.value },
        revision: inverse.revision + 1,
        updated_at: at
      });
      pushV3Event(state, inverse.session_id, inverse.turn_id, 'operation', operationEvent(inverse));
      return publicOperation(inverse);
    }
    const actor = owner(state),
      outcome = undoProjectCapabilityInState(state, original, actor.id),
      afterHash = canonicalHash(outcome.afterValue);
    Object.assign(inverse, {
      forced: force,
      status: 'committed',
      before_value: outcome.beforeValue,
      after_value: outcome.afterValue,
      current_value: outcome.afterValue,
      before_hash: canonicalHash(outcome.beforeValue),
      after_hash: afterHash,
      current_hash: afterHash,
      resource_revision_before: outcome.resourceRevisionBefore,
      resource_revision_after: outcome.resourceRevisionAfter,
      locator: { ...inverse.locator, resource_revision: outcome.resourceRevisionAfter },
      committed_at: at,
      revision: inverse.revision + 1,
      updated_at: at
    });
    Object.assign(original, { undone_by: inverse.id, undone_at: at, updated_at: at });
    addTrace(
      state,
      'assist.action.confirmed',
      { project_id: inverse.project_id, target_id: inverse.id, summary: inverse.summary },
      actor.id
    );
    pushV3Event(state, inverse.session_id, inverse.turn_id, 'operation', operationEvent(inverse));
    return publicOperation(inverse);
  });
}

export async function reviseProjectOperation(operationId, input) {
  return mutate((state) => {
    const original = requireOperation(state, operationId);
    if (!['committed', 'undone', 'conflicted'].includes(original.status))
      throw new HttpError(409, { error: 'assist_operation_not_revisionable', status: original.status });
    assertProjectOperationLocator(original, input);
    if (!Object.hasOwn(input, 'value')) throw new HttpError(400, { error: 'assist_operation_revision_value_required' });
    const value = sanitizeLedgerValue(input.value);
    assertLedgerValue(value);
    const session = requireSession(state, original.session_id, true),
      turn = input.turn_id ? requireTurn(state, input.turn_id) : requireTurn(state, original.turn_id);
    if (
      turn.session_id !== session.id ||
      turn.project_id !== original.project_id ||
      turn.collaboration_mode === 'plan' ||
      turn.mode === 'plan'
    )
      throw new HttpError(409, { error: 'assist_operation_revision_scope_mismatch' });
    const prepared = prepareProjectCapabilityRevision(state, original, value),
      at = now(),
      actor = owner(state);
    const revised = makeProjectRevision(original, session, turn, prepared, value, at);
    const outcome = executeProjectCapabilityInState(state, revised, actor.id);
    applyOutcome(revised, outcome);
    if (outcome.resultKind === 'change_proposal') revised.summary = `已创建工作流变更提案 · ${outcome.targetLabel}`;
    state.assist_operations.push(revised);
    traceCommittedOutcome(state, revised, outcome, actor.id);
    pushV3Event(state, revised.session_id, revised.turn_id, 'operation', operationEvent(revised));
    return publicOperation(revised);
  });
}

function commitProjectOperation(state, operationId) {
  const operation = requireOperation(state, operationId);
  if (operation.status === 'committed') return operation;
  if (operation.status !== 'pending')
    throw new HttpError(409, { error: 'assist_operation_not_executable', status: operation.status });
  const actor = owner(state),
    outcome = executeProjectCapabilityInState(state, operation, actor.id);
  applyOutcome(operation, outcome);
  operation.summary =
    outcome.resultKind === 'change_proposal'
      ? `已创建工作流变更提案 · ${outcome.targetLabel}`
      : `${operation.summary.split(' · ')[0]} · ${outcome.targetLabel}`;
  traceCommittedOutcome(state, operation, outcome, actor.id);
  pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
  return operation;
}

function applyOutcome(operation, outcome) {
  const beforeHash = canonicalHash(outcome.beforeValue),
    afterHash = canonicalHash(outcome.afterValue),
    currentHash = canonicalHash(outcome.currentValue);
  Object.assign(operation, {
    target_id: outcome.targetId,
    target_label: outcome.targetLabel,
    locator: {
      ...operation.locator,
      target_id: outcome.targetId,
      target_label: outcome.targetLabel,
      resource_revision: outcome.resourceRevisionAfter
    },
    domain_request: { ...operation.domain_request, target_id: outcome.targetId },
    domain_inverse: outcome.inverse,
    domain_value_kind: outcome.valueKind,
    resource_revision_before: outcome.resourceRevisionBefore,
    resource_revision_after: outcome.resourceRevisionAfter,
    before_value: outcome.beforeValue,
    after_value: outcome.afterValue,
    current_value: outcome.currentValue,
    before_hash: beforeHash,
    after_hash: afterHash,
    current_hash: currentHash,
    result_kind: outcome.resultKind || null,
    proposal_id: outcome.proposalId || null,
    proposal_status: outcome.proposalStatus || null,
    status: 'committed',
    committed_at: outcome.committedAt,
    revision: operation.revision + 1,
    updated_at: outcome.committedAt
  });
}

function traceCommittedOutcome(state, operation, outcome, actorId) {
  if (outcome.resultKind === 'change_proposal')
    addTrace(
      state,
      'change_proposal.created',
      {
        project_id: operation.project_id,
        target_type: 'change_proposal',
        target_id: outcome.proposalId,
        summary: operation.summary
      },
      actorId
    );
  addTrace(
    state,
    'assist.action.confirmed',
    { project_id: operation.project_id, target_id: operation.id, summary: operation.summary },
    actorId
  );
}

function makeProjectOperation(session, turn, prepared, callId, at) {
  return {
    id: id('aop'),
    session_id: session.id,
    turn_id: turn.id,
    tool_call_id: callId,
    tool: `${PROJECT_TOOL_NAMESPACE}.${prepared.tool}`,
    execution_layer: 'server',
    project_id: turn.project_id,
    capability_id: prepared.descriptor.id,
    action: prepared.descriptor.action,
    route: prepared.request.route,
    surface_id: prepared.request.surface_id,
    surface_revision: prepared.request.surface_revision,
    browser_instance_id: prepared.request.browser_instance_id,
    target_id: prepared.targetId,
    target_label: prepared.targetLabel,
    summary: `${prepared.descriptor.label_zh} · ${prepared.targetLabel}`,
    input_schema: prepared.inputSchema,
    locator: {
      route: prepared.request.route,
      project_id: turn.project_id,
      surface_id: prepared.request.surface_id,
      surface_revision: prepared.request.surface_revision,
      target_id: prepared.targetId,
      target_label: prepared.targetLabel,
      resource_type: prepared.request.resource_type,
      resource_id: prepared.request.resource_id,
      expected_revision: prepared.request.expected_revision
    },
    requested_value: prepared.request,
    allowed_values: null,
    domain_request: prepared.request,
    domain_inverse: null,
    domain_value_kind: prepared.request.value_kind,
    resource_revision_before: null,
    resource_revision_after: null,
    before_value: null,
    after_value: null,
    current_value: null,
    before_hash: null,
    after_hash: null,
    current_hash: null,
    result_kind: null,
    proposal_id: null,
    proposal_status: null,
    status:
      prepared.request.resource_type === 'workflow'
        ? 'pending'
        : requiresConfirmation(prepared.descriptor.risk)
          ? 'pending_confirmation'
          : 'pending',
    risk: prepared.descriptor.risk,
    revision: 1,
    inverse_of: null,
    operation_reference_id: turn.operation_reference_id || null,
    forced: false,
    conflict: null,
    claimed_by: null,
    claim_expires_at: null,
    approved_at: null,
    committed_at: null,
    failed_at: null,
    created_at: at,
    updated_at: at
  };
}

function makeProjectInverse(original, current, currentHash, force, at) {
  return {
    id: id('aop'),
    session_id: original.session_id,
    turn_id: original.turn_id,
    tool_call_id: `undo:${original.id}:${randomBytes(6).toString('hex')}`,
    tool: original.tool,
    execution_layer: 'server',
    project_id: original.project_id,
    capability_id: original.capability_id,
    action: 'undo',
    route: original.route,
    surface_id: original.surface_id,
    surface_revision: original.surface_revision,
    browser_instance_id: original.browser_instance_id,
    target_id: original.target_id,
    target_label: original.target_label,
    summary: `已撤销 · ${original.target_label || original.target_id}`,
    input_schema: original.input_schema,
    locator: original.locator,
    requested_value: original.before_value,
    allowed_values: null,
    domain_request: original.domain_request,
    domain_inverse: null,
    domain_value_kind: original.domain_value_kind,
    resource_revision_before: current.resource.revision,
    resource_revision_after: null,
    before_value: current.value,
    after_value: null,
    current_value: current.value,
    before_hash: currentHash,
    after_hash: null,
    current_hash: currentHash,
    result_kind: null,
    proposal_id: null,
    proposal_status: null,
    status: 'pending',
    risk: original.risk,
    revision: 1,
    inverse_of: original.id,
    operation_reference_id: original.id,
    expected_current_hash: original.after_hash,
    forced: force,
    conflict: null,
    claimed_by: null,
    claim_expires_at: null,
    approved_at: force ? at : null,
    committed_at: null,
    failed_at: null,
    created_at: at,
    updated_at: at
  };
}

function makeProjectRevision(original, session, turn, prepared, value, at) {
  return {
    id: id('aop'),
    session_id: session.id,
    turn_id: turn.id,
    project_id: original.project_id,
    tool_call_id: `revision:${original.id}:${randomBytes(6).toString('hex')}`,
    tool: `${PROJECT_TOOL_NAMESPACE}.${prepared.tool}`,
    execution_layer: 'server',
    capability_id: prepared.descriptor?.id || original.capability_id,
    action: 'revise',
    operation_reference_id: original.operation_reference_id || original.id,
    route: original.route,
    surface_id: original.surface_id,
    surface_revision: original.surface_revision,
    browser_instance_id: original.browser_instance_id,
    target_id: prepared.targetId,
    target_label: prepared.targetLabel,
    summary: `继续修改 · ${prepared.targetLabel}`,
    input_schema: prepared.inputSchema,
    locator: { ...original.locator, target_id: prepared.targetId, target_label: prepared.targetLabel },
    requested_value: value,
    allowed_values: null,
    domain_request: prepared.request,
    domain_inverse: null,
    domain_value_kind: prepared.request.value_kind,
    resource_revision_before: null,
    resource_revision_after: null,
    before_value: null,
    after_value: null,
    current_value: null,
    before_hash: null,
    after_hash: null,
    current_hash: null,
    result_kind: null,
    proposal_id: null,
    proposal_status: null,
    status: 'pending',
    risk: 'low',
    revision: 1,
    inverse_of: null,
    forced: false,
    conflict: null,
    claimed_by: null,
    claim_expires_at: null,
    approved_at: at,
    committed_at: null,
    failed_at: null,
    created_at: at,
    updated_at: at
  };
}

async function markProjectOperationFailed(operationId, error) {
  return mutate((state) => {
    const operation = state.assist_operations.find((item) => item.id === operationId);
    if (!operation || ['committed', 'failed', 'conflicted'].includes(operation.status)) return operation;
    const code =
        cleanText(error?.payload?.error || error?.code || error?.message, 200) || 'assist_domain_operation_failed',
      at = now(),
      revisionConflict = /revision_conflict/.test(code);
    const conflict = revisionConflict ? projectRevisionConflict(state, operation, error) : null;
    Object.assign(operation, {
      status: revisionConflict ? 'conflicted' : 'failed',
      failure_code: code,
      failed_at: revisionConflict ? null : at,
      ...(conflict
        ? {
            before_value: conflict.before,
            after_value: conflict.after,
            current_value: conflict.current,
            before_hash: conflict.before === null ? null : canonicalHash(conflict.before),
            after_hash: conflict.after === null ? null : canonicalHash(conflict.after),
            current_hash: conflict.current === null ? null : canonicalHash(conflict.current),
            conflict
          }
        : {}),
      revision: operation.revision + 1,
      updated_at: at
    });
    pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
    return operation;
  });
}

function projectRevisionConflict(state, operation, error) {
  let current = null,
    currentRevision = error?.payload?.current_revision ?? null,
    desired = null;
  try {
    const snapshot = currentProjectCapabilityValue(state, operation);
    current = snapshot.value;
    currentRevision = snapshot.resource.revision;
    const isolated = structuredClone(state),
      candidate = structuredClone(operation);
    candidate.domain_request.expected_revision = currentRevision;
    desired = executeProjectCapabilityInState(isolated, candidate, owner(state).id).afterValue;
  } catch {
    desired = requestedConflictValue(operation);
  }
  return {
    before: operation.before_value ?? null,
    after: desired,
    current,
    expected_revision: operation.domain_request?.expected_revision ?? null,
    current_revision: currentRevision
  };
}

function requestedConflictValue(operation) {
  const primary = operation.domain_request?.operations?.[0];
  if (!primary) return null;
  if (['delete_section', 'delete_node'].includes(primary.type)) return null;
  if (primary.type === 'rename_section') return primary.title ?? primary.value ?? null;
  if (['move_section', 'move_node'].includes(primary.type)) return primary.to_index ?? primary.index ?? null;
  if (primary.type === 'reorder_nodes') return primary.node_ids || null;
  return primary.patch || primary.section || primary.node || primary;
}

function assertProjectOperationLocator(original, input) {
  if (cleanText(input.session_id, 200) && cleanText(input.session_id, 200) !== original.session_id)
    throw new HttpError(409, { error: 'assist_operation_revision_scope_mismatch' });
  if (cleanText(input.route, 2_000) !== original.route)
    throw new HttpError(409, { error: 'assist_operation_revision_route_mismatch' });
  if (cleanText(input.surface_id, 200) !== original.surface_id)
    throw new HttpError(409, { error: 'assist_operation_revision_surface_mismatch' });
  if (cleanText(input.surface_revision, 200) !== original.surface_revision)
    throw new HttpError(409, { error: 'assist_operation_revision_surface_revision_mismatch' });
  if (cleanText(input.browser_instance_id, 200) !== original.browser_instance_id)
    throw new HttpError(409, { error: 'assist_operation_revision_browser_mismatch' });
}

function requireOperation(state, operationId) {
  const item = state.assist_operations.find((entry) => entry.id === operationId);
  if (!item) throw new HttpError(404, { error: 'assist_operation_not_found' });
  return item;
}
function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}
function assertLedgerValue(value) {
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_LEDGER_VALUE_BYTES)
    throw new HttpError(413, { error: 'assist_operation_value_too_large', max_bytes: MAX_LEDGER_VALUE_BYTES });
}
function sanitizeLedgerValue(value) {
  const safe = maskSecretsDeep(value);
  if (JSON.stringify(safe).includes('***MASKED'))
    throw new HttpError(409, { error: 'assist_operation_secret_value_forbidden' });
  return safe;
}
function rejectDangerousArguments(value) {
  if (Array.isArray(value)) {
    for (const item of value) if (item && typeof item === 'object') rejectDangerousArguments(item);
    return;
  }
  for (const [key, item] of Object.entries(value || {})) {
    if (/selector|xpath|script|javascript|html|dom|credential|secret|token/i.test(key))
      throw new HttpError(400, { error: 'assist_dynamic_tool_unsafe_argument', field: key });
    if (item && typeof item === 'object') rejectDangerousArguments(item);
  }
}
