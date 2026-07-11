import assert from 'node:assert/strict';
import { inspectCodexRuntimeLive } from '../../apps/api/src/codex-runtime-status.mjs';

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

const ready = inspectCodexRuntimeLive({ commandRunner: () => ({ ok: true, stdout: 'ready\n', stderr: '', error: null }) });
assert.equal(ready.ready, true);
assert.equal(ready.docker.error_code, null);
assert.equal(ready.image.error_code, null);
assert.equal(ready.image.id, 'ready');
const inspectDenied = inspectCodexRuntimeLive({ commandRunner: (name, args) => args[0] === 'info' ? { ok: true, stdout: '29.4.1', stderr: '', error: null } : { ok: false, stdout: '', stderr: 'permission denied', error: null } });
assert.equal(inspectDenied.image.error_code, 'codex_probe_image_inspection_failed');
console.log('Codex runtime status unit tests passed');
