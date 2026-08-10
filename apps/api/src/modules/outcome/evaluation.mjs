import { assert } from '../../errors.mjs';

export function prepareOutcomeEvaluations(requirements, input, availableEvidenceIds) {
  const requested = Array.isArray(input?.evaluations) ? input.evaluations : [];
  const availableEvidence = new Set(availableEvidenceIds);
  assert(requested.length === requirements.length, 'outcome_evidence_required', 'every outcome requirement requires a scored evidence evaluation', { status: 422 });
  return requirements.map((requirement) => {
    const evaluation = requested.find((item) => item?.requirement_id === requirement.id);
    const score = Number(evaluation?.score);
    const evidence = [...new Set((Array.isArray(evaluation?.evidence_asset_ids) ? evaluation.evidence_asset_ids : []).map(String))];
    assert(evaluation && Number.isFinite(score) && score >= 0 && score <= 100, 'invalid_input', `outcome score is invalid for ${requirement.requirement_key}`, { status: 422 });
    assert(evidence.length > 0 && evidence.every((assetId) => availableEvidence.has(assetId)), 'outcome_evidence_required', `verified execution evidence is required for ${requirement.requirement_key}`, { status: 422 });
    const threshold = Number(requirement.rubric?.min_score ?? 80);
    return { requirement, score, evidence, status: score >= threshold ? 'passed' : 'failed' };
  });
}
