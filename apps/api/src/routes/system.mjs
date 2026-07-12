import { command, makeRoute, send } from '../http.mjs';
import { ROOT } from '../config.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { createLocalOwner, now, pick } from '../../../../packages/shared/index.mjs';
import { inspectCodexRuntimeLive } from '../codex-runtime-status.mjs';
import { dataDirectoryReady, deploymentStatus } from '../deployment-status.mjs';

export const systemRoutes = [
  makeRoute('GET', '/health', async ({ res }) => {
    const state = await readState();
    const git = command('git', ['--version'], ROOT, 3000);
    const codex = command('codex', ['--version'], ROOT, 3000);
    const runtime = inspectCodexRuntimeLive();
    const storageReady = dataDirectoryReady();
    const deployment = deploymentStatus({ dockerReady: runtime.docker.ok, storageReady });
    return send(res, 200, {
      status: storageReady ? 'ok' : 'degraded', api: { healthy: true }, db: { healthy: storageReady, mode: 'json-local', writable: storageReady },
      deployment: { mode: deployment.mode, local_only: deployment.local_only },
      queue: { required: false, status: 'not_configured', mode: 'direct-execution' },
      git: { healthy: git.ok, version: git.stdout.trim() || git.error },
      codex: { healthy: codex.ok, version: codex.stdout.trim() || codex.error, degraded_ok: true },
      docker: { healthy: runtime.docker.ok, version: runtime.docker.version || runtime.docker.summary, image_ready: runtime.image.ready, image: runtime.image.name, error_code: runtime.docker.error_code || runtime.image.error_code, degraded_ok: true },
      local_owner: state.users[0] ? pick(state.users[0], ['id', 'display_name', 'role', 'auth_mode']) : null
    });
  }),
  makeRoute('GET', '/system/deployment', async ({ res }) => {
    const runtime = inspectCodexRuntimeLive();
    return send(res, 200, deploymentStatus({ dockerReady: runtime.docker.ok }));
  }),
  makeRoute('GET', '/account/me', async ({ res }) => {
    const state = await readState();
    const user = owner(state);
    return send(res, 200, { user, session: state.sessions.find((s) => s.user_id === user.id), connected_accounts: state.connected_accounts.filter((a) => a.user_id === user.id), github: state.connected_accounts.find((a) => a.user_id === user.id && a.provider === 'github') || null });
  }),
  makeRoute('POST', '/account/setup-local-owner', async ({ res, body }) => {
    const result = await mutate((state) => {
      let user = owner(state);
      if (!user) {
        const created = createLocalOwner(body.display_name || 'Local Owner');
        state.users.push(created.user); state.sessions.push(created.session); user = created.user;
      }
      user.display_name = body.display_name || user.display_name;
      user.email = body.email || user.email;
      user.updated_at = now();
      addTrace(state, 'human.reviewed', { summary: 'Local Owner Account 已创建/更新。' }, user.id);
      return { user, session: state.sessions.find((s) => s.user_id === user.id) };
    });
    return send(res, 200, result);
  }),
  makeRoute('GET', '/review', async ({ res }) => {
    const state = await readState();
    return send(res, 200, { projects: state.projects, workflows: state.workflows, nodes: state.workflow_nodes, runs: state.node_runs, traces: state.traces.slice(-500), assets: state.assets, decisions: state.decisions, digests: state.digests, code_changes: state.code_changes, agent_sessions: state.agent_sessions, submissions: state.submissions, change_proposals: state.change_proposals, codex_profiles: state.codex_profiles, integrations: state.integration_statuses, open_questions: state.workspaces.flatMap((w) => (w.open_questions || []).map((q) => ({ workspace_id: w.id, question: q }))) });
  })
];
