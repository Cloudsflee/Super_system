import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import {
  applyContractPatch,
  approveProposal,
  createChangeProposal,
  createNodeWorkspace,
  defaultContractForNode,
  id,
  now,
  rejectProposal,
  validateNodeContract
} from '../../../../packages/shared/index.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider } from '../codex-service.mjs';
import { proposalTargetHash } from '../proposal-target.mjs';
import { applyProposalAtomically } from '../proposal-atomic.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';
import { applyWorkflowGraphPatchInState, applyWorkflowReplanInState } from '../workflow-graph-service.mjs';
import { operationEvent, syncProposalOperationState } from '../assist-operation-metadata.mjs';
import { pushV3Event } from '../assist-v3-events.mjs';
import { accessibleProjectIds, actorForRequest, instanceOwnerId } from '../project-governance-v19.mjs';

export const changeProposalRoutes = [
  makeRoute('GET', '/change-proposals', listProposals),
  makeRoute('POST', '/change-proposals', createProposalRoute),
  makeRoute('POST', '/change-proposals/:id/approve', approveProposalRoute),
  makeRoute('POST', '/change-proposals/:id/reject', rejectProposalRoute),
  makeRoute('POST', '/change-proposals/:id/apply', applyProposalRoute)
];

async function listProposals({ req, res, query }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
    allowed = accessibleProjectIds(state, actor?.id);
  let proposals = state.change_proposals.filter((item) =>
    item.project_id ? allowed.has(item.project_id) : actor.id === instanceOwnerId(state)
  );
  if (query.project_id) proposals = proposals.filter((item) => item.project_id === query.project_id);
  if (query.status) proposals = proposals.filter((item) => item.status === query.status);
  return send(res, 200, proposals);
}

async function createProposalRoute({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === body.project_id));
    const workspace = body.workspace_id
      ? state.workspaces.find((item) => item.id === body.workspace_id && item.project_id === project.id)
      : null;
    if (body.workspace_id && !workspace) throw new HttpError(404, { error: 'workspace_not_found' });
    const node = body.node_id
      ? state.workflow_nodes.find(
          (item) =>
            item.id === body.node_id &&
            state.workflows.some((workflow) => workflow.id === item.workflow_id && workflow.project_id === project.id)
        )
      : null;
    if (body.node_id && !node) throw new HttpError(404, { error: 'node_not_found' });
    if (workspace && node && workspace.id !== node.workspace_id && workspace.workflow_node_id !== node.id)
      throw new HttpError(409, { error: 'proposal_workspace_node_scope_mismatch' });
    const proposal = createChangeProposal({
      projectId: project.id,
      workspaceId: workspace?.id || null,
      nodeId: node?.id || null,
      changeType: body.change_type || 'general',
      title: body.title,
      summary: body.summary,
      before: body.before_json ?? body.before,
      after: body.after_json ?? body.after,
      impact: body.impact || [],
      risks: body.risks || [],
      evidenceRefs: body.evidence_refs || [],
      applyAction: body.apply_action || null,
      actorId: actor.id
    });
    proposal.target_hash = proposalTargetHash(state, proposal);
    proposal.target_hash_mode = 'state';
    state.change_proposals.push(proposal);
    addTrace(
      state,
      'change_proposal.created',
      {
        project_id: proposal.project_id,
        workspace_id: proposal.workspace_id,
        node_id: proposal.node_id,
        target_type: 'change_proposal',
        target_id: proposal.id,
        summary: `创建变更审批：${proposal.title}`,
        data: proposal
      },
      actor.id
    );
    return proposal;
  });
  return send(res, 201, result);
}

async function approveProposalRoute({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      proposal = state.change_proposals.find((item) => item.id === params.id);
    if (!proposal) return { error: 'proposal_not_found' };
    assertProposalProjectIdle(state, proposal);
    if (
      ['state', 'workflow_graph_v2'].includes(proposal.target_hash_mode) &&
      proposalTargetHash(state, proposal) !== proposal.target_hash
    )
      return { error: 'proposal_stale' };
    try {
      approveProposal(proposal, actor.id);
    } catch (error) {
      return { error: error.message };
    }
    proposal.revision = Number(proposal.revision || 1) + 1;
    publishProposalOperations(state, proposal);
    addTrace(
      state,
      'change_proposal.approved',
      {
        project_id: proposal.project_id,
        workspace_id: proposal.workspace_id,
        node_id: proposal.node_id,
        target_type: 'change_proposal',
        target_id: proposal.id,
        summary: `批准变更：${proposal.title}`
      },
      actor.id
    );
    return proposal;
  });
  return result?.error ? send(res, result.error === 'proposal_not_found' ? 404 : 400, result) : send(res, 200, result);
}

async function rejectProposalRoute({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      proposal = state.change_proposals.find((item) => item.id === params.id);
    if (!proposal) return { error: 'proposal_not_found' };
    assertProposalProjectIdle(state, proposal);
    if (
      ['state', 'workflow_graph_v2'].includes(proposal.target_hash_mode) &&
      proposalTargetHash(state, proposal) !== proposal.target_hash
    )
      return { error: 'proposal_stale' };
    try {
      rejectProposal(proposal, actor.id, body.reason || '用户拒绝');
    } catch (error) {
      return { error: error.message };
    }
    proposal.attention_state = 'resolved';
    proposal.revision = Number(proposal.revision || 1) + 1;
    publishProposalOperations(state, proposal);
    addTrace(
      state,
      'change_proposal.rejected',
      {
        project_id: proposal.project_id,
        workspace_id: proposal.workspace_id,
        node_id: proposal.node_id,
        target_type: 'change_proposal',
        target_id: proposal.id,
        summary: `拒绝变更：${proposal.title}`,
        data: { reason: body.reason || '' }
      },
      actor.id
    );
    return proposal;
  });
  return result?.error ? send(res, result.error === 'proposal_not_found' ? 404 : 400, result) : send(res, 200, result);
}

async function applyProposalRoute({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      proposal = state.change_proposals.find((item) => item.id === params.id);
    if (!proposal) return { error: 'proposal_not_found' };
    assertProposalProjectIdle(state, proposal);
    if (proposal.status !== 'approved' && proposal.status !== 'applied') return { error: 'proposal_not_approved' };
    let applied;
    try {
      applied = applyProposalAtomically(state, proposal, actor, {
        revision: proposal.revision,
        target_hash: proposal.target_hash
      });
    } catch (error) {
      return { error: error.payload?.error || error.message, detail: error.payload };
    }
    publishProposalOperations(state, proposal);
    addTrace(
      state,
      'change_proposal.applied',
      {
        project_id: proposal.project_id,
        workspace_id: proposal.workspace_id,
        node_id: proposal.node_id,
        target_type: 'change_proposal',
        target_id: proposal.id,
        summary: `应用变更：${proposal.title}`,
        data: { applied }
      },
      actor.id
    );
    return { proposal, applied: applied.applied, idempotent: applied.idempotent };
  });
  return result?.error ? send(res, result.error === 'proposal_not_found' ? 404 : 400, result) : send(res, 200, result);
}

export function applyAction(state, proposal) {
  const action = proposal.apply_action || {};
  if (action.type === 'workflow_graph_patch') return applyWorkflowGraphPatchInState(state, proposal);
  if (action.type === 'workflow_replan_replace') return applyWorkflowReplanInState(state, proposal);
  if (action.type === 'node_contract_patch' && proposal.node_id) {
    const node = state.workflow_nodes.find((item) => item.id === proposal.node_id);
    const workflow = state.workflows.find(
      (item) => item.id === node?.workflow_id && item.project_id === proposal.project_id
    );
    const current = state.node_contracts.find((item) => item.id === node?.current_contract_id);
    if (!node || !workflow || !current) return { type: action.type, skipped: 'node_or_contract_missing' };
    const next = applyContractPatch(
      current,
      proposal.after_json || action.patch || {},
      proposal.approved_by_user_id || proposal.created_by_user_id
    );
    Object.assign(next, {
      status: 'confirmed',
      confirmed_by: 'human',
      confirmed_by_user_id: proposal.approved_by_user_id
    });
    const validation = validateNodeContract(next);
    if (!validation.ok) return { type: action.type, validation };
    current.status = 'superseded';
    state.node_contracts.push(next);
    Object.assign(node, { current_contract_id: next.id, pending_approved_change_id: proposal.id, updated_at: now() });
    return { type: action.type, node_id: proposal.node_id, contract_id: next.id };
  }
  if (action.type === 'codex_profile_apply' && action.profile_id) {
    const selected = state.codex_profiles.find((item) => item.id === action.profile_id && item.status === 'validated');
    const probe = state.integration_statuses.find(
      (item) => item.key === 'codex_probe' && item.profile_id === action.profile_id && item.status === 'ready'
    );
    const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
    if (!selected || !probe || !codexAuthMatchesProfile(auth, selected))
      return { type: action.type, skipped: 'validated_profile_probe_or_auth_missing' };
    if (isThirdPartyProvider(selected.provider) && selected.cc_switch_mode === 'managed') {
      const discovered = state.integration_statuses.find(
        (item) =>
          item.key === 'codex_discovery_binding' &&
          item.profile_id === selected.id &&
          item.status === 'synced' &&
          item.source_id === selected.discovery_source?.source_id &&
          item.source_provider_id === selected.discovery_source?.source_provider_id &&
          item.source_revision === selected.discovery_source?.revision
      );
      const ccSwitch = state.integration_statuses.find((item) => item.key === 'cc_switch');
      const sourceCommit = ccSwitch?.sources?.find((item) => item.name === 'cc-switch-cli')?.commit;
      if (
        !discovered &&
        (ccSwitch?.status !== 'synced' ||
          ccSwitch.bridge?.ready !== true ||
          selected.cc_switch_status !== 'synced' ||
          !selected.cc_switch_synced_at ||
          Number(selected.cc_switch_bridge_revision) !== Number(ccSwitch.bridge.revision) ||
          !sourceCommit ||
          selected.cc_switch_source_commit !== sourceCommit)
      )
        return { type: action.type, skipped: 'cc_switch_profile_not_synced' };
      if (ccSwitch && !discovered) {
        Object.assign(ccSwitch, {
          active_profile_id: selected.id,
          active_provider_id: selected.cc_switch_provider_id,
          switched_at: now(),
          updated_at: now()
        });
        selected.cc_switch_last_switched_at = ccSwitch.switched_at;
      }
    }
    for (const item of state.codex_profiles) item.is_active = item.id === action.profile_id;
    return { type: action.type, profile_id: action.profile_id };
  }
  if (action.type === 'node_run_authorization') {
    const node = state.workflow_nodes.find((item) => item.id === proposal.node_id && item.id === action.node_id);
    const workflow = state.workflows.find(
      (item) => item.id === node?.workflow_id && item.project_id === proposal.project_id
    );
    if (!node || !workflow) return { type: action.type, skipped: 'node_missing' };
    if (!['codex_docker', 'codex'].includes(action.runner)) return { type: action.type, skipped: 'runner_invalid' };
    return {
      type: action.type,
      node_id: node.id,
      runner: action.runner,
      repository_workspace_id: action.repository_workspace_id || null,
      ready: true
    };
  }
  if (['git_commit_authorization', 'git_publish_authorization'].includes(action.type)) {
    const run = state.node_runs.find(
      (item) =>
        item.id === action.run_id && item.project_id === proposal.project_id && item.node_id === proposal.node_id
    );
    if (!run) return { type: action.type, skipped: 'run_missing' };
    return { type: action.type, run_id: run.id, node_id: run.node_id, ready: true };
  }
  if (action.type === 'workflow_nodes_create' && action.workflow_id)
    return createWorkflowNodes(state, proposal, action.workflow_id);
  if (action.type === 'workflow_node_remove') return removeWorkflowNode(state, proposal, action);
  if (action.type === 'workflow_node_update') return updateWorkflowNode(state, proposal, action);
  if (action.type === 'workflow_nodes_connect') return connectWorkflowNodes(state, proposal, action);
  if (action.type === 'record_only') return { type: action.type, recorded: true };
  return { type: action.type || 'unknown', skipped: 'unsupported_apply_action' };
}

function createWorkflowNodes(state, proposal, workflowId) {
  const workflow = state.workflows.find((item) => item.id === workflowId);
  const project = state.projects.find((item) => item.id === workflow?.project_id);
  if (!workflow || !project || project.id !== proposal.project_id)
    return { type: 'workflow_nodes_create', skipped: 'workflow_or_project_missing' };
  const actorId = proposal.approved_by_user_id || proposal.created_by_user_id;
  const existing = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  const nextOrder = Math.max(-1, ...existing.map((item) => Number(item.order_index) || 0)) + 1;
  const allowedTypes = new Set(['goal_definition', 'research', 'analysis', 'execution', 'retrospective']);
  const created = (proposal.after_json?.nodes || []).slice(0, 20).map((input, index) => ({
    id: id('wfn'),
    workflow_id: workflow.id,
    workspace_id: null,
    type: allowedTypes.has(input.type) ? input.type : 'execution',
    title: String(input.title || '新节点').slice(0, 100),
    goal: String(input.goal || '').slice(0, 2000),
    status: 'ready',
    order_index: nextOrder + index,
    dependencies: [],
    current_contract_id: null,
    position: input.position,
    created_at: now(),
    updated_at: now()
  }));
  for (let index = 0; index < created.length; index++) {
    created[index].dependencies = (proposal.after_json.nodes[index].dependency_indexes || [])
      .map((dependencyIndex) => ({ node_id: created[dependencyIndex]?.id, type: 'finish_to_start' }))
      .filter((item) => item.node_id);
    const workspace = createNodeWorkspace(project, created[index], actorId);
    const contract = defaultContractForNode(created[index], project, actorId, 'confirmed');
    created[index].workspace_id = workspace.id;
    created[index].current_contract_id = contract.id;
    state.workspaces.push(workspace);
    state.node_contracts.push(contract);
  }
  state.workflow_nodes.push(...created);
  refreshGraph(state, workflow);
  workflow.updated_at = now();
  return { type: 'workflow_nodes_create', workflow_id: workflow.id, node_ids: created.map((item) => item.id) };
}

function removeWorkflowNode(state, proposal, action) {
  const workflow = state.workflows.find(
      (item) => item.id === action.workflow_id && item.project_id === proposal.project_id
    ),
    node = state.workflow_nodes.find((item) => item.id === action.node_id && item.workflow_id === action.workflow_id);
  if (!workflow || !node) return { type: action.type, skipped: 'node_missing' };
  if (state.node_runs.some((item) => item.node_id === node.id && ['queued', 'running'].includes(item.status)))
    return { type: action.type, skipped: 'active_node_run' };
  state.workflow_nodes = state.workflow_nodes.filter((item) => item.id !== node.id);
  for (const item of state.workflow_nodes)
    item.dependencies = (item.dependencies || []).filter((dependency) => dependency.node_id !== node.id);
  const workspace = state.workspaces.find((item) => item.id === node.workspace_id);
  if (workspace) workspace.status = 'archived';
  refreshGraph(state, workflow);
  return { type: action.type, node_id: node.id };
}

function updateWorkflowNode(state, proposal, action) {
  const workflow = state.workflows.find(
      (item) => item.id === action.workflow_id && item.project_id === proposal.project_id
    ),
    node = state.workflow_nodes.find((item) => item.id === action.node_id && item.workflow_id === action.workflow_id);
  if (!workflow || !node) return { type: action.type, skipped: 'node_missing' };
  const patch = proposal.after_json || {};
  const previousType = node.type,
    previousGoal = node.goal;
  if (typeof patch.title === 'string' && patch.title.trim()) node.title = patch.title.trim().slice(0, 100);
  if (typeof patch.goal === 'string') node.goal = patch.goal.trim().slice(0, 2000) || node.title;
  if (['goal_definition', 'research', 'analysis', 'execution', 'retrospective'].includes(patch.type))
    node.type = patch.type;
  if (node.type !== previousType || node.goal !== previousGoal)
    refreshNodeContract(state, proposal, workflow, node, node.type !== previousType);
  const workspace = state.workspaces.find((item) => item.id === node.workspace_id);
  if (workspace) Object.assign(workspace, { title: node.title, goal: node.goal, updated_at: now() });
  node.updated_at = now();
  refreshGraph(state, workflow);
  return { type: action.type, node_id: node.id };
}

function refreshNodeContract(state, proposal, workflow, node, reset) {
  const current = state.node_contracts.find((item) => item.id === node.current_contract_id),
    project = state.projects.find((item) => item.id === workflow.project_id);
  if (!current || !project) return;
  const actorId = proposal.approved_by_user_id || proposal.created_by_user_id;
  const next = reset
    ? defaultContractForNode(node, project, actorId, 'confirmed')
    : applyContractPatch(current, { node_goal: node.goal }, actorId);
  Object.assign(next, {
    version: Number(current.version || 0) + 1,
    status: 'confirmed',
    confirmed_by: 'human',
    confirmed_by_user_id: actorId
  });
  current.status = 'superseded';
  state.node_contracts.push(next);
  node.current_contract_id = next.id;
}

function connectWorkflowNodes(state, proposal, action) {
  const workflow = state.workflows.find(
      (item) => item.id === action.workflow_id && item.project_id === proposal.project_id
    ),
    target = state.workflow_nodes.find(
      (item) => item.id === action.target_id && item.workflow_id === action.workflow_id
    ),
    source = state.workflow_nodes.find(
      (item) => item.id === action.source_id && item.workflow_id === action.workflow_id
    );
  if (!workflow || !source || !target) return { type: action.type, skipped: 'node_missing' };
  if (dependsOn(state, source, target.id)) return { type: action.type, skipped: 'dependency_cycle' };
  if (!(target.dependencies || []).some((item) => item.node_id === source.id))
    target.dependencies = [...(target.dependencies || []), { node_id: source.id, type: 'finish_to_start' }];
  refreshGraph(state, workflow);
  return { type: action.type, source_id: source.id, target_id: target.id };
}

function dependsOn(state, node, targetId, visited = new Set()) {
  if (node.id === targetId) return true;
  if (visited.has(node.id)) return false;
  visited.add(node.id);
  return (node.dependencies || []).some((item) => {
    const parent = state.workflow_nodes.find((candidate) => candidate.id === item.node_id);
    return parent ? dependsOn(state, parent, targetId, visited) : false;
  });
}

function refreshGraph(state, workflow) {
  const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  workflow.graph_json = {
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, label: node.title, position: node.position })),
    edges: nodes.flatMap((node) =>
      (node.dependencies || [])
        .filter((item) => item.node_id)
        .map((item, index) => ({ id: `${item.node_id}-${node.id}-${index}`, source: item.node_id, target: node.id }))
    )
  };
  workflow.version = Number(workflow.version || 1) + 1;
  workflow.updated_at = now();
}

function assertProposalProjectIdle(state, proposal) {
  return proposal.project_id
    ? assertProjectLifecycleIdle(state.projects.find((item) => item.id === proposal.project_id))
    : null;
}
function publishProposalOperations(state, proposal) {
  for (const operation of syncProposalOperationState(state, proposal))
    pushV3Event(state, operation.session_id, operation.turn_id, 'operation', operationEvent(operation));
}
