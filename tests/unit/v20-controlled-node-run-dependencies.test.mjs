import assert from 'node:assert/strict';

import { assertNodeRunDependencies } from '../../apps/api/src/routes/runs.mjs';

const upstream = {
    id: 'workstream-upstream',
    role: 'workstream',
    status: 'ready_for_submission',
    dependencies: []
  },
  parent = {
    id: 'workstream-consumer',
    role: 'workstream',
    status: 'ready',
    dependencies: [{ node_id: upstream.id, type: 'finish_to_start' }]
  },
  dependency = {
    id: 'task-dependency',
    role: 'task',
    parent_node_id: parent.id,
    status: 'blocked',
    dependencies: []
  },
  task = {
    id: 'task-consumer',
    role: 'task',
    parent_node_id: parent.id,
    dependencies: [{ node_id: dependency.id, type: 'finish_to_start' }]
  },
  state = { workflow_nodes: [upstream, parent, dependency, task] };

assert.throws(
  () => assertNodeRunDependencies(state, task),
  (error) =>
    error?.payload?.error === 'task_dependency_blocked' &&
    error.payload.workstream_dependencies.includes(upstream.id) &&
    error.payload.task_dependencies.includes(dependency.id)
);

// For a controlled execution, workflow readiness plus the bound lease are the
// authority. Legacy projected node statuses must not veto that decision.
assert.doesNotThrow(() => assertNodeRunDependencies(state, task, { controlled: true }));

assert.throws(
  () => assertNodeRunDependencies(state, parent, { controlled: true }),
  (error) => error?.payload?.error === 'workstream_is_aggregate_not_executable'
);

console.log('v20 controlled NodeRun dependency tests passed');
