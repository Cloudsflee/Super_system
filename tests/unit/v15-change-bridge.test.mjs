import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v15-change-bridge-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const batches = await import('../../apps/api/src/assist-change-batches.mjs');
  const bridge = await import('../../apps/api/src/host-bridge-service.mjs');
  const vault = await import('../../apps/api/src/vault.mjs');
  await stateApi.ensureRuntime();

  const repo = path.join(process.env.AIWS_HOME, 'workspaces', 'project-v15', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'V1.5 Test']);
  git(repo, ['config', 'user.email', 'v15@example.test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# baseline\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
  const initialHead = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  await stateApi.mutate((state) => {
    state.projects = [
      {
        id: 'project-v15',
        title: 'V1.5',
        status: 'active',
        onboarding_state: 'confirmed',
        managed_workspace_state: 'ready',
        repo_path: repo,
        settings: {}
      }
    ];
    state.assist_sessions = [
      {
        id: 'session-v15',
        version: 3,
        project_id: 'project-v15',
        scope_type: 'project',
        scope_id: 'project-v15',
        scope_status: 'active',
        archived_at: null,
        active_change_batch_id: null
      }
    ];
    state.assist_change_batches = [];
    state.assist_checkpoints = [];
    state.worktrees = [];
  });

  const created = await batches.ensureSessionChangeBatch('session-v15');
  const reused = await batches.ensureSessionChangeBatch('session-v15');
  assert.equal(reused.batch.id, created.batch.id, 'one open batch per session');
  assert.equal(created.batch.base_commit, initialHead);
  const release = await batches.acquireBatchWriteLock(created.batch.id, { kind: 'assist_turn', id: 'turn-one' });
  await assert.rejects(
    () => batches.acquireBatchWriteLock(created.batch.id, { kind: 'linux_cli', id: 'terminal-one' }),
    (error) => error.status === 423 && error.payload?.error === 'assist_change_batch_locked'
  );
  await release();
  assert.equal((await stateApi.readState()).assist_change_batches[0].write_lock, null);

  await batches.createBatchCheckpoint(created.batch.id, {
    source: 'assist_turn',
    sourceId: 'turn-one',
    phase: 'before'
  });
  fs.writeFileSync(path.join(created.worktree.path, 'README.md'), '# accumulated change\n');
  const after = await batches.createBatchCheckpoint(created.batch.id, {
    source: 'assist_turn',
    sourceId: 'turn-one',
    phase: 'after'
  });
  assert.notEqual(after.before_commit, after.after_commit);
  const review = await batches.getChangeBatchReview(created.batch.id);
  assert.equal(
    review.changed_files.some((item) => item.path === 'README.md'),
    true
  );
  assert.match(review.diff, /accumulated change/);
  assert.equal(review.checkpoints.length, 2);
  const rolledBack = await batches.rollbackChangeBatch(created.batch.id, review.target_hash);
  assert.equal(rolledBack.batch.status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# baseline\n');
  assert.equal((await batches.rollbackChangeBatch(created.batch.id, review.target_hash)).idempotent, true);

  const applyBatch = await batches.ensureSessionChangeBatch('session-v15');
  assert.notEqual(applyBatch.batch.id, created.batch.id);
  fs.writeFileSync(path.join(applyBatch.worktree.path, 'APPLIED.txt'), 'applied through cumulative review\n');
  await batches.createBatchCheckpoint(applyBatch.batch.id, {
    source: 'linux_cli',
    sourceId: 'terminal-two',
    phase: 'after'
  });
  const applyReview = await batches.getChangeBatchReview(applyBatch.batch.id);
  const applied = await batches.applyChangeBatch(applyBatch.batch.id, applyReview.target_hash);
  assert.equal(applied.batch.status, 'applied');
  assert.equal(
    normalize(fs.readFileSync(path.join(repo, 'APPLIED.txt'), 'utf8')),
    'applied through cumulative review\n'
  );
  assert.equal(
    git(repo, ['status', '--porcelain=v1']).stdout.trim(),
    '',
    'Apply commits project atomically for the next batch'
  );
  assert.equal(git(repo, ['rev-parse', 'HEAD']).stdout.trim(), applied.project_commit);
  assert.equal((await batches.applyChangeBatch(applyBatch.batch.id, applyReview.target_hash)).idempotent, true);
  const nextBatch = await batches.ensureSessionChangeBatch('session-v15');
  assert.equal(nextBatch.batch.base_commit, applied.project_commit);
  await batches.rollbackChangeBatch(nextBatch.batch.id);

  assert.equal(bridge.isHostBridgeLocalRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:4317' }), true);
  assert.equal(
    bridge.isHostBridgeLocalRequest({ remoteAddress: '172.18.0.1', host: '127.0.0.1:4317' }, { containerized: true }),
    true
  );
  assert.equal(
    bridge.isHostBridgeLocalRequest(
      { remoteAddress: '172.18.0.1', host: 'evil.example:4317' },
      { containerized: true }
    ),
    false
  );
  assert.equal(
    bridge.isHostBridgeLocalRequest({ remoteAddress: '203.0.113.5', host: '127.0.0.1:4317' }, { containerized: true }),
    false
  );
  const pairing = bridge.createHostBridgePairing();
  assert.match(pairing.pairing_code, /^\d{12}$/);
  const exchanged = await bridge.exchangeHostBridgePairing({
    action: 'exchange',
    pairing_code: pairing.pairing_code,
    device_name: 'Unit Windows',
    protocol_version: bridge.HOST_BRIDGE_PROTOCOL_VERSION,
    bridge_version: '1.5.0'
  });
  assert.ok(exchanged.credential.length >= 40);
  const pairedState = await stateApi.readState(),
    device = pairedState.host_bridge_devices.find((item) => item.id === exchanged.device.id);
  assert.ok(device.vault_ref.startsWith('vault:'));
  assert.equal(await vault.readSecret(device.vault_ref), exchanged.credential);
  assert.equal(
    JSON.stringify(pairedState).includes(exchanged.credential),
    false,
    'long-lived credential never enters state'
  );
  assert.equal((await bridge.hostBridgeCapability()).reason, 'windows_bridge_offline');
  await bridge.revokeHostBridgeDevice(device.id);
  assert.equal(await vault.readSecret(device.vault_ref), '');

  const bundleRepo = path.join(root, 'bundle-repo');
  fs.mkdirSync(bundleRepo);
  git(bundleRepo, ['init']);
  git(bundleRepo, ['config', 'user.name', 'Bridge Test']);
  git(bundleRepo, ['config', 'user.email', 'bridge@example.test']);
  fs.writeFileSync(path.join(bundleRepo, 'safe.txt'), 'safe\n');
  git(bundleRepo, ['add', '.']);
  git(bundleRepo, ['commit', '-m', 'safe']);
  git(bundleRepo, ['branch', '-M', 'aiws']);
  const base = git(bundleRepo, ['rev-parse', 'HEAD']).stdout.trim(),
    validBundle = path.join(root, 'valid.bundle');
  git(bundleRepo, ['bundle', 'create', validBundle, 'refs/heads/aiws']);
  const verified = await bridge.validateHostBridgeBundle({
    bundlePath: validBundle,
    repositoryPath: bundleRepo,
    expectedBase: base
  });
  assert.equal(verified.ok, true);
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);
  const emptyBundle = path.join(root, 'empty.bundle');
  fs.writeFileSync(emptyBundle, '');
  await assert.rejects(
    () => bridge.validateHostBridgeBundle({ bundlePath: emptyBundle, repositoryPath: bundleRepo }),
    (error) => error.status === 413
  );

  const blob = git(bundleRepo, ['hash-object', '-w', '--stdin'], { input: 'outside-target' }).stdout.trim();
  git(bundleRepo, ['update-index', '--add', '--cacheinfo', `120000,${blob},escape-link`]);
  git(bundleRepo, ['commit', '-m', 'malicious symlink']);
  const maliciousBundle = path.join(root, 'symlink.bundle');
  git(bundleRepo, ['bundle', 'create', maliciousBundle, 'refs/heads/aiws']);
  await assert.rejects(
    () =>
      bridge.validateHostBridgeBundle({ bundlePath: maliciousBundle, repositoryPath: bundleRepo, expectedBase: base }),
    (error) => error.payload?.error === 'host_bridge_bundle_symlink_rejected'
  );

  const dpapi = fs.readFileSync(path.resolve('bridge/dpapi_windows.go'), 'utf8');
  assert.match(dpapi, /CryptProtectData/);
  assert.match(dpapi, /CryptUnprotectData/);
  assert.match(dpapi, /DPAPI is bound to Windows CurrentUser/);
  console.log('V1.5 change batch and Host Bridge unit tests passed');
} finally {
  await import('../../apps/api/src/state.mjs').then((state) => state.checkpointAndCloseState()).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error?.message}`);
  return result;
}
function normalize(value) {
  return value.replaceAll('\r\n', '\n');
}
