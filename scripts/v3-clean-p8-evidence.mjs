import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';
import { CLEAN_P8_TABLE_OWNERS } from '../apps/api/src/clean/ownership.mjs';
import { ImmutableEvidenceWriter } from './lib/immutable-evidence-writer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRelative = 'docs/evidence/v3-clean-p8-delivery-deployment-importer-20260825';
const out = path.join(root, evidenceRelative);
const baselineCommit = '4ee1a436b2f810354602308d733fbee7423f3cf0';
const verifyOnly = process.argv.includes('--verify');
const supersede = process.argv.includes('--supersede');
const focused = process.argv.includes('--focused');
const publishArgument = process.argv.find((value) => value.startsWith('--publish-run='));
const finalFile = path.join(out, 'verification.json');

if (publishArgument) {
  const runId = publishArgument.slice('--publish-run='.length);
  const attemptRoot = path.join(out, 'attempts', runId);
  if (!fs.existsSync(path.join(attemptRoot, 'verification.json')) || !fs.existsSync(path.join(attemptRoot, 'manifest.json'))) throw new Error('p8_publish_attempt_incomplete');
  publish(attemptRoot);
  const result = verifyPublished();
  process.stdout.write(`${JSON.stringify({ ...result, published_run_id: runId }, null, 2)}\n`);
  process.exit(result.status === 'passed' ? 0 : 1);
}

if (verifyOnly) {
  const result = verifyPublished();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'passed' ? 0 : 1);
}

const existing = readJson(finalFile);
if (existing && !supersede) throw new Error('p8_evidence_exists_use_supersede');
fs.mkdirSync(out, { recursive: true });
if (existing) archivePublished(existing);

const writer = new ImmutableEvidenceWriter(out, { runId: `run-${Date.now()}` });
const records = [];
try {
  writer.write('preflight.json', preflight());
  writer.write('original-hashes.json', baselineInventory());
  writer.write('modified-artifact.json', worktreeInventory());
  writer.writeText('change.patch', gitPatch());
  createMigrationArtifacts(writer);
  createRollbackArtifacts(writer);

  for (const command of acceptanceCommands(focused)) records.push(run(command));
  writer.write('gate-results.json', { schema_version: 'aiws.v3-clean.p8-gate-results.v2', focused, commands: records });

  const github = probeRecord(records, 'v3-clean-p8-github-delivery-probe.mjs');
  const deployment = probeRecord(records, 'v3-clean-p8-deployment-rollback-probe.mjs');
  const importer = probeRecord(records, 'v3-clean-p8-importer-probe.mjs');
  const backup = probeRecord(records, 'v3-clean-p8-backup-restore-gc-probe.mjs');
  const performance = probeRecord(records, 'v3-clean-p8-performance.mjs');
  writer.write('github-delivery-probe.json', github);
  writer.write('deployment-probe.json', deployment);
  writer.write('importer-probe.json', importer);
  writer.write('backup-restore-gc-probe.json', backup);
  writer.write('performance-receipt.json', performance);

  const rollback = executeRollback(writer);
  writer.write('rollback-receipt.json', rollback);
  const localFailure = records.find((record) => record.exit_status !== 0)
    || (rollback.status === 'passed' ? null : { command: 'rollback', exit_status: 1 });
  const githubVerified = github.status === 'passed' && github.provisional === false && github.external?.status === 'verified';
  const dockerVerified = deployment.status === 'passed' && deployment.provisional === false && deployment.external?.status === 'verified';
  const provisional = Boolean(localFailure) || !githubVerified || !dockerVerified;
  const status = localFailure ? 'failed' : provisional ? 'candidate' : 'verified';
  const verificationRecord = { schema_version: 'aiws.v3-clean.p8-verification-record.v2', commands: records, rollback };
  writer.write('verification-record.json', verificationRecord);
  const verification = {
    schema_version: 'aiws.v3-clean.p8-verification.v2', phase: 'P8', run_id: writer.runId,
    status, provisional, generated_at: new Date().toISOString(), baseline_commit: baselineCommit,
    supersedes_run_id: existing?.run_id || null, migration: '008-delivery-deployment-importer-operations', target_user_version: 8,
    local_gate_status: localFailure ? 'failed' : 'verified', blocking_failure: localFailure ? { command: localFailure.command, exit_status: localFailure.exit_status } : null,
    catalog_promotion: provisional ? 'frozen-23/4/27' : '26/1/27', catalog: provisional ? { clean: 23, historical: 4, total: 27 } : { clean: 26, historical: 1, total: 27 },
    external_gates: { github: { verified: githubVerified, artifact: 'github-delivery-probe.json' }, docker: { verified: dockerVerified, artifact: 'deployment-probe.json' } },
    probes: {
      github: { status: github.status, provisional: github.provisional }, deployment: { status: deployment.status, provisional: deployment.provisional },
      importer: { status: importer.status }, backup_restore_gc: { status: backup.status }, performance: { status: performance.status }
    },
    rollback: { status: rollback.status, dry_run_exit_status: rollback.dry_run.exit_status, apply_exit_status: rollback.apply.exit_status, restored_user_version: rollback.apply.output?.restored_user_version, ledger: rollback.apply.output?.ledger, p8_tables_present: rollback.apply.output?.p8_tables_present, byte_exact_mismatches: rollback.apply.output?.byte_exact_mismatches },
    commands: records.map(({ command, exit_status, duration_ms }) => ({ command, exit_status, duration_ms })),
    artifacts: artifactRoles(writer.attemptRoot)
  };
  writer.write('verification.json', verification);
  const secretScan = scanAttempt(writer.attemptRoot);
  writer.write('secret-scan.json', secretScan);
  if (secretScan.status !== 'passed') throw new Error(`p8_evidence_secret_scan_failed:${secretScan.findings.join(',')}`);
  const manifest = attemptManifest(writer.attemptRoot, verification);
  writer.write('manifest.json', manifest);
  if (!localFailure) {
    publish(writer.attemptRoot);
    const reopened = verifyPublished();
    if (reopened.status !== 'passed') throw new Error(`p8_evidence_reopen_failed:${reopened.failures.join(',')}`);
  }
  process.stdout.write(`${JSON.stringify({ status, provisional, run_id: writer.runId, directory: evidenceRelative, published: !localFailure, local_gate_status: verification.local_gate_status, external_gates: verification.external_gates, rollback_exit_status: rollback.apply.exit_status }, null, 2)}\n`);
  if (localFailure) process.exitCode = 1;
} catch (error) {
  try { writer.write('failure.json', { schema_version: 'aiws.v3-clean.p8-generation-failure.v1', status: 'failed', provisional: true, run_id: writer.runId, error: redact(String(error?.stack || error)) }); } catch { /* preserve primary failure */ }
  process.stderr.write(`${redact(String(error?.stack || error))}\n`);
  process.exitCode = 1;
}

function acceptanceCommands(useFocused) {
  const p8 = [
    ['pnpm', 'check'], ['pnpm', 'test:p8'], ['node', 'scripts/v3-clean-p8-performance.mjs'], ['node', 'scripts/v3-clean-p8-github-delivery-probe.mjs'],
    ['node', 'scripts/v3-clean-p8-importer-probe.mjs'], ['node', 'scripts/v3-clean-p8-deployment-rollback-probe.mjs'], ['node', 'scripts/v3-clean-p8-backup-restore-gc-probe.mjs'],
    ['pnpm', '--filter', '@aiws/web', 'test'], ['pnpm', 'build'], ['git', 'diff', '--check']
  ];
  if (useFocused) return p8;
  return [
    ['pnpm', 'check'], ['pnpm', 'audit:p1'], ['pnpm', 'scan:clean'], ['pnpm', 'recovery:plan'], ['pnpm', 'recovery:catalog'], ['pnpm', 'recovery:coverage'], ['pnpm', 'recovery:impact', '--', '--audit'],
    ...['p1', 'p2', 'p3', 'p31', 'p4', 'p5', 'p6', 'p7', 'p8'].map((phase) => ['pnpm', `test:${phase}`]),
    ['node', 'scripts/v3-clean-p5-performance.mjs'], ['node', 'scripts/v3-clean-p5-assist-probe.mjs'], ['node', 'scripts/v3-clean-p5-bridge-probe.mjs'],
    ['node', 'scripts/v3-clean-p6-performance.mjs'], ['node', 'scripts/v3-clean-p6-docker-runner-probe.mjs'], ['node', 'scripts/v3-clean-p6-host-runner-probe.mjs'], ['node', 'scripts/v3-clean-p6-bridge-runner-probe.mjs'], ['node', 'scripts/v3-clean-p6-restart-probe.mjs'],
    ['node', 'scripts/v3-clean-p7-performance.mjs'], ['node', 'scripts/v3-clean-p7-cas-tamper-probe.mjs'], ['node', 'scripts/v3-clean-p7-parser-probe.mjs'], ['node', 'scripts/v3-clean-p7-quality-outcome-probe.mjs'], ['node', 'scripts/v3-clean-p7-restart-probe.mjs'],
    ...p8.slice(2, 7),
    ['pnpm', '--filter', '@aiws/web', 'test'], ['pnpm', 'test'], ['pnpm', 'test:integration:clean'], ['pnpm', 'test:security:clean'], ['pnpm', 'test:integration'], ['pnpm', 'test:security'], ['pnpm', 'build'], ['pnpm', 'test:e2e'], ['pnpm', 'test:release'], ['git', 'diff', '--check']
  ];
}

function run(parts) {
  const started = Date.now();
  const result = spawnSync(parts[0], parts.slice(1), { cwd: root, encoding: 'utf8', timeout: 1_800_000, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  return { command: parts.join(' '), stdout: redact(result.stdout || ''), stderr: redact(result.stderr || ''), exit_status: result.status ?? 1, signal: result.signal || null, duration_ms: Date.now() - started };
}

function probeRecord(records, name) {
  const record = records.find((item) => item.command.includes(name));
  if (!record) return { status: 'missing', provisional: true };
  try { return { ...JSON.parse(record.stdout.slice(record.stdout.indexOf('{'))), command: record.command, exit_status: record.exit_status }; }
  catch { return { status: 'failed', provisional: true, command: record.command, exit_status: record.exit_status, stdout_sha256: sha256(record.stdout), stderr_sha256: sha256(record.stderr) }; }
}

function createMigrationArtifacts(activeWriter) {
  const receiptRoot = path.join(activeWriter.attemptRoot, 'migration-receipts');
  const baseline = path.join(activeWriter.attemptRoot, 'baseline-v7.sqlite');
  const modified = path.join(activeWriter.attemptRoot, 'modified-v8.sqlite');
  openCleanDatabase(baseline, { targetVersion: 7, receiptRoot }).close();
  fs.copyFileSync(baseline, modified);
  openCleanDatabase(modified, { targetVersion: 8, receiptRoot }).close();
  fs.rmSync(receiptRoot, { recursive: true, force: true });
  const added = p8Tables();
  activeWriter.write('patch.json', { schema_version: 'aiws.v3-clean.p8-schema-diff.v2', from_user_version: 7, to_user_version: 8, migration: '008-delivery-deployment-importer-operations', added_tables: added, removed_tables: [] });
}

function createRollbackArtifacts(activeWriter) {
  const baselineRoot = path.join(activeWriter.attemptRoot, 'rollback-baseline');
  const components = ['cas', 'vault', 'workspace', 'broker', 'bridge', 'parser'];
  fs.mkdirSync(baselineRoot, { recursive: true });
  const files = [{ path: 'sqlite/state.sqlite', source: 'baseline-v7.sqlite' }];
  fs.mkdirSync(path.join(baselineRoot, 'sqlite'), { recursive: true });
  fs.copyFileSync(path.join(activeWriter.attemptRoot, 'baseline-v7.sqlite'), path.join(baselineRoot, 'sqlite', 'state.sqlite'));
  for (const component of components) {
    const relative = `${component}/state.bin`;
    const file = path.join(baselineRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(`p8-${component}-baseline\n`));
    files.push({ path: relative, source: `rollback-baseline/${relative}` });
  }
  activeWriter.write('rollback-manifest.json', { schema_version: 'aiws.v3-clean.p8-rollback-manifest.v2', files: files.map((item) => ({ path: item.path, sha256: hash(path.join(baselineRoot, item.path)) })) });
  activeWriter.writeText('rollback-verify.mjs', rollbackVerifier());
  activeWriter.writeText('rollback.ps1', rollbackPowerShell());
}

function executeRollback(activeWriter) {
  const script = path.join(activeWriter.attemptRoot, 'rollback.ps1');
  const isolated = path.join(activeWriter.attemptRoot, 'rollback-isolated');
  const dry = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-IsolatedRoot', isolated], { cwd: activeWriter.attemptRoot, encoding: 'utf8', timeout: 120_000 });
  const apply = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Apply', '-IsolatedRoot', isolated], { cwd: activeWriter.attemptRoot, encoding: 'utf8', timeout: 120_000 });
  const output = parseLastJson(apply.stdout);
  if (fs.existsSync(path.join(isolated, 'sqlite', 'state.sqlite'))) fs.copyFileSync(path.join(isolated, 'sqlite', 'state.sqlite'), path.join(activeWriter.attemptRoot, 'rollback-applied.sqlite'));
  return { schema_version: 'aiws.v3-clean.p8-rollback-receipt.v2', status: dry.status === 0 && apply.status === 0 && output?.byte_exact_mismatches?.length === 0 ? 'passed' : 'failed', dry_run: { command: 'powershell -File rollback.ps1 -DryRun', stdout: redact(dry.stdout || ''), stderr: redact(dry.stderr || ''), exit_status: dry.status ?? 1 }, apply: { command: 'powershell -File rollback.ps1 -Apply -IsolatedRoot <TARGET>', stdout: redact(apply.stdout || ''), stderr: redact(apply.stderr || ''), exit_status: apply.status ?? 1, output } };
}

function rollbackPowerShell() {
  return `param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot=(Join-Path $PSScriptRoot 'rollback-isolated'))\n$ErrorActionPreference='Stop'\n$source=Join-Path $PSScriptRoot 'rollback-baseline'\nif($DryRun){$result=@{status='passed';mode='dry-run';source=(Split-Path $source -Leaf);target=(Split-Path $IsolatedRoot -Leaf);writes=0};$result|ConvertTo-Json -Compress;exit 0}\nif(-not $Apply){throw 'rollback_mode_required'}\n$resolvedRoot=[IO.Path]::GetFullPath($PSScriptRoot)\n$resolvedTarget=[IO.Path]::GetFullPath($IsolatedRoot)\nif(-not $resolvedTarget.StartsWith($resolvedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'rollback_target_outside_evidence'}\nif(Test-Path -LiteralPath $resolvedTarget){Remove-Item -LiteralPath $resolvedTarget -Recurse -Force}\nCopy-Item -LiteralPath $source -Destination $resolvedTarget -Recurse\nnode (Join-Path $PSScriptRoot 'rollback-verify.mjs') $resolvedTarget (Join-Path $PSScriptRoot 'rollback-manifest.json')\nexit $LASTEXITCODE\n`;
}

function rollbackVerifier() {
  return `import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';import{DatabaseSync}from'node:sqlite';const root=path.resolve(process.argv[2]);const manifest=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');const mismatches=manifest.files.filter(x=>!fs.existsSync(path.join(root,x.path))||hash(path.join(root,x.path))!==x.sha256).map(x=>x.path);const db=new DatabaseSync(path.join(root,'sqlite','state.sqlite'),{readOnly:true});const version=Number(db.prepare('PRAGMA user_version').get().user_version);const ledger=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x=>x.version);const fk=db.prepare('PRAGMA foreign_key_check').all();const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name);db.close();const p8=${JSON.stringify(p8Tables())}.filter(x=>names.includes(x));const result={status:version===7&&ledger.join(',')==='1,2,3,4,5,6,7'&&!fk.length&&!p8.length&&!mismatches.length?'passed':'failed',restored_user_version:version,ledger,foreign_keys:fk,p8_tables_present:p8,restored_components:manifest.files.map(x=>x.path.split('/')[0]),byte_exact_mismatches:mismatches};console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;`;
}

function preflight() {
  return { schema_version: 'aiws.v3-clean.p8-preflight.v2', phase: 'P8', generated_at: new Date().toISOString(), Target: 'P8 Delivery, Deployment, offline Importer, Backup/Restore, Operations replay and physical CAS GC over fixed P7 baseline', '目标': '完成 P8 本地行为、外部门禁候选证据与隔离回滚', 'Non-target': 'P9 Offline/Web release and production cutover', '非目标': 'P9、生产切换与缺少外部身份时的 Catalog 晋级', Forbidden: ['P1-P7 migration or verified Evidence edits', '/api/v1 runtime', 'second operation/event/CAS/head model', 'online importer writes', 'secret/token/full prompt/host absolute path in receipts'], '禁止项': ['修改已验证 P1-P7 工件', '伪造外部门禁或命令输出'], Reuse: ['P1-P7 operations/events/heads/CAS/Vault/ACL', 'Clean dispatcher and /api/v2', 'verified P7 baseline'], '复用项': ['统一账本、CAS、授权谓词和回滚模型'], 'Delete/retire': ['open p8.query/mutation/list/receipt schemas', 'Identity fallback for P8 routes'], '删除/退役': ['开放式 P8 contract 与错误 HTTP 分派'], Acceptance_commands: acceptanceCommands(focused).map((parts) => parts.join(' ')), '验收命令': 'P1-P8 gates, P5-P8 probes, Web, integration/security, build/E2E/release and diff check', Rollback_artifact: `${evidenceRelative}/rollback.ps1`, '回滚工件': `${evidenceRelative}/rollback.ps1`, active_object: 'P8 worktree', last_confirmed_result: 'focused P8 backend, importer, UI and local probes passed', next_action: 'run governed gates and publish candidate or final Evidence according to external receipts' };
}

function artifactRoles(attemptRoot) {
  return {
    modified_artifact: { path: 'modified-v8.sqlite', sha256: hash(path.join(attemptRoot, 'modified-v8.sqlite')) },
    patch: { path: 'change.patch', sha256: hash(path.join(attemptRoot, 'change.patch')) },
    verification_record: { path: 'verification-record.json', sha256: hash(path.join(attemptRoot, 'verification-record.json')) },
    rollback: { path: 'rollback.ps1', sha256: hash(path.join(attemptRoot, 'rollback.ps1')) }
  };
}

function attemptManifest(attemptRoot, verification) {
  const files = walkFiles(attemptRoot).filter((file) => path.basename(file) !== 'manifest.json').map((file) => ({ path: path.relative(attemptRoot, file).replaceAll('\\', '/'), sha256: hash(file), byte_length: fs.statSync(file).size }));
  return { schema_version: 'aiws.v3-clean.p8-evidence-manifest.v2', run_id: verification.run_id, status: verification.status, provisional: verification.provisional, files };
}

function publish(attemptRoot) {
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    if (entry.name === 'attempts') continue;
    fs.rmSync(path.join(out, entry.name), { recursive: true, force: true });
  }
  for (const source of walkFiles(attemptRoot)) {
    const relative = path.relative(attemptRoot, source);
    const target = path.join(out, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

function archivePublished(receipt) {
  const originalAttempt = path.join(out, 'attempts', String(receipt.run_id || ''));
  const publishedManifest = readJson(path.join(out, 'manifest.json'));
  if (receipt.run_id && fs.existsSync(originalAttempt) && Array.isArray(publishedManifest?.files)) {
    const matches = publishedManifest.files.every((entry) => {
      const published = path.join(out, entry.path);
      const archived = path.join(originalAttempt, entry.path);
      return fs.existsSync(published) && fs.existsSync(archived) && hash(published) === hash(archived);
    });
    if (matches) return originalAttempt;
  }
  let archive = path.join(out, 'attempts', `superseded-${receipt.status || 'candidate'}-${receipt.run_id || Date.now()}`);
  if (fs.existsSync(archive)) archive = `${archive}-${Date.now()}`;
  fs.mkdirSync(archive, { recursive: true });
  for (const source of walkFiles(out)) {
    const relative = path.relative(out, source);
    if (relative === 'attempts' || relative.startsWith(`attempts${path.sep}`)) continue;
    const target = path.join(archive, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  const files = walkFiles(archive).map((file) => ({ path: path.relative(archive, file).replaceAll('\\', '/'), sha256: hash(file) }));
  fs.writeFileSync(path.join(archive, 'archive-manifest.json'), `${JSON.stringify({ schema_version: 'aiws.v3-clean.p8-superseded-evidence.v1', run_id: receipt.run_id, status: receipt.status, files }, null, 2)}\n`, { flag: 'wx' });
}

function verifyPublished() {
  const receipt = readJson(finalFile);
  const manifest = readJson(path.join(out, 'manifest.json'));
  const failures = [];
  if (!receipt || !['candidate', 'verified'].includes(receipt.status)) failures.push('verification_status');
  if (!manifest || receipt?.run_id !== manifest?.run_id) failures.push('manifest_run_id');
  for (const artifact of manifest?.files || []) {
    const file = path.join(out, artifact.path);
    if (!fs.existsSync(file) || hash(file) !== artifact.sha256) failures.push(artifact.path);
  }
  if (receipt?.provisional === true && receipt?.catalog_promotion !== 'frozen-23/4/27') failures.push('candidate_catalog_status');
  if (receipt?.provisional === false && receipt?.status !== 'verified') failures.push('final_status');
  return { schema_version: 'aiws.v3-clean.p8-evidence-verify.v2', status: failures.length ? 'failed' : 'passed', provisional: receipt?.provisional ?? true, run_id: receipt?.run_id || null, catalog: receipt?.catalog || { clean: 23, historical: 4, total: 27 }, failures: [...new Set(failures)].sort() };
}

function scanAttempt(directory) {
  const findings = [];
  for (const file of walkFiles(directory)) {
    if (/\.(?:sqlite|bin|png|jpg|jpeg|webp)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/gh[opusr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|aiws_session=(?!\$\{|<)[A-Za-z0-9%._~-]{16,}/i.test(text)) findings.push(path.relative(directory, file));
  }
  return { schema_version: 'aiws.v3-clean.p8-secret-scan.v1', status: findings.length ? 'failed' : 'passed', findings };
}

function baselineInventory() {
  const result = spawnSync('git', ['ls-tree', '-r', '--full-tree', baselineCommit], { cwd: root, encoding: 'utf8' });
  return { schema_version: 'aiws.v3-clean.p8-original-hashes.v1', commit: baselineCommit, exit_status: result.status ?? 1, entries: result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => { const match = line.match(/^(\d+)\s+(\w+)\s+([a-f0-9]+)\t(.+)$/); return match ? { mode: match[1], type: match[2], object: match[3], path: match[4] } : { raw: line }; }) };
}

function worktreeInventory() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  const paths = listed.stdout.trim().split(/\r?\n/).filter(Boolean).filter((file) => !file.replaceAll('\\', '/').startsWith(`${evidenceRelative}/`) && fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile());
  return { schema_version: 'aiws.v3-clean.p8-modified-artifact.v1', baseline_commit: baselineCommit, files: paths.map((file) => ({ path: file.replaceAll('\\', '/'), sha256: hash(path.join(root, file)), byte_length: fs.statSync(path.join(root, file)).size })) };
}

function gitPatch() {
  const index = path.join(os.tmpdir(), `aiws-p8-evidence-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const read = spawnSync('git', ['read-tree', baselineCommit], { cwd: root, env, encoding: 'utf8' });
    if (read.status !== 0) throw new Error(`p8_patch_read_tree_failed:${read.stderr}`);
    const add = spawnSync('git', ['add', '-A', '--', '.', `:(exclude)${evidenceRelative}/**`], { cwd: root, env, encoding: 'utf8' });
    if (add.status !== 0) throw new Error(`p8_patch_add_failed:${add.stderr}`);
    const diff = spawnSync('git', ['diff', '--cached', '--binary', baselineCommit, '--', '.'], { cwd: root, env, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
    if (diff.status !== 0) throw new Error('p8_patch_diff_failed');
    return diff.stdout || Buffer.alloc(0);
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}
function p8Tables() { return Object.keys(CLEAN_P8_TABLE_OWNERS).filter((name) => ['delivery_policies', 'deliveries', 'pull_request_intents', 'delivery_events', 'deployment_candidates', 'deployment_verifications', 'backup_manifests', 'import_batches', 'import_checkpoints', 'import_id_map', 'import_conflicts'].includes(name)).sort(); }
function parseLastJson(value) { const text = String(value || '').trim(); for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) try { return JSON.parse(text.slice(index)); } catch { /* continue */ } return null; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function hash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function walkFiles(directory) { const output = []; if (!fs.existsSync(directory)) return output; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) output.push(...walkFiles(file)); else if (entry.isFile()) output.push(file); } return output.sort(); }
function redact(value) { return String(value || '').replaceAll(root, '<WORKSPACE>').replaceAll(root.replaceAll('\\', '/'), '<WORKSPACE>').replace(/gh[opusr]_[A-Za-z0-9]{20,}/g, '<REDACTED_TOKEN>').replace(/aiws_session=[^;<\s]+/gi, 'aiws_session=<REDACTED>'); }
