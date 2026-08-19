import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';
import { CLEAN_MIGRATIONS } from '../apps/api/src/clean/schema.mjs';
import { CLEAN_COMMAND_OWNERS, CLEAN_EVENT_OWNERS, CLEAN_TABLE_OWNERS } from '../apps/api/src/clean/ownership.mjs';
import { registryParity } from '../apps/api/src/clean/registry.mjs';
import { auditWorkspace, evidenceCompletionFindings, governedWorkspaceFiles, workspaceScopeFiles } from './v3-clean-workspace-audit.mjs';
import {
  P1_BASELINE_DIRECTORY,
  P1_EVIDENCE_DIRECTORY,
  P1_EVIDENCE_REQUIRED_FILES,
  P1_GATE_SYNC_CATALOG_PATHS,
  P1_GATE_SYNC_COMMANDS,
  P1_GATE_SYNC_DOCUMENTS,
  P1_GATE_SYNC_RULES,
  P1_MATRIX_ROWS,
  P1_PARENT_EVIDENCE_DIRECTORY,
  classifyWorkspacePath
} from './lib/v3-clean-p1-scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const evidence = path.resolve(root, outputArgument ? outputArgument.slice('--output='.length) : P1_EVIDENCE_DIRECTORY);
const baseline = path.resolve(root, P1_BASELINE_DIRECTORY);
const parentEvidence = path.resolve(root, P1_PARENT_EVIDENCE_DIRECTORY);
const verifyOnly = process.argv.includes('--verify');
const required = P1_EVIDENCE_REQUIRED_FILES;
const generationEnv = { AIWS_P1_EVIDENCE_GENERATING: '1' };

if (verifyOnly) {
  process.exitCode = verifyEvidence();
} else {
  try {
    await generateEvidence();
  } catch (error) {
    if (fs.existsSync(evidence)) {
      fs.writeFileSync(path.join(evidence, 'failure.json'), `${JSON.stringify({
        schema_version: 'aiws.v3-clean.completion-audit-failure.v1',
        status: 'failed',
        failed_at: new Date().toISOString(),
        error: sanitize(error?.stack || error?.message || error)
      }, null, 2)}\n`);
    }
    process.stderr.write(`${sanitize(error?.stack || error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

async function generateEvidence() {
  if (!fs.existsSync(baseline)) throw new Error(`baseline_missing:${relative(baseline)}`);
  if (!fs.existsSync(parentEvidence)) throw new Error(`parent_evidence_missing:${relative(parentEvidence)}`);
  if (fs.existsSync(evidence) && fs.readdirSync(evidence).length) throw new Error(`evidence_exists:${relative(evidence)}`);
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });

  await generatePlatformArtifacts();
  const workspaceAudit = auditWorkspace({ root, verifyEvidence: false });
  if (!workspaceAudit.valid) throw new Error(`workspace_audit_failed:${workspaceAudit.findings.map((entry) => entry.code).join(',')}`);
  writeJson('workspace-audit.json', workspaceAudit);

  const architecture = run('node', ['scripts/v3-clean-architecture-scan.mjs'], { timeout: 120000, env: generationEnv });
  if (!architecture.ok) throw new Error(`architecture_scan_failed:${architecture.stderr}`);
  const architectureResult = JSON.parse(architecture.stdout);
  if (!architectureResult.valid) throw new Error('architecture_scan_invalid');
  writeJson('architecture-scan.json', architectureResult);

  const baselineReceiptFile = path.join(baseline, 'original-hashes.json');
  const baselineReceipt = readJson(baselineReceiptFile);
  writeJson('original-hashes.json', {
    schema_version: 'aiws.v3-clean.completion-audit-original.v1',
    source_receipt: `${P1_BASELINE_DIRECTORY}/original-hashes.json`,
    source_receipt_sha256: hashFile(baselineReceiptFile),
    baseline_commit: baselineReceipt.baseline_commit,
    captured_at: baselineReceipt.captured_at,
    scope: baselineReceipt.scope,
    files: baselineReceipt.files
  });

  const workspaceFiles = governedWorkspaceFiles(root);
  const workspaceRows = workspaceFiles.map((file) => ({ path: file, sha256: hashFile(path.join(root, file)), bytes: fs.statSync(path.join(root, file)).size }));
  writeJson('workspace-inventory.json', {
    schema_version: 'aiws.v3-clean.workspace-inventory.v1',
    phase: 'P1',
    files: workspaceRows,
    inventory_sha256: sha256(canonicalInventory(workspaceRows))
  });
  const expectedEvidencePaths = required.map((file) => `${relative(evidence)}/${file}`);
  const workspaceScopePaths = [...new Set([...workspaceScopeFiles(root), ...expectedEvidencePaths])].sort();
  const workspaceScopeRows = workspaceScopePaths.map((file) => ({ path: file, classification: classifyWorkspacePath(file) }));
  const unclassifiedScope = workspaceScopeRows.filter((entry) => !entry.classification).map((entry) => entry.path);
  if (unclassifiedScope.length) throw new Error(`workspace_scope_unclassified:${unclassifiedScope.join(',')}`);
  writeJson('workspace-scope-inventory.json', {
    schema_version: 'aiws.v3-clean.workspace-scope-inventory.v1',
    phase: 'P1',
    paths: workspaceScopeRows,
    classifications: countClassifications(workspaceScopeRows),
    inventory_sha256: sha256(canonicalScope(workspaceScopeRows))
  });

  const scopeFiles = captureScopeFiles();
  const baselineRows = new Map((baselineReceipt.files || []).map((entry) => [entry.path, entry]));
  const changedPaths = [...new Set([...baselineRows.keys(), ...scopeFiles])].filter((file) => {
    const baselineFile = path.join(baseline, file);
    const currentFile = path.join(root, file);
    const before = fs.existsSync(baselineFile) ? hashFile(baselineFile) : null;
    const after = fs.existsSync(currentFile) ? hashFile(currentFile) : null;
    return before !== after;
  }).sort();
  const changedFiles = changedPaths.filter((file) => fs.existsSync(path.join(root, file))).map((file) => ({ path: file, sha256: hashFile(path.join(root, file)) }));
  const deletedFiles = changedPaths.filter((file) => !fs.existsSync(path.join(root, file))).map((file) => ({ path: file, baseline_sha256: hashFile(path.join(baseline, file)) }));
  writeJson('modified-artifact.json', {
    schema_version: 'aiws.v3-clean.completion-audit-modified-artifact.v1',
    parent_evidence: P1_PARENT_EVIDENCE_DIRECTORY,
    baseline_receipt: `${P1_BASELINE_DIRECTORY}/original-hashes.json`,
    runtime_entry: 'apps/api/server.mjs',
    workspace_inventory_sha256: sha256(canonicalInventory(workspaceRows)),
    workspace_scope_inventory_sha256: sha256(canonicalScope(workspaceScopeRows)),
    files: changedFiles,
    deleted_files: deletedFiles
  });
  writeJson('gate-sync-contract.json', {
    schema_version: 'aiws.v3-clean.p1-gate-sync-contract.v1',
    phase: 'P1',
    rules: P1_GATE_SYNC_RULES,
    commands: P1_GATE_SYNC_COMMANDS,
    governing_documents: P1_GATE_SYNC_DOCUMENTS,
    catalog_paths: P1_GATE_SYNC_CATALOG_PATHS,
    catalog_id: 'REC-D0-GOVERNANCE-000',
    matrix_rows: P1_MATRIX_ROWS,
    evidence: `${P1_EVIDENCE_DIRECTORY}/verification.json`,
    parent_evidence: P1_PARENT_EVIDENCE_DIRECTORY,
    baseline: P1_BASELINE_DIRECTORY
  });
  fs.writeFileSync(path.join(evidence, 'change.patch'), buildPatch(changedPaths), { mode: 0o600 });
  fs.writeFileSync(path.join(evidence, 'rollback.ps1'), rollbackScript(), { mode: 0o600 });

  const parent = verifyParentBoundary();
  if (!parent.valid) throw new Error(`parent_boundary_invalid:${parent.errors.join(',')}`);
  writeJson('parent-receipt.json', parent);
  writeJson('task-manifest.json', {
    schema_version: 'aiws.v3-clean.gate-contract-enforcement-task.v1',
    target: 'P1 gate synchronization contract across plans, commands, implementations, tests, Catalog/matrix, Evidence, and rollback',
    non_target: ['P2 Identity/Team behavior', 'P3 Project behavior', 'P4-P7 adapters and domains', 'P8 importer/release implementation', 'P9 clean Web workflow'],
    preflight: {
      active_object: 'V3-Clean P1 gate synchronization enforcement',
      last_confirmed_result: 'parent gate-contract sync receipt passed with a byte-exact rollback',
      next_action: 'verify exact rule text, duplicate rejection, receipt binding, and the ordinary P1 gate sequence',
      forbidden: ['legacy runtime in clean dependency graph', 'active pre-clean release command', 'second operation/head/CAS model', 'Catalog promotion without behavior Evidence'],
      reuse: [P1_PARENT_EVIDENCE_DIRECTORY, P1_BASELINE_DIRECTORY],
      delete_retire: ['stale, duplicate, missing, and orphan gate inventory entries']
    },
    acceptance_commands: [
      'pnpm check', 'pnpm audit:p1', 'pnpm scan:clean', 'pnpm test:p1',
      'pnpm recovery:plan', 'pnpm recovery:catalog', 'pnpm recovery:coverage',
      'pnpm recovery:impact -- --audit', 'pnpm test:integration -- --test-concurrency=1', 'pnpm test:security',
      'pnpm test:release', 'pnpm verify', 'git diff --check'
    ],
    rollback_artifact: 'rollback.ps1',
    matrix_rows: P1_MATRIX_ROWS
  });

  const baselineChecks = [
    run('node', ['scripts/v3-clean-workspace-audit.mjs', `--root=${P1_BASELINE_DIRECTORY}`, '--skip-evidence'], { timeout: 120000, allowed: [1] }),
    run('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', path.join(parentEvidence, 'change.patch')], { cwd: baseline, timeout: 120000 })
  ];
  const checks = [
    run('pnpm', ['check'], { timeout: 300000, env: generationEnv }),
    run('node', ['scripts/v3-clean-workspace-audit.mjs', '--skip-evidence'], { timeout: 120000, env: generationEnv }),
    architecture,
    run('pnpm', ['test:p1'], { timeout: 300000, env: generationEnv })
  ];
  ensurePassed(baselineChecks, 'baseline_checks');
  checkpoint('initial_checks');

  const acceptanceChecks = [
    ['pnpm', ['recovery:plan', '--', '--skip-evidence'], { timeout: 120000, env: generationEnv }],
    ['pnpm', ['recovery:catalog', '--', '--skip-evidence'], { timeout: 120000, env: generationEnv }],
    ['pnpm', ['recovery:coverage', '--', '--skip-evidence'], { timeout: 120000, env: generationEnv }],
    ['pnpm', ['recovery:impact', '--', '--audit', '--skip-evidence'], { timeout: 120000, env: generationEnv }],
    ['pnpm', ['test:integration', '--', '--test-concurrency=1'], { timeout: 600000, env: generationEnv }],
    ['pnpm', ['test:security'], { timeout: 300000, env: generationEnv }],
    ['pnpm', ['test:release'], { timeout: 300000, env: generationEnv }],
    ['git', ['diff', '--check'], { timeout: 120000 }],
    ['git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', path.join(evidence, 'change.patch')], { timeout: 120000 }],
    ['git', ['-c', 'core.autocrlf=false', 'apply', '--check', path.join(evidence, 'change.patch')], { cwd: baseline, timeout: 120000 }],
    [powershellExecutable(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidence, 'rollback.ps1')], { timeout: 120000 }]
  ];
  for (const [command, args, options] of acceptanceChecks) {
    checks.push(run(command, args, options));
    checkpoint('acceptance_checks');
  }
  checks.push(verifyRollbackApply(changedPaths));
  checkpoint('acceptance_checks');

  const finalAudit = run('node', ['scripts/v3-clean-workspace-audit.mjs', '--skip-evidence'], { timeout: 120000, env: generationEnv });
  checks.push(finalAudit);
  checkpoint('final_audit');
  const finalArchitecture = run('node', ['scripts/v3-clean-architecture-scan.mjs'], { timeout: 120000, env: generationEnv });
  checks.push(finalArchitecture);
  checkpoint('final_architecture');
   checks.push(run('pnpm', ['verify'], { timeout: 900000, env: generationEnv }));
  checkpoint('final_verify');
  const finalAuditResult = JSON.parse(finalAudit.stdout);
  const finalArchitectureResult = JSON.parse(finalArchitecture.stdout);
  if (!finalAuditResult.valid || !finalArchitectureResult.valid) throw new Error('final_audit_invalid');
  writeJson('workspace-audit.json', finalAuditResult);
  writeJson('architecture-scan.json', finalArchitectureResult);
  writeVerification({ baselineChecks, checks, status: 'passed', provisional: false });
  writeManifest();

  const verified = verifyEvidence();
  if (verified !== 0) throw new Error('generated_evidence_verification_failed');
  process.stdout.write(`${JSON.stringify({
    evidence: relative(evidence),
    status: 'passed',
    parent: P1_PARENT_EVIDENCE_DIRECTORY,
    changed_files: changedFiles.length,
    deleted_files: deletedFiles.length,
    workspace_files: workspaceRows.length,
    workspace_scope_files: workspaceScopeRows.length,
    checks: checks.length
  }, null, 2)}\n`);

  function checkpoint(label) {
    const failed = checks.filter((entry) => !entry.ok);
    writeVerification({ baselineChecks, checks, status: failed.length ? 'failed' : 'passed', provisional: true });
    writeManifest();
    ensurePassed(checks, label);
  }

  async function generatePlatformArtifacts() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-completion-audit-platform-'));
    let runtime;
    try {
      const config = {
        runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0,
        home: temp, databaseFile: path.join(temp, 'data', 'state.sqlite'),
        casRoot: path.join(temp, 'cas'), receiptRoot: path.join(temp, 'receipts'),
        cursorSecret: 'completion-audit-evidence', runtimeBuild: 'v3-clean-p1-completion-audit',
        maxBodyBytes: 1024 * 1024
      };
      runtime = createCleanRuntime({ config });
      const created = await runtime.operations.create({ commandId: 'evidence.completion_audit', idempotencyKey: 'completion-audit-operation-1', request: { fixture: 'p1-completion-audit' }, resourceType: 'evidence_probe', resourceId: 'probe_completion_audit' });
      const queued = await runtime.operations.queue(created.operation_id, { expectedRevision: created.revision });
      const running = await runtime.operations.start(created.operation_id, { expectedRevision: queued.revision });
      const completed = await runtime.operations.succeed(created.operation_id, { expectedRevision: running.revision, result: { status: 'verified' } });
      const replay = runtime.events.replay({ actorId: runtime.metadata.bootstrap_actor_id, operationId: created.operation_id });
      const casObject = runtime.cas.putCanonical({ evidence: 'p1-completion-audit', status: 'verified' }, { mediaType: 'application/json' });
      const casManifest = runtime.cas.createManifest({ createdAt: '2026-08-19T00:00:00.000Z' });
      const tables = runtime.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
      const schemaRows = runtime.db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
      writeJson('schema-snapshot.json', { schema_version: 'aiws.v3-clean.schema-snapshot.v3', family: runtime.metadata.family, baseline_id: runtime.metadata.baseline_id, user_version: runtime.metadata.user_version, migration: CLEAN_MIGRATIONS[0], schema_sha256: runtime.metadata.schema_sha256, tables, sqlite_schema: schemaRows });
      writeJson('schema-inventory.json', { schema_version: 'aiws.v3-clean.schema-inventory.v3', owner: 'Platform', family: runtime.metadata.family, baseline: runtime.metadata.baseline_id, tables });
      writeJson('cas-manifest.json', casManifest);
      writeJson('golden-receipt.json', { schema_version: 'aiws.v3-clean.golden-receipt.v3', operation: completed, replay: { events: replay.events, terminal: replay.terminal, next_cursor: replay.next_cursor }, cas_object: casObject, cas_manifest_sha256: casManifest.manifest_sha256, redactions: [] });
      writeJson('route-inventory.json', { schema_version: 'aiws.v3-clean.route-inventory.v3', routes: runtime.registry.inventory(), mcp: runtime.registry.mcp(), web: runtime.registry.web(), parity: registryParity(runtime.registry) });
      writeJson('owner-manifest.json', { schema_version: 'aiws.v3-clean.owner-manifest.v3', tables: CLEAN_TABLE_OWNERS, commands: CLEAN_COMMAND_OWNERS, events: CLEAN_EVENT_OWNERS, second_operation_model: false, shadow_head_model: false });
    } finally {
      try {
        runtime?.close();
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  }
}

function verifyEvidence() {
  const errors = [];
  if (!fs.existsSync(evidence)) errors.push('evidence_missing');
  for (const file of required) if (!fs.existsSync(path.join(evidence, file))) errors.push(`artifact_missing:${file}`);
  if (fs.existsSync(path.join(evidence, 'failure.json'))) errors.push('failure_marker_present');
  if (errors.length) return failVerification(errors);
  let manifest;
  let modified;
  let verification;
  let inventory;
  let scopeInventory;
  try {
    manifest = readJson(path.join(evidence, 'manifest.json'));
    modified = readJson(path.join(evidence, 'modified-artifact.json'));
    verification = readJson(path.join(evidence, 'verification.json'));
    inventory = readJson(path.join(evidence, 'workspace-inventory.json'));
    scopeInventory = readJson(path.join(evidence, 'workspace-scope-inventory.json'));
  } catch (error) {
    return failVerification([String(error?.message || error)]);
  }
  for (const file of required.filter((file) => file !== 'manifest.json')) if (!Object.hasOwn(manifest.artifacts || {}, file)) errors.push(`manifest_entry_missing:${file}`);
  for (const [file, expected] of Object.entries(manifest.artifacts || {})) {
    const full = path.join(evidence, file);
    if (!fs.existsSync(full)) errors.push(`manifest_artifact_missing:${file}`);
    else if (hashFile(full) !== expected) errors.push(`manifest_hash_mismatch:${file}`);
  }
  for (const entry of modified.files || []) {
    const full = path.join(root, entry.path);
    if (!fs.existsSync(full)) errors.push(`modified_artifact_missing:${entry.path}`);
    else if (hashFile(full) !== entry.sha256) errors.push(`modified_artifact_hash_mismatch:${entry.path}`);
  }
  for (const entry of modified.deleted_files || []) if (fs.existsSync(path.join(root, entry.path))) errors.push(`deleted_artifact_restored:${entry.path}`);
  const currentPaths = governedWorkspaceFiles(root);
  const recordedPaths = (inventory.files || []).map((entry) => entry.path).sort();
  if (JSON.stringify(currentPaths) !== JSON.stringify(recordedPaths)) errors.push('workspace_inventory_paths_mismatch');
  const currentRows = [];
  for (const entry of inventory.files || []) {
    const full = path.join(root, entry.path);
    if (!fs.existsSync(full) || hashFile(full) !== entry.sha256) errors.push(`workspace_inventory_hash_mismatch:${entry.path}`);
    else {
      const bytes = fs.statSync(full).size;
      if (bytes !== entry.bytes) errors.push(`workspace_inventory_size_mismatch:${entry.path}`);
      currentRows.push({ path: entry.path, sha256: entry.sha256, bytes });
    }
  }
  const inventorySha256 = sha256(canonicalInventory(currentRows));
  if (inventory.inventory_sha256 !== inventorySha256 || modified.workspace_inventory_sha256 !== inventorySha256) errors.push('workspace_inventory_digest_mismatch');
  const currentScopePaths = workspaceScopeFiles(root);
  const currentScopeRows = currentScopePaths.map((file) => ({ path: file, classification: classifyWorkspacePath(file) }));
  const recordedScopePaths = (scopeInventory.paths || []).map((entry) => entry.path).sort();
  if (JSON.stringify(currentScopePaths) !== JSON.stringify(recordedScopePaths)) errors.push('workspace_scope_paths_mismatch');
  if (JSON.stringify(currentScopeRows) !== JSON.stringify(scopeInventory.paths || [])) errors.push('workspace_scope_classification_mismatch');
  const scopeSha256 = sha256(canonicalScope(currentScopeRows));
  if (scopeInventory.inventory_sha256 !== scopeSha256 || modified.workspace_scope_inventory_sha256 !== scopeSha256) errors.push('workspace_scope_digest_mismatch');
  errors.push(...evidenceCompletionFindings({ manifest, verification }).map((entry) => entry.code));
  const original = readJson(path.join(evidence, 'original-hashes.json'));
  const originalSource = path.join(root, original.source_receipt);
  if (!fs.existsSync(originalSource) || hashFile(originalSource) !== original.source_receipt_sha256) errors.push('original_hash_receipt_mismatch');
  const reverse = run('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', path.join(evidence, 'change.patch')], { timeout: 120000 });
  if (!reverse.ok) errors.push('rollback_reverse_check_failed');
  const forward = run('git', ['-c', 'core.autocrlf=false', 'apply', '--check', path.join(evidence, 'change.patch')], { cwd: baseline, timeout: 120000 });
  if (!forward.ok) errors.push('patch_forward_check_failed');
  const parent = verifyParentBoundary();
  if (!parent.valid) errors.push(...parent.errors.map((entry) => `parent:${entry}`));
  const audit = auditWorkspace({ root, verifyEvidence: false });
  if (!audit.valid) errors.push(...audit.findings.map((entry) => `workspace:${entry.code}`));
  if (errors.length) return failVerification(errors);
  process.stdout.write(`${JSON.stringify({ evidence: relative(evidence), status: 'passed', parent_boundary: 'passed', workspace_files: currentPaths.length, workspace_scope_files: currentScopePaths.length, rollback_dry_run: reverse }, null, 2)}\n`);
  return 0;
}

function verifyParentBoundary() {
  const errors = [];
  const manifest = readJson(path.join(parentEvidence, 'manifest.json'));
  const modified = readJson(path.join(parentEvidence, 'modified-artifact.json'));
  const verification = readJson(path.join(parentEvidence, 'verification.json'));
  for (const [file, expected] of Object.entries(manifest.artifacts || {})) {
    const full = path.join(parentEvidence, file);
    if (!fs.existsSync(full) || hashFile(full) !== expected) errors.push(`parent_artifact_invalid:${file}`);
  }
  for (const entry of modified.files || []) {
    const boundaryCopy = path.join(baseline, entry.path);
    const full = fs.existsSync(boundaryCopy) ? boundaryCopy : path.join(root, entry.path);
    if (!fs.existsSync(full) || hashFile(full) !== entry.sha256) errors.push(`parent_boundary_file_mismatch:${entry.path}`);
  }
  for (const entry of modified.deleted_files || []) {
    const boundaryCopy = path.join(baseline, entry.path);
    const full = fs.existsSync(boundaryCopy) ? boundaryCopy : path.join(root, entry.path);
    if (fs.existsSync(full)) errors.push(`parent_boundary_deleted_file_present:${entry.path}`);
  }
  const parentCompletion = evidenceCompletionFindings({ manifest, verification });
  if (parentCompletion.length) errors.push(...parentCompletion.map((entry) => `parent_${entry.code}`));
  const reverse = run('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', path.join(parentEvidence, 'change.patch')], { cwd: baseline, timeout: 120000 });
  if (!reverse.ok) errors.push('parent_rollback_check_failed');
  return {
    schema_version: 'aiws.v3-clean.parent-boundary-receipt.v1',
    parent: P1_PARENT_EVIDENCE_DIRECTORY,
    parent_manifest_sha256: hashFile(path.join(parentEvidence, 'manifest.json')),
    boundary: P1_BASELINE_DIRECTORY,
    boundary_receipt_sha256: hashFile(path.join(baseline, 'original-hashes.json')),
    modified_files_checked: (modified.files || []).length,
    deleted_files_checked: (modified.deleted_files || []).length,
    rollback_check: reverse,
    errors,
    valid: errors.length === 0
  };
}

function verifyRollbackApply(changedPaths) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-completion-audit-rollback-'));
  try {
    const baselineReceipt = readJson(path.join(baseline, 'original-hashes.json'));
    for (const entry of baselineReceipt.files || []) {
      const source = path.join(baseline, entry.path);
      const destination = path.join(temp, entry.path);
      if (!fs.existsSync(source) || hashFile(source) !== entry.sha256) throw new Error(`rollback_baseline_mismatch:${entry.path}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    let record = run('git', ['-c', 'core.autocrlf=false', 'apply', path.join(evidence, 'change.patch')], { cwd: temp, timeout: 120000 });
    if (!record.ok) return { ...record, command: 'isolated rollback setup', ok: false };
    const isolatedEvidence = path.join(temp, P1_EVIDENCE_DIRECTORY);
    fs.mkdirSync(isolatedEvidence, { recursive: true });
    fs.copyFileSync(path.join(evidence, 'change.patch'), path.join(isolatedEvidence, 'change.patch'));
    fs.copyFileSync(path.join(evidence, 'rollback.ps1'), path.join(isolatedEvidence, 'rollback.ps1'));
    record = run(powershellExecutable(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(isolatedEvidence, 'rollback.ps1'), '-Apply'], { cwd: temp, timeout: 120000 });
    const mismatches = [];
    for (const file of changedPaths) {
      const before = path.join(baseline, file);
      const after = path.join(temp, file);
      if (fs.existsSync(before) !== fs.existsSync(after)) mismatches.push(file);
      else if (fs.existsSync(before) && hashFile(before) !== hashFile(after)) mismatches.push(file);
    }
    return { ...record, command: 'isolated-copy rollback.ps1 -Apply', rollback_files_checked: changedPaths.length, rollback_mismatches: mismatches, ok: record.ok && mismatches.length === 0 };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function writeVerification({ baselineChecks, checks, status, provisional }) {
  writeJson('verification.json', {
    schema_version: 'aiws.v3-clean.completion-audit-verification.v1',
    status,
    provisional,
    generated_at: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, cwd: 'repository-root' },
    baseline: {
      boundary: P1_BASELINE_DIRECTORY,
      expected_failure: 'workspace synchronization audit exits 1 before the fix',
      commands: baselineChecks
    },
    commands: checks,
    literal_failure_notes: checks.filter((entry) => !entry.ok).map((entry) => `${entry.command} exited ${entry.exit_status}`),
    artifacts: { modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' }
  });
}

function writeManifest() {
  const hashes = {};
  for (const file of fs.readdirSync(evidence).sort()) {
    if (file === 'manifest.json' || file === 'failure.json') continue;
    const full = path.join(evidence, file);
    if (fs.statSync(full).isFile()) hashes[file] = hashFile(full);
  }
  const verificationFile = path.join(evidence, 'verification.json');
  const verification = fs.existsSync(verificationFile) ? readJson(verificationFile) : null;
  const status = verification?.status === 'failed'
    ? 'failed'
    : verification?.provisional === false ? 'verified' : 'checkpoint';
  writeJson('manifest.json', {
    schema_version: 'aiws.v3-clean.completion-audit-manifest.v1',
    batch: path.basename(evidence),
    phase: 'P1',
    status,
    parent: P1_PARENT_EVIDENCE_DIRECTORY,
    artifacts: hashes,
    modified_artifact: 'modified-artifact.json',
    patch: 'change.patch',
    verification: 'verification.json',
    rollback: 'rollback.ps1'
  });
}

function buildPatch(paths) {
  const chunks = [];
  for (const file of paths) {
    const oldFile = path.join(baseline, file);
    const newFile = path.join(root, file);
    const oldExists = fs.existsSync(oldFile) && fs.statSync(oldFile).isFile();
    const newExists = fs.existsSync(newFile) && fs.statSync(newFile).isFile();
    const oldArgument = oldExists ? oldFile : '/dev/null';
    const newArgument = newExists ? newFile : '/dev/null';
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--binary', '--', oldArgument, newArgument], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (![0, 1].includes(result.status)) throw new Error(`patch_file_failed:${file}:${result.stderr || result.status}`);
    if (result.stdout) chunks.push(normalizePatch(result.stdout, file, oldExists, newExists));
  }
  return chunks.join('').replace(/\n+$/u, '') + (chunks.length ? '\n' : '');
}

function normalizePatch(diff, file, oldExists, newExists) {
  let oldHeader = false;
  let newHeader = false;
  return diff.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) return `diff --git a/${file} b/${file}`;
    if (!oldHeader && line.startsWith('--- ')) {
      oldHeader = true;
      return oldExists ? `--- a/${file}` : '--- /dev/null';
    }
    if (!newHeader && line.startsWith('+++ ')) {
      newHeader = true;
      return newExists ? `+++ b/${file}` : '+++ /dev/null';
    }
    return line;
  }).join('\n');
}

function rollbackScript() {
  return `param([switch]$Apply)\n$ErrorActionPreference = 'Stop'\n$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path\n$Root = (Resolve-Path (Join-Path $Evidence '..\\..\\..')).Path\n$Patch = Join-Path $Evidence 'change.patch'\nPush-Location $Root\ntry {\n  git -c core.autocrlf=false apply --reverse --check $Patch\n  if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_failed' }\n  if ($Apply) { git -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_failed' } }\n  [ordered]@{ schema_version='aiws.v3-clean.completion-audit-rollback.v1'; status=($(if ($Apply) { 'applied' } else { 'dry_run_passed' })); patch='change.patch'; parent='${P1_PARENT_EVIDENCE_DIRECTORY}'; volume_policy='seal deployment volumes; git core.autocrlf disabled; no down migration'; verified_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5\n} finally { Pop-Location }\n`;
}

function captureScopeFiles() {
  const tracked = gitLines(['-c', 'core.quotepath=false', 'ls-files']);
  const untracked = gitLines(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']);
  const roots = /^(?:\.github\/|\.githooks\/|apps\/|packages\/|scripts\/|tests\/|docs\/architecture\/)/;
  const exact = new Set([
    'AGENTS.md', 'README.md', 'Dockerfile', 'compose.yml', 'package.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', 'feature-catalog.json', 'sbom.spdx.json', '.dockerignore',
    '.gitattributes', '.gitignore', '.prettierignore', '.prettierrc.json', 'eslint.config.mjs',
    'docs/document-index.md', 'docs/requirements-traceability.md', 'docs/runbook.md',
    'docs/testing.md', 'docs/threat-model.md', 'docs/v2-retrospective.md'
  ]);
  return [...new Set([...tracked, ...untracked].map(normalize))]
    .filter((file) => file && (roots.test(file) || exact.has(file)))
    .filter((file) => !file.startsWith('docs/evidence/') && !file.includes('/dist/') && !file.includes('/coverage/'))
    .filter((file) => fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile())
    .sort();
}

function run(command, args, options = {}) {
  const cwd = options.cwd || root;
  const allowed = options.allowed || [0];
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'pnpm',
    timeout: options.timeout || 120000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) }
  });
  const exitStatus = result.status == null ? 1 : result.status;
  return {
    command: sanitize([command, ...args].join(' ')),
    cwd: cwd === root ? 'repository-root' : sanitize(relative(cwd)),
    stdout: sanitize(result.stdout || ''),
    stderr: sanitize(result.stderr || result.error?.message || ''),
    exit_status: exitStatus,
    expected_exit_statuses: allowed,
    signal: result.signal || null,
    ok: allowed.includes(exitStatus)
  };
}

function powershellExecutable() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
  return probe.status === 0 ? 'pwsh' : 'powershell.exe';
}

function ensurePassed(records, label) {
  const failed = records.filter((entry) => !entry.ok);
  if (failed.length) throw new Error(`${label}:${failed.map((entry) => `${entry.command}:${entry.exit_status}`).join(',')}`);
}

function gitLines(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git_failed:${args.join(' ')}:${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function canonicalInventory(rows) {
  return JSON.stringify(rows.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })));
}

function canonicalScope(rows) {
  return JSON.stringify(rows.map((entry) => ({ path: entry.path, classification: entry.classification })));
}

function countClassifications(rows) {
  return rows.reduce((counts, entry) => {
    const key = `${entry.classification.kind}:${entry.classification.phase}`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function sanitize(value) {
  return String(value || '')
    .replaceAll(root, 'HOST')
    .replaceAll(baseline, 'BASELINE_COPY')
    .replace(/(?:file:\/\/\/)?\b[A-Za-z]:[\\/][^\r\n"']+/g, 'HOST_PATH')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/)[^\s"']+/g, 'HOST_PATH');
}

function failVerification(errors) {
  process.stderr.write(`${errors.join('\n')}\n`);
  return 1;
}
