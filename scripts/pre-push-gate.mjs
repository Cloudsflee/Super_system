import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_PRE_PUSH_GATES,
  collectCurrentGateIdentity,
  readGateReceiptForIdentity,
  writeGateReceiptForIdentity
} from './gate-receipt-v22.mjs';

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
const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
if (mainUpdate && mainUpdate.localSha !== head)
  fail(`main update ${mainUpdate.localSha} is not the checked-out HEAD ${head}`);
const changes = git(['status', '--porcelain']);
if (changes) fail(`working tree must be clean so tests match the pushed commit:\n${changes}`);

const baseSha = git(['rev-parse', '--verify', `${resolveBase(mainUpdate, head)}^{commit}`]);
const gateEnv = { ...process.env, AIWS_TEST_BASE_SHA: baseSha, AIWS_TEST_HEAD_SHA: head };
console.log(`[pre-push] Verifying ${head.slice(0, 12)} against ${baseSha.slice(0, 12)}.`);
const identity = collectCurrentGateIdentity(root, gateEnv),
  cached = readGateReceiptForIdentity({ root, identity, requiredGates: DEFAULT_PRE_PUSH_GATES, env: gateEnv });
if (cached.hit) {
  console.log(
    `[pre-push] Exact gate receipt hit ${cached.receipt.fingerprint.slice(0, 12)} ` +
      `(original ${cached.receipt.duration_ms}ms, lookup within 60s budget).`
  );
  process.exit(0);
}
console.log(`[pre-push] Gate receipt miss: ${cached.reason}.`);
const gateStarted = Date.now();
for (const script of DEFAULT_PRE_PUSH_GATES) {
  console.log(`\n[pre-push] ${script}`);
  const result = runPnpm(script, gateEnv);
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${script} failed with exit code ${result.status ?? 'unknown'}`);
}
const receipt = writeGateReceiptForIdentity({
  root,
  identity,
  coveredGates: DEFAULT_PRE_PUSH_GATES,
  durationMs: Date.now() - gateStarted,
  env: gateEnv
});
console.log(
  `\n[pre-push] Historical compatibility and V2.2 gates passed; receipt ${receipt.fingerprint.slice(0, 12)}.`
);

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
