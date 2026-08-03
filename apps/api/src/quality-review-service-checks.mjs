import { currentTaskExecutions } from './workflow-execution-domain.mjs';
import { normalizeQualityReviewRubric, qualityReviewRubricHash } from './quality-review-rubric.mjs';
import { safeCode } from './quality-review-service-state.mjs';

export function qualityReviewRubricChecks(state, execution, run) {
  let rubric;
  try {
    rubric = normalizeQualityReviewRubric(run.rubric);
  } catch (error) {
    return [
      check('rubric_identity', 'blocked', '冻结 Rubric 无法通过协议校验。', {
        error_code: safeCode(error.code || 'quality_review_rubric_invalid')
      })
    ];
  }
  const context = rubricCheckContext(state, execution, run, rubric);
  return [
    rubricIdentityCheck(run, rubric),
    rubricWeightsCheck(rubric),
    rubricScopeCheck(run, rubric),
    outcomeThresholdCheck(context)
  ];
}

function rubricCheckContext(state, execution, run, rubric) {
  const workflow = state.workflows.find((item) => item.id === execution.workflow_id),
    frozenPolicy = execution.quality_review_policy_snapshot,
    policy = frozenPolicy && typeof frozenPolicy === 'object' ? frozenPolicy : workflow?.quality_review_policy,
    policyRubric = policy?.enabled ? normalizeQualityReviewRubric(policy.rubric) : null,
    thresholdRequirement = (state.outcome_requirements || []).find(isSemanticHumanRequirement(execution.id)),
    expectedOutcomeThreshold = thresholdRequirement
      ? Number(thresholdRequirement.expected?.min ?? thresholdRequirement.expected)
      : null;
  return {
    run,
    rubric,
    policyRubric,
    thresholdRequirement,
    expectedOutcomeThreshold,
    thresholdMatches:
      Number(run.threshold) === Number(rubric.threshold) &&
      (!policyRubric || Number(run.threshold) === Number(policyRubric.threshold)) &&
      (expectedOutcomeThreshold == null || Number(run.threshold) === expectedOutcomeThreshold)
  };
}

function isSemanticHumanRequirement(executionId) {
  return (item) =>
    item.workflow_execution_id === executionId &&
    item.evaluator === 'human_score' &&
    item.evaluator_config?.quality_review === true &&
    (item.contract_requirement_id === 'semantic_human_score' ||
      item.evaluator_config?.criterion_id === 'semantic_human_score');
}

function rubricIdentityCheck(run, rubric) {
  return check(
    'rubric_identity',
    run.rubric_hash === qualityReviewRubricHash(rubric) ? 'passed' : 'blocked',
    '冻结 Rubric 身份和哈希校验通过。',
    { schema_version: rubric.schema_version, version: rubric.version, rubric_hash: run.rubric_hash }
  );
}

function rubricWeightsCheck(rubric) {
  const enabled = rubric.dimensions.filter((item) => item.enabled),
    enabledWeight = enabled.reduce((sum, item) => sum + Number(item.weight), 0),
    valid = enabled.length > 0 && Math.abs(enabledWeight - 100) <= 0.0001;
  return check(
    'rubric_weights',
    valid ? 'passed' : 'blocked',
    valid ? '启用 Rubric 维度权重合计为 100。' : '启用 Rubric 维度权重必须合计为 100。',
    {
      enabled_weight: enabledWeight,
      dimensions: rubric.dimensions.map((item) => ({ id: item.id, enabled: item.enabled, weight: item.weight }))
    }
  );
}

function rubricScopeCheck(run, rubric) {
  const enabled = rubric.dimensions.filter((item) => item.enabled),
    disabled = rubric.dimensions.filter((item) => !item.enabled);
  return check('rubric_scope', enabled.length > 0 ? 'passed' : 'blocked', 'Rubric 评审范围已冻结，仅使用启用维度。', {
    enabled_dimension_ids: enabled.map((item) => item.id),
    disabled_dimension_ids: disabled.map((item) => item.id),
    asset_version_ids: run.asset_version_ids,
    excluded_asset_version_ids: run.excluded_assets.map((item) => item.asset_version_id),
    out_of_scope_asset_version_ids: run.out_of_scope_assets
  });
}

function outcomeThresholdCheck(context) {
  const { run, rubric, policyRubric, thresholdRequirement, expectedOutcomeThreshold, thresholdMatches } = context;
  return check(
    'outcome_threshold',
    thresholdMatches ? 'passed' : 'blocked',
    thresholdMatches ? 'Outcome 人工评分阈值已冻结并保持一致。' : 'Outcome 人工评分阈值与冻结 Rubric 不一致。',
    {
      run_threshold: Number(run.threshold),
      rubric_threshold: Number(rubric.threshold),
      policy_threshold: policyRubric ? Number(policyRubric.threshold) : null,
      outcome_requirement_id: thresholdRequirement?.id || null,
      outcome_threshold: expectedOutcomeThreshold
    }
  );
}

export function sourceEvidenceChecks(state, execution) {
  const refs = new Set(
    currentTaskExecutions(state, execution.id).flatMap((item) => item.evidence?.evidence_refs || [])
  );
  return [
    check(
      'source_evidence',
      refs.size ? 'passed' : 'warning',
      refs.size ? '已有来源证据引用。' : '未发现来源证据引用，人工裁决必须自行核验。',
      { count: refs.size }
    )
  ];
}

export function buildOutOfScopeLimitations(parsed, _run, outOfScopeCandidates) {
  return [
    ...parsed.flatMap((asset) => assetOutOfScopeLimitations(asset)),
    ...outOfScopeCandidates.map(candidateOutOfScopeLimitation)
  ];
}

function assetOutOfScopeLimitations(asset) {
  const entries = asset.out_of_scope || [];
  if (!entries.length) return [];
  return [formatOutOfScope(asset.title, asset.asset_version_id, entries, '包含')];
}

function candidateOutOfScopeLimitation(candidate) {
  const entries = candidate.out_of_scope_entries || [];
  return formatOutOfScope(candidate.title, candidate.asset_version_id, entries, '为范围外资产');
}

function formatOutOfScope(title, assetVersionId, entries, prefix) {
  const paths = entries.map((entry) => String(entry.path || 'unknown')).slice(0, 20),
    suffix = entries.length > paths.length ? ` 等另外 ${entries.length - paths.length} 个文件` : '',
    files = paths.length ? `：${paths.join('、')}${suffix}` : '';
  return `${title}（${assetVersionId}）${prefix} ${entries.length} 个范围外文件${files}；不构成通过依据。`;
}

export function outcomeReadinessChecks(state, execution) {
  return ['source_evidence', 'counterevidence', 'confidence_basis', 'authority_mapping'].map((criterionId) => {
    const requirement = findOutcomeRequirement(state, execution.id, criterionId),
      latest = latestEvaluation(state, requirement?.id),
      passed = latest?.status === 'satisfied';
    return check(
      `outcome_${criterionId}`,
      passed ? 'passed' : 'warning',
      passed ? `${criterionId} Outcome 检查通过。` : `${criterionId} Outcome 尚未满足，需人工核验。`,
      { requirement_id: requirement?.id || null, status: latest?.status || 'not_evaluated' }
    );
  });
}

function findOutcomeRequirement(state, executionId, criterionId) {
  return (state.outcome_requirements || []).find(
    (item) =>
      item.workflow_execution_id === executionId &&
      (item.evaluator_config?.criterion_id === criterionId || item.id === `rubric:${criterionId}`)
  );
}

function latestEvaluation(state, requirementId) {
  return (
    (state.outcome_evaluations || [])
      .filter((item) => item.requirement_id === requirementId)
      .sort((left, right) => String(right.evaluated_at).localeCompare(String(left.evaluated_at)))[0] || null
  );
}

function check(idValue, status, message, details = {}) {
  return { id: idValue, status, message, details };
}
