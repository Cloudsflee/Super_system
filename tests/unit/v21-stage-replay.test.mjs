import assert from 'node:assert/strict';

import { emptyState } from '../../apps/api/src/state.mjs';
import {
  assertStageReplayableInState,
  beginExecutionStageInState,
  beginStageReplayInState,
  completeExecutionStageInState,
  failExecutionStageInState,
  stageSnapshot
} from '../../apps/api/src/execution-stage-service.mjs';
import { assertV21AppendOnly } from '../../apps/api/src/state-migration-v21.mjs';
import { runnerPreflightInState } from '../../apps/api/src/runner-preflight.mjs';

const state = fixture();
for (const stage of ['preflight', 'execute', 'collect']) {
  const token = beginExecutionStageInState(state, {
    workflowExecutionId: 'wex',
    taskExecutionId: 'tex',
    stage,
    input: { stage }
  });
  completeExecutionStageInState(state, token, { output: { passed: true } });
}
const verify = beginExecutionStageInState(state, {
  workflowExecutionId: 'wex',
  taskExecutionId: 'tex',
  stage: 'verify',
  input: { result_hash: 'fixture' }
});
const failed = failExecutionStageInState(
  state,
  verify,
  Object.assign(new Error('verifier failed'), { code: 'verifier_injected_failure' }),
  { category: 'verifier', details: { proxy_password: 'SHOULD_NOT_LEAK' } }
);
assert.equal(failed.failure.code, 'verifier_injected_failure');
assert.equal(failed.failure.details.proxy_password, '[REDACTED]');
assert.deepEqual(
  stageSnapshot(state, 'tex').stages.map((item) => item.stage),
  ['preflight', 'execute', 'collect', 'verify']
);

const immutableBefore = snapshotImmutable(state);
const replay = beginStageReplayInState(state, 'tex', 'verify');
const replayed = completeExecutionStageInState(state, replay.token, { output: { verified: true } });
assert.equal(replayed.replay_of_checkpoint_id, failed.id);
assert.equal(replayed.stage, 'verify');
assert.equal(state.task_executions[0].replay_count, 1);
assertV21AppendOnly(immutableBefore, state);

state.context_packs[0].content_json = { changed: true };
assert.throws(
  () => assertStageReplayableInState(state, 'tex', 'verify'),
  (error) =>
    error.payload?.error === 'execution_stage_replay_identity_changed' &&
    error.payload?.changed_fields.includes('cas_hash')
);

const preflight = runnerPreflightInState(state, {
  taskExecution: state.task_executions[0],
  node: state.workflow_nodes[0],
  contract: state.node_contracts[0],
  testAdapter: true,
  env: {
    AIWS_CODEX_DOCKER_IMAGE: 'aiws-codex-runner:2.1.0-codex-0.144.0',
    HTTPS_PROXY: 'http://proxy.fixture',
    https_proxy: 'http://proxy.fixture'
  }
});
assert.equal(preflight.passed, true);
assert.equal(JSON.stringify(preflight).includes('proxy.fixture'), false);

assert.throws(
  () =>
    runnerPreflightInState(state, {
      taskExecution: state.task_executions[0],
      node: state.workflow_nodes[0],
      contract: state.node_contracts[0],
      testAdapter: true,
      env: { HTTPS_PROXY: 'http://upper.fixture', https_proxy: 'http://lower.fixture' }
    }),
  (error) => error.payload?.error === 'runner_preflight_failed' && error.payload?.failed_checks.includes('proxy_case')
);

console.log('V2.1 checkpoint order, sanitized preflight, failure envelope and replay identity tests passed');

function fixture() {
  const value = emptyState();
  value.schema_version = 21;
  value.workflow_executions.push({
    id: 'wex',
    project_id: 'project',
    workflow_id: 'workflow',
    status: 'running',
    input_hash: '1'.repeat(64),
    outcome_contract_hash: '2'.repeat(64),
    executor_config: { runner_image_digest: 'sha256:fixture' }
  });
  value.task_executions.push({
    id: 'tex',
    workflow_execution_id: 'wex',
    project_id: 'project',
    workflow_id: 'workflow',
    task_id: 'task',
    contract_id: 'contract',
    contract_version: 1,
    executor: 'assist',
    status: 'failed',
    input_snapshot_hash: '3'.repeat(64),
    context_snapshot: {
      context_pack_id: 'pack',
      repository_snapshot: { fixed_sha: '4'.repeat(40) }
    },
    stage_checkpoint_ids: [],
    replay_count: 0,
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z'
  });
  value.context_packs.push({ id: 'pack', content_json: { exact: 'snapshot' } });
  value.workflow_nodes.push({ id: 'task', task_kind: 'code', title: 'Code task' });
  value.node_contracts.push({ id: 'contract', allowed_tools: ['codex'] });
  value.tools.push({ id: 'codex', name: 'codex', enabled: true, health_status: 'ready' });
  return value;
}

function snapshotImmutable(value) {
  return Object.fromEntries(
    ['outcome_requirements', 'outcome_evaluations', 'outcome_waivers', 'execution_stage_checkpoints'].map((key) => [
      key,
      structuredClone(value[key])
    ])
  );
}
