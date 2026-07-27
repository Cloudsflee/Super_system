import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v110-cas-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const {
    blobStoragePath,
    createAssetRecord,
    createImmutableAssetVersion,
    materializeAssetVersion,
    readCasBlob,
    safeManifestPath,
    verifyAssetVersionPayload,
    verifyCasBlob,
    writeCasBlob
  } = await import('../../apps/api/src/asset-cas.mjs');
  const { emptyState } = await import('../../apps/api/src/state.mjs');
  const casRoot = path.join(root, 'cas'),
    bytes = Buffer.from('immutable payload', 'utf8');
  const writes = await Promise.all(
    Array.from({ length: 8 }, () => writeCasBlob(bytes, { casRoot, mediaType: 'text/plain' }))
  );
  assert.equal(new Set(writes.map((item) => item.sha256)).size, 1);
  assert.equal(await fsp.readFile(path.join(casRoot, blobStoragePath(writes[0].sha256)), 'utf8'), 'immutable payload');
  assert.equal(safeManifestPath('../escape.txt'), false);
  assert.equal(safeManifestPath('C:/escape.txt'), false);
  assert.equal(safeManifestPath('safe/note.txt'), true);

  const state = emptyState(),
    asset = createAssetRecord({
      projectId: 'project-1',
      assetType: 'DecisionAsset',
      title: 'Decision',
      actorId: 'owner'
    });
  state.assets.push(asset);
  const textVersion = await createImmutableAssetVersion(state, {
    asset,
    payload: {
      payload_kind: 'text',
      media_type: 'text/plain; charset=utf-8',
      content: 'Strict runner payload.',
      files: []
    },
    casRoot
  });
  assert.equal((await verifyAssetVersionPayload(state, textVersion, { casRoot })).ok, true);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: {
      payload_kind: 'file_set',
      media_type: 'application/vnd.aiws.files+json',
      files: [
        { path: 'notes/decision.txt', media_type: 'text/plain; charset=utf-8', content: 'Use CAS.' },
        { path: 'metadata.json', media_type: 'application/json', content: '{"accepted":true}' }
      ]
    },
    casRoot
  });
  assert.equal((await verifyAssetVersionPayload(state, version, { casRoot })).ok, true);
  const mounted = await materializeAssetVersion(state, version, path.join(root, 'mount'), { casRoot });
  assert.equal(mounted.read_only, true);
  assert.equal(await fsp.readFile(path.join(mounted.root, 'notes/decision.txt'), 'utf8'), 'Use CAS.');
  const mountedAgain = await materializeAssetVersion(state, version, path.join(root, 'mount'), { casRoot });
  assert.equal(await fsp.readFile(path.join(mountedAgain.root, 'metadata.json'), 'utf8'), '{"accepted":true}');
  await fsp.chmod(path.join(mounted.root, 'notes/decision.txt'), 0o600);
  await fsp.writeFile(path.join(mounted.root, 'notes/decision.txt'), 'changed', 'utf8');
  await assert.rejects(
    () => materializeAssetVersion(state, version, path.join(root, 'mount'), { casRoot }),
    (error) => error.code === 'asset_mount_existing_file_mismatch'
  );

  const referenced = version.blob_refs.find((item) => item.role !== 'manifest');
  const blob = state.asset_blobs.find((item) => item.sha256 === referenced.sha256);
  await fsp.writeFile(path.join(casRoot, blob.storage_path), 'tampered', 'utf8');
  assert.equal((await verifyCasBlob(blob, { casRoot })).ok, false);
  await assert.rejects(
    () => readCasBlob(blob, { casRoot }),
    (error) => error.code === 'cas_blob_tampered'
  );
  assert.equal((await verifyAssetVersionPayload(state, version, { casRoot })).ok, false);
  await assert.rejects(
    () => materializeAssetVersion(state, version, path.join(root, 'tampered-mount'), { casRoot }),
    (error) => error.code === 'asset_version_integrity_failed'
  );
  console.log('V1.10 CAS immutability and tamper detection unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
