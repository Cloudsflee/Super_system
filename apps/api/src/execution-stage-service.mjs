import {
  EXECUTION_CHECKPOINT_SCHEMA,
  EXECUTION_STAGES,
  failureEnvelope,
  parseExecutionCheckpoint,
  parseFailureEnvelope,
  protocolHash
} from '../../../packages/execution-protocol/src/index.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { redactKnownSecretsSync } from './vault.mjs';

export function executionIdentityInState(state, taskExecution, overrides = {}) {
  const workflowExecution = state.workflow_executions.find((item) => item.id === taskExecution?.workflow_execution_id),
    repositorySha =
      overrides.repository_sha ||
      taskExecution?.context_snapshot?.repository_snapshot?.fixed_sha ||
      taskExecution?.context_snapshot?.repository_snapshot?.head_sha ||
      null,
    contextPack = state.context_packs.find((item) => item.id === taskExecution?.context_snapshot?.context_pack_id);
  return {
    input_snapshot_hash: validSha(taskExecution?.input_snapshot_hash) ? taskExecution.input_snapshot_hash : null,
    repository_sha: /^[a-f0-9]{40,64}$/.test(String(repositorySha || '')) ? repositorySha : null,
    runner_image_digest:
      overrides.runner_image_digest ||
      workflowExecution?.executor_config?.runner_image_digest ||
      process.env.AIWS_CODEX_DOCKER_IMAGE ||
      'aiws-codex-runner:2.1.0-codex-0.144.0',
    policy_hash:
      overrides.policy_hash ||
      protocolHash({
        workflow_input_hash: workflowExecution?.input_hash || null,
        contract_id: taskExecution?.contract_id || null,
        contract_version: taskExecution?.contract_version || null,
        executor: taskExecution?.executor || null
      }),
    verifier_version: overrides.verifier_version || verifierVersion(taskExecution),
    cas_hash: overrides.cas_hash || (contextPack ? protocolHash(contextPack.content_json || contextPack) : null)
  };
}

export function beginExecutionStageInState(
  state,
  {
    workflowExecutionId,
    taskExecutionId = null,
    stage,
    input = null,
    identity = null,
    replayOfCheckpointId = null,
    timestamp = now()
  }
) {
  assertStage(stage);
  const taskExecution = taskExecutionId
    ? state.task_executions.find(
        (item) => item.id === taskExecutionId && item.workflow_execution_id === workflowExecutionId
      )
    : null;
  if (taskExecutionId && !taskExecution) throw new HttpError(404, { error: 'task_execution_not_found' });
  if (!state.workflow_executions.some((item) => item.id === workflowExecutionId))
    throw new HttpError(404, { error: 'workflow_execution_not_found' });
  if (taskExecution) {
    taskExecution.current_stage = stage;
    taskExecution.updated_at = timestamp;
  }
  return {
    workflow_execution_id: workflowExecutionId,
    task_execution_id: taskExecutionId,
    stage,
    input_hash: protocolHash(input),
    identity:
      identity ||
      (taskExecution ? executionIdentityInState(state, taskExecution) : workflowIdentity(state, workflowExecutionId)),
    replay_of_checkpoint_id: replayOfCheckpointId,
    started_at: timestamp
  };
}

export function completeExecutionStageInState(
  state,
  token,
  { output = null, casRefs = [], queueMs = 0, timestamp = now() } = {}
) {
  return appendCheckpoint(state, token, {
    status: 'completed',
    outputHash: protocolHash(output),
    casRefs,
    queueMs,
    failure: null,
    timestamp
  });
}

export function failExecutionStageInState(
  state,
  token,
  error,
  { category = 'internal', retryable = false, details = {}, queueMs = 0, timestamp = now() } = {}
) {
  const failure = failureEnvelope(error, {
    stage: token.stage,
    category,
    retryable,
    details,
    clock: () => new Date(timestamp)
  });
  failure.message = failure.message ? redactKnownSecretsSync(failure.message) : null;
  parseFailureEnvelope(failure);
  const checkpoint = appendCheckpoint(state, token, {
    status: 'failed',
    outputHash: null,
    casRefs: [],
    queueMs,
    failure,
    timestamp
  });
  const taskExecution = token.task_execution_id
    ? state.task_executions.find((item) => item.id === token.task_execution_id)
    : null;
  if (taskExecution) {
    taskExecution.failure = failure;
    taskExecution.error_code = failure.code;
    taskExecution.retry_class = failure.retryable ? 'transient' : 'deterministic';
  }
  return checkpoint;
}

export function assertStageReplayableInState(state, taskExecutionId, stage, overrides = {}) {
  assertStage(stage);
  const execution = state.task_executions.find((item) => item.id === taskExecutionId);
  if (!execution) throw new HttpError(404, { error: 'task_execution_not_found' });
  const checkpoint = state.execution_stage_checkpoints
    .filter((item) => item.task_execution_id === execution.id && item.stage === stage && item.status === 'failed')
    .sort((left, right) => Number(right.sequence) - Number(left.sequence))[0];
  if (!checkpoint) throw new HttpError(409, { error: 'execution_stage_failed_checkpoint_required', stage });
  const current = executionIdentityInState(state, execution, overrides),
    changed = Object.keys(checkpoint.identity).filter(
      (key) => JSON.stringify(checkpoint.identity[key]) !== JSON.stringify(current[key])
    );
  if (changed.length)
    throw new HttpError(409, {
      error: 'execution_stage_replay_identity_changed',
      stage,
      changed_fields: changed,
      checkpoint_id: checkpoint.id
    });
  if (!replayPrerequisitesSatisfied(state, execution.id, stage, checkpoint.sequence))
    throw new HttpError(409, { error: 'execution_stage_replay_prerequisite_missing', stage });
  return { task_execution: execution, checkpoint, identity: current };
}

export function beginStageReplayInState(state, taskExecutionId, stage, overrides = {}) {
  const replay = assertStageReplayableInState(state, taskExecutionId, stage, overrides);
  replay.task_execution.replay_count = Number(replay.task_execution.replay_count || 0) + 1;
  replay.task_execution.failure = null;
  return {
    ...replay,
    token: beginExecutionStageInState(state, {
      workflowExecutionId: replay.task_execution.workflow_execution_id,
      taskExecutionId: replay.task_execution.id,
      stage,
      input: { replay_checkpoint_id: replay.checkpoint.id },
      identity: replay.identity,
      replayOfCheckpointId: replay.checkpoint.id
    })
  };
}

export function stageSnapshot(state, taskExecutionId) {
  const execution = state.task_executions.find((item) => item.id === taskExecutionId);
  if (!execution) throw new HttpError(404, { error: 'task_execution_not_found' });
  return {
    task_execution_id: execution.id,
    current_stage: execution.current_stage || null,
    replay_count: Number(execution.replay_count || 0),
    failure: execution.failure || null,
    stages: state.execution_stage_checkpoints
      .filter((item) => item.task_execution_id === execution.id)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
  };
}

function appendCheckpoint(state, token, { status, outputHash, casRefs, queueMs, failure, timestamp }) {
  const relevant = state.execution_stage_checkpoints.filter((item) =>
      token.task_execution_id
        ? item.task_execution_id === token.task_execution_id
        : !item.task_execution_id && item.workflow_execution_id === token.workflow_execution_id
    ),
    sequence = relevant.reduce((maximum, item) => Math.max(maximum, Number(item.sequence || 0)), 0) + 1,
    attempt = relevant.filter((item) => item.stage === token.stage).length + 1,
    started = Date.parse(token.started_at),
    completed = Date.parse(timestamp),
    checkpoint = {
      schema_version: EXECUTION_CHECKPOINT_SCHEMA,
      id: id('ecp'),
      workflow_execution_id: token.workflow_execution_id,
      task_execution_id: token.task_execution_id,
      stage: token.stage,
      sequence,
      attempt,
      status,
      input_hash: token.input_hash,
      output_hash: outputHash,
      identity: structuredClone(token.identity),
      cas_refs: normalizeCasRefs(casRefs),
      duration_ms: Math.max(0, Number.isFinite(completed - started) ? completed - started : 0),
      queue_ms: Math.max(0, Math.floor(Number(queueMs) || 0)),
      failure,
      replay_of_checkpoint_id: token.replay_of_checkpoint_id || null,
      started_at: token.started_at,
      completed_at: timestamp,
      immutable: true
    };
  parseExecutionCheckpoint(checkpoint);
  state.execution_stage_checkpoints.push(checkpoint);
  if (token.task_execution_id) {
    const execution = state.task_executions.find((item) => item.id === token.task_execution_id);
    execution.stage_checkpoint_ids = [...new Set([...(execution.stage_checkpoint_ids || []), checkpoint.id])];
    execution.current_stage = token.stage;
    execution.updated_at = timestamp;
    if (status === 'completed') execution.failure = null;
  }
  return checkpoint;
}

function replayPrerequisitesSatisfied(state, taskExecutionId, stage, beforeSequence) {
  if (stage === 'finalize')
    return state.task_executions.some((item) => item.id === taskExecutionId && item.status === 'completed');
  const stageIndex = EXECUTION_STAGES.indexOf(stage);
  if (stageIndex <= 0) return true;
  const completed = new Set(
    state.execution_stage_checkpoints
      .filter(
        (item) =>
          item.task_execution_id === taskExecutionId &&
          item.status === 'completed' &&
          item.sequence < beforeSequence &&
          EXECUTION_STAGES.indexOf(item.stage) < stageIndex
      )
      .map((item) => item.stage)
  );
  return EXECUTION_STAGES.slice(0, stageIndex).every((required) => completed.has(required));
}

function workflowIdentity(state, workflowExecutionId) {
  const execution = state.workflow_executions.find((item) => item.id === workflowExecutionId);
  return {
    input_snapshot_hash: validSha(execution?.input_hash) ? execution.input_hash : null,
    repository_sha: null,
    runner_image_digest: null,
    policy_hash: protocolHash({ outcome_contract_hash: execution?.outcome_contract_hash || null }),
    verifier_version: EVALUATOR_VERSION,
    cas_hash: null
  };
}

function verifierVersion(execution) {
  if (execution?.executor === 'repository_change') return 'repository_change_verifier.v1';
  if (execution?.executor === 'repository_verify') return 'repository_verify_verifier.v1';
  if (execution?.executor === 'repository_integrate') return 'repository_integrate_verifier.v1';
  return 'deployment_runtime_verifier.v2';
}

function normalizeCasRefs(values) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    sha256: String(item.sha256 || ''),
    size_bytes: Math.max(0, Math.floor(Number(item.size_bytes) || 0)),
    media_type: String(item.media_type || 'application/octet-stream')
  }));
}

function assertStage(stage) {
  if (!EXECUTION_STAGES.includes(stage))
    throw new HttpError(400, { error: 'execution_stage_invalid', stage, allowed: EXECUTION_STAGES });
}

function validSha(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

const EVALUATOR_VERSION = 'aiws.outcome-evaluator.v1';
