// Owner: Platform Governance and Operations. Phase: D-040 post-P10 maintenance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runGateCommand, executableInvocation } from '../../../scripts/lib/gate-process.mjs';

const evidence = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(evidence, '../../..');
const relativeEvidence = path.relative(root, evidence).replaceAll('\\', '/');
const baseline = '5f2be38845d36236637c7f22a1b4df5611a6175b';
const local = path.join(root, '.ai-workspace', 'post-p10-maintenance');
const commands = [];
const args = process.argv.slice(2);
if (args[0] === '--rollback') {
  await rollback(args[2], args[1] === '--apply');
} else if (args[0] === '--verify') {
  verifyPackage();
} else {
  await buildPackage();
}

async function buildPackage() {
  if (fs.existsSync(path.join(evidence, 'verification.json'))) throw new Error('maintenance_final_already_exists');
  const attempt = path.join(local, `package-${Date.now()}`);
  const stage = path.join(attempt, 'modified');
  const isolated = path.join(attempt, 'isolated-clone');
  fs.mkdirSync(stage, { recursive: true });
  for (const name of ['original-hashes.json', 'change.patch', 'modified-artifact.tgz']) {
    if (fs.existsSync(path.join(evidence, name))) fs.copyFileSync(path.join(evidence, name), path.join(attempt, `prior-${name}`));
  }
  const names = git(root, ['diff', '-z', '--name-only', '--no-renames', baseline, '--', '.', `:(exclude)${relativeEvidence}/**`]).toString('utf8').split('\0').filter(Boolean).sort();
  const originals = [];
  for (const name of names) {
    const file = child(root, name);
    const old = git(root, ['show', `${baseline}:${name}`], true);
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (bytes) {
      const target = child(stage, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    originals.push({ path: name, original_sha256: old ? hash(old) : null, modified_sha256: bytes ? hash(bytes) : null });
  }
  write('original-hashes.json', { schema_version: 'aiws.maintenance-originals.v1', owner: 'Platform', phase: 'post-P10', baseline_commit: baseline, implementation_commit: git(root, ['rev-parse', 'HEAD']).toString().trim(), files: originals });
  const patch = git(root, ['diff', '--binary', '--no-ext-diff', baseline, '--', '.', `:(exclude)${relativeEvidence}/**`]);
  write('change.patch', patch);
  await run('tar', ['-czf', path.join(evidence, 'modified-artifact.tgz'), '-C', stage, '.']);
  const unpacked = path.join(attempt, 'reopened');
  fs.mkdirSync(unpacked);
  await run('tar', ['-xzf', path.join(evidence, 'modified-artifact.tgz'), '-C', unpacked]);
  for (const item of originals.filter((item) => item.modified_sha256)) {
    if (hashFile(child(unpacked, item.path)) !== item.modified_sha256) throw new Error(`artifact_reopen_mismatch:${item.path}`);
  }
  await run('git', ['clone', '--shared', '--no-checkout', root, isolated]);
  git(isolated, ['config', 'core.autocrlf', 'false']);
  await run('git', ['-C', isolated, 'checkout', '--detach', baseline]);
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const baselineRun = await run('node', ['scripts/recovery-golden.mjs', 'verify', 'r5-context-projection-mcp'], { cwd: isolated, expected: [1] });
  if (!baselineRun.output.stderr.includes('r5_golden_source_changed:scripts/mcp-stdio.mjs')) throw new Error('baseline_golden_failure_not_reproduced');
  await run('git', ['-C', isolated, 'apply', '--check', path.join(evidence, 'change.patch')]);
  await run('git', ['-C', isolated, 'apply', path.join(evidence, 'change.patch')]);
  // Restore exact packaged worktree bytes after Git's platform EOL handling.
  for (const item of originals.filter((item) => item.modified_sha256)) fs.copyFileSync(child(unpacked, item.path), child(isolated, item.path));
  const modifiedRun = await run('node', ['scripts/recovery-golden.mjs', 'verify', 'r5-context-projection-mcp'], { cwd: isolated });
  const result = JSON.parse(modifiedRun.output.stdout);
  if (result.status !== 'passed' || JSON.stringify(result.batches[0].source_drift) !== '["scripts/mcp-stdio.mjs"]') throw new Error('modified_golden_behavior_invalid');
  const roundFile = latestRound();
  const round = JSON.parse(fs.readFileSync(roundFile, 'utf8'));
  const stateSource = child(root, round.runtime_home);
  const snapshot = path.join(attempt, 'state-snapshot');
  copyTree(stateSource, snapshot);
  copyTree(snapshot, path.join(isolated, 'state'));
  const frozenBefore = treeHash(path.join(isolated, 'docs', 'evidence'));
  const marker = { baseline_commit: baseline, state_snapshot: snapshot, state_sha256: treeHash(snapshot), evidence_sha256: frozenBefore, patch_sha256: hash(patch) };
  fs.writeFileSync(path.join(isolated, '.post-p10-rollback-sandbox'), JSON.stringify(marker));
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const common = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidence, 'rollback.ps1'), '-IsolatedRoot', isolated];
  const dry = await run(shell, [...common, '-DryRun']);
  fs.writeFileSync(path.join(isolated, 'state', 'rollback-mutation.fixture'), 'isolated mutation\n');
  const apply = await run(shell, [...common, '-Apply']);
  const rollbackResult = JSON.parse(apply.output.stdout.trim());
  if (rollbackResult.status !== 'passed' || rollbackResult.byte_exact_mismatches.length) throw new Error('maintenance_rollback_failed');
  const saved = readCapturedCommands();
  const formal = lastResult(saved, 'aiws.v3-clean.verify-result.v3');
  const development = lastResult(saved, 'aiws.v3-clean.dev-verification.v1');
  const verification = {
    schema_version: 'aiws.post-p10-maintenance-verification.v1', owner: 'Platform Governance and Operations', phase: 'post-P10',
    status: round.status === 'passed' ? 'verified' : 'partial', provisional: round.status !== 'passed',
    baseline_commit: baseline, implementation_commit: git(root, ['rev-parse', 'HEAD']).toString().trim(),
    generated_at: new Date().toISOString(), preflight: fs.readFileSync(path.join(evidence, 'preflight.txt'), 'utf8'),
    catalog_status: '27/0/27', catalog_promotion: false, production_mutation: false,
    commands: [...saved, ...commands],
    performance: {
      baseline_ms: 549714, baseline_source: 'user-provided-measurement',
      formal: { status: formal.status, duration_ms: formal.duration_ms, target_ms: 360000, passed: formal.status === 'passed' && formal.duration_ms <= 360000, reduction_percent: Math.round((1 - formal.duration_ms / 549714) * 10000) / 100 },
      development: { status: development.status, duration_ms: development.duration_ms, target_ms: 120000, passed: development.status === 'passed' && development.duration_ms <= 120000 }
    },
    baseline_behavior: { command: baselineRun.command, args: baselineRun.args, exit_status: baselineRun.exit_status, error_code: 'r5_golden_source_changed:scripts/mcp-stdio.mjs' },
    modified_behavior: { status: result.status, source_drift: result.batches[0].source_drift, exit_status: modifiedRun.exit_status },
    artifact_reopen: { status: 'passed', files_checked: originals.filter((item) => item.modified_sha256).length },
    rollback: { status: 'passed', dry_run: dry, actual_apply: apply, ...rollbackResult },
    round2: { project_id: round.project_id, generation_id: round.generation_id, status: round.status, blockers: round.blockers, not_executed: round.not_executed },
    remaining: round.status === 'passed' ? [] : ['DesignSignal Round 2 business execution and downstream delivery remain blocked; see round2.json.']
  };
  write('round2.json', round);
  if (round.development_receipt) write('development-receipt.json', fs.readFileSync(child(root, round.development_receipt)));
  write('verification.json', verification);
  const files = fs.readdirSync(evidence).filter((name) => name !== 'manifest.json').sort();
  write('manifest.json', { schema_version: 'aiws.maintenance-artifact-manifest.v1', owner: 'Platform Governance', phase: 'post-P10', files: files.map((name) => ({ path: name, sha256: hashFile(path.join(evidence, name)), byte_length: fs.statSync(path.join(evidence, name)).size })) });
  verifyPackage();
}

async function rollback(isolatedRoot, apply) {
  const target = fs.realpathSync(path.resolve(isolatedRoot));
  if (target === root || target.startsWith(root + path.sep) && !target.startsWith(local + path.sep)) throw new Error('rollback_target_not_isolated');
  const marker = JSON.parse(fs.readFileSync(path.join(target, '.post-p10-rollback-sandbox'), 'utf8'));
  if (marker.baseline_commit !== baseline || hashFile(path.join(evidence, 'change.patch')) !== marker.patch_sha256) throw new Error('rollback_baseline_or_patch_invalid');
  const inventory = JSON.parse(fs.readFileSync(path.join(evidence, 'original-hashes.json'), 'utf8'));
  for (const item of inventory.files) {
    const file = child(target, item.path);
    if (item.modified_sha256 && hashFile(file) !== item.modified_sha256) throw new Error(`rollback_modified_hash_mismatch:${item.path}`);
  }
  git(target, ['apply', '--reverse', '--check', path.join(evidence, 'change.patch')]);
  if (!apply) { console.log(JSON.stringify({ status: 'passed', mode: 'dry-run', files_checked: inventory.files.length, byte_exact_mismatches: [] })); return; }
  git(target, ['apply', '--reverse', path.join(evidence, 'change.patch')]);
  for (const item of inventory.files.filter((item) => item.original_sha256)) fs.writeFileSync(child(target, item.path), git(target, ['show', `${baseline}:${item.path}`]));
  const snapshot = fs.realpathSync(marker.state_snapshot);
  if (!snapshot.startsWith(path.dirname(target) + path.sep) || treeHash(snapshot) !== marker.state_sha256) throw new Error('rollback_snapshot_invalid');
  const state = child(target, 'state');
  if (fs.lstatSync(state).isSymbolicLink()) throw new Error('rollback_state_symlink');
  fs.rmSync(state, { recursive: true, force: true });
  copyTree(snapshot, state);
  const mismatches = inventory.files.filter((item) => item.original_sha256 ? hashFile(child(target, item.path)) !== item.original_sha256 : fs.existsSync(child(target, item.path))).map((item) => item.path);
  if (treeHash(state) !== marker.state_sha256) mismatches.push('state');
  if (treeHash(path.join(target, 'docs', 'evidence')) !== marker.evidence_sha256) mismatches.push('published-evidence');
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-rollback-db-'));
  const database = path.join(probe, 'state.sqlite');
  fs.copyFileSync(path.join(state, 'data', 'state.sqlite'), database);
  const db = new DatabaseSync(database, { readOnly: true });
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const ledger = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
  db.close(); fs.rmSync(probe, { recursive: true, force: true });
  if (version !== 9 || JSON.stringify(ledger) !== '[1,2,3,4,5,6,7,8,9]') mismatches.push('schema');
  console.log(JSON.stringify({ status: mismatches.length ? 'failed' : 'passed', mode: 'actual-apply', restored_code_commit: git(target, ['rev-parse', 'HEAD']).toString().trim(), restored_user_version: version, ledger, preserved_roles: ['sqlite', 'cas', 'vault', 'workspace', 'catalog', 'published-evidence'], byte_exact_mismatches: mismatches }));
  if (mismatches.length) process.exitCode = 1;
}

function verifyPackage() {
  const manifest = JSON.parse(fs.readFileSync(path.join(evidence, 'manifest.json'), 'utf8'));
  const names = fs.readdirSync(evidence).filter((name) => name !== 'manifest.json').sort();
  if (JSON.stringify(names) !== JSON.stringify(manifest.files.map((item) => item.path).sort())) throw new Error('maintenance_manifest_inventory_mismatch');
  for (const item of manifest.files) if (hashFile(child(evidence, item.path)) !== item.sha256) throw new Error(`maintenance_manifest_hash:${item.path}`);
  const verification = JSON.parse(fs.readFileSync(path.join(evidence, 'verification.json'), 'utf8'));
  if (verification.rollback?.status !== 'passed' || verification.artifact_reopen?.status !== 'passed') throw new Error('maintenance_receipt_verification_failed');
  console.log(JSON.stringify({ status: 'passed', receipt_status: verification.status, artifact_roles: ['modified-artifact.tgz', 'change.patch', 'verification.json', 'rollback.ps1'], files_checked: names.length, byte_exact_mismatches: verification.rollback.byte_exact_mismatches }));
}

async function run(command, args, options = {}) {
  process.stderr.write(`maintenance_command:${command}:${args[0]}\n`);
  const result = await runGateCommand(executableInvocation(command === 'node' ? process.execPath : command, args), { cwd: options.cwd || root, workspaceRoot: root, cwdRole: options.cwd ? 'isolated-clone' : 'repository-root', stdout: false, stderr: false, timeoutMs: 600_000, maxCaptureBytes: 32 * 1024 * 1024 });
  commands.push(result);
  const debug = path.join(local, 'packaging-debug');
  fs.mkdirSync(debug, { recursive: true });
  fs.writeFileSync(path.join(debug, `${Date.now()}-${process.pid}-${commands.length}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
  if (!(options.expected || [0]).includes(result.exit_status)) throw new Error(`maintenance_command_failed:${command}:${result.error_code}`);
  return result;
}
function git(cwd, args, optional = false) {
  const result = spawnSync('git', args, { cwd, encoding: null, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) { if (optional) return null; throw new Error(`maintenance_git_failed:${args[0]}`); }
  return result.stdout;
}
function child(parent, relative) {
  const target = path.resolve(parent, relative);
  if (!relative || path.isAbsolute(relative) || !target.startsWith(path.resolve(parent) + path.sep)) throw new Error('maintenance_path_invalid');
  return target;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function hashFile(file) { return hash(fs.readFileSync(file)); }
function treeHash(directory) {
  const rows = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('maintenance_tree_symlink');
      if (item.isDirectory()) walk(file);
      else rows.push([path.relative(directory, file).replaceAll('\\', '/'), hashFile(file)]);
    }
  };
  walk(directory);
  return hash(JSON.stringify(rows));
}
function write(name, value) {
  const target = child(evidence, name);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (fs.existsSync(target) && fs.readFileSync(target).equals(bytes)) return;
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
}
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('maintenance_copy_symlink');
    if (item.isDirectory()) copyTree(path.join(source, item.name), path.join(target, item.name));
    else fs.copyFileSync(path.join(source, item.name), path.join(target, item.name));
  }
}
function readCapturedCommands() { const dir = path.join(local, 'commands'); return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); }
function latestRound() {
  const names = fs.readdirSync(local).filter((name) => name.startsWith('round2-') && fs.existsSync(path.join(local, name, 'round2.json'))).sort();
  if (!names.length) throw new Error('round2_receipt_required');
  const directory = path.join(local, names.at(-1));
  const receipts = fs.readdirSync(directory).filter((name) => /^round2(?:-\d+)?\.json$/.test(name))
    .sort((a, b) => fs.statSync(path.join(directory, a)).mtimeMs - fs.statSync(path.join(directory, b)).mtimeMs);
  return path.join(directory, receipts.at(-1));
}
function lastResult(records, schema) {
  const matches = [];
  for (const record of records) {
    const output = String(record.output?.stdout || '');
    for (let index = output.indexOf('{'); index >= 0; index = output.indexOf('{', index + 1)) {
      try {
        const value = JSON.parse(output.slice(index, output.lastIndexOf('}') + 1));
        if (value.schema_version === schema) matches.push({ time: record.started_at, value });
      } catch { /* command prelude or nested JSON */ }
    }
  }
  if (!matches.length) throw new Error(`maintenance_command_result_missing:${schema}`);
  return matches.sort((a, b) => String(a.time).localeCompare(String(b.time))).at(-1).value;
}
