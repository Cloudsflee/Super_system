import { id, now } from '../../../packages/shared/index.mjs';
import { addTrace, mutate, readState } from './state.mjs';
import { HttpError, commandAsync } from './http.mjs';
import { git } from './git-utils.mjs';
import { refreshRepositoryMirror, repositoryGitAuthEnv } from './repository-workspace-service.mjs';
import { createAssetRecord, createImmutableAssetVersion } from './asset-cas.mjs';
import { attestAssetVersionInState, ingestExecutionOutputsInState } from './asset-attestation-service.mjs';
import { collectActualEvidenceInState, prepareTaskExecutionInState } from './task-execution-service.mjs';
import { executionInputHash } from './task-execution-context.mjs';
import {
  appendExecutionEvent,
  completeTaskExecutionInState,
  reconcileWorkflowExecutionInState,
  requireTaskExecution,
  transitionTaskExecutionInState
} from './workflow-execution-domain.mjs';
import { revokePullRequestIntentInState } from './pull-request-intent-domain.mjs';
import { prepareRepositoryIntegration } from './repository-integration-service.mjs';

const SHA = /^[a-f0-9]{40,64}$/i;

/**
 * Reopens the repository handoff when a PR branch was rebuilt after its base
 * advanced. All old outputs remain immutable history, but are made
 * non-consumable and a fresh remediation -> acceptance -> integration chain
 * is produced for the exact remote commit.
 */
// The recovery transaction intentionally keeps the invalidation and revalidation
// steps together so a failed handoff cannot leave a partially reopened chain.
// eslint-disable-next-line max-lines-per-function, complexity
export async function reopenRepositoryIntegration(taskExecutionId, input = {}, actorId) {
  const initial = await readState();
  const previousIntegration = requireTaskExecution(initial, taskExecutionId);
  if (previousIntegration.executor !== 'repository_integrate')
    throw new HttpError(409, { error: 'repository_reconciliation_executor_invalid' });
  if (!['awaiting_human', 'failed'].includes(previousIntegration.status))
    throw new HttpError(409, {
      error: 'repository_reconciliation_status_invalid',
      status: previousIntegration.status
    });
  const line = initial.repository_lines.find(
    (item) =>
      item.workflow_execution_id === previousIntegration.workflow_execution_id &&
      item.workstream_id === previousIntegration.workstream_id
  );
  if (!line) throw new HttpError(404, { error: 'repository_line_not_found' });
  const expectedHead = normalizeExpected(input.expected_head_sha, line.head_sha),
    expectedBase = normalizeExpected(input.expected_base_sha, line.base_sha),
    connection = initial.repository_connections.find((item) => item.id === line.connection_id);
  if (!connection) throw new HttpError(409, { error: 'repository_connection_required' });

  const catalog = await refreshRepositoryMirror(initial, line.project_id, line.connection_id, { fetch: true }),
    base = catalog.branches.find((item) => item.name === line.base_ref),
    head = catalog.branches.find((item) => item.name === line.branch);
  if (!base) throw new HttpError(409, { error: 'repository_base_ref_not_found', ref: line.base_ref });
  if (!head) throw new HttpError(409, { error: 'repository_head_ref_not_found', ref: line.branch });
  const nextBase = String(base.sha).toLowerCase(),
    nextHead = String(head.sha).toLowerCase();
  if (!SHA.test(nextBase) || !SHA.test(nextHead)) throw new HttpError(409, { error: 'repository_remote_sha_invalid' });
  if (expectedHead && expectedHead !== String(line.head_sha || '').toLowerCase())
    throw new HttpError(409, {
      error: 'repository_line_head_changed',
      expected_sha: expectedHead,
      actual_sha: line.head_sha
    });
  if (expectedBase && expectedBase !== String(line.base_sha || '').toLowerCase())
    throw new HttpError(409, {
      error: 'repository_line_base_changed',
      expected_sha: expectedBase,
      actual_sha: line.base_sha
    });
  if (nextHead === String(line.head_sha || '').toLowerCase() && nextBase === String(line.base_sha || '').toLowerCase())
    throw new HttpError(409, { error: 'repository_reconciliation_not_required' });

  await syncLineCheckout(initial, line, nextHead);
  const mergeParents = commitParentsFor(line.checkout_path, nextHead),
    changedFiles = changedFilesFor(line.checkout_path, line.head_sha, nextHead),
    conflictEvidence = {
      schema_version: 'aiws.repository_conflict_evidence.v1',
      reason: 'base_advanced',
      repository_line_id: line.id,
      branch: line.branch,
      base_ref: line.base_ref,
      previous_base_sha: line.base_sha,
      current_base_sha: nextBase,
      previous_head_sha: line.head_sha,
      current_head_sha: nextHead,
      merge_commit: mergeParents.length > 1,
      merge_parents: mergeParents,
      changed_files: changedFiles
    };
  // The transaction deliberately keeps invalidation and revalidation atomic.
  // eslint-disable-next-line max-lines-per-function, complexity
  const result = await mutate(async (state) => {
    const currentIntegration = requireTaskExecution(state, taskExecutionId),
      currentLine = state.repository_lines.find((item) => item.id === line.id);
    if (!currentLine) throw new HttpError(404, { error: 'repository_line_not_found' });
    if (String(currentLine.head_sha || '').toLowerCase() !== String(line.head_sha || '').toLowerCase())
      throw new HttpError(409, {
        error: 'repository_line_head_changed',
        expected_sha: line.head_sha,
        actual_sha: currentLine.head_sha
      });
    const workflow = state.workflow_executions.find((item) => item.id === currentIntegration.workflow_execution_id),
      workstreamTasks = state.workflow_nodes.filter(
        (item) => item.parent_node_id === currentIntegration.workstream_id && item.role === 'task'
      );
    if (!workflow) throw new HttpError(409, { error: 'workflow_execution_not_found' });

    const integrationContract = state.node_contracts.find((item) => item.id === currentIntegration.contract_id),
      acceptanceTaskId = integrationContract?.expected_inputs?.find(
        (slot) => slot.source === 'dependency' && slot.ref_id
      )?.ref_id,
      priorAcceptance =
        latestTaskExecutionForTask(state, acceptanceTaskId) ||
        latestTaskExecution(state, workstreamTasks, 'repository_verify'),
      acceptanceContract = priorAcceptance
        ? state.node_contracts.find((item) => item.id === priorAcceptance.contract_id)
        : null,
      remediationTaskId = acceptanceContract?.expected_inputs?.find(
        (slot) => slot.source === 'dependency' && slot.ref_id
      )?.ref_id,
      priorRemediation =
        latestTaskExecutionForTask(state, remediationTaskId) ||
        latestTaskExecution(state, workstreamTasks, 'repository_change');
    if (!priorRemediation || !priorAcceptance)
      throw new HttpError(409, { error: 'repository_reconciliation_upstream_missing' });

    const remediationTask = state.workflow_nodes.find((item) => item.id === priorRemediation.task_id),
      acceptanceTask = state.workflow_nodes.find((item) => item.id === priorAcceptance.task_id);
    if (!remediationTask || !acceptanceTask)
      throw new HttpError(409, { error: 'repository_reconciliation_task_missing' });

    supersedeExecution(state, priorAcceptance, 'repository_base_advanced');
    supersedeExecution(state, currentIntegration, 'repository_base_advanced');
    supersedeExecution(state, priorRemediation, 'repository_base_advanced');

    const remediation = nextAttempt(priorRemediation, actorId),
      acceptance = nextAttempt(priorAcceptance, actorId),
      integration = nextAttempt(currentIntegration, actorId);
    state.task_executions.push(remediation, acceptance, integration);
    remediationTask.current_task_execution_id = remediation.id;
    remediationTask.current_attempt = remediation.attempt;
    acceptanceTask.current_task_execution_id = acceptance.id;
    acceptanceTask.current_attempt = acceptance.attempt;
    const integrationTask = state.workflow_nodes.find((item) => item.id === currentIntegration.task_id);
    if (integrationTask) {
      integrationTask.current_task_execution_id = integration.id;
      integrationTask.current_attempt = integration.attempt;
    }

    const oldIntent = state.pull_request_intents.find((item) => item.id === currentLine.pull_request_intent_id);
    if (oldIntent && !['revoked', 'expired', 'closed', 'merged'].includes(oldIntent.status))
      revokePullRequestIntentInState(state, oldIntent.id, { expected_revision: oldIntent.revision }, actorId);

    Object.assign(currentLine, {
      base_sha: nextBase,
      head_sha: nextHead,
      status: 'active',
      pull_request_intent_id: null,
      pr_number: null,
      pr_url: null,
      pr_state: null,
      merged_sha: null,
      error_code: null,
      updated_at: now()
    });
    const selection = workflow.repository_selection?.find((item) => item.workstream_id === currentLine.workstream_id);
    if (selection) selection.base_sha = nextBase;

    const conflict = await createConflictEvidence(
      state,
      currentIntegration.project_id,
      remediationTask,
      conflictEvidence,
      nextHead,
      actorId,
      remediation
    );
    await prepareTaskExecutionInState(state, remediation.id, { allowCompletedTask: true });
    attachOptionalInput(remediation, conflict);
    transitionTaskExecutionInState(state, remediation, 'running', { reason: 'repository_conflict_reopened' });
    const remediationEvidence = {
      repository_sha: nextHead,
      commit_sha: nextHead,
      checkout_head: nextHead,
      previous_sha: line.head_sha,
      previous_base_sha: line.base_sha,
      current_base_sha: nextBase,
      changed_files: changedFiles,
      conflict_evidence_version_id: conflict.version.id,
      evidence_refs: [`commit:${nextHead}`, `conflict:${conflict.version.content_sha256}`],
      repository_payload: {
        payload_kind: 'json',
        media_type: 'application/vnd.aiws.repository-version+json',
        content: {
          schema_version: 'aiws.repository_version.v1',
          repository_sha: nextHead,
          previous_sha: line.head_sha,
          base_sha: nextBase,
          branch: line.branch,
          changed_files: changedFiles,
          conflict_evidence_version_id: conflict.version.id,
          verifier: 'aiws.repository_reconciliation'
        }
      }
    };
    const remediationInputs = inputVersionIds(remediation);
    const remediationOutputs = [
      {
        output_key: 'code_change',
        asset_type: 'CodeChangeAsset',
        title: `冲突重开代码变更 ${nextHead.slice(0, 12)}`,
        summary: '基于新 base 合并提交重新确认代码变更，旧版本保留为历史证据。',
        payload: { payload_kind: 'json', media_type: 'application/json', content: remediationEvidence },
        consumed_input_versions: remediationInputs
      },
      {
        output_key: 'repository_version',
        asset_type: 'RepositoryVersionAsset',
        title: `Repository version ${nextHead.slice(0, 12)}`,
        summary: '冲突事实已处理后的远端合并提交。',
        payload: { payload_kind: 'json', media_type: 'application/json', content: remediationEvidence },
        consumed_input_versions: remediationInputs
      }
    ];
    const remediationIngested = await ingestExecutionOutputsInState(state, {
      taskExecution: remediation,
      outputs: remediationOutputs,
      actorId,
      verifierId: 'repository_change_verifier',
      actualEvidence: remediationEvidence
    });
    if (remediationIngested.awaiting_human.length)
      throw new HttpError(409, { error: 'repository_reconciliation_remediation_review_required' });
    remediation.evidence = remediationEvidence;
    completeTaskExecutionInState(state, remediation.id, { evidence: remediationEvidence });

    await prepareTaskExecutionInState(state, acceptance.id, { allowCompletedTask: true });
    transitionTaskExecutionInState(state, acceptance, 'running', { reason: 'repository_revalidation_started' });
    const acceptanceEvidence = await collectActualEvidenceInState(state, acceptance),
      acceptanceInputs = inputVersionIds(acceptance),
      acceptanceOutputs = [
        {
          output_key: 'test_evidence',
          asset_type: 'TestEvidenceAsset',
          title: `test_evidence verification ${nextHead.slice(0, 12)}`,
          summary: '在新合并提交上重新执行离线验收。',
          payload: { payload_kind: 'test_report', media_type: 'application/json', content: acceptanceEvidence },
          consumed_input_versions: acceptanceInputs
        },
        {
          output_key: 'accepted_repository_version',
          asset_type: 'AcceptedRepositoryVersionAsset',
          title: `accepted_repository_version ${nextHead.slice(0, 12)}`,
          summary: '测试证据与仓库快照 SHA 完全一致。',
          payload: { payload_kind: 'json', media_type: 'application/json', content: acceptanceEvidence },
          consumed_input_versions: acceptanceInputs
        }
      ];
    const acceptanceIngested = await ingestExecutionOutputsInState(state, {
      taskExecution: acceptance,
      outputs: acceptanceOutputs,
      actorId,
      verifierId: 'repository_verify_verifier',
      actualEvidence: acceptanceEvidence
    });
    if (acceptanceIngested.awaiting_human.length)
      throw new HttpError(409, { error: 'repository_reconciliation_acceptance_review_required' });
    acceptance.evidence = acceptanceEvidence;
    completeTaskExecutionInState(state, acceptance.id, { evidence: acceptanceEvidence });

    appendExecutionEvent(
      state,
      workflow,
      remediation,
      'repository.reconciliation.completed',
      {
        previous_head_sha: line.head_sha,
        current_head_sha: nextHead,
        previous_base_sha: line.base_sha,
        current_base_sha: nextBase,
        conflict_evidence_version_id: conflict.version.id,
        acceptance_task_execution_id: acceptance.id
      },
      'user',
      actorId
    );
    addTrace(
      state,
      'integration.synced',
      {
        project_id: currentLine.project_id,
        target_type: 'repository_line',
        target_id: currentLine.id,
        summary: `Repository line revalidated at ${nextHead.slice(0, 12)}`,
        data: {
          previous_head_sha: line.head_sha,
          current_head_sha: nextHead,
          previous_base_sha: line.base_sha,
          current_base_sha: nextBase,
          conflict_evidence_version_id: conflict.version.id,
          superseded_task_execution_ids: [priorRemediation.id, priorAcceptance.id, currentIntegration.id]
        }
      },
      actorId
    );
    const reconciled = reconcileWorkflowExecutionInState(state, workflow.id, { autoQueue: true });
    return {
      workflow_execution: reconciled.workflow_execution,
      repository_line: currentLine,
      conflict_evidence: { asset: conflict.asset, version: conflict.version },
      remediation_task_execution: remediation,
      acceptance_task_execution: acceptance,
      integration_task_execution: integration
    };
  });

  let integrationPreparation = null;
  try {
    integrationPreparation = await prepareRepositoryIntegration(result.integration_task_execution.id);
  } catch (error) {
    if (!(error?.payload?.error === 'repository_integration_not_queued')) throw error;
  }
  return {
    ...result,
    integration_preparation: integrationPreparation
  };
}

function normalizeExpected(value, fallback) {
  if (value === undefined || value === null || value === '') return String(fallback || '').toLowerCase();
  const normalized = String(value).trim().toLowerCase();
  if (!SHA.test(normalized)) throw new HttpError(400, { error: 'repository_expected_sha_invalid' });
  return normalized;
}

function latestTaskExecution(state, tasks, executor) {
  const ids = new Set(tasks.filter((item) => executorForTask(item) === executor).map((item) => item.id));
  return (
    state.task_executions
      .filter((item) => ids.has(item.task_id))
      .sort((a, b) => Number(b.attempt || 0) - Number(a.attempt || 0))[0] || null
  );
}

function latestTaskExecutionForTask(state, taskId) {
  if (!taskId) return null;
  return (
    state.task_executions
      .filter((item) => item.task_id === taskId)
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) || Number(b.attempt || 0) - Number(a.attempt || 0)
      )[0] || null
  );
}

function executorForTask(task) {
  if (task?.task_kind === 'code') return 'repository_change';
  if (task?.task_kind === 'test') return 'repository_verify';
  if (['deploy', 'integration'].includes(task?.task_kind)) return 'repository_integrate';
  return null;
}

function nextAttempt(previous, actorId) {
  const createdAt = now();
  return {
    ...structuredClone(previous),
    id: id('tex'),
    attempt: Number(previous.attempt || 0) + 1,
    status: 'queued',
    readiness: { ready: false, reasons: [{ code: 'repository_reconciliation_pending' }], checked_at: createdAt },
    context_snapshot: null,
    context_pack_id: null,
    input_snapshot_hash: null,
    input_snapshot_hash_version: null,
    repository_snapshot_hash: null,
    retry_input_snapshot_hash: null,
    retry_input_snapshot_hash_version: null,
    output_bindings: [],
    consumed_inputs: [],
    acceptance_results: [],
    consumed_context_document_versions: [],
    context_selection_id: null,
    context_selection_ids: [],
    evidence: {},
    error_code: null,
    retry_class: null,
    lease: null,
    supersedes_id: previous.id,
    queued_at: createdAt,
    started_at: null,
    completed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    created_by_user_id: actorId,
    input_superseded: false,
    input_superseded_reasons: []
  };
}

function supersedeExecution(state, execution, reason) {
  if (!execution || execution.status === 'superseded') return;
  for (const binding of execution.output_bindings || []) {
    const asset = state.assets.find((item) => item.id === binding.asset_id);
    if (!asset) continue;
    asset.status = 'superseded';
    asset.attestation_status = 'superseded';
    asset.superseded_reason = reason;
    asset.superseded_at = now();
    asset.updated_at = now();
  }
  execution.input_superseded = true;
  execution.input_superseded_reasons = [{ code: reason }];
  if (
    ['pending', 'ready', 'queued', 'running', 'verifying', 'awaiting_human', 'completed', 'failed'].includes(
      execution.status
    )
  )
    transitionTaskExecutionInState(state, execution, 'superseded', { reason });
}

async function createConflictEvidence(state, projectId, task, evidence, repositorySha, actorId, taskExecution) {
  const asset = createAssetRecord({
    projectId,
    workspaceId: task.workspace_id,
    taskId: task.id,
    taskExecutionId: taskExecution?.id || null,
    assetType: 'ConflictEvidenceAsset',
    title: `Repository base conflict ${repositorySha.slice(0, 12)}`,
    summary: '记录旧验收版本因 base 前进而失效，以及新的合并提交输入。',
    outputKey: 'conflict_evidence',
    actorId
  });
  Object.assign(asset, {
    acceptance_criteria: ['旧 repository version 不再作为当前 Integration 输入', '新的 base/head SHA 可追溯'],
    confirmation_policy: 'system_evidence',
    execution_type: 'repository_reconciliation',
    execution_id: taskExecution?.id || null
  });
  state.assets.push(asset);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: { payload_kind: 'json', media_type: 'application/json', content: evidence },
    title: asset.title,
    summary: asset.summary,
    evidenceRefs: [`conflict:${repositorySha}`, `commit:${repositorySha}`],
    repositorySha,
    provenance: { source: 'repository_reconciliation', repository_line_id: evidence.repository_line_id },
    actorId,
    outputKey: 'conflict_evidence'
  });
  await attestAssetVersionInState(state, {
    assetId: asset.id,
    versionId: version.id,
    expectedSha256: version.content_sha256,
    taskExecutionId: taskExecution?.id || null,
    outputKey: asset.output_key,
    decision: 'accepted',
    attestorType: 'trusted_verifier',
    attestorId: 'repository_change_verifier',
    evidence: { repository_sha: repositorySha, external_snapshot_sha256: version.content_sha256 },
    summary: 'Repository conflict was reconciled against the remote merge commit.'
  });
  return { asset, version };
}

function attachOptionalInput(execution, conflict) {
  const context = execution.context_snapshot;
  if (!context) throw new HttpError(409, { error: 'repository_reconciliation_context_missing' });
  const binding = {
    asset_id: conflict.asset.id,
    version_id: conflict.version.id,
    asset_type: conflict.asset.asset_type,
    content_sha256: conflict.version.content_sha256,
    repository_sha: conflict.version.repository_sha || null,
    confirmation_policy: 'system_evidence'
  };
  context.inputs ||= [];
  context.inputs.push({
    key: 'conflict_evidence',
    kind: 'asset_version',
    required: false,
    source: 'repository_reconciliation',
    selector: 'explicit',
    ref_id: conflict.asset.id,
    version_id: conflict.version.id,
    asset_versions: [binding]
  });
  context.input_snapshot_hash = executionInputHash(context);
  execution.input_snapshot_hash = context.input_snapshot_hash;
  execution.input_snapshot_hash_version = 2;
  execution.repository_snapshot_hash = context.repository_snapshot?.snapshot_hash || null;
}

function inputVersionIds(execution) {
  return [
    ...new Set(
      (execution.context_snapshot?.inputs || [])
        .filter((item) => item.required !== false || item.key === 'conflict_evidence')
        .flatMap((item) => item.asset_versions || [])
        .map((item) => item.version_id)
        .filter(Boolean)
    )
  ];
}

async function syncLineCheckout(state, line, targetSha) {
  if (!line.checkout_path) throw new HttpError(409, { error: 'repository_line_checkout_missing' });
  const clean = await commandAsync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    line.checkout_path,
    30_000
  );
  if (!clean.ok) throw new HttpError(409, { error: 'repository_line_git_failed', detail: clean.stderr || clean.error });
  if (String(clean.stdout || '').trim())
    throw new HttpError(409, { error: 'repository_reconciliation_dirty_checkout' });
  const remoteName =
    state.repository_connections.find((item) => item.id === line.connection_id)?.remote_name || 'origin';
  const remote = git(line.checkout_path, ['remote', 'get-url', remoteName], 5_000);
  if (!remote.ok) throw new HttpError(409, { error: 'repository_remote_unavailable' });
  const env = await repositoryGitAuthEnv(
    state,
    state.repository_connections.find((item) => item.id === line.connection_id),
    remote.stdout.trim()
  );
  const fetched = await commandAsync('git', ['fetch', '--prune', remoteName], line.checkout_path, 120_000, env);
  if (!fetched.ok)
    throw new HttpError(409, {
      error: 'repository_reconciliation_fetch_failed',
      detail: fetched.stderr || fetched.error
    });
  const switched = await commandAsync('git', ['switch', '-C', line.branch, targetSha], line.checkout_path, 60_000, env);
  if (!switched.ok)
    throw new HttpError(409, {
      error: 'repository_reconciliation_checkout_failed',
      detail: switched.stderr || switched.error
    });
  const head = git(line.checkout_path, ['rev-parse', 'HEAD'], 5_000).stdout.trim().toLowerCase();
  if (head !== targetSha) throw new HttpError(409, { error: 'repository_reconciliation_checkout_mismatch' });
}

function changedFilesFor(root, previousSha, nextSha) {
  if (!root || !previousSha || !nextSha) return [];
  const result = git(root, ['diff', '--name-status', `${previousSha}..${nextSha}`, '--'], 30_000);
  if (!result.ok) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 2000)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return { status: status || 'modified', path: rest.join(' ') };
    });
}

function commitParentsFor(root, sha) {
  if (!root || !sha) return [];
  const result = git(root, ['show', '-s', '--format=%P', sha], 10_000);
  return result.ok
    ? String(result.stdout || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    : [];
}
