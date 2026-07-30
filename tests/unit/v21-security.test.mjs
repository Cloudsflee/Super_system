import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveCasPath, writeCasBlob } from '../../apps/api/src/asset-cas.mjs';
import { assertProjectRun } from '../../apps/api/src/project-governance-v19.mjs';
import { runnerPreflightInState } from '../../apps/api/src/runner-preflight.mjs';
import { emptyState } from '../../apps/api/src/state.mjs';
import {
  DEFAULT_PRE_PUSH_GATES,
  buildGateIdentity,
  collectCurrentGateIdentity,
  environmentFingerprint,
  gateReceiptCacheAllowed,
  gateReceiptPath,
  readGateReceiptForIdentity,
  writeGateReceiptForIdentity
} from '../../scripts/gate-receipt-v21.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v21-security-'));
const sentinel = 'V21_PROXY_SECRET_SENTINEL';

try {
  await verifyGateReceipt();
  await verifyDirtyTreeRejection();
  await verifyCasAndProjectBoundaries();
  verifyPreflightSanitization();
  console.log('V2.1 gate receipt, secret sentinel, Project replay and CAS security tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function verifyGateReceipt() {
  const identity = identityFixture();
  assert.notEqual(
    identity.fingerprint,
    buildGateIdentity({ ...identityFixtureInput(), tree_sha: 'b'.repeat(40) }).fingerprint
  );
  assert.notEqual(
    environmentFingerprint({ HTTPS_PROXY: `http://user:${sentinel}@proxy.fixture` }),
    environmentFingerprint({ HTTPS_PROXY: 'http://proxy.fixture' })
  );

  const written = writeGateReceiptForIdentity({
    root,
    identity,
    durationMs: 1234,
    clock: () => new Date('2026-07-30T00:00:00.000Z'),
    env: {}
  });
  const serialized = await fsp.readFile(written.path, 'utf8');
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(readGateReceiptForIdentity({ root, identity, env: {} }).hit, true);
  assert.deepEqual(gateReceiptCacheAllowed({ mode: 'release', env: {} }), {
    allowed: false,
    reason: 'release_cache_forbidden'
  });
  assert.equal(gateReceiptCacheAllowed({ externalEffects: 'docker' }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ externalEffects: 'live' }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ env: { AIWS_GATE_CACHE_DISABLED: '1' } }).allowed, false);

  const file = gateReceiptPath(root, identity.fingerprint),
    forged = JSON.parse(await fsp.readFile(file, 'utf8'));
  forged.duration_ms = 1;
  await fsp.writeFile(file, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
  assert.equal(readGateReceiptForIdentity({ root, identity, env: {} }).reason, 'receipt_integrity_mismatch');
}

async function verifyDirtyTreeRejection() {
  const repository = path.join(root, 'clean-repository');
  fs.mkdirSync(repository, { recursive: true });
  for (const file of identityFiles()) {
    const target = path.join(repository, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      file === 'package.json'
        ? `${JSON.stringify({ name: 'gate-fixture', private: true, packageManager: 'pnpm@10.14.0' }, null, 2)}\n`
        : `${file}\n`,
      'utf8'
    );
  }
  git(repository, ['init']);
  git(repository, ['config', 'user.email', 'v21-fixture@aiws.test']);
  git(repository, ['config', 'user.name', 'AIWS V2.1 Fixture']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'fixture']);
  assert.equal(collectCurrentGateIdentity(repository, {}).clean_head_tree, true);
  fs.writeFileSync(path.join(repository, 'untracked.txt'), sentinel, 'utf8');
  assert.throws(
    () => collectCurrentGateIdentity(repository, {}),
    (error) => error.code === 'gate_receipt_clean_head_required'
  );
}

async function verifyCasAndProjectBoundaries() {
  const bytes = Buffer.from('trusted payload', 'utf8'),
    casRoot = path.join(root, 'cas');
  await assert.rejects(
    () => writeCasBlob(bytes, { casRoot, expectedSha256: '0'.repeat(64) }),
    (error) => error.code === 'cas_expected_hash_mismatch'
  );
  assert.throws(
    () => resolveCasPath(casRoot, '../forged-blob'),
    (error) => error.code === 'cas_path_outside_root'
  );

  const state = emptyState();
  state.users.push({ id: 'owner-a', role: 'owner' }, { id: 'collaborator-b', role: 'member' });
  state.instance_owner_user_id = 'owner-a';
  state.projects.push(
    { id: 'project-a', owner_user_id: 'owner-a', status: 'active', deleted_at: null },
    { id: 'project-b', owner_user_id: 'owner-a', status: 'active', deleted_at: null }
  );
  state.project_memberships.push({
    id: 'membership-b',
    project_id: 'project-b',
    user_id: 'collaborator-b',
    role: 'collaborator',
    status: 'active'
  });
  assert.throws(
    () => assertProjectRun(state, 'project-a', 'collaborator-b'),
    (error) => error.payload?.error === 'project_access_denied'
  );
  assert.equal(assertProjectRun(state, 'project-b', 'collaborator-b').role, 'collaborator');
}

function verifyPreflightSanitization() {
  const state = emptyState();
  state.workflow_executions.push({ id: 'wex', executor_config: {} });
  state.task_executions.push({
    id: 'tex',
    workflow_execution_id: 'wex',
    executor: 'assist',
    input_snapshot_hash: '1'.repeat(64),
    context_snapshot: {}
  });
  state.workflow_nodes.push({ id: 'task', task_kind: 'code', title: 'Security task' });
  state.node_contracts.push({ id: 'contract', allowed_tools: [] });
  const preflight = runnerPreflightInState(state, {
    taskExecution: state.task_executions[0],
    node: state.workflow_nodes[0],
    contract: state.node_contracts[0],
    testAdapter: true,
    env: {
      HTTP_PROXY: `http://user:${sentinel}@proxy.fixture`,
      http_proxy: `http://user:${sentinel}@proxy.fixture`,
      HTTPS_PROXY: `http://user:${sentinel}@proxy.fixture`,
      https_proxy: `http://user:${sentinel}@proxy.fixture`
    }
  });
  assert.equal(JSON.stringify(preflight).includes(sentinel), false);
  assert.equal(preflight.sanitized, true);
}

function identityFixture() {
  return buildGateIdentity(identityFixtureInput());
}

function identityFixtureInput() {
  return {
    clean_head_tree: true,
    head_sha: 'a'.repeat(40),
    tree_sha: 'a'.repeat(40),
    lockfile_sha256: '1'.repeat(64),
    node_version: 'v24.0.0',
    pnpm_version: '10.14.0',
    os_fingerprint: 'fixture:x64:1',
    catalog_sha256: '2'.repeat(64),
    policy_sha256: '3'.repeat(64),
    environment_fingerprint: '4'.repeat(64)
  };
}

function identityFiles() {
  return [
    'package.json',
    'pnpm-lock.yaml',
    'tests/v21/catalog.json',
    'tests/v21/coverage-map.json',
    'tests/v21/impact-map.json',
    'tests/v21/suites.json',
    'scripts/pre-push-gate.mjs',
    'scripts/v175-runner.mjs',
    'scripts/v18-runner.mjs',
    'scripts/v20-runner.mjs',
    'scripts/v21-runner.mjs',
    'scripts/gate-receipt-v21.mjs'
  ];
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
}
