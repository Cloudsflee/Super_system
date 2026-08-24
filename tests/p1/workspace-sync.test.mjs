import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { auditWorkspace, evidenceCompletionFindings, gateSyncDocumentFindings, governedWorkspaceFiles, workspaceScopeFiles } from '../../scripts/v3-clean-workspace-audit.mjs';
import {
  P1_BASELINE_DIRECTORY,
  P1_COMPLETION_BASELINE_DIRECTORY,
  P1_DEFERRED_PACKAGE_SCRIPTS,
  P1_EVIDENCE_DIRECTORY,
  P1_EVIDENCE_REQUIRED_FILES,
  P1_GATE_SYNC_CATALOG_PATHS,
  P1_GATE_SYNC_COMMANDS,
  P1_GATE_SYNC_DOCUMENTS,
  P1_GATE_SYNC_RULES,
  P1_GOVERNANCE_ROWS,
  P1_MATRIX_ROWS,
  P1_PACKAGE_SCRIPT_DEFINITIONS,
  classifyWorkspacePath
} from '../../scripts/lib/v3-clean-p1-scope.mjs';

const root = process.cwd();

test('global P1 audit classifies active and deferred surfaces without Evidence recursion', () => {
  const audit = auditWorkspace({ root, verifyEvidence: false });
  assert.equal(audit.valid, true, JSON.stringify(audit.findings));
  assert.equal(audit.active.runtime_entrypoint, 'apps/api/server.mjs');
  assert.deepEqual(audit.deferred.package_scripts, Object.keys(P1_DEFERRED_PACKAGE_SCRIPTS).sort());
  assert.ok(Object.values(audit.deferred.retired_route_references).reduce((sum, count) => sum + count, 0) > 0);
  assert.equal(audit.evidence.directory, P1_EVIDENCE_DIRECTORY);
  assert.equal(audit.scope_inventory.files, workspaceScopeFiles(root).length);
  assert.deepEqual(audit.scope_inventory.unclassified, []);
  assert.ok(audit.scope_inventory.files > 700);
  assert.ok(governedWorkspaceFiles(root).includes('docs/v2-retrospective.md'));
});

test('gate synchronization contract is present in every governing surface', () => {
  const documents = P1_GATE_SYNC_DOCUMENTS.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  for (const rule of P1_GATE_SYNC_RULES) {
    assert.ok(documents.every((source) => source.includes(rule.id)), rule.id);
  }
  for (const command of P1_GATE_SYNC_COMMANDS) {
    assert.ok(documents.every((source) => source.includes(command)), command);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'feature-catalog.json'), 'utf8'));
  const matrix = fs.readFileSync(path.join(root, 'docs/architecture/v23-capability-matrix.md'), 'utf8');
  const governance = catalog.features.find((feature) => feature.id === 'REC-D0-GOVERNANCE-000');
  const paths = new Set([
    ...(governance.source_files || []), ...(governance.target_modules || []),
    ...(governance.behavior_tests || []), ...(governance.ui_tests || [])
  ]);
  for (const group of Object.values(P1_GATE_SYNC_CATALOG_PATHS)) {
    for (const file of group) assert.ok(paths.has(file), file);
  }
  assert.deepEqual(governance.evidence, ['docs/evidence/v3-clean-p1-gate-contract-complete-20260819/verification.json']);
  assert.deepEqual(governance.gate_sync_rules, P1_GATE_SYNC_RULES.map((rule) => rule.id));
  assert.deepEqual(governance.gate_sync_commands, [...P1_GATE_SYNC_COMMANDS]);
  for (const rule of P1_GATE_SYNC_RULES) assert.match(matrix, new RegExp(rule.id));
});

test('gate synchronization parser rejects duplicate ids and rule text drift', () => {
  const source = fs.readFileSync(path.join(root, 'docs/testing.md'), 'utf8');
  assert.deepEqual(gateSyncDocumentFindings(source, 'docs/testing.md'), []);
  const ruleLine = source.split(/\r?\n/).find((line) => line.startsWith('| GS-001 |'));
  const duplicateCodes = new Set(gateSyncDocumentFindings(`${source}\n${ruleLine}\n`, 'duplicate.md').map((entry) => entry.code));
  assert.ok(duplicateCodes.has('gate_sync_rule_duplicate'));
  assert.ok(duplicateCodes.has('gate_sync_rule_table_mismatch'));
  const drifted = source.replace('MUST trigger gate-sync review.', 'MUST trigger review.');
  assert.ok(gateSyncDocumentFindings(drifted, 'drifted.md').some((entry) => entry.code === 'gate_sync_rule_table_mismatch'));
});

test('completion baseline records the remaining pre-fix synchronization gaps', () => {
  const baseline = path.join(root, P1_COMPLETION_BASELINE_DIRECTORY);
  assert.ok(fs.existsSync(path.join(baseline, 'original-hashes.json')));
  const classification = JSON.parse(fs.readFileSync(path.join(baseline, 'workspace-classification-baseline.json'), 'utf8'));
  assert.equal(classification.files, 743);
  assert.equal(classification.unclassified.length, 6);
  assert.ok(classification.unclassified.every((file) => file.startsWith('愿景与范围文档模板/')));
  const audit = auditWorkspace({ root: baseline, verifyEvidence: false });
  const codes = new Set(audit.findings.map((entry) => entry.code));
  assert.equal(audit.valid, false);
  for (const code of [
    'catalog_p1_evidence_mismatch',
    'catalog_p1_path_missing',
    'catalog_p1_path_unregistered',
    'plan_p1_evidence_mismatch',
    'matrix_p1_evidence_mismatch'
  ]) assert.ok(codes.has(code), code);
});

test('gate complete baseline records the task-start synchronization gap', () => {
  const baseline = path.join(root, P1_BASELINE_DIRECTORY);
  assert.ok(fs.existsSync(path.join(baseline, 'original-hashes.json')));
  const original = JSON.parse(fs.readFileSync(path.join(baseline, 'original-hashes.json'), 'utf8'));
  assert.ok(original.files.some((entry) => entry.path === 'docs/v2-retrospective.md'));
  const audit = auditWorkspace({ root: baseline, verifyEvidence: false });
  const codes = new Set(audit.findings.map((entry) => entry.code));
  assert.equal(audit.valid, false);
  assert.ok(codes.has('catalog_p1_evidence_mismatch'));
  assert.ok(codes.has('gate_sync_evidence_reference_missing'));
});

test('workspace path classifier keeps later phases separate from P1', () => {
  assert.deepEqual(classifyWorkspacePath('apps/api/src/clean/runtime.mjs').rows, ['P1-PLATFORM-001', 'P1-PLATFORM-002']);
  assert.deepEqual(classifyWorkspacePath('scripts/v3-clean-workspace-audit.mjs').rows, P1_GOVERNANCE_ROWS);
  assert.deepEqual(classifyWorkspacePath('scripts/v3-clean-architecture-scan.mjs').rows, P1_MATRIX_ROWS);
  assert.equal(classifyWorkspacePath('scripts/check.mjs').phase, 'P1');
  assert.equal(classifyWorkspacePath('apps/api/src/modules/identity/service.mjs').phase, 'P2-P8');
  assert.equal(classifyWorkspacePath('apps/runner-broker/server.mjs').phase, 'P6');
  assert.equal(classifyWorkspacePath('apps/web/src/App.tsx').phase, 'P6');
  assert.equal(classifyWorkspacePath('compose.yml').phase, 'P8-P9');
  assert.equal(classifyWorkspacePath('愿景与范围文档模板/愿景与范围文档模板_中文融合版.docx').kind, 'non_product');
});

test('every package script has one exact P1 or deferred classification', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), Object.keys(P1_PACKAGE_SCRIPT_DEFINITIONS).sort());
  for (const [name, definition] of Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS)) {
    assert.equal(packageJson.scripts[name], definition.command, name);
    assert.ok(definition.role);
    assert.ok(definition.phase);
  }
});

test('Evidence completion requires final state and an applied byte-exact rollback', () => {
  const rollback = {
    command: 'isolated-copy rollback.ps1 -Apply',
    exit_status: 0,
    ok: true,
    rollback_files_checked: 1,
    rollback_mismatches: []
  };
  const complete = {
    manifest: { status: 'verified' },
    verification: { status: 'passed', provisional: false, commands: [rollback] }
  };
  assert.deepEqual(evidenceCompletionFindings(complete), []);
  assert.ok(evidenceCompletionFindings({ ...complete, verification: { ...complete.verification, provisional: true } })
    .some((entry) => entry.code === 'p1_verification_not_final'));
  assert.ok(evidenceCompletionFindings({
    ...complete,
    verification: { ...complete.verification, commands: [{ ...rollback, rollback_mismatches: ['README.md'] }] }
  }).some((entry) => entry.code === 'p1_rollback_apply_not_verified'));
  for (const file of ['modified-artifact.json', 'change.patch', 'verification.json', 'rollback.ps1', 'workspace-scope-inventory.json']) {
    assert.ok(P1_EVIDENCE_REQUIRED_FILES.includes(file), file);
  }
});
