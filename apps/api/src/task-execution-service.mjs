import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { id, now } from '../../../packages/shared/index.mjs';
import { attestAssetVersionInState, ingestExecutionOutputsInState } from './asset-attestation-service.mjs';
import {
  createAssetRecord,
  createImmutableAssetVersion,
  materializeAssetVersion,
  registerCasBlob,
  verifyAssetVersionPayload
} from './asset-cas.mjs';
import { EXECUTION_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { finalizeRepositoryChangeInState } from './repository-change-verifier.mjs';
import { verifyRepositoryLineHead } from './repository-line-service.mjs';
import { mutate, readState } from './state.mjs';
import { executionInputHash, prepareTaskExecutionContext } from './task-execution-context.mjs';
import { ensureContextProjection } from './context-service.mjs';
import { recordAssetLineage } from './task-output-service.mjs';
import {
  appendExecutionEvent,
  completeTaskExecutionInState,
  currentTaskExecutions,
  failTaskExecutionInState,
  issueTaskExecutionLeaseInState,
  reconcileWorkflowExecutionInState,
  requireTaskExecution,
  retryTaskExecutionInState,
  transitionTaskExecutionInState
} from './workflow-execution-domain.mjs';

export async function prepareTaskExecutionInState(state, taskExecutionId) {
  const execution = requireTaskExecution(state, taskExecutionId);
  if (!['queued', 'running'].includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_context_status_invalid', status: execution.status });
  if (execution.context_snapshot) return execution.context_snapshot;
  const project = state.projects.find((item) => item.id === execution.project_id),
    workflow = state.workflows.find((item) => item.id === execution.workflow_id),
    task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    contract = state.node_contracts.find((item) => item.id === execution.contract_id),
    workspace = state.workspaces.find((item) => item.id === task?.workspace_id),
    workflowExecution = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
    repositoryLine = state.repository_lines.find(
      (item) =>
        item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
    );
  if (!project || !workflow || !task || !contract || !workspace || !workflowExecution)
    throw new HttpError(409, { error: 'task_execution_scope_incomplete' });
  if (
    Number(workflow.workflow_revision || workflow.version || 1) !== workflowExecution.workflow_revision ||
    Number(task.execution_revision || 1) !== execution.task_revision ||
    contract.id !== task.current_contract_id ||
    Number(contract.version || 1) !== execution.contract_version
  )
    throw new HttpError(409, { error: 'task_execution_revision_superseded' });
  if (repositoryLine?.checkout_path)
    await verifyRepositoryLineHead(repositoryLine, repositoryLine.head_sha, { requireClean: true });
  const prepared = prepareTaskExecutionContext(state, {
    project,
    workflow,
    workspace,
    task,
    contract,
    taskExecution: execution,
    workflowExecution,
    repositoryLine,
    purpose: execution.executor,
    receiverName: receiverFor(execution.executor)
  });
  const mountRoot = path.resolve(EXECUTION_DIR, workflowExecution.id, execution.id, 'inputs'),
    mounts = [];
  for (const input of prepared.context.inputs || []) {
    for (const binding of input.asset_versions || []) {
      const version = state.asset_versions.find((item) => item.id === binding.version_id);
      const verified = await verifyAssetVersionPayload(state, version);
      if (!verified.ok)
        throw new HttpError(409, {
          error: 'task_input_asset_integrity_failed',
          version_id: binding.version_id,
          reasons: verified.reasons
        });
      const mounted = await materializeAssetVersion(state, version, path.join(mountRoot, binding.version_id));
      mounts.push({
        input_key: input.key,
        asset_id: binding.asset_id,
        version_id: binding.version_id,
        content_sha256: binding.content_sha256,
        manifest: binding.manifest,
        mount: mounted
      });
    }
  }
  prepared.context.asset_mounts = mounts;
  prepared.context.repository_checkout = repositoryLine
    ? {
        repository_line_id: repositoryLine.id,
        path: repositoryLine.checkout_path,
        expected_head_sha: repositoryLine.head_sha,
        access: ['assist', 'repository_verify'].includes(execution.executor)
          ? 'read_only'
          : execution.executor === 'repository_integrate'
            ? 'integrate_only'
            : 'read_write'
      }
    : null;
  prepared.context.input_snapshot_hash = executionInputHash(prepared.context);
  if (
    execution.retry_input_snapshot_hash &&
    execution.retry_input_snapshot_hash !== prepared.context.input_snapshot_hash
  )
    throw new HttpError(409, {
      error: 'task_execution_retry_input_changed',
      expected_input_snapshot_hash: execution.retry_input_snapshot_hash,
      actual_input_snapshot_hash: prepared.context.input_snapshot_hash
    });
  prepared.context_pack.task_execution_context = structuredClone(prepared.context);
  prepared.context_pack.input_snapshot_hash = prepared.context.input_snapshot_hash;
  execution.context_snapshot = structuredClone(prepared.context);
  execution.input_snapshot_hash = prepared.context.input_snapshot_hash;
  execution.updated_at = now();
  appendExecutionEvent(
    state,
    workflowExecution,
    execution,
    'task.context_prepared',
    {
      input_snapshot_hash: execution.input_snapshot_hash,
      input_version_ids: mounts.map((item) => item.version_id),
      repository_sha: prepared.context.repository_snapshot?.fixed_sha || null
    },
    'system',
    null
  );
  return execution.context_snapshot;
}

export async function claimTaskExecution(taskExecutionId, input = {}) {
  await ensureTaskExecutionContextProjection(taskExecutionId);
  return mutate(async (state) => {
    await prepareTaskExecutionInState(state, taskExecutionId);
    const claimed = issueTaskExecutionLeaseInState(state, taskExecutionId, {
      holder: input.holder || 'worker',
      ttlMs: input.ttl_ms
    });
    claimed.task_execution.lease.input_snapshot_hash = claimed.task_execution.input_snapshot_hash;
    return claimed;
  });
}

export async function submitTaskExecutionOutputs(
  taskExecutionId,
  { outputs, leaseToken = null, verifierId = null, actualEvidence = null, actorId = null, manual = false }
) {
  if (manual) await ensureTaskExecutionContextProjection(taskExecutionId);
  const result = await mutate(async (state) => {
    const execution = requireTaskExecution(state, taskExecutionId);
    if (manual && execution.status === 'queued') {
      await prepareTaskExecutionInState(state, execution.id);
      transitionTaskExecutionInState(state, execution, 'running', { reason: 'manual_checkpoint_submitted' });
    } else if (manual && execution.status === 'awaiting_human' && !(execution.output_bindings || []).length) {
      transitionTaskExecutionInState(state, execution, 'verifying', { reason: 'manual_checkpoint_submitted' });
    } else if (!manual) {
      const { assertTaskExecutionLease } = await import('./workflow-execution-domain.mjs');
      assertTaskExecutionLease(state, { taskExecutionId, leaseToken, operation: 'executor_result' });
    }
    const evidence = actualEvidence || (await collectActualEvidenceInState(state, execution));
    const ingested = await ingestExecutionOutputsInState(state, {
      taskExecution: execution,
      outputs,
      actorId,
      verifierId: verifierId || verifierFor(execution.executor),
      actualEvidence: evidence
    });
    if (manual && ingested.awaiting_human.length) {
      for (const item of ingested.awaiting_human)
        await attestAssetVersionInState(state, {
          assetId: item.asset_id,
          versionId: item.version_id,
          expectedSha256: item.content_sha256,
          taskExecutionId: execution.id,
          outputKey: item.output_key,
          decision: 'accepted',
          attestorType: 'human',
          attestorId: actorId,
          summary: 'Manual checkpoint submitted and accepted.'
        });
      ingested.awaiting_human = [];
      ingested.output_bindings = execution.output_bindings;
    }
    if (!ingested.awaiting_human.length) completeTaskExecutionInState(state, execution.id, { evidence });
    await ensureCompletedWorkstreamOutcomesInState(state, execution.workflow_execution_id);
    const reconciled = reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
    return { task_execution: execution, ...ingested, workflow_execution: reconciled.workflow_execution };
  });
  return result;
}

async function ensureTaskExecutionContextProjection(taskExecutionId) {
  const state = await readState(),
    execution = state.task_executions.find((item) => item.id === taskExecutionId);
  if (execution?.project_id && !execution.context_snapshot)
    await ensureContextProjection({ projectId: execution.project_id });
}

export async function approveTaskExecution(taskExecutionId, { decision, expectedVersions, actorId, summary = '' }) {
  return mutate(async (state) => {
    const execution = requireTaskExecution(state, taskExecutionId);
    if (execution.status !== 'awaiting_human')
      throw new HttpError(409, { error: 'task_execution_not_awaiting_human', status: execution.status });
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, { error: 'human_decision_invalid' });
    const contract = state.node_contracts.find((item) => item.id === execution.contract_id),
      expected = Array.isArray(expectedVersions) ? expectedVersions : [];
    const humanSlots = (contract?.expected_outputs || []).filter(
      (item) => item.confirmation_policy === 'human' && item.required !== false
    );
    const candidates = humanSlots.map((slot) => {
      const asset = state.assets.find(
          (item) =>
            item.task_execution_id === execution.id && item.output_key === slot.key && item.status === 'candidate'
        ),
        version = state.asset_versions.find((item) => item.id === asset?.current_version_id);
      if (!asset || !version)
        throw new HttpError(409, { error: 'human_checkpoint_output_missing', output_key: slot.key });
      const claim = expected.find(
        (item) => item.version_id === version.id && item.content_sha256 === version.content_sha256
      );
      if (!claim)
        throw new HttpError(409, {
          error: 'human_checkpoint_expected_version_required',
          output_key: slot.key,
          version_id: version.id,
          content_sha256: version.content_sha256
        });
      return { slot, asset, version };
    });
    for (const item of candidates)
      await attestAssetVersionInState(state, {
        assetId: item.asset.id,
        versionId: item.version.id,
        expectedSha256: item.version.content_sha256,
        taskExecutionId: execution.id,
        outputKey: item.slot.key,
        decision: decision === 'approve' ? 'accepted' : 'rejected',
        attestorType: 'human',
        attestorId: actorId,
        summary
      });
    if (decision === 'reject')
      failTaskExecutionInState(state, execution.id, {
        errorCode: 'human_changes_requested',
        retryClass: 'deterministic'
      });
    else
      completeTaskExecutionInState(state, execution.id, {
        evidence: { ...execution.evidence, human_attestation: true }
      });
    await ensureCompletedWorkstreamOutcomesInState(state, execution.workflow_execution_id);
    const reconciled = reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
    return {
      task_execution: execution,
      workflow_execution: reconciled.workflow_execution,
      attestations: state.asset_attestations.filter((item) => item.task_execution_id === execution.id)
    };
  });
}

export async function ensureCompletedWorkstreamOutcomesInState(state, workflowExecutionId) {
  const workflowExecution = state.workflow_executions.find((item) => item.id === workflowExecutionId);
  if (!workflowExecution) throw new HttpError(404, { error: 'workflow_execution_not_found' });
  const executions = currentTaskExecutions(state, workflowExecutionId),
    outcomes = [];
  for (const workstream of state.workflow_nodes.filter(
    (item) => item.workflow_id === workflowExecution.workflow_id && item.role === 'workstream'
  )) {
    const taskIds = new Set(
        state.workflow_nodes
          .filter((item) => item.parent_node_id === workstream.id && item.required !== false)
          .map((item) => item.id)
      ),
      tasks = executions.filter((item) => taskIds.has(item.task_id));
    if (!tasks.length || tasks.some((item) => item.status !== 'completed')) continue;
    const existing = state.assets.find(
      (item) =>
        item.node_id === workstream.id &&
        item.asset_type === 'WorkstreamOutcomeAsset' &&
        item.provenance_workflow_execution_id === workflowExecutionId &&
        item.status === 'confirmed'
    );
    if (existing) {
      outcomes.push(existing);
      continue;
    }
    const bindings = tasks.flatMap((item) => item.output_bindings || []),
      line = state.repository_lines.find(
        (item) => item.workflow_execution_id === workflowExecutionId && item.workstream_id === workstream.id
      );
    if (line && line.status !== 'merged') continue;
    const payload = {
      payload_kind: 'json',
      media_type: 'application/json',
      content: {
        schema_version: 'aiws.workstream_outcome.v1',
        workflow_execution_id: workflowExecutionId,
        workstream_id: workstream.id,
        workflow_revision: workflowExecution.workflow_revision,
        terminal_task_executions: tasks.map((item) => ({
          id: item.id,
          task_id: item.task_id,
          attempt: item.attempt,
          input_snapshot_hash: item.input_snapshot_hash,
          output_bindings: item.output_bindings
        })),
        repository_line: line
          ? {
              id: line.id,
              base_sha: line.base_sha,
              head_sha: line.head_sha,
              merged_sha: line.merged_sha,
              pr_number: line.pr_number
            }
          : null
      }
    };
    const asset = createAssetRecord({
      projectId: workflowExecution.project_id,
      workspaceId: workstream.workspace_id,
      taskId: workstream.id,
      taskExecutionId: null,
      assetType: 'WorkstreamOutcomeAsset',
      title: `${workstream.title} outcome`,
      summary: workstream.outcome || workstream.goal,
      outputKey: 'workstream_outcome',
      actorId: workflowExecution.created_by_user_id
    });
    Object.assign(asset, {
      confirmation_policy: 'system_evidence',
      provenance_workflow_execution_id: workflowExecutionId
    });
    state.assets.push(asset);
    const version = await createImmutableAssetVersion(state, {
      asset,
      payload,
      title: asset.title,
      summary: asset.summary,
      evidenceRefs: [
        ...bindings.map((item) => `asset-version:${item.version_id}`),
        ...(line?.merged_sha ? [`merge:${line.merged_sha}`] : [])
      ],
      repositorySha: line?.merged_sha || line?.head_sha || null,
      provenance: {
        source: 'workstream_execution',
        workflow_execution_id: workflowExecutionId,
        workstream_id: workstream.id
      },
      actorId: workflowExecution.created_by_user_id
    });
    recordAssetLineage(state, { inputs: [{ asset_versions: bindings }] }, [
      { asset_id: asset.id, version_id: version.id }
    ]);
    await attestAssetVersionInState(state, {
      assetId: asset.id,
      versionId: version.id,
      expectedSha256: version.content_sha256,
      outputKey: 'workstream_outcome',
      decision: 'accepted',
      attestorType: 'trusted_verifier',
      attestorId: 'aiws_cas_verifier',
      evidence: {
        workflow_execution_id: workflowExecutionId,
        terminal_output_bindings: bindings,
        external_snapshot_sha256: version.content_sha256,
        repository_line: line ? { id: line.id, merged_sha: line.merged_sha, pr_number: line.pr_number } : null
      }
    });
    outcomes.push(asset);
    appendExecutionEvent(
      state,
      workflowExecution,
      null,
      'workstream.outcome_created',
      { workstream_id: workstream.id, asset_id: asset.id, version_id: version.id },
      'system',
      null
    );
  }
  return outcomes;
}

export async function recoverWorkflowExecutionsInState(state) {
  const recovered = [];
  for (const workflow of state.workflow_executions.filter((item) => ['running', 'paused'].includes(item.status))) {
    for (const execution of currentTaskExecutions(state, workflow.id)) {
      if (!['running', 'verifying'].includes(execution.status)) continue;
      if (execution.lease && Date.parse(execution.lease.expires_at) > Date.now()) continue;
      failTaskExecutionInState(state, execution.id, { errorCode: 'service_restarted', retryClass: 'transient' });
      const attempts = state.task_executions.filter(
        (item) => item.workflow_execution_id === workflow.id && item.task_id === execution.task_id
      );
      if (attempts.length < 2) recovered.push(retryTaskExecutionInState(state, execution.id, null));
    }
    reconcileWorkflowExecutionInState(state, workflow.id, { autoQueue: workflow.status === 'running' });
  }
  return recovered;
}

export async function recoverPersistentWorkflowExecutions() {
  return mutate((state) => recoverWorkflowExecutionsInState(state));
}

export async function collectActualEvidenceInState(state, execution) {
  const line = state.repository_lines.find(
    (item) =>
      item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
  );
  if (execution.executor === 'repository_change') {
    if (!line) throw new HttpError(409, { error: 'repository_line_missing' });
    return finalizeRepositoryChangeInState(state, execution, line);
  }
  if (execution.executor === 'repository_verify') {
    if (!line) throw new HttpError(409, { error: 'repository_line_missing' });
    const before = await verifyRepositoryLineHead(line, line.head_sha, { requireClean: true }),
      commands = await runApprovedVerificationCommands(state, execution, line);
    const after = await verifyRepositoryLineHead(line, line.head_sha, { requireClean: true });
    if (before.repository_sha !== after.repository_sha)
      throw new HttpError(409, { error: 'repository_verify_head_changed' });
    if (!commands.length) throw new HttpError(409, { error: 'repository_verify_commands_required' });
    if (commands.some((item) => item.exit_code !== 0))
      throw new HttpError(409, { error: 'repository_verify_failed', commands });
    return {
      repository_sha: line.head_sha,
      checkout_head: after.repository_sha,
      commands,
      test_results: commands,
      evidence_refs: commands.map((item) => `cas:${item.log_sha256}`)
    };
  }
  if (execution.executor === 'assist' && line) {
    const verified = await verifyRepositoryLineHead(
      line,
      execution.context_snapshot?.repository_snapshot?.fixed_sha || line.head_sha,
      { requireClean: true }
    );
    return { repository_sha: verified.repository_sha, checkout_head: verified.repository_sha, read_only: true };
  }
  return execution.evidence || {};
}

async function runApprovedVerificationCommands(state, execution, line) {
  const policy = state.delivery_policies
    .filter(
      (item) =>
        item.workstream_id === execution.workstream_id &&
        item.connection_id === line.connection_id &&
        item.status === 'approved'
    )
    .sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at)))[0];
  const commands = policy?.test_commands || [];
  const results = [];
  for (const command of commands) {
    const shell =
      process.platform === 'win32'
        ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
        : { command: '/bin/sh', args: ['-lc', command] };
    const run = spawnSync(shell.command, shell.args, {
      cwd: line.checkout_path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: 10 * 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    const raw = Buffer.from(`${run.stdout || ''}${run.stderr || ''}`, 'utf8'),
      blob = await registerCasBlob(state, raw, { mediaType: 'text/plain; charset=utf-8' });
    results.push({
      command,
      exit_code: run.status ?? -1,
      status: run.status === 0 && !run.error ? 'passed' : 'failed',
      log_sha256: blob.sha256,
      raw_log_sha256: blob.sha256,
      size_bytes: blob.size_bytes,
      error_code: run.error?.code || null
    });
  }
  return results;
}

export async function retryTaskExecution(taskExecutionId, actorId) {
  return mutate((state) => retryTaskExecutionInState(state, taskExecutionId, actorId));
}
export async function taskExecutionReadiness(taskExecutionId) {
  const state = await readState(),
    execution = requireTaskExecution(state, taskExecutionId);
  return { task_execution: execution, readiness: execution.readiness };
}

function receiverFor(executor) {
  return (
    {
      assist: 'AssistExecutor',
      manual: 'ManualExecutor',
      repository_change: 'RepositoryChangeExecutor',
      repository_verify: 'RepositoryVerifyExecutor',
      repository_integrate: 'RepositoryIntegrateExecutor'
    }[executor] || 'TaskExecutor'
  );
}
function verifierFor(executor) {
  return (
    {
      repository_change: 'repository_change_verifier',
      repository_verify: 'repository_verify_verifier',
      repository_integrate: 'repository_integrate_verifier'
    }[executor] || null
  );
}
