import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateToLegacyTasks, validateWorkflowCandidate } from '../../apps/api/src/modules/workflow/validator.mjs';

function valid() {
  return {
    name: 'R4 workflow',
    workstreams: [
      {
        id: 'plan',
        tasks: [{ id: 'inspect', goal: 'Inspect', outputs: ['artifacts/analysis.json'], acceptance: ['analysis exists'] }]
      },
      {
        id: 'delivery',
        deps: ['plan'],
        tasks: [{ id: 'implement', goal: 'Implement', deps: ['inspect'], inputs: ['artifacts/analysis.json'], outputs: ['artifacts/result.json'], allowed_tools: ['git'], acceptance: ['tests pass'] }]
      }
    ]
  };
}

test('R4 canonicalizes a two-level workflow and keeps executable legacy tasks', () => {
  const candidate = validateWorkflowCandidate(valid(), { brief: { acceptance: ['tests pass'] } });
  assert.equal(candidate.hierarchy_mode, 'two_level');
  assert.equal(candidate.workstreams.length, 2);
  assert.equal(candidate.tasks.length, 2);
  assert.match(candidate.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(candidateToLegacyTasks(candidate).map((task) => task.id), ['inspect', 'implement']);
});

test('R4 rejects hierarchy, dependency, cycle and output conflicts with stable codes', () => {
  assert.throws(() => validateWorkflowCandidate({ workstreams: [] }), (error) => error.code === 'workflow_depth_invalid');
  const scoped = valid();
  scoped.workstreams[1].deps = [];
  assert.throws(() => validateWorkflowCandidate(scoped), (error) => error.code === 'workflow_dependency_scope_invalid');
  const cyclic = valid();
  cyclic.workstreams[0].deps = ['delivery'];
  assert.throws(() => validateWorkflowCandidate(cyclic), (error) => error.code === 'workflow_graph_cycle');
  const duplicate = valid();
  duplicate.workstreams[1].tasks[0].outputs = ['artifacts/analysis.json'];
  assert.throws(() => validateWorkflowCandidate(duplicate), (error) => error.code === 'workflow_duplicate_output');
  const prefix = valid();
  prefix.workstreams[1].tasks[0].outputs = ['artifacts/analysis.json/report'];
  assert.throws(() => validateWorkflowCandidate(prefix), (error) => error.code === 'workflow_output_path_conflict');
});

test('R4 validates typed slots and required contract acceptance', () => {
  const slot = valid();
  slot.workstreams[0].tasks[0] = {
    id: 'inspect', goal: 'Inspect', acceptance: ['analysis exists'],
    output_slots: [{ name: 'analysis', type: 'json', selector: 'artifacts/analysis.json', acceptance: ['valid JSON'] }]
  };
  slot.workstreams[1].tasks[0] = {
    id: 'implement', goal: 'Implement', deps: ['inspect'], acceptance: ['tests pass'],
    input_slots: [{ name: 'analysis', type: 'json', target_output: 'analysis', acceptance: ['present'] }],
    output_slots: [{ name: 'result', type: 'json', selector: 'artifacts/result.json', acceptance: ['valid JSON'] }]
  };
  assert.equal(validateWorkflowCandidate(slot).tasks[1].input_slots[0].required, true);
  slot.workstreams[1].tasks[0].output_slots[0].acceptance = [];
  assert.throws(() => validateWorkflowCandidate(slot), (error) => error.code === 'workflow_contract_invalid');
});

test('R4 normalizes selectors and resolves typed upstream outputs exactly once', () => {
  const slot = valid();
  slot.workstreams[0].tasks[0] = {
    id: 'inspect', goal: 'Inspect', acceptance: ['analysis exists'],
    output_slots: [{ name: 'analysis', type: 'json', selector: 'artifacts\\analysis.json', acceptance: ['valid JSON'] }]
  };
  slot.workstreams[1].tasks[0] = {
    id: 'implement', goal: 'Implement', deps: ['inspect'], acceptance: ['tests pass'],
    input_slots: [{ name: 'analysis', type: 'json', selector: 'artifacts/analysis.json', target_output: 'inspect.analysis', acceptance: ['present'] }],
    output_slots: [{ name: 'result', type: 'json', selector: 'artifacts/result.json', acceptance: ['valid JSON'] }]
  };
  const candidate = validateWorkflowCandidate(slot);
  assert.equal(candidate.tasks[0].output_slots[0].selector, 'artifacts/analysis.json');
  assert.equal(candidate.tasks[1].input_slots[0].target_output, 'inspect.analysis');

  const wrongType = structuredClone(slot);
  wrongType.workstreams[1].tasks[0].input_slots[0].type = 'text';
  assert.throws(() => validateWorkflowCandidate(wrongType), (error) => error.code === 'workflow_contract_invalid');
  const missingTarget = structuredClone(slot);
  missingTarget.workstreams[1].tasks[0].input_slots[0].target_output = 'inspect.missing';
  assert.throws(() => validateWorkflowCandidate(missingTarget), (error) => error.code === 'workflow_contract_invalid');
  const duplicateSelector = structuredClone(slot);
  duplicateSelector.workstreams[0].tasks[0].output_slots.push({
    name: 'copy', type: 'json', selector: 'artifacts/analysis.json', acceptance: ['valid JSON']
  });
  assert.throws(() => validateWorkflowCandidate(duplicateSelector), (error) => error.code === 'workflow_duplicate_output');
});

test('R4 rejects reverse declaration dependencies and covers singular Brief fields', () => {
  const reversedWorkstream = valid();
  reversedWorkstream.workstreams[0].deps = ['delivery'];
  reversedWorkstream.workstreams[1].deps = [];
  assert.throws(() => validateWorkflowCandidate(reversedWorkstream), (error) => error.code === 'workflow_dependency_scope_invalid');

  const reversedTask = valid();
  reversedTask.workstreams = [{
    id: 'delivery',
    tasks: [
      { id: 'publish', goal: 'Publish', deps: ['prepare'], outputs: ['artifacts/published.json'], acceptance: ['published'] },
      { id: 'prepare', goal: 'Prepare', outputs: ['artifacts/prepared.json'], acceptance: ['prepared'] }
    ]
  }];
  assert.throws(() => validateWorkflowCandidate(reversedTask), (error) => error.code === 'workflow_dependency_scope_invalid');

  const covered = valid();
  covered.workstreams[0].tasks[0].goal = 'Deliver feature alpha for milestone beta while mitigating risk gamma';
  covered.workstreams[1].tasks[0].acceptance.push('acceptance delta');
  const candidate = validateWorkflowCandidate(covered, {
    brief: { feature: 'feature alpha', milestone: 'milestone beta', risk: 'risk gamma', acceptance: 'acceptance delta' }
  });
  assert.equal(candidate.brief_coverage.complete, true);
  assert.deepEqual(candidate.brief_coverage.missing, []);
});
