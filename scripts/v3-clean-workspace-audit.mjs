import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P1_ACTIVE_MARKDOWN,
  P1_CLEAN_ROOT,
  P1_DEFERRED_PACKAGE_SCRIPTS,
  P1_EVIDENCE_DIRECTORY,
  P1_EVIDENCE_REQUIRED_FILES,
  P1_GATE_SYNC_COMMANDS,
  P1_GATE_SYNC_CATALOG_PATHS,
  P1_GATE_SYNC_DOCUMENTS,
  P1_GATE_SYNC_EVIDENCE_DOCUMENTS,
  P1_GATE_SYNC_RULES,
  P1_FORBIDDEN_PACKAGE_SCRIPTS,
  P1_HTTP_COMPOSITION,
  P1_LEGACY_SERVER_IMPORTERS,
  P1_MATRIX_ROWS,
  P1_PACKAGE_SCRIPT_DEFINITIONS,
  P1_PROCESS_SCRIPTS,
  P1_RETIRED_ROUTE_PROBES,
  P1_RUNTIME_ENTRYPOINT,
  classifyWorkspacePath
} from './lib/v3-clean-p1-scope.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function auditWorkspace(options = {}) {
  const root = path.resolve(options.root || defaultRoot);
  const verifyEvidence = options.verifyEvidence ?? process.env.AIWS_P1_EVIDENCE_GENERATING !== '1';
  const compareEvidenceWorkspace = options.compareEvidenceWorkspace === true;
  const findings = [];
  const checks = [];
  const addFinding = (code, details = {}) => findings.push({ code, ...details });

  const packageFile = path.join(root, 'package.json');
  const packageJson = readJson(packageFile, addFinding, 'package_json_invalid') || {};
  const scripts = packageJson.scripts || {};
  const expectedScriptNames = Object.keys(P1_PACKAGE_SCRIPT_DEFINITIONS).sort();
  const actualScriptNames = Object.keys(scripts).sort();
  if (JSON.stringify(expectedScriptNames) !== JSON.stringify(actualScriptNames)) {
    addFinding('package_script_inventory_mismatch', { expected: expectedScriptNames, actual: actualScriptNames });
  }
  for (const [name, definition] of Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS)) {
    if (scripts[name] !== definition.command) addFinding('package_script_command_mismatch', { script: name, expected: definition.command, actual: scripts[name] || null });
  }
  for (const name of P1_FORBIDDEN_PACKAGE_SCRIPTS) if (Object.hasOwn(scripts, name)) addFinding('future_phase_script_is_active', { script: name });
  checks.push({ id: 'package-process-surface', valid: !findings.some((entry) => entry.code.includes('script')) });

  const devSource = readText(path.join(root, 'scripts', 'dev.mjs'), addFinding, 'dev_script_missing');
  if (devSource) {
    if (!devSource.includes("['apps/api/server.mjs']")) addFinding('default_dev_missing_clean_entrypoint');
    if (devSource.includes('apps/runner-broker/server.mjs') || devSource.includes("'@aiws/web'")) addFinding('default_dev_starts_future_surface');
  }
  const dockerfile = readText(path.join(root, 'Dockerfile'), addFinding, 'dockerfile_missing');
  if (dockerfile && !dockerfile.includes('CMD ["node", "apps/api/server.mjs"]')) addFinding('container_entrypoint_mismatch');
  if (fs.existsSync(path.join(root, 'apps', 'api', 'server-clean.mjs'))) addFinding('duplicate_clean_entrypoint_alias', { file: 'apps/api/server-clean.mjs' });
  checks.push({ id: 'runtime-entrypoints', valid: !findings.some((entry) => ['default_dev_missing_clean_entrypoint', 'default_dev_starts_future_surface', 'container_entrypoint_mismatch', 'duplicate_clean_entrypoint_alias'].includes(entry.code)) });

  const sourceFiles = collectSourceFiles(root);
  const legacyImporters = [];
  const legacyImportPattern = /(?:from\s+|import\s*\(\s*)['"]([^'"]*server-legacy\.mjs)['"]/g;
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if ([...source.matchAll(legacyImportPattern)].length) legacyImporters.push(file);
  }
  const expectedLegacyImporters = [...P1_LEGACY_SERVER_IMPORTERS].sort();
  if (JSON.stringify(legacyImporters.sort()) !== JSON.stringify(expectedLegacyImporters)) {
    addFinding('legacy_fixture_import_inventory_mismatch', { expected: expectedLegacyImporters, actual: legacyImporters.sort() });
  }
  checks.push({ id: 'legacy-server-containment', valid: !findings.some((entry) => entry.code === 'legacy_fixture_import_inventory_mismatch') });

  const retiredRoutePattern = new RegExp('/api/' + 'v1(?:/|\\b)', 'g');
  const deferredRouteReferences = new Map();
  const activeRouteReferences = [];
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const count = [...source.matchAll(retiredRoutePattern)].length;
    if (!count) continue;
    if (P1_RETIRED_ROUTE_PROBES.includes(file)) continue;
    const classification = classifyWorkspacePath(file);
    const active = file.startsWith(P1_CLEAN_ROOT)
      || [P1_RUNTIME_ENTRYPOINT, P1_HTTP_COMPOSITION, 'scripts/dev.mjs', '.github/PULL_REQUEST_TEMPLATE.md'].includes(file);
    if (active) activeRouteReferences.push({ file, count });
    else {
      const key = `${classification?.phase || 'unclassified'}:${classification?.reason || classification?.kind || 'unknown'}`;
      deferredRouteReferences.set(key, (deferredRouteReferences.get(key) || 0) + count);
    }
  }
  if (activeRouteReferences.length) addFinding('retired_route_on_active_surface', { files: activeRouteReferences });
  checks.push({ id: 'retired-route-containment', valid: activeRouteReferences.length === 0 });

  const markdown = [];
  for (const file of P1_ACTIVE_MARKDOWN) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      addFinding('active_markdown_missing', { file });
      continue;
    }
    const source = fs.readFileSync(full, 'utf8');
    markdown.push({ file, source });
    for (const target of markdownTargets(source)) {
      if (!target || /^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
      const withoutFragment = decodeURIComponent(target.split('#')[0].replace(/^<|>$/g, ''));
      if (!withoutFragment) continue;
      if (!fs.existsSync(path.resolve(path.dirname(full), withoutFragment))) addFinding('markdown_link_missing', { file, target });
    }
  }
  const pullRequestTemplate = markdown.find((entry) => entry.file === '.github/PULL_REQUEST_TEMPLATE.md')?.source || '';
  if (!pullRequestTemplate.includes('/api/v2')) addFinding('pull_request_template_missing_api_v2');
  if (retiredRoutePattern.test(pullRequestTemplate)) addFinding('pull_request_template_uses_retired_route');
  const readme = markdown.find((entry) => entry.file === 'README.md')?.source || '';
  if (/\]\(docs\/archive\//.test(readme)) addFinding('active_readme_links_archive');
  if (/docker\s+compose\s+up|pnpm\s+release:(?:build|rehearse|promote)/.test(readme)) addFinding('readme_advertises_future_release');
  const staleNames = /docs\/(?:api|architecture|data-model)\.md|V3功能恢复与架构治理判断\.md|开发计划v3功能恢复\.md|测试计划v3功能恢复\.md/;
  for (const entry of markdown) if (staleNames.test(entry.source)) addFinding('stale_active_document_reference', { file: entry.file });
  checks.push({ id: 'active-document-contracts', valid: !findings.some((entry) => ['active_markdown_missing', 'markdown_link_missing', 'pull_request_template_missing_api_v2', 'pull_request_template_uses_retired_route', 'active_readme_links_archive', 'readme_advertises_future_release', 'stale_active_document_reference'].includes(entry.code)) });

  const catalog = readJson(path.join(root, 'feature-catalog.json'), addFinding, 'feature_catalog_invalid');
  const governance = catalog?.features?.find((feature) => feature.id === 'REC-D0-GOVERNANCE-000');
  const expectedVerification = `${P1_EVIDENCE_DIRECTORY}/verification.json`;
  if (JSON.stringify(governance?.evidence || []) !== JSON.stringify([expectedVerification])) {
    addFinding('catalog_p1_evidence_mismatch', { expected: expectedVerification, actual: governance?.evidence || null });
  }
  const governanceImplementationPaths = [
    ...(governance?.source_files || []),
    ...(governance?.target_modules || []),
    ...(governance?.behavior_tests || []),
    ...(governance?.ui_tests || [])
  ];
  const governancePaths = [...governanceImplementationPaths, ...(governance?.evidence || [])];
  for (const file of governanceImplementationPaths) if (!fs.existsSync(path.join(root, file))) addFinding('catalog_p1_path_missing', { file });
  if (verifyEvidence) for (const file of governance?.evidence || []) if (!fs.existsSync(path.join(root, file))) addFinding('catalog_p1_path_missing', { file });
  for (const file of [
    'scripts/lib/v3-clean-p1-scope.mjs',
    'scripts/v3-clean-workspace-audit.mjs',
    'scripts/v3-clean-architecture-scan.mjs',
    'scripts/v3-clean-p1-global-sync-evidence.mjs',
    'tests/p1/workspace-sync.test.mjs',
    'tests/unit/recovery-governance.test.mjs'
  ]) {
    if (!governancePaths.includes(file)) addFinding('catalog_p1_path_unregistered', { file });
  }
  const plan = readText(path.join(root, 'docs', 'architecture', 'v3-clean-development-plan.md'), addFinding, 'development_plan_missing');
  const matrix = readText(path.join(root, 'docs', 'architecture', 'v23-capability-matrix.md'), addFinding, 'capability_matrix_missing');
  verifyGateSyncContract({ root, governance, plan, matrix, addFinding });
  checks.push({ id: 'gate-sync-contract', valid: !findings.some((entry) => entry.code.startsWith('gate_sync_')) });
  if (plan && !plan.includes(`\`${P1_EVIDENCE_DIRECTORY}/\``)) addFinding('plan_p1_evidence_mismatch', { expected: P1_EVIDENCE_DIRECTORY });
  if (matrix) {
    const p1Lines = matrix.split(/\r?\n/).filter((line) => line.startsWith('| P1-'));
    const actualRows = p1Lines.map((line) => line.split('|')[1].trim()).sort();
    if (JSON.stringify(actualRows) !== JSON.stringify([...P1_MATRIX_ROWS].sort())) addFinding('matrix_p1_row_inventory_mismatch', { expected: P1_MATRIX_ROWS, actual: actualRows });
    if (!p1Lines.length || p1Lines.some((line) => !line.includes(P1_EVIDENCE_DIRECTORY))) addFinding('matrix_p1_evidence_mismatch', { expected: P1_EVIDENCE_DIRECTORY });
  }
  if (verifyEvidence) verifyEvidenceDirectory(root, addFinding, { compareWorkspace: compareEvidenceWorkspace });
  checks.push({ id: 'p1-evidence-synchronization', valid: !findings.some((entry) => /(?:catalog|plan|matrix|evidence|artifact|manifest|verification|inventory|rollback)_/.test(entry.code)) });

  const scopeFiles = workspaceScopeFiles(root);
  const classifications = {};
  const unclassified = [];
  for (const file of scopeFiles) {
    const classification = classifyWorkspacePath(file);
    const key = classification ? `${classification.kind}:${classification.phase}` : 'unclassified';
    classifications[key] = (classifications[key] || 0) + 1;
    if (!classification) unclassified.push(file);
  }
  if (unclassified.length) addFinding('workspace_files_unclassified', { files: unclassified });
  checks.push({ id: 'workspace-inventory', valid: unclassified.length === 0 });

  return {
    schema_version: 'aiws.v3-clean.workspace-audit.v3',
    phase: 'P1',
    active: {
      runtime_entrypoint: P1_RUNTIME_ENTRYPOINT,
      http_composition: P1_HTTP_COMPOSITION,
      process_scripts: Object.keys(P1_PROCESS_SCRIPTS).sort()
    },
    deferred: {
      package_scripts: Object.keys(P1_DEFERRED_PACKAGE_SCRIPTS).sort(),
      package_script_roles: Object.fromEntries(Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS)
        .filter(([, definition]) => definition.phase !== 'P1')
        .map(([name, definition]) => [name, { role: definition.role, phase: definition.phase }])),
      retired_route_references: Object.fromEntries([...deferredRouteReferences].sort(([left], [right]) => left.localeCompare(right)))
    },
    evidence: { directory: P1_EVIDENCE_DIRECTORY, verified: verifyEvidence, workspace_comparison: compareEvidenceWorkspace },
    scope_inventory: { files: scopeFiles.length, classifications, unclassified },
    checks,
    findings,
    valid: findings.length === 0
  };
}

function verifyGateSyncContract({ root, governance, plan, matrix, addFinding }) {
  const documentSources = new Map([
    ['AGENTS.md', readText(path.join(root, 'AGENTS.md'), addFinding, 'agents_missing')],
    ['docs/testing.md', readText(path.join(root, 'docs', 'testing.md'), addFinding, 'testing_policy_missing')],
    ['docs/architecture/v3-clean-development-plan.md', plan]
  ]);
  const documents = P1_GATE_SYNC_DOCUMENTS.map((file) => [file, documentSources.get(file) || '']);
  const expectedIds = P1_GATE_SYNC_RULES.map((rule) => rule.id);
  for (const [file, source] of documents) {
    for (const finding of gateSyncDocumentFindings(source, file)) {
      const { code, ...details } = finding;
      addFinding(code, details);
    }
  }
  for (const file of P1_GATE_SYNC_EVIDENCE_DOCUMENTS) {
    const source = file === 'docs/architecture/v23-capability-matrix.md' ? matrix : documents.find(([name]) => name === file)?.[1] || '';
    if (!source.includes(P1_EVIDENCE_DIRECTORY)) addFinding('gate_sync_evidence_reference_missing', { file, expected: P1_EVIDENCE_DIRECTORY });
  }
  const allCatalogPaths = [
    ...(governance?.source_files || []),
    ...(governance?.target_modules || []),
    ...(governance?.behavior_tests || []),
    ...(governance?.ui_tests || [])
  ];
  const catalogPaths = new Set(allCatalogPaths);
  for (const [field, expected] of Object.entries(P1_GATE_SYNC_CATALOG_PATHS)) {
    const actual = governance?.[field] || [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      addFinding('gate_sync_catalog_path_inventory_mismatch', { field, expected, actual });
    }
  }
  for (const field of Object.keys(P1_GATE_SYNC_CATALOG_PATHS)) {
    for (const file of P1_GATE_SYNC_CATALOG_PATHS[field]) {
      if (!catalogPaths.has(file)) addFinding('gate_sync_catalog_path_missing', { field, file });
      if (!fs.existsSync(path.join(root, file))) addFinding('gate_sync_catalog_path_missing_on_disk', { field, file });
      const classification = classifyWorkspacePath(file);
      if (!classification) addFinding('gate_sync_path_unclassified', { file });
    }
  }
  const duplicatePaths = allCatalogPaths.filter((file, index) => allCatalogPaths.indexOf(file) !== index);
  for (const file of [...new Set(duplicatePaths)]) addFinding('gate_sync_catalog_path_duplicate', { file });
  const catalogEvidence = governance?.evidence || [];
  if (JSON.stringify(catalogEvidence) !== JSON.stringify([`${P1_EVIDENCE_DIRECTORY}/verification.json`])) {
    addFinding('gate_sync_catalog_evidence_mismatch', { expected: `${P1_EVIDENCE_DIRECTORY}/verification.json`, actual: catalogEvidence });
  }
  const expectedRuleIds = P1_GATE_SYNC_RULES.map((rule) => rule.id);
  if (JSON.stringify(governance?.gate_sync_rules || []) !== JSON.stringify(expectedRuleIds)) {
    addFinding('gate_sync_catalog_rules_mismatch', { expected: expectedRuleIds, actual: governance?.gate_sync_rules || null });
  }
  if (JSON.stringify(governance?.gate_sync_commands || []) !== JSON.stringify([...P1_GATE_SYNC_COMMANDS])) {
    addFinding('gate_sync_catalog_commands_mismatch', { expected: P1_GATE_SYNC_COMMANDS, actual: governance?.gate_sync_commands || null });
  }
  const packageJson = readJson(path.join(root, 'package.json'), addFinding, 'package_json_invalid') || {};
  const scripts = packageJson.scripts || {};
  const scriptNames = new Set(P1_GATE_SYNC_COMMANDS.map((command) => command.replace(/^pnpm\s+/, '').split(/\s+/)[0]));
  for (const name of scriptNames) {
    if (!Object.hasOwn(scripts, name)) addFinding('gate_sync_package_script_missing', { script: name });
  }
  const matrixP1 = (matrix || '').split(/\r?\n/).filter((line) => line.startsWith('| P1-'));
  if (matrixP1.length && matrixP1.some((line) => !line.includes(P1_EVIDENCE_DIRECTORY))) {
    addFinding('gate_sync_matrix_evidence_mismatch', { expected: P1_EVIDENCE_DIRECTORY });
  }
  for (const id of expectedIds) if (!String(matrix || '').includes(id)) addFinding('gate_sync_matrix_rule_missing', { id });
}

export function gateSyncDocumentFindings(source, file = 'document') {
  const findings = [];
  const rows = gateSyncRuleRows(source);
  const expectedIds = P1_GATE_SYNC_RULES.map((rule) => rule.id);
  const rowIds = rows.map((row) => row.id);
  for (const id of expectedIds) {
    const count = rowIds.filter((actual) => actual === id).length;
    if (count === 0) findings.push({ code: 'gate_sync_rule_missing', file, id });
    if (count > 1) findings.push({ code: 'gate_sync_rule_duplicate', file, id, count });
  }
  for (const id of new Set(rowIds)) if (!expectedIds.includes(id)) findings.push({ code: 'gate_sync_rule_orphan', file, id });
  if (JSON.stringify(rows) !== JSON.stringify(P1_GATE_SYNC_RULES)) {
    findings.push({ code: 'gate_sync_rule_table_mismatch', file, expected: P1_GATE_SYNC_RULES, actual: rows });
  }
  for (const command of P1_GATE_SYNC_COMMANDS) if (!String(source || '').includes(command)) findings.push({ code: 'gate_sync_command_missing', file, command });
  return findings;
}

function gateSyncRuleRows(source) {
  return String(source || '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\|\s*(GS-\d{3})\s*\|\s*(.*?)\s*\|\s*$/);
    return match ? [{ id: match[1], requirement: match[2] }] : [];
  });
}

function verifyEvidenceDirectory(root, addFinding, { compareWorkspace = false } = {}) {
  const directory = path.join(root, P1_EVIDENCE_DIRECTORY);
  if (!fs.existsSync(directory)) {
    addFinding('p1_evidence_missing', { directory: P1_EVIDENCE_DIRECTORY });
    return;
  }
  const missing = P1_EVIDENCE_REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(directory, file)));
  for (const file of missing) addFinding('p1_evidence_artifact_missing', { file: `${P1_EVIDENCE_DIRECTORY}/${file}` });
  if (fs.existsSync(path.join(directory, 'failure.json'))) addFinding('p1_evidence_failure_marker_present');
  if (missing.length) return;
  const manifest = readJson(path.join(directory, 'manifest.json'), addFinding, 'p1_evidence_manifest_invalid');
  const modified = readJson(path.join(directory, 'modified-artifact.json'), addFinding, 'p1_modified_artifact_invalid');
  const verification = readJson(path.join(directory, 'verification.json'), addFinding, 'p1_verification_invalid');
  const workspaceInventory = readJson(path.join(directory, 'workspace-inventory.json'), addFinding, 'p1_workspace_inventory_invalid');
  const scopeInventory = readJson(path.join(directory, 'workspace-scope-inventory.json'), addFinding, 'p1_workspace_scope_inventory_invalid');
  const original = readJson(path.join(directory, 'original-hashes.json'), addFinding, 'p1_original_hashes_invalid');
  if (!manifest || !modified || !verification || !workspaceInventory || !scopeInventory || !original) return;
  for (const file of P1_EVIDENCE_REQUIRED_FILES.filter((file) => file !== 'manifest.json')) {
    if (!Object.hasOwn(manifest.artifacts || {}, file)) addFinding('p1_evidence_manifest_entry_missing', { file });
  }
  for (const [file, expected] of Object.entries(manifest.artifacts || {})) {
    const full = path.join(directory, file);
    if (!fs.existsSync(full)) addFinding('p1_evidence_artifact_missing', { file: `${P1_EVIDENCE_DIRECTORY}/${file}` });
    else if (hashFile(full) !== expected) addFinding('p1_evidence_artifact_hash_mismatch', { file: `${P1_EVIDENCE_DIRECTORY}/${file}` });
  }
  if (compareWorkspace) {
    for (const entry of modified.files || []) {
      const full = path.join(root, entry.path);
      if (!fs.existsSync(full)) addFinding('p1_modified_artifact_missing', { file: entry.path });
      else if (hashFile(full) !== entry.sha256) addFinding('p1_modified_artifact_hash_mismatch', { file: entry.path });
    }
    for (const entry of modified.deleted_files || []) if (fs.existsSync(path.join(root, entry.path))) addFinding('p1_deleted_artifact_restored', { file: entry.path });
    const expectedInventoryPaths = (workspaceInventory.files || []).map((entry) => entry.path).sort();
    const currentInventoryPaths = governedWorkspaceFiles(root);
    if (JSON.stringify(expectedInventoryPaths) !== JSON.stringify(currentInventoryPaths)) {
      addFinding('p1_workspace_inventory_paths_mismatch', { expected_count: expectedInventoryPaths.length, actual_count: currentInventoryPaths.length });
    }
    const currentInventoryRows = [];
    for (const entry of workspaceInventory.files || []) {
      const full = path.join(root, entry.path);
      if (!fs.existsSync(full) || hashFile(full) !== entry.sha256) addFinding('p1_workspace_inventory_hash_mismatch', { file: entry.path });
      else {
        const bytes = fs.statSync(full).size;
        if (bytes !== entry.bytes) addFinding('p1_workspace_inventory_size_mismatch', { file: entry.path, expected: entry.bytes, actual: bytes });
        currentInventoryRows.push({ path: entry.path, sha256: entry.sha256, bytes });
      }
    }
    const inventorySha256 = sha256(canonicalInventory(currentInventoryRows));
    if (workspaceInventory.inventory_sha256 !== inventorySha256) addFinding('p1_workspace_inventory_digest_mismatch');
    if (modified.workspace_inventory_sha256 !== inventorySha256) addFinding('p1_modified_inventory_digest_mismatch');

    const currentScopePaths = workspaceScopeFiles(root);
    const expectedScopeRows = scopeInventory.paths || [];
    const expectedScopePaths = expectedScopeRows.map((entry) => entry.path).sort();
    if (JSON.stringify(expectedScopePaths) !== JSON.stringify(currentScopePaths)) {
      addFinding('p1_workspace_scope_paths_mismatch', { expected_count: expectedScopePaths.length, actual_count: currentScopePaths.length });
    }
    const currentScopeRows = currentScopePaths.map((file) => ({ path: file, classification: classifyWorkspacePath(file) }));
    for (let index = 0; index < Math.min(expectedScopeRows.length, currentScopeRows.length); index += 1) {
      if (JSON.stringify(expectedScopeRows[index]) !== JSON.stringify(currentScopeRows[index])) {
        addFinding('p1_workspace_scope_classification_mismatch', { file: currentScopeRows[index]?.path || expectedScopeRows[index]?.path });
        break;
      }
    }
    if (scopeInventory.inventory_sha256 !== sha256(canonicalScope(currentScopeRows))) addFinding('p1_workspace_scope_digest_mismatch');
  }

  const originalSource = path.join(root, original.source_receipt || '');
  if (!original.source_receipt || !fs.existsSync(originalSource) || hashFile(originalSource) !== original.source_receipt_sha256) {
    addFinding('p1_original_hash_receipt_mismatch');
  }
  for (const finding of evidenceCompletionFindings({ manifest, verification })) addFinding(finding.code, finding.details);
  const patch = path.join(directory, 'change.patch');
  if (compareWorkspace && fs.existsSync(patch)) {
    const reverse = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', patch], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (reverse.status !== 0) addFinding('p1_rollback_patch_check_failed', { stderr: bounded(reverse.stderr) });
  }
}

export function evidenceCompletionFindings({ manifest = {}, verification = {} } = {}) {
  const findings = [];
  const records = verification.commands || verification.checks || [];
  if (manifest.status !== 'verified') findings.push({ code: 'p1_evidence_manifest_not_verified' });
  if (verification.status !== 'passed' || verification.provisional !== false) findings.push({ code: 'p1_verification_not_final' });
  if (!records.length || records.some((entry) => entry.ok !== true || Number(entry.exit_status ?? 1) !== 0)) {
    findings.push({ code: 'p1_verification_commands_not_passed' });
  }
  const rollback = records.find((entry) => String(entry.command || '').includes('isolated-copy rollback.ps1 -Apply'));
  if (!rollback || rollback.ok !== true || Number(rollback.exit_status ?? 1) !== 0
    || !Number.isInteger(rollback.rollback_files_checked) || rollback.rollback_files_checked < 1
    || !Array.isArray(rollback.rollback_mismatches) || rollback.rollback_mismatches.length) {
    findings.push({ code: 'p1_rollback_apply_not_verified' });
  }
  return findings;
}

function collectSourceFiles(root) {
  return ['.github', 'apps', 'packages', 'scripts', 'tests']
    .flatMap((directory) => walk(path.join(root, directory), root))
    .filter((file) => /\.(?:md|mjs|js|ts|tsx|json|ya?ml)$/i.test(file));
}

function collectGovernedFiles(root) {
  const files = ['.github', '.githooks', 'apps', 'packages', 'scripts', 'tests', 'docs/architecture']
    .flatMap((directory) => walk(path.join(root, directory), root));
  for (const file of P1_ACTIVE_MARKDOWN) if (fs.existsSync(path.join(root, file))) files.push(file);
  for (const file of [
    'AGENTS.md', 'README.md', 'Dockerfile', 'compose.yml', 'feature-catalog.json', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'sbom.spdx.json', 'eslint.config.mjs',
    '.dockerignore', '.gitattributes', '.gitignore', '.prettierignore', '.prettierrc.json',
    'docs/v2-retrospective.md'
  ]) {
    if (fs.existsSync(path.join(root, file))) files.push(file);
  }
  return [...new Set(files)].sort();
}

export function governedWorkspaceFiles(root = defaultRoot) {
  return collectGovernedFiles(path.resolve(root));
}

export function workspaceScopeFiles(root = defaultRoot) {
  const resolved = path.resolve(root);
  if (fs.existsSync(path.join(resolved, '.git'))) {
    const result = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: resolved,
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.status === 0) {
      return [...new Set(result.stdout.split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/')))]
        .filter((file) => !/(^|\/)(?:node_modules|dist|coverage)(?:\/|$)/.test(file))
        .sort();
    }
  }
  const receipt = path.join(resolved, 'original-hashes.json');
  if (fs.existsSync(receipt)) {
    try {
      return JSON.parse(fs.readFileSync(receipt, 'utf8')).files.map((entry) => entry.path).sort();
    } catch { /* fall through to the filesystem inventory */ }
  }
  return walkWorkspace(resolved, resolved).sort();
}

function walkWorkspace(directory, root) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.agents', '.ai-workspace', '.pnpm-store', 'node_modules', 'dist', 'coverage', 'temp'].includes(entry.name) || entry.name.startsWith('.tmp-')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkWorkspace(full, root));
    else output.push(path.relative(root, full).replaceAll('\\', '/'));
  }
  return output;
}

function walk(directory, root) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(full, root));
    else output.push(path.relative(root, full).replaceAll('\\', '/'));
  }
  return output;
}

function markdownTargets(source) {
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim());
}

function readText(file, addFinding, code) {
  if (!fs.existsSync(file)) {
    addFinding(code, { file: path.relative(defaultRoot, file).replaceAll('\\', '/') });
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

function readJson(file, addFinding, code) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    addFinding(code, { file: path.basename(file), error: bounded(error?.message || error) });
    return null;
  }
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalInventory(rows) {
  return JSON.stringify(rows.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })));
}

function canonicalScope(rows) {
  return JSON.stringify(rows.map((entry) => ({ path: entry.path, classification: entry.classification })));
}

function bounded(value) {
  return String(value || '').replaceAll(defaultRoot, 'HOST').slice(0, 500);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArgument = process.argv.find((value) => value.startsWith('--root='));
  const result = auditWorkspace({
    root: rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : defaultRoot,
    verifyEvidence: !process.argv.includes('--skip-evidence'),
    compareEvidenceWorkspace: process.argv.includes('--compare-workspace')
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}
