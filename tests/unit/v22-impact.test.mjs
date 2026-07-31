import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { collectImpactRange } from '../../scripts/impact-range.mjs';
import { buildGateIdentity, gateReceiptCacheAllowed } from '../../scripts/gate-receipt-v22.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v22-impact-'));
try {
  git(['init']);
  git(['config', 'user.email', 'v22-impact@aiws.test']);
  git(['config', 'user.name', 'AIWS V2.2 Impact']);
  fs.writeFileSync(path.join(root, '删除前.txt'), 'first\n');
  fs.writeFileSync(path.join(root, 'rename-me.txt'), 'rename\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  fs.rmSync(path.join(root, '删除前.txt'));
  fs.renameSync(path.join(root, 'rename-me.txt'), path.join(root, '重命名后.txt'));
  fs.writeFileSync(path.join(root, '新增.txt'), 'new\n');
  git(['add', '-A']);
  git(['commit', '-m', 'head']);
  const head = git(['rev-parse', 'HEAD']),
    impact = collectImpactRange({ base, head, cwd: root });
  assert.equal(impact.mode, 'committed-range');
  assert.equal(impact.base_sha, base);
  assert.equal(impact.head_sha, head);
  assert.ok(impact.files.includes('删除前.txt'));
  assert.ok(impact.files.includes('rename-me.txt'));
  assert.ok(impact.files.includes('重命名后.txt'));
  assert.ok(impact.files.includes('新增.txt'));
  assert.throws(
    () => collectImpactRange({ base: '0'.repeat(40), head, cwd: root }),
    (error) => error.code === 'impact_base_not_found'
  );

  const fixture = {
      clean_head_tree: true,
      base_sha: base,
      head_sha: head,
      tree_sha: 'a'.repeat(40),
      lockfile_sha256: 'b'.repeat(64),
      node_version: process.version,
      pnpm_version: '10.14.0',
      os_fingerprint: 'test:x64',
      catalog_sha256: 'c'.repeat(64),
      policy_sha256: 'd'.repeat(64),
      environment_fingerprint: 'e'.repeat(64)
    },
    identity = buildGateIdentity(fixture);
  assert.notEqual(identity.fingerprint, buildGateIdentity({ ...fixture, base_sha: 'f'.repeat(40) }).fingerprint);
  assert.equal(gateReceiptCacheAllowed({ env: { CI: '1' } }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ mode: 'release', env: {} }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ externalEffects: 'docker', env: {} }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ externalEffects: 'live', env: {} }).allowed, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.2 committed base/head impact and cache identity tests passed');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return String(result.stdout || '')
    .trim()
    .toLowerCase();
}
