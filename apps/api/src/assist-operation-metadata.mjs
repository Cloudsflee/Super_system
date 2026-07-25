import { assistCapability } from '../../../packages/shared/index.mjs';

export function publicOperation(item, state = null) {
  if (!item) return null;
  const result = { ...item };
  if (item.proposal_id && state) {
    const proposal = state.change_proposals.find((entry) => entry.id === item.proposal_id);
    result.proposal_status = proposal?.status || item.proposal_status || null;
    result.proposal_attention_state = proposal?.attention_state || null;
    result.proposal_destructive = Boolean(proposal?.destructive);
  }
  delete result.tool;
  delete result.browser_instance_id;
  delete result.requested_value;
  delete result.allowed_values;
  delete result.domain_request;
  delete result.domain_inverse;
  return result;
}
export function operationEvent(item) {
  return {
    operation_id: item.id,
    capability_id: item.capability_id,
    action: item.action,
    execution_layer: item.execution_layer || 'browser',
    result_kind: item.result_kind || null,
    proposal_id: item.proposal_id || null,
    proposal_status: item.proposal_status || null,
    target_id: item.target_id,
    target_label: item.target_label,
    summary: item.summary,
    locator: item.locator,
    route: item.route,
    surface_id: item.surface_id,
    surface_revision: item.surface_revision,
    status: item.status,
    risk: item.risk,
    revision: item.revision,
    inverse_of: item.inverse_of,
    operation_reference_id: item.operation_reference_id || null,
    forced: item.forced,
    conflict: item.conflict,
    claimable: item.status === 'pending' && item.execution_layer !== 'server',
    requires_confirmation: item.status === 'pending_confirmation'
  };
}
export function executionPayload(item) {
  return {
    operation_id: item.id,
    capability_id: item.capability_id,
    action: item.action,
    tool: item.tool,
    target_id: item.target_id,
    target_label: item.target_label,
    value: item.requested_value,
    route: item.route,
    surface_id: item.surface_id,
    surface_revision: item.surface_revision,
    inverse_of: item.inverse_of,
    operation_reference_id: item.operation_reference_id || null,
    expected_current_hash: item.expected_current_hash,
    forced: item.forced,
    revision: item.revision
  };
}
export function toolSuccess(item) {
  return {
    success: true,
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify({
          operation_id: item.id,
          status: item.status,
          result_kind: item.result_kind || null,
          proposal_id: item.proposal_id || null,
          proposal_status: item.proposal_status || null,
          approval_required: item.result_kind === 'change_proposal',
          formal_workflow_changed: item.result_kind === 'change_proposal' ? false : undefined,
          target_id: item.target_id,
          before_hash: item.before_hash,
          after_hash: item.after_hash
        })
      }
    ]
  };
}
export function toolDefinition(name, description, targetIds) {
  return {
    type: 'function',
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: name === 'select_tab' ? ['target_id'] : ['target_id', 'value'],
      properties: { target_id: { type: 'string', enum: targetIds }, ...(name === 'select_tab' ? {} : { value: {} }) }
    }
  };
}
export function capabilityForTool(tool) {
  return tool === 'set_filter'
    ? 'surface.filter.set'
    : tool === 'select_tab'
      ? 'surface.tab.select'
      : 'surface.field.set';
}
export function actionForTool(tool) {
  return assistCapability(capabilityForTool(tool))?.action || (tool === 'select_tab' ? 'select' : 'set');
}
export function semanticSummary(tool, label) {
  return tool === 'select_tab'
    ? `已切换 · ${label}`
    : tool === 'set_filter'
      ? `已更新筛选 · ${label}`
      : `已更新 · ${label}`;
}
export function toolName(value) {
  return String(value || '')
    .split('.')
    .at(-1);
}
export function toolMatchesKind(tool, kind) {
  return tool === 'set_field' ? kind === 'field' : tool === 'set_filter' ? kind === 'filter' : kind === 'tab';
}
export function requiresConfirmation(risk) {
  return !['low', 'reversible'].includes(risk);
}
export function syncProposalOperationState(state, proposal) {
  const updated = [];
  for (const operation of state.assist_operations.filter(
    (item) => item.proposal_id === proposal.id && item.proposal_status !== proposal.status
  )) {
    operation.proposal_status = proposal.status;
    operation.revision = Number(operation.revision || 1) + 1;
    operation.updated_at = proposal.updated_at;
    updated.push(operation);
  }
  return updated;
}
