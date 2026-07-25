import { command, makeRoute, send } from '../http.mjs';
import { ROOT } from '../config.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { AIWS_VERSION, createLocalOwner, now, pick } from '../../../../packages/shared/index.mjs';
import { inspectCodexRuntimeCached, selectedCodexRuntimeImage } from '../codex-runtime-status.mjs';
import { dataDirectoryReady, deploymentStatus } from '../deployment-status.mjs';
import { hostBridgeCapability } from '../host-bridge-service.mjs';
import { terminalRuntimeStats } from '../terminal-service.mjs';
import { accessibleProjectIds, actorForRequest } from '../project-governance-v19.mjs';

export const systemRoutes = [
  makeRoute('GET', '/health', async ({ res, query }) => {
    if (query.gc === '1' && process.env.NODE_ENV === 'test') global.gc?.();
    const state = await readState();
    const git = command('git', ['--version'], ROOT, 3000);
    const codex = command('codex', ['--version'], ROOT, 3000);
    const runtime = await inspectCodexRuntimeCached({ image: selectedCodexRuntimeImage(state) });
    const storageReady = dataDirectoryReady();
    const deployment = deploymentStatus({ dockerReady: runtime.docker.ok, storageReady });
    return send(res, 200, {
      status: storageReady ? 'ok' : 'degraded',
      version: AIWS_VERSION,
      schema_version: state.schema_version,
      api: { healthy: true },
      db: { healthy: storageReady, mode: 'json-local', writable: storageReady },
      deployment: { mode: deployment.mode, local_only: deployment.local_only },
      queue: { required: false, status: 'not_configured', mode: 'direct-execution' },
      git: { healthy: git.ok, version: git.stdout.trim() || git.error },
      codex: { healthy: codex.ok, version: codex.stdout.trim() || codex.error, degraded_ok: true },
      docker: {
        healthy: runtime.docker.ok,
        version: runtime.docker.version || runtime.docker.summary,
        image_ready: runtime.image.ready,
        image: runtime.image.name,
        error_code: runtime.docker.error_code || runtime.image.error_code,
        degraded_ok: true
      },
      runtime: {
        pid: process.pid,
        heap_used_bytes: process.memoryUsage().heapUsed,
        rss_bytes: process.memoryUsage().rss,
        uptime_seconds: process.uptime(),
        terminal: terminalRuntimeStats()
      },
      local_owner: state.users[0] ? pick(state.users[0], ['id', 'display_name', 'role', 'auth_mode']) : null
    });
  }),
  makeRoute('GET', '/system/deployment', async ({ res }) => {
    const state = await readState();
    const runtime = await inspectCodexRuntimeCached({ image: selectedCodexRuntimeImage(state) });
    const deployment = deploymentStatus({ dockerReady: runtime.docker.ok });
    deployment.capabilities = {
      native_assist: { available: runtime.ready, transport: 'app-server' },
      linux_cli: { available: runtime.docker.ok && runtime.image.ready, runtime: 'linux_container' },
      windows_cli: await hostBridgeCapability()
    };
    return send(res, 200, deployment);
  }),
  makeRoute('GET', '/account/me', async ({ req, res }) => {
    const state = await readState();
    const user = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const accounts = state.connected_accounts.filter((item) => item.user_id === user.id).map(publicAccount);
    return send(res, 200, {
      user: pick(user, ['id', 'display_name', 'email', 'avatar_url', 'role', 'auth_mode', 'created_at', 'updated_at']),
      session: publicSession(state.sessions.find((item) => item.user_id === user.id)),
      connected_accounts: accounts,
      github: accounts.find((item) => item.provider === 'github') || null
    });
  }),
  makeRoute('POST', '/account/setup-local-owner', async ({ req, res, body }) => {
    const result = await mutate((state) => {
      let user = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
      if (!user) {
        const created = createLocalOwner(body.display_name || 'Local Owner');
        state.users.push(created.user);
        state.sessions.push(created.session);
        user = created.user;
      }
      user.display_name = body.display_name || user.display_name;
      user.email = body.email || user.email;
      user.updated_at = now();
      addTrace(state, 'human.reviewed', { summary: 'Local Owner Account 已创建/更新。' }, user.id);
      return { user, session: state.sessions.find((s) => s.user_id === user.id) };
    });
    return send(res, 200, result);
  }),
  makeRoute('GET', '/review', async ({ req, res, query }) => {
    const state = await readState(),
      actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      allowed = accessibleProjectIds(state, actor?.id);
    const tokenProjects = new Set(req.auth?.extra?.project_allowlist || []);
    if (tokenProjects.size)
      for (const projectId of [...allowed]) if (!tokenProjects.has(projectId)) allowed.delete(projectId);
    if (query.project_id)
      for (const projectId of [...allowed]) if (projectId !== query.project_id) allowed.delete(projectId);
    const projects = state.projects.filter((item) => allowed.has(item.id)),
      workflows = state.workflows.filter((item) => allowed.has(item.project_id)),
      workflowIds = new Set(workflows.map((item) => item.id));
    const instanceOwner = actor?.id === state.instance_owner_user_id;
    return send(res, 200, {
      projects,
      workflows,
      nodes: state.workflow_nodes.filter((item) => workflowIds.has(item.workflow_id)),
      runs: state.node_runs.filter((item) => allowed.has(item.project_id)),
      traces: state.traces
        .filter((item) => (item.project_id ? allowed.has(item.project_id) : instanceOwner))
        .slice(-500),
      assets: state.assets.filter((item) => allowed.has(item.project_id)),
      decisions: state.decisions.filter((item) => allowed.has(item.project_id)),
      digests: state.digests.filter((item) => allowed.has(item.project_id)),
      code_changes: state.code_changes.filter((item) => allowed.has(item.project_id)),
      agent_sessions: state.agent_sessions.filter((item) => allowed.has(item.project_id)),
      submissions: state.submissions.filter((item) => allowed.has(item.project_id)),
      change_proposals: state.change_proposals.filter((item) =>
        item.project_id ? allowed.has(item.project_id) : instanceOwner
      ),
      open_questions: state.workspaces
        .filter((item) => allowed.has(item.project_id))
        .flatMap((w) => (w.open_questions || []).map((q) => ({ workspace_id: w.id, question: q })))
    });
  })
];

function publicSession(item) {
  return item ? pick(item, ['id', 'user_id', 'mode', 'expires_at', 'created_at']) : null;
}
function publicAccount(item) {
  return pick(item, [
    'id',
    'user_id',
    'provider',
    'provider_account_id',
    'login',
    'display_name',
    'status',
    'scopes',
    'last_verified_at',
    'created_at',
    'updated_at'
  ]);
}
