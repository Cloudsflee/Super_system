#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { protocolHash } from '../packages/execution-protocol/src/index.mjs';

export const GATE_RECEIPT_SCHEMA = 'aiws.gate_receipt.v3';
export const GATE_RECEIPT_VERSION = '2.3';
export const DEFAULT_PRE_PUSH_GATES = Object.freeze(['test:v23:pr', 'test:compat:pr']);

const IDENTITY_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'tests/v23/catalog.json',
  'tests/v23/coverage-map.json',
  'tests/v23/impact-map.json',
  'tests/v23/suites.json',
  'tests/v175/catalog.json',
  'tests/v175/impact-map.json',
  'tests/v175/suite-files.json',
  'tests/v18/catalog.json',
  'tests/v18/suites.json',
  'tests/v20/catalog.json',
  'tests/v20/suites.json',
  'tests/v21/catalog.json',
  'tests/v21/suites.json',
  'scripts/pre-push-gate.mjs',
  'scripts/compat-pr-runner.mjs',
  'scripts/gate-scheduler.mjs',
  'scripts/impact-range.mjs',
  'scripts/v18-contract.mjs',
  'scripts/v175-impact.mjs',
  'scripts/v175-runner.mjs',
  'scripts/v23-plan.mjs',
  'scripts/v23-catalog.mjs',
  'scripts/v23-coverage.mjs',
  'scripts/v23-impact.mjs',
  'scripts/v23-runner.mjs',
  'scripts/v23-suite.mjs',
  'scripts/gate-receipt-v23.mjs'
]);
const ENVIRONMENT_KEYS = Object.freeze([
  'AIWS_TEST_BASE_SHA',
  'AIWS_TEST_HEAD_SHA',
  'CI',
  'NODE_ENV',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
]);

export function buildGateIdentity(input) {
  const identity = {
    schema_version: 'aiws.gate_identity.v2',
    product_version: '2.3.0',
    clean_head_tree: input.clean_head_tree === true,
    base_sha: normalizeHash(input.base_sha, 40, 64),
    head_sha: normalizeHash(input.head_sha, 40, 64),
    tree_sha: normalizeHash(input.tree_sha, 40, 64),
    lockfile_sha256: normalizeHash(input.lockfile_sha256, 64, 64),
    node_version: String(input.node_version || ''),
    pnpm_version: String(input.pnpm_version || ''),
    os_fingerprint: String(input.os_fingerprint || ''),
    catalog_sha256: normalizeHash(input.catalog_sha256, 64, 64),
    policy_sha256: normalizeHash(input.policy_sha256, 64, 64),
    environment_fingerprint: normalizeHash(input.environment_fingerprint, 64, 64)
  };
  if (!identity.clean_head_tree) throw gateError('gate_receipt_clean_head_required');
  for (const [key, value] of Object.entries(identity))
    if (key !== 'clean_head_tree' && !value) throw gateError('gate_identity_field_missing', { field: key });
  return { ...identity, fingerprint: protocolHash(identity) };
}

export function environmentFingerprint(env = process.env) {
  return protocolHash(Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, fingerprintEnvironmentValue(key, env)])));
}

export function gateReceiptCacheAllowed({ mode = 'pre-push', externalEffects = 'none', env = process.env } = {}) {
  if (env.AIWS_GATE_CACHE_DISABLED === '1') return { allowed: false, reason: 'cache_disabled' };
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return { allowed: false, reason: 'ci_cache_forbidden' };
  if (mode === 'release') return { allowed: false, reason: 'release_cache_forbidden' };
  if (['docker', 'live'].includes(externalEffects))
    return { allowed: false, reason: `${externalEffects}_cache_forbidden` };
  return { allowed: true, reason: null };
}

export function gateReceiptPath(root, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) throw gateError('gate_receipt_fingerprint_invalid');
  return path.join(path.resolve(root), '.ai-workspace', 'gate-receipts', GATE_RECEIPT_VERSION, `${fingerprint}.json`);
}

export function readGateReceiptForIdentity({
  root,
  identity,
  requiredGates = DEFAULT_PRE_PUSH_GATES,
  mode = 'pre-push',
  externalEffects = 'none',
  env = process.env
}) {
  const permission = gateReceiptCacheAllowed({ mode, externalEffects, env });
  if (!permission.allowed) return { hit: false, reason: permission.reason, receipt: null };
  const file = gateReceiptPath(root, identity.fingerprint);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { hit: false, reason: 'receipt_missing', receipt: null };
  }
  if (
    receipt.schema_version !== GATE_RECEIPT_SCHEMA ||
    receipt.version !== GATE_RECEIPT_VERSION ||
    receipt.status !== 'passed' ||
    receipt.cache_reusable !== true
  )
    return { hit: false, reason: 'receipt_invalid', receipt: null };
  const { receipt_sha256: receiptSha256, ...unsignedReceipt } = receipt;
  if (receiptSha256 !== protocolHash(unsignedReceipt))
    return { hit: false, reason: 'receipt_integrity_mismatch', receipt: null };
  if (
    receipt.fingerprint !== identity.fingerprint ||
    protocolHash(receipt.identity) !== protocolHash(stripFingerprint(identity))
  )
    return { hit: false, reason: 'identity_mismatch', receipt: null };
  if (!sameSet(requiredGates, receipt.covered_gates))
    return { hit: false, reason: 'gate_coverage_mismatch', receipt: null };
  return { hit: true, reason: null, receipt: publicReceipt(receipt) };
}

export function writeGateReceiptForIdentity({
  root,
  identity,
  coveredGates = DEFAULT_PRE_PUSH_GATES,
  durationMs,
  clock = () => new Date(),
  mode = 'pre-push',
  externalEffects = 'none',
  env = process.env
}) {
  const permission = gateReceiptCacheAllowed({ mode, externalEffects, env });
  if (!permission.allowed) throw gateError(permission.reason);
  const receipt = {
    schema_version: GATE_RECEIPT_SCHEMA,
    version: GATE_RECEIPT_VERSION,
    status: 'passed',
    cache_reusable: true,
    fingerprint: identity.fingerprint,
    identity: stripFingerprint(identity),
    covered_gates: [...new Set(coveredGates)].sort(),
    duration_ms: Math.max(0, Math.floor(Number(durationMs) || 0)),
    created_at: clock().toISOString()
  };
  receipt.receipt_sha256 = protocolHash(receipt);
  const file = gateReceiptPath(root, identity.fingerprint),
    temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  return { ...publicReceipt(receipt), path: file };
}

export function collectCurrentGateIdentity(root = process.cwd(), env = process.env) {
  const cwd = path.resolve(root),
    status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.trim()) throw gateError('gate_receipt_clean_head_required');
  const fileHashes = Object.fromEntries(
      IDENTITY_FILES.map((file) => {
        const absolute = path.join(cwd, file);
        if (!fs.existsSync(absolute)) throw gateError('gate_identity_file_missing', { file });
        return [file, fileSha256(absolute)];
      })
    ),
    catalogHashes = Object.fromEntries(Object.entries(fileHashes).filter(([file]) => file.startsWith('tests/v23/'))),
    policyHashes = Object.fromEntries(
      Object.entries(fileHashes).filter(([file]) => file !== 'pnpm-lock.yaml' && !file.startsWith('tests/v23/'))
    );
  const actualHead = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
    requestedHead = env.AIWS_TEST_HEAD_SHA || actualHead,
    headSha = git(cwd, ['rev-parse', '--verify', `${requestedHead}^{commit}`]).trim(),
    baseRef = env.AIWS_TEST_BASE_SHA || `${headSha}^`,
    baseSha = git(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
  if (headSha !== actualHead) throw gateError('gate_identity_head_mismatch', { expected: actualHead, actual: headSha });
  return buildGateIdentity({
    clean_head_tree: true,
    base_sha: baseSha,
    head_sha: headSha,
    tree_sha: git(cwd, ['rev-parse', 'HEAD^{tree}']).trim(),
    lockfile_sha256: fileHashes['pnpm-lock.yaml'],
    node_version: process.version,
    pnpm_version: pnpmVersion(cwd),
    os_fingerprint: `${process.platform}:${process.arch}:${os.release()}`,
    catalog_sha256: protocolHash(catalogHashes),
    policy_sha256: protocolHash(policyHashes),
    environment_fingerprint: environmentFingerprint(env)
  });
}

function pnpmVersion(cwd) {
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'corepack pnpm --version'], {
          cwd,
          encoding: 'utf8',
          windowsHide: true
        })
      : spawnSync('corepack', ['pnpm', '--version'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw gateError('gate_identity_pnpm_version_failed');
  return String(result.stdout || '').trim();
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw gateError('gate_identity_git_failed', { args });
  return String(result.stdout || '');
}

function stripFingerprint(identity) {
  const { fingerprint, ...value } = identity;
  return value;
}
function publicReceipt(receipt) {
  return {
    schema_version: receipt.schema_version,
    version: receipt.version,
    status: receipt.status,
    fingerprint: receipt.fingerprint,
    covered_gates: receipt.covered_gates,
    duration_ms: receipt.duration_ms,
    created_at: receipt.created_at,
    cache_hit: true
  };
}
function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function fingerprintEnvironmentValue(key, env) {
  let value;
  if (key === 'HOME' || key === 'USERPROFILE') {
    const home = environmentEntry(env, 'HOME'),
      profile = environmentEntry(env, 'USERPROFILE');
    if (!home.present && !profile.present) return null;
    value = home.value || profile.value;
  } else {
    const entry = environmentEntry(env, key);
    if (!entry.present) return null;
    value = entry.value;
  }
  const normalized = ['HOME', 'USERPROFILE', 'COMSPEC'].includes(key)
    ? normalizeEnvironmentPath(value)
    : String(value ?? '');
  return sha256(normalized);
}
function environmentEntry(env, key) {
  if (Object.hasOwn(env, key)) return { present: true, value: env[key] };
  if (process.platform === 'win32') {
    const actual = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual) return { present: true, value: env[actual] };
  }
  return { present: false, value: undefined };
}
function normalizeEnvironmentPath(value) {
  let normalized = String(value || '').replaceAll('\\', '/');
  if (/^\/[A-Za-z]\//.test(normalized)) normalized = `${normalized[1]}:${normalized.slice(2)}`;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
function normalizeHash(value, minimum, maximum) {
  const hash = String(value || '').toLowerCase();
  return new RegExp(`^[a-f0-9]{${minimum},${maximum}}$`).test(hash) ? hash : '';
}
function sameSet(left, right) {
  return left.length === right?.length && left.every((item) => right.includes(item));
}
function gateError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const command = process.argv[2] || 'inspect',
    root = process.cwd(),
    identity = collectCurrentGateIdentity(root);
  if (command === 'inspect') console.log(JSON.stringify(identity, null, 2));
  else if (command === 'lookup') console.log(JSON.stringify(readGateReceiptForIdentity({ root, identity }), null, 2));
  else throw gateError('gate_receipt_command_invalid', { command });
}
