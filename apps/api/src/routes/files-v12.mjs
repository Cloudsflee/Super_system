import { makeRoute, send } from '../http.mjs';
import { listProjectFiles, projectDiff, readProjectFile, runTestPreset, saveProjectFile } from '../file-service.mjs';

export const fileV12Routes = [
  makeRoute('GET', '/projects/:id/files', async ({ res, params, query }) => send(res, 200, await listProjectFiles(params.id, query.path || '', query.repository_workspace_id || null))),
  makeRoute('GET', '/projects/:id/files/content', async ({ res, params, query }) => send(res, 200, await readProjectFile(params.id, query.path || '', query.repository_workspace_id || null))),
  makeRoute('PUT', '/projects/:id/files/content', async ({ res, params, body }) => send(res, 200, await saveProjectFile({ projectId: params.id, nodeId: body.node_id, relative: body.path, content: body.content, repositoryWorkspaceId: body.repository_workspace_id || null, taskExecutionId: body.task_execution_id || null, leaseToken: body.lease_token || null }))),
  makeRoute('GET', '/projects/:id/files/diff', async ({ res, params, query }) => send(res, 200, await projectDiff(params.id, query.path || '', query.repository_workspace_id || null))),
  makeRoute('POST', '/projects/:id/test-tasks', async ({ res, params, body }) => send(res, 201, { task: await runTestPreset({ projectId: params.id, nodeId: body.node_id, preset: body.preset, repositoryWorkspaceId: body.repository_workspace_id || null, taskExecutionId: body.task_execution_id || null, leaseToken: body.lease_token || null }) }))
];
