import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { mutate, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import {
  QUALITY_REVIEW_REPORT_SCHEMA,
  parseQualityReviewReport,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';
import { normalizeQualityReviewRubric } from './quality-review-rubric.mjs';
import { parseQualityReviewAsset, QUALITY_REVIEW_LIMITS } from './quality-review-parser.mjs';
import {
  buildOutOfScopeLimitations,
  outcomeReadinessChecks,
  qualityReviewRubricChecks,
  sourceEvidenceChecks
} from './quality-review-service-checks.mjs';
import {
  candidateAssetsByVersion,
  collectCandidateAssets,
  outputBindingCheck,
  requiredOutputCoverageCheck
} from './quality-review-service-assets.mjs';
import {
  appendQualityReviewEvent,
  bumpQualityReviewRevision,
  qualityReviewFailure,
  qualityReviewSnapshot,
  qualityReviewRunInputIsCurrent,
  requireQualityReview
} from './quality-review-service-state.mjs';
import { buildQualityReviewAdvice, cleanupQualityReviewTemp } from './quality-review-service-model.mjs';
import { requireWorkflowExecution } from './workflow-execution-domain.mjs';

export async function executeQualityReviewRunLocked(runId, controller, dependencies) {
  let state = await readState(),
    run = requireQualityReview(state, runId);
  if (shouldStop(run, controller, dependencies)) return qualityReviewSnapshot(state, run);
  await dependencies.transition(runId, 'preparing', { phase: 'preparing' });
  state = await readState();
  run = requireQualityReview(state, runId);
  if (shouldStop(run, controller, dependencies)) return qualityReviewSnapshot(state, run);
  const execution = requireWorkflowExecution(state, run.workflow_execution_id);
  await dependencies.transition(runId, 'checking', { phase: 'checking' });
  state = await readState();
  run = requireQualityReview(state, runId);
  if (shouldStop(run, controller, dependencies)) return qualityReviewSnapshot(state, run);
  const prepared = await prepareReview(state, execution, run, controller, dependencies);
  if (!prepared) return dependencies.snapshotForRun(runId);
  state = await readState();
  run = requireQualityReview(state, runId);
  if (shouldStop(run, controller, dependencies)) return qualityReviewSnapshot(state, run);
  if (!qualityReviewRunInputIsCurrent(state, execution, run)) {
    const error = qualityReviewFailure('quality_review_input_stale');
    error.retryable = true;
    await dependencies.fail(runId, error);
    return dependencies.snapshotForRun(runId);
  }
  await dependencies.transition(runId, 'reviewing', { phase: 'reviewing' });
  state = await readState();
  run = requireQualityReview(state, runId);
  if (shouldStop(run, controller, dependencies)) return qualityReviewSnapshot(state, run);
  const report = await createReport(state, execution, run, prepared, controller, dependencies);
  if (!report) return dependencies.snapshotForRun(runId);
  await persistReport(runId, report, controller, dependencies);
  return dependencies.snapshotForRun(runId);
}

function shouldStop(run, controller, dependencies) {
  return !isActive(run) || controller.signal.aborted || dependencies.isShuttingDown();
}

function isActive(run) {
  return ['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human'].includes(run.status);
}

async function prepareReview(state, execution, run, controller, dependencies) {
  try {
    return await buildDeterministicReview(state, execution, run, controller);
  } catch (error) {
    if (controller.signal.aborted) return null;
    await dependencies.fail(run.id, error);
    return null;
  }
}

async function buildDeterministicReview(state, execution, run, controller) {
  const candidates = candidateAssetsByVersion(state, execution, run.asset_version_ids),
    checks = [],
    parsed = [];
  assertReviewableCandidates(candidates, run);
  checks.push(requiredOutputCoverageCheck(state, execution, candidates));
  throwBlockedCheck(checks.at(-1));
  const rubricChecks = qualityReviewRubricChecks(state, execution, run);
  checks.push(...rubricChecks);
  throwBlockedCheck(rubricChecks.find((item) => item.status === 'blocked'));
  await parseReviewCandidates(state, candidates, parsed, controller);
  if (controller.signal.aborted) return null;
  appendContentChecks(state, execution, candidates, parsed, checks);
  return { parsed, deterministicChecks: checks };
}

function assertReviewableCandidates(candidates, run) {
  if (!candidates.length)
    throw qualityReviewFailure('quality_review_no_reviewable_assets', {
      out_of_scope_asset_version_ids: run.out_of_scope_assets
    });
  if (candidates.length > QUALITY_REVIEW_LIMITS.max_assets)
    throw qualityReviewFailure('quality_review_asset_count_exceeded', {
      max_assets: QUALITY_REVIEW_LIMITS.max_assets
    });
}

function throwBlockedCheck(item) {
  if (item?.status === 'blocked') throw qualityReviewFailure(item.id, item.details);
}

async function parseReviewCandidates(state, candidates, parsed, controller) {
  let imageCount = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (controller.signal.aborted) return;
    const declaredSize = Number(candidate.version.size_bytes || 0);
    validateDeclaredSize(candidate, declaredSize);
    const parsedAsset = await parseQualityReviewAsset(state, candidate.asset, candidate.version, {
      signal: controller.signal,
      maxImageCount: Math.max(0, QUALITY_REVIEW_LIMITS.max_direct_images - imageCount)
    });
    if (parsedAsset.files.length && parsedAsset.files.every((item) => item.kind === 'out_of_scope'))
      throw qualityReviewFailure('quality_review_asset_out_of_scope', {
        asset_version_id: candidate.version.id
      });
    parsed.push(parsedAsset);
    imageCount += parsedAsset.image_count;
    totalBytes += parsedAsset.raw_size_bytes;
    if (totalBytes > QUALITY_REVIEW_LIMITS.max_total_bytes)
      throw qualityReviewFailure('quality_review_total_size_exceeded', {
        max_bytes: QUALITY_REVIEW_LIMITS.max_total_bytes
      });
    if (imageCount > QUALITY_REVIEW_LIMITS.max_direct_images)
      throw qualityReviewFailure('quality_review_image_count_exceeded', {
        max_images: QUALITY_REVIEW_LIMITS.max_direct_images
      });
  }
  validateParsedReviewLimits(parsed);
}

function validateDeclaredSize(candidate, declaredSize) {
  const entries = candidate.version.manifest?.entries || [];
  if (entries.length <= 1 && declaredSize > QUALITY_REVIEW_LIMITS.max_file_bytes)
    throw qualityReviewFailure('quality_review_file_size_exceeded', { asset_version_id: candidate.version.id });
  if (declaredSize > QUALITY_REVIEW_LIMITS.max_total_bytes)
    throw qualityReviewFailure('quality_review_total_size_exceeded', {
      max_bytes: QUALITY_REVIEW_LIMITS.max_total_bytes
    });
}

function validateParsedReviewLimits(parsed) {
  const normalizedChars = parsed.reduce((sum, item) => sum + item.normalized_text_length, 0),
    parsedImageCount = parsed.reduce((sum, item) => sum + item.image_count, 0);
  if (normalizedChars > QUALITY_REVIEW_LIMITS.max_normalized_text_chars)
    throw qualityReviewFailure('quality_review_normalized_text_exceeded', {
      max_chars: QUALITY_REVIEW_LIMITS.max_normalized_text_chars
    });
  if (parsedImageCount > QUALITY_REVIEW_LIMITS.max_direct_images)
    throw qualityReviewFailure('quality_review_image_count_exceeded', {
      max_images: QUALITY_REVIEW_LIMITS.max_direct_images
    });
}

function appendContentChecks(state, execution, candidates, parsed, checks) {
  checks.push(check('asset_integrity', 'passed', 'CAS、不可变性和 verification status 校验通过。'));
  checks.push(buildAssetScopeCheck(parsed, execution, state));
  const bindingCheck = outputBindingCheck(state, execution, candidates);
  checks.push(bindingCheck);
  throwBlockedCheck(bindingCheck);
  checks.push(...sourceEvidenceChecks(state, execution));
  checks.push(...outcomeReadinessChecks(state, execution));
}

function buildAssetScopeCheck(parsed, execution, state) {
  const outOfScope = parsed.flatMap((item) =>
    (item.out_of_scope || []).map((entry) => ({
      asset_version_id: item.asset_version_id,
      path: entry.path,
      reason: entry.reason || 'format_not_supported'
    }))
  );
  return check(
    'asset_scope',
    outOfScope.length ? 'warning' : 'passed',
    outOfScope.length ? '存在明确范围外资产，未计入内容质量结论。' : '所有纳入资产均在支持范围内。',
    { out_of_scope_count: outOfScope.length, assets: outOfScope.slice(0, 100) }
  );
}

async function createReport(state, execution, run, prepared, controller, dependencies) {
  try {
    const rubric = normalizeQualityReviewRubric(run.rubric),
      advice = await buildQualityReviewAdvice({
        state,
        run,
        execution,
        rubric,
        parsed: prepared.parsed,
        signal: controller.signal,
        modelRunner: dependencies.modelRunner
      }),
      report = parseQualityReviewReport(buildReportInput(run, execution, rubric, prepared, advice, state));
    return { report, reportSha256: protocolHash(report) };
  } catch (error) {
    await cleanupQualityReviewTemp(run.id);
    if (controller.signal.aborted || error?.code === 'quality_review_cancelled') return null;
    await dependencies.fail(run.id, error);
    return null;
  }
}

function buildReportInput(run, execution, rubric, prepared, advice, state) {
  return {
    schema_version: QUALITY_REVIEW_REPORT_SCHEMA,
    id: id('qrrp'),
    run_id: run.id,
    workflow_execution_id: execution.id,
    project_id: execution.project_id,
    input_snapshot_hash: run.input_snapshot_hash,
    rubric_hash: run.rubric_hash,
    deterministic_checks: prepared.deterministicChecks,
    assets: prepared.parsed.map(publicReportAsset),
    advice,
    limitations: buildReportLimitations(prepared.parsed, run, state, execution, advice),
    generated_at: now(),
    immutable: true
  };
}

function publicReportAsset(item) {
  return {
    asset_id: item.asset_id,
    asset_version_id: item.asset_version_id,
    title: item.title,
    media_type: item.media_type,
    size_bytes: item.size_bytes,
    content_sha256: item.content_sha256,
    normalized_text_sha256: item.normalized_text_sha256,
    normalized_text_length: item.normalized_text_length,
    image_count: item.image_count,
    anchors: item.anchors,
    status: 'included'
  };
}

function buildReportLimitations(parsed, run, state, execution, advice) {
  const outOfScopeCandidates = candidateAssetsByVersion(state, execution, run.out_of_scope_assets);
  return [
    ...parsed.flatMap((item) => item.limitations || []),
    ...parsed.flatMap((item) => (item.image_count ? ['图片已计入评审包；没有 OCR 文本层时只能依赖视觉能力。'] : [])),
    ...buildOutOfScopeLimitations(parsed, run, outOfScopeCandidates),
    ...(advice?.status === 'completed' ? [] : advice?.limitations || [])
  ].filter((item, index, values) => values.indexOf(item) === index);
}

async function persistReport(runId, result, controller, dependencies) {
  await mutate((data) => {
    const current = requireQualityReview(data, runId);
    if (shouldStop(current, controller, dependencies)) return current;
    const execution = requireWorkflowExecution(data, current.workflow_execution_id);
    if (!qualityReviewRunInputIsCurrent(data, execution, current)) return markStale(data, current);
    data.quality_review_reports.push({ ...structuredClone(result.report), report_sha256: result.reportSha256 });
    Object.assign(current, {
      status: 'awaiting_human',
      phase: 'awaiting_human',
      report_id: result.report.id,
      report_sha256: result.reportSha256,
      started_at: current.started_at || now(),
      updated_at: now()
    });
    bumpQualityReviewRevision(current);
    appendQualityReviewEvent(data, current, 'awaiting_human', {
      phase: 'awaiting_human',
      report_sha256: result.reportSha256
    });
    return current;
  });
}

function markStale(state, run) {
  const error = qualityReviewFailure('quality_review_input_stale');
  error.retryable = true;
  Object.assign(run, {
    status: 'failed',
    phase: 'failed',
    error_code: error.code,
    failure: { code: error.code, details: {} },
    retryable: true,
    completed_at: now(),
    updated_at: now()
  });
  bumpQualityReviewRevision(run);
  appendQualityReviewEvent(state, run, 'failed', { phase: 'failed', error_code: run.error_code, retryable: true });
  return run;
}

function check(idValue, status, message, details = {}) {
  return { id: idValue, status, message, details };
}
