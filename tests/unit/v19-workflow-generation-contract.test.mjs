import assert from 'node:assert/strict';

import {
  validateGenerationCandidate,
  workflowGenerationPrompt
} from '../../apps/api/src/workflow-generation-candidate.mjs';
import { generationFingerprint } from '../../apps/api/src/workflow-generation-service.mjs';
import {
  applyWorkflowReplanInState,
  createWorkflowReplanProposalInState
} from '../../apps/api/src/workflow-graph-service.mjs';
import {
  normalizeWorkflowPlanningFields,
  validateWorkflowPlanningQuality
} from '../../apps/api/src/workflow-quality.mjs';

const state = replanState();
const fingerprint = generationFingerprint(state, 'project-replan', 'replan');
const completed = fingerprint.current_nodes.find((node) => node.id === 'task-completed');

assert.deepEqual(completed.capability_tags, ['execution']);
assert.deepEqual(completed.acceptance_criteria, ['The accepted baseline is retained.']);
assert.equal(
  completed.input_slots.some((slot) => slot.source === 'brief'),
  false
);
assert.equal(completed.input_slots[0].key, 'repository_snapshot');
assert.equal(completed.output_slots[0].asset_type, 'CodeChangeAsset');
assert.deepEqual(completed.repository_intent, { mode: 'write', repository: 'primary' });
assert.equal(completed.execution_revision, 3);

const prompt = workflowGenerationPrompt(fingerprint);
assert.match(prompt, /"role":"workstream"/);
assert.match(prompt, /"role":"task"/);
assert.match(prompt, /especially id, parent_node_id, title, goal, task_kind/);
assert.match(prompt, /"input_slots"/);
assert.match(prompt, /"output_slots"/);
assert.match(prompt, /RepositoryVersionAsset/);
assert.match(prompt, /Integration delivery inputs must both reference the acceptance Task/);
assert.match(prompt, /source="workstream_dependency"/);
assert.match(prompt, /dependency_ids control readiness and may be ordering-only/);
assert.match(prompt, /WorkstreamOutcome receipt is verification metadata and is never a consumable input/);
assert.match(prompt, /An empty input_slots array is valid/);
assert.match(prompt, /match the project's primary natural language/);
assert.match(
  prompt,
  /If Simplified Chinese is primary, write every user-visible title, goal, outcome, acceptance_criteria, and decomposition_basis value in Simplified Chinese/
);
assert.match(
  prompt,
  /Keep product and proper names, CLI commands, paths, URLs, JSON or Schema keys, and SHAs unchanged/
);
assert.match(
  workflowGenerationPrompt(fingerprint, [{ code: 'FIX_SELECTOR', node_id: 'task-a' }]),
  /Previous attempt critic errors.*FIX_SELECTOR/
);

const repaired = normalizeWorkflowPlanningFields([
  task('task-normalized', 'Normalized generated task', 'test', 'codex', ['model_specific_test_tag'], ['task-completed'])
])[0];
assert.equal(repaired.capability_tags.includes('acceptance'), true);
assert.equal(
  repaired.input_slots.some((slot) => slot.source === 'dependency' && slot.ref_id === 'task-completed'),
  false
);
assert.equal(
  repaired.input_slots.some((slot) => slot.source === 'repository_workspace'),
  true
);
assert.equal(
  repaired.output_slots.some((slot) => slot.acceptance_criteria.includes('Normalized generated task is accepted.')),
  true
);
const crossWorkstream = normalizeWorkflowPlanningFields([
  { id: 'workstream-source', role: 'workstream', dependency_ids: [] },
  {
    ...task('task-source-terminal', 'Publish source delivery', 'review', 'assist', ['acceptance'], []),
    parent_node_id: 'workstream-source',
    output_slots: [output('source_delivery', ['Source delivery is accepted.'])]
  },
  { id: 'workstream-target', role: 'workstream', dependency_ids: ['workstream-source'] },
  {
    ...task('task-target-entry', 'Consume source outcome', 'research', 'assist', ['research_evidence'], []),
    parent_node_id: 'workstream-target',
    input_slots: [
      dependencyInput(
        'source_delivery',
        'workstream_dependency',
        'workstream-source',
        'source_delivery',
        'research_result'
      )
    ]
  },
  {
    ...task(
      'task-target-next',
      'Continue target work',
      'analysis',
      'assist',
      ['constraint_analysis'],
      ['task-target-entry']
    ),
    parent_node_id: 'workstream-target',
    input_slots: [
      dependencyInput('research_result', 'dependency', 'task-target-entry', 'research_result', 'analysis_result')
    ]
  }
]);
const targetEntry = crossWorkstream.find((item) => item.id === 'task-target-entry'),
  targetNext = crossWorkstream.find((item) => item.id === 'task-target-next');
assert.deepEqual(
  targetEntry.input_slots.find((slot) => slot.source === 'workstream_dependency'),
  {
    key: 'source_delivery',
    kind: 'asset_version',
    required: true,
    source: 'workstream_dependency',
    selector: 'source_delivery',
    ref_id: 'workstream-source',
    version_id: null,
    consumption_policy: null,
    application_policy: 'required',
    purpose: 'Apply source_delivery to research_result.',
    target_output_keys: ['research_result'],
    coverage_policy: 'all'
  }
);
assert.equal(
  targetNext.input_slots.some((slot) => slot.source === 'workstream_dependency'),
  false
);
const crossQualityNodes = [
  { id: 'quality-source', role: 'workstream', dependency_ids: [] },
  {
    ...task('quality-source-terminal', 'Publish two exports', 'review', 'assist', ['acceptance'], []),
    parent_node_id: 'quality-source',
    output_slots: [
      output('decision_export', ['Publish two exports is accepted.']),
      output('evidence_export', ['Publish two exports is accepted.'])
    ]
  },
  { id: 'quality-target', role: 'workstream', dependency_ids: ['quality-source'] },
  {
    ...task('quality-entry-consumer', 'Consume decision export', 'research', 'assist', ['research_evidence'], []),
    parent_node_id: 'quality-target',
    input_slots: [
      dependencyInput(
        'decision_export',
        'workstream_dependency',
        'quality-source',
        'decision_export',
        'research_result'
      )
    ]
  },
  {
    ...task('quality-entry-independent', 'Prepare independent input', 'research', 'assist', ['research_evidence'], []),
    parent_node_id: 'quality-target'
  }
];
const exactCrossQuality = validateWorkflowPlanningQuality({ nodes: crossQualityNodes });
assert.equal(
  exactCrossQuality.errors.some((item) => item.code === 'workflow_workstream_dependency_input_binding_required'),
  false
);
const missingCrossQuality = structuredClone(crossQualityNodes);
missingCrossQuality.find((item) => item.id === 'quality-entry-consumer').input_slots = [];
assert.equal(
  validateWorkflowPlanningQuality({ nodes: missingCrossQuality }).errors.some(
    (item) => item.code === 'workflow_workstream_dependency_input_binding_required'
  ),
  false
);
const outOfScopeCrossQuality = structuredClone(crossQualityNodes);
outOfScopeCrossQuality.find((item) => item.id === 'quality-entry-independent').input_slots = [
  dependencyInput('unrelated', 'workstream_dependency', 'workstream-unrelated', 'delivery', 'research_result')
];
assert.equal(
  validateWorkflowPlanningQuality({ nodes: outOfScopeCrossQuality }).errors.some(
    (item) => item.code === 'workflow_workstream_dependency_input_scope_invalid'
  ),
  true
);
const receiptCrossQuality = structuredClone(crossQualityNodes);
receiptCrossQuality.find((item) => item.id === 'quality-entry-consumer').input_slots[0].selector = 'workstream_outcome';
assert.equal(
  validateWorkflowPlanningQuality({ nodes: receiptCrossQuality }).errors.some(
    (item) => item.code === 'workflow_workstream_outcome_not_consumable'
  ),
  true
);
const broadCrossQuality = structuredClone(crossQualityNodes);
broadCrossQuality.find((item) => item.id === 'quality-entry-consumer').input_slots[0].selector = 'required_outputs';
assert.equal(
  validateWorkflowPlanningQuality({ nodes: broadCrossQuality }).errors.some(
    (item) => item.code === 'workflow_workstream_dependency_output_selector_required'
  ),
  true
);
const fanInQualityNodes = structuredClone(crossQualityNodes);
fanInQualityNodes.push(
  { id: 'quality-source-second', role: 'workstream', dependency_ids: [] },
  {
    ...task('quality-source-second-terminal', 'Publish second export', 'review', 'assist', ['acceptance'], []),
    parent_node_id: 'quality-source-second',
    output_slots: [output('second_export', ['Publish second export is accepted.'])]
  }
);
fanInQualityNodes.find((item) => item.id === 'quality-target').dependency_ids.push('quality-source-second');
fanInQualityNodes
  .find((item) => item.id === 'quality-entry-consumer')
  .input_slots.push(
    dependencyInput(
      'second_export',
      'workstream_dependency',
      'quality-source-second',
      'second_export',
      'research_result'
    )
  );
assert.equal(
  validateWorkflowPlanningQuality({ nodes: fanInQualityNodes }).errors.some(
    (item) => item.code === 'workflow_workstream_dependency_input_binding_required'
  ),
  false
);

const candidate = {
  project_classification: 'software_delivery',
  decomposition_basis: 'Preserve the accepted baseline and add a verified follow-up DAG.',
  evidence_refs: [{ section_id: 'brief-replan', quote: 'Ship a verified increment' }],
  confidence: 0.9,
  repository_intent: [],
  brief_coverage: {
    features: ['task-follow-up'],
    acceptance_criteria: ['task-follow-up'],
    milestones: ['task-follow-up'],
    risks: ['task-follow-up']
  },
  nodes: [
    { ...fingerprint.current_nodes.find((node) => node.id === 'workstream-main'), status: 'ready' },
    completed,
    task('task-evidence', 'Evidence refresh', 'research', 'assist', ['research_evidence'], ['task-completed']),
    task(
      'task-decision',
      'Constraint and solution decision',
      'design',
      'assist',
      ['constraint_analysis', 'solution_decision'],
      ['task-evidence']
    ),
    task(
      'task-follow-up',
      'Implement and accept follow-up',
      'code',
      'codex',
      ['execution', 'acceptance', 'integration_delivery'],
      ['task-decision']
    )
  ]
};
candidate.nodes.find((node) => node.id === 'task-evidence').input_slots = [
  dependencyInput('accepted_baseline', 'dependency', 'task-completed', 'code_result', 'research_result')
];
candidate.nodes.find((node) => node.id === 'task-decision').input_slots = [
  dependencyInput('research_result', 'dependency', 'task-evidence', 'research_result', 'design_result')
];
candidate.nodes.find((node) => node.id === 'task-follow-up').input_slots = [
  dependencyInput('design_result', 'dependency', 'task-decision', 'design_result', 'code_result')
];
attachContributionContracts(candidate.nodes);
const ambiguous = structuredClone(candidate.nodes),
  decision = ambiguous.find((node) => node.id === 'task-decision'),
  followUp = ambiguous.find((node) => node.id === 'task-follow-up');
decision.output_slots = [
  output('decision', decision.acceptance_criteria),
  output('repository_version', decision.acceptance_criteria)
];
followUp.input_slots = [
  {
    key: 'decision_version',
    kind: 'asset_version',
    required: true,
    source: 'dependency',
    selector: 'required_outputs',
    ref_id: decision.id,
    version_id: null,
    consumption_policy: null,
    application_policy: 'required',
    purpose: 'Apply the selected decision to code_result.',
    target_output_keys: ['code_result'],
    coverage_policy: 'all'
  }
];
const ambiguousQuality = validateWorkflowPlanningQuality({
  nodes: ambiguous,
  project: state.projects[0],
  brief: state.project_briefs[0],
  projectClassification: candidate.project_classification,
  briefCoverage: candidate.brief_coverage
});
assert.equal(
  ambiguousQuality.errors.some((item) => item.code === 'workflow_task_dependency_output_selector_required'),
  true
);
const optionalSelection = structuredClone(candidate.nodes),
  optionalProducer = optionalSelection.find((node) => node.id === 'task-decision'),
  optionalConsumer = optionalSelection.find((node) => node.id === 'task-follow-up');
optionalProducer.output_slots = [
  output('decision', optionalProducer.acceptance_criteria),
  { ...output('repository_version', optionalProducer.acceptance_criteria), required: false }
];
optionalConsumer.input_slots = [
  dependencyInput('optional_repository', 'dependency', optionalProducer.id, 'repository_version', 'code_result')
];
assert.equal(
  validateWorkflowPlanningQuality({ nodes: optionalSelection }).errors.some((item) =>
    ['workflow_task_dependency_output_selector_required', 'workflow_task_dependency_output_selector_invalid'].includes(
      item.code
    )
  ),
  false
);
optionalConsumer.input_slots[0].selector = 'required_outputs';
assert.equal(
  validateWorkflowPlanningQuality({ nodes: optionalSelection }).errors.some(
    (item) => item.code === 'workflow_task_dependency_output_selector_required'
  ),
  false
);
const generatedInput = structuredClone(candidate),
  generatedFollowUp = generatedInput.nodes.find((node) => node.id === 'task-follow-up'),
  generatedDecision = generatedInput.nodes.find((node) => node.id === 'task-decision');
generatedFollowUp.input_slots = generatedFollowUp.input_slots.filter((slot) => slot.source !== 'dependency');
generatedDecision.output_slots = [
  { ...output('design_result', generatedDecision.acceptance_criteria), handoff: false }
];
const contributionCandidate = validateGenerationCandidate(generatedInput, fingerprint),
  contributionTask = contributionCandidate.nodes.find((node) => node.id === 'task-decision'),
  bridgeTask = contributionCandidate.nodes.find((node) => node.id === 'task-evidence'),
  contributionContract = contributionTask.input_slots[0].contribution;
assert.equal(bridgeTask.progression_protocol, null);
assert.equal(bridgeTask.progression_compatibility, 'legacy_upstream_bridge');
assert.equal(contributionTask.progression_protocol, 'aiws.task_progression.v1');
assert.equal(contributionContract.schema_version, 'aiws.input_contribution.v1');
assert.match(contributionContract.id, /^ic_[a-f0-9]{24}$/);
assert.equal(
  contributionContract.target_criterion_ids.every((id) => /^ac_[a-f0-9]{24}$/.test(id)),
  true
);
const missingContribution = structuredClone(generatedInput);
delete missingContribution.nodes.find((node) => node.id === 'task-decision').input_slots[0].contribution;
assert.throws(
  () => validateGenerationCandidate(missingContribution, fingerprint),
  (error) =>
    error?.payload?.error === 'workflow_planning_quality_failed' &&
    error.payload.errors.some((item) => item.code === 'workflow_task_typed_inputs_invalid')
);
generatedFollowUp.input_slots.push(
  dependencyInput('unrelated', 'dependency', 'task-evidence', 'research_result', 'code_result')
);
assert.throws(
  () => validateGenerationCandidate(generatedInput, fingerprint),
  (error) =>
    error?.payload?.error === 'workflow_planning_quality_failed' &&
    error.payload.errors.some((item) => item.code === 'workflow_task_dependency_input_scope_invalid')
);
const created = createWorkflowReplanProposalInState(state, 'workflow-replan', candidate, 'owner');
applyWorkflowReplanInState(state, created.proposal);
assert.equal(state.workflow_nodes.find((node) => node.id === 'task-completed').status, 'completed');
assert.equal(state.workflow_nodes.find((node) => node.id === 'workstream-main').status, 'ready');
assert.equal(state.workflow_nodes.find((node) => node.id === 'task-evidence').status, 'ready');
assert.equal(state.workflow_nodes.find((node) => node.id === 'task-decision').status, 'blocked');
assert.equal(state.workflows[0].planning_quality, 'verified');

function task(id, title, kind, mode, tags, dependencyIds) {
  return {
    id,
    role: 'task',
    parent_node_id: 'workstream-main',
    title,
    goal: title,
    task_kind: kind,
    execution_mode: mode,
    capability_tags: tags,
    acceptance_criteria: [`${title} is accepted.`],
    dependency_ids: dependencyIds,
    repository_intent: kind === 'code' ? { mode: 'write', repository: 'primary' } : null
  };
}
function output(key, acceptance) {
  return {
    key,
    kind: 'asset',
    required: true,
    asset_type: 'DecisionAsset',
    acceptance_criteria: acceptance,
    confirmation_policy: 'human',
    handoff: true,
    consumer_hint: null,
    purpose: `Deliver ${key} to its declared consumer.`
  };
}
function dependencyInput(key, source, refId, selector, targetOutputKey) {
  return {
    key,
    kind: 'asset_version',
    required: true,
    source,
    selector,
    ref_id: refId,
    version_id: null,
    consumption_policy: null,
    application_policy: 'required',
    purpose: `Apply ${key} to ${targetOutputKey}.`,
    target_output_keys: [targetOutputKey],
    coverage_policy: 'all'
  };
}
function attachContributionContracts(nodes) {
  for (const node of nodes.filter((item) => item.role === 'task' && item.status !== 'completed'))
    for (const input of node.input_slots || []) {
      const targets = input.target_output_keys || [],
        criteria = (node.output_slots || [])
          .filter((outputSlot) => targets.includes(outputSlot.key))
          .flatMap((outputSlot) => outputSlot.acceptance_criteria || []);
      input.contribution = {
        schema_version: 'aiws.input_contribution.v1',
        effect: 'constraint',
        expected_effect: `${input.key} constrains the accepted ${targets.join(', ')} decision.`,
        target_output_keys: targets,
        target_criteria: criteria.length ? criteria : node.acceptance_criteria || [],
        origin: 'declared'
      };
    }
}

function replanState() {
  const at = '2026-07-21T12:00:00.000Z';
  const workstream = {
    id: 'workstream-main',
    workflow_id: 'workflow-replan',
    workspace_id: 'workspace-workstream',
    role: 'workstream',
    type: 'execution',
    parent_node_id: null,
    title: 'Accepted product increment',
    goal: 'Deliver the accepted product increment.',
    outcome: 'An accepted product increment.',
    category: 'deliverable',
    boundary: { deliverable: 'product_increment' },
    acceptance_criteria: ['The accepted baseline is retained.'],
    status: 'completed',
    required: true,
    order_index: 0,
    plan_revision: 1,
    execution_revision: 1,
    dependencies: [],
    created_at: at,
    updated_at: at
  };
  const completed = {
    id: 'task-completed',
    workflow_id: 'workflow-replan',
    workspace_id: 'workspace-task',
    role: 'task',
    type: 'execution',
    parent_node_id: workstream.id,
    title: 'Accepted baseline',
    goal: 'Retain the accepted baseline.',
    task_kind: 'code',
    execution_mode: 'codex',
    status: 'completed',
    required: true,
    repository_intent: { mode: 'write', repository: 'primary' },
    capability_tags: ['execution'],
    acceptance_criteria: ['The accepted baseline is retained.'],
    dependencies: [],
    order_index: 0,
    execution_revision: 3,
    created_at: at,
    updated_at: at
  };
  return {
    instance_owner_user_id: 'owner',
    users: [{ id: 'owner' }],
    projects: [
      {
        id: 'project-replan',
        title: 'Replan project',
        goal: 'Ship a verified increment',
        status: 'active',
        onboarding_state: 'confirmed',
        current_workspace_id: 'workspace-root'
      }
    ],
    project_intakes: [{ project_id: 'project-replan', mode: 'brainstorm', context_sources: [] }],
    project_briefs: [
      {
        id: 'brief-replan',
        project_id: 'project-replan',
        status: 'active',
        version: 1,
        revision: 1,
        content: {
          summary: 'Ship a verified increment',
          features: ['Follow-up implementation'],
          acceptance_criteria: ['Accepted follow-up'],
          milestones: ['Delivery'],
          risks: ['Regression']
        }
      }
    ],
    workflows: [
      {
        id: 'workflow-replan',
        project_id: 'project-replan',
        workspace_id: 'workspace-root',
        title: 'Product workflow',
        status: 'active',
        version: 1,
        workflow_revision: 1,
        planning_quality: 'legacy_unverified'
      }
    ],
    workflow_nodes: [workstream, completed],
    workflow_drafts: [],
    workflow_generations: [],
    workflow_generation_events: [],
    import_jobs: [],
    attachments: [],
    workspaces: [
      { id: 'workspace-root', project_id: 'project-replan', status: 'active' },
      { id: 'workspace-workstream', project_id: 'project-replan', workflow_node_id: workstream.id, status: 'active' },
      { id: 'workspace-task', project_id: 'project-replan', workflow_node_id: completed.id, status: 'active' }
    ],
    node_contracts: [],
    node_runs: [],
    change_proposals: [],
    assist_sessions: [],
    assist_turns: [],
    assist_events: [],
    assist_change_batches: [],
    runtime_user_inputs: [],
    human_reviews: [],
    worktrees: []
  };
}

console.log('V1.9 workflow generation contract regression tests passed');
