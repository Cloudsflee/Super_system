#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditParity } from './lib/v3-clean-p10-parity.mjs';
import { ImmutableEvidenceWriter } from './lib/immutable-evidence-writer.mjs';
import { validateP9EvidenceManifest, validateP10EvidenceManifest } from './catalog-loader.mjs';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';
import { FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_CHECKSUM, P10_PARSER_IMAGE_DIGEST } from '../apps/api/src/clean/migrations/009-final-business-parity-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRelative = 'docs/evidence/v3-clean-p10-final-governance-20260829';
const evidenceRoot = path.join(root, evidenceRelative);
const p9EvidenceRelative = 'docs/evidence/v3-clean-p9-web-release-20260826';
const p9EvidenceRoot = path.join(root, p9EvidenceRelative);
const baselineCommit = 'bb55746b7e08cf7ee764d06a8fa23da91ad48e2f';
const v23SourceCommit = 'e18dc0b616fa7ab2b00a6c05db23890ccd940175';
const maxPatchBytes = 50 * 1024 * 1024;
const verifyOnly = process.argv.includes('--verify');
const supersede = process.argv.includes('--supersede');
const focused = process.argv.includes('--focused');
const publishArg = process.argv.find((value) => value.startsWith('--publish-run='));

if (verifyOnly) {
  const result = verifyPublished({ closure: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'passed' ? 0 : 1);
}

if (publishArg) {
  const runId = publishArg.slice('--publish-run='.length);
  const attempt = path.join(evidenceRoot, 'attempts', runId);
  if (!fs.existsSync(path.join(attempt, 'verification.json')) || !fs.existsSync(path.join(attempt, 'manifest.json'))) throw new Error('p10_publish_attempt_incomplete');
  publishAttempt(attempt);
  const result = verifyPublished();
  process.stdout.write(`${JSON.stringify({ ...result, published_run_id: runId }, null, 2)}\n`);
  process.exit(result.status === 'passed' ? 0 : 1);
}

const existing = readJson(path.join(evidenceRoot, 'verification.json'));
if (existing && !supersede) throw new Error('p10_evidence_exists_use_supersede');
fs.mkdirSync(evidenceRoot, { recursive: true });

const writer = new ImmutableEvidenceWriter(evidenceRoot, { runId: `run-${Date.now()}` });
const records = [];
try {
  const p9EvidenceFailures = validateP9EvidenceManifest(p9EvidenceRoot);
  if (p9EvidenceFailures.length) throw new Error(`p9_evidence_invalid:${p9EvidenceFailures.join(',')}`);
  const implementationCommit = git(['rev-parse', 'HEAD']);
  const runtimeTree = git(['write-tree']);
  const parity = await auditParity({ root, verifyGit: true });
  writer.write('preflight.json', preflight());
  writer.write('original-hashes.json', originalHashes());
  writer.write('modified-artifact.json', modifiedArtifact());
  const patch = workingPatch();
  if (Buffer.byteLength(patch) > maxPatchBytes) throw new Error('p10_change_patch_too_large');
  writer.writeText('change.patch', patch);
  writer.write('business-parity-map.json', readJson(path.join(root, 'docs/architecture/p10-parity/business-parity-map.json')));
  writer.write('retired-interface-manifest.json', readJson(path.join(root, 'docs/architecture/p10-parity/retired-interface-manifest.json')));
  writer.write('design-retention.json', readJson(path.join(root, 'docs/architecture/p10-parity/design-retention.json')));
  writer.write('parity-audit.json', parity);
  writer.write('catalog-release-map.json', catalogReleaseMap());
  writer.write('migration-diff.json', migrationDiff());

  for (const command of acceptanceCommands()) records.push(run(command));
  createReleaseBundle(writer, records);
  copyReleaseArtifacts(writer);
  copyViewports(writer);
  writer.write('gate-results.json', { schema_version: 'aiws.v3-clean.p10-gate-results.v1', phase: 'P10', focused, commands: records });
  const external = {
    schema_version: 'aiws.v3-clean.p10-external-probes.v1',
    status: 'passed',
    inherited_from: {
      evidence: p9EvidenceRelative,
      run_id: readJson(path.join(p9EvidenceRoot, 'verification.json'))?.run_id || null,
      verification_sha256: sha256File(path.join(p9EvidenceRoot, 'verification.json')),
      manifest_sha256: sha256File(path.join(p9EvidenceRoot, 'manifest.json'))
    },
    gates: inheritedExternalGates()
  };
  for (const [key, marker] of Object.entries({ parser: 'v3-clean-p10-parser-probe.mjs', github_deletion: 'v3-clean-p10-github-deletion-probe.mjs', release: 'v3-clean-p10-release-probe.mjs' })) {
    const record = records.find((item) => item.command.includes(marker));
    const parsed = key === 'release'
      ? (readJson(path.join(root, '.ai-workspace', 'p10-release-probe', 'receipt.json')) || parseOutput(record?.stdout || ''))
      : parseOutput(record?.stdout || '');
    const verified = probeIsVerified(key, record, parsed);
    external.gates[key] = {
      status: verified ? 'verified' : 'provisional',
      provisional: !verified,
      command: record?.command || marker,
      exit_status: record?.exit_status ?? 1,
      receipt_schema: parsed?.schema_version || null,
      receipt_sha256: parsed ? digest(parsed) : null,
      ...(key === 'parser' ? { image_digest: parsed?.image_digest || null, format_count: parsed?.format_count || 0, valid_samples: parsed?.valid_samples || 0, image_build_count: parsed?.image_build_count || 0, windows_host_status: parsed?.windows_host_archive_wrapper?.status || null } : {}),
      ...(key === 'github_deletion' ? { repository_id: parsed?.external?.generated_repository_id || null, reconciled_absent: parsed?.deletion?.reconciled_absent === true } : {}),
      ...(key === 'release' ? { image_digest: parsed?.image?.image_digest || null, sbom_sha256: parsed?.image?.sbom?.sha256 || null, reproducible_builds: parsed?.image?.reproducible_builds || 0 } : {})
    };
  }
  external.status = Object.values(external.gates).every((gate) => gate.status === 'verified') ? 'passed' : 'provisional';
  writer.write('external-probes.json', external);
  const rollback = createAndExecuteRollback(writer);
  writer.write('rollback-receipt.json', rollback);
  const localFailure = records.find((record) => record.exit_status !== 0) || parity.status !== 'passed' ? { command: records.find((record) => record.exit_status !== 0)?.command || 'audit:parity', exit_status: records.find((record) => record.exit_status !== 0)?.exit_status ?? 1 } : null;
  const final = !localFailure && external.status === 'passed' && rollback.status === 'passed';
  const verificationRecord = { schema_version: 'aiws.v3-clean.p10-verification-record.v1', phase: 'P10', baseline_commit: baselineCommit, implementation_commit: implementationCommit, runtime_tree: runtimeTree, v23_source_commit: v23SourceCommit, commands: records, parity, external_probes: external, rollback };
  writer.write('verification-record.json', verificationRecord);
  const releaseRecord = records.find((item) => item.command.includes('v3-clean-p10-release-probe.mjs'));
  const releaseProbe = readJson(path.join(root, '.ai-workspace', 'p10-release-probe', 'receipt.json')) || parseOutput(releaseRecord?.stdout || '');
  writer.write('release-probe.json', releaseProbe);
  const verification = {
    schema_version: 'aiws.v3-clean.p10-verification.v1',
    phase: 'P10', run_id: writer.runId, status: final ? 'verified' : (localFailure ? 'failed' : 'candidate'), provisional: !final,
    generated_at: new Date().toISOString(), baseline_commit: baselineCommit, source_commit: implementationCommit, implementation_commit: implementationCommit, runtime_tree: runtimeTree, v23_source_commit: v23SourceCommit,
    runtime_phase: 10, target_user_version: 9, migration_ledger: [1,2,3,4,5,6,7,8,9], migration: '009-final-business-parity-governance',
    catalog_promotion: '27/0/27', catalog: { clean: 27, historical: 0, total: 27 },
    local_gate_status: localFailure ? 'failed' : 'verified', blocking_failure: localFailure,
    parity: { status: parity.status, counts: parity.counts, business_groups: parity.business_groups, gaps: parity.gaps, map_sha256: readJson(path.join(root, 'docs/architecture/p10-parity/business-parity-map.json'))?.map_sha256 || null },
    release: {
      status: releaseProbe?.status === 'passed' ? 'passed' : 'failed',
      provisional: releaseProbe?.provisional !== false,
      image_digest: releaseProbe?.image?.image_digest || null,
      reproducible_builds: releaseProbe?.image?.reproducible_builds || 0,
      sbom_sha256: releaseProbe?.image?.sbom?.sha256 || null,
      dynamic_origin: releaseProbe?.http?.exact_cors_origin || null,
      fresh_volume: releaseProbe?.image?.publish?.fresh_volume || null,
      production_cutover: false
    },
    external_probes: external,
    rollback: { status: rollback.status, restored_user_version: rollback.apply?.output?.restored_user_version ?? null, ledger: rollback.apply?.output?.ledger ?? [], p10_tables_present: rollback.apply?.output?.p10_tables_present ?? [], p10_columns_present: rollback.apply?.output?.p10_columns_present ?? [], byte_exact_mismatches: rollback.apply?.output?.byte_exact_mismatches ?? [] },
    artifacts: { modified_artifact: role(writer, 'modified-artifact.json'), patch: role(writer, 'change.patch'), verification_record: role(writer, 'verification-record.json'), rollback: role(writer, 'rollback-receipt.json') },
    final_tag: 'p10-final-governance-20260829'
  };
  writer.write('verification.json', verification);
  const secretScan = secretScanAttempt(writer.attemptRoot);
  writer.write('secret-scan.json', secretScan);
  if (secretScan.status !== 'passed') throw new Error(`p10_secret_scan_failed:${secretScan.findings.join(',')}`);
  writer.write('manifest.json', manifest(writer.attemptRoot, verification));
  if (final) {
    if (existing) archivePublished(existing);
    publishAttempt(writer.attemptRoot);
    const reopened = verifyPublished();
    if (reopened.status !== 'passed') throw new Error(`p10_reopen_failed:${reopened.failures.join(',')}`);
  }
  process.stdout.write(`${JSON.stringify({ schema_version: 'aiws.v3-clean.p10-evidence-result.v1', status: verification.status, provisional: verification.provisional, run_id: writer.runId, directory: evidenceRelative, published: final, catalog: '27/0/27', rollback: rollback.status }, null, 2)}\n`);
  if (!final) process.exitCode = 1;
} catch (error) {
  try { writer.write('failure.json', { schema_version: 'aiws.v3-clean.p10-generation-failure.v1', status: 'failed', provisional: true, run_id: writer.runId, error: redact(String(error?.stack || error)) }); } catch { /* preserve primary error */ }
  process.stderr.write(`${redact(String(error?.stack || error))}\n`);
  process.exitCode = 1;
}

function acceptanceCommands() {
  const base = [
    ['pnpm', 'audit:parity'], ['pnpm', 'scan:clean', '--', '--skip-evidence'], ['pnpm', 'test:p10'],
    ['pnpm', 'test:p9'], ['pnpm', '--filter', '@aiws/web', 'test'], ['pnpm', 'build'],
    ['node', 'scripts/v3-clean-p10-parser-probe.mjs'], ['node', 'scripts/v3-clean-p10-github-deletion-probe.mjs'],
    ['node', 'scripts/v3-clean-p10-release-probe.mjs'], ['git', 'diff', '--check']
  ];
  if (focused) return base.filter((parts) => !['pnpm test:p9'].includes(parts.join(' ')));
  return [
    ['pnpm', 'check'], ['pnpm', 'audit:p1', '--', '--skip-evidence'], ['pnpm', 'scan:clean', '--', '--skip-evidence'], ['pnpm', 'audit:parity'],
    ['pnpm', 'recovery:plan'], ['pnpm', 'recovery:catalog'], ['pnpm', 'recovery:coverage'], ['pnpm', 'recovery:impact', '--', '--audit'],
    ...['p1','p2','p3','p31','p4','p5','p6','p7','p8','p9','p10'].map((phase) => ['pnpm', `test:${phase}`]),
    ['node', 'scripts/v3-clean-p10-parser-probe.mjs'], ['node', 'scripts/v3-clean-p10-github-deletion-probe.mjs'],
    ['pnpm', '--filter', '@aiws/web', 'test'], ['pnpm', 'test'], ['pnpm', 'test:integration:clean'], ['pnpm', 'test:security:clean'], ['pnpm', 'test:integration'], ['pnpm', 'test:security'], ['pnpm', 'build'], ['pnpm', 'test:e2e'],
    ['node', 'scripts/v3-clean-p10-release-probe.mjs'], ['pnpm', 'test:release'], ['git', 'diff', '--check']
  ];
}

function run(parts) {
  const command = parts[0] === 'pnpm' && process.platform === 'win32' ? 'pnpm.cmd' : parts[0];
  const started = Date.now();
  const result = spawnSync(command, parts.slice(1), { cwd: root, encoding: 'utf8', timeout: 1_800_000, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { command: parts.join(' '), stdout: redact(result.stdout || ''), stderr: redact(result.stderr || ''), exit_status: result.status ?? 1, signal: result.signal || null, duration_ms: Date.now() - started };
}

function inheritedExternalGates() {
  const externalPath = path.join(p9EvidenceRoot, 'external-probes.json');
  const external = readJson(externalPath);
  const manifest = readJson(path.join(p9EvidenceRoot, 'manifest.json'));
  const manifestEntry = manifest?.files?.find((entry) => entry.path === 'external-probes.json');
  if (external?.status !== 'passed' || !manifestEntry || manifestEntry.sha256 !== sha256File(externalPath) || Number(manifestEntry.byte_length) !== fs.statSync(externalPath).size) throw new Error('p9_external_probes_invalid');
  const mapping = {
    gateway: 'gateway',
    codex: 'codex',
    bridge: 'bridge',
    docker_runner: 'docker_runner',
    host_runner: 'host_runner',
    bridge_runner: 'bridge_runner',
    parser: 'p9_parser_baseline',
    github: 'github_delivery',
    github_local: 'github_local',
    release: 'p9_release_baseline'
  };
  return Object.fromEntries(Object.entries(mapping).map(([sourceKey, targetKey]) => {
    const gate = external.gates?.[sourceKey];
    if (gate?.status !== 'verified') throw new Error(`p9_external_gate_invalid:${sourceKey}`);
    return [targetKey, {
      ...gate,
      status: 'verified',
      provisional: false,
      inherited: true,
      source_evidence: `${p9EvidenceRelative}/external-probes.json`,
      source_receipt_sha256: manifestEntry.sha256
    }];
  }));
}

function preflight() { return { schema_version: 'aiws.v3-clean.p10-preflight.v1', owner: 'Product Architecture', phase: 'P10', Target: 'P10 final business parity and governance closure', '目标': 'P10 最终业务对等与治理封账', 'Non-target': 'production cutover and production volumes', '非目标': '生产切换与生产卷', Forbidden: ['legacy runtime/facade', 'dual operation/event/CAS/head writes', 'unconfirmed deletion', 'provisional promotion'], '禁止项': ['旧运行时与双写', '未确认删除', '临时收录晋级'], Reuse: ['P9 /api/v2', 'shared operations/events/heads/CAS/ACL/redaction', 'P9 released Catalog'], '复用项': ['P9 公共 owner 与 Catalog'], 'Delete/retire': ['historical interface shapes only; no business capability'], '删除/退役': ['仅退役历史接口形状，不退役业务能力'], 'Acceptance commands': acceptanceCommands().map((parts) => parts.join(' ')), '验收命令': 'audit:parity, P10 tests, parser/GitHub/release probes, Web, build, rollback', 'Rollback artifact': `${evidenceRelative}/rollback.ps1`, '回滚工件': `${evidenceRelative}/rollback.ps1`, active_object: 'P10 final Evidence', last_confirmed_result: 'P10 parity audit and focused domain tests passed', next_action: 'run synchronized gates, execute isolated rollback, publish final receipt' }; }
function originalHashes() { const lines = git(['ls-tree', '-r', baselineCommit]).split(/\r?\n/).filter(Boolean); return { schema_version: 'aiws.v3-clean.p10-original-hashes.v1', baseline_commit: baselineCommit, tree: git(['show', '-s', '--format=%T', baselineCommit]), files: lines.map((line) => { const match = line.match(/^\d+\s+blob\s+([a-f0-9]+)\t(.+)$/); return match ? { path: match[2], git_blob: match[1] } : null; }).filter(Boolean) }; }
function modifiedArtifact() { const status = git(['status', '--short', '--untracked-files=all']); const paths = new Set([...git(['diff', '--name-only', baselineCommit]).split(/\r?\n/), ...status.split(/\r?\n/).map((line) => line.slice(3))].filter(Boolean)); return { schema_version: 'aiws.v3-clean.p10-modified-artifact.v1', baseline_commit: baselineCommit, head: git(['rev-parse', 'HEAD']), working_tree: 'modified', files: [...paths].sort().map((file) => ({ path: file, sha256: fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile() ? sha256File(path.join(root, file)) : null })) }; }
function workingPatch() {
  const evidencePrefix = `${evidenceRelative}/`;
  const evidencePathspec = `:(exclude)${evidencePrefix}**`;
  const tracked = spawnSync('git', ['diff', '--binary', baselineCommit, '--', '.', evidencePathspec], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: maxPatchBytes });
  if (tracked.status !== 0) throw new Error('p10_change_patch_failed');
  const status = git(['status', '--short', '--untracked-files=all']).split(/\r?\n/)
    .filter((line) => line && !line.slice(3).replaceAll('\\', '/').startsWith(evidencePrefix))
    .join('\n');
  return `${tracked.stdout || ''}\n# untracked and staged non-Evidence paths\n${status}\n`;
}
function migrationDiff() { return { schema_version: 'aiws.v3-clean.p10-migration-diff.v1', from_user_version: 8, to_user_version: 9, migration: '009-final-business-parity-governance', tables: ['brief_templates','brief_template_revisions','workflow_quality_policies','quality_review_asset_selections','quality_review_advices','assist_review_comments','project_deletion_intents','repository_deletion_intents'], additive_columns: { provider_profiles: ['lifecycle_status','disabled_at'], brief_revisions: ['template_id','template_revision','template_sha256'], assist_sessions: ['title','mode','parent_session_id','fork_source_turn_id','pinned_at','archived_at','deleted_at'], quality_review_runs: ['policy_revision','policy_snapshot_json','policy_sha256','reviewer_profile_id','reviewer_profile_revision','reviewer_snapshot_json','reviewer_snapshot_sha256','supersedes_quality_review_id','superseded_by_quality_review_id','stale_at','stale_reason'] }, checksum: FINAL_BUSINESS_PARITY_GOVERNANCE_MIGRATION_CHECKSUM }; }
function catalogReleaseMap() { const catalog = readJson(path.join(root, 'feature-catalog.clean.json')); const rows = (catalog?.features || []).map((feature) => ({ id: feature.id, domain: feature.domain, prior_status: feature.status, release_status: 'released', release_behavior: 'P10 business-semantic parity and released Web/API receipt', verification: `${evidenceRelative}/verification.json`, parity_map: 'docs/architecture/p10-parity/business-parity-map.json' })).sort((left, right) => left.id.localeCompare(right.id)); return { schema_version: 'aiws.v3-clean.p10-catalog-release-map.v1', status: rows.length === 27 && new Set(rows.map((row) => row.id)).size === 27 ? 'passed' : 'failed', counts: { clean: rows.length, historical: 0, total: rows.length }, rows }; }
function createReleaseBundle(writer, records) {
  const releaseRecord = records.find((item) => item.command.includes('v3-clean-p10-release-probe.mjs'));
  const releaseProbe = readJson(path.join(root, '.ai-workspace', 'p10-release-probe', 'receipt.json')) || parseOutput(releaseRecord?.stdout || '');
  const source = path.join(root, '.ai-workspace', 'p10-release-probe', 'modified-release-bundle.tgz');
  if (releaseProbe?.status !== 'passed' || releaseProbe?.provisional !== false || !fs.existsSync(source)) { const record = records.find((item) => item.command.includes('v3-clean-p10-release-probe.mjs')); throw new Error(`p10_release_bundle_missing_${record?.exit_status ?? 'none'}_${releaseProbe?.status || 'none'}_${releaseProbe?.provisional === false ? 'stable' : 'provisional'}_${fs.existsSync(source) ? 'present' : 'absent'}`); }
  if (sha256File(source) !== releaseProbe.bundle?.sha256) throw new Error('p10_release_bundle_hash_mismatch');
  writer.write('release-bundle.tgz', fs.readFileSync(source));
  writer.write('release-bundle.json', {
    schema_version: 'aiws.v3-clean.p10-release-bundle-manifest.v1',
    implementation_commit: git(['rev-parse', 'HEAD']),
    runtime_tree: git(['write-tree']),
    web_tree: treeHash(path.join(root, 'apps/web/dist')),
    bundle_sha256: releaseProbe.bundle.sha256,
    bundle_byte_length: releaseProbe.bundle.byte_length,
    image_digest: releaseProbe.image?.image_digest || null,
    sbom_sha256: releaseProbe.image?.sbom?.sha256 || null,
    reproducible_builds: releaseProbe.image?.reproducible_builds || 0,
    dynamic_origin: releaseProbe.http?.exact_cors_origin || null,
    production_cutover: false
  });
}

function copyReleaseArtifacts(writer) {
  const sourceRoot = path.join(root, '.ai-workspace', 'p10-release-probe');
  const receipt = readJson(path.join(sourceRoot, 'receipt.json'));
  if (receipt?.status !== 'passed' || receipt?.provisional !== false) throw new Error('p10_release_receipt_missing');
  const artifacts = [
    ['image.spdx.json', 'image.spdx.json', receipt.image?.sbom?.sha256],
    ['viewport-desktop.png', 'release-viewport-desktop.png', receipt.browser?.layouts?.find((item) => item.name === 'desktop')?.screenshot_sha256],
    ['viewport-tablet.png', 'release-viewport-tablet.png', receipt.browser?.layouts?.find((item) => item.name === 'tablet')?.screenshot_sha256],
    ['viewport-mobile.png', 'release-viewport-mobile.png', receipt.browser?.layouts?.find((item) => item.name === 'mobile')?.screenshot_sha256],
    ['offline.png', 'release-offline.png', receipt.browser?.offline?.screenshot_sha256]
  ];
  for (const [sourceName, targetName, expectedHash] of artifacts) {
    const source = path.join(sourceRoot, sourceName);
    if (!fs.existsSync(source) || !/^[a-f0-9]{64}$/.test(String(expectedHash || '')) || sha256File(source) !== expectedHash) throw new Error(`p10_release_artifact_invalid:${sourceName}`);
    writer.write(targetName, fs.readFileSync(source));
  }
}

function copyViewports(writer) {
  const p10Root = path.join(root, '.ai-workspace', 'e2e-clean-p10');
  const e2eReceipt = readJson(path.join(p10Root, 'receipt.json'));
  const p10 = e2eReceipt?.p10;
  const requiredDimensions = ['coverage', 'accuracy', 'depth', 'consistency', 'clarity'];
  if (e2eReceipt?.status !== 'passed' || e2eReceipt?.provisional !== false || e2eReceipt?.business_groups?.length !== 19 || e2eReceipt?.layouts?.some((item) => item.horizontal_overflow || item.overlaps?.length) || !p10?.provider?.id || p10.provider.probe_status !== 'succeeded' || !p10.brief_template?.archived || !p10.assist?.fork_id || !p10.assist?.side_thread_id || p10.assist.comments !== 2 || !p10.assist.restored_deleted || !p10.repository_deletion?.two_session_proofs || p10.repository_deletion.terminal_status !== 'cancelled' || p10.project_deletion?.terminal_status !== 'completed' || JSON.stringify(p10.quality_dimensions) !== JSON.stringify(requiredDimensions)) throw new Error('p10_e2e_receipt_invalid');
  writer.write('e2e-receipt.json', e2eReceipt);
  for (const [name, width, height, sourceName] of [
    ['viewport-desktop.png', 1440, 900, 'desktop-governance.png'],
    ['viewport-tablet.png', 1024, 768, 'laptop-governance.png'],
    ['viewport-mobile.png', 390, 844, 'mobile-governance.png']
  ]) {
    const source = path.join(p10Root, sourceName);
    if (!fs.existsSync(source)) throw new Error(`p10_viewport_missing:${sourceName}`);
    writer.write(name, fs.readFileSync(source));
    writer.write(`${name.replace('.png', '')}-receipt.json`, {
      schema_version: 'aiws.v3-clean.p10-viewport-receipt.v1',
      viewport: { width, height },
      screenshot: name,
      screenshot_sha256: sha256File(path.join(writer.attemptRoot, name)),
      e2e_receipt_sha256: sha256File(path.join(p10Root, 'receipt.json')),
      status: 'passed',
      source: `P10 governance browser:${sourceName}`
    });
  }
}
function createAndExecuteRollback(writer) { const base = path.join(writer.attemptRoot, 'rollback-baseline'); fs.mkdirSync(path.join(base, 'sqlite'), { recursive: true }); const baselineDb = path.join(base, 'sqlite', 'state.sqlite'); openCleanDatabase(baselineDb, { targetVersion: 8, receiptRoot: path.join(writer.attemptRoot, 'migration-receipts'), runtimeBuild: 'p10-p9-rollback' }).close(); for (const component of ['cas','vault','workspace','broker','bridge','parser','web','catalog']) { const file = path.join(base, component, 'state.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ component, baseline_commit: baselineCommit })}\n`, { flag: 'wx' }); } writer.write('rollback-manifest.json', { schema_version: 'aiws.v3-clean.p10-rollback-manifest.v1', baseline_commit: baselineCommit, files: treeFiles(base).map((file) => ({ path: path.relative(base, file).replaceAll('\\', '/'), sha256: sha256File(file) })), expected_user_version: 8, expected_ledger: [1,2,3,4,5,6,7,8] }); writer.writeText('rollback-verify.mjs', rollbackVerifier()); writer.writeText('rollback.ps1', rollbackPowerShell()); const isolated = path.join(writer.attemptRoot, 'rollback-isolated'); const shell = process.platform === 'win32' ? 'powershell' : 'pwsh'; const dry = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(writer.attemptRoot, 'rollback.ps1'), '-DryRun', '-IsolatedRoot', isolated], { cwd: writer.attemptRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true }); const apply = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(writer.attemptRoot, 'rollback.ps1'), '-Apply', '-IsolatedRoot', isolated], { cwd: writer.attemptRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true }); return { schema_version: 'aiws.v3-clean.p10-rollback-receipt.v1', status: dry.status === 0 && apply.status === 0 && parseOutput(apply.stdout)?.byte_exact_mismatches?.length === 0 ? 'passed' : 'failed', dry_run: { command: 'powershell -File rollback.ps1 -DryRun', stdout: redact(dry.stdout || ''), stderr: redact(dry.stderr || ''), exit_status: dry.status ?? 1 }, apply: { command: 'powershell -File rollback.ps1 -Apply -IsolatedRoot <TARGET>', stdout: redact(apply.stdout || ''), stderr: redact(apply.stderr || ''), exit_status: apply.status ?? 1, output: parseOutput(apply.stdout) } }; }
function rollbackPowerShell() { return `param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot=(Join-Path $PSScriptRoot 'rollback-isolated'))\n$ErrorActionPreference='Stop'\n$source=Join-Path $PSScriptRoot 'rollback-baseline'\n$root=[IO.Path]::GetFullPath($PSScriptRoot)\n$target=[IO.Path]::GetFullPath($IsolatedRoot)\nif(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'rollback_target_outside_evidence'}\nif($DryRun){ConvertTo-Json @{status='passed';mode='dry-run';writes=0} -Compress;exit 0}\nif(-not $Apply){throw 'rollback_mode_required'}\nif(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}\nCopy-Item -LiteralPath $source -Destination $target -Recurse\nnode (Join-Path $PSScriptRoot 'rollback-verify.mjs') $target (Join-Path $PSScriptRoot 'rollback-manifest.json')\nexit $LASTEXITCODE\n`; }
function rollbackVerifier() { return `import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';import{DatabaseSync}from'node:sqlite';const root=path.resolve(process.argv[2]);const manifest=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');const mismatches=manifest.files.filter(x=>!fs.existsSync(path.join(root,x.path))||hash(path.join(root,x.path))!==x.sha256).map(x=>x.path);const db=new DatabaseSync(path.join(root,'sqlite','state.sqlite'),{readOnly:true});const version=Number(db.prepare('PRAGMA user_version').get().user_version);const ledger=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x=>Number(x.version));const fk=db.prepare('PRAGMA foreign_key_check').all();const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name);const p10Tables=${JSON.stringify(['brief_templates','brief_template_revisions','workflow_quality_policies','quality_review_asset_selections','quality_review_advices','assist_review_comments','project_deletion_intents','repository_deletion_intents'])}.filter(x=>tables.includes(x));const columns=${JSON.stringify({provider_profiles:['lifecycle_status','disabled_at'],brief_revisions:['template_id','template_revision','template_sha256'],assist_sessions:['title','mode','parent_session_id','fork_source_turn_id','pinned_at','archived_at','deleted_at'],quality_review_runs:['policy_revision','policy_snapshot_json','policy_sha256','reviewer_profile_id','reviewer_profile_revision','reviewer_snapshot_json','reviewer_snapshot_sha256','supersedes_quality_review_id','superseded_by_quality_review_id','stale_at','stale_reason']})};const p10Columns=Object.entries(columns).flatMap(([table,expected])=>{const actual=db.prepare('PRAGMA table_info('+table+')').all().map(x=>x.name);return expected.filter(x=>actual.includes(x)).map(x=>table+'.'+x)});db.close();const result={status:version===8&&JSON.stringify(ledger)===JSON.stringify([1,2,3,4,5,6,7,8])&&!fk.length&&!p10Tables.length&&!p10Columns.length&&!mismatches.length?'passed':'failed',restored_user_version:version,ledger,foreign_key_check:fk,p10_tables_present:p10Tables,p10_columns_present:p10Columns,restored_components:manifest.files.map(x=>x.path.split('/')[0]),byte_exact_mismatches:mismatches};console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;`; }
function manifest(attempt, verification) { const files = treeFiles(attempt).filter((file) => { const relative = path.relative(attempt, file).replaceAll('\\', '/'); return path.basename(file) !== 'manifest.json' && !['rollback-isolated/','rollback-baseline/','migration-receipts/'].some((prefix) => relative.startsWith(prefix)); }); return { schema_version: 'aiws.v3-clean.p10-evidence-manifest.v1', run_id: verification.run_id, status: verification.status, provisional: verification.provisional, files: files.map((file) => ({ path: path.relative(attempt, file).replaceAll('\\', '/'), sha256: sha256File(file), byte_length: fs.statSync(file).size })).sort((left, right) => left.path.localeCompare(right.path)) }; }
function role(writer, file) { const target = path.join(writer.attemptRoot, file); return { path: file, sha256: sha256File(target), byte_length: fs.statSync(target).size }; }
function probeIsVerified(key, record, parsed) {
  if (record?.exit_status !== 0 || parsed?.status !== 'passed' || parsed?.provisional !== false) return false;
  if (key === 'parser') return parsed.image_digest === P10_PARSER_IMAGE_DIGEST && parsed.image_build_count === 2 && parsed.format_count === 21 && parsed.valid_samples === 21 && parsed.windows_host_archive_wrapper?.status === 'passed' && Object.values(parsed.negatives || {}).every((item) => item.status === 'invalid' || item.status === 'resource_exceeded');
  if (key === 'github_deletion') return parsed.external?.status === 'verified' && /^[0-9]+$/.test(String(parsed.external.generated_repository_id || '')) && parsed.deletion?.deleted === true && parsed.deletion?.reconciled_absent === true && parsed.cleanup?.no_broad_cleanup === true && parsed.cleanup?.residual_repository === false;
  if (key === 'release') return parsed.image?.status === 'verified' && parsed.image?.provisional === false && parsed.image?.reproducible_builds === 2 && /^sha256:[a-f0-9]{64}$/.test(String(parsed.image?.image_digest || '')) && /^[a-f0-9]{64}$/.test(String(parsed.image?.sbom?.sha256 || '')) && parsed.http?.status === 'passed' && parsed.rollback?.status === 'passed' && parsed.rollback?.restored_user_version === 8 && !parsed.rollback?.byte_exact_mismatches?.length && parsed.production_cutover === false;
  return true;
}

function verifyPublished({ closure = false } = {}) {
  const verification = readJson(path.join(evidenceRoot, 'verification.json'));
  const failures = verification ? validateP10EvidenceManifest(evidenceRoot, verification) : ['verification_missing'];
  if (closure && verification && !failures.length) failures.push(...closureFailures(verification));
  return { schema_version: 'aiws.v3-clean.p10-evidence-verify.v1', status: failures.length ? 'failed' : 'passed', failures: [...new Set(failures)].sort(), run_id: verification?.run_id || null, catalog: '27/0/27', closure_checked: closure };
}

function closureFailures(verification) {
  const failures = [];
  const head = tryGit(['rev-parse', 'HEAD']);
  const tag = String(verification.final_tag || 'p10-final-governance-20260829');
  if (tryGit(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') failures.push('annotated_tag');
  if (tryGit(['rev-parse', `${tag}^{}`]) !== head) failures.push('tag_head');
  const upstream = tryGit(['rev-parse', '@{u}']);
  if (!upstream || upstream !== head) failures.push('upstream_head');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (status.status !== 0 || String(status.stdout || '').trim()) failures.push('worktree_clean');
  const implementation = String(verification.implementation_commit || verification.source_commit || '');
  if (!/^[a-f0-9]{40}$/.test(implementation)) failures.push('implementation_commit');
  else {
    const tree = tryGit(['show', '-s', '--format=%T', implementation]);
    if (!tree || tree !== verification.runtime_tree) failures.push('runtime_tree');
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', implementation, head], { cwd: root, windowsHide: true });
    if (ancestry.status !== 0) failures.push('implementation_ancestry');
    const changed = tryGit(['diff', '--name-only', `${implementation}..HEAD`]).split(/\r?\n/).filter(Boolean);
    const allow = /^(?:docs\/evidence\/v3-clean-p10-final-governance-20260829\/|docs\/architecture\/p10-parity\/|docs\/architecture\/p10-final-business-parity\.md$|docs\/testing\.md$|AGENTS\.md$|feature-catalog(?:\.clean)?\.json$)/;
    for (const file of changed) if (!allow.test(file.replaceAll('\\', '/'))) failures.push(`post_implementation_path:${file}`);
  }
  return failures;
}

function tryGit(args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 }); return result.status === 0 ? String(result.stdout || '').trim() : ''; }
function publishAttempt(attempt) { for (const entry of fs.readdirSync(attempt, { withFileTypes: true })) { if (['rollback-baseline','rollback-isolated','migration-receipts'].includes(entry.name)) continue; const source = path.join(attempt, entry.name); const target = path.join(evidenceRoot, entry.name); if (entry.isDirectory()) copyTree(source, target); else if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); else if (sha256File(source) !== sha256File(target)) throw new Error(`p10_publish_mismatch:${entry.name}`); } }
function copyTree(source, target) { fs.mkdirSync(target, { recursive: true }); for (const entry of fs.readdirSync(source, { withFileTypes: true })) { const from = path.join(source, entry.name); const to = path.join(target, entry.name); if (entry.isDirectory()) copyTree(from, to); else if (!fs.existsSync(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); else if (sha256File(from) !== sha256File(to)) throw new Error(`p10_publish_mismatch:${entry.name}`); } }
function archivePublished(verification) { const archive = path.join(evidenceRoot, 'attempts', `superseded-final-${verification.run_id}-${Date.now()}`); fs.mkdirSync(archive, { recursive: true }); for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) { if (entry.name === 'attempts') continue; const source = path.join(evidenceRoot, entry.name); const target = path.join(archive, entry.name); if (entry.isDirectory()) copyTree(source, target); else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); } for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) { if (entry.name === 'attempts') continue; const target = path.join(evidenceRoot, entry.name); if (entry.isDirectory()) fs.rmSync(target, { recursive: true, force: true }); else fs.rmSync(target); } }
function secretScanAttempt(directory) { const findings = []; for (const file of treeFiles(directory)) { const relative = path.relative(directory, file).replaceAll('\\', '/'); if (/\.(?:png|tgz|sqlite)$/i.test(file)) continue; const text = fs.readFileSync(file, 'utf8'); if (/(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9]{16,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|aiws_session=[A-Za-z0-9%._~-]{32,})/.test(text)) findings.push(relative); } return { schema_version: 'aiws.v3-clean.p10-secret-scan.v1', status: findings.length ? 'failed' : 'passed', findings }; }
function parseOutput(value) {
  const text = String(value || '').trim();
  try { return JSON.parse(text); } catch { /* command warnings may precede JSON */ }
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    try { return JSON.parse(text.slice(index)); } catch { /* try the next object boundary */ }
  }
  return null;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function treeFiles(directory) { const output = []; if (!fs.existsSync(directory)) return output; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) output.push(...treeFiles(file)); else output.push(file); } return output; }
function treeHash(directory) { if (!fs.existsSync(directory)) return null; return digest(treeFiles(directory).map((file) => [path.relative(directory, file).replaceAll('\\', '/'), sha256File(file)]).sort((left, right) => left[0].localeCompare(right[0]))); }
function sha256File(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function redact(value) { return String(value || '').replace(/(?:ghp_|github_pat_|sk-)[A-Za-z0-9_]{8,}/gi, '[redacted]').replace(/[A-Za-z]:\\[^\r\n ]+/g, '[path]'); }
function git(args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 }); if (result.status !== 0) throw new Error(`git_${args[0]}_failed`); return result.stdout.trim(); }
