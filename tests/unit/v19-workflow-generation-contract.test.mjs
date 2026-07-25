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
assert.equal(completed.input_slots[0].key, 'project_brief');
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
  true
);
assert.equal(
  repaired.input_slots.some((slot) => slot.source === 'repository_workspace'),
  true
);
assert.equal(
  repaired.output_slots.some((slot) => slot.acceptance_criteria.includes('Normalized generated task is accepted.')),
  true
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
    version_id: null
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
const generatedInput = structuredClone(candidate);
generatedInput.nodes.find((node) => node.id === 'task-follow-up').input_slots = [
  {
    key: 'repository',
    kind: 'repository',
    required: true,
    source: 'repository_workspace',
    selector: 'fixed_sha',
    ref_id: 'repository-target-not-workspace',
    version_id: 'not-a-version'
  }
];
const normalizedGenerated = validateGenerationCandidate(generatedInput, fingerprint),
  normalizedEvidence = normalizedGenerated.nodes.find((node) => node.id === 'task-evidence'),
  normalizedFollowUp = normalizedGenerated.nodes.find((node) => node.id === 'task-follow-up');
assert.equal(normalizedEvidence.status, 'ready');
assert.equal(normalizedFollowUp.status, 'blocked');
assert.equal(normalizedFollowUp.input_slots.find((slot) => slot.source === 'repository_workspace').ref_id, null);
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
    confirmation_policy: 'human'
  };
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
