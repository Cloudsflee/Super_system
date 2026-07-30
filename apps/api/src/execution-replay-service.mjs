import { now } from '../../../packages/shared/index.mjs';
import { ingestExecutionOutputsInState } from './asset-attestation-service.mjs';
import { verifyDeploymentNodeRun } from './deployment-evidence-verifier.mjs';
import {
  beginStageReplayInState,
  completeExecutionStageInState,
  failExecutionStageInState,
  stageSnapshot
} from './execution-stage-service.mjs';
import { HttpError } from './http.mjs';
import { collectActualEvidenceInState, ensureCompletedWorkstreamOutcomesInState } from './task-execution-service.mjs';
import { mutate, owner, readState } from './state.mjs';
import { scheduleWorkflowExecution } from './workflow-dispatcher.mjs';
import { finalizeWorkflowExecution } from './workflow-finalization-service.mjs';
import {
  completeTaskExecutionInState,
  reconcileWorkflowExecutionInState,
  reopenTaskExecutionForStageReplayInState
} from './workflow-execution-domain.mjs';

export async function replayTaskExecutionStage(taskExecutionId, stage, actorId) {
  const started = await mutate((state) => {
    const replay = beginStageReplayInState(state, taskExecutionId, stage);
    if (stage !== 'finalize') reopenTaskExecutionForStageReplayInState(state, taskExecutionId, stage, actorId);
    return {
      token: replay.token,
      workflow_execution_id: replay.task_execution.workflow_execution_id,
      checkpoint_id: replay.checkpoint.id
    };
  });
  if (stage === 'finalize')
    return finalizeWorkflowExecution(started.workflow_execution_id, { forceContext: true, replayToken: started.token });
  if (!['verify', 'attest', 'promote'].includes(stage))
    throw new HttpError(409, { error: 'execution_stage_replay_handler_unavailable', stage });
  return replayPersistedResult(taskExecutionId, stage, started, actorId);
}

async function replayPersistedResult(taskExecutionId, stage, started, actorId) {
  try {
    const snapshot = await readState(),
      taskExecution = snapshot.task_executions.find((item) => item.id === taskExecutionId),
      run = snapshot.node_runs
        .filter((item) => item.task_execution_id === taskExecutionId && item.result_json)
        .sort((left, right) =>
          String(right.completed_at || right.updated_at).localeCompare(String(left.completed_at || left.updated_at))
        )[0];
    if (!taskExecution || !run?.result_json)
      throw new HttpError(409, { error: 'execution_stage_replay_result_missing' });
    const deploymentVerification =
      stage === 'verify'
        ? await verifyDeploymentNodeRun(snapshot, { run, taskExecution, resultJson: run.result_json })
        : null;
    const result = await mutate(async (state) => {
      const execution = state.task_executions.find((item) => item.id === taskExecutionId),
        persistedRun = state.node_runs.find((item) => item.id === run.id),
        actual = await collectActualEvidenceInState(state, execution),
        evidence = mergeEvidence(actual, deploymentVerification?.evidence),
        ingested = await ingestExecutionOutputsInState(state, {
          taskExecution: execution,
          outputs: persistedRun.result_json.outputs,
          declaredConsumedInputVersions: persistedRun.result_json.consumed_input_versions,
          declaredInputDispositions: persistedRun.result_json.input_dispositions,
          declaredConsumedContextDocumentVersions: persistedRun.result_json.consumed_context_document_versions,
          declaredContextDispositions: persistedRun.result_json.context_dispositions,
          declaredInputEffects: persistedRun.result_json.input_effects,
          declaredContextEffects: persistedRun.result_json.context_effects,
          nodeRunId: persistedRun.id,
          actorId: actorId || owner(state).id,
          verifierId: deploymentVerification?.verifierId || 'replayed_persisted_result_verifier',
          actualEvidence: evidence
        });
      if (!ingested.awaiting_human.length) {
        completeTaskExecutionInState(state, execution.id, { evidence });
        await ensureCompletedWorkstreamOutcomesInState(state, execution.workflow_execution_id);
      }
      reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
      const checkpoint = completeExecutionStageInState(state, started.token, {
        output: {
          node_run_id: persistedRun.id,
          output_count: ingested.outputs.length,
          awaiting_human: ingested.awaiting_human.length,
          replayed_at: now()
        }
      });
      return {
        task_execution: execution,
        checkpoint,
        awaiting_human: ingested.awaiting_human,
        node_run_id: persistedRun.id,
        runner_invocations: 0
      };
    });
    scheduleWorkflowExecution(started.workflow_execution_id);
    return result;
  } catch (error) {
    await mutate((state) => {
      const execution = state.task_executions.find((item) => item.id === taskExecutionId);
      const checkpoint = failExecutionStageInState(state, started.token, error, {
        category: stage === 'verify' ? 'verifier' : 'integrity',
        retryable: error?.retryable === true
      });
      execution.status = 'failed';
      execution.completed_at = now();
      execution.updated_at = now();
      reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
      return checkpoint;
    });
    throw error;
  }
}

export function taskStageSnapshotInState(state, taskExecutionId) {
  return stageSnapshot(state, taskExecutionId);
}

function mergeEvidence(actual, verified) {
  if (!verified) return actual;
  return {
    ...(actual || {}),
    ...verified,
    evidence_refs: [...new Set([...(actual?.evidence_refs || []), ...(verified.evidence_refs || [])])]
  };
}
