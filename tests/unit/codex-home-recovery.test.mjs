import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveIncompatibleCodexState, isCodexStateRuntimeFailure, withCodexRuntimeStateRecovery } from '../../apps/api/src/codex-home-recovery.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-codex-recovery-'));
try {
  const home = path.join(root, 'profile-one');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  for (const name of ['config.toml', 'sessions/rollout.jsonl', 'state_5.sqlite', 'state_5.sqlite-journal', 'state_5.sqlite-wal', 'logs_2.sqlite', 'unrelated.sqlite']) {
    fs.writeFileSync(path.join(home, name), name);
  }
  const archived = await archiveIncompatibleCodexState(home, { allowedRoot: root, clock: () => Date.UTC(2026, 6, 16), nonce: 'unit' });
  assert.deepEqual(archived.files, ['logs_2.sqlite', 'state_5.sqlite', 'state_5.sqlite-journal', 'state_5.sqlite-wal']);
  assert.equal(fs.existsSync(path.join(home, 'config.toml')), true);
  assert.equal(fs.existsSync(path.join(home, 'sessions', 'rollout.jsonl')), true);
  assert.equal(fs.existsSync(path.join(home, 'unrelated.sqlite')), true);
  for (const name of archived.files) assert.equal(fs.existsSync(path.join(archived.backup_dir, name)), true);
  assert.equal(await archiveIncompatibleCodexState(root, { allowedRoot: root }), null);

  const retryHome = path.join(root, 'profile-retry');
  fs.mkdirSync(retryHome);
  fs.writeFileSync(path.join(retryHome, 'state_5.sqlite'), 'old state');
  const failure = Object.assign(new Error('failed to initialize sqlite state runtime under /codex-home'), { code: 'app_server_start_failed' });
  assert.equal(isCodexStateRuntimeFailure(failure), true);
  let attempts = 0;
  const result = await withCodexRuntimeStateRecovery({ id: 'profile-retry', kind: 'docker', codex_home: retryHome }, async () => {
    attempts += 1;
    if (attempts === 1) throw failure;
    return 'recovered';
  }, { allowedRoot: root, clock: () => Date.UTC(2026, 6, 16), nonce: 'retry' });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(path.join(retryHome, 'state_5.sqlite')), false);

  const permanentHome = path.join(root, 'profile-permanent');
  fs.mkdirSync(permanentHome);
  fs.writeFileSync(path.join(permanentHome, 'state_5.sqlite'), 'old state');
  await assert.rejects(
    withCodexRuntimeStateRecovery({ id: 'profile-permanent', kind: 'docker', codex_home: permanentHome }, async () => { throw new Error(failure.message); }, { allowedRoot: root, nonce: 'permanent' }),
    (error) => error.code === 'codex_state_runtime_incompatible'
  );
  console.log('Codex home recovery unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
