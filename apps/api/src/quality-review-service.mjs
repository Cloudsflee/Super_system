import fs from 'node:fs/promises';

import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { HttpError } from './http.mjs';
import { mutate, readState } from './state.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { QUALITY_REVIEW_TEMP_DIR } from './config.mjs';
import {
  defaultQualityReviewRubric,
  normalizeQualityReviewRubric,
  qualityReviewRubricHash
} from './quality-review-rubric.mjs';
import { QUALITY_REVIEW_LIMITS } from './quality-review-parser.mjs';
import { qualityReviewPolicyForExecution } from './quality-review-freshness.mjs';
import { requireWorkflowExecution } from './workflow-execution-domain.mjs';
import { createQualityReviewRun, decideQualityReviewInState } from './quality-review-service-commands.mjs';
import { collectCandidateAssets, publicCandidateAsset } from './quality-review-service-assets.mjs';
import {
  appendQualityReviewEvent,
  bumpQualityReviewRevision,
  publicQualityReviewRun,
  qualityReviewFailure,
  qualityReviewRunInputIsCurrent,
  qualityReviewSnapshot,
  requireQualityReview,
  reviewerReadiness,
  safeCode
} from './quality-review-service-state.mjs';
import { executeQualityReviewRunLocked } from './quality-review-service-runner.mjs';
import { reviewerReadinessPreflight } from './quality-review-reviewer-readiness.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const locks = new Map();
const abortControllers = new Map();
let modelRunner = null;
let shutdownRequested = false;

export function setQualityReviewModelRunner(runner) {
  modelRunner = typeof runner === 'function' ? runner : null;
}

export async function prepareQualityReview(workflowExecutionId) {
  const state = await readState();
  const preparation = prepareQualityReviewInState(state, workflowExecutionId),
    execution = requireWorkflowExecution(state, workflowExecutionId),
    workflow = state.workflows.find((item) => item.id === execution.workflow_id);
  preparation.reviewer_readiness = await reviewerReadinessPreflight(state, workflow);
  return preparation;
}

export function prepareQualityReviewInState(state, workflowExecutionId) {
  const execution = requireWorkflowExecution(state, workflowExecutionId),
    workflow = state.workflows.find((item) => item.id === execution.workflow_id),
    effectivePolicy = qualityReviewPolicyForExecution(execution),
    policy = effectivePolicy?.enabled
      ? normalizeQualityReviewRubric(effectivePolicy.rubric)
      : { ...defaultQualityReviewRubric(), enabled: false, mandatory: false },
    candidates = collectCandidateAssets(state, execution),
    currentRun = latestVisibleRun(state, execution.id);
  return {
    workflow_execution_id: execution.id,
    enabled: Boolean(policy.enabled),
    mandatory: Boolean(policy.mandatory),
    default_rubric: structuredClone(policy),
    threshold: Number(policy.threshold),
    rubric_hash: qualityReviewRubricHash(policy),
    assets: candidates.in_scope.map(publicCandidateAsset),
    out_of_scope_assets: candidates.out_of_scope.map(publicCandidateAsset),
    default_included_asset_version_ids: candidates.in_scope.map((item) => item.asset_version_id),
    excluded_assets: [],
    reviewer_readiness: reviewerReadiness(state, workflow),
    current_run: currentRun ? publicQualityReviewRun(state, currentRun) : null,
    limits: QUALITY_REVIEW_LIMITS
  };
}

function latestVisibleRun(state, executionId) {
  const items = qualityReviewRunsForExecution(state, executionId);
  return activeQualityReviewRun(state, items) || currentQualityReviewRun(state, items) || items[0] || null;
}

export async function listQualityReviews(workflowExecutionId) {
  const state = await readState(),
    execution = requireWorkflowExecution(state, workflowExecutionId),
    items = qualityReviewRunsForExecution(state, execution.id),
    active = activeQualityReviewRun(state, items),
    current = currentQualityReviewRun(state, items),
    latest = items[0] || null;
  return {
    workflow_execution_id: execution.id,
    active: active ? publicQualityReviewRun(state, active) : null,
    current: current ? publicQualityReviewRun(state, current) : null,
    latest: latest ? publicQualityReviewRun(state, latest) : null,
    items: items.map((item) => publicQualityReviewRun(state, item))
  };
}

function qualityReviewRunsForExecution(state, executionId) {
  return state.quality_review_runs
    .filter((item) => item.workflow_execution_id === executionId)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
}

function activeQualityReviewRun(state, items) {
  return (
    items.find((item) => {
      const execution = state.workflow_executions.find((candidate) => candidate.id === item.workflow_execution_id);
      return (
        ACTIVE_STATUSES.has(item.status) &&
        item.stale !== true &&
        qualityReviewRunInputIsCurrent(state, execution, item)
      );
    }) || null
  );
}

function currentQualityReviewRun(state, items) {
  return (
    items.find((item) => {
      const execution = state.workflow_executions.find((candidate) => candidate.id === item.workflow_execution_id);
      return (
        item.status === 'completed' &&
        Boolean(item.decision_id) &&
        !item.superseded_by_run_id &&
        item.stale !== true &&
        qualityReviewRunInputIsCurrent(state, execution, item)
      );
    }) || null
  );
}

export async function getQualityReview(runId) {
  const state = await readState();
  return qualityReviewSnapshot(state, requireQualityReview(state, runId));
}

export async function getQualityReviewEvents(runId, after = 0) {
  const state = await readState(),
    run = requireQualityReview(state, runId),
    events = state.quality_review_events
      .filter((item) => item.run_id === run.id && Number(item.sequence) > Number(after || 0))
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  return {
    run: publicQualityReviewRun(state, run),
    events,
    terminal: TERMINAL_STATUSES.has(run.status),
    next_cursor: events.at(-1)?.sequence || Number(after || 0)
  };
}

export async function startQualityReview(workflowExecutionId, input = {}, actorId = null) {
  const result = await mutate((state) => {
    if (shutdownRequested) throw new HttpError(503, { error: 'quality_review_service_draining' });
    const execution = requireWorkflowExecution(state, workflowExecutionId),
      preparation = prepareQualityReviewInState(state, execution.id);
    if (!preparation.enabled) throw new HttpError(409, { error: 'quality_review_not_enabled' });
    return createQualityReviewRun(state, execution, preparation, input, actorId);
  });
  if (!result.idempotent) queueMicrotask(() => void executeQualityReviewRun(result.run.id));
  return {
    ...qualityReviewSnapshot(await readState(), result.run),
    idempotent: result.idempotent
  };
}

export async function cancelQualityReview(runId, actorId = null) {
  const result = await mutate((state) => {
    const run = requireQualityReview(state, runId);
    if (TERMINAL_STATUSES.has(run.status)) return { run, idempotent: true };
    const timestamp = now();
    Object.assign(run, {
      cancel_requested_at: timestamp,
      status: 'cancelled',
      phase: 'cancelled',
      error_code: 'quality_review_cancelled',
      retryable: false,
      completed_at: timestamp,
      updated_at: timestamp
    });
    bumpQualityReviewRevision(run);
    appendQualityReviewEvent(state, run, 'cancelled', { phase: 'cancelled', actor_id: actorId });
    return { run, idempotent: false };
  });
  abortControllers.get(runId)?.abort();
  return qualityReviewSnapshot(await readState(), result.run);
}

export async function decideQualityReview(runId, input = {}, actorId = null) {
  return mutate((state) => decideQualityReviewInState(state, runId, input, actorId));
}

export async function executeQualityReviewRun(runId) {
  const previous = locks.get(runId) || Promise.resolve(),
    current = previous
      .catch(() => undefined)
      .then(() =>
        executeQualityReviewRunLocked(runId, createQualityReviewAbortController(runId), {
          isShuttingDown: () => shutdownRequested,
          modelRunner,
          transition,
          fail: failQualityReview,
          snapshotForRun: qualityReviewSnapshotForRun
        })
      );
  locks.set(runId, current);
  return current.finally(() => {
    if (locks.get(runId) === current) locks.delete(runId);
    abortControllers.delete(runId);
  });
}

function createQualityReviewAbortController(runId) {
  const controller = new AbortController();
  abortControllers.set(runId, controller);
  return controller;
}

export async function shutdownQualityReviews() {
  shutdownRequested = true;
  await mutate((state) => {
    for (const run of state.quality_review_runs.filter((item) => ACTIVE_STATUSES.has(item.status))) {
      const error = qualityReviewFailure('service_draining');
      error.retryable = true;
      markQualityReviewRunFailedInState(run, error);
      appendQualityReviewEvent(state, run, 'failed', {
        phase: 'failed',
        error_code: run.error_code,
        retryable: run.retryable
      });
    }
  });
  for (const controller of abortControllers.values()) controller.abort();
  await Promise.allSettled([...locks.values()]);
  await fs.rm(QUALITY_REVIEW_TEMP_DIR, { recursive: true, force: true }).catch(() => undefined);
}

async function transition(runId, phase, data = {}) {
  return mutate((state) => {
    const run = requireQualityReview(state, runId);
    if (TERMINAL_STATUSES.has(run.status) || shutdownRequested) return run;
    Object.assign(run, { status: phase, phase, started_at: run.started_at || now(), updated_at: now(), ...data });
    bumpQualityReviewRevision(run);
    appendQualityReviewEvent(state, run, phase, { phase, ...data });
    return run;
  });
}

async function failQualityReview(runId, error) {
  await mutate((state) => {
    const run = requireQualityReview(state, runId);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    markQualityReviewRunFailedInState(run, error);
    appendQualityReviewEvent(state, run, 'failed', {
      phase: 'failed',
      error_code: run.error_code,
      retryable: run.retryable
    });
    return run;
  });
}

function markQualityReviewRunFailedInState(run, error) {
  const timestamp = now(),
    code = safeCode(error.code || 'quality_review_failed');
  Object.assign(run, {
    status: 'failed',
    phase: 'failed',
    error_code: code,
    failure: { code, details: error.details || {} },
    retryable: Boolean(error.retryable),
    completed_at: timestamp,
    updated_at: timestamp
  });
  bumpQualityReviewRevision(run);
}

async function qualityReviewSnapshotForRun(runId) {
  const state = await readState();
  return qualityReviewSnapshot(state, requireQualityReview(state, runId));
}
