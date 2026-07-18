import assert from 'node:assert/strict';
import { codexImageFingerprint, inspectCodexRuntimeLive, selectedCodexRuntimeImage } from '../../apps/api/src/codex-runtime-status.mjs';

const imageInspect = (overrides = {}) => JSON.stringify([{
  Id: 'sha256:volatile-build-id', Created: '2026-07-12T00:00:00Z',
  RootFS: { Type: 'layers', Layers: ['sha256:base', 'sha256:codex'] },
  Config: { Entrypoint: ['codex'], Env: ['PATH=/usr/bin'], WorkingDir: '/workspace' },
  Metadata: { LastTagTime: '2026-07-12T00:00:00Z' }, ...overrides
}]);

assert.equal(selectedCodexRuntimeImage({ codex_profiles: [{ image: 'fallback:one', status: 'validated' }, { image: 'active:two', is_active: true }] }), 'active:two');
assert.equal(selectedCodexRuntimeImage({ codex_profiles: [{ config: { image: 'configured:one' }, status: 'validated' }] }), 'configured:one');
assert.equal(selectedCodexRuntimeImage({ codex_profiles: [] }), undefined);

const stopped = inspectCodexRuntimeLive({ commandRunner: () => ({ ok: false, status: 1, stdout: '', stderr: 'daemon unavailable', error: null }) });
assert.equal(stopped.ready, false);
assert.equal(stopped.docker.error_code, 'codex_probe_docker_unavailable');
assert.equal(stopped.image.error_code, 'codex_probe_docker_unavailable');

const calls = [];
const missingImage = inspectCodexRuntimeLive({ commandRunner: (name, args) => {
  calls.push([name, args]);
  return args[0] === 'info' ? { ok: true, stdout: '29.4.1\n', stderr: '', error: null } : { ok: false, stdout: '', stderr: 'No such image', error: null };
} });
assert.equal(missingImage.docker.version, '29.4.1');
assert.equal(missingImage.image.error_code, 'codex_probe_image_missing');
assert.equal(calls.length, 2);

const ready = inspectCodexRuntimeLive({ commandRunner: (_name, args) => ({ ok: true, stdout: args[0] === 'info' ? '29.4.1\n' : imageInspect(), stderr: '', error: null }) });
assert.equal(ready.ready, true);
assert.equal(ready.docker.error_code, null);
assert.equal(ready.image.error_code, null);
assert.match(ready.image.id, /^sha256:[a-f0-9]{64}$/);
const rebuilt = imageInspect({ Id: 'sha256:different-build-id', Created: '2026-07-13T00:00:00Z', Metadata: { LastTagTime: '2026-07-13T00:00:00Z' } });
assert.equal(codexImageFingerprint(imageInspect()), codexImageFingerprint(rebuilt));
assert.notEqual(codexImageFingerprint(imageInspect()), codexImageFingerprint(imageInspect({ RootFS: { Type: 'layers', Layers: ['sha256:base', 'sha256:changed'] } })));
assert.notEqual(codexImageFingerprint(imageInspect()), codexImageFingerprint(imageInspect({ Config: { Entrypoint: ['codex', 'changed'], Env: ['PATH=/usr/bin'], WorkingDir: '/workspace' } })));
assert.equal(codexImageFingerprint('not-json'), null);
const malformed = inspectCodexRuntimeLive({ commandRunner: (_name, args) => ({ ok: true, stdout: args[0] === 'info' ? '29.4.1' : '{}', stderr: '', error: null }) });
assert.equal(malformed.ready, false);
assert.equal(malformed.image.error_code, 'codex_probe_image_inspection_failed');
const inspectDenied = inspectCodexRuntimeLive({ commandRunner: (name, args) => args[0] === 'info' ? { ok: true, stdout: '29.4.1', stderr: '', error: null } : { ok: false, stdout: '', stderr: 'permission denied', error: null } });
assert.equal(inspectDenied.image.error_code, 'codex_probe_image_inspection_failed');
console.log('Codex runtime status unit tests passed');
