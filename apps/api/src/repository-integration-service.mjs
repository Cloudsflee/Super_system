import { now } from '../../../packages/shared/index.mjs';
import { ingestExecutionOutputsInState } from './asset-attestation-service.mjs';
import { HttpError } from './http.mjs';
import { createRepositoryLinePullRequestIntentInState, requireIntent } from './pull-request-intent-domain.mjs';
import { verifyRepositoryLineHead } from './repository-line-service.mjs';
import { mutate } from './state.mjs';
import { notUsedContextDispositions } from './task-handoff.mjs';
import { ensureCompletedWorkstreamOutcomesInState, prepareTaskExecutionInState } from './task-execution-service.mjs';
import {
  appendExecutionEvent,
  completeTaskExecutionInState,
  reconcileWorkflowExecutionInState,
  requireTaskExecution,
  integrationEvidenceFor,
  transitionTaskExecutionInState
} from './workflow-execution-domain.mjs';

export async function prepareRepositoryIntegration(taskExecutionId) {
  return mutate(async (state) => {
    const execution = requireTaskExecution(state, taskExecutionId);
    if (execution.executor !== 'repository_integrate' || execution.status !== 'queued')
      throw new HttpError(409, { error: 'repository_integration_not_queued', status: execution.status });
    await prepareTaskExecutionInState(state, execution.id);
    const line = repositoryLine(state, execution);
    await verifyRepositoryLineHead(line, line.head_sha, { requireClean: true });
    transitionTaskExecutionInState(state, execution, 'running', { reason: 'integration_preparing' });
    const workflowExecution = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id);
    const task = state.workflow_nodes.find((item) => item.id === execution.task_id);
    const created = createRepositoryLinePullRequestIntentInState(
      state,
      line.id,
      {
        title: task?.title || `Integrate ${line.branch}`,
        body: `AIWS Workflow Execution ${execution.workflow_execution_id}\n\nTask Execution ${execution.id}`
      },
      workflowExecution.created_by_user_id
    );
    line.status = 'integrating';
    line.updated_at = now();
    execution.integration = {
      pull_request_intent_id: created.intent.id,
      repository_line_id: line.id,
      stage: created.intent.status
    };
    execution.readiness = {
      ready: false,
      reasons: [{ code: 'pull_request_create_approval_required', pull_request_intent_id: created.intent.id }]
    };
    transitionTaskExecutionInState(state, execution, 'awaiting_human', {
      reason: 'pull_request_create_approval_required',
      pull_request_intent_id: created.intent.id
    });
    appendExecutionEvent(
      state,
      workflowExecution,
      execution,
      'integration.intent_created',
      { pull_request_intent_id: created.intent.id, repository_line_id: line.id },
      'system',
      null
    );
    reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
    return { task_execution: execution, repository_line: line, pull_request_intent: created.intent };
  });
}

export async function advanceRepositoryIntegration(intentId, action, result, actorId) {
  return mutate(async (state) => {
    const intent = requireIntent(state, intentId),
      line = state.repository_lines.find((item) => item.id === intent.repository_line_id);
    if (!line) throw new HttpError(404, { error: 'repository_line_not_found' });
    const execution = state.task_executions
      .filter(
        (item) =>
          item.workflow_execution_id === line.workflow_execution_id &&
          item.workstream_id === line.workstream_id &&
          item.executor === 'repository_integrate'
      )
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (!execution) throw new HttpError(404, { error: 'repository_integration_task_execution_not_found' });
    if (action === 'create_pr') {
      Object.assign(line, {
        status: 'integrating',
        pr_number: intent.pr_number,
        pr_url: intent.pr_url,
        pr_state: intent.pr_state,
        updated_at: now()
      });
      execution.integration = {
        ...execution.integration,
        stage: 'merge_approval_required',
        pr_number: intent.pr_number,
        pr_url: intent.pr_url
      };
      execution.readiness = {
        ready: false,
        reasons: [
          {
            code: 'pull_request_merge_approval_required',
            pull_request_intent_id: intent.id,
            pr_number: intent.pr_number
          }
        ]
      };
      appendExecutionEvent(
        state,
        state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
        execution,
        'integration.pull_request_created',
        { pull_request_intent_id: intent.id, pr_number: intent.pr_number, pr_url: intent.pr_url },
        'system',
        actorId
      );
      reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
      return { task_execution: execution, repository_line: line, pull_request_intent: intent };
    }
    if (action !== 'merge_pr' || intent.status !== 'merged')
      throw new HttpError(409, { error: 'repository_integration_action_invalid' });
    if (execution.status !== 'awaiting_human')
      throw new HttpError(409, { error: 'repository_integration_task_status_invalid', status: execution.status });
    const checks = Array.isArray(result.checks) ? result.checks : intent.checks || [];
    const approvals = intent.approvals.filter((item) => ['create_pr', 'merge_pr'].includes(item.action));
    if (!approvals.some((item) => item.action === 'create_pr') || !approvals.some((item) => item.action === 'merge_pr'))
      throw new HttpError(409, { error: 'integration_two_approvals_required' });
    const mergedSha = result.merge_commit_sha || intent.merge_commit_sha;
    Object.assign(line, {
      status: 'merged',
      merged_sha: mergedSha,
      pr_number: intent.pr_number,
      pr_url: intent.pr_url,
      pr_state: 'merged',
      updated_at: now()
    });
    const evidence = integrationEvidenceFor(state, execution, { checks, mergedSha });
    execution.evidence = evidence;
    transitionTaskExecutionInState(state, execution, 'verifying', { reason: 'pull_request_merged' });
    const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
    const consumed = [
        ...new Set(
          (execution.context_snapshot?.inputs || [])
            .flatMap((item) => item.asset_versions || [])
            .map((item) => item.version_id)
        )
      ],
      contextDispositions = notUsedContextDispositions(
        execution,
        'The deterministic repository integration did not use semantic context.'
      );
    const outputs = (contract?.expected_outputs || []).map((slot) => ({
      output_key: slot.key,
      asset_type: slot.asset_type,
      title: `${slot.key} PR #${intent.pr_number}`,
      summary: `Merged ${intent.head_sha} into ${intent.base_ref} as ${mergedSha}.`,
      payload: { payload_kind: 'json', media_type: 'application/json', content: { pull_request_intent_id: intent.id } },
      evidence_refs: evidence.evidence_refs,
      consumed_input_versions: consumed,
      ...(contextDispositions.length
        ? { consumed_context_document_versions: [], context_dispositions: contextDispositions }
        : {})
    }));
    const ingested = await ingestExecutionOutputsInState(state, {
      taskExecution: execution,
      outputs,
      declaredConsumedContextDocumentVersions: contextDispositions.length ? [] : null,
      declaredContextDispositions: contextDispositions.length ? contextDispositions : null,
      actorId,
      verifierId: 'repository_integrate_verifier',
      actualEvidence: evidence
    });
    if (!ingested.awaiting_human.length) completeTaskExecutionInState(state, execution.id, { evidence });
    execution.integration = {
      ...execution.integration,
      stage: ingested.awaiting_human.length ? 'output_approval_required' : 'completed',
      merged_sha: mergedSha
    };
    await ensureCompletedWorkstreamOutcomesInState(state, execution.workflow_execution_id);
    const reconciled = reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
    return {
      task_execution: execution,
      repository_line: line,
      pull_request_intent: intent,
      workflow_execution: reconciled.workflow_execution
    };
  });
}

function repositoryLine(state, execution) {
  const line = state.repository_lines.find(
    (item) =>
      item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
  );
  if (!line) throw new HttpError(404, { error: 'repository_line_not_found' });
  return line;
}
