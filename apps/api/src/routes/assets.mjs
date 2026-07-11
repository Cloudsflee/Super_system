import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner } from '../state.mjs';
import { readState } from '../state.mjs';
import { createDigest } from '../handlers/digests.mjs';
import { AssetStatus, confirmAsset, now } from '../../../../packages/shared/index.mjs';

async function confirmCandidate({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), asset = findAsset(state, params.id), version = currentVersion(state, asset);
    if (asset.status !== AssetStatus.Candidate) throw new HttpError(409, { error: 'asset_not_candidate', status: asset.status });
    if (!asset.evidence_refs?.length || !version) throw new HttpError(409, { error: 'asset_evidence_required' });
    const confirmed = confirmAsset(asset, version, actor.id, body.patch || body);
    Object.assign(asset, confirmed.asset);
    state.asset_versions.push(confirmed.version);
    addTrace(state, 'asset.confirmed', { project_id: asset.project_id, workspace_id: asset.workspace_id, node_id: asset.node_id, run_id: asset.run_id, target_type: 'asset', target_id: asset.id, summary: `确认资产：${asset.title}`, data: { evidence_refs: asset.evidence_refs } }, actor.id);
    return { asset, version: confirmed.version };
  });
  return send(res, 200, result);
}

async function rejectCandidate({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state), asset = findAsset(state, params.id);
    if (asset.status !== AssetStatus.Candidate) throw new HttpError(409, { error: 'asset_not_candidate', status: asset.status });
    asset.status = AssetStatus.Rejected;
    asset.updated_at = now();
    addTrace(state, 'asset.rejected', { project_id: asset.project_id, workspace_id: asset.workspace_id, node_id: asset.node_id, run_id: asset.run_id, target_type: 'asset', target_id: asset.id, summary: `拒绝资产候选：${asset.title}` }, actor.id);
    return asset;
  });
  return send(res, 200, result);
}

function findAsset(state, idValue) { const asset = state.assets.find((item) => item.id === idValue); if (!asset) throw new HttpError(404, 'asset_not_found'); return asset; }
function currentVersion(state, asset) { return state.asset_versions.find((item) => item.id === asset.current_version_id) || state.asset_versions.filter((item) => item.asset_id === asset.id).sort((a, b) => b.version - a.version)[0]; }

export const assetRoutes = [
  makeRoute('GET', '/assets', async ({ res, query }) => { const state = await readState(); const assets = query.project_id ? state.assets.filter((item) => item.project_id === query.project_id) : state.assets; return send(res, 200, assets); }),
  makeRoute('POST', '/asset-candidates/:id/confirm', confirmCandidate),
  makeRoute('POST', '/asset-candidates/:id/reject', rejectCandidate),
  makeRoute('POST', '/workspaces/:id/digests', (ctx) => createDigest({ ...ctx, send }))
];
