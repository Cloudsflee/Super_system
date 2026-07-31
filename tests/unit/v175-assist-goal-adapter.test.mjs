import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v175-goal-'));
process.env.AIWS_HOME = path.join(root, 'home');
try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const goals = await import('../../apps/api/src/assist-goals.mjs');
  const domain = await import('../../apps/api/src/assist-v3-domain.mjs');
  await stateApi.ensureRuntime();
  await stateApi.mutate((state) => {
    state.projects.push({
      id: 'project-goal',
      title: 'Goal fixture',
      status: 'active',
      managed_workspace_state: 'ready',
      current_workspace_id: 'workspace-goal',
      repo_path: root,
      lifecycle_operation: null
    });
    state.workspaces.push({ id: 'workspace-goal', project_id: 'project-goal', status: 'active' });
    const profile = {
      id: 'profile-goal',
      name: 'Goal profile',
      status: 'validated',
      kind: 'docker',
      model: 'test-model',
      reasoning: 'high'
    };
    const session = {
      id: 'session-goal',
      version: 3,
      project_id: 'project-goal',
      workspace_id: 'workspace-goal',
      scope_type: 'project',
      scope_id: 'project-goal',
      status: 'idle',
      native_thread_generation: 2
    };
    state.codex_profiles.push(profile);
    domain.bindSessionRuntimeProfile(session, profile);
    state.assist_sessions.push(session);
  });
  const set = await goals.setAssistGoal(
    'session-goal',
    { objective: 'Complete adapter journey', tokenBudget: 17500 },
    { adapted: true }
  );
  assert.deepEqual(
    { objective: set.goal.objective, status: set.goal.status, tokenBudget: set.goal.tokenBudget },
    { objective: 'Complete adapter journey', status: 'active', tokenBudget: 17500 }
  );
  const fetched = await goals.getAssistGoal('session-goal', { adapted: true });
  assert.equal(fetched.goal.objective, 'Complete adapter journey');
  assert.equal(
    (await goals.setAssistGoal('session-goal', { status: 'complete' }, { adapted: true })).goal.status,
    'complete'
  );
  assert.deepEqual(await goals.clearAssistGoal('session-goal', { adapted: true }), { goal: null });
  const state = await stateApi.readState(),
    session = state.assist_sessions.find((item) => item.id === 'session-goal');
  assert.match(session.codex_thread_id, /^test-goal-/);
  assert.equal(session.native_goal_snapshot, null);
  console.log('V1.75 Assist Goal adapter tests passed');
} finally {
  await import('../../apps/api/src/state.mjs').then((state) => state.checkpointAndCloseState()).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}
