import fs from 'node:fs/promises';
import path from 'node:path';

import { cloneStateValue as structuredClone } from './state-clone.mjs';
import {
  QUALITY_REVIEW_ADVICE_JSON_SCHEMA,
  QUALITY_REVIEW_ADVICE_SCHEMA,
  parseQualityReviewAdvice,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';
import { QUALITY_REVIEW_TEMP_DIR } from './config.mjs';
import { QUALITY_REVIEW_LIMITS } from './quality-review-parser.mjs';
import {
  parsePossibleJson,
  qualityReviewCancelledError,
  selectReviewerProfile
} from './quality-review-service-state.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { reviewerReadinessForRun } from './quality-review-reviewer-readiness.mjs';

export async function buildQualityReviewAdvice({
  state,
  run,
  execution,
  rubric,
  parsed,
  signal = null,
  modelRunner = null
}) {
  const fallback = (status = 'unavailable', reason = 'reviewer_advice_unavailable') =>
    buildFallbackAdvice(run, rubric, status, reason);
  if (modelRunner) return runInjectedAdvice(modelRunner, fallback, { state, run, execution, rubric, parsed, signal });
  const profile = selectReviewerProfile(state, run);
  if (!profile) return fallback('unavailable', 'reviewer_profile_unavailable');
  const readiness = await reviewerReadinessForRun(state, run);
  if (!readiness.ready) return fallback('unavailable', readinessFailureCode(readiness));
  return runLiveAdvice({ state, run, execution, rubric, parsed, profile, signal, fallback });
}

function buildFallbackAdvice(run, rubric, status = 'unavailable', reason = 'reviewer_advice_unavailable') {
  const limitation = adviceFailureLimitation(status, reason);
  return {
    schema_version: QUALITY_REVIEW_ADVICE_SCHEMA,
    reviewer: {
      profile_id: run.reviewer_profile_snapshot?.id || null,
      provider: run.reviewer_profile_snapshot?.provider || null,
      model: run.reviewer_profile_snapshot?.model || null,
      attempt: 1
    },
    status,
    dimensions: rubric.dimensions
      .filter((item) => item.enabled)
      .map((dimension) => ({
        criterion_id: dimension.id,
        recommendation: null,
        rationale:
          status === 'invalid' ? '模型建议无效；该字段不会预填人工评分。' : '模型建议不可用；该字段不会预填人工评分。',
        evidence_anchors: [],
        limitations: ['需要人工独立判断。', limitation]
      })),
    limitations: [limitation, '模型建议仅供参考，不能直接修改 Outcome、创建 waiver 或代替人工裁决。'],
    generated_at: now()
  };
}

async function runInjectedAdvice(modelRunner, fallback, input) {
  let raw;
  try {
    raw = await retryTransient(
      () => modelRunner({ ...input, run: structuredClone(input.run) }),
      isTransientModelError,
      2,
      input.signal
    );
  } catch (error) {
    return fallback('unavailable', modelFailureCode(error));
  }
  try {
    return parseAndValidateAdvice(raw, input.rubric, input.parsed, input.run.reviewer_profile_snapshot);
  } catch (error) {
    return fallback('invalid', invalidAdviceCode(error));
  }
}

async function runLiveAdvice({ state, run, execution, rubric, parsed, profile, signal, fallback }) {
  const tempDir = path.join(QUALITY_REVIEW_TEMP_DIR, run.id);
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  try {
    const imagePaths = await materializeReviewerImages(tempDir, parsed),
      packagePath = path.join(tempDir, 'review-package.json'),
      reviewerPackage = buildReviewerPackage(run, execution, rubric, parsed),
      prompt = buildReviewerPrompt(run, execution, rubric, parsed, imagePaths, path.basename(packagePath)),
      schemaPath = path.join(tempDir, 'advice.schema.json');
    await writeReviewerInputs(packagePath, schemaPath, reviewerPackage);
    let result;
    try {
      result = await retryTransient(
        () => runReviewerModel({ state, profile, prompt, tempDir, imagePaths, schemaPath, signal }),
        isTransientModelError,
        2,
        signal
      );
    } catch (error) {
      return fallback('unavailable', modelFailureCode(error));
    }
    try {
      return parseAndValidateAdvice(
        parseQualityReviewModelOutput(result),
        rubric,
        parsed,
        run.reviewer_profile_snapshot
      );
    } catch (error) {
      return fallback('invalid', invalidAdviceCode(error));
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function parseQualityReviewModelOutput(result) {
  const eventMessages = String(result?.stdout || '')
      .split(/\r?\n/)
      .map(parseModelEvent)
      .map(extractMessage)
      .filter(Boolean)
      .reverse(),
    candidates = [result?.last_message, ...eventMessages, result?.stdout].filter(Boolean);
  for (const candidate of candidates)
    try {
      return parsePossibleJson(candidate);
    } catch {
      continue;
    }
  throw new Error('quality_review_model_json_invalid');
}

function parseModelEvent(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function writeReviewerInputs(packagePath, schemaPath, reviewerPackage) {
  await fs.writeFile(packagePath, JSON.stringify(reviewerPackage), { mode: 0o400 });
  await fs.chmod(packagePath, 0o400).catch(() => undefined);
  await fs.writeFile(schemaPath, JSON.stringify(QUALITY_REVIEW_ADVICE_JSON_SCHEMA, null, 2), { mode: 0o600 });
}

async function runReviewerModel({ state, profile, prompt, tempDir, imagePaths, schemaPath, signal }) {
  const response = await runCodexJson({
    state,
    profile,
    prompt,
    cwd: tempDir,
    sandbox: 'read-only',
    runtimeKind: 'quality-review',
    projectId: null,
    reviewer: true,
    ephemeral: true,
    disableMcp: true,
    disableRules: true,
    outputSchema: schemaPath,
    images: imagePaths,
    signal
  });
  if (response.ok) return response;
  const error = new Error('quality_review_model_unavailable');
  error.code = response.timed_out ? 'quality_review_model_timeout' : 'quality_review_model_failed';
  error.retryable = isTransientModelResult(response);
  throw error;
}

export async function cleanupQualityReviewTemp(runId) {
  await fs.rm(path.join(QUALITY_REVIEW_TEMP_DIR, runId), { recursive: true, force: true }).catch(() => undefined);
}

async function retryTransient(operation, isTransient, maxAttempts = 2, signal = null) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw qualityReviewCancelledError();
    try {
      return await runAbortable(operation, attempt, signal);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransient(error)) throw error;
      await abortableDelay(25 * attempt, signal);
    }
  }
  throw lastError;
}

function runAbortable(operation, attempt, signal) {
  const work = Promise.resolve().then(() => operation(attempt));
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(qualityReviewCancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, qualityReviewCancelledError());
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function abortableDelay(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(qualityReviewCancelledError());
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function isTransientModelError(error) {
  if (error?.retryable === true) return true;
  return /timeout|temporar|unavailable|econn|reset|worker|service_draining/i.test(
    `${error?.code || ''} ${error?.message || ''}`
  );
}

function isTransientModelResult(result) {
  return Boolean(
    result?.timed_out ||
    /timeout|temporar|unavailable|econn|reset|worker|overloaded|rate.?limit/i.test(
      `${result?.code || ''} ${result?.stderr || ''}`
    )
  );
}

function parseAndValidateAdvice(raw, rubric, parsed, reviewerSnapshot = null) {
  const advice = parseQualityReviewAdvice(raw),
    expectedIds = rubric.dimensions.filter((item) => item.enabled).map((item) => item.id),
    ids = new Set(expectedIds),
    anchors = new Map(parsed.flatMap((item) => item.anchors.map((anchor) => [anchor.anchor_id, anchor])));
  if (advice.dimensions.length !== expectedIds.length || advice.dimensions.some((item) => !ids.has(item.criterion_id)))
    throw new Error('quality_review_unknown_criterion');
  validateCriterionIds(advice.dimensions, expectedIds);
  validateEvidenceAnchors(advice.dimensions, anchors);
  advice.reviewer = {
    profile_id: reviewerSnapshot?.id || null,
    provider: reviewerSnapshot?.provider || null,
    model: reviewerSnapshot?.model || null,
    attempt: advice.reviewer.attempt
  };
  if (advice.status !== 'completed') for (const dimension of advice.dimensions) dimension.recommendation = null;
  return advice;
}

function readinessFailureCode(readiness) {
  const failed = Object.entries(readiness?.checks || {}).find(([, item]) => item?.ready !== true);
  return failed?.[1]?.code || `reviewer_${failed?.[0] || 'preflight'}_unavailable`;
}

function invalidAdviceCode(error) {
  const value = String(error?.code || error?.message || 'quality_review_model_output_invalid');
  if (/json|protocol_invalid/i.test(value)) return 'quality_review_model_json_invalid';
  if (/criterion/i.test(value)) return 'quality_review_model_criterion_invalid';
  if (/anchor/i.test(value)) return 'quality_review_model_anchor_invalid';
  return 'quality_review_model_output_invalid';
}

function modelFailureCode(error) {
  const value = String(error?.code || error?.message || 'quality_review_model_unavailable');
  if (/timeout/i.test(value)) return 'quality_review_model_timeout';
  if (/cancel/i.test(value)) return 'quality_review_cancelled';
  return 'quality_review_model_unavailable';
}

function adviceFailureLimitation(status, reason) {
  const code = String(reason || 'reviewer_advice_unavailable')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 160);
  return `${status === 'invalid' ? 'Advice invalid' : 'Advice unavailable'}: ${code || 'reviewer_advice_unavailable'}.`;
}

function validateCriterionIds(dimensions, expectedIds) {
  const seen = new Set();
  for (const dimension of dimensions) {
    if (seen.has(dimension.criterion_id)) throw new Error('quality_review_duplicate_criterion');
    seen.add(dimension.criterion_id);
  }
  if (seen.size !== expectedIds.length) throw new Error('quality_review_criterion_incomplete');
}

function validateEvidenceAnchors(dimensions, anchors) {
  for (const dimension of dimensions)
    for (const anchor of dimension.evidence_anchors) {
      const expected = anchors.get(anchor.anchor_id);
      if (!expected || protocolHash(expected) !== protocolHash(anchor))
        throw new Error('quality_review_invalid_evidence_anchor');
    }
}

async function materializeReviewerImages(tempDir, parsed) {
  const paths = [];
  for (const [index, image] of parsed.flatMap((item) => item.review_images || []).entries()) {
    const extension = path.extname(String(image.path || '')).toLowerCase(),
      suffix = /^\.(?:png|jpe?g|webp|gif)$/.test(extension) ? extension : '.bin',
      target = path.join(tempDir, `image-${index + 1}${suffix}`);
    await fs.writeFile(target, image.bytes, { mode: 0o400 });
    paths.push(target);
  }
  return paths;
}

function buildReviewerPackage(run, execution, rubric, parsed) {
  return {
    workflow_execution_id: execution.id,
    rubric,
    assets: parsed.map((item) => ({
      asset_version_id: item.asset_version_id,
      title: item.title,
      normalized_text: item.normalized_text.slice(0, QUALITY_REVIEW_LIMITS.max_normalized_text_chars),
      anchors: item.anchors
    })),
    input_snapshot_hash: run.input_snapshot_hash
  };
}

function buildReviewerPrompt(run, execution, rubric, parsed, imagePaths = [], packageName = null) {
  return JSON.stringify({
    role: '独立内容质量建议者',
    rules: [
      '只输出符合 aiws.quality_review_advice.v1 的 JSON。',
      '模型建议不能代替人工评分，不能修改 Outcome 或创建 waiver。',
      '只使用给定的资产摘要和 evidence anchor，不得访问项目仓库、Web Search 或 MCP。',
      packageName
        ? `读取只读评审包 ${packageName} 中的完整结构化输入；不要尝试访问其父目录之外的任何文件。`
        : '使用本提示中的资产摘要作为唯一输入。'
    ],
    visual_inputs: imagePaths.map((item) => path.basename(item)),
    review_package: packageName,
    workflow_execution_id: execution.id,
    rubric,
    assets: packageName
      ? undefined
      : parsed.map((item) => ({
          asset_version_id: item.asset_version_id,
          title: item.title,
          normalized_text: item.normalized_text.slice(0, QUALITY_REVIEW_LIMITS.max_normalized_text_chars),
          anchors: item.anchors
        })),
    input_snapshot_hash: run.input_snapshot_hash
  });
}
