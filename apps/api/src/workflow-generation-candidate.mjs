import { hashString } from '../../../packages/shared/index.mjs';
import { normalizeWorkflowGenerationCandidate, normalizeWorkflowHierarchyNodes } from './workflow-hierarchy-domain.mjs';
import { assertWorkflowPlanningQuality, defaultBriefCoverage } from './workflow-quality.mjs';

export function validateGenerationCandidate(value, fingerprint, options = {}) {
  const candidate = normalizeWorkflowGenerationCandidate(value, options);
  const nodes = normalizeGeneratedRuntimeState(candidate.nodes, fingerprint);
  const quality = assertWorkflowPlanningQuality({
    nodes,
    project: fingerprint.project,
    brief: fingerprint.brief,
    projectClassification: candidate.project_classification,
    briefCoverage: candidate.brief_coverage
  });
  return { ...candidate, nodes: quality.nodes, brief_coverage: quality.brief_coverage };
}

export function generationContext(fingerprint) {
  const content = fingerprint.brief.content || {};
  return {
    mode: fingerprint.mode,
    project: { id: fingerprint.project.id, title: fingerprint.project.title, goal: fingerprint.project.goal },
    brief: {
      id: fingerprint.brief.id,
      revision: fingerprint.brief.revision,
      title: content.title,
      summary: content.summary,
      sections: content.sections
    },
    materials: fingerprint.intake?.context_sources || [],
    code_source: fingerprint.intake?.code_source || null,
    current_workflow: fingerprint.workflow
      ? {
          id: fingerprint.workflow.id,
          revision: fingerprint.workflow.workflow_revision,
          planning_quality: fingerprint.workflow.planning_quality,
          nodes: fingerprint.current_nodes
        }
      : null,
    material_hash: fingerprint.material_hash,
    code_source_hash: fingerprint.code_source_hash
  };
}

export function workflowGenerationNodeSnapshot(nodes) {
  return normalizeWorkflowHierarchyNodes(nodes || []).map((node) => ({
    id: node.id,
    role: node.role,
    parent_node_id: node.parent_node_id,
    title: node.title,
    goal: node.goal,
    outcome: node.outcome,
    category: node.category,
    boundary: node.boundary,
    status: node.status,
    task_kind: node.task_kind,
    execution_mode: node.execution_mode,
    required: node.required !== false,
    repository_intent: node.repository_intent,
    repository_target_ids: node.repository_target_ids || [],
    capability_tags: node.capability_tags,
    acceptance_criteria: node.acceptance_criteria,
    input_slots: node.input_slots,
    output_slots: node.output_slots,
    atomic_justification: node.atomic_justification,
    dependency_ids: node.dependency_ids,
    order_index: node.order_index,
    position: node.position,
    plan_revision: node.plan_revision,
    execution_revision: Number(node.execution_revision || 1)
  }));
}

export function workflowGenerationPrompt(fingerprint, retryErrors = []) {
  const modeInstruction =
    fingerprint.mode === 'replan'
      ? 'Replan the active workflow as a reviewable replacement. Reuse each existing Workstream id and definition; set a completed Workstream to status="ready" when adding unfinished follow-up Tasks. Every completed Task must remain present. Copy its full current_workflow.nodes snapshot, especially id, parent_node_id, title, goal, task_kind, execution_mode, required, repository_intent, repository_target_ids, capability_tags, acceptance_criteria, input_slots, output_slots, atomic_justification, dependency_ids, status, order_index, position, and execution_revision. Never edit or delete it; add dependent follow-up Tasks for new work.'
      : 'Design an initial outcome-oriented two-level project workflow.';
  return [
    `${modeInstruction} Return JSON only.`,
    'The role field is mandatory on every node: each Workstream must contain "role":"workstream" and every nested Task must contain "role":"task".',
    "For newly generated or editable content, match the project's primary natural language from its title, goal, and Brief. If Simplified Chinese is primary, write every user-visible title, goal, outcome, acceptance_criteria, and decomposition_basis value in Simplified Chinese. Preserve completed nodes exactly during replan. Keep product and proper names, CLI commands, paths, URLs, JSON or Schema keys, and SHAs unchanged.",
    'Use this exact shape: {"project_classification":"...","decomposition_basis":"...","evidence_refs":[{"section_id":"...","quote":"..."}],"confidence":0.8,"repository_intent":[],"brief_coverage":{"features":["task-id"],"acceptance_criteria":["task-id"],"milestones":["task-id"],"risks":["task-id"]},"workstreams":[{"id":"workstream-id","role":"workstream","title":"...","outcome":"...","category":"deliverable","boundary":{"deliverable":"..."},"acceptance_criteria":["..."],"dependency_ids":[],"tasks":[{"id":"task-id","role":"task","title":"...","goal":"...","task_kind":"research","execution_mode":"assist","capability_tags":["research_evidence"],"acceptance_criteria":["..."],"input_slots":[{"key":"...","kind":"asset_version","required":true,"source":"brief","selector":"current","ref_id":null,"version_id":null}],"output_slots":[{"key":"...","kind":"asset","required":true,"asset_type":"ResearchEvidenceAsset","acceptance_criteria":["..."],"confirmation_policy":"human"}],"dependency_ids":[],"repository_intent":null}]}]}.',
    'Top level: 1-6 independently acceptable Workstreams, never generic lifecycle phases.',
    'Software outcomes default to six Tasks: research evidence, constraint analysis, solution decision, implementation, acceptance testing, and integration delivery. Simple work may merge adjacent stages but must retain at least evidence preparation, execution, and acceptance.',
    'Allowed task_kind values: research, analysis, design, content, code, test, review, deploy, manual, integration. Allowed execution_mode values: manual, assist, codex, integration.',
    'Every Task needs capability_tags, acceptance_criteria, an input_slots array (which may be empty), typed output_slots, same-Workstream dependency_ids, task_kind, execution_mode, and optional repository_intent.',
    'Input slots use key/kind/required/source/selector/ref_id/version_id. Output slots use key/kind/required/asset_type/acceptance_criteria/confirmation_policy.',
    'Task dependency_ids control readiness and may be ordering-only. Add source="dependency" only when the Task genuinely reads an upstream asset; every such ref_id must also appear in dependency_ids. Select one exact upstream output key, or use selector="required_outputs" only when exactly one required output exists. Add separate input slots for multiple genuinely consumed outputs; never add a generic input merely to mirror a graph edge.',
    'Workstream dependency_ids are readiness boundaries and may also be ordering-only. A Task that genuinely reads an upstream Workstream delivery may declare source="workstream_dependency" only when that Workstream id appears in its parent Workstream dependency_ids. Select one exact terminal output key, or use selector="required_outputs" only when exactly one required terminal output exists. The WorkstreamOutcome receipt is verification metadata and is never a consumable input. Runtime verifies the receipt but mounts only selected terminal AssetVersion payloads from the same Workflow Execution.',
    'Declare source="brief", source="decision", or other context inputs only when the Task directly needs that material. An empty input_slots array is valid; do not invent Project Brief, Digest, dependency, asset, or context inputs to make the workflow look connected.',
    'Within each Workstream, every Task after the first returned Task must have at least one dependency_id. During replan, the first new follow-up Task must depend on an existing completed Task so the new asset chain starts from the accepted baseline.',
    'Use these exact capability tags as applicable: research_evidence, constraint_analysis, solution_decision, execution, acceptance, integration_delivery. A six-or-more-Task software Workstream must cover all six.',
    'Make Task titles, goals, outputs, and acceptance criteria specific to this Brief. Lifecycle stages are required as Tasks inside an outcome Workstream, never as top-level Workstreams.',
    'A code-changing Task must output both the change and an immutable RepositoryVersionAsset identified by commit/SHA. Acceptance must bind that exact repository output key and produce separate TestEvidenceAsset and AcceptedRepositoryVersionAsset outputs. Integration delivery inputs must both reference the acceptance Task, selecting those two exact output keys, and must not make later code changes.',
    'Code, test, and integration Tasks still need a repository_workspace fixed_sha input to execute. It must coexist with the selected RepositoryVersionAsset; the server enforces that both SHAs are identical.',
    'For repository_workspace input slots, set ref_id and version_id to null. Runtime binds the selected managed Repository Workspace and verifies its fixed_sha.',
    'Only an atomic manual task without a repository, external materials, or multiple acceptance criteria may use one Task, and it needs atomic_justification.',
    'Map every non-empty Brief features, acceptance_criteria, milestones, and risks collection to responsible Task ids in brief_coverage.',
    'Return keys project_classification, decomposition_basis, evidence_refs, confidence, repository_intent, brief_coverage, and workstreams with nested tasks.',
    ...(retryErrors.length
      ? [`Previous attempt critic errors that must all be fixed: ${JSON.stringify(retryErrors)}`]
      : []),
    `Input: ${JSON.stringify(generationContext(fingerprint))}`
  ].join('\n');
}

export function workflowCriticPrompt(fingerprint, candidate) {
  return [
    'Act as an independent workflow critic using only the contract below. Reject evidence mismatch, generic lifecycle Workstreams, incomplete stage coverage, invalid local DAG, missing required Brief mapping, weak acceptance criteria, or untyped asset flow.',
    'Lifecycle stages are expected as domain-specific Tasks inside an outcome Workstream and must not be rejected as generic decomposition. An existing completed Workstream may be reopened to ready when follow-up Tasks are added.',
    'Completed Task immutability covers id, parent_node_id, title, goal, task_kind, execution_mode, required, repository_intent, capability_tags, acceptance_criteria, input_slots, output_slots, atomic_justification, and dependency_ids. Do not invent additional immutable fields.',
    'brief_coverage is complete when every non-empty Brief features, acceptance_criteria, milestones, and risks collection maps to valid Task ids. Do not require users, scope, constraints, open questions, URLs, or per-item mappings.',
    'Do not reject missing external materials or code_source when current_workflow and repository intent provide the existing baseline. Do reject code changes after final acceptance or a test input that is not derived from the changed immutable repository version.',
    'A repository_workspace fixed_sha input is required execution material and may coexist with a dependency RepositoryVersionAsset. The server rejects the Task unless their SHAs are identical, so do not treat their coexistence as a version mismatch.',
    'dependency_ids govern readiness, not automatic data flow. Empty input_slots and ordering-only Task or Workstream edges are valid. Every declared dependency/workstream_dependency input must, however, have its corresponding graph edge and select a real output; WorkstreamOutcome receipts are not consumable assets.',
    'Do not introduce requirements absent from the Brief or this contract. Candidate fields have already passed deterministic normalization and validation.',
    'The minimum acceptable confidence is 0.7.',
    'Return JSON only: {"approved":true|false,"errors":[{"code":"...","node_id":"...","detail":"..."}]}.',
    `Brief: ${JSON.stringify(generationContext(fingerprint))}`,
    `Candidate: ${JSON.stringify(candidate)}`
  ].join('\n');
}

export function createTestWorkflowCandidate(fingerprint) {
  const content = fingerprint.brief.content || {},
    derived = content.derived || content;
  const evidence = content.sections?.find((item) => item.id) || { id: 'brief-goal' };
  const text = `${fingerprint.project.title} ${fingerprint.project.goal} ${content.summary || ''}`.toLowerCase();
  const software =
    fingerprint.intake?.mode === 'existing' || /(software|app|api|code|system|软件|系统|应用|编程)/i.test(text);
  const workstreamId = stable(fingerprint.input_hash, 'outcome', 'wfs');
  const phases = software ? softwarePhases() : simplePhases();
  const taskIds = phases.map((phase, index) => stable(fingerprint.input_hash, `task:${index}`, 'tsk'));
  const tasks = phases.map((phase, index) => {
    const previous = phases[index - 1],
      previousOutputKey = previous ? `${previous.kind}_result` : null;
    return {
      id: taskIds[index],
      role: 'task',
      title: phase.title,
      goal: phase.goal,
      task_kind: phase.kind,
      execution_mode: phase.mode,
      capability_tags: [phase.tag],
      acceptance_criteria: [phase.acceptance],
      input_slots: previous
        ? [
            {
              key: previousOutputKey,
              kind: 'asset_version',
              required: true,
              source: 'dependency',
              selector: previousOutputKey,
              ref_id: taskIds[index - 1],
              version_id: null
            }
          ]
        : [],
      dependency_ids: index ? [taskIds[index - 1]] : [],
      repository_intent: phase.repository ? { mode: 'write' } : null
    };
  });
  return {
    project_classification: software ? 'software_delivery' : 'knowledge_or_manual_delivery',
    decomposition_basis: software
      ? 'A six-stage Task DAG carries immutable evidence into a verifiable software delivery.'
      : 'A three-stage Task DAG separates evidence, execution, and acceptance.',
    evidence_refs: [
      { section_id: evidence.id, quote: content.goal || fingerprint.project.goal || fingerprint.project.title }
    ],
    confidence: 0.86,
    repository_intent: software ? [{ mode: 'write', source: 'project_code_source' }] : [],
    brief_coverage: defaultBriefCoverage(fingerprint.brief, taskIds),
    workstreams: [
      {
        id: workstreamId,
        role: 'workstream',
        title: software ? 'Verifiable product increment' : 'Verified project outcome',
        outcome: software
          ? 'A runnable increment satisfying the Brief acceptance criteria.'
          : 'A reviewed deliverable satisfying the stated project goal.',
        category: 'deliverable',
        boundary: { deliverable: software ? 'runnable_increment' : 'reviewed_deliverable' },
        acceptance_criteria: derived.acceptance_criteria?.length
          ? derived.acceptance_criteria
          : ['The submitted outcome is reviewable and supported by evidence.'],
        dependency_ids: [],
        tasks
      }
    ]
  };
}

function softwarePhases() {
  return [
    phase(
      'Research evidence',
      'Collect traceable repository and requirement evidence.',
      'research',
      'assist',
      'research_evidence',
      'Evidence sources are traceable.'
    ),
    phase(
      'Constraint analysis',
      'Analyze constraints, risks, and affected boundaries.',
      'analysis',
      'assist',
      'constraint_analysis',
      'Constraints and risks are covered.'
    ),
    phase(
      'Solution decision',
      'Select and record an implementable solution.',
      'design',
      'assist',
      'solution_decision',
      'The decision addresses the analyzed constraints.'
    ),
    phase(
      'Implementation',
      'Implement the approved product increment.',
      'code',
      'codex',
      'execution',
      'The change is committed at a fixed repository SHA.',
      true
    ),
    phase(
      'Test acceptance',
      'Run deterministic tests against the acceptance criteria.',
      'test',
      'codex',
      'acceptance',
      'Required checks pass with retained evidence.',
      true
    ),
    phase(
      'Integration delivery',
      'Integrate and prepare the accepted increment for delivery.',
      'deploy',
      'codex',
      'integration_delivery',
      'Delivery evidence references the tested SHA.',
      true
    )
  ];
}
function simplePhases() {
  return [
    phase(
      'Evidence preparation',
      'Collect the facts and source material required by the Brief.',
      'research',
      'assist',
      'research_evidence',
      'Evidence is traceable and sufficient.'
    ),
    phase(
      'Deliverable execution',
      'Produce the requested outcome from the accepted evidence.',
      'content',
      'assist',
      'execution',
      'The deliverable covers the stated goal.'
    ),
    phase(
      'Acceptance review',
      'Review the deliverable against every acceptance criterion.',
      'review',
      'assist',
      'acceptance',
      'All acceptance criteria have review evidence.'
    )
  ];
}
function phase(title, goal, kind, mode, tag, acceptance, repository = false) {
  return { title, goal, kind, mode, tag, acceptance, repository };
}
function normalizeGeneratedRuntimeState(nodes, fingerprint) {
  const current = new Map((fingerprint.current_nodes || []).map((node) => [node.id, node])),
    completed = new Set([...current.values()].filter((node) => node.status === 'completed').map((node) => node.id));
  const result = nodes.map((node) => {
    const prior = current.get(node.id);
    if (node.role === 'workstream')
      return {
        ...node,
        status:
          prior?.status === 'completed' &&
          !nodes.some((item) => item.parent_node_id === node.id && !completed.has(item.id))
            ? 'completed'
            : 'ready'
      };
    if (prior) return { ...node, status: prior.status };
    const inputSlots = node.input_slots.map((slot) =>
      slot.source === 'repository_workspace' ? { ...slot, ref_id: null, version_id: null } : slot
    );
    return {
      ...node,
      input_slots: inputSlots,
      status: node.dependency_ids.every((id) => completed.has(id)) ? 'ready' : 'blocked'
    };
  });
  return result;
}
function stable(seed, key, prefix) {
  return `${prefix}_${hashString(`${seed}:${key}`).slice(0, 20)}`;
}
