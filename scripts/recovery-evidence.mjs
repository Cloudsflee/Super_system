import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const batch = process.env.RECOVERY_BATCH || 'v3-feature-restore-20260807';
const evidenceRoot = path.join(root, 'docs', 'evidence', batch);
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

fs.mkdirSync(evidenceRoot, { recursive: true });
const baselineCommit = run(git, ['rev-parse', 'HEAD']).stdout.toString('utf8').trim();
const changedFiles = listChangedFiles().filter((file) => !file.startsWith(`docs/evidence/${batch}/`));
const fileRecords = changedFiles.map((file) => ({
  path: file,
  baseline_sha256: trackedAtBaseline(file) ? sha256(run(git, ['show', `${baselineCommit}:${file}`]).stdout) : null,
  modified_sha256: sha256(fs.readFileSync(path.join(root, file))),
  baseline_present: trackedAtBaseline(file)
}));

const testCommands = [
  ['recovery-plan', ['recovery:plan']],
  ['recovery-catalog', ['recovery:catalog']],
  ['recovery-coverage', ['recovery:coverage']],
  ['recovery-impact', ['recovery:impact', '--audit']],
  ['verify', ['verify']]
];
const testResults = [];
for (const [label, args] of testCommands) {
  const result = run(pnpm, args, { shell: true });
  const logPath = path.join(evidenceRoot, `${label}.log`);
  fs.writeFileSync(logPath, `${result.stdout}${result.stderr}`);
  testResults.push({
    label,
    command: `pnpm ${args.join(' ')}`,
    log: path.relative(root, logPath).replaceAll('\\', '/'),
    exit_status: result.status,
    output_tail: `${result.stdout}${result.stderr}`.trim().split(/\r?\n/).slice(-8).join('\n')
  });
  if (result.status !== 0) process.exitCode = 1;
}

const diffResult = includeIntentToAdd(changedFiles);
fs.writeFileSync(path.join(evidenceRoot, 'working-tree.patch'), diffResult.patch);
if (diffResult.cleanupStatus !== 0) process.exitCode = 1;

const manifest = {
  schema_version: 'aiws.v3.recovery_evidence_manifest.v1',
  batch,
  branch: run(git, ['branch', '--show-current']).stdout.toString('utf8').trim(),
  baseline_commit: baselineCommit,
  implementation_commit: null,
  created_at: new Date().toISOString(),
  files: fileRecords,
  diff: 'docs/evidence/' + batch + '/working-tree.patch',
  tests: testResults,
  rollback: {
    command: 'git revert --no-edit <implementation_commit>',
    script: 'docs/evidence/' + batch + '/rollback.ps1',
    note: 'Run from the recovery branch after replacing <implementation_commit> with the recorded implementation commit.'
  }
};
fs.writeFileSync(path.join(evidenceRoot, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(evidenceRoot, 'rollback.ps1'), [
  'param([Parameter(Mandatory=$true)][string]$Commit)',
  '$branch = git branch --show-current',
  'if ($branch -ne "recovery/v3-feature-restore") { throw "Run rollback on recovery/v3-feature-restore" }',
  'git revert --no-edit $Commit',
  'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  'pnpm verify'
].join('\r\n') + '\r\n');

process.stdout.write(`${JSON.stringify({ batch, baselineCommit, changedFiles: changedFiles.length, tests: testResults.map(({ label, exit_status }) => ({ label, exit_status })) }, null, 2)}\n`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'buffer', windowsHide: true, ...options });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  return { status: result.status ?? 1, stdout, stderr };
}

function listChangedFiles() {
  const tracked = run(git, ['-c', 'core.quotepath=false', 'diff', '--name-only']).stdout.toString('utf8');
  const staged = run(git, ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only']).stdout.toString('utf8');
  const untracked = run(git, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']).stdout.toString('utf8');
  return [...new Set(`${tracked}\n${staged}\n${untracked}`.split(/\r?\n/).filter(Boolean).map((file) => file.replaceAll('\\', '/')))];
}

function trackedAtBaseline(file) {
  const result = run(git, ['cat-file', '-e', `${baselineCommit}:${file}`]);
  return result.status === 0;
}

function includeIntentToAdd(files) {
  const untracked = files.filter((file) => !trackedAtBaseline(file));
  let addStatus = 0;
  if (untracked.length) addStatus = run(git, ['add', '-N', '--', ...untracked]).status;
  const diff = run(git, ['-c', 'core.quotepath=false', 'diff', '--binary', baselineCommit]).stdout.toString('utf8');
  let cleanupStatus = 0;
  if (untracked.length) cleanupStatus = run(git, ['reset', '--', ...untracked]).status;
  return { patch: diff, addStatus, cleanupStatus };
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
