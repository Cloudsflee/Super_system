import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { RunnerStatus, id, now } from '../../../packages/shared/index.mjs';
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
import { synchronizeRepositoryLineDependencyBase, verifyRepositoryLineHead } from './repository-line-service.mjs';
import { mutate, readState } from './state.mjs';
import {
  EXECUTION_INPUT_HASH_VERSION,
  executionInputHash,
  inspectWorkstreamDependencyHandoff,
  prepareTaskExecutionContext
} from './task-execution-context.mjs';
import { ensureContextProjection } from './context-service.mjs';
import { beginExecutionStageInState, completeExecutionStageInState } from './execution-stage-service.mjs';
import { effectClaimsForOutput, validateRequestedEffectClaims } from './task-effect-claims.mjs';
import {
  appendExecutionEvent,
  completeTaskExecutionInState,
  currentTaskExecutions,
  failTaskExecutionInState,
  issueTaskExecutionLeaseInState,
  integrationEvidenceFor,
  reconcileWorkflowExecutionInState,
  requireTaskExecution,
  retryTaskExecutionInState,
  transitionTaskExecutionInState
} from './workflow-execution-domain.mjs';

export async function prepareTaskExecutionInState(state, taskExecutionId, { allowCompletedTask = false } = {}) {
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
    allowCompletedTask,
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
  prepared.context.input_snapshot_hash_version = EXECUTION_INPUT_HASH_VERSION;
  const retryHashVersion = Number(execution.retry_input_snapshot_hash_version || 1);
  if (
    execution.retry_input_snapshot_hash &&
    retryHashVersion === EXECUTION_INPUT_HASH_VERSION &&
    execution.retry_input_snapshot_hash !== prepared.context.input_snapshot_hash
  )
    throw new HttpError(409, {
      error: 'task_execution_retry_input_changed',
      expected_input_snapshot_hash: execution.retry_input_snapshot_hash,
      actual_input_snapshot_hash: prepared.context.input_snapshot_hash
    });
  if (execution.retry_input_snapshot_hash && retryHashVersion !== EXECUTION_INPUT_HASH_VERSION) {
    appendExecutionEvent(
      state,
      workflowExecution,
      execution,
      'task.retry_input_hash_upgraded',
      { from_version: retryHashVersion, to_version: EXECUTION_INPUT_HASH_VERSION },
      'system',
      null
    );
    execution.retry_input_snapshot_hash = null;
    execution.retry_input_snapshot_hash_version = null;
  }
  prepared.context_pack.task_execution_context = structuredClone(prepared.context);
  prepared.context_pack.input_snapshot_hash = prepared.context.input_snapshot_hash;
  prepared.context_pack.input_snapshot_hash_version = prepared.context.input_snapshot_hash_version;
  execution.context_snapshot = structuredClone(prepared.context);
  execution.input_snapshot_hash = prepared.context.input_snapshot_hash;
  execution.input_snapshot_hash_version = prepared.context.input_snapshot_hash_version;
  execution.repository_snapshot_hash = prepared.context.repository_snapshot?.snapshot_hash || null;
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
  await synchronizeTaskExecutionRepositoryLine(taskExecutionId);
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
  {
    outputs,
    leaseToken = null,
    verifierId = null,
    actualEvidence = null,
    actorId = null,
    manual = false,
    declaredConsumedInputVersions = null,
    declaredInputDispositions = null,
    declaredConsumedContextDocumentVersions = null,
    declaredContextDispositions = null,
    declaredInputEffects = null,
    declaredContextEffects = null
  }
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
      declaredConsumedInputVersions,
      declaredInputDispositions,
      declaredConsumedContextDocumentVersions,
      declaredContextDispositions,
      declaredInputEffects,
      declaredContextEffects,
      actorId,
      verifierId: verifierId || verifierFor(execution.executor),
      actualEvidence: evidence
    });
    const contributionReviewRequired = execution.context_snapshot?.schema_version === 'aiws.task_execution_context.v5';
    if (manual && ingested.awaiting_human.length && !contributionReviewRequired) {
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

export async function approveTaskExecution(
  taskExecutionId,
  { decision, expectedVersions, acceptedEffectClaimIds = [], actorId, summary = '' }
) {
  return mutate(async (state) => {
    const execution = requireTaskExecution(state, taskExecutionId);
    if (execution.status !== 'awaiting_human')
      throw new HttpError(409, { error: 'task_execution_not_awaiting_human', status: execution.status });
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, { error: 'human_decision_invalid' });
    const contract = state.node_contracts.find((item) => item.id === execution.contract_id),
      expected = Array.isArray(expectedVersions) ? expectedVersions : [];
    const humanSlots = (contract?.expected_outputs || []).filter(
        (item) => item.confirmation_policy === 'human' && item.required !== false
      ),
      acceptedClaims = validateRequestedEffectClaims(execution, acceptedEffectClaimIds);
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
        acceptedEffectClaimIds: acceptedClaims.filter((claimId) =>
          effectClaimsForOutput(execution, item.slot.key).some((effect) => effect.claim_id === claimId)
        ),
        summary
      });
    if (decision === 'reject')
      failTaskExecutionInState(state, execution.id, {
        errorCode: 'human_changes_requested',
        retryClass: 'deterministic'
      });
    else {
      const evidence =
        execution.executor === 'repository_integrate' && !Object.keys(execution.evidence || {}).length
          ? integrationEvidenceFor(state, execution)
          : execution.evidence || {};
      const promoteToken =
        Number(state.schema_version || 0) >= 21
          ? beginExecutionStageInState(state, {
              workflowExecutionId: execution.workflow_execution_id,
              taskExecutionId: execution.id,
              stage: 'promote',
              input: { human_attestation: true, output_bindings: execution.output_bindings || [] }
            })
          : null;
      completeTaskExecutionInState(state, execution.id, {
        evidence: { ...evidence, human_attestation: true }
      });
      if (promoteToken)
        completeExecutionStageInState(state, promoteToken, {
          output: { status: execution.status, output_bindings: execution.output_bindings || [] }
        });
    }
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
    const taskNodes = state.workflow_nodes.filter(
        (item) => item.parent_node_id === workstream.id && item.required !== false
      ),
      taskIds = new Set(taskNodes.map((item) => item.id)),
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
    const terminalTaskIds = new Set(
        taskNodes
          .filter((task) => !taskNodes.some((candidate) => nodeDependencyIds(candidate).includes(task.id)))
          .map((item) => item.id)
      ),
      bindings = tasks.flatMap((item) => item.output_bindings || []),
      terminalBindings = tasks
        .filter((item) => terminalTaskIds.has(item.task_id))
        .flatMap((item) =>
          (item.output_bindings || []).map((binding) => {
            const contract = state.node_contracts.find((entry) => entry.id === item.contract_id),
              outputSlot = (contract?.expected_outputs || []).find((slot) => slot.key === binding.key);
            return {
              ...structuredClone(binding),
              required: outputSlot?.required !== false,
              producer_task_id: item.task_id,
              producer_task_execution_id: item.id
            };
          })
        ),
      handoffBindings = terminalBindings.filter((binding) => binding.handoff !== false),
      line = state.repository_lines.find(
        (item) => item.workflow_execution_id === workflowExecutionId && item.workstream_id === workstream.id
      );
    if (!handoffBindings.length)
      throw new HttpError(409, {
        error: 'workstream_handoff_outputs_missing',
        workstream_id: workstream.id,
        terminal_task_ids: [...terminalTaskIds]
      });
    if (line && line.status !== 'merged') continue;
    const payload = {
      payload_kind: 'json',
      media_type: 'application/json',
      content: {
        schema_version: 'aiws.workstream_outcome.v1',
        workflow_execution_id: workflowExecutionId,
        workstream_id: workstream.id,
        workflow_revision: workflowExecution.workflow_revision,
        handoff_output_bindings: handoffBindings,
        terminal_output_bindings: terminalBindings,
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
    recordWorkstreamOutcomeEvidence(state, bindings, asset, version, workflowExecutionId);
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
        handoff_output_bindings: handoffBindings,
        terminal_output_bindings: terminalBindings,
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

export async function runApprovedVerificationCommands(state, execution, line) {
  const policy = state.delivery_policies
    .filter(
      (item) =>
        item.workstream_id === execution.workstream_id &&
        item.connection_id === line.connection_id &&
        item.status === 'approved' &&
        (!item.expires_at || Date.parse(item.expires_at) > Date.now())
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

export async function retryTaskExecution(taskExecutionId, actorId, { recoverPartialResult = false } = {}) {
  const dependencySync = recoverPartialResult
    ? { changed: false }
    : await synchronizeTaskExecutionRepositoryLine(taskExecutionId);
  return mutate(async (state) => {
    const previous = requireTaskExecution(state, taskExecutionId);
    if (!recoverPartialResult) {
      const retry = retryTaskExecutionInState(state, taskExecutionId, actorId);
      if (dependencySync.changed) {
        retry.retry_input_snapshot_hash = null;
        retry.retry_input_snapshot_hash_version = null;
        retry.repository_dependency_refresh = {
          repository_line_id: dependencySync.line.id,
          previous_sha: dependencySync.previous_sha,
          target_sha: dependencySync.target_sha,
          refreshed_at: now()
        };
      }
      return retry;
    }
    const sourceRun = recoverablePartialRepositoryChangeRun(state, previous);
    if (!sourceRun)
      throw new HttpError(409, {
        error: 'repository_change_partial_result_not_recoverable',
        task_execution_id: previous.id
      });
    const sourceExecution = state.task_executions.find((item) => item.id === sourceRun.task_execution_id);
    if (!sourceExecution)
      throw new HttpError(409, {
        error: 'repository_change_recovery_source_missing',
        task_execution_id: sourceRun.task_execution_id
      });
    const retry = retryTaskExecutionInState(state, previous.id, actorId);
    return recoverPartialRepositoryChangeInState(state, sourceExecution, retry, sourceRun, actorId, previous.id);
  });
}

export async function synchronizeTaskExecutionRepositoryLine(taskExecutionId) {
  const state = await readState(),
    execution = requireTaskExecution(state, taskExecutionId);
  if (execution.context_snapshot && execution.status !== 'failed') return { changed: false };
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    contract = state.node_contracts.find((item) => item.id === execution.contract_id),
    line = state.repository_lines.find(
      (item) =>
        item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
    );
  if (!task || !contract || !line) return { changed: false };
  const hashes = new Set();
  for (const slot of (contract.expected_inputs || []).filter((item) => item.source === 'workstream_dependency')) {
    const handoff = inspectWorkstreamDependencyHandoff(state, {
      projectId: execution.project_id,
      workflowId: execution.workflow_id,
      workflowExecutionId: execution.workflow_execution_id,
      workstreamId: slot.ref_id,
      selector: slot.selector || 'required_outputs',
      strict: true
    });
    if (!handoff.ready) continue;
    for (const version of handoff.asset_versions || []) if (version.repository_sha) hashes.add(version.repository_sha);
  }
  if (!hashes.size) return { changed: false };
  if (hashes.size !== 1)
    throw new HttpError(409, { error: 'repository_dependency_sha_ambiguous', repository_shas: [...hashes] });
  return synchronizeRepositoryLineDependencyBase(line.id, [...hashes][0]);
}

export function recoverablePartialRepositoryChangeRun(state, execution) {
  if (execution?.status !== 'failed' || execution.executor !== 'repository_change') return null;
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id),
    executionIds = repositoryChangeRetryAncestry(state, execution),
    requiredKeys = new Set(
      (contract?.expected_outputs || []).filter((item) => item.required !== false).map((item) => item.key)
    );
  return (
    state.node_runs
      .filter((run) => {
        const result = run.result_json,
          outputKeys = new Set((result?.outputs || []).map((item) => item.output_key));
        return (
          executionIds.has(run.task_execution_id) &&
          run.status === RunnerStatus.Failed &&
          ['aiws.task_runner_result.v2', 'aiws.task_runner_result.v3', 'aiws.task_runner_result.v4'].includes(
            result?.schema_version
          ) &&
          [RunnerStatus.Partial, RunnerStatus.Succeeded].includes(result.status) &&
          Number(result._codex_process?.code) === 0 &&
          !result._codex_process?.failure_code &&
          requiredKeys.size > 0 &&
          [...requiredKeys].every((key) => outputKeys.has(key))
        );
      })
      .sort((left, right) =>
        String(right.completed_at || right.updated_at).localeCompare(String(left.completed_at || left.updated_at))
      )[0] || null
  );
}

function repositoryChangeRetryAncestry(state, execution) {
  const ids = new Set([execution.id]);
  let current = execution;
  for (let depth = 0; depth < 100 && current.supersedes_id; depth += 1) {
    const ancestor = state.task_executions.find((item) => item.id === current.supersedes_id);
    if (
      !ancestor ||
      ancestor.workflow_execution_id !== execution.workflow_execution_id ||
      ancestor.task_id !== execution.task_id ||
      ancestor.workstream_id !== execution.workstream_id ||
      ancestor.executor !== execution.executor ||
      ancestor.contract_id !== execution.contract_id ||
      ancestor.task_revision !== execution.task_revision
    )
      break;
    ids.add(ancestor.id);
    current = ancestor;
  }
  return ids;
}

async function recoverPartialRepositoryChangeInState(
  state,
  sourceExecution,
  retry,
  sourceRun,
  actorId,
  requestedFromTaskExecutionId
) {
  if (retry.status !== 'queued')
    throw new HttpError(409, { error: 'repository_change_partial_recovery_not_queued', status: retry.status });
  const context = structuredClone(sourceExecution.context_snapshot);
  if (!context) throw new HttpError(409, { error: 'repository_change_partial_context_missing' });
  context.task_execution_id = retry.id;
  context.recovery_source = {
    task_execution_id: sourceExecution.id,
    node_run_id: sourceRun.id,
    result_status: sourceRun.result_json.status
  };
  const inputHash = executionInputHash(context);
  if (sourceExecution.input_snapshot_hash && inputHash !== sourceExecution.input_snapshot_hash)
    throw new HttpError(409, {
      error: 'repository_change_partial_input_mismatch',
      expected_input_snapshot_hash: sourceExecution.input_snapshot_hash,
      actual_input_snapshot_hash: inputHash
    });
  Object.assign(retry, {
    context_snapshot: context,
    input_snapshot_hash: inputHash,
    input_snapshot_hash_version: sourceExecution.input_snapshot_hash_version || EXECUTION_INPUT_HASH_VERSION,
    repository_snapshot_hash:
      sourceExecution.repository_snapshot_hash || context.repository_snapshot?.snapshot_hash || null,
    recovery_source_task_execution_id: sourceExecution.id,
    recovery_source_node_run_id: sourceRun.id
  });
  transitionTaskExecutionInState(state, retry, 'running', { reason: 'partial_repository_change_recovery' });
  const evidence = await collectActualEvidenceInState(state, retry),
    result = sourceRun.result_json,
    ingested = await ingestExecutionOutputsInState(state, {
      taskExecution: retry,
      outputs: result.outputs,
      declaredConsumedInputVersions: result.consumed_input_versions,
      declaredInputDispositions: result.input_dispositions,
      declaredConsumedContextDocumentVersions: result.consumed_context_document_versions,
      declaredContextDispositions: result.context_dispositions,
      declaredInputEffects: result.input_effects,
      declaredContextEffects: result.context_effects,
      actorId,
      verifierId: 'repository_change_verifier',
      actualEvidence: evidence,
      nodeRunId: sourceRun.id
    });
  if (ingested.awaiting_human.length)
    throw new HttpError(409, { error: 'repository_change_partial_recovery_human_checkpoint' });
  completeTaskExecutionInState(state, retry.id, { evidence });
  appendExecutionEvent(
    state,
    state.workflow_executions.find((item) => item.id === retry.workflow_execution_id),
    retry,
    'task.partial_repository_change_recovered',
    {
      source_task_execution_id: sourceExecution.id,
      source_node_run_id: sourceRun.id,
      requested_from_task_execution_id: requestedFromTaskExecutionId
    },
    'user',
    actorId
  );
  await ensureCompletedWorkstreamOutcomesInState(state, retry.workflow_execution_id);
  reconcileWorkflowExecutionInState(state, retry.workflow_execution_id);
  return retry;
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

function nodeDependencyIds(node) {
  const source = Array.isArray(node?.dependency_ids) ? node.dependency_ids : node?.dependencies || [];
  return source.map((item) => (typeof item === 'string' ? item : item?.node_id)).filter(Boolean);
}

function recordWorkstreamOutcomeEvidence(state, bindings, outcomeAsset, outcomeVersion, workflowExecutionId) {
  const seen = new Set();
  for (const binding of bindings) {
    if (!binding?.asset_id || !binding?.version_id || seen.has(binding.version_id)) continue;
    seen.add(binding.version_id);
    if (
      state.asset_relations.some(
        (item) =>
          item.relation_type === 'evidenced_by' &&
          item.source_asset_version_id === binding.version_id &&
          item.target_asset_version_id === outcomeVersion.id
      )
    )
      continue;
    state.asset_relations.push({
      id: id('arl'),
      relation_type: 'evidenced_by',
      source_asset_id: binding.asset_id,
      source_asset_version_id: binding.version_id,
      target_asset_id: outcomeAsset.id,
      target_asset_version_id: outcomeVersion.id,
      input_snapshot_hash: null,
      execution_id: null,
      workflow_execution_id: workflowExecutionId,
      created_at: now()
    });
  }
}
