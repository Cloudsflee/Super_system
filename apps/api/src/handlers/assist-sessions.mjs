import { HttpError, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { nodeBundle } from '../helpers.mjs';
import { applyContractPatch, buildAssistContextPack, buildAssistResult, createProject, defaultContractForNode, id, mergeSufficiencyIntoAssistResult, now, pick, validateNodeContract } from '../../../../packages/shared/index.mjs';

export async function createAssistSession({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const input = resolveAssistInput(state, body);
    const assistContext = buildAssistContextPack({ state, ...input, target_type: body.target_type, target_id: body.target_id, field_key: body.field_key, user_prompt: body.user_prompt });
    const draft = buildAssistResult({ state, ...input, target_type: body.target_type, target_id: body.target_id, field_key: body.field_key, user_prompt: body.user_prompt, diff: body.diff || {} });
    const assistResult = mergeSufficiencyIntoAssistResult(draft, assistContext);
    const session = { id: id('asst'), target_type: body.target_type, target_id: body.target_id, field_key: body.field_key || null, user_prompt: body.user_prompt || '', status: assistResult.status, result: assistResult, assist_context_pack: assistContext, created_by_user_id: actor.id, applied_at: null, rejected_at: null, created_at: now(), updated_at: now() };
    state.assist_sessions.push(session);
    state.context_sufficiency_checks.push(assistContext.sufficiency_check);
    traceAssistCreated(state, actor.id, session, input, assistContext);
    return session;
  });
  return send(res, 201, result);
}

function resolveAssistInput(state, body) {
  let project = body.project_id ? state.projects.find((p) => p.id === body.project_id) : null;
  let node = null, contract = null, workspace = null;
  if (body.node_id || body.target_type === 'node_contract') ({ node, project, workspace, contract } = nodeBundle(state, body.node_id || body.target_id));
  if (body.target_type === 'project_wizard' && body.target_id) project = state.projects.find((p) => p.id === body.target_id) || project;
  project ||= state.projects.at(-1) || draftProject(body);
  workspace ||= state.workspaces.find((w) => w.id === project.current_workspace_id) || draftWorkspace(project);
  contract ||= node ? defaultContractForNode(node, project, 'system') : defaultContractForNode({ id: 'draft_node', title: 'Project Wizard', goal: project.goal, type: 'execution' }, project, 'system');
  return { project, node, workspace, contract, asset: state.assets.find((a) => a.id === body.target_id), digest: state.digests.find((d) => d.id === body.target_id) };
}

function draftProject(body) { return { id: 'draft_project', title: body.title || 'Draft Project', goal: body.user_prompt || '', role: '', background: '', current_workspace_id: 'draft_workspace', settings: { token_budget: 4000 } }; }
function draftWorkspace(project) { return { id: project.current_workspace_id || 'draft_workspace', project_id: project.id, title: 'Draft Workspace', goal: project.goal, type: 'project', status: 'draft' }; }

function traceAssistCreated(state, actorId, session, input, ctx) {
  const base = { project_id: input.project?.id, workspace_id: input.workspace?.id, node_id: input.node?.id, target_type: session.target_type, target_id: session.target_id };
  addTrace(state, 'memory.sufficiency.checked', { ...base, summary: `Assist 前充分性检查：${ctx.sufficiency_check.status}`, data: ctx.sufficiency_check }, actorId);
  addTrace(state, 'memory.manifest.generated', { ...base, summary: `Assist Memory Manifest：included ${ctx.memory_manifest.included.length} / excluded ${ctx.memory_manifest.excluded.length}`, data: ctx.memory_manifest }, actorId);
  addTrace(state, 'assist.context_pack.generated', { ...base, summary: `Assist Context Pack：${session.target_type}` }, actorId);
  addTrace(state, 'assist.requested', { ...base, summary: `Assist：${session.target_type}` }, actorId);
  if (session.result.questions.length) addTrace(state, 'assist.questions.generated', { ...base, target_id: session.id, summary: `生成 ${session.result.questions.length} 个追问` }, actorId);
  if (session.result.options.length) addTrace(state, 'assist.options.generated', { ...base, target_id: session.id, summary: `生成 ${session.result.options.length} 个选项` }, actorId);
}

export async function getAssistSession({ res, params }) {
  const state = await readState();
  const session = state.assist_sessions.find((s) => s.id === params.id);
  return session ? send(res, 200, session) : send(res, 404, { error: 'assist_not_found' });
}

export async function rejectAssistSession({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const session = findSession(state, params.id);
    Object.assign(session, { status: 'rejected', rejected_at: now(), updated_at: now() });
    addTrace(state, 'assist.rejected', { target_type: session.target_type, target_id: session.target_id, summary: '用户拒绝 Assist 建议，仅保留 Trace。' }, actor.id);
    return session;
  });
  return send(res, 200, result);
}

export async function applyAssistSession({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), session = findSession(state, params.id), patch = body.patch || session.result.draft_patch || {};
    const target = applyPatchByTarget(state, actor, session, patch, body);
    Object.assign(session, { status: 'applied', applied_at: now(), updated_at: now() });
    state.human_reviews.push({ id: id('hrv'), target_type: session.target_type, target_id: session.target_id, action: 'assist.apply', reviewer_id: actor.id, patch, created_at: now() });
    addTrace(state, 'assist.draft.applied', { target_type: session.target_type, target_id: session.target_id, summary: `应用 Assist 草稿：${session.target_type}`, data: { patch } }, actor.id);
    addTrace(state, 'human.reviewed', { target_type: session.target_type, target_id: session.target_id, summary: '用户确认 Assist 结果后写入目标对象。' }, actor.id);
    return { session, target };
  });
  return send(res, 200, result);
}

function findSession(state, idValue) { const session = state.assist_sessions.find((s) => s.id === idValue); if (!session) throw new HttpError(404, 'assist_not_found'); return session; }

function applyPatchByTarget(state, actor, session, patch, body) {
  if (session.target_type === 'project_wizard') return applyProjectPatch(state, actor, session, patch);
  if (session.target_type === 'node_contract') return applyContractPatchTarget(state, actor, session, patch, body);
  if (session.target_type === 'asset_review') return applyAssetPatch(state, session, patch);
  return null;
}

function applyProjectPatch(state, actor, session, patch) {
  let target = state.projects.find((p) => p.id === session.target_id) || state.projects.at(-1);
  if (target) { Object.assign(target, pick(patch, ['title', 'goal', 'role', 'background'])); target.updated_at = now(); return target; }
  const created = createProject({ ...patch, created_by_user_id: actor.id });
  state.projects.push(created.project); state.workspaces.push(created.workspace);
  return created.project;
}

function applyContractPatchTarget(state, actor, session, patch, body) {
  const { node, project, workspace, contract } = nodeBundle(state, body.node_id || session.target_id);
  if (!node) throw new HttpError(404, 'node_not_found');
  const next = applyContractPatch(contract || defaultContractForNode(node, project, actor.id), patch, actor.id);
  const validation = validateNodeContract(next);
  if (!validation.ok) throw new HttpError(400, { error: 'invalid_contract', details: validation.errors });
  if (contract) contract.status = 'superseded';
  state.node_contracts.push(next); node.current_contract_id = next.id;
  addTrace(state, 'node_contract.created', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_id: next.id, summary: 'Assist 草稿应用到 Node Contract' }, actor.id);
  return next;
}

function applyAssetPatch(state, session, patch) {
  const target = state.assets.find((a) => a.id === session.target_id);
  if (target) { Object.assign(target, pick(patch, ['title', 'summary', 'tags'])); target.updated_at = now(); }
  return target;
}
