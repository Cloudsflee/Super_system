import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { extractMessage, runCodexJson } from './codex-service.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { critiqueWorkflowGenerationCandidate, normalizeWorkflowGenerationCandidate } from './workflow-hierarchy-domain.mjs';
import { resolveWorkflowGenerationCwd } from './workflow-generation-workspace.mjs';
import { createCodexRunError, safeErrorDetail } from './codex-run-diagnostics.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
const controllers = new Map();
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'superseded']);
export async function startWorkflowGeneration(projectId, input = {}, actorId = null) {
  const snapshot = await readState();
  const fingerprint = generationFingerprint(snapshot, projectId);
  const result = await mutate((state) => {
    const project = requireReadyProject(state, projectId), actor = actorId ? state.users.find((item) => item.id === actorId) : owner(state);
    const currentFingerprint = generationFingerprint(state, project.id);
    if (currentFingerprint.input_hash !== fingerprint.input_hash) throw new HttpError(409, { error: 'workflow_generation_inputs_changed' });
    const same = state.workflow_generations
      .filter((item) => item.project_id === project.id && item.input_hash === fingerprint.input_hash && !['cancelled', 'failed', 'superseded'].includes(item.status))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
    if (same && input.force !== true) return { generation: same, idempotent: true, created: false };
    for (const prior of state.workflow_generations.filter((item) => item.project_id === project.id && !TERMINAL.has(item.status))) {
      Object.assign(prior, { status: 'superseded', superseded_reason: 'generation_inputs_changed', completed_at: now(), updated_at: now() });
      appendEvent(state, prior, 'superseded', { reason: prior.input_hash === fingerprint.input_hash ? 'retry_requested' : 'generation_inputs_changed' });
      controllers.get(prior.id)?.abort('superseded'); controllers.delete(prior.id);
    }
    const generation = {
      id: id('wfg'), operation_id: null, project_id: project.id, draft_id: fingerprint.draft.id,
      status: 'queued', phase: 'queued', input_hash: fingerprint.input_hash, brief_id: fingerprint.brief.id,
      brief_revision: fingerprint.brief.revision, material_hash: fingerprint.material_hash, code_source_hash: fingerprint.code_source_hash,
      draft_revision_at_start: fingerprint.draft.revision, draft_user_modified_at_start: fingerprint.draft.user_modified_at || null,
      retry_of_generation_id: input.retry_of_generation_id || null, attempt: Number(input.attempt || 1),
      adapter: input.adapter === 'test' ? 'test' : null, test_candidate: input.test_candidate || null,
      candidate: null, critic: null, result_mode: null, diff: null, error_code: null, error_detail: null, retryable: false,
      cancel_requested_at: null, created_by_user_id: actor?.id || null, created_at: now(), updated_at: now(), completed_at: null
    };
    generation.operation_id = generation.id;
    state.workflow_generations.push(generation);
    appendEvent(state, generation, 'queued', { input_hash: generation.input_hash, attempt: generation.attempt });
    Object.assign(fingerprint.draft, { generation_status: 'queued', generation_id: generation.id, updated_at: now() });
    addTrace(state, 'workflow.generation.queued', { project_id: project.id, target_id: generation.id, summary: 'Workflow draft generation queued.', data: { input_hash: generation.input_hash } }, actor?.id || null);
    return { generation, idempotent: false, created: true };
  });
  if (result.created) queueMicrotask(() => { void executeWorkflowGeneration(result.generation.id); });
  return { generation: publicGeneration(result.generation), idempotent: result.idempotent };
}
export async function retryWorkflowGeneration(projectId, generationId, input = {}, actorId = null) {
  const state = await readState(), generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
  if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
  if (!TERMINAL.has(generation.status)) throw new HttpError(409, { error: 'workflow_generation_not_terminal', status: generation.status });
  return startWorkflowGeneration(projectId, { ...input, force: true, retry_of_generation_id: generation.id, attempt: Number(generation.attempt || 1) + 1 }, actorId);
}
export async function cancelWorkflowGeneration(projectId, generationId, actorId = null) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
    if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
    if (TERMINAL.has(generation.status)) return publicGeneration(generation);
    Object.assign(generation, { cancel_requested_at: now(), status: 'cancelled', phase: 'cancelled', error_code: 'workflow_generation_cancelled', retryable: true, completed_at: now(), updated_at: now() });
    appendEvent(state, generation, 'cancelled', { actor_id: actorId });
    const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id);
    if (draft?.generation_id === generation.id) Object.assign(draft, { generation_status: 'cancelled', updated_at: now() });
    controllers.get(generation.id)?.abort('cancelled'); controllers.delete(generation.id);
    return publicGeneration(generation);
  });
}
export async function getWorkflowGeneration(projectId, generationId) {
  const state = await readState(), generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
  if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
  return publicGeneration(generation);
}
export async function listWorkflowGenerations(projectId, { limit = 20 } = {}) {
  const state = await readState();
  if (!state.projects.some((item) => item.id === projectId && !item.deleted_at)) throw new HttpError(404, { error: 'project_not_found' });
  return state.workflow_generations.filter((item) => item.project_id === projectId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Math.min(100, Math.max(1, Number(limit) || 20))).map(publicGeneration);
}
export async function applyWorkflowGenerationCandidate(projectId, generationId, input = {}, actorId = null) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
    if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
    if (generation.status !== 'completed' || !generation.candidate?.nodes) throw new HttpError(409, { error: 'workflow_generation_candidate_unavailable', status: generation.status });
    const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id && item.project_id === projectId);
    if (!draft) throw new HttpError(404, { error: 'workflow_draft_not_found' });
    if (!Number.isInteger(input.expected_revision)) throw new HttpError(400, { error: 'expected_revision_required', current_revision: draft.revision });
    if (input.expected_revision !== draft.revision) throw new HttpError(409, { error: 'workflow_draft_revision_conflict', expected_revision: input.expected_revision, current_revision: draft.revision });
    const checked = normalizeWorkflowGenerationCandidate(generation.candidate);
    Object.assign(draft, { nodes: structuredClone(checked.nodes), revision: Number(draft.revision || 1) + 1, user_modified_at: now(), updated_by_user_id: actorId, generation_status: 'completed', generation_id: generation.id, updated_at: now() });
    Object.assign(generation, { result_mode: 'applied_after_diff_review', diff: null, applied_by_user_id: actorId, applied_at: now(), updated_at: now() });
    appendEvent(state, generation, 'candidate_applied', { draft_revision: draft.revision, actor_id: actorId });
    return { generation: publicGeneration(generation), draft };
  });
}

export async function listWorkflowGenerationEvents(projectId, generationId, after = 0) {
  const state = await readState(), generation = state.workflow_generations.find((item) => item.id === generationId && item.project_id === projectId);
  if (!generation) throw new HttpError(404, { error: 'workflow_generation_not_found' });
  const events = state.workflow_generation_events.filter((item) => item.generation_id === generation.id && Number(item.sequence) > Number(after || 0)).sort((a, b) => a.sequence - b.sequence);
  return { generation: publicGeneration(generation), events, terminal: TERMINAL.has(generation.status), next_cursor: events.at(-1)?.sequence || Number(after || 0) };
}

export function generationFingerprint(state, projectId) {
  const project = requireReadyProject(state, projectId);
  const brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  const draft = state.workflow_drafts.find((item) => item.project_id === project.id);
  if (!brief || !draft) throw new HttpError(409, { error: 'workflow_generation_brief_and_draft_required' });
  const intake = state.project_intakes.find((item) => item.project_id === project.id);
  const imports = state.import_jobs.filter((item) => item.project_id === project.id && item.status === 'succeeded');
  const material = { context_sources: intake?.context_sources || [], attachments: state.attachments.filter((item) => item.project_id === project.id).map((item) => ({ id: item.id, sha256: item.sha256 || item.content_hash || null })) };
  const code = { code_source: intake?.code_source || null, imports: imports.map((item) => ({ kind: item.kind, source_hash: item.source_hash || null, repository: item.repository?.full_name || null })) };
  const materialHash = hashString(JSON.stringify(canonical(material))), codeSourceHash = hashString(JSON.stringify(canonical(code)));
  const inputHash = hashString(JSON.stringify({ project_id: project.id, brief_id: brief.id, brief_revision: brief.revision, material_hash: materialHash, code_source_hash: codeSourceHash }));
  return { project, brief, draft, intake, material_hash: materialHash, code_source_hash: codeSourceHash, input_hash: inputHash };
}

async function executeWorkflowGeneration(generationId) {
  const controller = new AbortController(); controllers.set(generationId, controller);
  try {
    await setGenerationPhase(generationId, 'generating', 'running');
    const state = await readState(), generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || generation.status === 'cancelled' || generation.status === 'superseded') return;
    const fingerprint = generationFingerprint(state, generation.project_id);
    if (fingerprint.input_hash !== generation.input_hash) return supersedeGeneration(generation.id, 'generation_inputs_changed');
    const candidate = generation.adapter === 'test'
      ? normalizeWorkflowGenerationCandidate(generation.test_candidate || testCandidate(fingerprint), { idFactory: deterministicFactory(generation.id) })
      : await generateCandidateWithCodex(state, generation, fingerprint, controller.signal);
    if (controller.signal.aborted) return;
    await setGenerationPhase(generationId, 'critic', 'running');
    const critic = generation.adapter === 'test'
      ? { approved: true, errors: [] }
      : await critiqueCandidateWithCodex(state, generation, fingerprint, candidate, controller.signal);
    const deterministicCritic = critiqueWorkflowGenerationCandidate(candidate);
    if (!critic.approved || !deterministicCritic.ok) throw generationError('workflow_generation_critic_rejected', { critic, deterministic_critic: deterministicCritic });
    await completeGeneration(generationId, candidate, { ...critic, deterministic: deterministicCritic });
  } catch (error) {
    if (!controller.signal.aborted) await failGeneration(generationId, error);
  } finally { controllers.delete(generationId); }
}

async function generateCandidateWithCodex(state, generation, fingerprint, signal) {
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw generationError('active_codex_profile_required');
  let output = '';
  const context = generationContext(fingerprint);
  const prompt = [
    'Design an outcome-oriented two-level project workflow. Return JSON only.',
    'Top level: 1-6 independently acceptable workstreams. Each workstream needs role=workstream, category deliverable|decision|coordination|operation, a verifiable outcome, acceptance_criteria, at least one explicit boundary, dependencies, and 1-12 tasks.',
    'Tasks need role=task, task_kind research|analysis|design|content|code|test|review|deploy|manual|integration, execution_mode manual|assist|codex|integration, same-workstream dependencies, and optional repository_intent.',
    'Never use a lifecycle phase such as requirements analysis, design, coding, testing, review, deployment, or launch as a standalone workstream. Do not assume the project is software.',
    'Return keys project_classification, decomposition_basis, evidence_refs [{section_id,quote}], confidence (0..1), repository_intent, workstreams [{id,role:"workstream",title,outcome,category,boundary,acceptance_criteria,dependency_ids,tasks:[{id,role:"task",title,goal,task_kind,execution_mode,dependency_ids,repository_intent}]}].',
    `Input: ${JSON.stringify(context)}`
  ].join('\n');
  const run = await runCodexJson({ state, profile, prompt, cwd: await resolveWorkflowGenerationCwd(fingerprint.project), sandbox: 'read-only', projectId: fingerprint.project.id, signal, onEvent: (event) => { output += extractMessage(event); } });
  if (!run.ok) throw createCodexRunError(run, { failureCode: 'codex_workflow_generation_failed', timeoutCode: 'codex_workflow_generation_timeout' });
  return normalizeWorkflowGenerationCandidate(parseJson(output || run.stdout));
}

async function critiqueCandidateWithCodex(state, generation, fingerprint, candidate, signal) {
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw generationError('active_codex_profile_required');
  let output = '';
  const prompt = [
    'Act as an independent workflow critic. Check evidence fidelity, outcome-oriented workstream semantics, independent boundaries, two-level depth, local DAG scope, task completeness, repository intent, and the ban on generic lifecycle-stage workstreams.',
    'Return JSON only: {"approved":true|false,"errors":[{"code":"...","node_id":"...","detail":"..."}]}. Reject the entire candidate on any violation.',
    `Brief: ${JSON.stringify(generationContext(fingerprint))}`,
    `Candidate: ${JSON.stringify(candidate)}`
  ].join('\n');
  const run = await runCodexJson({ state, profile, prompt, cwd: await resolveWorkflowGenerationCwd(fingerprint.project), sandbox: 'read-only', projectId: fingerprint.project.id, signal, onEvent: (event) => { output += extractMessage(event); } });
  if (!run.ok) throw createCodexRunError(run, { failureCode: 'codex_workflow_critic_failed', timeoutCode: 'codex_workflow_critic_timeout' });
  const parsed = parseJson(output || run.stdout);
  return { approved: parsed.approved === true, errors: Array.isArray(parsed.errors) ? parsed.errors.slice(0, 100) : [] };
}

async function completeGeneration(generationId, candidate, critic) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || TERMINAL.has(generation.status)) return generation;
    const fingerprint = generationFingerprint(state, generation.project_id);
    if (fingerprint.input_hash !== generation.input_hash) {
      Object.assign(generation, { status: 'superseded', phase: 'superseded', completed_at: now(), updated_at: now(), error_code: 'generation_inputs_changed' });
      appendEvent(state, generation, 'superseded', { reason: 'generation_inputs_changed' }); return generation;
    }
    const draft = fingerprint.draft;
    const userModified = Boolean(draft.user_modified_at) || draft.revision !== generation.draft_revision_at_start || (draft.user_modified_at || null) !== generation.draft_user_modified_at_start;
    Object.assign(generation, {
      status: 'completed', phase: 'completed', candidate: structuredClone(candidate), critic: structuredClone(critic),
      result_mode: userModified ? 'diff' : 'applied_to_draft', diff: userModified ? { from_revision: draft.revision, current_nodes: structuredClone(draft.nodes || []), candidate_nodes: structuredClone(candidate.nodes) } : null,
      completed_at: now(), updated_at: now(), retryable: false
    });
    if (!userModified) Object.assign(draft, { nodes: structuredClone(candidate.nodes), revision: Number(draft.revision || 1) + 1, source_brief_id: fingerprint.brief.id, source_brief_revision: fingerprint.brief.revision, generation_status: 'completed', generation_id: generation.id, updated_at: now() });
    else Object.assign(draft, { generation_status: 'completed_diff_available', generation_id: generation.id, updated_at: now() });
    appendEvent(state, generation, 'completed', { result_mode: generation.result_mode, confidence: candidate.confidence });
    addTrace(state, 'workflow.generation.completed', { project_id: generation.project_id, target_id: generation.id, summary: `Workflow generation completed: ${generation.result_mode}.`, data: { confidence: candidate.confidence } }, generation.created_by_user_id);
    return generation;
  });
}

async function failGeneration(generationId, error) {
  return mutate((state) => {
    const generation = state.workflow_generations.find((item) => item.id === generationId);
    if (!generation || TERMINAL.has(generation.status)) return generation;
    const code = error?.code || error?.payload?.error || 'workflow_generation_failed';
    Object.assign(generation, { status: 'failed', phase: 'failed', error_code: code, error_detail: safeErrorDetail(error), retryable: true, completed_at: now(), updated_at: now() });
    const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id);
    if (draft?.generation_id === generation.id) Object.assign(draft, { generation_status: 'failed', updated_at: now() });
    appendEvent(state, generation, 'failed', { error_code: code });
    return generation;
  });
}

async function supersedeGeneration(generationId, reason) { return mutate((state) => { const generation = state.workflow_generations.find((item) => item.id === generationId); if (!generation || TERMINAL.has(generation.status)) return generation; Object.assign(generation, { status: 'superseded', phase: 'superseded', error_code: reason, completed_at: now(), updated_at: now() }); appendEvent(state, generation, 'superseded', { reason }); return generation; }); }
async function setGenerationPhase(generationId, phase, status) { return mutate((state) => { const generation = state.workflow_generations.find((item) => item.id === generationId); if (!generation || TERMINAL.has(generation.status)) return generation; Object.assign(generation, { phase, status, updated_at: now() }); appendEvent(state, generation, 'phase', { phase, status }); const draft = state.workflow_drafts.find((item) => item.id === generation.draft_id); if (draft?.generation_id === generation.id) Object.assign(draft, { generation_status: status, updated_at: now() }); return generation; }); }

function requireReadyProject(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  assertProjectLifecycleIdle(project);
  if (project.status !== 'draft') throw new HttpError(409, { error: 'workflow_generation_project_not_draft' });
  const intake = state.project_intakes.find((item) => item.project_id === project.id);
  if (!intake?.mode) throw new HttpError(409, { error: 'workflow_generation_intake_incomplete' });
  if (intake.mode === 'existing' && (!intake.code_source || project.managed_workspace_state !== 'ready')) throw new HttpError(409, { error: 'workflow_generation_code_source_not_ready' });
  return project;
}

function generationContext(fingerprint) {
  const content = fingerprint.brief.content || {};
  return {
    project: { id: fingerprint.project.id, title: fingerprint.project.title, goal: fingerprint.project.goal },
    brief: { id: fingerprint.brief.id, revision: fingerprint.brief.revision, title: content.title, summary: content.summary, sections: content.sections },
    materials: fingerprint.intake?.context_sources || [], code_source: fingerprint.intake?.code_source || null,
    material_hash: fingerprint.material_hash, code_source_hash: fingerprint.code_source_hash
  };
}

function testCandidate(fingerprint) {
  const content = fingerprint.brief.content || {}, evidence = content.sections?.find((item) => item.id) || { id: 'brief-goal' };
  const text = `${fingerprint.project.title} ${fingerprint.project.goal} ${content.summary || ''}`.toLowerCase();
  const coding = fingerprint.intake?.mode === 'existing' || /(software|app|api|code|system|\u8f6f\u4ef6|\u7cfb\u7edf|\u5e94\u7528|\u7f16\u7a0b)/i.test(text);
  const workstreamId = `wfs_${hashString(`${fingerprint.input_hash}:outcome`).slice(0, 20)}`;
  const taskId = `tsk_${hashString(`${fingerprint.input_hash}:task`).slice(0, 20)}`;
  return {
    project_classification: coding ? 'software_delivery' : 'knowledge_or_manual_delivery',
    decomposition_basis: 'One independently acceptable outcome is sufficient for the current brief; execution steps stay inside the workstream.',
    evidence_refs: [{ section_id: evidence.id, quote: content.goal || fingerprint.project.goal || fingerprint.project.title }], confidence: 0.86,
    repository_intent: coding ? [{ mode: 'write', source: 'project_code_source' }] : [],
    workstreams: [{
      id: workstreamId, role: 'workstream', title: coding ? 'Verifiable product increment' : 'Verified project outcome',
      outcome: coding ? 'A runnable increment satisfying the brief acceptance criteria.' : 'A reviewed deliverable satisfying the stated project goal.',
      category: 'deliverable', boundary: { deliverable: coding ? 'runnable_increment' : 'reviewed_deliverable' },
      acceptance_criteria: content.acceptance_criteria?.length ? content.acceptance_criteria : ['The submitted outcome is reviewable and supported by evidence.'], dependency_ids: [],
      tasks: [{ id: taskId, role: 'task', title: coding ? 'Implement and verify the increment' : 'Produce and verify the deliverable', goal: fingerprint.project.goal || content.goal || 'Complete the deliverable', task_kind: coding ? 'code' : 'manual', execution_mode: coding ? 'codex' : 'manual', dependency_ids: [], repository_intent: coding ? { mode: 'write' } : null }]
    }]
  };
}

function deterministicFactory(seed) { let counter = 0; return (prefix) => `${prefix}_${hashString(`${seed}:${prefix}:${counter++}`).slice(0, 20)}`; }
function appendEvent(state, generation, type, data) { const sequence = state.workflow_generation_events.filter((item) => item.generation_id === generation.id).reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1; const event = { id: id('wge'), generation_id: generation.id, project_id: generation.project_id, sequence, type, data: structuredClone(data || {}), created_at: now() }; state.workflow_generation_events.push(event); return event; }
function publicGeneration(item) { if (!item) return null; const { test_candidate, ...result } = item; return structuredClone(result); }
function parseJson(text) { const cleaned = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, ''), start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}'); if (start < 0 || end < start) throw generationError('codex_json_parse_failed'); try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { throw generationError('codex_json_parse_failed'); } }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); }
function generationError(code, details = {}) { const error = new Error(code); error.code = code; error.details = details; return error; }
