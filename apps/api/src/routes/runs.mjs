import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { nodeBundle } from '../helpers.mjs';
import { ensureRunContextPack, confirmContextPack, previewContextPack } from '../handlers/context-packs.mjs';
import { cancelRunInState, invokeRunner, persistRunnerResult } from '../handlers/runners.mjs';
import { consumeNodeRunApproval, requireNodeRunApproval } from '../run-approval.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { RunnerStatus, buildNodeRunResult, now } from '../../../../packages/shared/index.mjs';
import { assertManagedProjectWritable } from '../project-lifecycle.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';
import { evaluateTaskExecutionContextFreshness } from '../task-execution-context.mjs';
import { assertControlledTaskWrite } from '../execution-governance.mjs';
import { prepareTaskExecutionInState } from '../task-execution-service.mjs';
import { collectActualEvidenceInState, ensureCompletedWorkstreamOutcomesInState } from '../task-execution-service.mjs';
import { ingestExecutionOutputsInState } from '../asset-attestation-service.mjs';
import { ensureContextProjection } from '../context-service.mjs';
import { verifyDeploymentNodeRun } from '../deployment-evidence-verifier.mjs';
import {
  beginExecutionStageInState,
  completeExecutionStageInState,
  failExecutionStageInState
} from '../execution-stage-service.mjs';
import { runnerPreflightInState } from '../runner-preflight.mjs';
import {
  completeTaskExecutionInState,
  failTaskExecutionInState,
  reconcileWorkflowExecutionInState
} from '../workflow-execution-domain.mjs';
import { controlledRunnerResultError, failNodeRun } from '../run-failure-support.mjs';
import {
  assertNodeRunDependencies,
  createAssetsFromRun,
  createRun,
  requireNodeBundle,
  startRunTrace
} from '../run-record-support.mjs';
import { applyTestRepositoryChanges, delay, testConsumptionFixture } from '../run-test-support.mjs';

export { controlledRunnerResultError } from '../run-failure-support.mjs';
export { assertNodeRunDependencies } from '../run-record-support.mjs';

const runControllers = new Map();

export const runRoutes = [
  makeRoute('POST', '/nodes/:id/context-pack/preview', previewRoute),
  makeRoute('POST', '/context-packs/:id/confirm', confirmContextRoute),
  makeRoute('GET', '/context-packs/:id', getContextRoute),
  makeRoute('POST', '/nodes/:id/run/start', startNodeRunRoute),
  makeRoute('POST', '/nodes/:id/run', runNodeRoute),
  makeRoute('POST', '/runs/:id/cancel', cancelRunRoute),
  makeRoute('GET', '/runs/:id/trace', traceRoute),
  makeRoute('GET', '/runs/:id', getRunRoute)
];

async function previewRoute({ res, params, body }) {
  await ensureNodeContextProjection(params.id);
  const result = await mutate((state) => {
    const actor = owner(state),
      bundle = nodeBundle(state, params.id);
    requireNodeBundle(bundle);
    assertProjectLifecycleIdle(bundle.project);
    return previewContextPack(state, { actor, ...bundle, body });
  });
  return send(res, 201, result);
}

async function confirmContextRoute({ res, params }) {
  const result = await mutate((state) => {
    const contextPack = state.context_packs.find((item) => item.id === params.id);
    if (!contextPack) throw new HttpError(404, 'context_pack_not_found');
    const projectId =
      contextPack.content_json?.project?.id ||
      state.workspaces.find((item) => item.id === contextPack.source_workspace_id)?.project_id;
    assertProjectLifecycleIdle(state.projects.find((item) => item.id === projectId));
    return confirmContextPack(state, { actor: owner(state), contextPackId: params.id });
  });
  return send(res, 200, result);
}

async function getContextRoute({ res, params }) {
  const ctx = (await readState()).context_packs.find((item) => item.id === params.id);
  return ctx ? send(res, 200, ctx) : send(res, 404, { error: 'context_pack_not_found' });
}

async function runNodeRoute({ res, params, body }) {
  return send(res, 201, await executeNodeRun(params.id, body));
}

export async function executeNodeRun(nodeId, body = {}) {
  const prepared = await prepareNodeRun(nodeId, body);
  return completeNodeRun(nodeId, body, prepared);
}

async function startNodeRunRoute({ res, params, body }) {
  const prepared = await prepareNodeRun(params.id, body);
  setImmediate(() =>
    completeNodeRun(params.id, body, prepared).catch((error) =>
      console.error('background NodeRun failed', error.message)
    )
  );
  const state = await readState();
  return send(res, 202, {
    run: state.node_runs.find((item) => item.id === prepared.run_id),
    context_pack: state.context_packs.find((item) => item.id === prepared.context_pack_id),
    assets: []
  });
}

async function prepareNodeRun(nodeId, body) {
  if (body.enqueue_only === true) throw new HttpError(400, { error: 'enqueue_only_not_supported' });
  await ensureNodeContextProjection(nodeId);
  const prepared = await mutate(async (state) => {
    const actor = owner(state),
      bundle = nodeBundle(state, nodeId);
    requireNodeBundle(bundle);
    const controlled = assertControlledTaskWrite(state, nodeId, body, 'node_run');
    assertNodeRunDependencies(state, bundle.node, { controlled: controlled.controlled });
    assertManagedProjectWritable(bundle.project);
    if (controlled.controlled && !['assist', 'repository_change'].includes(controlled.task_execution.executor))
      throw new HttpError(409, { error: 'node_run_executor_mismatch', executor: controlled.task_execution.executor });
    if (controlled.controlled) await prepareTaskExecutionInState(state, controlled.task_execution.id);
    const ctx = controlled.controlled
      ? state.context_packs.find((item) => item.id === controlled.task_execution.context_snapshot?.context_pack_id)
      : ensureRunContextPack(state, { actor, ...bundle, body });
    if (!ctx) throw new HttpError(409, { error: 'task_execution_context_pack_missing' });
    const run = createRun({ actor, ...bundle, ctx, body });
    run.task_execution_id = controlled.task_execution?.id || null;
    state.node_runs.push(run);
    const staged = Boolean(
      controlled.task_execution?.workflow_execution_id &&
      controlled.task_execution?.completion_status !== 'legacy_unassessed' &&
      Number(state.schema_version || 0) >= 21
    );
    if (staged) {
      const token = beginExecutionStageInState(state, {
        workflowExecutionId: controlled.task_execution.workflow_execution_id,
        taskExecutionId: controlled.task_execution.id,
        stage: 'preflight',
        input: { node_id: nodeId, context_pack_id: ctx.id, runner: run.runner }
      });
      try {
        const preflight = runnerPreflightInState(state, {
          taskExecution: controlled.task_execution,
          node: bundle.node,
          contract: bundle.contract,
          runner: run.runner,
          testAdapter: testAdapter(body)
        });
        run.preflight = preflight;
        completeExecutionStageInState(state, token, { output: preflight });
      } catch (error) {
        const checkpoint = failExecutionStageInState(state, token, error, {
          category: error?.payload?.failed_checks?.some((item) => ['dns', 'https', 'proxy_case'].includes(item))
            ? 'network'
            : 'capability',
          retryable: error?.payload?.retryable === true,
          details: { failed_checks: error?.payload?.failed_checks || [] }
        });
        Object.assign(run, {
          status: RunnerStatus.Failed,
          error_code: checkpoint.failure.code,
          summary: checkpoint.failure.code,
          completed_at: now(),
          updated_at: now()
        });
        bundle.node.status = 'blocked';
        failTaskExecutionInState(state, controlled.task_execution.id, {
          errorCode: checkpoint.failure.code,
          retryClass: checkpoint.failure.retryable ? 'transient' : 'deterministic',
          failure: checkpoint.failure,
          stage: 'preflight'
        });
        return {
          run_id: run.id,
          context_pack_id: ctx.id,
          controlled: true,
          staged: true,
          error: { status: error?.status || 409, payload: error?.payload || { error: checkpoint.failure.code } }
        };
      }
    }
    if (!controlled.controlled) {
      const approval = requireNodeRunApproval(state, {
        approvalId: body.approval_id,
        nodeId,
        runner: run.runner,
        repositoryWorkspaceId: run.repository_workspace_id
      });
      consumeNodeRunApproval(approval, run.id);
      addTrace(
        state,
        'node_run.approval.consumed',
        {
          project_id: bundle.project.id,
          workspace_id: bundle.workspace.id,
          node_id: nodeId,
          run_id: run.id,
          target_type: 'change_proposal',
          target_id: approval.id,
          summary: `NodeRun 使用审批：${approval.title}`
        },
        actor.id
      );
    }
    startRunTrace(state, { actor, ...bundle, run, ctx });
    return {
      run_id: run.id,
      context_pack_id: ctx.id,
      controlled: controlled.controlled,
      staged
    };
  });
  if (prepared.error) throw new HttpError(prepared.error.status, prepared.error.payload);
  return prepared;
}

async function ensureNodeContextProjection(nodeId) {
  const state = await readState(),
    node = state.workflow_nodes.find((item) => item.id === nodeId),
    workflow = state.workflows.find((item) => item.id === node?.workflow_id);
  if (workflow?.project_id) await ensureContextProjection({ projectId: workflow.project_id });
}

async function completeNodeRun(nodeId, body, prepared) {
  const controller = new AbortController();
  let activeStageToken = null;
  runControllers.set(prepared.run_id, controller);
  try {
    activeStageToken = await beginPreparedRunStage(prepared, 'execute', {
      node_run_id: prepared.run_id,
      context_pack_id: prepared.context_pack_id
    });
    const invoked = await invokePreparedNodeRun(nodeId, body, prepared, controller, activeStageToken);
    if (invoked.cancelled) return invoked.response;
    const execution = invoked.execution;
    const runnerError = controlledRunnerResultError(execution.resultJson, prepared.controlled);
    if (runnerError) {
      await persistNodeRunCollection(nodeId, prepared, execution, null);
      throw runnerError;
    }
    activeStageToken = await completeAndBeginRunStage(
      prepared,
      activeStageToken,
      { node_run_id: prepared.run_id, status: execution.resultJson?.status || RunnerStatus.Succeeded },
      'collect',
      { node_run_id: prepared.run_id, result_schema: execution.resultJson?.schema_version || null }
    );
    const persisted = await persistNodeRunCollection(nodeId, prepared, execution, activeStageToken);
    activeStageToken = null;
    if (persisted.cancelled) return persisted.response;
    activeStageToken = await beginVerifyStage(prepared);
    assertNoTestVerifierFailure(prepared, body);
    const deploymentVerification = persisted.controlled
      ? await verifyPersistedDeploymentRun(prepared.run_id, execution.resultJson)
      : null;
    activeStageToken = await completeVerifyAndBeginAttest(prepared, activeStageToken, deploymentVerification);
    return await finalizeNodeRun(nodeId, prepared, execution, activeStageToken, deploymentVerification);
  } catch (error) {
    await failNodeRun(prepared.run_id, error, activeStageToken);
    throw error;
  } finally {
    runControllers.delete(prepared.run_id);
  }
}

async function beginPreparedRunStage(prepared, stage, input) {
  if (!prepared.staged) return null;
  return mutate((state) => {
    const taskExecution = taskExecutionForRun(state, prepared.run_id);
    return beginExecutionStageInState(state, {
      workflowExecutionId: taskExecution?.workflow_execution_id,
      taskExecutionId: taskExecution?.id,
      stage,
      input
    });
  });
}

async function invokePreparedNodeRun(nodeId, body, prepared, controller, stageToken) {
  try {
    const cancelled = await cancelledNodeRunResponse(prepared);
    if (cancelled) return { cancelled: true, response: cancelled };
    const execution = testAdapter(body)
      ? await executeTestNodeRun(body, prepared)
      : await executeRunnerNodeRun(nodeId, body, prepared, controller);
    return { cancelled: false, execution };
  } catch (error) {
    await failNodeRun(prepared.run_id, error, stageToken);
    throw error;
  }
}

async function cancelledNodeRunResponse(prepared) {
  const state = await readState();
  const run = state.node_runs.find((item) => item.id === prepared.run_id);
  if (run?.status !== RunnerStatus.Cancelled) return null;
  return {
    run,
    context_pack: state.context_packs.find((item) => item.id === prepared.context_pack_id),
    assets: []
  };
}

async function executeTestNodeRun(body, prepared) {
  await delay(Number(body.test_delay_ms || 10));
  const state = await readState();
  const run = state.node_runs.find((item) => item.id === prepared.run_id);
  const contextPack = state.context_packs.find((item) => item.id === prepared.context_pack_id);
  const taskExecution = state.task_executions.find((item) => item.id === run?.task_execution_id);
  if (taskExecution?.executor === 'repository_change')
    await applyTestRepositoryChanges(taskExecution, body.test_changes);
  return {
    raw: 'test adapter execution',
    resultJson: buildNodeRunResult({
      run,
      contextPack,
      changedFiles: [],
      raw: body.test_summary || '测试 NodeRun 已完成',
      status: RunnerStatus.Succeeded,
      ...testConsumptionFixture(taskExecution, body)
    })
  };
}

async function executeRunnerNodeRun(nodeId, body, prepared, controller) {
  const state = await readState();
  const actor = owner(state);
  const bundle = nodeBundle(state, nodeId);
  requireNodeBundle(bundle);
  return invokeRunner(state, {
    actor,
    run: state.node_runs.find((item) => item.id === prepared.run_id),
    ...bundle,
    ctx: state.context_packs.find((item) => item.id === prepared.context_pack_id),
    body: { ...body, signal: controller.signal }
  });
}

async function completeAndBeginRunStage(prepared, token, output, stage, input) {
  if (!prepared.staged) return token;
  await mutate((state) => completeExecutionStageInState(state, token, { output }));
  return mutate((state) =>
    beginExecutionStageInState(state, {
      workflowExecutionId: token.workflow_execution_id,
      taskExecutionId: token.task_execution_id,
      stage,
      input
    })
  );
}

async function beginVerifyStage(prepared) {
  if (!prepared.staged) return null;
  return mutate((state) => {
    const taskExecution = taskExecutionForRun(state, prepared.run_id);
    return beginExecutionStageInState(state, {
      workflowExecutionId: taskExecution?.workflow_execution_id,
      taskExecutionId: taskExecution?.id,
      stage: 'verify',
      input: { node_run_id: prepared.run_id, result_hash: nodeRunResultSize(state, prepared.run_id) }
    });
  });
}

function assertNoTestVerifierFailure(prepared, body) {
  if (!prepared.staged || !testAdapter(body) || !body.test_verifier_failure) return;
  const error = new Error(String(body.test_verifier_failure));
  error.code = String(body.test_verifier_failure);
  throw error;
}

async function completeVerifyAndBeginAttest(prepared, token, verification) {
  return completeAndBeginRunStage(
    prepared,
    token,
    {
      verifier: verification?.verifierId || 'task_output_protocol_verifier',
      evidence_refs: verification?.evidence?.evidence_refs || []
    },
    'attest',
    { node_run_id: prepared.run_id, verifier: verification?.verifierId || null }
  );
}

async function finalizeNodeRun(nodeId, prepared, execution, stageToken, verification) {
  return mutate((state) => finalizeNodeRunInState(state, nodeId, prepared, execution, stageToken, verification));
}

async function finalizeNodeRunInState(state, nodeId, prepared, execution, stageToken, verification) {
  const actor = owner(state);
  const bundle = nodeBundle(state, nodeId);
  const run = state.node_runs.find((item) => item.id === prepared.run_id);
  const contextPack = state.context_packs.find((item) => item.id === prepared.context_pack_id);
  if (!run || !contextPack) throw new HttpError(404, { error: 'prepared_node_run_not_found' });
  if (run.status === RunnerStatus.Cancelled)
    return { cancelled: true, response: { run, context_pack: contextPack, assets: [] } };
  requireNodeBundle(bundle);
  const assets = run.task_execution_id
    ? await finalizeControlledNodeRun(state, { actor, run, execution, prepared, stageToken, verification })
    : createAssetsFromRun(state, { actor, ...bundle, run, resultJson: execution.resultJson });
  return { run, context_pack: contextPack, assets };
}

async function finalizeControlledNodeRun(state, options) {
  const { actor, run, execution, prepared, stageToken, verification } = options;
  const taskExecution = state.task_executions.find((item) => item.id === run.task_execution_id);
  if (!taskExecution) throw new HttpError(409, { error: 'task_execution_missing' });
  const actualEvidence = await collectActualEvidenceInState(state, taskExecution);
  const evidence = mergeActualEvidence(actualEvidence, verification?.evidence);
  const ingested = await ingestExecutionOutputsInState(state, {
    taskExecution,
    outputs: execution.resultJson.outputs,
    declaredConsumedInputVersions: execution.resultJson.consumed_input_versions,
    declaredInputDispositions: execution.resultJson.input_dispositions,
    declaredConsumedContextDocumentVersions: execution.resultJson.consumed_context_document_versions,
    declaredContextDispositions: execution.resultJson.context_dispositions,
    declaredInputEffects: execution.resultJson.input_effects,
    declaredContextEffects: execution.resultJson.context_effects,
    nodeRunId: run.id,
    actorId: actor.id,
    verifierId: executionVerifierId(taskExecution, verification),
    actualEvidence: evidence
  });
  completeAttestationStage(state, prepared, stageToken, ingested);
  if (!ingested.awaiting_human.length) promoteTaskExecution(state, prepared, taskExecution, evidence);
  await ensureCompletedWorkstreamOutcomesInState(state, taskExecution.workflow_execution_id);
  reconcileWorkflowExecutionInState(state, taskExecution.workflow_execution_id);
  return ingested.outputs.map((item) => item.asset);
}

function executionVerifierId(taskExecution, verification) {
  return (
    verification?.verifierId ||
    {
      repository_change: 'repository_change_verifier',
      repository_verify: 'repository_verify_verifier',
      repository_integrate: 'repository_integrate_verifier'
    }[taskExecution.executor] ||
    null
  );
}

function completeAttestationStage(state, prepared, stageToken, ingested) {
  if (!prepared.staged) return;
  completeExecutionStageInState(state, stageToken, {
    output: {
      output_version_ids: ingested.outputs.map((item) => item.version?.id).filter(Boolean),
      awaiting_human: ingested.awaiting_human.length
    }
  });
}

function promoteTaskExecution(state, prepared, taskExecution, evidence) {
  const token = prepared.staged
    ? beginExecutionStageInState(state, {
        workflowExecutionId: taskExecution.workflow_execution_id,
        taskExecutionId: taskExecution.id,
        stage: 'promote',
        input: { output_bindings: taskExecution.output_bindings || [] }
      })
    : null;
  completeTaskExecutionInState(state, taskExecution.id, { evidence });
  if (token)
    completeExecutionStageInState(state, token, {
      output: { status: taskExecution.status, output_bindings: taskExecution.output_bindings || [] }
    });
}

function taskExecutionForRun(state, runId) {
  const run = state.node_runs.find((item) => item.id === runId);
  return state.task_executions.find((item) => item.id === run?.task_execution_id);
}

function nodeRunResultSize(state, runId) {
  const result = state.node_runs.find((run) => run.id === runId)?.result_json;
  return result ? JSON.stringify(result).length : 0;
}

async function persistNodeRunCollection(nodeId, prepared, execution, stageToken) {
  return mutate(async (state) => {
    const actor = owner(state),
      bundle = nodeBundle(state, nodeId),
      run = state.node_runs.find((item) => item.id === prepared.run_id),
      ctx = state.context_packs.find((item) => item.id === prepared.context_pack_id);
    if (!run || !ctx) throw new HttpError(404, { error: 'prepared_node_run_not_found' });
    if (run.status === RunnerStatus.Cancelled)
      return { cancelled: true, response: { run, context_pack: ctx, assets: [] } };
    requireNodeBundle(bundle);
    await persistRunnerResult(state, { actor, run, ...bundle, ...execution });
    const freshness = evaluateTaskExecutionContextFreshness(state, run.task_execution_context);
    if (!freshness.current) {
      Object.assign(run, { input_superseded: true, input_superseded_reasons: freshness.reasons });
      Object.assign(bundle.node, { input_superseded: true, updated_at: now() });
    }
    if (stageToken)
      completeExecutionStageInState(state, stageToken, {
        output: { node_run_id: run.id, result_schema: execution.resultJson?.schema_version || null }
      });
    return { controlled: Boolean(run.task_execution_id), cancelled: false };
  });
}

async function verifyPersistedDeploymentRun(runId, resultJson) {
  const state = await readState(),
    run = state.node_runs.find((item) => item.id === runId),
    taskExecution = state.task_executions.find((item) => item.id === run?.task_execution_id);
  if (!run || !taskExecution) return null;
  return verifyDeploymentNodeRun(state, { run, taskExecution, resultJson });
}

function mergeActualEvidence(actual, verified) {
  if (!verified) return actual;
  return {
    ...(actual || {}),
    ...verified,
    evidence_refs: [...new Set([...(actual?.evidence_refs || []), ...(verified.evidence_refs || [])])]
  };
}

async function cancelRunRoute({ res, params }) {
  runControllers.get(params.id)?.abort();
  const result = await mutate((state) => cancelRunInState(state, params.id, owner(state).id));
  return send(res, 200, result);
}

async function traceRoute({ res, params }) {
  const state = await readState();
  return send(
    res,
    200,
    state.traces
      .filter((trace) => trace.run_id === params.id)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  );
}

async function getRunRoute({ res, params }) {
  const state = await readState();
  const run = state.node_runs.find((item) => item.id === params.id);
  if (!run) return send(res, 404, { error: 'run_not_found' });
  return send(res, 200, {
    run,
    context_pack: state.context_packs.find((c) => c.id === run.context_pack_id),
    traces: state.traces.filter((t) => t.run_id === run.id),
    assets: state.assets.filter((a) => a.run_id === run.id),
    code_change: state.code_changes.find((c) => c.run_id === run.id)
  });
}
