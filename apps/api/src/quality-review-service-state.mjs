import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { HttpError } from './http.mjs';
import { AIWS_RUNNER_IMAGE, id, now } from '../../../packages/shared/index.mjs';
import { protocolHash } from '../../../packages/execution-protocol/src/index.mjs';
import { qualityReviewInputHash, qualityReviewRunIsCurrent } from './quality-review-freshness.mjs';

export { qualityReviewInputHash };

export function qualityReviewRunInputIsCurrent(state, execution, run) {
  return qualityReviewRunIsCurrent(state, execution, run);
}

export function reviewerReadiness(state, workflow) {
  const profile = qualityReviewerProfile(state, workflow),
    checkedAt = now(),
    profileReady = Boolean(profile),
    checks = Object.fromEntries(
      ['profile', 'image', 'credential', 'probe', 'vision'].map((name) => [
        name,
        name === 'profile'
          ? {
              status: profileReady ? 'passed' : 'failed',
              ready: profileReady,
              code: profileReady ? null : 'reviewer_profile_unavailable',
              checked_at: checkedAt,
              details: {}
            }
          : {
              status: 'not_checked',
              ready: false,
              code: 'reviewer_check_not_run',
              checked_at: checkedAt,
              details: {}
            }
      ])
    );
  return {
    status: 'unavailable',
    ready: false,
    advice_available: false,
    checked_at: checkedAt,
    profile: profile ? reviewerProfileSnapshot(profile) : null,
    checks
  };
}

export function qualityReviewerProfile(state, workflow) {
  const preferred = workflow?.quality_review_profile_id;
  return (
    state.codex_profiles.find((item) => item.id === preferred && isQualityReviewerProfile(item)) ||
    state.codex_profiles.find((item) => isQualityReviewerProfile(item)) ||
    null
  );
}

export function reviewerProfileSnapshot(profile) {
  const runtime = reviewerProfileRuntimeIdentity(profile);
  return {
    id: profile.id,
    provider: profile.provider || null,
    model: profile.model || null,
    reasoning: profile.reasoning || 'high',
    kind: profile.kind || null,
    image: profile.image || null,
    wire_api: profile.wire_api || 'responses',
    timeout_ms: profile.timeout_ms || null,
    base_url: profile.base_url || null,
    requires_openai_auth: profile.requires_openai_auth === true,
    runtime_sha256: protocolHash(runtime)
  };
}

export function selectReviewerProfile(state, run) {
  const snapshot = run.reviewer_profile_snapshot;
  if (!snapshot?.id || !snapshot.runtime_sha256) return null;
  const profile = state.codex_profiles.find((item) => item.id === snapshot.id);
  if (!isQualityReviewerProfile(profile)) return null;
  return protocolHash(reviewerProfileRuntimeIdentity(profile)) === snapshot.runtime_sha256 ? profile : null;
}

function isQualityReviewerProfile(profile) {
  return Boolean(profile && reviewerRuntimeIsValid(profile) && reviewerIsolationIsValid(profile));
}

function reviewerRuntimeIsValid(profile) {
  return (
    profile.quality_reviewer === true &&
    profile.kind === 'docker' &&
    profile.status === 'validated' &&
    String(profile.model || '').trim() &&
    profile.image === AIWS_RUNNER_IMAGE &&
    profile.config?.reviewer === true &&
    profile.config?.image === AIWS_RUNNER_IMAGE
  );
}

function reviewerIsolationIsValid(profile) {
  return (
    profile.web_search !== true &&
    Array.isArray(profile.mcp_servers) &&
    profile.mcp_servers.length === 0 &&
    Array.isArray(profile.mounts) &&
    profile.mounts.length === 0
  );
}

function reviewerProfileRuntimeIdentity(profile) {
  return {
    id: profile.id,
    kind: nullable(profile.kind),
    provider: nullable(profile.provider),
    model: nullable(profile.model),
    reasoning: profile.reasoning ? profile.reasoning : 'high',
    wire_api: profile.wire_api ? profile.wire_api : 'responses',
    timeout_ms: nullable(profile.timeout_ms),
    base_url: nullable(profile.base_url),
    requires_openai_auth: profile.requires_openai_auth === true,
    image: nullable(profile.image),
    codex_home: nullable(profile.codex_home),
    config_file: nullable(profile.config_file),
    reviewer: profile.config?.reviewer === true,
    config_image: nullable(profile.config?.image),
    quality_reviewer: profile.quality_reviewer === true,
    web_search: profile.web_search === true,
    mcp_servers: arrayValue(profile.mcp_servers),
    mounts: arrayValue(profile.mounts)
  };
}

function nullable(value) {
  return value || null;
}

function arrayValue(value) {
  return value || [];
}

export function publicQualityReviewRun(state, run) {
  const report = state.quality_review_reports.find((item) => item.id === run.report_id) || null,
    review = state.human_reviews.find((item) => item.id === run.decision_id) || null,
    execution = state.workflow_executions.find((item) => item.id === run.workflow_execution_id),
    stale = run.stale === true || isRunInputStale(state, execution, run);
  return {
    ...structuredClone(run),
    rubric: structuredClone(run.rubric),
    report: report ? publicReport(report, run) : null,
    // Keep the stable decision value on the run. The full immutable audit record is exposed separately.
    decision: run.decision || null,
    decision_record: review ? { ...structuredClone(review), reviewer_id: review.reviewer_id } : null,
    stale
  };
}

function isRunInputStale(state, execution, run) {
  return Boolean(
    execution && Array.isArray(run.input_asset_version_ids) && !qualityReviewRunInputIsCurrent(state, execution, run)
  );
}

function publicReport(report, run) {
  return {
    id: report.id,
    report_sha256: run.report_sha256,
    input_snapshot_hash: report.input_snapshot_hash,
    rubric_hash: report.rubric_hash,
    deterministic_checks: report.deterministic_checks,
    assets: report.assets,
    advice: report.advice,
    limitations: report.limitations,
    generated_at: report.generated_at
  };
}

export function qualityReviewSnapshot(state, run) {
  const execution = state.workflow_executions.find((item) => item.id === run.workflow_execution_id),
    stale = run.stale === true || (execution ? !qualityReviewRunInputIsCurrent(state, execution, run) : true);
  return {
    run: { ...publicQualityReviewRun(state, run), stale },
    report: state.quality_review_reports.find((item) => item.id === run.report_id) || null,
    decision: state.human_reviews.find((item) => item.id === run.decision_id) || null,
    events: state.quality_review_events.filter((item) => item.run_id === run.id).sort((a, b) => a.sequence - b.sequence)
  };
}

export function appendQualityReviewEvent(state, run, type, data = {}) {
  const sequence =
    Math.max(
      0,
      ...state.quality_review_events.filter((item) => item.run_id === run.id).map((item) => Number(item.sequence) || 0)
    ) + 1;
  state.quality_review_events.push({
    id: id('qre'),
    run_id: run.id,
    project_id: run.project_id,
    sequence,
    type,
    data: sanitizeEvent(data),
    created_at: now()
  });
}

export function bumpQualityReviewRevision(run) {
  run.revision = Math.max(1, Number(run.revision) || 1) + 1;
}

export function requireQualityReview(state, runId) {
  const run = state.quality_review_runs.find((item) => item.id === runId);
  if (!run) throw new HttpError(404, { error: 'quality_review_not_found' });
  return run;
}

export function parsePossibleJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    const match = String(value).match(/\{[\s\S]*\}/);
    if (!match) throw new Error('quality_review_model_json_invalid');
    return JSON.parse(match[0]);
  }
}

export function sanitizeEvent(value) {
  return sanitizeEventValue(value, 0);
}

function sanitizeEventValue(value, depth) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeEventValue(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 2000) : value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/prompt|body|text|content|token|delta|raw|secret|password|credential|authorization|cookie/i.test(key)
      )
      .slice(0, 100)
      .map(([key, item]) => [key, sanitizeEventValue(item, depth + 1)])
  );
}

export function qualityReviewFailure(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  error.retryable = false;
  return error;
}

export function qualityReviewCancelledError() {
  const error = new Error('quality_review_cancelled');
  error.code = 'quality_review_cancelled';
  error.retryable = false;
  return error;
}

export function safeCode(value) {
  const candidate = String(value || 'quality_review_failed').slice(0, 200);
  return /^[a-z0-9_.-]+$/i.test(candidate) ? candidate : 'quality_review_failed';
}

export function clean(value, max = 2000) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
