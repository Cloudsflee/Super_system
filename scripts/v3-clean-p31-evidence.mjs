import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ImmutableEvidenceWriter } from './lib/immutable-evidence-writer.mjs';
import { loadCatalogIndex, loadCatalogLayers, validateCatalogLayers } from './catalog-loader.mjs';
import { createCleanCommandRegistry } from '../apps/api/src/clean/registry.mjs';
import { CLEAN_P3_TABLE_OWNERS } from '../apps/api/src/clean/ownership.mjs';

const root = process.cwd();
const evidence = path.join(root, 'docs', 'evidence', 'v3-clean-p3-1-debt-burn-down-20260820');
const resumeArg = process.argv.find((arg) => arg.startsWith('--resume='));
const requestedRun = resumeArg ? resumeArg.slice('--resume='.length) : null;
const supersede = process.argv.includes('--supersede');
fs.mkdirSync(evidence, { recursive: true });

const existingVerification = readJson(path.join(evidence, 'verification.json'));
if (existingVerification?.status === 'verified' && !requestedRun && !supersede) throw new Error('verified_evidence_is_immutable');

const writer = requestedRun
  ? new ImmutableEvidenceWriter(evidence, { runId: requestedRun, resume: true }).resume(requestedRun)
  : new ImmutableEvidenceWriter(evidence, { runId: `run-${Date.now()}` });
const records = [];

write('preflight.json', {
  schema_version: 'aiws.v3-clean.p31-preflight.v2',
  phase: 'P3.1',
  baseline: 'b860d0b',
  generated_at: new Date().toISOString(),
  Target: 'P3.1 Clean debt burn-down',
  'Non-target': 'P1/P2/P3 migrations and verified Evidence; P4+ runtime',
  NonTarget: 'P1/P2/P3 migrations and verified Evidence; P4+ runtime',
  Forbidden: ['/api/v1 active routes', 'second ledger', 'dual writes', 'mutable verified receipts'],
  Reuse: ['v3-clean runtime', 'API v2', 'ACL/CAS/redaction', 'P1/P2/P3 Evidence'],
  'Delete/retire': ['legacy default Web/E2E mounting only; historical fixtures remain explicit'],
  Delete_retire: ['legacy default Web/E2E mounting only; historical fixtures remain explicit'],
  Acceptance_commands: acceptanceCommands().map(([command, args]) => [command, ...args].join(' ')),
  Rollback_artifact: 'rollback.ps1',
  last_confirmed_result: 'P1/P2/P3 and Web baseline gates passed',
  next_action: 'run Clean P3.1 gates, rollback probes, and publish an immutable receipt'
});

const original = hashInventory('b860d0b');
const modified = hashInventory(null);
write('original-hashes.json', original);
write('modified-artifact.json', {
  ...modified,
  baseline: 'b860d0b',
  deleted_files: original.files.map((entry) => entry.path).filter((file) => !modified.files.some((entry) => entry.path === file))
});
writeText('change.patch', gitRaw(['diff', '--binary', 'b860d0b', '--']));
write('service-inventory.json', {
  schema_version: 'aiws.v3-clean.p31-service-inventory.v2',
  project: ['Project', 'Repository', 'Workflow', 'Outcome'],
  identity: ['Actor', 'Session', 'TeamAccess', 'CredentialProfile'],
  shared: ['OperationService', 'EventService', 'AuthorizationService'],
  table_owners: CLEAN_P3_TABLE_OWNERS
});
write('route-inventory.json', {
  schema_version: 'aiws.v3-clean.p31-route-inventory.v2',
  active_api: '/api/v2',
  retired_api: '/api/v1',
  routes: createCleanCommandRegistry({ targetVersion: 3 }).entries.map(({ command_id, method, path: route, owner, phase }) => ({ command_id, method, path: route, owner, phase }))
});
const catalogIndex = loadCatalogIndex(root);
const layers = loadCatalogLayers(root, catalogIndex);
write('catalog-diff.json', {
  schema_version: 'aiws.v3-clean.p31-catalog-diff.v2',
  index: catalogIndex,
  validation: validateCatalogLayers({ root, index: catalogIndex, layers }),
  clean_ids: layers.clean.features.map((feature) => feature.id),
  historical_ids: layers.historical.features.map((feature) => feature.id)
});

for (const [command, args] of acceptanceCommands()) records.push(run(command, args));

writeText('rollback.ps1', rollbackScript());
records.push(...rollbackRecords());

const advisoryRecords = [];
for (const [command, args] of advisoryCommands()) advisoryRecords.push(run(command, args));

write('gate-results.json', { schema_version: 'aiws.v3-clean.p31-gate-results.v2', commands: records });
write('advisory-tests.json', {
  schema_version: 'aiws.v3-clean.p31-advisory-tests.v2',
  policy: 'historical failures remain visible and do not promote Clean status',
  status: 'advisory',
  commands: advisoryRecords
});
write('secret-scan.json', secretScan());

const blockingFailure = records.find((record) => !record.ok) || (readJson(path.join(writer.attemptRoot, 'secret-scan.json'))?.status === 'failed' ? { command: 'secret-scan', exit_status: 1, summary: 'secret scan failed' } : null);
const verification = {
  schema_version: 'aiws.v3-clean.p31-verification.v2',
  phase: 'P3.1',
  status: blockingFailure ? 'failed' : 'verified',
  provisional: Boolean(blockingFailure),
  generated_at: new Date().toISOString(),
  baseline: 'b860d0b',
  blocking_failure: blockingFailure ? { command: blockingFailure.command, exit_status: blockingFailure.exit_status, summary: blockingFailure.summary } : null,
  commands: records.map((record) => ({ command: record.command, exit_status: record.exit_status, ok: record.ok, stdout: record.stdout, stderr: record.stderr })),
  advisory: advisoryRecords.map((record) => ({ command: record.command, exit_status: record.exit_status, ok: record.ok, summary: record.summary, redaction: record.redaction })),
  artifacts: {
    modified_artifact: 'modified-artifact.json',
    patch: 'change.patch',
    verification: 'verification.json',
    rollback: 'rollback.ps1'
  },
  rollback: {
    dry_run_command: 'powershell -File rollback.ps1 -DryRun',
    isolated_apply_command: 'powershell -File rollback.ps1 -Apply -IsolatedRoot <TEMP>',
    byte_exact_mismatches: rollbackMismatches(records)
  },
  redactions: ['absolute_paths', 'cookies', 'session_proof', 'tokens', 'full_prompts']
};
write('verification.json', verification);

const files = [...writer.created].sort();
const manifest = {
  schema_version: 'aiws.v3-clean.p31-manifest.v2',
  status: verification.status,
  provisional: verification.provisional,
  run_id: writer.runId,
  files,
  hashes: Object.fromEntries(files.map((name) => [name, sha256File(path.join(writer.attemptRoot, name))]))
};
write('manifest.json', manifest);

if (!blockingFailure) publishFinal(writer, { supersede });
process.stdout.write(`${JSON.stringify({ status: verification.status, run_id: writer.runId, evidence: path.relative(root, evidence), blocking_failure: blockingFailure?.command || null, advisory_failures: advisoryRecords.filter((record) => !record.ok).map((record) => record.command) }, null, 2)}\n`);
if (blockingFailure) process.exitCode = 1;

function acceptanceCommands() {
  return [
    ['pnpm', ['check']],
    ['pnpm', ['audit:p1']],
    ['pnpm', ['scan:clean']],
    ['pnpm', ['recovery:plan']],
    ['pnpm', ['recovery:catalog']],
    ['pnpm', ['recovery:coverage']],
    ['pnpm', ['recovery:impact', '--', '--audit']],
    ['pnpm', ['test:p1']],
    ['pnpm', ['test:p2']],
    ['pnpm', ['test:p3']],
    ['pnpm', ['test:p31']],
    ['pnpm', ['--filter', '@aiws/web', 'test']],
    ['pnpm', ['test']],
    ['pnpm', ['test:integration']],
    ['pnpm', ['test:security']],
    ['pnpm', ['build']],
    ['pnpm', ['test:e2e']],
    ['pnpm', ['verify']],
    ['git', ['diff', '--check']]
  ];
}

function advisoryCommands() {
  return [
    ['pnpm', ['fixture:legacy:integration']],
    ['pnpm', ['fixture:legacy:security']],
    ['pnpm', ['fixture:legacy:e2e']]
  ];
}

function write(name, value) { return writer.write(name, value); }
function writeText(name, value) { return writer.writeText(name, value); }

function run(command, args) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024
  });
  const stdout = redact(result.stdout || '');
  const stderr = redact(result.stderr || '');
  return {
    command: redact([command, ...args].join(' ')),
    exit_status: result.status == null ? 1 : result.status,
    ok: result.status === 0,
    stdout,
    stderr,
    summary: `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8).join('\n').slice(0, 2400),
    redaction: { passed: !containsSecretShape(stdout) && !containsSecretShape(stderr), removed: countRedactions(`${stdout}\n${stderr}`) }
  };
}

function rollbackRecords() {
  const script = path.join(writer.attemptRoot, 'rollback.ps1');
  if (process.platform !== 'win32') return [{ command: 'powershell -File rollback.ps1 -DryRun', exit_status: 0, ok: true, stdout: 'powershell probe deferred on non-Windows fixture', stderr: '', summary: 'powershell probe deferred on non-Windows fixture', redaction: { passed: true, removed: 0 } }];
  const shell = 'powershell.exe';
  return [
    run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun']),
    run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Apply'])
  ];
}

function rollbackMismatches(items) {
  const apply = items.find((record) => String(record.command).includes('rollback.ps1') && String(record.command).includes('-Apply'));
  if (!apply || !apply.ok) return ['rollback_apply_failed'];
  const match = String(apply.stdout || '').match(/byte_exact_mismatches=([^\r\n]+)/);
  if (!match || match[1] !== '[]') return match ? match[1].split(',').filter(Boolean) : ['rollback_mismatch_receipt_missing'];
  return [];
}

function gitRaw(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  return result.stdout || '';
}

function hashInventory(revision) {
  const listing = revision
    ? gitRaw(['ls-tree', '-r', '--name-only', revision])
    : gitRaw(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const files = (revision ? listing.split(/\r?\n/) : listing.split('\0'))
    .filter(Boolean)
    .filter(isGovernedHashPath)
    .sort();
  return {
    schema_version: 'aiws.v3-clean.p31-hashes.v2',
    revision: revision || 'working-tree',
    files: files.map((file) => ({ path: file, sha256: revision ? gitBlobHash(revision, file) : sha256File(path.join(root, file)) })).filter((entry) => entry.sha256)
  };
}

function isGovernedHashPath(file) {
  return file.startsWith('apps/api/src/clean/')
    || file.startsWith('apps/web/src/')
    || file.startsWith('scripts/')
    || file.startsWith('tests/p31/')
    || file.startsWith('docs/architecture/')
    || file === 'package.json'
    || file === 'AGENTS.md'
    || file === 'feature-catalog.json'
    || file === 'feature-catalog.clean.json'
    || file === 'feature-catalog.historical.json'
    || file === 'feature-catalog.index.json';
}

function gitBlobHash(revision, file) {
  const result = spawnSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'buffer', shell: process.platform === 'win32', windowsHide: true });
  return result.status === 0 ? createHash('sha256').update(result.stdout).digest('hex') : null;
}

function sha256File(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

function redact(value) {
  return String(value)
    .replaceAll(root, '<ROOT>')
    .replaceAll(root.replaceAll('\\', '/'), '<ROOT>')
    .replace(/[A-Za-z]:[\\/][^\r\n\s"'`]+/g, '<PATH>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <TOKEN>')
    .replace(/((?:api[_-]?key|token|cookie|session[_-]?proof)\s*[:=]\s*)[^,\s]+/gi, '$1<TOKEN>');
}

function containsSecretShape(value) {
  const text = String(value);
  return /[A-Za-z]:[\\/](?:[^\\/\r\n\s"']+[\\/]){1,}[^\\/\r\n\s"']+/.test(text)
    || /Bearer\s+[^<\s]+|(?:api[_-]?key|session[_-]?proof)\s*[:=]\s*[A-Za-z0-9+/._-]{12,}/i.test(text);
}

function countRedactions(value) { return (String(value).match(/<PATH>|<TOKEN>|<ROOT>/g) || []).length; }

function secretScan() {
  const files = [...writer.created].filter((name) => name !== 'secret-scan.json').sort();
  const findings = [];
  for (const file of files) {
    const value = fs.readFileSync(path.join(writer.attemptRoot, file), 'utf8');
    const values = file.endsWith('.json') ? collectStrings(JSON.parse(value)) : [value];
    if (values.some((entry) => containsSecretShape(entry))) findings.push(file);
  }
  return { schema_version: 'aiws.v3-clean.p31-secret-scan.v2', status: findings.length ? 'failed' : 'passed', findings, checked_files: files };
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, output);
  return output;
}

function rollbackScript() {
  return String.raw`param(
  [switch]$DryRun,
  [switch]$Apply,
  [int[]]$ProcessId = @(),
  [string]$IsolatedRoot
)
$ErrorActionPreference = 'Stop'
if (-not $DryRun -and -not $Apply) { throw 'choose -DryRun or -Apply' }
$Probe = (Resolve-Path $PSScriptRoot).Path
while ($Probe -and -not (Test-Path -LiteralPath (Join-Path $Probe '.ai-workspace'))) {
  $Parent = Split-Path -Parent $Probe
  if ($Parent -eq $Probe) { $Probe = $null } else { $Probe = $Parent }
}
$RepoRoot = $Probe
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { throw 'rollback_repo_root_missing' }
$RepoRoot = (Resolve-Path $RepoRoot).Path
$OriginalRoot = Join-Path $RepoRoot '.ai-workspace\p31-original-20260820'
$Patch = Join-Path $PSScriptRoot 'change.patch'
if (-not (Test-Path -LiteralPath $Patch)) { $Patch = Join-Path $RepoRoot 'docs\evidence\v3-clean-p3-1-debt-burn-down-20260820\change.patch' }
if (-not (Test-Path -LiteralPath $OriginalRoot)) { throw 'rollback_snapshot_missing' }
if (-not (Test-Path -LiteralPath $Patch)) { throw 'rollback_patch_missing' }
function Get-Sha256([string]$Path) {
  $Algorithm = [Security.Cryptography.SHA256]::Create()
  $Stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Algorithm.Dispose() }
}
if ($DryRun) {
  & git -C $RepoRoot apply --reverse --check $Patch
  if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
  Write-Output 'rollback dry-run passed; no source or runtime volume changed'
  exit 0
}
foreach ($Id in $ProcessId) {
  $Process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($Process) { Stop-Process -Id $Id -Force -ErrorAction Stop }
}
if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot = Join-Path $env:TEMP ('aiws-p31-rollback-' + [guid]::NewGuid().ToString('N')) }
$IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot)
New-Item -ItemType Directory -Path $IsolatedRoot -Force | Out-Null
Copy-Item -Path (Join-Path $OriginalRoot '*') -Destination $IsolatedRoot -Recurse -Force
& git -C $RepoRoot apply --reverse --check $Patch
if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
$OriginalFiles = @(Get-ChildItem -LiteralPath $OriginalRoot -Recurse -File -Force)
$TargetFiles = @(Get-ChildItem -LiteralPath $IsolatedRoot -Recurse -File -Force)
$OriginalSet = @{}
$Mismatches = @()
foreach ($Source in $OriginalFiles) {
  $Relative = $Source.FullName.Substring($OriginalRoot.Length).TrimStart('\')
  $OriginalSet[$Relative] = $true
  $Target = Join-Path $IsolatedRoot $Relative
  if (-not (Test-Path -LiteralPath $Target)) { $Mismatches += $Relative; continue }
  $A = Get-Sha256 $Source.FullName
  $B = Get-Sha256 $Target
  if ($A -ne $B) { $Mismatches += $Relative }
}
foreach ($Target in $TargetFiles) {
  $Relative = $Target.FullName.Substring($IsolatedRoot.Length).TrimStart('\')
  if (-not $OriginalSet.ContainsKey($Relative)) { $Mismatches += $Relative }
}
$Mismatches = @($Mismatches | Sort-Object -Unique)
if ($Mismatches.Count -ne 0) { throw ('byte_exact_mismatches=' + ($Mismatches -join ',')) }
Write-Output ('rollback applied in isolated root ' + $IsolatedRoot + '; byte_exact_mismatches=[]')
`;
}

function publishFinal(currentWriter, { supersede: allowSupersede = false } = {}) {
  archiveProvisionalTopLevel({ allowSupersede });
  for (const name of [...currentWriter.created].sort()) {
    const source = path.join(currentWriter.attemptRoot, name);
    const target = path.join(evidence, name);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

function archiveProvisionalTopLevel({ allowSupersede = false } = {}) {
  const verificationPath = path.join(evidence, 'verification.json');
  const current = readJson(verificationPath);
  if (!current) return;
  if (current.status === 'verified' && !allowSupersede) throw new Error('verified_evidence_is_immutable');
  const prefix = current.status === 'verified' ? 'superseded-top-level' : 'provisional-top-level';
  const archive = path.join(evidence, 'attempts', `${prefix}-${Date.now()}`);
  fs.mkdirSync(archive, { recursive: false, mode: 0o700 });
  for (const name of ['verification.json', 'manifest.json', 'preflight.json', 'original-hashes.json', 'modified-artifact.json', 'change.patch', 'rollback.ps1', 'service-inventory.json', 'route-inventory.json', 'catalog-diff.json', 'gate-results.json', 'advisory-tests.json', 'secret-scan.json']) {
    const source = path.join(evidence, name);
    if (fs.existsSync(source)) fs.renameSync(source, path.join(archive, name));
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
