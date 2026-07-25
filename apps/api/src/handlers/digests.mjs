import { HttpError } from '../http.mjs';
import { addTrace, mutate, owner } from '../state.mjs';
import { buildDigest, now } from '../../../../packages/shared/index.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';

export async function createDigest({ res, params, body, send }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const workspace = state.workspaces.find((item) => item.id === params.id);
    if (!workspace) throw new HttpError(404, 'workspace_not_found');
    const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === workspace.project_id));
    const digest = buildDigest({ state, project, workspace, actorId: actor.id, summaryPatch: body });
    state.digests.push(digest);
    workspace.current_digest_id = digest.id;
    workspace.updated_at = now();
    traceDigest(state, { actorId: actor.id, project, workspace, digest });
    return digest;
  });
  return send(res, 201, result);
}

function traceDigest(state, { actorId, project, workspace, digest }) {
  addTrace(
    state,
    'digest.generated',
    {
      project_id: project.id,
      workspace_id: workspace.id,
      target_type: 'digest',
      target_id: digest.id,
      summary: `生成 Digest v${digest.version}`
    },
    actorId
  );
  addTrace(
    state,
    'digest.confirmed',
    {
      project_id: project.id,
      workspace_id: workspace.id,
      target_type: 'digest',
      target_id: digest.id,
      summary: `确认 Digest v${digest.version}`
    },
    actorId
  );
}
