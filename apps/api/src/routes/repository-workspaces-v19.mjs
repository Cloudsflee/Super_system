import { addTrace, mutate, readState } from '../state.mjs';
import { HttpError, makeRoute, send } from '../http.mjs';
import { actorForRequest, assertProjectRead, assertProjectWrite } from '../project-governance-v19.mjs';
import {
  createRepositoryWorkspace,
  inspectRepositoryWorkspace,
  markRepositoryWorkspacesStale,
  refreshRepositoryMirror,
  removeRepositoryWorkspace,
  repositoryBranches,
  requireRepositoryWorkspace
} from '../repository-workspace-service.mjs';
import { listProjectFiles, projectDiff, readProjectFile, runTestPreset, saveProjectFile } from '../file-service.mjs';

export const repositoryWorkspaceV19Routes = [
  makeRoute('GET', '/projects/:id/repository-branches', listBranches),
  makeRoute('GET', '/projects/:id/repository-workspaces', listWorkspaces),
  makeRoute('POST', '/projects/:id/repository-workspaces', createWorkspace),
  makeRoute('GET', '/repository-workspaces/:id', getWorkspace),
  makeRoute('POST', '/repository-workspaces/:id/refresh', refreshWorkspace),
  makeRoute('DELETE', '/repository-workspaces/:id', cleanupWorkspace),
  makeRoute('GET', '/repository-workspaces/:id/files', listFiles),
  makeRoute('GET', '/repository-workspaces/:id/files/content', readFile),
  makeRoute('PUT', '/repository-workspaces/:id/files/content', saveFile),
  makeRoute('GET', '/repository-workspaces/:id/diff', diffWorkspace),
  makeRoute('POST', '/repository-workspaces/:id/test-tasks', runWorkspaceTest)
];

async function listBranches({ req, res, params, query }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor.id);
  const catalog = repositoryBranches(state, params.id, query.connection_id || null);
  return send(res, 200, publicCatalog(catalog));
}

async function listWorkspaces({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor.id);
  return send(res, 200, {
    items: state.repository_workspaces
      .filter((item) => item.project_id === params.id && item.status !== 'removed')
      .map((item) => decorate(state, item))
  });
}

async function createWorkspace({ req, res, params, body }) {
  const result = await mutate(async (state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    assertProjectWrite(state, params.id, actor.id);
    const created = await createRepositoryWorkspace(state, params.id, body, actor.id);
    if (!created.idempotent)
      addTrace(
        state,
        'repository.workspace.created',
        {
          project_id: params.id,
          target_type: 'repository_workspace',
          target_id: created.workspace.id,
          summary: `Repository workspace: ${created.workspace.ref}@${created.workspace.fixed_sha.slice(0, 12)}`
        },
        actor.id
      );
    return { ...created, workspace: decorate(state, created.workspace) };
  });
  return send(res, result.idempotent ? 200 : 201, result);
}

async function getWorkspace({ req, res, params }) {
  const state = await readState(),
    workspace = requireRepositoryWorkspace(state, params.id),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, workspace.project_id, actor.id);
  return send(res, 200, decorate(state, workspace));
}

async function refreshWorkspace({ req, res, params, body }) {
  const result = await mutate(async (state) => {
    const workspace = requireRepositoryWorkspace(state, params.id),
      actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    assertProjectWrite(state, workspace.project_id, actor.id);
    await refreshRepositoryMirror(state, workspace.project_id, workspace.connection_id, {
      fetch: body.fetch !== false
    });
    const refreshed = inspectRepositoryWorkspace(state, workspace.id);
    addTrace(
      state,
      'repository.workspace.refreshed',
      {
        project_id: workspace.project_id,
        target_type: 'repository_workspace',
        target_id: workspace.id,
        summary: `Repository workspace ${refreshed.sync_status}`,
        data: { ref: refreshed.ref, fixed_sha: refreshed.fixed_sha, remote_sha: refreshed.remote_sha }
      },
      actor.id
    );
    return decorate(state, refreshed);
  });
  return send(res, 200, result);
}

async function cleanupWorkspace({ req, res, params }) {
  const result = await mutate(async (state) => {
    const workspace = requireRepositoryWorkspace(state, params.id),
      actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    assertProjectWrite(state, workspace.project_id, actor.id);
    return removeRepositoryWorkspace(state, workspace.id, actor.id);
  });
  return send(res, 200, result);
}

async function listFiles({ req, res, params, query }) {
  const { state, workspace } = await access(req, params.id, false);
  return send(res, 200, await listProjectFiles(workspace.project_id, query.path || '', workspace.id));
}
async function readFile({ req, res, params, query }) {
  const { workspace } = await access(req, params.id, false);
  return send(res, 200, await readProjectFile(workspace.project_id, query.path || '', workspace.id));
}
async function saveFile({ req, res, params, body }) {
  const { workspace } = await access(req, params.id, true);
  return send(
    res,
    200,
    await saveProjectFile({
      projectId: workspace.project_id,
      repositoryWorkspaceId: workspace.id,
      nodeId: body.node_id,
      relative: body.path,
      content: body.content
    })
  );
}
async function diffWorkspace({ req, res, params, query }) {
  const { workspace } = await access(req, params.id, false);
  return send(res, 200, await projectDiff(workspace.project_id, query.path || '', workspace.id));
}
async function runWorkspaceTest({ req, res, params, body }) {
  const { workspace } = await access(req, params.id, true);
  return send(res, 201, {
    task: await runTestPreset({
      projectId: workspace.project_id,
      repositoryWorkspaceId: workspace.id,
      nodeId: body.node_id,
      preset: body.preset
    })
  });
}

async function access(req, workspaceId, write) {
  const state = await readState(),
    workspace = requireRepositoryWorkspace(state, workspaceId),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  if (write) assertProjectWrite(state, workspace.project_id, actor.id);
  else assertProjectRead(state, workspace.project_id, actor.id);
  return { state, workspace, actor };
}

function decorate(state, workspace) {
  const intents = state.pull_request_intents.filter(
    (item) => item.repository_workspace_id === workspace.id && !['revoked', 'expired'].includes(item.status)
  );
  return {
    ...workspace,
    snapshot_hash: workspaceSnapshot(workspace),
    pull_requests: intents.map((item) => ({
      intent_id: item.id,
      number: item.pr_number || null,
      url: item.pr_url || null,
      state: item.pr_state || item.status
    }))
  };
}
function workspaceSnapshot(item) {
  return `${item.ref}:${item.fixed_sha}:${item.revision}`;
}
function publicCatalog(value) {
  return {
    project_id: value.project.id,
    connection_id: value.connection?.id || null,
    default_branch: value.default_branch,
    branches: value.branches
  };
}

export { markRepositoryWorkspacesStale };
