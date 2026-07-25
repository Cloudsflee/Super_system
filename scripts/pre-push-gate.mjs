import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const manual = process.argv.includes('--all');
const updates = manual ? [] : parseUpdates(fs.readFileSync(0, 'utf8'));
const mainUpdate = updates.find((item) => item.remoteRef === 'refs/heads/main');

if (!manual && !mainUpdate) {
  console.log('[pre-push] No main branch update; release gates skipped.');
  process.exit(0);
}
if (mainUpdate && isZeroSha(mainUpdate.localSha)) fail('refusing to delete the remote main branch');

const root = git(['rev-parse', '--show-toplevel']);
process.chdir(root);
const head = git(['rev-parse', 'HEAD']);
if (mainUpdate && mainUpdate.localSha !== head)
  fail(`main update ${mainUpdate.localSha} is not the checked-out HEAD ${head}`);
const changes = git(['status', '--porcelain']);
if (changes) fail(`working tree must be clean so tests match the pushed commit:\n${changes}`);

const baseSha = resolveBase(mainUpdate, head);
console.log(`[pre-push] Verifying ${head.slice(0, 12)} against ${baseSha.slice(0, 12)}.`);
for (const script of ['test:v175:pr', 'test:v18:pr', 'test:v20:pr']) {
  console.log(`\n[pre-push] ${script}`);
  const result = runPnpm(script, { ...process.env, AIWS_TEST_BASE_SHA: baseSha });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${script} failed with exit code ${result.status ?? 'unknown'}`);
}
console.log('\n[pre-push] Historical compatibility and V2.0 gates passed.');

function resolveBase(update, headSha) {
  if (process.env.AIWS_TEST_BASE_SHA && !isZeroSha(process.env.AIWS_TEST_BASE_SHA))
    return process.env.AIWS_TEST_BASE_SHA;
  if (update && !isZeroSha(update.remoteSha)) return update.remoteSha;
  const originMain = git(['rev-parse', '--verify', 'origin/main'], false);
  if (originMain) return originMain;
  return git(['rev-parse', `${headSha}^`]);
}

function parseUpdates(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

function git(args, required = true) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) fail(result.error.message);
  if (required && result.status !== 0) fail((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function runPnpm(script, env) {
  if (process.platform !== 'win32') return spawnSync('corepack', ['pnpm', script], { stdio: 'inherit', env });
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `corepack pnpm ${script}`], {
    stdio: 'inherit',
    env,
    windowsHide: true
  });
}

function isZeroSha(value) {
  return /^0+$/.test(String(value || ''));
}
function fail(message) {
  console.error(`\n[pre-push] ${message}`);
  process.exit(1);
}
