import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { now } from '../../../../packages/shared/index.mjs';
import {
  applyWorkflowGenerationCandidate,
  cancelWorkflowGeneration,
  getWorkflowGeneration,
  listWorkflowGenerationEvents,
  listWorkflowGenerations,
  retryWorkflowGeneration,
  startWorkflowGeneration
} from '../workflow-generation-service.mjs';
import {
  createWorkflowGraphProposalInState,
  workflowGraphSnapshot,
  workflowVisualGraph
} from '../workflow-graph-service.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from '../project-lifecycle-operations.mjs';
import { evaluateTaskExecutionContextFreshness } from '../task-execution-context.mjs';
import { latestTaskExecution, recordAssetLineage, validateTaskOutputBindings } from '../task-output-service.mjs';

export const workflowV19Routes = [
  makeRoute('GET', '/workflows/:id/graph', getWorkflowGraph),
  makeRoute('POST', '/workflows/:id/graph-proposals', createGraphProposal),
  makeRoute('POST', '/tasks/:id/submissions', submitTask),
  makeRoute('POST', '/tasks/:id/review', reviewTask),
  makeRoute('POST', '/workstreams/:id/submissions', submitWorkstream),
  makeRoute('POST', '/workstreams/:id/review', reviewWorkstream),
  makeRoute('POST', '/projects/:id/workflow-draft/generations', createGeneration),
  makeRoute('GET', '/projects/:id/workflow-draft/generations', listGenerations),
  makeRoute('GET', '/projects/:id/workflow-draft/generations/:generationId', getGeneration),
  makeRoute('GET', '/projects/:id/workflow-draft/generations/:generationId/events', generationEvents),
  makeRoute('POST', '/projects/:id/workflow-draft/generations/:generationId/cancel', cancelGeneration),
  makeRoute('POST', '/projects/:id/workflow-draft/generations/:generationId/retry', retryGeneration),
  makeRoute('POST', '/projects/:id/workflow-draft/generations/:generationId/apply', applyGeneration)
];

async function submitTask({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      task = requireHierarchyNode(state, params.id, 'task'),
      workstream = requireHierarchyNode(state, task.parent_node_id, 'workstream');
    assertLegacyOrchestrationAllowed(state, task.workflow_id);
    if (task.status === 'completed') throw new HttpError(409, { error: 'task_already_completed' });
    const summary = clean(body.summary, 4000);
    if (!summary) throw new HttpError(400, { error: 'submission_summary_required' });
    const workflow = state.workflows.find((item) => item.id === task.workflow_id),
      contract = state.node_contracts.find((item) => item.id === task.current_contract_id),
      execution = latestTaskExecution(state, task.id),
      strict = workflow?.planning_quality === 'verified';
    const checked = validateTaskOutputBindings(state, {
      task,
      contract,
      bindings: body.output_bindings || execution?.output_bindings || [],
      projectId: workflow.project_id,
      strict
    });
    const inputSnapshotHash = body.input_snapshot_hash || execution?.input_snapshot_hash || null;
    if (strict && !inputSnapshotHash)
      throw new HttpError(409, {
        error: 'task_context_not_ready',
        reasons: [{ code: 'input_snapshot_hash_required' }]
      });
    const submission = makeScopeSubmission({
      state,
      actor,
      projectId: workflow.project_id,
      node: task,
      fromType: 'task',
      fromId: task.id,
      toType: 'workstream',
      toId: workstream.id,
      title: body.title || `${task.title} submission`,
      summary,
      body: { ...body, output_bindings: checked.bindings, input_snapshot_hash: inputSnapshotHash }
    });
    recordAssetLineage(state, execution?.task_execution_context, checked.bindings, submission.id);
    state.submissions.push(submission);
    Object.assign(task, { status: 'needs_review', latest_submission_id: submission.id, updated_at: now() });
    addTrace(
      state,
      'agent_session.submission.created',
      {
        project_id: submission.project_id,
        workspace_id: task.workspace_id,
        node_id: task.id,
        target_id: submission.id,
        summary: submission.title
      },
      actor.id
    );
    return { task, workstream, submission };
  });
  return send(res, 201, result);
}

async function reviewTask({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      task = requireHierarchyNode(state, params.id, 'task');
    assertLegacyOrchestrationAllowed(state, task.workflow_id);
    if (task.status !== 'needs_review') throw new HttpError(409, { error: 'task_not_in_review', status: task.status });
    if (!['approve', 'reject'].includes(body.decision)) throw new HttpError(400, { error: 'review_decision_invalid' });
    const approved = body.decision === 'approve';
    const workflow = state.workflows.find((item) => item.id === task.workflow_id),
      contract = state.node_contracts.find((item) => item.id === task.current_contract_id),
      submission = state.submissions.find((item) => item.id === task.latest_submission_id),
      execution = latestTaskExecution(state, task.id),
      strict = workflow?.planning_quality === 'verified';
    if (approved) {
      validateTaskOutputBindings(state, {
        task,
        contract,
        bindings: submission?.output_bindings || [],
        projectId: workflow.project_id,
        strict
      });
      const freshness = execution?.task_execution_context
        ? evaluateTaskExecutionContextFreshness(state, execution.task_execution_context)
        : { current: !strict, reasons: [{ code: 'task_execution_context_missing' }] };
      if (
        strict &&
        (!execution ||
          submission?.input_snapshot_hash !== execution.input_snapshot_hash ||
          !freshness.current ||
          execution.input_superseded)
      )
        throw new HttpError(409, {
          error: 'task_context_not_ready',
          reasons: freshness.reasons.length ? freshness.reasons : [{ code: 'input_snapshot_hash_mismatch' }]
        });
    }
    Object.assign(task, {
      status: approved ? 'completed' : 'blocked',
      review: {
        decision: body.decision,
        summary: clean(body.summary, 4000),
        acceptance_results: Array.isArray(body.acceptance_results) ? body.acceptance_results : []
      },
      reviewed_by_user_id: actor.id,
      reviewed_at: now(),
      updated_at: now()
    });
    if (submission)
      Object.assign(submission, {
        status: approved ? 'accepted' : 'changes_requested',
        reviewed_at: now(),
        reviewed_by_user_id: actor.id
      });
    const workstream = aggregateWorkstream(state, task.parent_node_id);
    if (approved) {
      unblockSiblingTasks(state, workstream);
      addTrace(
        state,
        'node.completed',
        {
          project_id: projectIdForNode(state, task),
          workspace_id: task.workspace_id,
          node_id: task.id,
          target_id: task.id,
          summary: `Task completed: ${task.title}`
        },
        actor.id
      );
    }
    return { task, workstream, submission };
  });
  return send(res, 200, result);
}

async function submitWorkstream({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      workstream = requireHierarchyNode(state, params.id, 'workstream'),
      tasks = state.workflow_nodes.filter((item) => item.role === 'task' && item.parent_node_id === workstream.id);
    assertLegacyOrchestrationAllowed(state, workstream.workflow_id);
    const incomplete = tasks.filter((item) => item.required !== false && item.status !== 'completed');
    if (incomplete.length)
      throw new HttpError(409, {
        error: 'workstream_required_tasks_incomplete',
        task_ids: incomplete.map((item) => item.id)
      });
    const summary = clean(body.summary || workstream.outcome, 4000);
    const submission = makeScopeSubmission({
      state,
      actor,
      projectId: projectIdForNode(state, workstream),
      node: workstream,
      fromType: 'workstream',
      fromId: workstream.id,
      toType: 'workflow',
      toId: workstream.workflow_id,
      title: body.title || `${workstream.title} outcome`,
      summary,
      body
    });
    state.submissions.push(submission);
    Object.assign(workstream, { status: 'needs_review', latest_submission_id: submission.id, updated_at: now() });
    addTrace(
      state,
      'agent_session.submission.created',
      {
        project_id: submission.project_id,
        workspace_id: workstream.workspace_id,
        node_id: workstream.id,
        target_id: submission.id,
        summary: submission.title
      },
      actor.id
    );
    return { workstream, tasks, submission };
  });
  return send(res, 201, result);
}

async function reviewWorkstream({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      workstream = requireHierarchyNode(state, params.id, 'workstream');
    assertLegacyOrchestrationAllowed(state, workstream.workflow_id);
    if (workstream.status !== 'needs_review')
      throw new HttpError(409, { error: 'workstream_not_in_review', status: workstream.status });
    if (!['approve', 'reject'].includes(body.decision)) throw new HttpError(400, { error: 'review_decision_invalid' });
    const approved = body.decision === 'approve';
    Object.assign(workstream, {
      status: approved ? 'completed' : 'blocked',
      review: { decision: body.decision, summary: clean(body.summary, 4000) },
      reviewed_by_user_id: actor.id,
      reviewed_at: now(),
      updated_at: now()
    });
    const submission = state.submissions.find((item) => item.id === workstream.latest_submission_id);
    if (submission)
      Object.assign(submission, {
        status: approved ? 'accepted' : 'changes_requested',
        reviewed_at: now(),
        reviewed_by_user_id: actor.id
      });
    if (approved) {
      unblockDownstreamWorkstreams(state, workstream);
      addTrace(
        state,
        'node.completed',
        {
          project_id: projectIdForNode(state, workstream),
          workspace_id: workstream.workspace_id,
          node_id: workstream.id,
          target_id: workstream.id,
          summary: `Workstream completed: ${workstream.title}`
        },
        actor.id
      );
    }
    return { workstream, submission };
  });
  return send(res, 200, result);
}

async function getWorkflowGraph({ res, params, query }) {
  const state = await readState(),
    workflow = state.workflows.find((item) => item.id === params.id);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  const project = state.projects.find((item) => item.id === workflow.project_id && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  const parentNodeId = clean(query.parent_node_id) || null;
  const all = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  const parent = parentNodeId ? all.find((item) => item.id === parentNodeId && item.role === 'workstream') : null;
  if (parentNodeId && !parent)
    throw new HttpError(404, { error: 'workflow_workstream_not_found', parent_node_id: parentNodeId });
  const nodes = all
    .filter((item) =>
      parentNodeId ? item.role === 'task' && item.parent_node_id === parentNodeId : item.role === 'workstream'
    )
    .sort((a, b) => a.order_index - b.order_index)
    .map((node) => decorateGraphNode(state, node, all));
  const snapshot = workflowGraphSnapshot(state, workflow, parentNodeId);
  return send(res, 200, {
    project,
    workflow,
    parent,
    parent_node_id: parentNodeId,
    revision: snapshot?.revision || 1,
    nodes,
    graph: workflowVisualGraph(all, parentNodeId),
    snapshot
  });
}

async function createGraphProposal({ res, params, body }) {
  const snapshot = await readState(),
    workflow = snapshot.workflows.find((item) => item.id === params.id);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  return withProjectLifecycleLock(workflow.project_id, async () => {
    const result = await mutate((state) => {
      const actor = owner(state),
        current = state.workflows.find((item) => item.id === workflow.id);
      if (!current) throw new HttpError(404, { error: 'workflow_not_found' });
      assertProjectLifecycleIdle(state.projects.find((item) => item.id === current.project_id));
      const created = createWorkflowGraphProposalInState(
        state,
        current.id,
        {
          parent_node_id: clean(body.parent_node_id) || null,
          expected_revision: body.expected_revision,
          operations: body.operations
        },
        actor.id,
        { project_id: current.project_id, target_id: body.target_id, title: body.title, summary: body.summary }
      );
      addTrace(
        state,
        'change_proposal.created',
        {
          project_id: current.project_id,
          workspace_id: current.workspace_id,
          node_id: created.parent_node_id || null,
          target_id: created.proposal.id,
          summary: created.proposal.title
        },
        actor.id
      );
      return created.proposal;
    });
    return send(res, 201, result);
  });
}

async function createGeneration({ res, params, body, query }) {
  const actor = owner(await readState());
  const result = await startWorkflowGeneration(
    params.id,
    { ...body, adapter: body.adapter || query.adapter },
    actor?.id
  );
  return send(res, result.idempotent ? 200 : 202, responseHandle(params.id, result.generation, result.idempotent));
}

async function listGenerations({ res, params, query }) {
  return send(res, 200, { items: await listWorkflowGenerations(params.id, query) });
}
async function getGeneration({ res, params }) {
  return send(res, 200, await getWorkflowGeneration(params.id, params.generationId));
}
async function cancelGeneration({ res, params }) {
  const actor = owner(await readState());
  const generation = await cancelWorkflowGeneration(params.id, params.generationId, actor?.id);
  return send(res, 202, responseHandle(params.id, generation));
}
async function retryGeneration({ res, params, body, query }) {
  const actor = owner(await readState());
  const result = await retryWorkflowGeneration(
    params.id,
    params.generationId,
    { ...body, adapter: body.adapter || query.adapter },
    actor?.id
  );
  return send(res, 202, responseHandle(params.id, result.generation, result.idempotent));
}
async function applyGeneration({ res, params, body }) {
  const actor = owner(await readState());
  return send(res, 200, await applyWorkflowGenerationCandidate(params.id, params.generationId, body, actor?.id));
}

async function generationEvents({ req, res, params, query }) {
  const after = Math.max(0, Number(query.after || req.headers['last-event-id'] || 0) || 0);
  if (query.format === 'json')
    return send(res, 200, await listWorkflowGenerationEvents(params.id, params.generationId, after));
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let cursor = after,
    closed = false,
    timer;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  };
  req.on?.('close', close);
  const poll = async () => {
    if (closed) return;
    try {
      const batch = await listWorkflowGenerationEvents(params.id, params.generationId, cursor);
      for (const event of batch.events) {
        cursor = event.sequence;
        res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (batch.terminal) {
        res.write(`event: snapshot\ndata: ${JSON.stringify(batch.generation)}\n\n`);
        return close();
      }
      timer = setTimeout(poll, 300);
      timer.unref?.();
    } catch (error) {
      const payload = error instanceof HttpError ? error.payload : { error: 'workflow_generation_events_failed' };
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      close();
    }
  };
  await poll();
}

function responseHandle(projectId, generation, idempotent = false) {
  return {
    operation: generation,
    generation,
    idempotent,
    events_url: `/projects/${projectId}/workflow-draft/generations/${generation.id}/events`,
    cancel_url: `/projects/${projectId}/workflow-draft/generations/${generation.id}/cancel`,
    retry_url: `/projects/${projectId}/workflow-draft/generations/${generation.id}/retry`
  };
}

function decorateGraphNode(state, node, allNodes) {
  if (node.role !== 'workstream')
    return {
      ...node,
      dependency_ids: dependencyIds(node),
      repository_target:
        state.repository_targets.find((item) => item.task_id === node.id && item.access === 'write') || null,
      output_count: state.assets.filter((item) => item.node_id === node.id).length,
      pending_approval_count: state.runtime_approvals.filter(
        (item) => item.node_id === node.id && item.status === 'pending'
      ).length
    };
  const tasks = allNodes.filter((item) => item.role === 'task' && item.parent_node_id === node.id),
    completed = tasks.filter((item) => item.status === 'completed').length;
  const targets = state.repository_targets.filter((item) => item.workstream_id === node.id);
  return {
    ...node,
    status: workstreamStatus(node, tasks),
    dependency_ids: dependencyIds(node),
    task_count: tasks.length,
    completed_task_count: completed,
    progress: tasks.length ? completed / tasks.length : 0,
    blocked_count: tasks.filter((item) => item.status === 'blocked').length,
    pending_approval_count: state.runtime_approvals.filter(
      (item) =>
        (item.node_id === node.id || tasks.some((task) => task.id === item.node_id)) && item.status === 'pending'
    ).length,
    output_count: state.assets.filter(
      (item) => item.node_id === node.id || tasks.some((task) => task.id === item.node_id)
    ).length,
    repository_status: targets.length
      ? { target_count: targets.length, ready_count: targets.filter((item) => item.status === 'ready').length }
      : null
  };
}
function workstreamStatus(workstream, tasks) {
  const required = tasks.filter((item) => item.required !== false);
  if (required.some((item) => item.status === 'blocked')) return 'blocked';
  if (required.length > 0 && required.every((item) => item.status === 'completed')) return 'ready_for_submission';
  if (required.some((item) => ['running', 'needs_review', 'completed'].includes(item.status))) return 'running';
  return workstream.status;
}
function dependencyIds(node) {
  return (node.dependencies || []).map((item) => (typeof item === 'string' ? item : item.node_id)).filter(Boolean);
}
function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
function requireHierarchyNode(state, nodeId, role) {
  const node = state.workflow_nodes.find((item) => item.id === nodeId && item.role === role && !item.legacy_read_only);
  if (!node) throw new HttpError(404, { error: `${role}_not_found` });
  return node;
}
function projectIdForNode(state, node) {
  return state.workflows.find((item) => item.id === node.workflow_id)?.project_id || null;
}
function makeScopeSubmission({ state, actor, projectId, node, fromType, fromId, toType, toId, title, summary, body }) {
  return {
    id: `sub_${cryptoId()}`,
    project_id: projectId,
    workspace_id: node.workspace_id,
    node_id: node.id,
    from_scope_type: fromType,
    from_scope_id: fromId,
    to_scope_type: toType,
    to_scope_id: toId,
    from_session_id: null,
    to_session_id: null,
    title: clean(title, 200),
    summary,
    changes: Array.isArray(body.changes) ? body.changes : [],
    evidence_refs: Array.isArray(body.evidence_refs) ? body.evidence_refs : [],
    asset_ids: Array.isArray(body.asset_ids) ? body.asset_ids : [],
    output_bindings: Array.isArray(body.output_bindings) ? body.output_bindings : [],
    input_snapshot_hash: body.input_snapshot_hash || null,
    risks: Array.isArray(body.risks) ? body.risks : [],
    status: 'submitted',
    created_by_user_id: actor.id,
    created_at: now(),
    updated_at: now()
  };
}
function aggregateWorkstream(state, workstreamId) {
  const workstream = requireHierarchyNode(state, workstreamId, 'workstream'),
    tasks = state.workflow_nodes.filter((item) => item.role === 'task' && item.parent_node_id === workstream.id),
    required = tasks.filter((item) => item.required !== false);
  if (required.length && required.every((item) => item.status === 'completed'))
    workstream.status = 'ready_for_submission';
  else if (required.some((item) => item.status === 'blocked')) workstream.status = 'blocked';
  else
    workstream.status = required.some((item) => ['running', 'needs_review', 'completed'].includes(item.status))
      ? 'running'
      : workstream.status;
  workstream.progress = {
    total: tasks.length,
    completed: tasks.filter((item) => item.status === 'completed').length,
    blocked: tasks.filter((item) => item.status === 'blocked').length
  };
  workstream.updated_at = now();
  return workstream;
}
function unblockSiblingTasks(state, workstream) {
  if (!workstream) return;
  for (const task of state.workflow_nodes.filter(
    (item) => item.role === 'task' && item.parent_node_id === workstream.id && item.status === 'blocked'
  )) {
    const ready = dependencyIds(task).every(
      (idValue) => state.workflow_nodes.find((item) => item.id === idValue)?.status === 'completed'
    );
    if (
      ready &&
      dependencyIds(workstream).every(
        (idValue) => state.workflow_nodes.find((item) => item.id === idValue)?.status === 'completed'
      )
    ) {
      task.status = 'ready';
      task.updated_at = now();
    }
  }
}
function unblockDownstreamWorkstreams(state, completed) {
  for (const workstream of state.workflow_nodes.filter(
    (item) => item.role === 'workstream' && item.workflow_id === completed.workflow_id && item.status === 'blocked'
  )) {
    if (
      !dependencyIds(workstream).every(
        (idValue) => state.workflow_nodes.find((item) => item.id === idValue)?.status === 'completed'
      )
    )
      continue;
    workstream.status = 'ready';
    workstream.updated_at = now();
    unblockSiblingTasks(state, workstream);
  }
}
function cryptoId() {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
}
function assertLegacyOrchestrationAllowed(state, workflowId) {
  const active = state.workflow_executions.find(
    (item) => item.workflow_id === workflowId && ['running', 'paused'].includes(item.status)
  );
  if (active)
    throw new HttpError(409, { error: 'legacy_task_orchestration_forbidden', workflow_execution_id: active.id });
}
