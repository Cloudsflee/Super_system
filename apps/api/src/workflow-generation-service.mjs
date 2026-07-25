import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { critiqueWorkflowGenerationCandidate } from './workflow-hierarchy-domain.mjs';
import { resolveWorkflowGenerationCwd } from './workflow-generation-workspace.mjs';
import { createCodexRunError, safeErrorDetail } from './codex-run-diagnostics.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
import {
  createTestWorkflowCandidate,
  validateGenerationCandidate,
  workflowCriticPrompt,
  workflowGenerationNodeSnapshot,
  workflowGenerationPrompt
} from './workflow-generation-candidate.mjs';
import { createWorkflowReplanProposalInState } from './workflow-graph-service.mjs';
const controllers = new Map();
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'superseded']);
export async function startWorkflowGeneration(projectId, input = {}, actorId = null) {
  const mode = input.mode === 'replan' ? 'replan' : 'initial';
  const snapshot = await readState();
  const fingerprint = generationFingerprint(snapshot, projectId, mode);
  const result = await mutate((state) => {
    const project = requireReadyProject(state, projectId, mode),
      actor = actorId ? state.users.find((item) => item.id === actorId) : owner(state);
    const currentFingerprint = generationFingerprint(state, project.id, mode);
    if (currentFingerprint.input_hash !== fingerprint.input_hash)
      throw new HttpError(409, { error: 'workflow_generation_inputs_changed' });
    const same = state.workflow_generations
      .filter(
        (item) =>
          item.project_id === project.id &&
          item.mode === mode &&
          item.input_hash === fingerprint.input_hash &&
          !['cancelled', 'failed', 'superseded'].includes(item.status)
      )
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
    if (same && input.force !== true) return { generation: same, idempotent: true, created: false };
    for (const prior of state.workflow_generations.filter(
      (item) => item.project_id === project.id && !TERMINAL.has(item.status)
    )) {
      Object.assign(prior, {
        status: 'superseded',
        superseded_reason: 'generation_inputs_changed',
        completed_at: now(),
        updated_at: now()
      });
      appendEvent(state, prior, 'superseded', {
        reason: prior.input_hash === fingerprint.input_hash ? 'retry_requested' : 'generation_inputs_changed'
      });
      controllers.get(prior.id)?.abort('superseded');
      controllers.delete(prior.id);
    }
    const generation = {
      id: id('wfg'),
      operation_id: null,
      project_id: project.id,
      mode,
      draft_id: fingerprint.draft?.id || null,
      workflow_id: fingerprint.workflow?.id || null,
      status: 'queued',
      phase: 'queued',
      input_hash: fingerprint.input_hash,
      brief_id: fingerprint.brief.id,
      brief_revision: fingerprint.brief.revision,
      material_hash: fingerprint.material_hash,
      code_source_hash: fingerprint.code_source_hash,
      draft_revision_at_start: fingerprint.draft?.revision || null,
      draft_user_modified_at_start: fingerprint.draft?.user_modified_at || null,
      workflow_revision_at_start: fingerprint.workflow
        ? Number(fingerprint.workflow.workflow_revision || fingerprint.workflow.version || 1)
        : null,
      retry_of_generation_id: input.retry_of_generation_id || null,
      attempt: Number(input.attempt || 1),
      adapter: testAdapterEnabled(input) ? 'test' : null,
      test_candidate: input.test_candidate || null,
      candidate: null,
      critic: null,
      result_mode: null,
      diff: null,
      error_code: null,
      error_detail: null,
      retryable: false,
      cancel_requested_at: null,
      created_by_user_id: actor?.id || null,
      created_at: now(),
      updated_at: now(),
      completed_at: null
    };
    generation.operation_id = generation.id;
    state.workflow_generations.push(generation);
    appendEvent(state, generation, 'queued', { input_hash: generation.input_hash, attempt: generation.attempt });
    if (fingerprint.draft && mode === 'initial')
      Object.assign(fingerprint.draft, {
        generation_status: 'queued',
        generation_id: generation.id,
        updated_at: now()
      });
    addTrace(
      state,
      'workflow.generation.queued',
      {
        project_id: project.id,
        target_id: generation.id,
        summary: 'Workflow draft generation queued.',
        data: { input_hash: generation.input_hash }
      },
      actor?.id || null
    );
    return { generation, idempotent: false, created: true };
  });
  if (result.created)
    queueMicrotask(() => {
      void executeWorkflowGeneration(result.generation.id);
    });
  return { generation: publicGeneration(result.generation), idempotent: result.idempotent };
}
export async function retryWorkflowGeneration(projectId, generationId, input = {}, actorId = null) {
  const state = await readState(),
    generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
  if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
  if (!TERMINAL.has(generation.status))
    throw new HttpError(409, { error: 'workflow_generation_not_terminal', status: generation.status });
  return startWorkflowGeneration(
    projectId,
    {
      ...input,
      mode: generation.mode || 'initial',
      force: true,
      retry_of_generation_id: generation.id,
      attempt: Number(generation.attempt || 1) + 1
    },
    actorId
  );
}
export async function cancelWorkflowGeneration(projectId, generationId, actorId = null) {
  return mutate((state) => {
    const generation = state.workflow_generations.find(
      (item) => item.id === generationId && item.project_id === projectId
    );
    if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
    if (TERMINAL.has(generation.status)) return publicGeneration(generation);
    Object.assign(generation, {
      cancel_requested_at: now(),
      status: 'cancelled',
      phase: 'cancelled',
      error_code: 'workflow_generation_cancelled',
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    appendEvent(state, generation, 'cancelled', { actor_id: actorId });
    const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id);
    if (draft?.generation_id === generation.id)
      Object.assign(draft, { generation_status: 'cancelled', updated_at: now() });
    controllers.get(generation.id)?.abort('cancelled');
    controllers.delete(generation.id);
    return publicGeneration(generation);
  });
}
export async function getWorkflowGeneration(projectId, generationId) {
  const state = await readState(),
    generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
  if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
  return publicGeneration(generation);
}
export async function listWorkflowGenerations(projectId, { limit = 20 } = {}) {
  const state = await readState();
  if (!state.projects.some((item) => item.id === projectId && !item.deleted_at))
    throw new HttpError(404, { error: 'project_not_found' });
  return state.workflow_generations
    .filter((item) => item.project_id === projectId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, Math.min(100, Math.max(1, Number(limit) || 20)))
    .map(publicGeneration);
}
export async function applyWorkflowGenerationCandidate(projectId, generationId, input = {}, actorId = null) {
  return mutate((state) => {
    const generation = state.workflow_generations.find(
      (item) => item.id === generationId && item.project_id === projectId
    );
    if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
    if (generation.status !== 'completed' || !generation.candidate?.nodes)
      throw new HttpError(409, { error: 'workflow_generation_candidate_unavailable', status: generation.status });
    if (generation.mode === 'replan') {
      const workflow = state.workflows.find(
        (item) => item.id === generation.workflow_id && item.project_id === projectId
      );
      if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
      const revision = Number(workflow.workflow_revision || workflow.version || 1);
      if (!Number.isInteger(input.expected_revision))
        throw new HttpError(400, { error: 'expected_revision_required', current_revision: revision });
      if (input.expected_revision !== revision || revision !== Number(generation.workflow_revision_at_start))
        throw new HttpError(409, {
          error: 'workflow_graph_revision_conflict',
          expected_revision: input.expected_revision,
          current_revision: revision
        });
      const fingerprint = generationFingerprint(state, projectId, 'replan');
      if (fingerprint.input_hash !== generation.input_hash)
        throw new HttpError(409, { error: 'workflow_generation_inputs_changed' });
      const checked = validateGenerationCandidate(generation.candidate, fingerprint);
      const created = createWorkflowReplanProposalInState(state, workflow.id, checked, actorId, {
        project_id: projectId,
        generation_id: generation.id
      });
      Object.assign(generation, {
        result_mode: 'replan_change_proposal_created',
        change_proposal_id: created.proposal.id,
        applied_by_user_id: actorId,
        applied_at: now(),
        updated_at: now()
      });
      appendEvent(state, generation, 'replan_proposal_created', {
        proposal_id: created.proposal.id,
        actor_id: actorId
      });
      return { generation: publicGeneration(generation), proposal: created.proposal };
    }
    const draft = state.workflow_drafts.find(
      (item) => item.id === generation.draft_id && item.project_id === projectId
    );
    if (!draft) throw new HttpError(404, { error: 'workflow_draft_not_found' });
    if (!Number.isInteger(input.expected_revision))
      throw new HttpError(400, { error: 'expected_revision_required', current_revision: draft.revision });
    if (input.expected_revision !== draft.revision)
      throw new HttpError(409, {
        error: 'workflow_draft_revision_conflict',
        expected_revision: input.expected_revision,
        current_revision: draft.revision
      });
    const checked = validateGenerationCandidate(
      generation.candidate,
      generationFingerprint(state, projectId, 'initial')
    );
    Object.assign(draft, {
      nodes: structuredClone(checked.nodes),
      brief_coverage: structuredClone(checked.brief_coverage),
      project_classification: checked.project_classification,
      revision: Number(draft.revision || 1) + 1,
      user_modified_at: now(),
      updated_by_user_id: actorId,
      generation_status: 'completed',
      generation_id: generation.id,
      updated_at: now()
    });
    Object.assign(generation, {
      result_mode: 'applied_after_diff_review',
      diff: null,
      applied_by_user_id: actorId,
      applied_at: now(),
      updated_at: now()
    });
    appendEvent(state, generation, 'candidate_applied', { draft_revision: draft.revision, actor_id: actorId });
    return { generation: publicGeneration(generation), draft };
  });
}

export async function listWorkflowGenerationEvents(projectId, generationId, after = 0) {
  const state = await readState(),
    generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
  if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
  const events = state.workflow_generation_events
    .filter((item) => item.generation_id === generation.id && Number(item.sequence) > Number(after || 0))
    .sort((a, b) => a.sequence - b.sequence);
  return {
    generation: publicGeneration(generation),
    events,
    terminal: TERMINAL.has(generation.status),
    next_cursor: events.at(-1)?.sequence || Number(after || 0)
  };
}

export function generationFingerprint(state, projectId, mode = 'initial') {
  const project = requireReadyProject(state, projectId, mode);
  const brief = state.project_briefs
    .filter((item) => item.project_id === project.id && item.status !== 'superseded')
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  const draft = state.workflow_drafts.find((item) => item.project_id === project.id);
  const workflow =
    mode === 'replan'
      ? state.workflows
          .filter((item) => item.project_id === project.id && item.status !== 'archived')
          .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0]
      : null;
  if (!brief || (mode === 'initial' && !draft))
    throw new HttpError(409, { error: 'workflow_generation_brief_and_draft_required' });
  if (mode === 'replan' && !workflow)
    throw new HttpError(409, { error: 'workflow_generation_active_workflow_required' });
  const intake = state.project_intakes.find((item) => item.project_id === project.id);
  const imports = state.import_jobs.filter((item) => item.project_id === project.id && item.status === 'succeeded');
  const material = {
    context_sources: intake?.context_sources || [],
    attachments: state.attachments
      .filter((item) => item.project_id === project.id)
      .map((item) => ({ id: item.id, sha256: item.sha256 || item.content_hash || null }))
  };
  const code = {
    code_source: intake?.code_source || null,
    imports: imports.map((item) => ({
      kind: item.kind,
      source_hash: item.source_hash || null,
      repository: item.repository?.full_name || null
    }))
  };
  const materialHash = hashString(JSON.stringify(canonical(material))),
    codeSourceHash = hashString(JSON.stringify(canonical(code)));
  const currentNodes = workflow
    ? workflowGenerationNodeSnapshot(
        state.workflow_nodes
          .filter((item) => item.workflow_id === workflow.id)
          .map((item) => ({
            ...item,
            dependency_ids: (item.dependencies || []).map((dependency) => dependency.node_id)
          }))
      )
    : [];
  const inputHash = hashString(
    JSON.stringify({
      mode,
      project_id: project.id,
      brief_id: brief.id,
      brief_revision: brief.revision,
      material_hash: materialHash,
      code_source_hash: codeSourceHash,
      workflow_id: workflow?.id || null,
      workflow_revision: workflow?.workflow_revision || null,
      current_nodes: canonical(currentNodes)
    })
  );
  return {
    mode,
    project,
    brief,
    draft,
    workflow,
    current_nodes: currentNodes,
    intake,
    material_hash: materialHash,
    code_source_hash: codeSourceHash,
    input_hash: inputHash
  };
}

async function executeWorkflowGeneration(generationId) {
  const controller = new AbortController();
  controllers.set(generationId, controller);
  try {
    await setGenerationPhase(generationId, 'generating', 'running');
    const state = await readState(),
      generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || generation.status === 'cancelled' || generation.status === 'superseded') return;
    const fingerprint = generationFingerprint(state, generation.project_id, generation.mode || 'initial');
    if (fingerprint.input_hash !== generation.input_hash)
      return supersedeGeneration(generation.id, 'generation_inputs_changed');
    const candidate =
      generation.adapter === 'test'
        ? validateGenerationCandidate(
            generation.test_candidate || createTestWorkflowCandidate(fingerprint),
            fingerprint
          )
        : await generateCandidateWithCodex(state, generation, fingerprint, controller.signal);
    if (controller.signal.aborted) return;
    await retainGenerationCandidate(generationId, candidate);
    await setGenerationPhase(generationId, 'critic', 'running');
    const critic =
      generation.adapter === 'test'
        ? { approved: true, errors: [] }
        : await critiqueCandidateWithCodex(state, generation, fingerprint, candidate, controller.signal);
    const deterministicCritic = critiqueWorkflowGenerationCandidate(candidate, { minimumConfidence: 0.7 });
    if (!critic.approved || !deterministicCritic.ok)
      throw generationError('workflow_generation_critic_rejected', {
        critic,
        deterministic_critic: deterministicCritic
      });
    await completeGeneration(generationId, candidate, { ...critic, deterministic: deterministicCritic });
  } catch (error) {
    if (!controller.signal.aborted) await failGeneration(generationId, error);
  } finally {
    controllers.delete(generationId);
  }
}

async function generateCandidateWithCodex(state, generation, fingerprint, signal) {
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw generationError('active_codex_profile_required');
  let output = '';
  const previous = state.workflow_generations.find((item) => item.id === generation.retry_of_generation_id);
  const retryErrors = previous?.error_detail?.critic?.errors || previous?.error_detail?.errors || [];
  const prompt = workflowGenerationPrompt(fingerprint, retryErrors);
  const run = await runCodexJson({
    state,
    profile,
    prompt,
    cwd: await resolveWorkflowGenerationCwd(fingerprint.project),
    sandbox: 'read-only',
    projectId: fingerprint.project.id,
    signal,
    onEvent: (event) => {
      output += extractMessage(event);
    }
  });
  if (!run.ok)
    throw createCodexRunError(run, {
      failureCode: 'codex_workflow_generation_failed',
      timeoutCode: 'codex_workflow_generation_timeout'
    });
  return validateGenerationCandidate(parseJson(output || run.stdout), fingerprint);
}

async function critiqueCandidateWithCodex(state, generation, fingerprint, candidate, signal) {
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw generationError('active_codex_profile_required');
  let output = '';
  const prompt = workflowCriticPrompt(fingerprint, candidate);
  const run = await runCodexJson({
    state,
    profile,
    prompt,
    cwd: await resolveWorkflowGenerationCwd(fingerprint.project),
    sandbox: 'read-only',
    projectId: fingerprint.project.id,
    signal,
    onEvent: (event) => {
      output += extractMessage(event);
    }
  });
  if (!run.ok)
    throw createCodexRunError(run, {
      failureCode: 'codex_workflow_critic_failed',
      timeoutCode: 'codex_workflow_critic_timeout'
    });
  const parsed = parseJson(output || run.stdout);
  return {
    approved: parsed.approved === true,
    errors: Array.isArray(parsed.errors) ? parsed.errors.slice(0, 100) : []
  };
}

async function completeGeneration(generationId, candidate, critic) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || TERMINAL.has(generation.status)) return generation;
    const fingerprint = generationFingerprint(state, generation.project_id, generation.mode || 'initial');
    if (fingerprint.input_hash !== generation.input_hash) {
      Object.assign(generation, {
        status: 'superseded',
        phase: 'superseded',
        completed_at: now(),
        updated_at: now(),
        error_code: 'generation_inputs_changed'
      });
      appendEvent(state, generation, 'superseded', { reason: 'generation_inputs_changed' });
      return generation;
    }
    const replan = generation.mode === 'replan',
      draft = fingerprint.draft;
    if (replan) {
      Object.assign(generation, {
        status: 'completed',
        phase: 'completed',
        candidate: structuredClone(candidate),
        critic: structuredClone(critic),
        result_mode: 'replan_diff',
        diff: {
          workflow_id: fingerprint.workflow.id,
          from_revision: fingerprint.workflow.workflow_revision,
          current_nodes: structuredClone(fingerprint.current_nodes),
          candidate_nodes: structuredClone(candidate.nodes)
        },
        completed_at: now(),
        updated_at: now(),
        retryable: false
      });
      appendEvent(state, generation, 'completed', {
        result_mode: generation.result_mode,
        confidence: candidate.confidence
      });
      return generation;
    }
    const userModified =
      Boolean(draft.user_modified_at) ||
      draft.revision !== generation.draft_revision_at_start ||
      (draft.user_modified_at || null) !== generation.draft_user_modified_at_start;
    Object.assign(generation, {
      status: 'completed',
      phase: 'completed',
      candidate: structuredClone(candidate),
      critic: structuredClone(critic),
      result_mode: userModified ? 'diff' : 'applied_to_draft',
      diff: userModified
        ? {
            from_revision: draft.revision,
            current_nodes: structuredClone(draft.nodes || []),
            candidate_nodes: structuredClone(candidate.nodes)
          }
        : null,
      completed_at: now(),
      updated_at: now(),
      retryable: false
    });
    if (!userModified)
      Object.assign(draft, {
        nodes: structuredClone(candidate.nodes),
        brief_coverage: structuredClone(candidate.brief_coverage),
        project_classification: candidate.project_classification,
        revision: Number(draft.revision || 1) + 1,
        source_brief_id: fingerprint.brief.id,
        source_brief_revision: fingerprint.brief.revision,
        generation_status: 'completed',
        generation_id: generation.id,
        updated_at: now()
      });
    else
      Object.assign(draft, {
        generation_status: 'completed_diff_available',
        generation_id: generation.id,
        updated_at: now()
      });
    appendEvent(state, generation, 'completed', {
      result_mode: generation.result_mode,
      confidence: candidate.confidence
    });
    addTrace(
      state,
      'workflow.generation.completed',
      {
        project_id: generation.project_id,
        target_id: generation.id,
        summary: `Workflow generation completed: ${generation.result_mode}.`,
        data: { confidence: candidate.confidence }
      },
      generation.created_by_user_id
    );
    return generation;
  });
}

async function failGeneration(generationId, error) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || TERMINAL.has(generation.status)) return generation;
    const code = error?.code || error?.payload?.error || 'workflow_generation_failed';
    Object.assign(generation, {
      status: 'failed',
      phase: 'failed',
      error_code: code,
      error_detail: safeErrorDetail(error),
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id);
    if (draft?.generation_id === generation.id)
      Object.assign(draft, { generation_status: 'failed', updated_at: now() });
    appendEvent(state, generation, 'failed', { error_code: code });
    return generation;
  });
}

async function supersedeGeneration(generationId, reason) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || TERMINAL.has(generation.status)) return generation;
    Object.assign(generation, {
      status: 'superseded',
      phase: 'superseded',
      error_code: reason,
      completed_at: now(),
      updated_at: now()
    });
    appendEvent(state, generation, 'superseded', { reason });
    return generation;
  });
}
async function retainGenerationCandidate(generationId, candidate) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (generation && !TERMINAL.has(generation.status))
      Object.assign(generation, { candidate: structuredClone(candidate), updated_at: now() });
    return generation;
  });
}
async function setGenerationPhase(generationId, phase, status) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || TERMINAL.has(generation.status)) return generation;
    Object.assign(generation, { phase, status, updated_at: now() });
    appendEvent(state, generation, 'phase', { phase, status });
    const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id);
    if (draft?.generation_id === generation.id) Object.assign(draft, { generation_status: status, updated_at: now() });
    return generation;
  });
}

function requireReadyProject(state, projectId, mode = 'initial') {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  assertProjectLifecycleIdle(project);
  if (mode === 'initial' && project.status !== 'draft')
    throw new HttpError(409, { error: 'workflow_generation_project_not_draft' });
  if (mode === 'replan' && project.status !== 'active')
    throw new HttpError(409, { error: 'workflow_generation_project_not_active' });
  const intake = state.project_intakes.find((item) => item.project_id === project.id);
  if (!intake?.mode) throw new HttpError(409, { error: 'workflow_generation_intake_incomplete' });
  if (intake.mode === 'existing' && (!intake.code_source || project.managed_workspace_state !== 'ready'))
    throw new HttpError(409, { error: 'workflow_generation_code_source_not_ready' });
  return project;
}

function testAdapterEnabled(input) {
  return input.adapter === 'test' && (process.env.NODE_ENV === 'test' || process.env.AIWS_ENABLE_TEST_ADAPTER === '1');
}
function appendEvent(state, generation, type, data) {
  const sequence =
    state.workflow_generation_events
      .filter((item) => item.generation_id === generation.id)
      .reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1;
  const event = {
    id: id('wge'),
    generation_id: generation.id,
    project_id: generation.project_id,
    sequence,
    type,
    data: structuredClone(data || {}),
    created_at: now()
  };
  state.workflow_generation_events.push(event);
  return event;
}
function publicGeneration(item) {
  if (!item) return null;
  const { test_candidate, ...result } = item;
  return structuredClone(result);
}
function parseJson(text) {
  const cleaned = String(text || '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, ''),
    start = cleaned.indexOf('{'),
    end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw generationError('codex_json_parse_failed');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw generationError('codex_json_parse_failed');
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}
function generationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
