import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v17-workflow-assist-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const operations = await import('../../apps/api/src/assist-operations.mjs');
  const capabilities = await import('../../apps/api/src/assist-capabilities-service.mjs');
  const graph = await import('../../apps/api/src/workflow-graph-service.mjs');
  const atomic = await import('../../apps/api/src/proposal-atomic.mjs');
  const context = await import('../../apps/api/src/assist-v3-context.mjs');
  const domain = await import('../../apps/api/src/assist-v3-domain.mjs');
  await stateApi.ensureRuntime();

  const projectId = 'project-formal-assist', workflowId = 'workflow-formal-assist';
  const sessionId = 'session-formal-assist', turnId = 'turn-formal-assist';
  const view = {
    route: `/projects/${projectId}/workflow`, browser_instance_id: 'browser-formal-assist',
    surface: { id: graph.workflowAssistSurfaceId(workflowId), revision: graph.workflowAssistSurfaceRevision({ id: workflowId, version: 1 }), browser_instance_id: 'browser-formal-assist' }
  };
  await stateApi.mutate((state) => seed(state, { projectId, workflowId, sessionId, turnId, view }));

  let state = await stateApi.readState();
  const namespaces = operations.dynamicPageToolSpec(view, 'default', { state, projectId });
  const tools = namespaces.find((item) => item.name === 'aiws_project')?.tools || [];
  assert.deepEqual(new Set(tools.map((item) => item.name)), new Set(['workflow_node_add', 'workflow_node_update', 'workflow_node_delete', 'workflow_node_reorder', 'workflow_node_connect', 'workflow_node_disconnect', 'workflow_graph_patch']));
  assert.ok(tools.every((item) => item.inputSchema.properties.workflow_id.enum[0] === workflowId && item.inputSchema.properties.expected_revision.enum[0] === 1));
  assert.deepEqual(operations.dynamicPageToolSpec(view, 'plan', { state, projectId }), []);

  const catalog = await capabilities.listAssistCapabilities({ project_id: projectId, route: view.route, surface_id: view.surface.id, surface_revision: view.surface.revision });
  assert.equal(catalog.current.find((item) => item.capability_id === 'project.workflow.graph.patch').available, true);
  const forgedCatalog = await capabilities.listAssistCapabilities({ project_id: projectId, route: view.route, surface_id: view.surface.id, surface_revision: `${workflowId}:v99` });
  assert.equal(forgedCatalog.current.find((item) => item.capability_id === 'project.workflow.graph.patch').reason, 'workflow_surface_mismatch');

  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, call('forged-workflow', [{ type: 'update_node', node_id: 'node-1', patch: { title: 'forged' } }], { workflow_id: 'other' })), error('assist_capability_resource_scope_mismatch'));
  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, call('forged-route', [{ type: 'update_node', node_id: 'node-1', patch: { title: 'forged' } }], { route: '/projects/other/workflow' })), error('assist_capability_route_mismatch'));
  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, call('forged-surface', [{ type: 'update_node', node_id: 'node-1', patch: { title: 'forged' } }], { surface_revision: `${workflowId}:v99` })), error('assist_capability_surface_revision_mismatch'));
  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, call('forged-browser', [{ type: 'update_node', node_id: 'node-1', patch: { title: 'forged' } }], { browser_instance_id: 'other-browser' })), error('assist_capability_browser_mismatch'));
  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, call('forged-revision', [{ type: 'update_node', node_id: 'node-1', patch: { title: 'forged' } }], { expected_revision: 2 })), error('workflow_graph_revision_conflict'));

  await stateApi.mutate((current) => { current.assist_turns[0].collaboration_mode = 'plan'; current.assist_turns[0].mode = 'plan'; });
  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, call('plan-write', [{ type: 'update_node', node_id: 'node-1', patch: { title: 'blocked' } }])), error('assist_plan_capability_write_forbidden'));
  await stateApi.mutate((current) => { current.assist_turns[0].collaboration_mode = 'default'; current.assist_turns[0].mode = 'default'; });
  state = await stateApi.readState(); assert.equal(state.change_proposals.length, 0); assert.equal(state.assist_operations.length, 0); assert.equal(state.workflow_nodes.find((item) => item.id === 'node-1').title, '目标成果');

  const firstResult = await operations.handleDynamicPageTool(sessionId, turnId, call('proposal-one', [
    { type: 'add_node', node: workstreamInput('node-3', '并行分析成果', ['node-1'], 'task-3') },
    { type: 'add_node', node: workstreamInput('node-4', '并行调研成果', ['node-1'], 'task-4') }
  ]));
  const toolResult = JSON.parse(firstResult.contentItems[0].text);
  assert.deepEqual({ result_kind: toolResult.result_kind, approval_required: toolResult.approval_required, formal_workflow_changed: toolResult.formal_workflow_changed }, { result_kind: 'change_proposal', approval_required: true, formal_workflow_changed: false });
  state = await stateApi.readState();
  const firstOperation = state.assist_operations.find((item) => item.tool_call_id === 'proposal-one'), firstProposal = state.change_proposals.find((item) => item.id === firstOperation.proposal_id);
  assert.equal(firstOperation.status, 'committed'); assert.equal(firstOperation.result_kind, 'change_proposal');
  assert.equal(firstProposal.status, 'pending'); assert.equal(state.workflows[0].version, 1); assert.equal(state.workflow_nodes.length, 4);

  await stateApi.mutate((current) => { current.assist_turns[0].operation_reference_id = firstOperation.id; });
  await assert.rejects(() => operations.handleDynamicPageTool(sessionId, turnId, nodeCall('reference-target-forged')), error('assist_operation_reference_target_mismatch'));
  await operations.handleDynamicPageTool(sessionId, turnId, call('proposal-replacement', [{ type: 'update_node', node_id: 'node-1', patch: { title: '明确正式目标' } }]));
  state = await stateApi.readState();
  const replacementOperation = state.assist_operations.find((item) => item.tool_call_id === 'proposal-replacement'), replacement = state.change_proposals.find((item) => item.id === replacementOperation.proposal_id);
  assert.equal(state.change_proposals.find((item) => item.id === firstProposal.id).status, 'superseded');
  assert.equal(replacement.replaces_proposal_id, firstProposal.id); assert.equal(replacement.apply_action.operations.length, 3);
  assert.equal(state.workflows[0].version, 1); assert.equal(state.workflow_nodes.length, 4);

  await stateApi.mutate((current) => {
    const owner = current.users.find((item) => item.role === 'owner') || current.users[0], proposal = current.change_proposals.find((item) => item.id === replacement.id);
    atomic.applyProposalAtomically(current, proposal, owner, { revision: proposal.revision, target_hash: proposal.target_hash });
  });
  state = await stateApi.readState();
  assert.equal(state.workflows[0].version, 2); assert.equal(state.workflow_nodes.length, 8); assert.equal(state.workflow_nodes.find((item) => item.id === 'node-1').title, '明确正式目标');
  const publicTurn = domain.turnDetail(state, state.assist_turns[0], null);
  assert.equal(publicTurn.operations.find((item) => item.id === replacementOperation.id).proposal_status, 'applied');
  assert.equal(Object.hasOwn(publicTurn.operations[0], 'tool'), false);

  const actor = state.users.find((item) => item.role === 'owner') || state.users[0], formalContext = context.createTurnContext(state, { actor, project: state.projects[0], session: state.assist_sessions[0], turn: { id: 'context-turn', mode: 'default', prompt: 'inspect', operation_reference_id: null }, attachmentIds: [] });
  assert.equal(Object.hasOwn(formalContext.pack.content_json, 'workflow_draft'), false);
  assert.equal(formalContext.pack.content_json.workflow.id, workflowId);
  assert.equal(formalContext.pack.content_json.workflow.revision, 2);
  assert.equal(formalContext.pack.content_json.workflow.mutation_policy, 'change_proposal');
  assert.equal(formalContext.pack.content_json.workflow.route, view.route);

  console.log('V1.7 formal workflow Assist tests passed');

  function call(callId, graphOperations, overrides = {}) { return { namespace: 'aiws_project', tool: 'workflow_graph_patch', callId, arguments: { project_id: projectId, workflow_id: workflowId, route: view.route, surface_id: view.surface.id, surface_revision: view.surface.revision, browser_instance_id: view.browser_instance_id, expected_revision: 1, operations: graphOperations, ...overrides } }; }
  function nodeCall(callId) { return { namespace: 'aiws_project', tool: 'workflow_node_update', callId, arguments: { project_id: projectId, workflow_id: workflowId, route: view.route, surface_id: view.surface.id, surface_revision: view.surface.revision, browser_instance_id: view.browser_instance_id, expected_revision: 1, operation: { type: 'update_node', node_id: 'node-1', patch: { title: 'forged target' } } } }; }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function seed(state, ids) {
  state.projects = [{ id: ids.projectId, title: 'Formal Assist', goal: 'Ship', status: 'active', onboarding_state: 'confirmed', current_workspace_id: 'workspace-root', managed_workspace_state: 'ready', settings: {}, lifecycle_operation: null }];
  state.workflows = [{ id: ids.workflowId, project_id: ids.projectId, workspace_id: 'workspace-root', title: 'Formal workflow', version: 1, workflow_revision: 1, hierarchy_mode: 'two_level', semantic_migration_status: 'not_required', legacy_read_only: false, status: 'active', graph_json: { nodes: [], edges: [] }, created_at: new Date(0).toISOString() }];
  state.workflow_nodes = [
    workstream('node-1', '目标成果', 0, []), task('task-1', 'node-1', '形成目标成果'),
    workstream('node-2', '实现成果', 1, ['node-1']), task('task-2', 'node-2', '形成实现成果')
  ];
  state.workspaces = [{ id: 'workspace-root', project_id: ids.projectId, status: 'active' }]; state.node_contracts = [];
  state.workflow_drafts = [{ id: 'activated-draft', project_id: ids.projectId, status: 'activated', revision: 1, nodes: [], user_modified_at: null }];
  state.assist_sessions = [{ id: ids.sessionId, version: 3, project_id: ids.projectId, workspace_id: 'workspace-root', scope_type: 'workflow', scope_id: ids.workflowId, scope_status: 'active', archived_at: null, clarification_policy: 'ask', view_context: ids.view }];
  state.assist_turns = [{ id: ids.turnId, session_id: ids.sessionId, project_id: ids.projectId, status: 'running', mode: 'default', collaboration_mode: 'default', view_context: ids.view, operation_reference_id: null }]; state.assist_operations = [];
}
function workstream(id, title, order_index, dependencies) { return { id, workflow_id: 'workflow-formal-assist', workspace_id: null, role: 'workstream', parent_node_id: null, type: 'execution', title, goal: title, outcome: title, category: 'deliverable', boundary: { deliverable: title }, acceptance_criteria: [`验收 ${title}`], required: true, repository_intent: null, repository_target_ids: [], plan_revision: 1, legacy_read_only: false, status: 'ready', order_index, dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })), current_contract_id: null, position: { x: order_index * 200, y: 100 } }; }
function task(id, parent_node_id, title) { return { id, workflow_id: 'workflow-formal-assist', workspace_id: null, role: 'task', parent_node_id, type: 'analysis', title, goal: title, outcome: null, category: null, task_kind: 'analysis', execution_mode: 'assist', boundary: null, acceptance_criteria: [], required: true, repository_intent: null, repository_target_ids: [], plan_revision: null, legacy_read_only: false, status: 'ready', order_index: 0, dependencies: [], current_contract_id: null, position: { x: 100, y: 100 } }; }
function workstreamInput(id, title, dependency_ids, taskId) { return { id, role: 'workstream', title, goal: title, outcome: title, category: 'deliverable', boundary: { deliverable: title }, acceptance_criteria: [`验收 ${title}`], dependency_ids, tasks: [{ id: taskId, role: 'task', title: `完成${title}`, task_kind: 'analysis', execution_mode: 'assist', dependency_ids: [] }] }; }
function error(code) { return (value) => value?.payload?.error === code; }
