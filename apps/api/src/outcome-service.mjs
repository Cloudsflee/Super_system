import { cloneStateValue as structuredClone } from './state-clone.mjs';
import {
  OUTCOME_EVALUATION_STATUSES,
  parseOutcomeContract,
  parseQualityRubric,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';
import * as qualityReview from './outcome-quality-review.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { instanceOwnerId, membershipFor } from './project-governance-v19.mjs';

const MAX_WAIVER_MS = 30 * 24 * 60 * 60 * 1000;
const EVALUATOR_VERSION = 'aiws.outcome-evaluator.v1';

export function materializeOutcomeRequirementsInState(state, workflowExecution, workflow, timestamp = now()) {
  const contract = parseOutcomeContract(workflow?.outcome_contract),
    rubric = parseQualityRubric(workflow?.quality_rubric),
    contractHash = protocolHash(contract),
    rubricHash = protocolHash(rubric);
  workflowExecution.outcome_contract_hash = contractHash;
  workflowExecution.outcome_contract_source = contract.source;
  workflowExecution.quality_rubric_hash = rubricHash;
  workflowExecution.quality_review_rubric_hash = qualityReview.qualityReviewMaterialization(workflow).hash;
  workflowExecution.quality_review_policy_snapshot = qualityReview.qualityReviewPolicySnapshot(workflow);
  const definitions = [
    ...contract.requirements.map((requirement) => ({ ...requirement, source: 'outcome_contract' })),
    ...rubric.criteria
      .filter((criterion) => criterion.applicable)
      .map((criterion, index) => ({
        id: `rubric:${criterion.id}`,
        title: criterion.title,
        description: null,
        mandatory: criterion.mandatory,
        scope: 'content',
        task_id: null,
        order: contract.requirements.length + index,
        evaluator: criterion.evaluator,
        expected: criterion.expected,
        waivable: true,
        evaluator_config: qualityReview.qualityReviewCriterionConfig(criterion),
        source: 'quality_rubric'
      }))
  ];
  for (const definition of definitions) {
    const requirementId = `oreq_${protocolHash(`${workflowExecution.id}:${definition.source}:${definition.id}`).slice(0, 24)}`;
    if (state.outcome_requirements.some((item) => item.id === requirementId)) continue;
    state.outcome_requirements.push({
      id: requirementId,
      workflow_execution_id: workflowExecution.id,
      project_id: workflowExecution.project_id,
      contract_requirement_id: definition.id,
      source: definition.source,
      contract_version: contract.version,
      contract_hash: contractHash,
      rubric_hash: definition.source === 'quality_rubric' ? rubricHash : null,
      title: definition.title || definition.id,
      description: definition.description || null,
      mandatory: definition.mandatory,
      scope: definition.scope,
      task_id: definition.task_id || null,
      order: definition.order,
      evaluator: definition.evaluator,
      expected: structuredClone(definition.expected),
      waivable: definition.waivable,
      evaluator_config: structuredClone(definition.evaluator_config || {}),
      immutable: true,
      created_at: timestamp
    });
  }
  workflowExecution.outcome_summary = emptySummary(definitions.length);
  return requirementsFor(state, workflowExecution.id);
}

export function evaluateWorkflowOutcomesInState(
  state,
  workflowExecutionId,
  { timestamp = now(), evaluatorVersion = EVALUATOR_VERSION } = {}
) {
  const execution = requireExecution(state, workflowExecutionId),
    requirements = requirementsFor(state, execution.id),
    effectiveWaivers = effectiveWaiversFor(state, execution.id, timestamp),
    current = new Map(requirements.map((requirement) => [requirement.id, currentEvaluation(state, requirement.id)]));
  const evaluations = [];
  for (const requirement of requirements) {
    let result;
    try {
      result = evaluateRequirement(state, execution, requirement);
    } catch (error) {
      result = {
        status: 'error',
        actual: null,
        evidence_refs: [],
        reason_code: safeCode(error?.code || 'outcome_evaluator_error'),
        details: {}
      };
    }
    const waiver = effectiveWaivers.find((item) => item.requirement_ids.includes(requirement.id));
    if (waiver && result.status !== 'satisfied')
      result = {
        ...result,
        status: 'waived',
        reason_code: 'outcome_requirement_waived',
        evidence_refs: [
          ...new Set([...(result.evidence_refs || []), ...(waiver.evidence_refs || []), `outcome_waiver:${waiver.id}`])
        ],
        waiver_id: waiver.id
      };
    const candidate = {
      requirement_id: requirement.id,
      workflow_execution_id: execution.id,
      project_id: execution.project_id,
      status: result.status,
      expected: structuredClone(requirement.expected),
      actual: structuredClone(result.actual ?? null),
      evidence_refs: unique(result.evidence_refs),
      reason_code: safeCode(result.reason_code || `outcome_${result.status}`),
      evaluator: requirement.evaluator,
      evaluator_version: evaluatorVersion,
      waiver_id: result.waiver_id || null,
      details: structuredClone(result.details || {})
    };
    const prior = current.get(requirement.id);
    if (prior && evaluationFingerprint(prior) === evaluationFingerprint(candidate)) evaluations.push(prior);
    else {
      const evaluation = {
        id: id('oev'),
        ...candidate,
        supersedes_evaluation_id: prior?.id || null,
        evaluated_at: timestamp,
        immutable: true,
        created_at: timestamp
      };
      state.outcome_evaluations.push(evaluation);
      evaluations.push(evaluation);
    }
  }
  applyCompletionStatus(execution, requirements, evaluations, effectiveWaivers, timestamp);
  return { workflow_execution: execution, requirements, evaluations, waivers: effectiveWaivers };
}

export function finalizeWorkflowOutcomesInState(state, workflowExecutionId, options = {}) {
  const execution = requireExecution(state, workflowExecutionId),
    tasks = currentTaskExecutions(state, execution.id);
  if (['failed', 'cancelled'].includes(execution.status)) {
    Object.assign(execution, {
      completion_status: 'failed',
      release_eligible: false,
      finalization_state: 'completed',
      finalized_at: options.timestamp || now(),
      updated_at: options.timestamp || now()
    });
    return outcomeSnapshot(state, execution.id);
  }
  if (!tasks.length || tasks.some((task) => task.status !== 'completed'))
    throw new HttpError(409, { error: 'workflow_outcome_finalization_not_ready' });
  const result = evaluateWorkflowOutcomesInState(state, execution.id, options);
  execution.status = 'completed';
  execution.completed_at ||= options.timestamp || now();
  execution.finalization_state = 'completed';
  execution.finalized_at = options.timestamp || now();
  execution.updated_at = options.timestamp || now();
  return result;
}

export function createOutcomeWaiverInState(state, workflowExecutionId, input, actorId, { timestamp = now() } = {}) {
  const execution = requireExecution(state, workflowExecutionId);
  assertOutcomeOwner(state, execution, actorId);
  const requirementIds = unique(input?.requirement_ids);
  if (!requirementIds.length)
    throw new HttpError(400, { error: 'outcome_waiver_requirements_required', field_path: '/requirement_ids' });
  const requirements = requirementIds.map((requirementId) => {
    const requirement = state.outcome_requirements.find(
      (item) => item.id === requirementId && item.workflow_execution_id === execution.id
    );
    if (!requirement)
      throw new HttpError(404, { error: 'outcome_requirement_not_found', requirement_id: requirementId });
    if (!requirement.waivable)
      throw new HttpError(409, { error: 'outcome_requirement_nonwaivable', requirement_id: requirementId });
    return requirement;
  });
  const reason = String(input?.reason || '').trim();
  if (reason.length < 10) throw new HttpError(400, { error: 'outcome_waiver_reason_required', field_path: '/reason' });
  const evidenceRefs = unique(input?.evidence_refs);
  if (!evidenceRefs.length)
    throw new HttpError(400, { error: 'outcome_waiver_evidence_required', field_path: '/evidence_refs' });
  const expiresAt = String(input?.expires_at || ''),
    duration = Date.parse(expiresAt) - Date.parse(timestamp);
  if (!(duration > 0 && duration <= MAX_WAIVER_MS))
    throw new HttpError(400, { error: 'outcome_waiver_expiry_invalid', field_path: '/expires_at', max_days: 30 });
  const waiver = {
    id: id('owv'),
    workflow_execution_id: execution.id,
    project_id: execution.project_id,
    action: 'grant',
    requirement_ids: requirements.map((item) => item.id).sort(),
    reason,
    evidence_refs: evidenceRefs,
    expires_at: new Date(Date.parse(expiresAt)).toISOString(),
    revokes_waiver_id: null,
    created_by_user_id: actorId,
    immutable: true,
    created_at: timestamp
  };
  state.outcome_waivers.push(waiver);
  evaluateWorkflowOutcomesInState(state, execution.id, { timestamp });
  return waiver;
}

export function revokeOutcomeWaiverInState(
  state,
  workflowExecutionId,
  waiverId,
  input,
  actorId,
  { timestamp = now() } = {}
) {
  const execution = requireExecution(state, workflowExecutionId);
  assertOutcomeOwner(state, execution, actorId);
  const grant = state.outcome_waivers.find(
    (item) => item.id === waiverId && item.workflow_execution_id === execution.id && item.action === 'grant'
  );
  if (!grant) throw new HttpError(404, { error: 'outcome_waiver_not_found' });
  if (state.outcome_waivers.some((item) => item.action === 'revoke' && item.revokes_waiver_id === grant.id))
    throw new HttpError(409, { error: 'outcome_waiver_already_revoked' });
  const reason = String(input?.reason || '').trim();
  if (reason.length < 3)
    throw new HttpError(400, { error: 'outcome_waiver_revoke_reason_required', field_path: '/reason' });
  const revocation = {
    id: id('owv'),
    workflow_execution_id: execution.id,
    project_id: execution.project_id,
    action: 'revoke',
    requirement_ids: [...grant.requirement_ids],
    reason,
    evidence_refs: unique(input?.evidence_refs),
    expires_at: null,
    revokes_waiver_id: grant.id,
    created_by_user_id: actorId,
    immutable: true,
    created_at: timestamp
  };
  state.outcome_waivers.push(revocation);
  evaluateWorkflowOutcomesInState(state, execution.id, { timestamp });
  return revocation;
}

export function outcomeSnapshot(state, workflowExecutionId, { timestamp = now() } = {}) {
  const execution = requireExecution(state, workflowExecutionId),
    requirements = requirementsFor(state, execution.id),
    evaluations = requirements.map((item) => currentEvaluation(state, item.id)).filter(Boolean),
    grants = state.outcome_waivers.filter(
      (item) => item.workflow_execution_id === execution.id && item.action === 'grant'
    );
  return {
    workflow_execution: execution,
    requirements,
    evaluations,
    waivers: grants.map((waiver) => ({
      ...waiver,
      active: waiverIsEffective(state, waiver, timestamp),
      revoked: state.outcome_waivers.some((item) => item.action === 'revoke' && item.revokes_waiver_id === waiver.id),
      expired: Date.parse(waiver.expires_at || '') <= Date.parse(timestamp)
    }))
  };
}

export function effectiveWaiversFor(state, workflowExecutionId, timestamp = now()) {
  return state.outcome_waivers.filter(
    (item) =>
      item.workflow_execution_id === workflowExecutionId &&
      item.action === 'grant' &&
      waiverIsEffective(state, item, timestamp)
  );
}

function evaluateRequirement(state, execution, requirement) {
  const supplied =
    execution.outcome_facts?.[requirement.contract_requirement_id] || execution.outcome_facts?.[requirement.id];
  if (supplied && !qualityReview.isQualityReviewHumanScore(requirement))
    return evaluateSuppliedFact(supplied, requirement);
  const evaluator = EVALUATORS[requirement.evaluator];
  if (!evaluator) return result('error', null, [], 'outcome_evaluator_unknown');
  return evaluator(state, execution, requirement);
}

const EVALUATORS = Object.freeze({
  task_acceptance(state, execution, requirement) {
    const tasks = currentTaskExecutions(state, execution.id).filter(
      (item) => !requirement.task_id || item.task_id === requirement.task_id
    );
    const accepted = tasks.length > 0 && tasks.every((item) => item.status === 'completed');
    return result(
      accepted ? 'satisfied' : 'unsatisfied',
      { completed: tasks.filter((item) => item.status === 'completed').length, total: tasks.length },
      tasks.flatMap((item) => [`task_execution:${item.id}`, ...(item.evidence?.evidence_refs || [])]),
      accepted ? 'task_acceptance_satisfied' : 'task_acceptance_incomplete'
    );
  },
  effect_claim(state, execution, requirement) {
    const expectedIds = unique(requirement.expected?.claim_ids || requirement.evaluator_config?.claim_ids),
      tasks = currentTaskExecutions(state, execution.id),
      accepted = new Set(tasks.flatMap((item) => item.accepted_effect_claim_ids || [])),
      missing = expectedIds.filter((claimId) => !accepted.has(claimId));
    return result(
      expectedIds.length > 0 && missing.length === 0 ? 'satisfied' : 'unsatisfied',
      { accepted_claim_ids: [...accepted].sort(), missing_claim_ids: missing },
      tasks.flatMap((item) => (item.accepted_effect_claim_ids || []).map((claimId) => `effect_claim:${claimId}`)),
      missing.length ? 'effect_claim_coverage_incomplete' : 'effect_claim_coverage_satisfied'
    );
  },
  delivery_receipt(state, execution, requirement) {
    const deliveries = (state.deliveries || []).filter(
      (item) => item.workflow_execution_id === execution.id || item.project_id === execution.project_id
    );
    const acceptedStatuses = unique(requirement.expected?.statuses || ['delivered', 'completed', 'sent']),
      matching = deliveries.filter((item) => acceptedStatuses.includes(String(item.status)));
    return result(
      matching.length > 0 ? 'satisfied' : 'unsatisfied',
      { statuses: deliveries.map((item) => item.status), receipts: matching.map((item) => item.id) },
      matching.map((item) => `delivery:${item.id}`),
      matching.length ? 'delivery_receipt_satisfied' : 'delivery_receipt_missing'
    );
  },
  trusted_metric(state, execution, requirement) {
    const metricName = requirement.expected?.metric || requirement.evaluator_config?.metric,
      actual = execution.metrics?.[metricName] ?? findMetric(state, execution, metricName),
      passed = compareMetric(actual, requirement.expected || {});
    return result(
      passed ? 'satisfied' : 'unsatisfied',
      { metric: metricName, value: actual ?? null },
      metricName ? [`metric:${metricName}`] : [],
      passed ? 'trusted_metric_satisfied' : 'trusted_metric_unsatisfied'
    );
  },
  context_freshness(state, execution) {
    const documents = currentTaskExecutions(state, execution.id).flatMap((taskExecution) =>
        (taskExecution.context_snapshot?.system_context?.document_versions || []).map((document) => ({
          ...document,
          task_id: taskExecution.task_id
        }))
      ),
      stale = documents.filter((document) => {
        const node = state.context_nodes.find((item) => item.id === document.node_id),
          version = state.context_document_versions.find(
            (item) => item.id === document.document_version_id && item.node_id === document.node_id
          ),
          exactBinding = version && version.content_sha256 === document.content_sha256 && version.immutable === true;
        if (!node || !exactBinding || node.freshness?.status !== 'current') return true;
        if (node.current_version_id === document.document_version_id) return false;
        return !(node.source_collection === 'workflow_nodes' && String(node.source_id) === String(document.task_id));
      }),
      acceptedAnchorSupersessions = documents.filter((document) => {
        const node = state.context_nodes.find((item) => item.id === document.node_id);
        return (
          node?.current_version_id !== document.document_version_id &&
          node?.source_collection === 'workflow_nodes' &&
          String(node.source_id) === String(document.task_id) &&
          !stale.includes(document)
        );
      });
    return result(
      documents.length > 0 && stale.length === 0 ? 'satisfied' : 'unsatisfied',
      {
        checked: documents.length,
        stale_document_version_ids: stale.map((item) => item.document_version_id),
        accepted_anchor_supersession_version_ids: acceptedAnchorSupersessions.map((item) => item.document_version_id)
      },
      documents.map((item) => `context_document_version:${item.document_version_id}`),
      stale.length || !documents.length ? 'context_freshness_unsatisfied' : 'context_freshness_satisfied'
    );
  },
  manual_review(state, execution, requirement) {
    const reviews = (state.human_reviews || []).filter(
      (item) =>
        item.workflow_execution_id === execution.id &&
        (item.requirement_id === requirement.id || item.requirement_id === requirement.contract_requirement_id)
    );
    const approved = reviews.find((item) => ['approved', 'accepted'].includes(String(item.status || item.decision)));
    return result(
      approved ? 'satisfied' : 'unsatisfied',
      approved ? { approved: true, review_id: approved.id } : { approved: false },
      approved ? [`human_review:${approved.id}`] : [],
      approved ? 'manual_review_satisfied' : 'manual_review_required'
    );
  },
  json_schema(state, execution, requirement) {
    const outputs = outputVersions(state, execution),
      requiredKeys = unique(requirement.expected?.required || []),
      missing = requiredKeys.filter(
        (key) => !outputs.some((item) => Object.hasOwn(item.manifest?.metadata || {}, key))
      );
    return result(
      outputs.length > 0 && missing.length === 0 ? 'satisfied' : 'unsatisfied',
      { output_version_ids: outputs.map((item) => item.id), missing_fields: missing },
      outputs.map((item) => `asset_version:${item.id}`),
      missing.length || !outputs.length ? 'json_schema_unsatisfied' : 'json_schema_satisfied'
    );
  },
  evidence_refs(state, execution, requirement) {
    const tasks = currentTaskExecutions(state, execution.id),
      refs = unique([
        ...tasks.flatMap((item) => item.evidence?.evidence_refs || []),
        ...outputVersions(state, execution).flatMap((item) => item.evidence_refs || item.manifest?.evidence_refs || [])
      ]),
      minimum = Number(requirement.expected?.min_count ?? 1);
    return result(
      refs.length >= minimum ? 'satisfied' : 'unsatisfied',
      { count: refs.length, minimum },
      refs,
      refs.length >= minimum ? 'evidence_refs_satisfied' : 'evidence_refs_insufficient'
    );
  },
  claim_coverage(state, execution, requirement) {
    return EVALUATORS.effect_claim(state, execution, requirement);
  },
  human_score(state, execution, requirement) {
    const evaluation = qualityReview.qualityReviewHumanScoreEvaluation(state, execution, requirement);
    return result(evaluation.status, evaluation.actual, evaluation.evidenceRefs, evaluation.reasonCode);
  }
});

function evaluateSuppliedFact(fact, requirement) {
  const explicit = OUTCOME_EVALUATION_STATUSES.includes(fact.status) ? fact.status : null,
    passed = explicit ? explicit === 'satisfied' : expectedMatches(fact.actual, requirement.expected);
  return result(
    explicit || (passed ? 'satisfied' : 'unsatisfied'),
    fact.actual ?? null,
    fact.evidence_refs || [],
    fact.reason_code || (passed ? 'declared_fact_satisfied' : 'declared_fact_unsatisfied')
  );
}

function applyCompletionStatus(execution, requirements, evaluations, effectiveWaivers, timestamp) {
  const counts = Object.fromEntries(OUTCOME_EVALUATION_STATUSES.map((status) => [status, 0]));
  for (const evaluation of evaluations) counts[evaluation.status] += 1;
  const byRequirement = new Map(evaluations.map((item) => [item.requirement_id, item])),
    gaps = requirements.filter((item) => byRequirement.get(item.id)?.status !== 'satisfied'),
    mandatoryGaps = gaps.filter((item) => item.mandatory),
    allGapsWaived = gaps.length > 0 && gaps.every((item) => byRequirement.get(item.id)?.status === 'waived'),
    mandatoryGapsWaived =
      mandatoryGaps.length > 0 && mandatoryGaps.every((item) => byRequirement.get(item.id)?.status === 'waived');
  const completionStatus = !gaps.length
    ? 'completed'
    : allGapsWaived || mandatoryGapsWaived
      ? 'waived'
      : 'completed_with_gaps';
  execution.completion_status = completionStatus;
  execution.release_eligible = mandatoryGaps.length === 0 || mandatoryGapsWaived;
  execution.outcome_summary = {
    total: requirements.length,
    ...counts,
    mandatory_gaps: mandatoryGaps.length,
    optional_gaps: gaps.length - mandatoryGaps.length,
    effective_waivers: effectiveWaivers.length,
    evaluated_at: timestamp
  };
  execution.updated_at = timestamp;
}

function assertOutcomeOwner(state, execution, actorId) {
  const membership = membershipFor(state, execution.project_id, actorId);
  if (actorId !== instanceOwnerId(state) && membership?.role !== 'owner')
    throw new HttpError(403, { error: 'outcome_waiver_owner_required', required: 'project_owner' });
}

function waiverIsEffective(state, waiver, timestamp) {
  return (
    Date.parse(waiver.expires_at || '') > Date.parse(timestamp) &&
    !state.outcome_waivers.some((item) => item.action === 'revoke' && item.revokes_waiver_id === waiver.id)
  );
}

function currentEvaluation(state, requirementId) {
  return (
    state.outcome_evaluations
      .filter((item) => item.requirement_id === requirementId)
      .sort(
        (left, right) =>
          String(right.evaluated_at).localeCompare(String(left.evaluated_at)) ||
          String(right.id).localeCompare(String(left.id))
      )[0] || null
  );
}

function requirementsFor(state, executionId) {
  return state.outcome_requirements
    .filter((item) => item.workflow_execution_id === executionId)
    .sort((left, right) => Number(left.order) - Number(right.order) || String(left.id).localeCompare(String(right.id)));
}

function currentTaskExecutions(state, executionId) {
  const candidates = state.task_executions.filter((item) => item.workflow_execution_id === executionId),
    superseded = new Set(candidates.map((item) => item.supersedes_id).filter(Boolean));
  return candidates.filter((item) => !superseded.has(item.id) && item.status !== 'superseded');
}

function outputVersions(state, execution) {
  const executionIds = new Set(currentTaskExecutions(state, execution.id).map((item) => item.id)),
    assetIds = new Set(state.assets.filter((item) => executionIds.has(item.task_execution_id)).map((item) => item.id));
  return state.asset_versions.filter((item) => assetIds.has(item.asset_id));
}

function findMetric(state, execution, metricName) {
  const report = (state.test_results || []).find(
    (item) => item.workflow_execution_id === execution.id && Object.hasOwn(item.metrics || {}, metricName)
  );
  return report?.metrics?.[metricName];
}

function compareMetric(actual, expected) {
  if (!Number.isFinite(Number(actual))) return false;
  const value = Number(expected.value ?? expected.expected ?? expected.min ?? 0),
    number = Number(actual);
  switch (expected.operator || (Object.hasOwn(expected, 'min') ? '>=' : '==')) {
    case '>=':
      return number >= value;
    case '>':
      return number > value;
    case '<=':
      return number <= value;
    case '<':
      return number < value;
    case '!=':
      return number !== value;
    default:
      return number === value;
  }
}

function expectedMatches(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.hasOwn(expected, 'value'))
    return compareMetric(actual, expected);
  return protocolHash(actual) === protocolHash(expected);
}

function result(status, actual, evidenceRefs, reasonCode) {
  return { status, actual, evidence_refs: unique(evidenceRefs), reason_code: reasonCode, details: {} };
}

function evaluationFingerprint(value) {
  return protocolHash({
    status: value.status,
    expected: value.expected,
    actual: value.actual,
    evidence_refs: value.evidence_refs,
    reason_code: value.reason_code,
    evaluator: value.evaluator,
    evaluator_version: value.evaluator_version,
    waiver_id: value.waiver_id,
    details: value.details
  });
}

function emptySummary(total) {
  return { total, pending: total, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: total };
}

function requireExecution(state, idValue) {
  const execution = state.workflow_executions.find((item) => item.id === idValue);
  if (!execution) throw new HttpError(404, { error: 'workflow_execution_not_found' });
  return execution;
}

function unique(values) {
  return [
    ...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))
  ].sort();
}

function safeCode(value) {
  const code = String(value || '').slice(0, 200);
  return /^[a-z0-9_.-]+$/i.test(code) ? code : 'outcome_evaluator_error';
}
