import { AssetStatus, id, now } from '../../../../packages/shared/index.mjs';
import {
  assetVersionDetails,
  assetVersionConsumers,
  attestAssetVersionInState
} from '../asset-attestation-service.mjs';
import { createImmutableAssetVersion, readCasBlob } from '../asset-cas.mjs';
import { accessibleProjectIds, actorForRequest } from '../project-governance-v19.mjs';
import { HttpError, makeRoute, send } from '../http.mjs';
import { createDigest } from '../handlers/digests.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';

export const assetRoutes = [
  makeRoute('GET', '/assets', listAssets),
  makeRoute('GET', '/assets/:id', getAsset),
  makeRoute('POST', '/assets/:id/versions', createAssetVersion),
  makeRoute('GET', '/asset-versions/:id', getAssetVersion),
  makeRoute('GET', '/asset-versions/:id/content', getAssetVersionContent),
  makeRoute('GET', '/asset-versions/:id/download', downloadAssetVersion),
  makeRoute('GET', '/asset-versions/:id/attestations', getAssetAttestations),
  makeRoute('POST', '/asset-versions/:id/attestations', createAssetAttestation),
  makeRoute('GET', '/asset-versions/:id/lineage', getAssetLineage),
  makeRoute('GET', '/asset-versions/:id/consumers', getAssetConsumers),
  makeRoute('POST', '/asset-candidates/:id/confirm', confirmCandidate),
  makeRoute('POST', '/asset-candidates/:id/reject', rejectCandidate),
  makeRoute('POST', '/workspaces/:id/digests', (ctx) => createDigest({ ...ctx, send }))
];

async function listAssets({ req, res, query }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
    allowed = accessibleProjectIds(state, actor?.id);
  const assets = state.assets
    .filter((item) => allowed.has(item.project_id) && (!query.project_id || item.project_id === query.project_id))
    .map((asset) => decorateAsset(state, asset));
  return send(res, 200, assets);
}

async function getAsset({ res, params }) {
  const state = await readState(),
    asset = findAsset(state, params.id),
    versions = state.asset_versions
      .filter((item) => item.asset_id === asset.id)
      .sort((a, b) => Number(b.version) - Number(a.version));
  return send(res, 200, {
    asset: decorateAsset(state, asset),
    versions,
    current: versions.find((item) => item.id === asset.current_version_id) || null,
    attestations: state.asset_attestations.filter((item) => item.asset_id === asset.id),
    consumers: versions.flatMap((item) => assetVersionConsumers(state, item.id))
  });
}

async function createAssetVersion({ res, params, body }) {
  const result = await mutate(async (state) => {
    const actor = owner(state),
      asset = findAsset(state, params.id);
    assertAssetProjectIdle(state, asset);
    const previous = currentVersion(state, asset);
    if (asset.task_execution_id)
      throw new HttpError(409, { error: 'execution_output_edit_forbidden', action: 'retry_task_execution' });
    const version = await createImmutableAssetVersion(state, {
      asset,
      payload: body.payload,
      title: body.title || asset.title,
      summary: body.summary ?? asset.summary,
      evidenceRefs: body.evidence_refs || [],
      repositorySha: body.repository_sha || null,
      provenance: { source: 'human_edit', previous_version_id: previous?.id || null },
      actorId: actor.id
    });
    if (previous)
      state.asset_relations.push({
        id: id('arl'),
        relation_type: 'supersedes',
        source_asset_id: asset.id,
        source_asset_version_id: previous.id,
        target_asset_id: asset.id,
        target_asset_version_id: version.id,
        execution_id: null,
        created_at: now()
      });
    return { asset, version };
  });
  return send(res, 201, result);
}

async function getAssetVersion({ res, params }) {
  const state = await readState();
  return send(res, 200, assetVersionDetails(state, params.id));
}

async function getAssetVersionContent({ res, params, query }) {
  return serveVersionContent(res, params.id, false, query.path);
}
async function downloadAssetVersion({ res, params, query }) {
  return serveVersionContent(res, params.id, true, query.path);
}
async function serveVersionContent(res, versionId, download, requestedPath = null) {
  const state = await readState(),
    details = assetVersionDetails(state, versionId),
    { version } = details;
  if (version.verification_status !== 'verified') {
    if (version.body == null) throw new HttpError(409, { error: 'asset_version_content_unavailable' });
    res.writeHead(200, {
      'content-type': version.media_type || 'text/plain; charset=utf-8',
      'content-disposition': download
        ? `attachment; filename="${safeFilename(version.title || version.id)}.txt"`
        : 'inline',
      'cache-control': 'no-store',
      etag: `"${version.content_sha256}"`
    });
    res.end(version.body);
    return;
  }
  const entry = requestedPath ? version.manifest?.entries?.find((item) => item.path === requestedPath) : null;
  if (requestedPath && !entry) throw new HttpError(404, { error: 'asset_version_entry_not_found' });
  const payloadRef = entry
    ? { sha256: entry.sha256 }
    : (version.blob_refs || []).find((item) => typeof item !== 'string' && item.role === 'payload');
  if (!payloadRef) return send(res, 200, version.manifest);
  const bytes = await readCasBlob(payloadRef.sha256, { state });
  const mediaType = entry?.media_type || version.media_type,
    filename = entry ? pathName(entry.path) : `${safeFilename(version.title || version.id)}${extensionFor(mediaType)}`;
  res.writeHead(200, {
    'content-type': mediaType,
    'content-length': bytes.length,
    'content-disposition': download ? `attachment; filename="${safeFilename(filename)}"` : 'inline',
    'cache-control': 'no-store',
    etag: `"${entry?.sha256 || version.content_sha256}"`,
    'x-content-type-options': 'nosniff'
  });
  res.end(bytes);
}

async function getAssetAttestations({ res, params }) {
  const state = await readState(),
    details = assetVersionDetails(state, params.id);
  return send(res, 200, { asset: details.asset, version: details.version, items: details.attestations });
}
async function getAssetLineage({ res, params }) {
  const state = await readState(),
    details = assetVersionDetails(state, params.id);
  return send(res, 200, details.lineage);
}
async function getAssetConsumers({ res, params }) {
  const state = await readState();
  assetVersionDetails(state, params.id);
  return send(res, 200, { items: assetVersionConsumers(state, params.id) });
}

async function createAssetAttestation({ res, params, body }) {
  if (body.attestor_type || body.output_bindings || body.acceptance_results)
    throw new HttpError(400, { error: 'client_attestation_fields_forbidden' });
  const result = await mutate(async (state) => {
    const actor = owner(state),
      version = state.asset_versions.find((item) => item.id === params.id),
      asset = state.assets.find((item) => item.id === version?.asset_id);
    if (!asset || !version) throw new HttpError(404, { error: 'asset_version_not_found' });
    assertAssetProjectIdle(state, asset);
    const attested = await attestAssetVersionInState(state, {
      assetId: asset.id,
      versionId: version.id,
      expectedSha256: body.expected_sha256,
      taskExecutionId: asset.task_execution_id || null,
      outputKey: asset.output_key || null,
      decision: body.decision || 'accepted',
      attestorType: 'human',
      attestorId: actor.id,
      summary: body.summary
    });
    addTrace(
      state,
      attested.attestation.decision === 'accepted' ? 'asset.confirmed' : 'asset.rejected',
      {
        project_id: asset.project_id,
        workspace_id: asset.workspace_id,
        node_id: asset.node_id,
        target_type: 'asset',
        target_id: asset.id,
        summary: `${attested.attestation.decision === 'accepted' ? '确认' : '拒绝'}资产版本：${asset.title}`,
        data: {
          asset_version_id: version.id,
          content_sha256: version.content_sha256,
          attestation_id: attested.attestation.id
        }
      },
      actor.id
    );
    return attested;
  });
  return send(res, result.idempotent ? 200 : 201, result);
}

async function confirmCandidate({ res, params, body }) {
  const snapshot = await readState(),
    asset = findAsset(snapshot, params.id),
    version = currentVersion(snapshot, asset);
  if (asset.status !== AssetStatus.Candidate)
    throw new HttpError(409, { error: 'asset_not_candidate', status: asset.status });
  if (!version) throw new HttpError(409, { error: 'asset_version_required' });
  if (version.verification_status !== 'verified') {
    const result = await mutate((state) => {
      const actor = owner(state),
        currentAsset = findAsset(state, params.id),
        current = currentVersion(state, currentAsset);
      if (
        currentAsset.task_execution_id ||
        state.workflows.find(
          (item) => item.id === state.workflow_nodes.find((node) => node.id === currentAsset.node_id)?.workflow_id
        )?.planning_quality === 'verified'
      )
        throw new HttpError(409, { error: 'legacy_unverified_asset_cannot_satisfy_workflow' });
      Object.assign(currentAsset, {
        status: 'confirmed',
        attestation_status: 'legacy_unverified',
        confirmed_by_user_id: actor.id,
        updated_at: now()
      });
      state.asset_attestations.push({
        id: id('aat'),
        asset_id: currentAsset.id,
        asset_version_id: current.id,
        task_execution_id: null,
        output_key: currentAsset.output_key || null,
        decision: 'accepted',
        confirmation_policy: 'human',
        attestor_type: 'human',
        attestor_id: actor.id,
        expected_sha256: current.content_sha256,
        acceptance_results: [],
        evidence: { legacy_compatibility: true },
        summary: '',
        created_at: now()
      });
      return { asset: currentAsset, version: current, legacy_unverified: true };
    });
    return send(res, 200, result);
  }
  return createAssetAttestation({
    res,
    params: { id: version.id },
    body: {
      expected_sha256: body.expected_sha256 || version.content_sha256,
      decision: 'accepted',
      summary: body.summary
    }
  });
}

async function rejectCandidate({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state),
      asset = findAsset(state, params.id);
    assertAssetProjectIdle(state, asset);
    if (asset.status !== AssetStatus.Candidate)
      throw new HttpError(409, { error: 'asset_not_candidate', status: asset.status });
    asset.status = AssetStatus.Rejected;
    asset.attestation_status = 'rejected';
    asset.updated_at = now();
    addTrace(
      state,
      'asset.rejected',
      {
        project_id: asset.project_id,
        workspace_id: asset.workspace_id,
        node_id: asset.node_id,
        run_id: asset.run_id,
        target_type: 'asset',
        target_id: asset.id,
        summary: `拒绝资产候选：${asset.title}`
      },
      actor.id
    );
    return asset;
  });
  return send(res, 200, result);
}

function decorateAsset(state, asset) {
  const version = currentVersion(state, asset);
  return {
    ...asset,
    current_version: version
      ? {
          id: version.id,
          version: version.version,
          payload_kind: version.payload_kind,
          media_type: version.media_type,
          content_sha256: version.content_sha256,
          size_bytes: version.size_bytes,
          repository_sha: version.repository_sha,
          verification_status: version.verification_status
        }
      : null,
    attestation_count: state.asset_attestations.filter((item) => item.asset_id === asset.id).length,
    consumer_count: version ? assetVersionConsumers(state, version.id).length : 0
  };
}
function findAsset(state, idValue) {
  const asset = state.assets.find((item) => item.id === idValue);
  if (!asset) throw new HttpError(404, { error: 'asset_not_found' });
  return asset;
}
function currentVersion(state, asset) {
  return (
    state.asset_versions.find((item) => item.id === asset.current_version_id) ||
    state.asset_versions
      .filter((item) => item.asset_id === asset.id)
      .sort((a, b) => Number(b.version) - Number(a.version))[0]
  );
}
function assertAssetProjectIdle(state, asset) {
  return assertProjectLifecycleIdle(state.projects.find((item) => item.id === asset.project_id));
}
function safeFilename(value) {
  return (
    String(value || 'asset')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 120) || 'asset'
  );
}
function extensionFor(mediaType) {
  if (mediaType.includes('json')) return '.json';
  if (mediaType.startsWith('text/markdown')) return '.md';
  if (mediaType.startsWith('text/')) return '.txt';
  return '.bin';
}
function pathName(value) {
  return (
    String(value || '')
      .replaceAll('\\', '/')
      .split('/')
      .pop() || 'asset.bin'
  );
}
