import assert from 'node:assert/strict';

import {
  assertWorkflowHierarchy, critiqueWorkflowGenerationCandidate, isProcessStageTitle,
  normalizeWorkflowGenerationCandidate, normalizeWorkflowHierarchyNodes
} from '../../apps/api/src/workflow-hierarchy-domain.mjs';
import {
  applyWorkflowGraphPatchInState, createWorkflowGraphProposalInState,
  workflowGraphSnapshot
} from '../../apps/api/src/workflow-graph-service.mjs';
import {
  assertSessionScope, invalidateAssistScopesInState, makeSession, resolveScope, sessionSummary
} from '../../apps/api/src/assist-v3-domain.mjs';
import { proposalTargetHash } from '../../apps/api/src/proposal-target.mjs';

const outcomeFixtures = [
  ['software_delivery', 'Runnable import capability', 'code', 'codex'],
  ['paper_research', 'Evidence synthesis accepted by reviewers', 'research', 'assist'],
  ['event_planning', 'Confirmed venue and executable run sheet', 'manual', 'manual'],
  ['content_production', 'Published editorial package', 'content', 'assist'],
  ['data_analysis', 'Validated analysis dataset and findings', 'analysis', 'assist'],
  ['manual_program', 'Approved community service plan', 'manual', 'manual']
];

for (const [classification, title, taskKind, executionMode] of outcomeFixtures) {
  const candidate = normalizeWorkflowGenerationCandidate(candidateFor(classification, title, taskKind, executionMode));
  assert.equal(candidate.nodes.filter((item) => item.role === 'workstream').length, 1);
  assert.equal(candidate.nodes.filter((item) => item.role === 'task').length, 1);
  assert.equal(critiqueWorkflowGenerationCandidate(candidate).ok, true);
  assert.equal(candidate.nodes.some((item) => item.role === 'workstream' && isProcessStageTitle(item.title)), false);
}

assert.equal(isProcessStageTitle('\u7f16\u7801\u9636\u6bb5'), true);
assert.equal(isProcessStageTitle('Testing phase'), true);
assert.throws(() => normalizeWorkflowGenerationCandidate(candidateFor('software', '\u7f16\u7801\u9636\u6bb5', 'code', 'codex')), code('workflow_workstream_process_stage_forbidden'));
assert.throws(() => normalizeWorkflowGenerationCandidate(candidateFor('invalid-role', 'Accepted package', 'manual', 'manual', { task: { role: 'worker' } })), code('workflow_node_role_invalid'));
assert.throws(() => normalizeWorkflowGenerationCandidate(candidateFor('invalid-category', 'Accepted package', 'manual', 'manual', { workstream: { category: 'phase' } })), code('workflow_workstream_category_invalid'));
assert.throws(() => normalizeWorkflowGenerationCandidate(candidateFor('invalid-kind', 'Accepted package', 'manual', 'manual', { task: { task_kind: 'compile' } })), code('workflow_task_kind_invalid'));
assert.throws(() => normalizeWorkflowGenerationCandidate(candidateFor('nested', 'Accepted package', 'manual', 'manual', { task: { tasks: [{ role: 'task' }] } })), code('workflow_hierarchy_depth_exceeded'));

const unknownDependency = candidateFor('research', 'Reviewed evidence package', 'research', 'assist');
unknownDependency.workstreams[0].tasks[0].dependency_ids = ['missing-task'];
assert.throws(() => normalizeWorkflowGenerationCandidate(unknownDependency), code('workflow_graph_dependency_not_found'));

const crossScope = twoWorkstreamCandidate();
crossScope.workstreams[1].tasks[0].dependency_ids = ['task-a'];
assert.throws(() => normalizeWorkflowGenerationCandidate(crossScope), code('workflow_task_dependency_scope_invalid'));

const tooMany = candidateFor('manual', 'Outcome 0', 'manual', 'manual');
tooMany.workstreams = Array.from({ length: 7 }, (_, index) => workstream(`ws-${index}`, `Outcome package ${index}`, `task-${index}`));
assert.throws(() => normalizeWorkflowGenerationCandidate(tooMany), code('workflow_workstream_count_invalid'));

const graphState = hierarchyState();
assert.equal(workflowGraphSnapshot(graphState, 'workflow-1').revision, 4);
assert.equal(workflowGraphSnapshot(graphState, 'workflow-1', 'ws-a').revision, 7);
assert.deepEqual(workflowGraphSnapshot(graphState, 'workflow-1').nodes.map((item) => item.id), ['ws-a', 'ws-b']);
assert.deepEqual(workflowGraphSnapshot(graphState, 'workflow-1', 'ws-a').nodes.map((item) => item.id), ['task-a', 'task-a2']);

assert.throws(() => createWorkflowGraphProposalInState(graphState, 'workflow-1', {
  parent_node_id: 'ws-a', expected_revision: 7,
  operations: [{ type: 'connect', node_id: 'task-a2', dependency_id: 'task-b' }]
}, 'owner'), code('workflow_task_dependency_scope_invalid'));

const local = createWorkflowGraphProposalInState(graphState, 'workflow-1', {
  parent_node_id: 'ws-a', expected_revision: 7,
  operations: [{ type: 'update_node', node_id: 'task-a', patch: { title: 'Collect verified inputs' } }]
}, 'owner');
const localTargetHash = proposalTargetHash(graphState, local.proposal);
graphState.workflow_nodes.find((item) => item.id === 'task-b').title = 'Unrelated task changed';
assert.equal(proposalTargetHash(graphState, local.proposal), localTargetHash, 'local proposal hashes exclude sibling Workstreams');
applyWorkflowGraphPatchInState(graphState, local.proposal);
assert.equal(graphState.workflow_nodes.find((item) => item.id === 'ws-a').plan_revision, 8);
assert.equal(graphState.workflows[0].workflow_revision, 4, 'local task edits do not advance the top-level revision');

const top = createWorkflowGraphProposalInState(graphState, 'workflow-1', {
  expected_revision: 4,
  operations: [{ type: 'update_node', node_id: 'ws-b', patch: { title: 'Accepted launch package' } }]
}, 'owner');
applyWorkflowGraphPatchInState(graphState, top.proposal);
assert.equal(graphState.workflows[0].workflow_revision, 5);
assert.equal(graphState.workflow_nodes.find((item) => item.id === 'ws-a').plan_revision, 8);

const addition = createWorkflowGraphProposalInState(graphState, 'workflow-1', {
  expected_revision: 5,
  operations: [{ type: 'add_node', node: workstream('ws-c', 'Published field guide', 'task-c') }]
}, 'owner');
applyWorkflowGraphPatchInState(graphState, addition.proposal);
const addedWorkstream = graphState.workflow_nodes.find((item) => item.id === 'ws-c');
const addedTask = graphState.workflow_nodes.find((item) => item.id === 'task-c');
const addedTaskWorkspace = graphState.workspaces.find((item) => item.id === addedTask.workspace_id);
assert.equal(addedTaskWorkspace.parent_workspace_id, addedWorkstream.workspace_id, 'a Task created with its Workstream receives the new Workstream Workspace as parent');
assert.equal(addedTaskWorkspace.type, 'task');

const project = graphState.projects[0];
for (const [scopeType, scopeId, expectedLength] of [['project', project.id, 1], ['workflow', 'workflow-1', 2], ['workstream', 'ws-a', 3], ['task', 'task-a', 4]]) {
  const scope = resolveScope(graphState, project, scopeType, scopeId);
  assert.equal(scope.breadcrumb.length, expectedLength);
  const session = makeSession({ actor: { id: 'owner' }, project, scope, title: `${scopeType} thread`, viewContext: {} });
  graphState.assist_sessions.push(session);
  assert.equal(session.scope_type, scopeType);
  assert.equal(sessionSummary(graphState, session).scope_breadcrumb.at(-1).id, scopeId);
  assert.throws(() => assertSessionScope(graphState, session, { project_id: project.id, scope_type: scopeType, scope_id: `${scopeId}-other` }), code('assist_session_scope_mismatch'));
}

const taskSession = graphState.assist_sessions.find((item) => item.scope_type === 'task');
const snapshotBeforeInvalidation = structuredClone(taskSession.scope_snapshot);
assert.deepEqual(invalidateAssistScopesInState(graphState, ['task-a']), [taskSession.id]);
assert.equal(taskSession.read_only, true);
assert.deepEqual(taskSession.scope_snapshot, snapshotBeforeInvalidation);
assert.throws(() => assertSessionScope(graphState, taskSession), code('assist_scope_read_only'));

console.log('V1.9 hierarchy, revision, and Assist scope unit tests passed');

function candidateFor(classification, title, taskKind, executionMode, overrides = {}) {
  return {
    project_classification: classification,
    decomposition_basis: 'Split by independently acceptable outcomes rather than lifecycle phases.',
    evidence_refs: [{ section_id: 'brief-goal', quote: 'The outcome must be independently reviewable.' }],
    confidence: 0.91,
    repository_intent: taskKind === 'code' ? [{ mode: 'write', repository: 'primary' }] : [],
    workstreams: [{
      ...workstream('ws-main', title, 'task-main'),
      ...overrides.workstream,
      tasks: [{ ...workstream('ws-main', title, 'task-main').tasks[0], task_kind: taskKind, execution_mode: executionMode, ...overrides.task }]
    }]
  };
}

function workstream(id, title, taskId) {
  return {
    id, role: 'workstream', title, outcome: `${title} with acceptance evidence.`, category: 'deliverable',
    boundary: { deliverable: id }, acceptance_criteria: ['The outcome is independently reviewable.'], dependency_ids: [],
    tasks: [{ id: taskId, role: 'task', title: `Produce ${title}`, goal: `Complete ${title}`, task_kind: 'manual', execution_mode: 'manual', dependency_ids: [] }]
  };
}

function twoWorkstreamCandidate() {
  const first = workstream('ws-a', 'Accepted evidence package', 'task-a');
  first.tasks.push({ id: 'task-a2', role: 'task', title: 'Verify evidence package', goal: 'Verify all evidence', task_kind: 'review', execution_mode: 'assist', dependency_ids: ['task-a'] });
  return {
    project_classification: 'multi_outcome', decomposition_basis: 'Two independent deliverables.',
    evidence_refs: [{ section_id: 'brief-goal', quote: 'Two outcomes.' }], confidence: 0.9, repository_intent: [],
    workstreams: [first, { ...workstream('ws-b', 'Approved decision record', 'task-b'), dependency_ids: ['ws-a'] }]
  };
}

function hierarchyState() {
  const nodes = normalizeWorkflowHierarchyNodes(twoWorkstreamCandidate().workstreams).map((node) => ({
    ...node, workflow_id: 'workflow-1', workspace_id: `workspace-${node.id}`, status: node.dependency_ids.length ? 'blocked' : 'ready',
    dependencies: node.dependency_ids.map((node_id) => ({ node_id, type: 'finish_to_start' })),
    plan_revision: node.id === 'ws-a' ? 7 : node.plan_revision
  }));
  return {
    projects: [{ id: 'project-1', title: 'Outcome project', goal: 'Ship outcomes', current_workspace_id: 'workspace-root' }],
    workflows: [{ id: 'workflow-1', project_id: 'project-1', workspace_id: 'workspace-root', title: 'Outcome workflow', status: 'active', version: 4, workflow_revision: 4, hierarchy_mode: 'two_level' }],
    workflow_nodes: nodes,
    workspaces: [{ id: 'workspace-root', project_id: 'project-1', status: 'active' }, ...nodes.map((node) => ({ id: node.workspace_id, project_id: 'project-1', workflow_node_id: node.id, status: 'active' }))],
    node_contracts: [], node_runs: [], change_proposals: [], assist_sessions: [], assist_turns: [], assist_events: [], assist_change_batches: [], attachments: [], assist_operations: [], runtime_user_inputs: [], human_reviews: [], worktrees: []
  };
}

function code(expected) {
  return (error) => error?.code === expected || error?.payload?.error === expected;
}
