import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { sha256 } from './crypto.mjs';

const execFileAsync = promisify(execFile);

export const DIFF_MAX_BYTES = 20 * 1024 * 1024;

export class DiffCaptureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DiffCaptureError';
    this.code = code;
    this.details = details;
  }
}

export const FIXTURES = Object.freeze({
  'designsignal-v1': Object.freeze({
    files: {
      'README.md': '# DesignSignal fixture\n\nDeterministic AIWS execution fixture.\n',
      'package.json': '{\n  "name": "designsignal-fixture",\n  "private": true,\n  "scripts": {"test": "node --test"}\n}\n',
      'src/signal.mjs': 'export const signal = "baseline";\n',
      'test/signal.test.mjs': 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { signal } from "../src/signal.mjs";\n\ntest("signal is exported", () => assert.equal(typeof signal, "string"));\n'
    },
    commit: 'AIWS fixture baseline designsignal-v1'
  })
});

const RUNNER_UID = 10001;
const RUNNER_GID = 10001;

function gitDirectoryArgs(directory) {
  const resolved = path.resolve(directory);
  return ['-c', `safe.directory=${resolved}`, '-C', resolved];
}

function grantRunnerAccess(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  const visit = (current) => {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) return;
    try { fs.chownSync(current, RUNNER_UID, RUNNER_GID); } catch { /* Windows and rootless hosts may not expose chown. */ }
    try { fs.chmodSync(current, stat.isDirectory() ? 0o770 : 0o660); } catch { /* Keep the host filesystem's mode when chmod is unavailable. */ }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
    }
  };
  visit(directory);
}

function assertNoSymlinkComponents(root, target, code) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(code);
  let current = base;
  const components = [base];
  for (const segment of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    components.push(current);
  }
  for (const component of components) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) throw new Error(code);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function git(directory, args) {
  const { stdout } = await execFileAsync('git', [...gitDirectoryArgs(directory), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024
  });
  return stdout.trim();
}

export async function ensureExecutionExcludes(directory) {
  const { stdout } = await execFileAsync('git', [...gitDirectoryArgs(directory), 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const excludePath = path.resolve(directory, stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true, mode: 0o770 });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const missing = ['worktrees/', 'outputs/'].filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length) fs.appendFileSync(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}# AIWS execution directories\n${missing.join('\n')}\n`, { encoding: 'utf8', mode: 0o660 });
}

export async function gitHead(directory) {
  try { return await git(directory, ['rev-parse', 'HEAD']); } catch { return ''; }
}

export async function gitStatus(directory) {
  try { return await git(directory, ['status', '--porcelain', '--untracked-files=all']); } catch { return ''; }
}

export async function initializeFixture(directory, fixtureId = 'designsignal-v1') {
  const fixture = FIXTURES[fixtureId];
  if (!fixture) throw new Error(`unknown_fixture:${fixtureId}`);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('fixture_symlink_not_allowed');
  fs.mkdirSync(directory, { recursive: true, mode: 0o770 });
  const marker = path.join(directory, '.aiws-fixture');
  if (!fs.existsSync(path.join(directory, '.git'))) {
    const existing = fs.readdirSync(directory).filter((entry) => entry !== '.git');
    if (existing.length) throw new Error('fixture_directory_not_empty');
    await execFileAsync('git', ['init', directory], { windowsHide: true });
    await git(directory, ['config', 'user.email', 'aiws-fixture@example.invalid']);
    await git(directory, ['config', 'user.name', 'AIWS Fixture']);
    for (const [relative, content] of Object.entries(fixture.files)) {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o770 });
      fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o660 });
    }
    fs.writeFileSync(marker, `${fixtureId}\n`, { encoding: 'utf8', mode: 0o660 });
    await git(directory, ['add', '.']);
    await execFileAsync('git', [...gitDirectoryArgs(directory), 'commit', '-m', fixture.commit, '--no-gpg-sign'], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' }
    });
  }
  const markerValue = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (markerValue !== fixtureId) throw new Error('fixture_marker_mismatch');
  if (await gitStatus(directory)) throw new Error('fixture_baseline_dirty');
  const tracked = (await git(directory, ['ls-files'])).split(/\r?\n/).filter(Boolean).sort();
  const expected = [...Object.keys(fixture.files), '.aiws-fixture'].sort();
  if (JSON.stringify(tracked) !== JSON.stringify(expected)) throw new Error('fixture_contents_mismatch');
  for (const [relative, content] of Object.entries(fixture.files)) {
    const target = path.join(directory, relative);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.readFileSync(target, 'utf8') !== content) throw new Error('fixture_contents_mismatch');
  }
  return gitHead(directory);
}

export async function createWorktree(directory, worktreeDirectory, baselineSha, options = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(baselineSha || ''))) throw new Error('invalid_baseline_sha');
  const repositoryRoot = path.resolve(directory);
  const targetRoot = path.resolve(worktreeDirectory);
  if (repositoryRoot === targetRoot) throw new Error('worktree_must_be_distinct');
  if (!targetRoot.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('worktree_outside_repository');
  assertNoSymlinkComponents(repositoryRoot, path.dirname(targetRoot), 'worktree_symlink_not_allowed');
  assertNoSymlinkComponents(repositoryRoot, targetRoot, 'worktree_symlink_not_allowed');
  fs.mkdirSync(path.dirname(worktreeDirectory), { recursive: true, mode: 0o770 });
  assertNoSymlinkComponents(repositoryRoot, path.dirname(targetRoot), 'worktree_symlink_not_allowed');
  if (fs.existsSync(worktreeDirectory)) {
    if (fs.lstatSync(worktreeDirectory).isSymbolicLink()) throw new Error('worktree_symlink_not_allowed');
    const head = await gitHead(worktreeDirectory);
    const status = await gitStatus(worktreeDirectory);
    if (head === baselineSha && (options.preserveChanges === true || !status)) {
      grantRunnerAccess(worktreeDirectory);
      return worktreeDirectory;
    }
    if (options.preserveChanges === true) throw new Error('worktree_baseline_changed');
    await git(directory, ['worktree', 'remove', '--force', worktreeDirectory]).catch(() => undefined);
    fs.rmSync(worktreeDirectory, { recursive: true, force: true });
  }
  await execFileAsync('git', ['-c', `safe.directory=${repositoryRoot}`, 'clone', '--no-hardlinks', '--no-checkout', repositoryRoot, worktreeDirectory], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  });
  assertNoSymlinkComponents(repositoryRoot, targetRoot, 'worktree_symlink_not_allowed');
  await git(worktreeDirectory, ['checkout', '--detach', baselineSha]);
  await git(worktreeDirectory, ['remote', 'remove', 'origin']);
  grantRunnerAccess(worktreeDirectory);
  return worktreeDirectory;
}

export async function removeWorktree(directory, worktreeDirectory) {
  if (!worktreeDirectory) return;
  const repositoryRoot = path.resolve(directory);
  const targetRoot = path.resolve(worktreeDirectory);
  if (repositoryRoot === targetRoot || !targetRoot.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('worktree_outside_repository');
  assertNoSymlinkComponents(repositoryRoot, targetRoot, 'worktree_symlink_not_allowed');
  if (!fs.existsSync(worktreeDirectory)) return;
  await git(directory, ['worktree', 'remove', '--force', worktreeDirectory]).catch(() => undefined);
  fs.rmSync(worktreeDirectory, { recursive: true, force: true });
}

function runGitStream(directory, args, env, limit = DIFF_MAX_BYTES, signal = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...gitDirectoryArgs(directory), ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const chunks = [];
    const digest = createHash('sha256');
    let bytes = 0;
    let exceeded = false;
    let stderr = '';
    let settled = false;
    let aborted = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      aborted = true;
      if (!child.killed) child.kill('SIGTERM');
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= limit) { chunks.push(chunk); digest.update(chunk); }
      else exceeded = true;
      if (exceeded && !child.killed) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish(reject, new DiffCaptureError('evidence_capture_failed', 'git capture process failed', { cause: error.message })));
    child.once('close', (code, terminationSignal) => {
      if (exceeded) return finish(reject, new DiffCaptureError('evidence_diff_too_large', 'captured diff exceeds 20 MiB', { bytes, limit }));
      if (aborted) return finish(reject, new DiffCaptureError('evidence_capture_failed', 'parallel git capture cancelled'));
      if (code !== 0) return finish(reject, new DiffCaptureError('evidence_capture_failed', 'git capture failed', { exit_code: code ?? 1, signal: terminationSignal, stderr: stderr.slice(0, 240) }));
      const output = Buffer.concat(chunks);
      finish(resolve, { output, bytes: output.byteLength, sha256: digest.digest('hex') });
    });
  });
}

export async function captureDiff(worktreeDirectory, baselineSha) {
  if (worktreeDirectory && fs.existsSync(worktreeDirectory) && fs.lstatSync(worktreeDirectory).isSymbolicLink()) throw new DiffCaptureError('evidence_capture_failed', 'worktree symlink is not allowed');
  if (!worktreeDirectory || !fs.existsSync(path.join(worktreeDirectory, '.git'))) return { diff: '', files: [], sha256: sha256(''), bytes: 0 };
  const indexFile = path.join(os.tmpdir(), `aiws-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', [...gitDirectoryArgs(worktreeDirectory), 'read-tree', String(baselineSha || 'HEAD')], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 });
    await execFileAsync('git', [...gitDirectoryArgs(worktreeDirectory), 'add', '--all', '--', '.'], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 });
    const controller = new AbortController();
    const streams = [
      runGitStream(worktreeDirectory, ['-c', 'core.quotePath=false', 'diff', '--cached', '--no-ext-diff', '--binary', '--full-index'], env, DIFF_MAX_BYTES, controller.signal),
      runGitStream(worktreeDirectory, ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z'], env, DIFF_MAX_BYTES, controller.signal)
    ];
    let diffResult;
    let namesResult;
    try {
      [diffResult, namesResult] = await Promise.all(streams);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(streams);
      throw error;
    }
    const diff = diffResult.output.toString('utf8');
    const files = namesResult.output.toString('utf8').split('\0').filter(Boolean).map((value) => value.replaceAll('\\', '/'));
    return { diff, files: [...new Set(files)], sha256: diffResult.sha256, bytes: diffResult.bytes };
  } catch (error) {
    if (error instanceof DiffCaptureError) throw error;
    throw new DiffCaptureError('evidence_capture_failed', 'git capture failed', { cause: error.message });
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(`${indexFile}.lock`, { force: true }); } catch { /* best effort */ }
  }
}
