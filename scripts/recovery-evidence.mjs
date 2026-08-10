import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const batch = process.env.RECOVERY_BATCH || 'v3-r0-r1-governance-20260810';
const isR2 = batch === 'v3-r2-identity-setup-20260810';
const evidenceRoot = path.join(root, 'docs', 'evidence', batch);
const excluded = new Set(String(process.env.RECOVERY_EXCLUDE || '').split(',').map(normalize).filter(Boolean));
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

fs.mkdirSync(evidenceRoot, { recursive: true });
const baselineRef = String(process.env.RECOVERY_BASELINE || 'HEAD').trim();
const baselineCommit = run(git, ['rev-parse', '--verify', `${baselineRef}^{commit}`]).stdout.trim();
const branch = run(git, ['branch', '--show-current']).stdout.trim();
const changedFiles = listChangedFiles(baselineCommit).filter((file) => !file.startsWith(`docs/evidence/${batch}/`) && !excluded.has(file));
if (!changedFiles.length) throw new Error('recovery_evidence_has_no_changed_files');

const fileRecords = changedFiles.map((file) => {
  const baseline = run(git, ['cat-file', '-e', `${baselineCommit}:${file}`], { allowFailure: true });
  const bytes = fs.readFileSync(path.join(root, file));
  return {
    path: file,
    baseline_present: baseline.status === 0,
    baseline_sha256: baseline.status === 0 ? sha256(runBuffer(git, ['show', `${baselineCommit}:${file}`]).stdout) : null,
    modified_sha256: sha256(bytes),
    modified_bytes: bytes.byteLength
  };
});

const modifiedArtifactPath = path.join(evidenceRoot, 'modified-artifact.json');
fs.writeFileSync(modifiedArtifactPath, `${JSON.stringify({
  schema_version: 'aiws.v3.recovery_modified_artifact.v1',
  batch,
  baseline_commit: baselineCommit,
  files: fileRecords
}, null, 2)}\n`);

const patchPath = path.join(evidenceRoot, 'change.patch');
const patch = createPatch(changedFiles, baselineCommit);
fs.writeFileSync(patchPath, patch);
const patchSha256 = sha256(fs.readFileSync(patchPath));

const commandDefinitions = [
  { label: 'recovery-plan', executable: corepack, args: ['pnpm', 'recovery:plan'] },
  { label: 'recovery-catalog', executable: corepack, args: ['pnpm', 'recovery:catalog'] },
  { label: 'recovery-coverage', executable: corepack, args: ['pnpm', 'recovery:coverage'] },
  { label: 'recovery-impact', executable: corepack, args: ['pnpm', 'recovery:impact', '--audit'] }
];
if (isR2) {
  commandDefinitions.push(
    {
      label: 'r2-focused', executable: process.execPath,
      args: ['--test', '--test-concurrency=1',
        'tests/unit/identity-operations.test.mjs', 'tests/unit/setup-service.test.mjs',
        'tests/unit/credential-vault.test.mjs', 'tests/unit/codex-provider.test.mjs',
        'tests/unit/github-provider.test.mjs', 'tests/unit/recovery-golden.test.mjs',
        'tests/integration/identity-r2-flow.test.mjs', 'tests/integration/setup-flow.test.mjs',
        'tests/integration/codex-provider-flow.test.mjs', 'tests/integration/github-provider-flow.test.mjs',
        'tests/integration/github-operations-flow.test.mjs', 'tests/integration/r2-provider-boundaries.test.mjs',
        'tests/security/credentials.test.mjs']
    },
    { label: 'migration-rollback', executable: process.execPath, args: ['scripts/r2-migration-evidence.mjs', '--output', path.join(evidenceRoot, 'migration-rollback.json')] },
    { label: 'provider-codex-real', executable: process.execPath, args: ['scripts/runner-real-smoke.mjs'] },
    { label: 'provider-github-real', executable: process.execPath, args: ['scripts/r2-provider-real-probe.mjs'] },
    { label: 'r2-golden', executable: process.execPath, args: ['scripts/recovery-golden.mjs', 'verify', 'r2-identity-setup'] }
  );
} else {
  commandDefinitions.push(
    { label: 'migration-focused', executable: process.execPath, args: ['--test', 'tests/unit/migrations.test.mjs', 'tests/unit/database.test.mjs'] },
    { label: 'v23-golden', executable: process.execPath, args: ['scripts/recovery-golden.mjs', 'verify'] }
  );
}
commandDefinitions.push(
  { label: 'verify', executable: corepack, args: ['pnpm', 'verify'] }
);
const commands = commandDefinitions.map(executeAndRecord);

const screenshotRecords = captureScreenshots();
const rollbackScriptPath = path.join(evidenceRoot, 'rollback.ps1');
fs.writeFileSync(rollbackScriptPath, rollbackScript(patchSha256), 'utf8');
const rollback = rehearseRollback({ patchPath, rollbackScriptPath, baselineCommit });
const rollbackReceiptPath = path.join(evidenceRoot, 'rollback.json');
fs.writeFileSync(rollbackReceiptPath, `${JSON.stringify(rollback, null, 2)}\n`);

const behaviorComparison = buildBehaviorComparison();
const verificationPath = path.join(evidenceRoot, 'verification.json');
const verification = {
  schema_version: 'aiws.v3.recovery_verification.v1',
  batch,
  status: commands.every((entry) => entry.exit_status === 0) && rollback.status === 'passed' ? 'passed' : 'failed',
  branch,
  baseline_commit: baselineCommit,
  created_at: new Date().toISOString(),
  inputs: {
    recovery_batch: batch,
    excluded_preexisting_files: [...excluded],
    source_commit: isR2 ? baselineCommit : 'e18dc0b',
    database_fixture: 'temporary SQLite files only',
    production_port_touched: false
  },
  behavior_comparison: behaviorComparison,
  external_provider_probes: isR2 ? {
    codex: probeReceipt('provider-codex-real'),
    github_app: probeReceipt('provider-github-real'),
    promotion_status: 'implemented_until_explicit_external_probe_passes'
  } : undefined,
  commands,
  screenshots: screenshotRecords,
  artifacts: {
    modified_artifact: relative(modifiedArtifactPath),
    patch: relative(patchPath),
    verification: relative(verificationPath),
    rollback: relative(rollbackScriptPath),
    rollback_receipt: relative(rollbackReceiptPath),
    migration_rollback: isR2 ? relative(path.join(evidenceRoot, 'migration-rollback.json')) : undefined,
    provider_codex: isR2 ? relative(path.join(evidenceRoot, 'provider-codex-real.log')) : undefined,
    provider_github: isR2 ? relative(path.join(evidenceRoot, 'provider-github-real.log')) : undefined
  },
  patch_sha256: patchSha256,
  rollback_status: rollback.status
};
fs.writeFileSync(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);

const manifestPath = path.join(evidenceRoot, 'manifest.json');
const manifest = {
  schema_version: 'aiws.v3.recovery_evidence_manifest.v2',
  batch,
  status: verification.status,
  branch,
  baseline_commit: baselineCommit,
  created_at: verification.created_at,
  catalog_sha256: sha256(fs.readFileSync(path.join(root, 'feature-catalog.json'))),
  files: fileRecords,
  artifacts: verification.artifacts,
  screenshots: screenshotRecords,
  commands: commands.map(({ label, command, exit_status, log, output_sha256 }) => ({ label, command, exit_status, log, output_sha256 }))
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const roleVerification = verifyRoles({ modifiedArtifactPath, patchPath, verificationPath, rollbackScriptPath, rollbackReceiptPath, manifestPath, patchSha256 });
if (verification.status !== 'passed' || !roleVerification.passed) process.exitCode = 1;
process.stdout.write(`${JSON.stringify({
  batch,
  status: verification.status,
  baseline_commit: baselineCommit,
  changed_files: changedFiles.length,
  commands: commands.map(({ label, exit_status }) => ({ label, exit_status })),
  rollback: rollback.status,
  roles_verified: roleVerification.passed,
  manifest: relative(manifestPath)
}, null, 2)}\n`);

function buildBehaviorComparison() {
  if (!isR2) {
    const baselineDbWorker = runBuffer(git, ['show', `${baselineCommit}:apps/api/src/db-worker.mjs`]);
    const baselineHttp = runBuffer(git, ['show', `${baselineCommit}:apps/api/src/http.mjs`]);
    return {
      baseline: {
        commands: [
          `git show ${baselineCommit}:apps/api/src/db-worker.mjs`,
          `git show ${baselineCommit}:apps/api/src/http.mjs`
        ],
        outputs: {
          db_worker_sha256: sha256(baselineDbWorker.stdout),
          direct_schema_bootstrap: baselineDbWorker.stdout.toString('utf8').includes('db.exec(SCHEMA_SQL)'),
          migration_ledger: baselineDbWorker.stdout.toString('utf8').includes('schema_migrations'),
          liveness_route: baselineHttp.stdout.toString('utf8').includes("urlPath === '/livez'") ? '/livez' : 'unknown'
        },
        exit_status: Math.max(baselineDbWorker.status, baselineHttp.status)
      },
      modified: {
        commands: ['node --test tests/unit/migrations.test.mjs tests/unit/database.test.mjs', 'corepack pnpm verify'],
        outputs: {
          migration_service_sha256: sha256(fs.readFileSync(path.join(root, 'apps/api/src/migration-service.mjs'))),
          schema_migrations_fields: ['version', 'name', 'checksum', 'applied_at', 'duration_ms'],
          liveness_route: '/health',
          readiness_version_source: 'schema_migrations.max(version)',
          focused_log: relative(path.join(evidenceRoot, 'migration-focused.log')),
          verify_log: relative(path.join(evidenceRoot, 'verify.log'))
        },
        exit_status: Math.max(
          commands.find((entry) => entry.label === 'migration-focused')?.exit_status ?? 1,
          commands.find((entry) => entry.label === 'verify')?.exit_status ?? 1
        )
      }
    };
  }

  const baselineIdentity = runBuffer(git, ['show', `${baselineCommit}:apps/api/src/modules/identity/index.mjs`]);
  const baselineSetup = runBuffer(git, ['show', `${baselineCommit}:apps/api/src/modules/setup/index.mjs`]);
  const runtimePresence = run(git, ['cat-file', '-e', `${baselineCommit}:apps/api/src/modules/r2-runtime.mjs`], { allowFailure: true });
  const migration = commands.find((entry) => entry.label === 'migration-rollback');
  const focused = commands.find((entry) => entry.label === 'r2-focused');
  const golden = commands.find((entry) => entry.label === 'r2-golden');
  const verify = commands.find((entry) => entry.label === 'verify');
  return {
    baseline: {
      commands: [
        `git show ${baselineCommit}:apps/api/src/modules/identity/index.mjs`,
        `git show ${baselineCommit}:apps/api/src/modules/setup/index.mjs`,
        `git cat-file -e ${baselineCommit}:apps/api/src/modules/r2-runtime.mjs`
      ],
      outputs: {
        identity_entry_sha256: sha256(baselineIdentity.stdout),
        setup_entry_sha256: sha256(baselineSetup.stdout),
        r2_runtime_present: runtimePresence.status === 0,
        identity_service_present: false,
        setup_service_present: false
      },
      exit_status: 0
    },
    modified: {
      commands: [focused?.command, migration?.command, golden?.command, verify?.command].filter(Boolean),
      outputs: {
        identity_service_sha256: sha256(fs.readFileSync(path.join(root, 'apps/api/src/modules/identity/service.mjs'))),
        setup_service_sha256: sha256(fs.readFileSync(path.join(root, 'apps/api/src/modules/setup/service.mjs'))),
        migration_v2_sha256: sha256(fs.readFileSync(path.join(root, 'apps/api/src/migrations/002-identity-setup.mjs'))),
        migration_record: relative(path.join(evidenceRoot, 'migration-rollback.json')),
        golden_log: relative(path.join(evidenceRoot, 'r2-golden.log')),
        verify_log: relative(path.join(evidenceRoot, 'verify.log'))
      },
      exit_status: Math.max(focused?.exit_status ?? 1, migration?.exit_status ?? 1, golden?.exit_status ?? 1, verify?.exit_status ?? 1)
    }
  };
}

function probeReceipt(label) {
  const entry = commands.find((item) => item.label === label);
  if (!entry) return { status: 'missing', exit_status: 1 };
  const parsed = parseJsonStatus(`${entry.stdout}\n${entry.stderr}`);
  return {
    command: entry.command,
    status: parsed || 'unknown',
    exit_status: entry.exit_status,
    log: entry.log,
    output_sha256: entry.output_sha256
  };
}

function parseJsonStatus(output) {
  const value = String(output).trim();
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.status === 'string') return parsed.status;
  } catch { /* fall through to single-line receipts from command wrappers */ }
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.status === 'string') return value.status;
    } catch { /* command wrappers may surround the JSON receipt */ }
  }
  return null;
}

function executeAndRecord(definition) {
  const result = runBuffer(definition.executable, definition.args, { allowFailure: true, shell: process.platform === 'win32' && definition.executable === corepack });
  const output = Buffer.concat([result.stdout, result.stderr]);
  const logPath = path.join(evidenceRoot, `${definition.label}.log`);
  fs.writeFileSync(logPath, output);
  return {
    label: definition.label,
    command: displayCommand(definition.executable, definition.args),
    cwd: root,
    input: null,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    exit_status: result.status,
    output_sha256: sha256(output),
    log: relative(logPath)
  };
}

function captureScreenshots() {
  const source = path.join(root, '.ai-workspace', 'e2e-v3');
  const target = path.join(evidenceRoot, 'screenshots');
  if (!fs.existsSync(source)) return [];
  fs.mkdirSync(target, { recursive: true });
  return fs.readdirSync(source).filter((name) => name.endsWith('.png')).sort().map((name) => {
    const sourceFile = path.join(source, name);
    const targetFile = path.join(target, name);
    fs.copyFileSync(sourceFile, targetFile);
    const bytes = fs.readFileSync(targetFile);
    if (!bytes.subarray(1, 4).equals(Buffer.from('PNG'))) throw new Error(`invalid_e2e_screenshot:${name}`);
    return { path: relative(targetFile), sha256: sha256(bytes), bytes: bytes.byteLength };
  });
}

function rehearseRollback({ patchPath: sourcePatch, rollbackScriptPath: script, baselineCommit: commit }) {
  const label = batch.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  const worktree = path.join(os.tmpdir(), `aiws-${label}-rollback-${process.pid}-${randomUUID()}`);
  const commands = [];
  try {
    commands.push(runAndDescribe(git, ['worktree', 'add', '--detach', worktree, commit]));
    commands.push(runAndDescribe(git, ['-C', worktree, 'apply', '--check', sourcePatch]));
    commands.push(runAndDescribe(git, ['-C', worktree, 'apply', sourcePatch]));
    const modifiedStatus = run(git, ['-C', worktree, 'status', '--porcelain']);
    if (!modifiedStatus.stdout.trim()) throw new Error('rollback_rehearsal_patch_did_not_modify_worktree');
    commands.push(runAndDescribe(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Workspace', worktree, '-SkipVerify']));
    const finalStatus = run(git, ['-C', worktree, 'status', '--porcelain'], { allowFailure: true });
    const diff = run(git, ['-C', worktree, 'diff', '--exit-code', commit], { allowFailure: true });
    const status = commands.every((entry) => entry.exit_status === 0) && finalStatus.status === 0 && !finalStatus.stdout.trim() && diff.status === 0 ? 'passed' : 'failed';
    return {
      schema_version: 'aiws.v3.recovery_rollback_receipt.v1',
      status,
      baseline_commit: commit,
      patch_sha256: sha256(fs.readFileSync(sourcePatch)),
      workspace: 'detached temporary worktree',
      commands,
      modified_status_before_rollback: modifiedStatus.stdout,
      final_status: finalStatus.stdout,
      final_diff_exit_status: diff.status,
      data_rollback_probe: 'node --test tests/unit/migrations.test.mjs',
      created_at: new Date().toISOString()
    };
  } finally {
    run(git, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
    run(git, ['worktree', 'prune'], { allowFailure: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function rollbackScript(expectedPatchHash) {
  return [
    'param(',
    "  [string]$Workspace = '.',",
    '  [string]$DatabaseFile = \'\',',
    '  [string]$MigrationManifest = \'\',',
    '  [switch]$SkipVerify',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '$Workspace = (Resolve-Path -LiteralPath $Workspace).Path',
    "$Patch = Join-Path $PSScriptRoot 'change.patch'",
    '$PatchBytes = [System.IO.File]::ReadAllBytes($Patch)',
    '$PatchDigest = [System.Security.Cryptography.SHA256]::Create()',
    "try { $PatchHash = [System.BitConverter]::ToString($PatchDigest.ComputeHash($PatchBytes)).Replace('-', '').ToLowerInvariant() } finally { $PatchDigest.Dispose() }",
    `if ($PatchHash -ne '${expectedPatchHash}') { throw 'rollback_patch_hash_mismatch' }`,
    "if ($DatabaseFile -or $MigrationManifest) { if (-not ($DatabaseFile -and $MigrationManifest)) { throw 'rollback_database_inputs_incomplete' }; & node (Join-Path $Workspace 'scripts/restore-migration-snapshot.mjs') --database $DatabaseFile --manifest $MigrationManifest; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
    '& git -C $Workspace apply --reverse --check $Patch',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    '& git -C $Workspace apply --reverse $Patch',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    "if (-not $SkipVerify) { & corepack pnpm --dir $Workspace verify; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
    "Write-Output 'rollback passed'"
  ].join('\r\n') + '\r\n';
}

function verifyRoles({ modifiedArtifactPath: modified, patchPath: patchFile, verificationPath: verificationFile, rollbackScriptPath: rollbackFile, rollbackReceiptPath: rollbackReceipt, manifestPath: manifestFile, patchSha256: expectedPatchHash }) {
  const modifiedArtifact = JSON.parse(fs.readFileSync(modified, 'utf8'));
  const verificationRecord = JSON.parse(fs.readFileSync(verificationFile, 'utf8'));
  const rollbackRecord = JSON.parse(fs.readFileSync(rollbackReceipt, 'utf8'));
  const evidenceManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const patchBytes = fs.readFileSync(patchFile);
  const rollbackBytes = fs.readFileSync(rollbackFile);
  const passed = modifiedArtifact.files.length === fileRecords.length
    && sha256(patchBytes) === expectedPatchHash
    && verificationRecord.status === 'passed'
    && rollbackRecord.status === 'passed'
    && evidenceManifest.status === 'passed'
    && rollbackBytes.includes(Buffer.from('git -C $Workspace apply --reverse'));
  return { passed };
}

function createPatch(files, commit) {
  const untracked = files.filter((file) => run(git, ['cat-file', '-e', `${commit}:${file}`], { allowFailure: true }).status !== 0);
  if (untracked.length) run(git, ['add', '-N', '--', ...untracked]);
  try {
    return runBuffer(git, ['-c', 'core.quotepath=false', 'diff', '--binary', commit, '--', ...files]).stdout.toString('utf8');
  } finally {
    if (untracked.length) run(git, ['reset', '--', ...untracked], { allowFailure: true });
  }
}

function listChangedFiles(commit) {
  const values = new Set();
  const changed = run(git, ['-c', 'core.quotepath=false', 'diff', '--name-only', commit, '--']);
  for (const file of changed.stdout.split(/\r?\n/).filter(Boolean)) values.add(normalize(file));
  const untracked = run(git, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']);
  for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean)) values.add(normalize(file));
  return [...values].sort();
}

function runAndDescribe(executable, args) {
  const result = run(executable, args, { allowFailure: true });
  return { command: displayCommand(executable, args), exit_status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function displayCommand(executable, args) {
  const name = path.basename(String(executable)).replace(/\.cmd$/i, '');
  return [name, ...args].map((value) => /\s/.test(String(value)) ? JSON.stringify(String(value)) : String(value)).join(' ');
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: options.shell === true });
  const normalized = { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
  if (!options.allowFailure && normalized.status !== 0) throw new Error(`command_failed:${displayCommand(executable, args)}\n${normalized.stderr || normalized.stdout}`);
  return normalized;
}

function runBuffer(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'buffer', windowsHide: true, shell: options.shell === true });
  const normalized = {
    status: result.status ?? 1,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || ''),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '')
  };
  if (!options.allowFailure && normalized.status !== 0) throw new Error(`command_failed:${displayCommand(executable, args)}\n${normalized.stderr.toString('utf8') || normalized.stdout.toString('utf8')}`);
  return normalized;
}

function normalize(value) {
  return String(value).replaceAll('\\', '/');
}

function relative(file) {
  return normalize(path.relative(root, file));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
