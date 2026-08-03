import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { HttpError } from './http.mjs';
import { mutate } from './state.mjs';
import { addTrace } from './state.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { ACTIVE_WORKFLOW_EXECUTION_STATUSES } from './workflow-execution-status.mjs';
import { applyWorkflowOutcomeProtocols } from './workflow-outcome-definition.mjs';
import {
  defaultQualityReviewRubric,
  qualityReviewProfileIdForState,
  qualityReviewRubricHash,
  validateQualityReviewRubricInput
} from './quality-review-rubric.mjs';

const QUALITY_REVIEW_THRESHOLD = 80;

export async function updateQualityReviewPolicy(workflowId, input = {}, actorId = null) {
  return mutate((state) => updateQualityReviewPolicyInState(state, workflowId, input, actorId));
}

export function updateQualityReviewPolicyInState(state, workflowId, input = {}, actorId = null) {
  const workflow = state.workflows.find((item) => item.id === workflowId);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  const revision = Number(workflow.workflow_revision || workflow.version || 1);
  if (!Number.isInteger(input.expected_revision))
    throw new HttpError(400, { error: 'expected_revision_required', current_revision: revision });
  if (Number(input.expected_revision) !== revision)
    throw new HttpError(409, {
      error: 'quality_review_policy_revision_conflict',
      expected_revision: Number(input.expected_revision),
      current_revision: revision
    });
  const active = state.workflow_executions.find(
    (item) => item.workflow_id === workflow.id && ACTIVE_WORKFLOW_EXECUTION_STATUSES.includes(item.status)
  );
  if (active)
    throw new HttpError(409, {
      error: 'quality_review_policy_execution_active',
      workflow_execution_id: active.id
    });
  if (typeof input.enabled !== 'boolean') throw new HttpError(400, { error: 'quality_review_policy_enabled_required' });
  const policy = input.enabled ? enabledPolicy(input.rubric) : disabledPolicy();
  const nextRevision = revision + 1,
    timestamp = now();
  Object.assign(workflow, {
    quality_review_profile_id: input.enabled ? qualityReviewProfileIdForState(state) : null,
    quality_review_policy: policy,
    workflow_revision: nextRevision,
    version: nextRevision,
    updated_at: timestamp
  });
  const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  applyWorkflowOutcomeProtocols(workflow, nodes);
  addTrace(
    state,
    'quality_review.policy_updated',
    {
      project_id: workflow.project_id,
      target_type: 'workflow',
      target_id: workflow.id,
      summary: input.enabled ? 'Quality Review 策略已启用。' : 'Quality Review 策略已停用。',
      data: { enabled: input.enabled, revision: nextRevision, rubric_hash: policy.rubric_hash }
    },
    actorId
  );
  return {
    workflow_id: workflow.id,
    project_id: workflow.project_id,
    revision: nextRevision,
    quality_review_profile_id: workflow.quality_review_profile_id,
    quality_review_policy: structuredClone(policy)
  };
}

function enabledPolicy(input) {
  const source = input && typeof input === 'object' ? input : defaultQualityReviewRubric();
  if (source.threshold != null && Number(source.threshold) !== QUALITY_REVIEW_THRESHOLD)
    throw new HttpError(409, {
      error: 'quality_review_threshold_read_only',
      expected: QUALITY_REVIEW_THRESHOLD,
      actual: Number(source.threshold)
    });
  if (source.mandatory != null && source.mandatory !== true)
    throw new HttpError(409, { error: 'quality_review_mandatory_read_only' });
  const rubric = validateQualityReviewRubricInput({
    ...source,
    enabled: true,
    mandatory: true,
    threshold: QUALITY_REVIEW_THRESHOLD
  });
  return {
    enabled: true,
    mandatory: true,
    strategy: 'v23_default',
    rubric,
    rubric_hash: qualityReviewRubricHash(rubric)
  };
}

function disabledPolicy() {
  return { enabled: false, mandatory: false, strategy: 'legacy_opt_in', rubric: null, rubric_hash: null };
}
