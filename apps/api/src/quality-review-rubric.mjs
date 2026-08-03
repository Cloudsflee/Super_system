import {
  QUALITY_REVIEW_RUBRIC_SCHEMA,
  parseQualityReviewRubric,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';

export const DEFAULT_QUALITY_REVIEW_RUBRIC = Object.freeze({
  schema_version: QUALITY_REVIEW_RUBRIC_SCHEMA,
  version: 1,
  enabled: true,
  mandatory: true,
  threshold: 80,
  dimensions: Object.freeze([
    {
      id: 'coverage',
      title: '目标与要求覆盖',
      weight: 25,
      enabled: true,
      instructions: '检查交付内容是否完整覆盖任务目标、验收要求和用户明确约束。'
    },
    {
      id: 'accuracy',
      title: '事实准确性与证据支撑',
      weight: 25,
      enabled: true,
      instructions: '检查事实、数字和结论是否有可追溯证据，区分事实、推断与未知。'
    },
    {
      id: 'depth',
      title: '分析深度、反证与边界',
      weight: 20,
      enabled: true,
      instructions: '检查分析是否呈现反证、替代解释、适用边界、风险和不确定性。'
    },
    {
      id: 'consistency',
      title: '内部一致性',
      weight: 15,
      enabled: true,
      instructions: '检查全文、表格、公式和结论之间没有矛盾，术语和口径保持一致。'
    },
    {
      id: 'clarity',
      title: '表达清晰度与可操作性',
      weight: 15,
      enabled: true,
      instructions: '检查结构、语言、可读性以及读者能否据此采取明确行动。'
    }
  ])
});

export function defaultQualityReviewRubric() {
  return parseQualityReviewRubric(JSON.parse(JSON.stringify(DEFAULT_QUALITY_REVIEW_RUBRIC)));
}

export function normalizeQualityReviewRubric(value, { allowDisabled = true } = {}) {
  const candidate = value && typeof value === 'object' ? value : defaultQualityReviewRubric();
  const rubric = parseQualityReviewRubric(candidate);
  if (!allowDisabled && !rubric.enabled) throw qualityRubricError('quality_review_mandatory');
  return rubric;
}

export function qualityReviewRubricHash(value) {
  return protocolHash(normalizeQualityReviewRubric(value));
}

export function validateQualityReviewRubricInput(value) {
  const rubric = normalizeQualityReviewRubric(value);
  const enabled = rubric.dimensions.filter((item) => item.enabled);
  if (!enabled.length) throw qualityRubricError('quality_review_dimension_required');
  return rubric;
}

export function qualityReviewPolicyForWorkflow(enabled, profileId = null) {
  const rubric = enabled ? defaultQualityReviewRubric() : null;
  return {
    quality_review_profile_id: enabled ? profileId : null,
    quality_review_policy: {
      enabled,
      mandatory: enabled,
      strategy: enabled ? 'v23_default' : 'legacy_opt_in',
      rubric,
      rubric_hash: rubric ? qualityReviewRubricHash(rubric) : null
    }
  };
}

export function qualityReviewProfileIdForState(state) {
  return state.codex_profiles.find((item) => item.quality_reviewer === true && item.status === 'validated')?.id || null;
}

export function applyQualityReviewPolicy(workflow, state, enabled) {
  Object.assign(
    workflow,
    qualityReviewPolicyForWorkflow(enabled, enabled ? qualityReviewProfileIdForState(state) : null)
  );
  return workflow;
}

export function pendingOutcomeSummary() {
  return { total: 0, pending: 0, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: 0 };
}

export function ensureQualityReviewPolicy(workflow) {
  const policy = workflow.quality_review_policy;
  if (policy?.enabled === true || (policy && policy.strategy !== 'legacy_opt_in')) return;
  Object.assign(workflow, qualityReviewPolicyForWorkflow(true));
}

export function workflowQualityReviewRubricHash(workflow) {
  return workflow.quality_review_rubric_hash || workflow.quality_review_policy?.rubric_hash || null;
}

function qualityRubricError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
