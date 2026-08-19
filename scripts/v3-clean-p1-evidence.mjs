import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';
import { CLEAN_MIGRATIONS } from '../apps/api/src/clean/schema.mjs';
import { CLEAN_TABLE_OWNERS, CLEAN_COMMAND_OWNERS, CLEAN_EVENT_OWNERS } from '../apps/api/src/clean/ownership.mjs';
import { registryParity } from '../apps/api/src/clean/registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvidence = path.join(root, 'docs', 'evidence', 'v3-clean-p1-sync-20260819');
const verifyOnly = process.argv.includes('--verify');
const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const evidence = path.resolve(outputArgument ? outputArgument.slice('--output='.length) : defaultEvidence);
const required = ['manifest.json', 'modified-artifact.json', 'original-hashes.json', 'verification.json', 'change.patch', 'rollback.ps1', 'schema-snapshot.json', 'cas-manifest.json', 'golden-receipt.json', 'route-inventory.json', 'schema-inventory.json', 'owner-manifest.json', 'task-manifest.json', 'architecture-scan.json'];
// The pre-batch receipt is the change boundary. Keeping this list tied to
// that receipt prevents a rollback patch from including unrelated dirty
// worktree changes made before the P1 sync began.
const baselineReceipt = path.join(root, '.ai-workspace', 'v3-clean-p1-sync-baseline-20260819', 'original-hashes.json');
const receiptPaths = fs.existsSync(baselineReceipt)
  ? (readJsonFile(baselineReceipt).files || []).map((entry) => entry.path).filter(Boolean)
  : [];
const touched = [...new Set([
  ...receiptPaths,
  'apps/api/src/clean/ownership.mjs'
])];

if (verifyOnly) process.exitCode = verifyEvidence();
else await generateEvidence();

async function generateEvidence() {
  if (fs.existsSync(evidence) && fs.readdirSync(evidence).length) throw new Error(`evidence_exists:${relative(evidence)}`);
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p1-sync-'));
  let runtime;
  try {
    const config = {
      runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0,
      home: temp, databaseFile: path.join(temp, 'data', 'state.sqlite'), casRoot: path.join(temp, 'cas'),
      receiptRoot: path.join(temp, 'receipts'), cursorSecret: 'p1-sync-evidence', runtimeBuild: 'v3-clean-p1-sync', maxBodyBytes: 1024 * 1024
    };
    runtime = createCleanRuntime({ config });
    const created = await runtime.operations.create({ commandId: 'evidence.probe', idempotencyKey: 'evidence-operation-1', request: { fixture: 'p1' }, resourceType: 'evidence_probe', resourceId: 'probe_1' });
    const queued = await runtime.operations.queue(created.operation_id, { expectedRevision: created.revision });
    const running = await runtime.operations.start(created.operation_id, { expectedRevision: queued.revision });
    const completed = await runtime.operations.succeed(created.operation_id, { expectedRevision: running.revision, result: { status: 'verified' } });
    const replay = runtime.events.replay({ actorId: runtime.metadata.bootstrap_actor_id, operationId: created.operation_id });
    const casObject = runtime.cas.putCanonical({ evidence: 'p1', status: 'verified' }, { mediaType: 'application/json' });
    const casManifest = runtime.cas.createManifest({ createdAt: '2026-08-19T00:00:00.000Z' });
    const tables = runtime.db.query("select name from sqlite_schema where type='table' and name not like 'sqlite_%' order by name").map((row) => row.name);
    const schemaRows = runtime.db.query("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%' order by type,name");
    writeJson('schema-snapshot.json', { schema_version: 'aiws.v3-clean.schema-snapshot.v2', family: runtime.metadata.family, baseline_id: runtime.metadata.baseline_id, user_version: runtime.metadata.user_version, migration: CLEAN_MIGRATIONS[0], schema_sha256: runtime.metadata.schema_sha256, tables, sqlite_schema: schemaRows });
    writeJson('cas-manifest.json', casManifest);
    writeJson('golden-receipt.json', { schema_version: 'aiws.v3-clean.golden-receipt.v2', operation: completed, replay: { events: replay.events, terminal: replay.terminal, next_cursor: replay.next_cursor }, cas_object: casObject, cas_manifest_sha256: casManifest.manifest_sha256, redactions: [] });
    writeJson('route-inventory.json', { schema_version: 'aiws.v3-clean.route-inventory.v2', routes: runtime.registry.inventory(), mcp: runtime.registry.mcp(), web: runtime.registry.web(), parity: registryParity(runtime.registry) });
    writeJson('schema-inventory.json', { schema_version: 'aiws.v3-clean.schema-inventory.v2', owner: 'Platform', family: runtime.metadata.family, baseline: runtime.metadata.baseline_id, tables });
    writeJson('owner-manifest.json', { schema_version: 'aiws.v3-clean.owner-manifest.v2', tables: CLEAN_TABLE_OWNERS, commands: CLEAN_COMMAND_OWNERS, events: CLEAN_EVENT_OWNERS, second_operation_model: false, shadow_head_model: false });
  } finally {
    runtime?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const original = readBaselineHashes();
  writeJson('original-hashes.json', { schema_version: 'aiws.v3-clean.original-hashes.v2', baseline_commit: '8edefc7', source_receipt: '.ai-workspace/v3-clean-p1-sync-baseline-20260819/original-hashes.json', files: original });
  const changedFiles = [];
  const deletedFiles = [];
  const baselineRoot = path.join(root, '.ai-workspace', 'v3-clean-p1-sync-baseline-20260819');
  const currentPaths = new Set(touched.flatMap((target) => allFiles(target)));
  const baselinePaths = new Set(touched.flatMap((target) => allFilesFrom(baselineRoot, target)));
  for (const file of [...currentPaths].sort()) changedFiles.push({ path: file, sha256: hashFile(path.join(root, file)) });
  for (const file of [...baselinePaths].sort()) {
    if (!currentPaths.has(file)) deletedFiles.push({ path: file, baseline_sha256: hashFile(path.join(baselineRoot, file)) });
  }
  writeJson('modified-artifact.json', { schema_version: 'aiws.v3-clean.modified-artifact.v2', runtime_entry: 'apps/api/server.mjs', files: changedFiles, deleted_files: deletedFiles });
  const patch = buildPatch();
  fs.writeFileSync(path.join(evidence, 'change.patch'), patch, { mode: 0o600 });
  fs.writeFileSync(path.join(evidence, 'rollback.ps1'), rollbackScript(), { mode: 0o600 });

  const checks = [
    run('pnpm', ['check'], 300000),
    run('pnpm', ['scan:clean'], 120000),
    run('pnpm', ['test:p1'], 300000),
    run('pnpm', ['test:integration'], 300000),
    run('pnpm', ['test:security'], 300000),
    run('pnpm', ['test:release'], 300000)
  ];
  // The governance unit test reads this receipt during pnpm verify. Publish a
  // provisional record only after every prerequisite command has passed, then
  // replace it with the complete record below.
  writeVerification(checks, checks.every((entry) => entry.exit_status === 0));
  checks.push(
    run('pnpm', ['verify'], 600000),
    run('git', ['diff', '--check'], 120000),
    run('git', ['apply', '--reverse', '--check', path.relative(root, path.join(evidence, 'change.patch')).replaceAll('\\', '/')], 120000)
  );
  const architecture = run('node', ['scripts/v3-clean-architecture-scan.mjs'], 120000);
  let architectureJson;
  try { architectureJson = JSON.parse(architecture.stdout); } catch { architectureJson = { valid: false, raw: architecture.stdout }; }
  writeJson('architecture-scan.json', architectureJson);
  const statuses = Object.fromEntries(checks.map((entry) => [entry.command, entry.exit_status]));
  const nonTarget = ['Identity/Team business behavior', 'Project business behavior', 'online importer', 'runner/parser adapters', 'full Web workflow'];
  writeJson('task-manifest.json', {
    schema_version: 'aiws.v3-clean.p1-task-manifest.v2',
    target: 'P1 clean baseline, API v2, platform kernel',
    non_target: nonTarget,
    preflight: {
      target: 'v3-clean P1 platform kernel, API v2, startup recovery, and Evidence batch',
      non_target: nonTarget,
      forbidden: ['legacy runtime/API v1 facade', 'second operation/head/CAS model', 'online migration', 'overwriting existing dirty worktree'],
      reuse: ['8edefc7 baseline', '.ai-workspace/v3-clean-p1-sync-baseline-20260819 original hashes', 'clean fixtures and P1 tests'],
      delete_retire: ['apps/api/server-clean.mjs alias', 'legacy entrypoint dynamic switching; historical handlers remain fixtures']
    },
    active_object: 'v3-clean temporary volume',
    last_confirmed_result: `${checks.filter((entry) => entry.exit_status === 0).length}/${checks.length} acceptance commands passed`,
    next_action: 'preserve the receipt and review the P2 entry gate',
    acceptance_commands: ['pnpm check', 'pnpm scan:clean', 'pnpm test:p1', 'pnpm test:integration', 'pnpm test:security', 'pnpm test:release', 'pnpm verify', 'git diff --check', 'git apply --reverse --check change.patch'],
    rollback_artifact: 'rollback.ps1'
  });
  writeVerification(checks, checks.every((entry) => entry.exit_status === 0));
  const hashes = {};
  for (const file of fs.readdirSync(evidence)) if (file !== 'manifest.json' && fs.statSync(path.join(evidence, file)).isFile()) hashes[file] = hashFile(path.join(evidence, file));
  writeJson('manifest.json', { schema_version: 'aiws.v3-clean.p1-evidence-manifest.v2', batch: path.basename(evidence), artifacts: hashes, modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' });
  process.stdout.write(`${JSON.stringify({ evidence: relative(evidence), status: checks.every((entry) => entry.exit_status === 0) ? 'passed' : 'failed', checks: statuses }, null, 2)}\n`);
  if (checks.some((entry) => entry.exit_status !== 0)) process.exitCode = 1;
}

function writeVerification(checks, passed) {
  writeJson('verification.json', { schema_version: 'aiws.v3-clean.verification.v2', status: passed ? 'passed' : 'failed', generated_at: new Date().toISOString(), environment: { node: process.version, platform: process.platform, cwd: 'repository-root' }, baseline: run('git', ['rev-parse', 'HEAD'], 120000), commands: checks, checks, clean_volume: 'temporary volume discarded after capture', literal_failure_notes: checks.filter((entry) => entry.exit_status !== 0).map((entry) => `${entry.command} exited ${entry.exit_status}`), artifacts: { modified_artifact: 'modified-artifact.json', patch: 'change.patch', rollback: 'rollback.ps1' } });
}

function verifyEvidence() {
  const errors = [];
  if (!fs.existsSync(evidence)) errors.push('evidence_missing');
  for (const file of required) if (!fs.existsSync(path.join(evidence, file))) errors.push(`artifact_missing:${file}`);
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); return 1; }
  let manifest;
  let verification;
  let modified;
  try {
    manifest = readJsonFile(path.join(evidence, 'manifest.json'));
    verification = readJsonFile(path.join(evidence, 'verification.json'));
    modified = readJsonFile(path.join(evidence, 'modified-artifact.json'));
  } catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
  for (const [file, expected] of Object.entries(manifest.artifacts || {})) {
    const actual = hashFile(path.join(evidence, file));
    if (actual !== expected) errors.push(`artifact_hash_mismatch:${file}`);
  }
  for (const file of modified.files || []) {
    const full = path.join(root, file.path);
    if (!fs.existsSync(full)) errors.push(`modified_artifact_missing:${file.path}`);
    else if (hashFile(full) !== file.sha256) errors.push(`modified_artifact_hash_mismatch:${file.path}`);
  }
  for (const file of modified.deleted_files || []) if (fs.existsSync(path.join(root, file.path))) errors.push(`deleted_artifact_restored:${file.path}`);
  if (verification.status !== 'passed' || (verification.checks || []).some((entry) => Number(entry.exit_status) !== 0)) errors.push('verification_not_passed');
  const reverse = run('git', ['apply', '--reverse', '--check', path.relative(root, path.join(evidence, 'change.patch')).replaceAll('\\', '/')], 120000);
  if (reverse.exit_status !== 0) errors.push('rollback_dry_run_failed');
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); return 1; }
  process.stdout.write(`${JSON.stringify({ evidence: relative(evidence), status: 'passed', rollback_dry_run: reverse }, null, 2)}\n`);
  return 0;
}

function readBaselineHashes() {
  const source = path.join(root, '.ai-workspace', 'v3-clean-p1-sync-baseline-20260819', 'original-hashes.json');
  if (fs.existsSync(source)) return readJsonFile(source).files || {};
  const files = {};
  for (const target of touched) for (const file of allFiles(target)) files[file] = { baseline_commit: '8edefc7', sha256: gitHeadHash(file) };
  return files;
}

function buildPatch() {
  const baselineRoot = path.join(root, '.ai-workspace', 'v3-clean-p1-sync-baseline-20260819');
  const paths = new Set();
  for (const target of touched) {
    for (const file of allFiles(target)) paths.add(file);
    for (const file of allFilesFrom(baselineRoot, target)) paths.add(file);
  }

  const chunks = [];
  for (const file of [...paths].sort()) {
    const baselineFile = path.join(baselineRoot, file);
    const currentFile = path.join(root, file);
    const baselineExists = fs.existsSync(baselineFile) && fs.statSync(baselineFile).isFile();
    const currentExists = fs.existsSync(currentFile) && fs.statSync(currentFile).isFile();
    if (!baselineExists && !currentExists) continue;
    if (baselineExists && currentExists && hashFile(baselineFile) === hashFile(currentFile)) continue;

    const oldPath = baselineExists ? path.relative(root, baselineFile).replaceAll('\\', '/') : '/dev/null';
    const newPath = currentExists ? file : '/dev/null';
    const result = spawnSync('git', ['diff', '--no-index', '--binary', '--', oldPath, newPath], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 && result.status !== 1) throw new Error(`patch_file_failed:${file}:${result.stderr || result.error || result.status}`);
    if (!result.stdout) continue;
    chunks.push(normalizeNoIndexPatch(result.stdout, file, baselineExists, currentExists));
  }
  return chunks.join('').replace(/\n+$/u, '') + (chunks.length ? '\n' : '');
}

function normalizeNoIndexPatch(diff, file, baselineExists, currentExists) {
  let oldHeader = false;
  let newHeader = false;
  return diff.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) return `diff --git a/${file} b/${file}`;
    if (!oldHeader && line.startsWith('--- ')) {
      oldHeader = true;
      return baselineExists ? `--- a/${file}` : '--- /dev/null';
    }
    if (!newHeader && line.startsWith('+++ ')) {
      newHeader = true;
      return currentExists ? `+++ b/${file}` : '+++ /dev/null';
    }
    return line;
  }).join('\n');
}

function rollbackScript() {
  return `param([switch]$Apply)\n$ErrorActionPreference = 'Stop'\n$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path\n$Root = (Resolve-Path (Join-Path $Evidence '..\\..\\..')).Path\n$Patch = Join-Path $Evidence 'change.patch'\nPush-Location $Root\ntry {\n  git apply --reverse --check $Patch\n  if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_failed' }\n  if ($Apply) { git apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_failed' } }\n  [ordered]@{ schema_version='aiws.v3-clean.rollback-receipt.v2'; status=($(if ($Apply) { 'applied' } else { 'dry_run_passed' })); patch='change.patch'; volume_policy='seal and retain deployment volumes; no down migration'; verified_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5\n} finally { Pop-Location }\n`;
}

function run(command, args, timeout) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' && command === 'pnpm', windowsHide: true, timeout, env: { ...process.env } });
  return { command: sanitize([command, ...args].join(' ')), stdout: sanitize(result.stdout || ''), stderr: sanitize(result.stderr || ''), exit_status: result.status == null ? 1 : result.status, signal: result.signal || null };
}

function sanitize(value) { return String(value).replaceAll(root, 'HOST').replace(/(?:file:\/\/\/)?\b[A-Za-z]:[\\/][^\r\n"']+/g, 'HOST_PATH').replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/)[^\s"']+/g, 'HOST_PATH'); }
function writeJson(name, value) { fs.writeFileSync(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function readJsonFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function hashFile(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function gitHeadHash(file) { const result = spawnSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: null, windowsHide: true }); return result.status === 0 ? createHash('sha256').update(result.stdout).digest('hex') : null; }
function allFiles(target) { const full = path.join(root, target); if (!fs.existsSync(full)) return []; if (fs.statSync(full).isFile()) return [target.replaceAll('\\', '/')]; const output = []; for (const entry of fs.readdirSync(full, { withFileTypes: true })) { const child = path.join(target, entry.name); if (entry.isDirectory()) output.push(...allFiles(child)); else output.push(child.replaceAll('\\', '/')); } return output; }
function allFilesFrom(base, target) {
  const full = path.join(base, target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [target.replaceAll('\\', '/')];
  const output = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) output.push(...allFilesFrom(base, child));
    else output.push(child.replaceAll('\\', '/'));
  }
  return output;
}
function relative(file) { return path.relative(root, file).replaceAll('\\', '/'); }
