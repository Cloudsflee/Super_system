import assert from 'node:assert/strict';
import fs from 'node:fs';

import { defaultQualityReviewRubric, qualityReviewRubricHash } from '../../apps/api/src/quality-review-rubric.mjs';
import { qualityReviewInputHash } from '../../apps/api/src/quality-review-freshness.mjs';
import {
  assertQualityReviewAppendOnly,
  assertQualityReviewHumanReviewAppendOnly,
  assertQualityReviewRunSnapshotImmutability,
  markQualityReviewRunsStale
} from '../../apps/api/src/state-migration-v23-quality.mjs';
import { normalizeState23Defaults, validateState23 } from '../../apps/api/src/state-migration-v23.mjs';
import {
  latestQualityReviewDecisions,
  qualityReviewHumanScoreEvaluation
} from '../../apps/api/src/outcome-quality-review.mjs';
import { updateQualityReviewPolicyInState } from '../../apps/api/src/quality-review-policy-service.mjs';

const stateRuntimeSource = fs.readFileSync('apps/api/src/state-runtime-v23.mjs', 'utf8'),
  legacyReaderWorkerSource = fs.readFileSync('apps/api/src/state-legacy-sqlite-reader-worker.mjs', 'utf8');
assert.equal(stateRuntimeSource.includes('node:sqlite'), false);
assert.match(stateRuntimeSource, /new Worker\(new URL\('\.\/state-legacy-sqlite-reader-worker\.mjs'/);
assert.match(legacyReaderWorkerSource, /from 'node:sqlite'/);
assert.match(legacyReaderWorkerSource, /immutable=1/);
assert.match(legacyReaderWorkerSource, /readOnly:\s*true/);
assert.match(legacyReaderWorkerSource, /database\.close\(\)/);
assert.match(legacyReaderWorkerSource, /parentPort\.close\(\)/);

const timestamp = '2026-08-01T00:00:00.000Z',
  rubric = defaultQualityReviewRubric(),
  rubricHash = qualityReviewRubricHash(rubric),
  state = fixtureState();

const normalized = normalizeState23Defaults(schemaFixture(), timestamp);
assert.doesNotThrow(() => validateState23(normalized));
const roundTrip = JSON.parse(JSON.stringify(normalized));
assert.deepEqual(roundTrip, normalized);
assert.doesNotThrow(() => validateState23(roundTrip));

const appendBefore = {
    quality_review_reports: [{ id: 'report-1', immutable: true, value: 1 }],
    quality_review_events: [{ id: 'event-1', run_id: 'run-1', sequence: 1, data: { phase: 'queued' } }],
    human_reviews: [{ id: 'review-1', target_type: 'quality_review_run', immutable: true, score: 80 }]
  },
  appendAfter = structuredClone(appendBefore);
appendAfter.quality_review_reports.push({ id: 'report-2', immutable: true, value: 2 });
appendAfter.quality_review_events.push({ id: 'event-2', run_id: 'run-1', sequence: 2, data: { phase: 'checking' } });
appendAfter.human_reviews.push({ id: 'review-2', target_type: 'quality_review_run', immutable: true, score: 90 });
assert.doesNotThrow(() => assertQualityReviewAppendOnly(appendBefore, appendAfter));
assert.doesNotThrow(() => assertQualityReviewHumanReviewAppendOnly(appendBefore, appendAfter));
const changedReport = structuredClone(appendAfter);
changedReport.quality_review_reports[0].value = 3;
assert.throws(() => assertQualityReviewAppendOnly(appendBefore, changedReport), /immutable_record_changed/);
const changedReview = structuredClone(appendAfter);
changedReview.human_reviews[0].score = 10;
assert.throws(() => assertQualityReviewHumanReviewAppendOnly(appendBefore, changedReview), /immutable_record_changed/);

const immutableBefore = { quality_review_runs: [state.quality_review_runs[0]] },
  immutableAfter = structuredClone(immutableBefore);
immutableAfter.quality_review_runs[0].status = 'completed';
assert.doesNotThrow(() => assertQualityReviewRunSnapshotImmutability(immutableBefore, immutableAfter));
immutableAfter.quality_review_runs[0].operation_key = 'changed';
assert.throws(() => assertQualityReviewRunSnapshotImmutability(immutableBefore, immutableAfter), /snapshot_changed/);

const hashA = qualityReviewInputHash(state.workflow_executions[0], ['asset-version-1'], rubric, []),
  hashB = qualityReviewInputHash(state.workflow_executions[0], ['asset-version-1'], rubric, [
    { asset_version_id: 'asset-version-2', reason: 'excluded' }
  ]);
assert.match(hashA, /^[a-f0-9]{64}$/);
assert.notEqual(hashA, hashB);
assert.equal(hashA, state.quality_review_runs[0].input_snapshot_hash);

const futurePolicyState = fixtureState(),
  futureRubric = structuredClone(rubric);
futureRubric.dimensions[0].instructions = '仅作用于未来执行的新说明。';
futurePolicyState.workflows[0].quality_review_policy.rubric = futureRubric;
futurePolicyState.workflows[0].quality_review_policy.rubric_hash = qualityReviewRubricHash(futureRubric);
futurePolicyState.workflows[0].workflow_revision = 2;
futurePolicyState.workflows[0].version = 2;
assert.equal(markQualityReviewRunsStale(futurePolicyState, '2026-08-01T00:00:30.000Z').changed, false);
assert.equal(futurePolicyState.quality_review_runs[0].stale, false);

const staleState = structuredClone(state);
staleState.quality_review_runs.push({
  ...structuredClone(staleState.quality_review_runs[0]),
  id: 'run-completed',
  operation_key: 'completed',
  status: 'completed',
  phase: 'completed',
  decision_id: 'review-completed',
  decision: 'changes_required',
  score: 40,
  completed_at: timestamp
});
staleState.workflow_executions[0].input_hash = 'b'.repeat(64);
assert.equal(markQualityReviewRunsStale(staleState, '2026-08-01T00:01:00.000Z').changed, true);
const staleActive = staleState.quality_review_runs.find((item) => item.id === 'run-active'),
  staleCompleted = staleState.quality_review_runs.find((item) => item.id === 'run-completed');
assert.equal(staleActive.status, 'failed');
assert.equal(staleActive.retryable, true);
assert.equal(staleActive.error_code, 'quality_review_input_stale');
assert.equal(staleCompleted.status, 'completed');
assert.equal(staleCompleted.stale, true);
assert.equal(staleState.quality_review_events.at(-1).type, 'failed');

const policyState = fixtureState();
assert.throws(
  () =>
    updateQualityReviewPolicyInState(policyState, 'workflow-1', {
      expected_revision: 2,
      enabled: true,
      rubric
    }),
  (error) => error.status === 409 && error.payload?.error === 'quality_review_policy_revision_conflict'
);
policyState.workflow_executions[0].status = 'running';
assert.throws(
  () =>
    updateQualityReviewPolicyInState(policyState, 'workflow-1', {
      expected_revision: 1,
      enabled: true,
      rubric
    }),
  (error) => error.status === 409 && error.payload?.error === 'quality_review_policy_execution_active'
);
policyState.workflow_executions[0].status = 'completed';
policyState.workflow_executions[0].quality_review_rubric_hash = null;
policyState.workflow_executions[0].quality_review_policy_snapshot = {
  enabled: false,
  mandatory: false,
  strategy: 'legacy_opt_in',
  rubric: null,
  rubric_hash: null
};
const policyResult = updateQualityReviewPolicyInState(
  policyState,
  'workflow-1',
  { expected_revision: 1, enabled: true, rubric },
  'owner-1'
);
assert.equal(policyResult.revision, 2);
assert.equal(policyResult.quality_review_policy.mandatory, true);
assert.equal(policyResult.quality_review_policy.rubric.threshold, 80);
assert.equal(policyState.workflow_executions[0].quality_review_policy_snapshot.enabled, false);

const outcomeState = fixtureState(),
  completedRun = outcomeState.quality_review_runs[0];
Object.assign(completedRun, {
  status: 'completed',
  phase: 'completed',
  report_id: 'report-1',
  report_sha256: 'c'.repeat(64),
  decision_id: 'quality-review-human',
  decision: 'changes_required',
  score: 40,
  completed_at: timestamp
});
outcomeState.human_reviews = [
  { id: 'assist-score', target_type: 'assist_turn', workflow_execution_id: 'execution-1', score: 100 },
  { id: 'terminal-score', target_type: 'terminal_session', workflow_execution_id: 'execution-1', score: 100 },
  qualityHumanReview(completedRun, 40, 'changes_required')
];
const requirement = {
  evaluator: 'human_score',
  expected: { min: 80 },
  evaluator_config: { quality_review: true }
};
assert.deepEqual(
  latestQualityReviewDecisions(outcomeState, outcomeState.workflow_executions[0], requirement).map((x) => x.id),
  ['quality-review-human']
);
assert.equal(
  qualityReviewHumanScoreEvaluation(outcomeState, outcomeState.workflow_executions[0], requirement).status,
  'unsatisfied'
);

console.log('V2.3 state round-trip, append-only, revision, stale, policy, and Outcome isolation tests passed');

function fixtureState() {
  const execution = {
      id: 'execution-1',
      workflow_id: 'workflow-1',
      project_id: 'project-1',
      workflow_revision: 1,
      input_hash: 'a'.repeat(64),
      status: 'completed',
      quality_review_rubric_hash: rubricHash,
      quality_review_policy_snapshot: {
        enabled: true,
        mandatory: true,
        strategy: 'v23_default',
        rubric,
        rubric_hash: rubricHash
      }
    },
    run = {
      id: 'run-active',
      workflow_execution_id: execution.id,
      project_id: execution.project_id,
      operation_key: 'operation-1',
      status: 'awaiting_human',
      phase: 'awaiting_human',
      revision: 1,
      input_asset_version_ids: ['asset-version-1'],
      asset_version_ids: ['asset-version-1'],
      excluded_assets: [],
      out_of_scope_assets: [],
      rubric,
      rubric_hash: rubricHash,
      workflow_policy_rubric_hash: rubricHash,
      threshold: 80,
      reviewer_profile_snapshot: null,
      report_id: null,
      report_sha256: null,
      decision_id: null,
      decision: null,
      score: null,
      failure: null,
      error_code: null,
      retryable: false,
      stale: false,
      superseded_by_run_id: null,
      cancel_requested_at: null,
      created_by_user_id: 'owner-1',
      created_at: timestamp,
      started_at: timestamp,
      completed_at: null,
      updated_at: timestamp
    };
  run.input_snapshot_hash = qualityReviewInputHash(execution, run.input_asset_version_ids, rubric, []);
  return {
    schema_version: 23,
    users: [],
    workflows: [
      {
        id: 'workflow-1',
        project_id: 'project-1',
        version: 1,
        workflow_revision: 1,
        quality_review_policy: {
          enabled: true,
          mandatory: true,
          strategy: 'v23_default',
          rubric,
          rubric_hash: rubricHash
        }
      }
    ],
    workflow_nodes: [],
    workflow_executions: [execution],
    task_executions: [
      {
        id: 'task-execution-1',
        task_id: 'task-1',
        workflow_execution_id: execution.id,
        status: 'completed',
        attempt: 1,
        created_at: timestamp,
        updated_at: timestamp
      }
    ],
    assets: [
      {
        id: 'asset-1',
        task_execution_id: 'task-execution-1',
        current_version_id: 'asset-version-1'
      }
    ],
    asset_versions: [{ id: 'asset-version-1', asset_id: 'asset-1' }],
    quality_review_runs: [run],
    quality_review_reports: [],
    quality_review_events: [],
    human_reviews: [],
    outcome_requirements: [],
    outcome_evaluations: [],
    outcome_waivers: [],
    traces: [],
    codex_profiles: [],
    integration_statuses: []
  };
}

function schemaFixture() {
  return {
    schema_version: 23,
    workflows: [
      {
        id: 'schema-workflow',
        quality_review_policy: { enabled: true, mandatory: true, rubric, rubric_hash: rubricHash }
      }
    ],
    workflow_executions: [
      {
        id: 'schema-execution',
        workflow_id: 'schema-workflow',
        project_id: 'schema-project',
        workflow_revision: 1,
        status: 'completed'
      }
    ],
    task_executions: [],
    assets: [],
    asset_versions: [],
    codex_profiles: [],
    quality_review_runs: [],
    quality_review_reports: [],
    quality_review_events: []
  };
}

function qualityHumanReview(run, score, decision) {
  return {
    id: 'quality-review-human',
    target_type: 'quality_review_run',
    target_id: run.id,
    workflow_execution_id: run.workflow_execution_id,
    project_id: run.project_id,
    report_id: run.report_id,
    report_sha256: run.report_sha256,
    input_snapshot_hash: run.input_snapshot_hash,
    rubric_hash: run.rubric_hash,
    dimension_scores: rubric.dimensions.map((item) => ({
      criterion_id: item.id,
      score,
      reason: '人工独立核验'
    })),
    score,
    decision,
    immutable: true,
    created_at: timestamp
  };
}
