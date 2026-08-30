import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { postClosureFailures } from '../../scripts/lib/p10-post-closure.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function write(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, 'utf8');
}

test('P10 post-closure verification accepts pushed product descendants and freezes governance bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p10-post-closure-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p10-post-closure-remote-'));
  try {
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'config', 'user.name', 'P10 fixture');
    git(remote, 'init', '--bare');
    for (const file of ['AGENTS.md', 'docs/architecture/decision-log.md', 'docs/evidence/p10/verification.json', 'apps/api/src/clean/migrations/009.mjs']) write(root, file, `sealed:${file}\n`);
    for (const file of ['feature-catalog.json', 'feature-catalog.clean.json', 'feature-catalog.historical.json']) write(root, file, `${JSON.stringify({ features: file.includes('historical') ? [] : [{ id: 'REC-001', status: 'released', target_modules: [] }] })}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'P10 closure');
    const closure = git(root, 'rev-parse', 'HEAD');
    const runtimeTree = git(root, 'show', '-s', '--format=%T', closure);
    git(root, 'tag', '-a', 'p10-final-governance-20260829', '-m', 'P10 closure');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main', '--tags');

    write(root, 'apps/web/src/product.ts', 'export const product = true;\n');
    write(root, 'feature-catalog.json', `${JSON.stringify({ features: [{ id: 'REC-001', status: 'released', target_modules: ['apps/web/src/product.ts'] }] })}\n`);
    write(root, 'feature-catalog.clean.json', `${JSON.stringify({ features: [{ id: 'REC-001', status: 'released', target_modules: ['apps/web/src/product.ts'] }] })}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'ordinary product work');
    git(root, 'push');
    const verification = { implementation_commit: closure, runtime_tree: runtimeTree };
    assert.deepEqual(postClosureFailures({ root, verification, expectedTagCommit: closure }), []);

    write(root, 'feature-catalog.json', `${JSON.stringify({ features: [{ id: 'REC-001', status: 'verified', target_modules: ['apps/web/src/product.ts'] }] })}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'invalid Catalog promotion');
    git(root, 'push');
    assert.ok(postClosureFailures({ root, verification, expectedTagCommit: closure }).includes('catalog_status:feature-catalog.json'));

    write(root, 'docs/architecture/decision-log.md', 'changed governance\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'invalid governance rewrite');
    git(root, 'push');
    assert.ok(postClosureFailures({ root, verification, expectedTagCommit: closure }).includes('frozen_path:docs/architecture/decision-log.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});
