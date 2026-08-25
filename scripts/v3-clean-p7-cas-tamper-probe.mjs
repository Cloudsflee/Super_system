import fs from 'node:fs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';
import { close, createProject, open } from '../tests/p7/helpers.mjs';

await emitProbe('aiws.v3-clean.p7-cas-tamper-probe.v1', async () => {
  const state = await open({ config: { runtimeBuild: 'v3-clean-p7-cas-tamper-probe' } });
  try {
    const project = await createProject(state, 'cas-tamper-probe');
    const captured = await state.runtime.evidence.capture({
      project_id: project.id, logical_name: 'tamper-probe.txt', source_type: 'manual',
      source_ref: 'probe:cas-tamper', media_type: 'text/plain',
      content_base64: Buffer.from('verified CAS object').toString('base64'),
      expected_revision: 0, idempotency_key: 'p7-cas-tamper-probe-capture'
    }, state.principal);
    const version = state.runtime.db.get('SELECT * FROM asset_versions WHERE id=?', [captured.asset.current_version_id]);
    const blob = state.runtime.db.get('SELECT * FROM asset_blobs WHERE id=?', [version.blob_id]);
    const file = state.runtime.cas.fileFor(blob.cas_sha256);
    const original = fs.readFileSync(file);
    let errorCode = '';
    try {
      fs.writeFileSync(file, 'changed bytes');
      state.runtime.evidence.content(captured.asset.id, version.id, state.principal);
    } catch (error) { errorCode = String(error?.code || ''); }
    finally { fs.writeFileSync(file, original); }
    if (errorCode !== 'cas_tamper') throw Object.assign(new Error('cas_tamper_not_detected'), { code: 'cas_tamper_not_detected' });
    const restored = state.runtime.evidence.content(captured.asset.id, version.id, state.principal);
    return {
      asset_id: captured.asset.id, content_sha256: version.content_sha256,
      tamper_error_code: errorCode, restored_byte_length: restored.byte_length,
      restored_sha256_matches: blob.content_sha256 === version.content_sha256,
      public_envelope_contains_content: false
    };
  } finally { await close(state); }
});
