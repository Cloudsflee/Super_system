import path from 'node:path';
import { HttpError } from './http.mjs';
import { ASSIST_DIR } from './config.mjs';
import { mutate, readState } from './state.mjs';
import { runCodexAppServerRpc } from './codex-app-server.mjs';
import { coordinateAssistSession } from './assist-session-coordinator.mjs';
import { getSessionChangeBatch } from './assist-change-batches.mjs';
import { bindSessionRuntimeProfile, cleanText, readableProjectCwd, requireProject, requireSession, resolveAssistTurnConfiguration } from './assist-v3-domain.mjs';
import { now } from '../../../packages/shared/index.mjs';

const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);

export function getAssistGoal(sessionId, dependencies = {}) { return coordinateAssistSession(sessionId, () => performGoalRpc(sessionId, 'get', {}, dependencies)); }
export function setAssistGoal(sessionId, input = {}, dependencies = {}) { return coordinateAssistSession(sessionId, () => performGoalRpc(sessionId, 'set', input, dependencies)); }
export function clearAssistGoal(sessionId, dependencies = {}) { return coordinateAssistSession(sessionId, () => performGoalRpc(sessionId, 'clear', {}, dependencies)); }

async function performGoalRpc(sessionId, operation, input = {}, { rpc = runCodexAppServerRpc } = {}) {
  let state = await readState(), session = requireSession(state, sessionId), project = requireProject(state, session.project_id);
  if (operation !== 'set' && !session.codex_thread_id) return { goal: null };
  const configuration = resolveGoalProfile(state, session, input);
  const profile = { ...configuration.profile, model: configuration.model, reasoning: configuration.reasoning };
  if (!profile?.id) throw new HttpError(409, { error: 'active_codex_profile_required' });
  if (operation === 'set') await mutate((current) => { const currentSession = requireSession(current, session.id); bindSessionRuntimeProfile(currentSession, current.codex_profiles.find((item) => item.id === profile.id)); });
  state = await readState(); session = requireSession(state, session.id); project = requireProject(state, session.project_id);
  const batch = await getSessionChangeBatch(session.id), cwd = batch?.worktree?.path || readableProjectCwd(project) || path.join(ASSIST_DIR, project.id);
  const legacy = session.native_thread_generation === 1;
  const resumeId = legacy ? null : session.codex_thread_id;
  const method = operation === 'get' ? 'thread/goal/get' : operation === 'clear' ? 'thread/goal/clear' : 'thread/goal/set';
  const params = operation === 'set' ? normalizeGoalInput(input, session.native_goal_snapshot) : {};
  const response = await rpc({ state, profile, cwd, sandbox: 'read-only', resumeId, createThread: !resumeId, method, params });
  const threadId = response.thread_id || resumeId;
  if (operation === 'set' && !threadId) throw new HttpError(409, { error: 'native_goal_thread_missing' });
  const goal = operation === 'clear' ? null : normalizeGoalResponse(response.result);
  await mutate((current) => {
    const currentSession = requireSession(current, session.id, true);
    if (threadId) { currentSession.codex_thread_id = threadId; currentSession.native_thread_generation = 2; }
    currentSession.native_goal_snapshot = goal; currentSession.native_goal_synced_at = now(); currentSession.updated_at = now();
  });
  return { goal };
}

function resolveGoalProfile(state, session, input) {
  if (input.profile_id || input.configuration_id || !session.runtime_profile_id) return resolveAssistTurnConfiguration(state, input);
  const profile = state.codex_profiles.find((item) => item.id === session.runtime_profile_id && item.status === 'validated');
  if (!profile) throw new HttpError(409, { error: 'assist_runtime_profile_unavailable' });
  return { profile, configuration: null, model: input.model || profile.model, reasoning: input.reasoning || profile.reasoning };
}
function normalizeGoalInput(input, previous) {
  const result = {};
  if (input.objective !== undefined) { const objective = cleanText(input.objective, 20_000); if (!objective) throw new HttpError(400, { error: 'assist_goal_objective_required' }); result.objective = objective; }
  else if (!previous?.objective && input.status === undefined) throw new HttpError(400, { error: 'assist_goal_objective_required' });
  if (input.status !== undefined) { const status = String(input.status); if (!GOAL_STATUSES.has(status)) throw new HttpError(400, { error: 'assist_goal_status_invalid', allowed: [...GOAL_STATUSES] }); result.status = status; }
  if (input.tokenBudget !== undefined || input.token_budget !== undefined) { const budget = Number(input.tokenBudget ?? input.token_budget); if (!Number.isSafeInteger(budget) || budget <= 0) throw new HttpError(400, { error: 'assist_goal_token_budget_invalid' }); result.tokenBudget = budget; }
  return result;
}
function normalizeGoalResponse(result) {
  const goal = result?.goal ?? result ?? null;
  if (!goal || typeof goal !== 'object') return null;
  return { objective: String(goal.objective || ''), status: String(goal.status || 'active'), tokenBudget: goal.tokenBudget == null ? null : Number(goal.tokenBudget), tokensUsed: Number(goal.tokensUsed || 0), timeUsedSeconds: Number(goal.timeUsedSeconds || 0), createdAt: goal.createdAt ?? null, updatedAt: goal.updatedAt ?? null };
}
