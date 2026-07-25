import { createNodeWorkspace, defaultContractForNode, hashString, id, now } from '../../../packages/shared/index.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import {
  assertWorkflowHierarchy,
  critiqueWorkflowGenerationCandidate,
  legacyNodeTypeForTaskKind,
  normalizeWorkflowGenerationCandidate
} from './workflow-hierarchy-domain.mjs';
import { workflowVisualGraph } from './workflow-graph-service.mjs';
import { resolveWorkflowGenerationCwd } from './workflow-generation-workspace.mjs';
import { createCodexRunError, safeErrorDetail } from './codex-run-diagnostics.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';

const runningBatches = new Set();
const MINIMUM_MIGRATION_CONFIDENCE = 0.7;

export async function resumeWorkflowMigrationOrchestrator() {
  const batch = await mutate((state) => {
    recoverInterruptedMigrationJobsInState(state);
    return ensureMigrationBatch(state);
  });
  if (batch?.status === 'approved' || batch?.status === 'running' || batch?.status === 'waiting_active_runs')
    queueMicrotask(() => {
      void runMigrationBatch(batch.id);
    });
  return batch;
}

export async function approveWorkflowMigrationBatch(batchId, input = {}, actorId = null) {
  const batch = await mutate((state) => {
    const current = state.workflow_migration_batches.find((item) => item.id === batchId);
    if (!current) throw new HttpError(404, { error: 'workflow_migration_batch_not_found' });
    if (['completed', 'cancelled'].includes(current.status)) return current;
    const actor = actorId ? state.users.find((item) => item.id === actorId) : owner(state);
    Object.assign(current, {
      status: 'approved',
      adapter: input.adapter === 'test' ? 'test' : null,
      approved_by_user_id: actor?.id || null,
      approved_at: now(),
      updated_at: now()
    });
    for (const job of state.workflow_migration_jobs.filter(
      (item) => item.batch_id === current.id && item.status === 'pending'
    )) {
      job.adapter = current.adapter;
      job.test_candidate =
        current.adapter === 'test' && input.test_candidate ? structuredClone(input.test_candidate) : null;
    }
    return current;
  });
  queueMicrotask(() => {
    void runMigrationBatch(batch.id);
  });
  return batch;
}

export async function cancelWorkflowMigrationBatch(batchId, actorId = null) {
  return mutate((state) => {
    const batch = state.workflow_migration_batches.find((item) => item.id === batchId);
    if (!batch) throw new HttpError(404, { error: 'workflow_migration_batch_not_found' });
    if (batch.status === 'completed') throw new HttpError(409, { error: 'workflow_migration_batch_completed' });
    Object.assign(batch, {
      status: 'cancelled',
      cancelled_by_user_id: actorId,
      cancelled_at: now(),
      updated_at: now()
    });
    for (const job of state.workflow_migration_jobs.filter(
      (item) => item.batch_id === batch.id && ['pending', 'waiting_active_runs'].includes(item.status)
    ))
      Object.assign(job, { status: 'cancelled', updated_at: now() });
    return batch;
  });
}

export async function getWorkflowMigrationState() {
  await mutate((state) => ensureMigrationBatch(state));
  const state = await readState(),
    batch =
      state.workflow_migration_batches.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ||
      null,
    activeProjects = new Set(state.projects.filter((item) => !item.deleted_at).map((item) => item.id));
  return {
    batch,
    jobs: batch
      ? state.workflow_migration_jobs
          .filter((item) => item.batch_id === batch.id)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      : [],
    legacy_workflow_ids: state.workflows
      .filter((item) => activeProjects.has(item.project_id) && item.hierarchy_mode === 'legacy')
      .map((item) => item.id)
  };
}

export async function retryWorkflowMigrationJob(jobId, input = {}) {
  const batchId = await mutate((state) => {
    const job = state.workflow_migration_jobs.find((item) => item.id === jobId);
    if (!job) throw new HttpError(404, { error: 'workflow_migration_job_not_found' });
    if (job.status !== 'failed')
      throw new HttpError(409, { error: 'workflow_migration_job_not_failed', status: job.status });
    const batch = state.workflow_migration_batches.find((item) => item.id === job.batch_id);
    if (!batch || batch.status === 'cancelled')
      throw new HttpError(409, { error: 'workflow_migration_batch_not_retryable' });
    const adapter = input.adapter === 'test' ? 'test' : job.adapter;
    Object.assign(job, {
      status: 'pending',
      adapter,
      test_candidate:
        input.adapter === 'test'
          ? input.test_candidate
            ? structuredClone(input.test_candidate)
            : null
          : job.test_candidate || null,
      error_code: null,
      error_detail: null,
      completed_at: null,
      updated_at: now()
    });
    Object.assign(batch, { status: 'approved', completed_at: null, updated_at: now() });
    const workflow = state.workflows.find((item) => item.id === job.workflow_id);
    if (workflow) workflow.semantic_migration_status = 'pending';
    return batch.id;
  });
  queueMicrotask(() => {
    void runMigrationBatch(batchId);
  });
  return getWorkflowMigrationState();
}

export function validateLegacyMigrationMapping(legacyNodes, candidate) {
  const legacyIds = legacyNodes.map((item) => item.id),
    mapped = candidate?.legacy_mapping || [];
  const mappedLegacyIds = mapped.map((item) => item.legacy_node_id),
    mappedTaskIds = mapped.map((item) => item.task_id);
  if (
    mapped.length !== legacyIds.length ||
    new Set(mappedLegacyIds).size !== mapped.length ||
    new Set(mappedTaskIds).size !== mapped.length
  )
    throw migrationError('workflow_migration_mapping_not_bijective');
  if (
    legacyIds.some((nodeId) => !mappedLegacyIds.includes(nodeId)) ||
    mapped.some((item) => item.legacy_node_id !== item.task_id)
  )
    throw migrationError('workflow_migration_mapping_incomplete_or_id_changed');
  const taskIds = candidate.nodes.filter((item) => item.role === 'task').map((item) => item.id);
  if (taskIds.length !== legacyIds.length || taskIds.some((taskId) => !legacyIds.includes(taskId)))
    throw migrationError('workflow_migration_task_set_mismatch');
  return true;
}

export function applyLegacyWorkflowMigrationInState(state, workflowId, candidate, actorId, job = null) {
  const workflow = state.workflows.find((item) => item.id === workflowId && item.hierarchy_mode === 'legacy');
  if (!workflow) throw new HttpError(409, { error: 'legacy_workflow_required' });
  const project = state.projects.find((item) => item.id === workflow.project_id),
    legacyNodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  validateLegacyMigrationMapping(legacyNodes, candidate);
  assertWorkflowHierarchy(candidate.nodes, { mode: 'formal', requireTasks: true });
  const beforeHash = hashString(JSON.stringify(legacyNodes));
  if (job?.before_hash && job.before_hash !== beforeHash) throw migrationError('workflow_migration_source_changed');
  const tasksById = new Map(candidate.nodes.filter((item) => item.role === 'task').map((item) => [item.id, item])),
    workstreams = candidate.nodes.filter((item) => item.role === 'workstream');
  const createdWorkstreams = [];
  for (const source of workstreams) {
    const node = {
      ...structuredClone(source),
      workflow_id: workflow.id,
      workspace_id: null,
      type: 'execution',
      status: source.dependency_ids.length ? 'blocked' : 'ready',
      dependencies: source.dependency_ids.map((nodeId) => ({ node_id: nodeId, type: 'finish_to_start' })),
      current_contract_id: null,
      repository_target_ids: [],
      plan_revision: 1,
      legacy_read_only: false,
      created_at: now(),
      updated_at: now()
    };
    const workspace = createNodeWorkspace(project, node, actorId);
    workspace.type = 'workstream';
    const contract = defaultContractForNode(node, project, actorId, 'confirmed');
    contract.node_goal = node.outcome;
    contract.acceptance_criteria = [...node.acceptance_criteria];
    contract.expected_outputs = [{ label: node.outcome, required: true }];
    contract.boundary = structuredClone(node.boundary);
    node.workspace_id = workspace.id;
    node.current_contract_id = contract.id;
    state.workspaces.push(workspace);
    state.node_contracts.push(contract);
    createdWorkstreams.push(node);
  }
  const workstreamById = new Map(createdWorkstreams.map((item) => [item.id, item]));
  for (const legacy of legacyNodes) {
    const source = tasksById.get(legacy.id),
      workspace = state.workspaces.find(
        (item) => item.id === legacy.workspace_id || item.workflow_node_id === legacy.id
      ),
      parent = workstreamById.get(source.parent_node_id);
    Object.assign(legacy, {
      role: 'task',
      parent_node_id: source.parent_node_id,
      type: legacyNodeTypeForTaskKind(source.task_kind),
      title: source.title,
      goal: source.goal,
      outcome: null,
      category: null,
      task_kind: source.task_kind,
      execution_mode: source.execution_mode,
      boundary: null,
      acceptance_criteria: source.acceptance_criteria || [],
      required: source.required !== false,
      repository_intent: source.repository_intent || null,
      dependencies: source.dependency_ids.map((nodeId) => ({ node_id: nodeId, type: 'finish_to_start' })),
      order_index: source.order_index,
      plan_revision: null,
      legacy_read_only: false,
      migrated_from_legacy: true,
      updated_at: now()
    });
    if (workspace) {
      workspace.type = 'task';
      workspace.parent_workspace_id = parent?.workspace_id || project.current_workspace_id;
      workspace.title = legacy.title;
      workspace.goal = legacy.goal;
      workspace.updated_at = now();
    }
  }
  state.workflow_nodes.push(...createdWorkstreams);
  Object.assign(workflow, {
    hierarchy_mode: 'two_level',
    legacy_read_only: false,
    semantic_migration_status: 'completed',
    semantic_migrated_at: now(),
    semantic_migrated_by_user_id: actorId,
    version: Number(workflow.version || 1) + 1,
    workflow_revision: Number(workflow.workflow_revision || workflow.version || 1) + 1,
    graph_json: workflowVisualGraph([...createdWorkstreams, ...legacyNodes]),
    updated_at: now()
  });
  project.workflow_migration_status = 'completed';
  project.updated_at = now();
  for (const session of state.assist_sessions.filter(
    (item) => item.version === 3 && item.scope_type === 'node' && legacyNodes.some((node) => node.id === item.scope_id)
  ))
    Object.assign(session, {
      scope_type: 'task',
      legacy_scope_type: 'node',
      scope_status: 'active',
      read_only: false,
      migrated_scope_at: now(),
      updated_at: now()
    });
  for (const session of state.agent_sessions.filter(
    (item) => item.scope_type === 'node' && legacyNodes.some((node) => node.id === item.scope_id)
  )) {
    session.scope_type = 'task';
    session.updated_at = now();
  }
  return {
    workflow,
    workstream_ids: createdWorkstreams.map((item) => item.id),
    task_ids: legacyNodes.map((item) => item.id),
    before_hash: beforeHash,
    after_hash: hashString(JSON.stringify([...createdWorkstreams, ...legacyNodes]))
  };
}

function ensureMigrationBatch(state) {
  const activeProjects = new Set(state.projects.filter((item) => !item.deleted_at).map((item) => item.id));
  const legacy = state.workflows.filter(
    (item) =>
      activeProjects.has(item.project_id) &&
      item.hierarchy_mode === 'legacy' &&
      item.semantic_migration_status !== 'completed'
  );
  if (!legacy.length) return null;
  const existing = state.workflow_migration_batches
    .filter((item) => !['completed', 'cancelled'].includes(item.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (existing) {
    for (const workflow of existing.status === 'pending_approval'
      ? legacy.filter((item) => !existing.workflow_ids.includes(item.id))
      : []) {
      existing.workflow_ids.push(workflow.id);
      if (!existing.project_ids.includes(workflow.project_id)) existing.project_ids.push(workflow.project_id);
      state.workflow_migration_jobs.push({
        id: id('wmj'),
        batch_id: existing.id,
        project_id: workflow.project_id,
        workflow_id: workflow.id,
        status: 'pending',
        attempt: 0,
        snapshot: null,
        before_hash: null,
        candidate: null,
        error_code: null,
        created_at: now(),
        updated_at: now()
      });
      existing.updated_at = now();
    }
    return existing;
  }
  const batch = {
    id: id('wmb'),
    status: 'pending_approval',
    workflow_ids: legacy.map((item) => item.id),
    project_ids: [...new Set(legacy.map((item) => item.project_id))],
    approved_by_user_id: null,
    approved_at: null,
    created_at: now(),
    updated_at: now()
  };
  state.workflow_migration_batches.push(batch);
  for (const workflow of legacy)
    state.workflow_migration_jobs.push({
      id: id('wmj'),
      batch_id: batch.id,
      project_id: workflow.project_id,
      workflow_id: workflow.id,
      status: 'pending',
      attempt: 0,
      snapshot: null,
      before_hash: null,
      candidate: null,
      error_code: null,
      created_at: now(),
      updated_at: now()
    });
  return batch;
}

async function runMigrationBatch(batchId) {
  if (runningBatches.has(batchId)) return;
  runningBatches.add(batchId);
  try {
    while (true) {
      const state = await readState(),
        batch = state.workflow_migration_batches.find((item) => item.id === batchId);
      if (
        !batch ||
        ['cancelled', 'completed'].includes(batch.status) ||
        !['approved', 'running', 'waiting_active_runs'].includes(batch.status)
      )
        return;
      const job = state.workflow_migration_jobs.find(
        (item) => item.batch_id === batch.id && ['pending', 'waiting_active_runs'].includes(item.status)
      );
      if (!job) {
        await finalizeBatch(batch.id);
        return;
      }
      const active = state.node_runs.filter(
        (item) =>
          item.project_id === job.project_id &&
          ['queued', 'starting', 'running', 'waiting_approval', 'stopping'].includes(item.status)
      );
      if (active.length) {
        await mutate((data) => {
          const currentBatch = data.workflow_migration_batches.find((item) => item.id === batch.id),
            currentJob = data.workflow_migration_jobs.find((item) => item.id === job.id);
          Object.assign(currentBatch, { status: 'waiting_active_runs', updated_at: now() });
          Object.assign(currentJob, {
            status: 'waiting_active_runs',
            active_run_ids: active.map((item) => item.id),
            updated_at: now()
          });
        });
        setTimeout(() => {
          void runMigrationBatch(batch.id);
        }, 1_000).unref?.();
        return;
      }
      await executeMigrationJob(batch, job);
    }
  } finally {
    runningBatches.delete(batchId);
  }
}

async function executeMigrationJob(batch, job) {
  try {
    const prepared = await mutate((state) => {
      const currentBatch = state.workflow_migration_batches.find((item) => item.id === batch.id),
        currentJob = state.workflow_migration_jobs.find((item) => item.id === job.id),
        workflow = state.workflows.find((item) => item.id === job.workflow_id),
        project = state.projects.find((item) => item.id === job.project_id),
        nodes = state.workflow_nodes.filter((item) => item.workflow_id === job.workflow_id);
      if (!currentBatch || !currentJob || workflow?.hierarchy_mode !== 'legacy')
        throw migrationError('workflow_migration_job_scope_invalid');
      assertProjectLifecycleIdle(project);
      const snapshot = {
        workflow: structuredClone(workflow),
        nodes: structuredClone(nodes),
        workspace_ids: nodes.map((item) => item.workspace_id),
        contract_ids: nodes.map((item) => item.current_contract_id),
        run_ids: state.node_runs.filter((item) => item.project_id === job.project_id).map((item) => item.id),
        asset_ids: state.assets.filter((item) => item.project_id === job.project_id).map((item) => item.id),
        trace_ids: state.traces.filter((item) => item.project_id === job.project_id).map((item) => item.id),
        assist_session_ids: state.assist_sessions
          .filter((item) => item.project_id === job.project_id)
          .map((item) => item.id)
      };
      Object.assign(currentBatch, { status: 'running', updated_at: now() });
      Object.assign(currentJob, {
        status: 'generating',
        attempt: Number(currentJob.attempt || 0) + 1,
        snapshot,
        before_hash: hashString(JSON.stringify(nodes)),
        active_run_ids: [],
        updated_at: now()
      });
      return {
        workflow: structuredClone(workflow),
        nodes: structuredClone(nodes),
        project: structuredClone(project),
        brief: structuredClone(
          state.project_briefs
            .filter((item) => item.project_id === workflow.project_id && item.status !== 'superseded')
            .sort((a, b) => b.version - a.version)[0] || null
        ),
        adapter: currentJob.adapter || currentBatch.adapter,
        test_candidate: currentJob.test_candidate ? structuredClone(currentJob.test_candidate) : null
      };
    });
    const state = await readState(),
      candidate =
        prepared.adapter === 'test'
          ? prepared.test_candidate
            ? normalizeTestMigrationCandidate(prepared.test_candidate)
            : deterministicMigrationCandidate(prepared)
          : await codexMigrationCandidate(state, prepared);
    const deterministicCritic = critiqueWorkflowGenerationCandidate(candidate, {
      minimumConfidence: MINIMUM_MIGRATION_CONFIDENCE
    });
    if (!deterministicCritic.ok)
      throw migrationError('workflow_migration_critic_rejected', { errors: deterministicCritic.errors });
    validateLegacyMigrationMapping(prepared.nodes, candidate);
    await mutate((data) => {
      const actor = owner(data),
        currentJob = data.workflow_migration_jobs.find((item) => item.id === job.id);
      const applied = applyLegacyWorkflowMigrationInState(data, job.workflow_id, candidate, actor.id, currentJob);
      Object.assign(currentJob, {
        status: 'completed',
        candidate,
        mapping: candidate.legacy_mapping,
        result: applied,
        completed_at: now(),
        updated_at: now()
      });
      addTrace(
        data,
        'workflow.migration.completed',
        {
          project_id: job.project_id,
          target_id: job.workflow_id,
          summary: `Legacy workflow migrated with ${applied.workstream_ids.length} workstreams.`
        },
        actor.id
      );
    });
  } catch (error) {
    await mutate((state) => {
      const current = state.workflow_migration_jobs.find((item) => item.id === job.id),
        project = state.projects.find((item) => item.id === job.project_id),
        workflow = state.workflows.find((item) => item.id === job.workflow_id);
      if (current)
        Object.assign(current, {
          status: 'failed',
          error_code: error?.code || error?.payload?.error || 'workflow_migration_failed',
          error_detail: safeErrorDetail(error),
          completed_at: now(),
          updated_at: now()
        });
      if (project) project.workflow_migration_status = 'failed';
      if (workflow) {
        workflow.semantic_migration_status = 'failed';
        workflow.legacy_read_only = true;
      }
    });
  }
}

export function recoverInterruptedMigrationJobsInState(state, timestamp = now()) {
  const recovered = state.workflow_migration_jobs.filter((item) => item.status === 'generating');
  for (const job of recovered) {
    const batch = state.workflow_migration_batches.find((item) => item.id === job.batch_id);
    if (!batch || batch.status === 'cancelled') {
      Object.assign(job, {
        status: 'cancelled',
        error_code: 'workflow_migration_batch_not_retryable',
        completed_at: timestamp,
        updated_at: timestamp
      });
      continue;
    }
    Object.assign(job, {
      status: 'pending',
      active_run_ids: [],
      error_code: null,
      error_detail: null,
      completed_at: null,
      restart_recovery_count: Number(job.restart_recovery_count || 0) + 1,
      restart_recovered_at: timestamp,
      updated_at: timestamp
    });
    Object.assign(batch, { status: 'approved', completed_at: null, updated_at: timestamp });
  }
  return recovered.length;
}

function normalizeTestMigrationCandidate(value) {
  const normalized = normalizeWorkflowGenerationCandidate(value);
  normalized.legacy_mapping = Array.isArray(value?.legacy_mapping) ? structuredClone(value.legacy_mapping) : [];
  return normalized;
}

function deterministicMigrationCandidate({ project, brief, nodes }) {
  const chunks = [];
  for (let index = 0; index < nodes.length; index += 12) chunks.push(nodes.slice(index, index + 12));
  if (!chunks.length || chunks.length > 6) throw migrationError('workflow_migration_size_unsupported');
  const workstreamIds = chunks.map(
      (_chunk, index) => `wfs_${hashString(`${project.id}:migration:${index}`).slice(0, 20)}`
    ),
    ownerByNode = new Map();
  chunks.forEach((chunk, index) => chunk.forEach((node) => ownerByNode.set(node.id, index)));
  const workstreams = chunks.map((chunk, index) => {
    const dependencies = new Set();
    for (const node of chunk)
      for (const dependencyId of legacyDependencies(node)) {
        const owner = ownerByNode.get(dependencyId);
        if (owner != null && owner !== index) dependencies.add(workstreamIds[owner]);
      }
    return {
      id: workstreamIds[index],
      role: 'workstream',
      title: chunks.length === 1 ? 'Verified project outcome' : `Verified project outcome ${index + 1}`,
      outcome:
        chunks.length === 1
          ? `A reviewable outcome for ${project.title}.`
          : `A reviewable outcome segment ${index + 1} for ${project.title}.`,
      category: 'deliverable',
      boundary: { deliverable: `legacy_outcome_${index + 1}` },
      acceptance_criteria: brief?.content?.acceptance_criteria?.length
        ? brief.content.acceptance_criteria
        : ['All mapped legacy tasks are accepted and their evidence remains traceable.'],
      dependency_ids: [...dependencies],
      tasks: chunk.map((node, taskIndex) => ({
        id: node.id,
        role: 'task',
        title: node.title,
        goal: node.goal || node.title,
        task_kind: legacyTaskKind(node.type),
        execution_mode: legacyExecutionMode(node.type),
        required: true,
        status: node.status,
        dependency_ids: legacyDependencies(node).filter((dependencyId) => ownerByNode.get(dependencyId) === index),
        order_index: taskIndex
      }))
    };
  });
  const normalized = normalizeWorkflowGenerationCandidate({
    project_classification: 'legacy_project_semantic_migration',
    decomposition_basis:
      'Preserve every legacy node and reference while placing process steps inside independently acceptable outcome containers.',
    evidence_refs: [
      {
        section_id: brief?.content?.sections?.[0]?.id || 'legacy-workflow',
        quote: brief?.content?.goal || project.goal || project.title
      }
    ],
    confidence: 0.92,
    repository_intent: [],
    workstreams
  });
  normalized.legacy_mapping = nodes.map((node) => ({
    legacy_node_id: node.id,
    task_id: node.id,
    workstream_id: normalized.nodes.find((item) => item.role === 'task' && item.id === node.id)?.parent_node_id
  }));
  return normalized;
}

async function codexMigrationCandidate(state, prepared) {
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw migrationError('active_codex_profile_required');
  let output = '';
  const prompt = [
    'Migrate this legacy flat workflow into an outcome-oriented two-level workflow. Return JSON only.',
    'Every legacy node must become exactly one task and keep the exact same id. Add only workstream containers. Put cross-workstream relationships on workstream dependencies and keep task dependencies within siblings. Return legacy_mapping [{legacy_node_id,task_id,workstream_id}].',
    'Also return project_classification, decomposition_basis, evidence_refs, confidence, repository_intent and workstreams in the standard hierarchy format. Never use lifecycle phases as workstream titles.',
    `Project: ${JSON.stringify(prepared.project)}`,
    `Brief: ${JSON.stringify(prepared.brief?.content || null)}`,
    `Legacy nodes: ${JSON.stringify(prepared.nodes)}`
  ].join('\n');
  const run = await runCodexJson({
    state,
    profile,
    prompt,
    cwd: await resolveWorkflowGenerationCwd(prepared.project),
    sandbox: 'read-only',
    projectId: prepared.project.id,
    onEvent: (event) => {
      output += extractMessage(event);
    }
  });
  if (!run.ok)
    throw createCodexRunError(run, {
      failureCode: 'codex_workflow_migration_failed',
      timeoutCode: 'codex_workflow_migration_timeout'
    });
  const parsed = parseJson(output || run.stdout),
    normalized = normalizeWorkflowGenerationCandidate(parsed);
  normalized.legacy_mapping = Array.isArray(parsed.legacy_mapping) ? parsed.legacy_mapping : [];
  return normalized;
}

async function finalizeBatch(batchId) {
  return mutate((state) => {
    const batch = state.workflow_migration_batches.find((item) => item.id === batchId),
      jobs = state.workflow_migration_jobs.filter((item) => item.batch_id === batchId);
    if (!batch) return null;
    Object.assign(batch, {
      status: jobs.some((item) => item.status === 'failed') ? 'completed_with_failures' : 'completed',
      completed_at: now(),
      updated_at: now(),
      summary: {
        total: jobs.length,
        completed: jobs.filter((item) => item.status === 'completed').length,
        failed: jobs.filter((item) => item.status === 'failed').length
      }
    });
    return batch;
  });
}
function legacyDependencies(node) {
  return (node.dependencies || []).map((item) => (typeof item === 'string' ? item : item.node_id)).filter(Boolean);
}
function legacyTaskKind(type) {
  return (
    {
      research: 'research',
      analysis: 'analysis',
      goal_definition: 'analysis',
      execution: 'code',
      retrospective: 'review'
    }[type] || 'manual'
  );
}
function legacyExecutionMode(type) {
  return type === 'execution' ? 'codex' : 'assist';
}
function parseJson(text) {
  const cleaned = String(text || '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, ''),
    start = cleaned.indexOf('{'),
    end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw migrationError('codex_json_parse_failed');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw migrationError('codex_json_parse_failed');
  }
}
function migrationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
