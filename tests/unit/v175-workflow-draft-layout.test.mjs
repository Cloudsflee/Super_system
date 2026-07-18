import assert from 'node:assert/strict';
import { patchWorkflowDraftInState } from '../../apps/api/src/workflow-draft-service.mjs';

const state = {
  projects: [{ id: 'project-layout', status: 'draft', lifecycle_operation: null }],
  workflow_drafts: [{
    id: 'draft-layout', project_id: 'project-layout', status: 'draft', revision: 1, user_modified_at: null,
    nodes: [
      node('goal', 'goal_definition', 80),
      node('execution', 'execution', 390),
      node('review', 'retrospective', 700)
    ]
  }]
};

const first = patchWorkflowDraftInState(state, 'project-layout', { expected_revision: 1, operations: [{ type: 'add_node', node: workstream('research', 'Research evidence') }] }, 'owner');
const second = patchWorkflowDraftInState(state, 'project-layout', { expected_revision: first.revision, operations: [{ type: 'add_node', node: workstream('analysis', 'Analysis decision') }] }, 'owner');

assert.deepEqual(second.nodes.find((item) => item.id === 'research').position, { x: 1010, y: 120 });
assert.deepEqual(second.nodes.find((item) => item.id === 'analysis').position, { x: 80, y: 350 });
assert.equal(new Set(second.nodes.map((item) => `${item.position.x}:${item.position.y}`)).size, second.nodes.length);
console.log('V1.75 workflow draft layout tests passed');

function node(id, type, x) { return { ...workstream(id, `${id} outcome`), type, position: { x, y: 120 }, order: x }; }
function workstream(id, title) { return { id, role: 'workstream', title, goal: title, outcome: title, category: 'deliverable', acceptance_criteria: [`Verify ${title}`], boundary: { deliverable: title }, dependency_ids: [] }; }
