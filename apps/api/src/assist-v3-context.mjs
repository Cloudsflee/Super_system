import path from 'node:path';
import { estimateTokens, id, now } from '../../../packages/shared/index.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import { currentProjectWorkflow, workflowGraphSnapshot } from './workflow-graph-service.mjs';
import { CONTEXT_PACK_SCHEMA } from '../../../packages/system-context/src/index.mjs';
import { compactRuntimeMap, createSelectionForRuntimeInState } from './context-service.mjs';

export function createTurnContext(state, { actor, project, session, turn, attachmentIds }) {
  const created = now();
  const scopeContext = assistScopeContext(state, {
    project,
    scopeType: session.scope_type,
    scopeId: session.scope_id
  });
  const repositoryWorkspace = state.repository_workspaces.find(
    (item) => item.id === turn.repository_workspace_id && item.project_id === project.id && item.status === 'active'
  );
  const assets = scopedMemoryAssets(state, session).slice(-50);
  const anchorCollection =
      session.scope_type === 'project'
        ? 'projects'
        : session.scope_type === 'workflow'
          ? 'workflows'
          : 'workflow_nodes',
    selection = createSelectionForRuntimeInState(state, {
      actorId: actor.id,
      sessionId: session.id,
      projectId: project.id,
      anchorSourceCollection: anchorCollection,
      anchorSourceId: session.scope_id,
      tokenBudget: Number(project.settings?.token_budget || 12_000)
    }),
    compactMap = compactRuntimeMap(state, project.id, session.scope_id);
  const missing = turn.prompt ? [] : ['prompt'];
  const check = {
    id: id('csc'),
    project_id: project.id,
    workspace_id: session.workspace_id,
    node_id: session.node_id,
    target_type: 'assist_turn',
    target_id: turn.id,
    status: missing.length ? 'insufficient' : 'sufficient',
    missing_slots: missing,
    conflicts: [],
    stale_refs: [],
    included_memory_refs: assets.map((item) => item.current_version_id).filter(Boolean),
    excluded_memory_refs: [],
    token_estimate: estimateTokens(turn.prompt),
    token_budget: Number(project.settings?.token_budget || 12_000),
    created_at: created
  };
  const pack = {
    id: id('ctx'),
    source_workspace_id: session.workspace_id,
    receiver_type: 'assist_turn',
    receiver_name: `${turn.mode}:${turn.id}`,
    purpose: 'assist_v3_turn',
    schema_version: CONTEXT_PACK_SCHEMA,
    version: 4,
    status: 'confirmed',
    content_json: {
      schema_version: CONTEXT_PACK_SCHEMA,
      project: { id: project.id, title: project.title, goal: project.goal },
      scope: { type: session.scope_type, id: session.scope_id, snapshot: session.scope_snapshot || null },
      context_map: compactMap,
      context_selection_id: selection.id,
      document_versions: selection.included.map((item) => ({
        node_id: item.node_id,
        document_version_id: item.document_version_id,
        content_sha256: item.content_sha256
      })),
      retrieval_protocol: {
        tool: 'aiws_context',
        order: ['map', 'search', 'read'],
        instruction: '先读取紧凑地图，再申请检索和精确节点正文；服务端负责权限、范围、新鲜度和 token 预算裁决。'
      },
      repository_workspace: repositoryWorkspace
        ? {
            id: repositoryWorkspace.id,
            connection_id: repositoryWorkspace.connection_id,
            ref: repositoryWorkspace.ref,
            fixed_sha: repositoryWorkspace.fixed_sha,
            current_sha: repositoryWorkspace.current_sha,
            mode: repositoryWorkspace.mode,
            scope: repositoryWorkspace.scope,
            stale: repositoryWorkspace.stale
          }
        : null,
      ...scopeContext,
      attachment_ids: attachmentIds,
      operation_reference: publicOperationReference(
        state.assist_operations.find((item) => item.id === turn.operation_reference_id),
        state
      )
    },
    memory_manifest: {
      included_asset_version_ids: assets.map((item) => item.current_version_id).filter(Boolean),
      digest_id: null,
      authority: 'confirmed_only',
      scope_type: session.scope_type,
      scope_id: session.scope_id
    },
    sufficiency_check_id: check.id,
    context_selection_id: selection.id,
    context_document_versions: selection.included.map((item) => item.document_version_id),
    content_file_ref_id: null,
    markdown_file_ref_id: null,
    included_asset_versions: assets.map((item) => item.current_version_id).filter(Boolean),
    token_estimate: check.token_estimate,
    quality_check: { sufficient: !missing.length, missing_slots: missing },
    confirmed_by_user_id: actor.id,
    created_at: created,
    updated_at: created
  };
  return { check, pack };
}

export function assistScopeContext(state, { project, scopeType, scopeId }) {
  const brief =
    state.project_briefs
      .filter((item) => item.project_id === project.id && item.status !== 'superseded')
      .sort((a, b) => b.version - a.version)[0] || null;
  const workflow =
    project.status !== 'draft' && project.onboarding_state === 'confirmed'
      ? currentProjectWorkflow(state, project.id)
      : null;
  const workflowDraft = workflow
    ? null
    : state.workflow_drafts.find((item) => item.project_id === project.id && item.status !== 'activated') || null;
  return minimalScopeContext(state, {
    project,
    session: { scope_type: scopeType, scope_id: scopeId },
    brief,
    workflow,
    workflowDraft
  });
}

function minimalScopeContext(state, { project, session, brief, workflow, workflowDraft }) {
  if (session.scope_type === 'project') {
    const decisions = state.decisions
      .filter((item) => item.project_id === project.id && ['accepted', 'confirmed'].includes(item.status))
      .slice(-50)
      .map((item) => ({ id: item.id, title: item.title, summary: item.summary, status: item.status }));
    return {
      brief: brief?.content || null,
      brief_ref: brief ? { id: brief.id, revision: brief.revision, version: brief.version } : null,
      global_decisions: decisions,
      ...(workflowDraft
        ? {
            workflow_draft: {
              id: workflowDraft.id,
              revision: workflowDraft.revision,
              nodes: workflowDraft.nodes,
              generation_status: workflowDraft.generation_status,
              route: `/projects/${project.id}/onboarding`,
              mutation_policy: 'direct_draft_edit',
              hierarchy: 'workstream_task'
            }
          }
        : {})
    };
  }
  if (session.scope_type === 'workflow') {
    const selected =
      state.workflows.find((item) => item.id === session.scope_id && item.project_id === project.id) || workflow;
    const graph = selected ? workflowGraphSnapshot(state, selected, null) : null;
    return selected && graph
      ? {
          workflow: {
            id: selected.id,
            title: selected.title,
            revision: graph.revision,
            graph,
            route: `/projects/${project.id}/workflow`,
            mutation_policy: 'change_proposal'
          }
        }
      : {};
  }
  const node = state.workflow_nodes.find((item) => item.id === session.scope_id),
    selectedWorkflow = state.workflows.find((item) => item.id === node?.workflow_id);
  if (session.scope_type === 'workstream' && node) {
    const contract = state.node_contracts.find((item) => item.id === node.current_contract_id),
      graph = selectedWorkflow ? workflowGraphSnapshot(state, selectedWorkflow, node.id) : null;
    return {
      workstream: {
        id: node.id,
        title: node.title,
        outcome: node.outcome,
        category: node.category,
        boundary: node.boundary,
        contract,
        task_graph: graph,
        repository_targets: state.repository_targets.filter((item) => item.workstream_id === node.id)
      }
    };
  }
  if (session.scope_type === 'task' && node) {
    return { task: taskScopeContext(state, project, selectedWorkflow, node) };
  }
  return {};
}

function taskScopeContext(state, project, workflow, node) {
  const workstream = state.workflow_nodes.find((item) => item.id === node.parent_node_id),
    dependencies = taskDependencies(state, node),
    execution = latestTaskExecution(state, node),
    failure = taskExecutionFailure(state, execution),
    rawReasons = taskReadinessReasons(node, execution, dependencies, failure),
    blockers = rawReasons.map((reason) => taskBlocker(state, reason));
  const status = normalizeTaskStatus(execution?.status || node.status),
    locked = taskIsLocked(node.status, status, blockers),
    contract = state.node_contracts.find((item) => item.id === node.current_contract_id) || null;
  return {
    id: node.id,
    title: node.title,
    goal: node.goal,
    status,
    source_status: node.status,
    status_label: locked ? '已锁定' : taskStatusLabel(status),
    task_kind: node.task_kind,
    execution_mode: node.execution_mode,
    required: node.required !== false,
    locked,
    lock_summary: locked ? blockers[0]?.label || '执行上下文门禁未满足' : null,
    blockers,
    workflow: workflow ? { id: workflow.id, title: workflow.title, status: workflow.status } : null,
    workstream: workstream
      ? { id: workstream.id, title: workstream.title, status: workstream.status, outcome: workstream.outcome }
      : null,
    dependencies,
    dependency_progress: {
      total: dependencies.length,
      completed: dependencies.filter((item) => normalizeTaskStatus(item.status) === 'completed').length,
      waiting: dependencies.filter((item) => normalizeTaskStatus(item.status) !== 'completed').length
    },
    current_execution: publicTaskExecution(execution),
    last_failure: failure,
    context: {
      summary: {
        core_goal: node.goal || null,
        status: locked ? '已锁定' : taskStatusLabel(status),
        lock_reason: locked ? blockers[0]?.label || '执行上下文门禁未满足' : null,
        dependency_progress: `${dependencies.filter((item) => normalizeTaskStatus(item.status) === 'completed').length}/${dependencies.length}`,
        input_count: contract?.expected_inputs?.length || node.input_slots?.length || 0,
        output_count: contract?.expected_outputs?.length || node.output_slots?.length || 0
      },
      source: {
        goal: node.goal || null,
        contract,
        execution_snapshot: execution?.context_snapshot || null
      }
    },
    repository_targets: state.repository_targets.filter(
      (item) => item.project_id === project.id && item.task_id === node.id
    )
  };
}

function taskDependencies(state, node) {
  return (node.dependencies || [])
    .map((item) => (typeof item === 'string' ? item : item.node_id))
    .filter(Boolean)
    .map((dependencyId) => {
      const dependency = state.workflow_nodes.find((item) => item.id === dependencyId);
      return {
        id: dependencyId,
        title: dependency?.title || null,
        status: dependency?.status || null,
        outputs: state.assets
          .filter((item) => item.node_id === dependencyId && item.status === 'confirmed')
          .map((item) => ({
            id: item.id,
            title: item.title,
            summary: item.summary,
            current_version_id: item.current_version_id
          }))
      };
    });
}

function latestTaskExecution(state, node) {
  const referencedId = node.current_task_execution_id || node.latest_task_execution_id,
    referenced = referencedId ? state.task_executions.find((item) => item.id === referencedId) : null;
  if (referenced?.task_id === node.id) return referenced;
  const workflowExecutions = state.workflow_executions
    .filter((item) => item.workflow_id === node.workflow_id)
    .sort((left, right) =>
      String(left.started_at || left.created_at).localeCompare(String(right.started_at || right.created_at))
    );
  const selected =
    workflowExecutions.filter((item) => ['running', 'paused'].includes(item.status)).at(-1) ||
    workflowExecutions.at(-1);
  const candidates = state.task_executions.filter((item) => item.task_id === node.id),
    selectedCandidates = selected
      ? candidates.filter((item) => item.workflow_execution_id === selected.id)
      : candidates;
  return [...(selectedCandidates.length ? selectedCandidates : candidates)].sort(byTaskExecutionTime).at(-1) || null;
}

function taskReadinessReasons(node, execution, dependencies, failure) {
  const stored = execution?.readiness?.reasons?.length
    ? execution.readiness.reasons
    : Array.isArray(node.waiting_reasons)
      ? node.waiting_reasons
      : [];
  const reasons = stored.map((item) => ({ ...item }));
  if (failure)
    reasons.unshift({
      code: 'task_execution_failed',
      error_code: failure.error_code,
      summary: `上次执行失败：${failure.summary}`,
      runtime_error: failure.runtime_error
    });
  for (const dependency of dependencies.filter((item) => normalizeTaskStatus(item.status) !== 'completed')) {
    if (!reasons.some((item) => item.code === 'task_dependency_waiting' && item.dependency_task_id === dependency.id))
      reasons.push({
        code: 'task_dependency_waiting',
        dependency_task_id: dependency.id,
        status: dependency.status || 'missing'
      });
  }
  if (normalizeTaskStatus(node.status) === 'blocked' && !reasons.length)
    reasons.push({ code: 'execution_context_gate_unsatisfied' });
  return reasons;
}

function taskBlocker(state, reason) {
  const dependency = reason.dependency_task_id
    ? state.workflow_nodes.find((item) => item.id === reason.dependency_task_id)
    : null;
  const labels = {
    task_execution_failed: reason.summary || '上次任务执行失败',
    reconcile_pending: '正在重新计算执行条件',
    workflow_paused: '工作流已暂停',
    task_revision_superseded: '任务版本已更新，需要重新生成执行上下文',
    contract_superseded: '任务契约已更新，需要重新生成执行上下文',
    task_dependency_waiting: dependency ? `等待前置任务“${dependency.title}”完成` : '等待前置任务完成',
    task_dependency_outputs_unaccepted: dependency
      ? `等待前置任务“${dependency.title}”的输出验收`
      : '等待前置任务输出验收',
    required_input_missing: reason.slot_key ? `必需输入“${reason.slot_key}”尚未就绪` : '必需输入尚未就绪',
    input_asset_unverified: reason.slot_key ? `输入“${reason.slot_key}”尚未验证` : '输入资产尚未验证',
    workstream_dependency_waiting: '等待前置成果节点完成',
    workstream_input_missing: '前置成果输入尚未就绪',
    repository_line_missing: '代码仓库执行线尚未创建',
    repository_line_not_active: '代码仓库执行线当前不可用',
    repository_line_provisioning: '代码仓库执行线准备中',
    workstream_tasks_incomplete: '同一成果节点仍有任务未完成',
    manual_input_required: '等待人工输入',
    pull_request_create_approval_required: '等待批准创建合并请求',
    pull_request_merge_approval_required: '等待批准合并请求',
    execution_context_gate_unsatisfied: '执行上下文门禁未满足',
    execution_scope_missing: '任务执行范围已失效'
  };
  return { ...reason, label: labels[reason.code] || '等待执行条件满足' };
}

function taskExecutionFailure(state, execution) {
  if (!execution || execution.status !== 'failed') return null;
  const runId = execution.source_run_id || execution.context_snapshot?.migration?.source_id,
    run = runId ? state.node_runs.find((item) => item.id === runId) : null,
    runtimeError = codexRuntimeError(run?.result_json?._codex_process?.stdout),
    summary = localizedFailureSummary(runtimeError, run?.summary, execution.error_code);
  return {
    error_code: execution.error_code || null,
    retry_class: execution.retry_class || null,
    summary,
    runtime_error: runtimeError,
    run: run
      ? {
          id: run.id,
          status: run.status,
          summary: run.summary || null,
          warnings: (run.result_json?.warnings || []).slice(0, 10),
          next_actions: (run.result_json?.next_actions || []).slice(0, 10),
          process_exit_code: run.result_json?._codex_process?.code ?? null
        }
      : null
  };
}

function codexRuntimeError(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const message = event?.error?.message || event?.message;
      if (message && ['turn.failed', 'error'].includes(event.type)) return cleanText(message, 2_000);
    } catch {
      /* A partial runner transcript may contain non-JSON lines. */
    }
  }
  return null;
}

function localizedFailureSummary(runtimeError, runSummary, errorCode) {
  if (/\b502 Bad Gateway\b/i.test(runtimeError || '')) return '上游模型服务返回 502 Bad Gateway';
  if (/timed?\s*out|timeout/i.test(runtimeError || '')) return '上游模型服务请求超时';
  if (/rate.?limit|\b429\b/i.test(runtimeError || '')) return '上游模型服务触发限流';
  return cleanText(runSummary, 500) || (errorCode ? `错误代码 ${errorCode}` : '运行器未完成任务');
}

function byTaskExecutionTime(left, right) {
  const timestamp = String(left.updated_at || left.created_at).localeCompare(
    String(right.updated_at || right.created_at)
  );
  return timestamp || Number(left.attempt || 0) - Number(right.attempt || 0);
}

function publicTaskExecution(execution) {
  return execution
    ? {
        id: execution.id,
        workflow_execution_id: execution.workflow_execution_id,
        status: execution.status,
        attempt: execution.attempt,
        executor: execution.executor,
        readiness: execution.readiness,
        input_snapshot_hash: execution.input_snapshot_hash || null,
        output_bindings: execution.output_bindings || [],
        error_code: execution.error_code || null,
        started_at: execution.started_at || null,
        completed_at: execution.completed_at || null,
        updated_at: execution.updated_at || null
      }
    : null;
}

function normalizeTaskStatus(value) {
  if (value === 'draft') return 'pending';
  if (value === 'succeeded') return 'completed';
  if (value === 'needs_review') return 'awaiting_human';
  return value || 'pending';
}

function taskStatusLabel(value) {
  return (
    {
      pending: '等待依赖',
      ready: '已就绪',
      queued: '已排队',
      running: '执行中',
      verifying: '验证中',
      awaiting_human: '等待人工',
      completed: '已完成',
      failed: '执行失败',
      cancelled: '已取消',
      superseded: '已替代',
      blocked: '已锁定'
    }[normalizeTaskStatus(value)] || '其他状态'
  );
}

function taskIsLocked(sourceStatus, status, blockers) {
  return (
    normalizeTaskStatus(sourceStatus) === 'blocked' ||
    (status === 'pending' && blockers.length > 0) ||
    status === 'cancelled' ||
    status === 'superseded'
  );
}

function scopedMemoryAssets(state, session) {
  const confirmed = state.assets.filter(
    (item) => item.project_id === session.project_id && item.status === 'confirmed'
  );
  if (session.scope_type === 'project') return confirmed.filter((item) => !item.node_id);
  if (session.scope_type === 'task') {
    const node = state.workflow_nodes.find((item) => item.id === session.scope_id),
      dependencies = new Set(
        (node?.dependencies || []).map((item) => (typeof item === 'string' ? item : item.node_id))
      );
    return confirmed.filter((item) => dependencies.has(item.node_id));
  }
  return [];
}

export function turnPrompt({ turn, session, project, contextPack, attachments }) {
  return cleanText(turn?.prompt, 100_000);
}

export function applicationAdditionalContext({ turn, session, project, contextPack, attachments }) {
  const writable = turn.code_access === 'workspace_write';
  const boundary = writable
    ? 'Code access: workspaceWrite inside the current isolated thread change batch. Do not push, publish, or modify repositories outside the current working directory. Leave all changes reviewable.'
    : `Code access: read-only (${turn.code_read_only_reason || 'read_only'}). Do not edit, create, delete, rename, apply patches, or run mutating commands.`;
  const attachmentContext = attachments.map((item) => ({
    kind: item.kind,
    path: item.relative_path,
    url: item.url,
    content_type: item.content_type,
    model_policy: item.model_policy,
    selection: item.selection
  }));
  const value = {
    schema: 'aiws.application-context.v1',
    boundary,
    project: {
      id: project.id,
      title: project.title,
      goal: project.goal || '',
      status: project.status,
      managed_workspace_state: project.managed_workspace_state || null
    },
    scope: { type: session.scope_type, id: session.scope_id },
    context_pack: contextPackPromptView(contextPack),
    attachments: attachmentContext,
    page: safePageContext(turn.view_context),
    clarification: clarificationContext(session.clarification_policy, turn.collaboration_mode),
    operation_reference: operationReferenceContext(contextPack, turn.operation_reference_id),
    migrated_thread_history: session.native_thread_generation === 1 ? limitedLegacyHistory(session) : null
  };
  return [{ kind: 'application', value: JSON.stringify(value) }];
}

function contextPackPromptView(contextPack) {
  const content = contextPack?.content_json || {};
  if (contextPack?.schema_version !== CONTEXT_PACK_SCHEMA && content.schema_version !== CONTEXT_PACK_SCHEMA)
    return content;
  return {
    schema_version: CONTEXT_PACK_SCHEMA,
    project: content.project || null,
    scope: content.scope ? { type: content.scope.type, id: content.scope.id } : null,
    current_anchor: {
      node_id: content.context_map?.anchor_node_id || null,
      scope_type: content.scope?.type || null,
      scope_id: content.scope?.id || null
    },
    context_map: content.context_map || null,
    context_selection_id: contextPack.context_selection_id || content.context_selection_id || null,
    document_versions: content.document_versions || [],
    retrieval_protocol: content.retrieval_protocol || null
  };
}

function clarificationContext(policy, mode) {
  return {
    policy: policy === 'auto_recommend' ? 'auto_recommend' : 'ask',
    collaboration_mode: mode === 'plan' ? 'plan' : 'default',
    instruction:
      policy === 'auto_recommend'
        ? 'When a material ambiguity has exactly one clearly marked safe recommendation, prefer it. Credentials, approvals, deletion, irreversible actions, conflicts, and questions without a recommendation must still use requestUserInput.'
        : 'When a material ambiguity would change scope or outcome, use requestUserInput before proceeding. This preference does not change collaboration mode.'
  };
}

function operationReferenceContext(contextPack, referenceId) {
  if (!referenceId) return null;
  return {
    ...(contextPack?.content_json?.operation_reference || {}),
    operation_reference_id: referenceId,
    instruction: 'Apply the requested follow-up to this exact prior operation target. Do not infer a different target.'
  };
}
function publicOperationReference(item, state) {
  const proposal = item?.proposal_id ? state?.change_proposals?.find((entry) => entry.id === item.proposal_id) : null;
  return item
    ? {
        operation_reference_id: item.id,
        capability_id: item.capability_id || null,
        action: item.action || null,
        result_kind: item.result_kind || null,
        proposal_id: item.proposal_id || null,
        proposal_status: proposal?.status || item.proposal_status || null,
        target_id: item.target_id,
        target_label: item.target_label || item.target_id,
        locator: item.locator || {
          route: item.route,
          surface_id: item.surface_id,
          surface_revision: item.surface_revision
        },
        before_value: item.before_value,
        after_value: item.after_value,
        current_value: item.current_value
      }
    : null;
}

export async function appServerUserInput(userText, attachments, _state, options = {}) {
  const input = [{ type: 'text', text: cleanText(userText, 100_000), text_elements: [] }];
  for (const attachment of attachments
    .filter((item) => ['selection', 'text', 'url'].includes(item.kind) && item.model_policy === 'injectable')
    .slice(0, 12)) {
    const text = cleanText(attachment.text, 100_000);
    if (text)
      input.push({
        type: 'text',
        text: `[Attachment: ${cleanText(attachment.title || attachment.relative_path || attachment.kind, 500)}]\n${text}`,
        text_elements: []
      });
  }
  for (const attachment of attachments.filter((item) => !['selection', 'text'].includes(item.kind)).slice(0, 20)) {
    const nativePath = options.nativePaths?.get(attachment.id) || projectMentionPath(attachment, options);
    if (!nativePath) continue;
    const name = cleanText(attachment.original_filename || attachment.title || path.basename(nativePath), 500);
    if (attachment.model_policy === 'image' && options.imageCapable !== false)
      input.push({ type: 'localImage', path: nativePath });
    else input.push({ type: 'mention', name, path: nativePath });
  }
  return input;
}

function projectMentionPath(attachment, options) {
  const relative = String(attachment.relative_path || '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) return null;
  if (options.containerized) return `/workspace/${relative}`;
  return options.cwd ? path.join(options.cwd, ...relative.split('/')) : relative;
}

function safePageContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    route: cleanText(value.route, 2_000),
    browser_instance_id: cleanText(value.browser_instance_id || value.surface?.browser_instance_id, 200) || null,
    surface: value.surface && typeof value.surface === 'object' ? value.surface : null
  };
}

function limitedLegacyHistory(session) {
  return {
    legacy_thread_id_present: Boolean(session.legacy_codex_thread_id || session.historical_shared_codex_thread_id),
    note: 'A legacy native thread is retained for audit only. Continue in an isolated V1.6 thread without exposing or resuming the shared identifier.'
  };
}
