import { makeRoute, send } from '../http.mjs';
import { listProjectFiles, projectDiff, readProjectFile, runTestPreset, saveProjectFile } from '../file-service.mjs';

export const fileV12Routes = [
  makeRoute('GET', '/projects/:id/files', async ({ res, params, query }) => send(res, 200, await listProjectFiles(params.id, query.path || ''))),
  makeRoute('GET', '/projects/:id/files/content', async ({ res, params, query }) => send(res, 200, await readProjectFile(params.id, query.path || ''))),
  makeRoute('PUT', '/projects/:id/files/content', async ({ res, params, body }) => send(res, 200, await saveProjectFile({ projectId: params.id, nodeId: body.node_id, relative: body.path, content: body.content }))),
  makeRoute('GET', '/projects/:id/files/diff', async ({ res, params, query }) => send(res, 200, await projectDiff(params.id, query.path || ''))),
  makeRoute('POST', '/projects/:id/test-tasks', async ({ res, params, body }) => send(res, 201, { task: await runTestPreset({ projectId: params.id, nodeId: body.node_id, preset: body.preset }) }))
];
