import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createGitBundle, validateRepositoryTree, verifyGitBundle } from '../../apps/api/src/terminal-bundle.mjs';
import { initializeFixture } from '../../apps/api/src/git-fixture.mjs';

const execFileAsync = promisify(execFile);

test('Git bundle creation records a verified ref, SHA and bounded output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-terminal-bundle-'));
  try {
    const baseline = await initializeFixture(root);
    const output = path.join(root, 'outputs', 'repository.bundle');
    const bundle = await createGitBundle({ repositoryRoot: root, outputPath: output, ref: 'HEAD' });
    assert.equal(bundle.path, output);
    assert.equal(bundle.head_sha, baseline);
    assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
    assert.equal(bundle.media_type, 'application/x-git-bundle');
    assert.equal(bundle.verified, true);
    assert.ok(bundle.size_bytes > 0);
    const verified = await verifyGitBundle(output, { sha256: bundle.sha256, ref: 'HEAD', head_sha: baseline });
    assert.deepEqual(verified.sha256, bundle.sha256);
    assert.equal(verified.size_bytes, bundle.size_bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository validation rejects symlinks and case-colliding entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-terminal-tree-'));
  try {
    await initializeFixture(root);
    let symlinkCreated = false;
    try {
      fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link.md'), 'file');
      symlinkCreated = true;
    } catch (error) {
      assert.match(String(error?.code || ''), /EPERM|EACCES|UNKNOWN/);
    }
    if (symlinkCreated) {
      await assert.rejects(() => validateRepositoryTree(root), (error) => error.code === 'bundle_symlink_not_allowed');
      fs.rmSync(path.join(root, 'link.md'), { force: true });
    }
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.join(root, 'CaseDir'));
      fs.writeFileSync(path.join(root, 'CaseDir', 'one.txt'), 'one\n');
      fs.mkdirSync(path.join(root, 'casedir'));
      fs.writeFileSync(path.join(root, 'casedir', 'two.txt'), 'two\n');
      await assert.rejects(() => validateRepositoryTree(root), (error) => error.code === 'bundle_case_collision');
      fs.rmSync(path.join(root, 'CaseDir'), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'casedir'), { recursive: true, force: true });
    }
    const report = await validateRepositoryTree(root);
    assert.equal(report.case_collisions.length, 0);
    assert.ok(report.files.includes('README.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository validation rejects a tracked submodule entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-terminal-submodule-'));
  try {
    const baseline = await initializeFixture(root);
    await execFileAsync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${baseline},vendor/module`], { windowsHide: true });
    await assert.rejects(() => validateRepositoryTree(root), (error) => error.code === 'bundle_submodule_not_allowed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundle verification detects content tampering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-terminal-tamper-'));
  try {
    await initializeFixture(root);
    const output = path.join(root, 'repository.bundle');
    const bundle = await createGitBundle(root, output);
    const bytes = fs.readFileSync(output);
    fs.writeFileSync(output, Buffer.concat([bytes, Buffer.from('tamper')]));
    await assert.rejects(() => verifyGitBundle(output, { sha256: bundle.sha256 }), (error) => error.code === 'bundle_hash_mismatch' || error.code === 'bundle_verify_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
