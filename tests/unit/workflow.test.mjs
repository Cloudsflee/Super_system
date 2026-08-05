import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflowTasks } from '../../apps/api/src/domain.mjs';

test('validates a two-level DAG and preserves dependency order', () => {
  const tasks = validateWorkflowTasks([
    { id: 'read-a', title: 'Read A', level: 1 },
    { id: 'read-b', title: 'Read B', level: 1 },
    { id: 'write', title: 'Write', level: 2, deps: ['read-a', 'read-b'], mode: 'write' }
  ]);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[2].mode, 'write');
});

test('rejects cycles, backwards levels, and multiple write tasks', () => {
  assert.throws(() => validateWorkflowTasks([{ id: 'a', level: 1, deps: ['b'] }, { id: 'b', level: 1, deps: ['a'] }]), /cycle/);
  assert.throws(() => validateWorkflowTasks([{ id: 'a', level: 2 }, { id: 'b', level: 1, deps: ['a'] }]), /backwards/);
  assert.throws(() => validateWorkflowTasks([{ id: 'a', level: 1, mode: 'write' }, { id: 'b', level: 2, mode: 'write' }]), /at most one/);
});
