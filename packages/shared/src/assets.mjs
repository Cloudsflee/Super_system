import { AssetStatus } from './enums.mjs';
import { id, now, pick } from './utils.mjs';

export function makeAssetFromCandidate(candidate, { projectId, workspaceId, nodeId, runId, actorId, status = AssetStatus.Candidate }) {
  const assetId = id('ast'), versionId = id('av'), created = now();
  return {
    asset: {
      id: assetId, project_id: projectId, workspace_id: workspaceId, node_id: nodeId, run_id: runId,
      asset_type: candidate.asset_type || 'DecisionAsset', title: candidate.title || '未命名资产候选', summary: candidate.summary || '',
      status, scope: 'project', evidence_refs: candidate.evidence_refs || [`node_run:${runId}`], tags: candidate.tags || [],
      current_version_id: versionId, created_by_user_id: actorId, confirmed_by_user_id: status === AssetStatus.Confirmed ? actorId : null,
      created_at: created, updated_at: created
    },
    version: {
      id: versionId, asset_id: assetId, version: 1, title: candidate.title || '未命名资产候选',
      summary: candidate.summary || '', body: candidate.body || candidate.summary || '',
      evidence_refs: candidate.evidence_refs || [`node_run:${runId}`], confirmed_by_user_id: status === AssetStatus.Confirmed ? actorId : null,
      created_at: created
    }
  };
}

export function confirmAsset(asset, version, actorId, patch = {}) {
  if (!Array.isArray(asset.evidence_refs) || asset.evidence_refs.length === 0) throw new Error('confirmed Asset 必须有 evidence_refs');
  const next = { ...asset, ...pick(patch, ['title', 'summary', 'tags']), status: AssetStatus.Confirmed, confirmed_by_user_id: actorId, updated_at: now() };
  const newVersion = { ...version, id: id('av'), asset_id: asset.id, version: Number(version.version || 1) + 1, title: next.title, summary: next.summary, body: patch.body || version.body || next.summary, evidence_refs: next.evidence_refs, confirmed_by_user_id: actorId, created_at: now() };
  next.current_version_id = newVersion.id;
  return { asset: next, version: newVersion };
}

export function buildDigest({ state, project, workspace, actorId, summaryPatch = {} }) {
  const previous = state.digests.filter((item) => item.workspace_id === workspace.id).sort((a, b) => a.version - b.version).at(-1);
  const assets = state.assets.filter((item) => (item.workspace_id === workspace.id || item.project_id === project.id) && item.status === AssetStatus.Confirmed);
  const runs = state.node_runs.filter((item) => item.workspace_id === workspace.id || item.project_id === project.id).slice(-5);
  const version = (previous?.version || 0) + 1;
  const summary = summaryPatch.summary || `Digest v${version}: 已确认 ${assets.length} 个资产，最近 ${runs.length} 次 NodeRun 可追溯。`;
  const body = [summary, '', '## Confirmed Assets', ...assets.slice(-8).map((item) => `- ${item.title}: ${item.summary}`), '', '## Recent Runs', ...runs.map((item) => `- ${item.id}: ${item.status} · ${item.summary || ''}`), '', '## Open Questions', ...((summaryPatch.open_questions || workspace.open_questions || []).map((item) => `- ${item}`))].join('\n');
  return { id: id('dig'), project_id: project.id, workspace_id: workspace.id, version, status: 'confirmed', summary, body, evidence_refs: [...assets.slice(-8).map((item) => `asset:${item.id}`), ...runs.map((item) => `node_run:${item.id}`)], previous_digest_id: previous?.id || null, confirmed_by_user_id: actorId, created_at: now(), updated_at: now() };
}
