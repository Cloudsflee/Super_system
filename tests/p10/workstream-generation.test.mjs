// Owner: Workflow. Phase: P10+ maintenance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicGenerator, normalizeGraph } from '../../apps/api/src/clean/project-workflow.mjs';

test('Brief workstreams retain IDs, names, order and dependencies without invented checks', async () => {
  const workstreams = [
    { id: 'first', name: 'First', order: 2, dependsOn: [] },
    { id: 'second', name: 'Second', order: 7, dependsOn: ['first'] }
  ];
  const result = await deterministicGenerator({ brief: { workstreams } });
  assert.deepEqual(normalizeGraph(result).nodes.map(({ id, title, order, depends_on }) => ({ id, name: title, order, dependsOn: depends_on })), workstreams);
  assert.ok(result.nodes.every(node => node.kind === 'workstream'));
});

test('explicit candidate has priority and executable tasks retain their contracts', async () => {
  const candidate = { nodes: [{ id: 'explicit', kind: 'task' }] };
  assert.equal(await deterministicGenerator({ candidate }), candidate);
  const task = { id: 'tests', config: { execution: { argv: ['npm', 'test'], mode: 'read', check_ids: ['node_test'], capabilities: ['network:none'] } }, contract: { acceptance: ['tests pass'] } };
  const result = await deterministicGenerator({ brief: { workstreams: [{ id: 'one', name: 'One', tasks: [task] }] } });
  assert.deepEqual(result.nodes[1].config, task.config);
  assert.deepEqual(result.nodes[1].contract, task.contract);
  assert.equal(result.nodes[1].parent_id, 'one');
});

test('missing, empty, duplicate and invalid workstreams fail closed', async () => {
  for (const brief of [{}, { workstreams: [] }]) await assert.rejects(deterministicGenerator({ brief }), { code: 'brief_workstreams_required' });
  await assert.rejects(deterministicGenerator({ brief: { workstreams: [{}] } }), { code: 'brief_workstream_invalid' });
  await assert.rejects(deterministicGenerator({ brief: { workstreams: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] } }), { code: 'brief_workstream_duplicate' });
  for (const workstreams of [
    [{ id: 'a', name: 'A', dependsOn: ['missing'] }],
    [{ id: 'a', name: 'A', depends_on: 'missing' }],
    [{ id: 'a', name: 'A', dependsOn: ['b'] }, { id: 'b', name: 'B', dependsOn: ['a'] }]
  ]) await assert.rejects(deterministicGenerator({ brief: { workstreams } }), { code: 'brief_workstream_dependency_invalid' });
  await assert.rejects(deterministicGenerator({ brief: { workstreams: [{ id: '1', name: 'One', tasks: [{ id: 1 }] }] } }), { code: 'brief_workstream_duplicate' });
});
