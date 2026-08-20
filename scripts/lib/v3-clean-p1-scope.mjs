export const P1_EVIDENCE_DIRECTORY = 'docs/evidence/v3-clean-p1-gate-contract-complete-20260819';
export const P1_PARENT_EVIDENCE_DIRECTORY = 'docs/evidence/v3-clean-p1-completion-audit-20260819';
export const P1_BASELINE_DIRECTORY = '.ai-workspace/v3-clean-p1-gate-contract-complete-baseline-20260819';
export const P1_COMPLETION_BASELINE_DIRECTORY = '.ai-workspace/v3-clean-p1-completion-audit-baseline-20260819';

export const P1_GATE_SYNC_RULES = Object.freeze([
  Object.freeze({ id: 'GS-001', requirement: 'A change to tests, gate commands, routes, schemas, ownership, phase scope, status rules, or receipt shapes MUST trigger gate-sync review.' }),
  Object.freeze({ id: 'GS-002', requirement: 'The phase plan, testing policy, package/CI commands, gate implementation, tests, Catalog/matrix, and Evidence references MUST update atomically.' }),
  Object.freeze({ id: 'GS-003', requirement: 'Every governed inventory MUST be bidirectional and MUST reject missing, stale, duplicate, and orphan entries.' }),
  Object.freeze({ id: 'GS-004', requirement: 'Every Git-visible non-build path MUST be classified; every new governance file MUST declare an owner and phase and be registered in the Catalog.' }),
  Object.freeze({ id: 'GS-005', requirement: 'Only final verified, non-provisional receipts MAY promote status; failed and checkpoint receipts remain immutable.' }),
  Object.freeze({ id: 'GS-006', requirement: 'Rollback verification MUST include a runnable dry-run and an isolated actual apply with byte-exact comparison.' }),
  Object.freeze({ id: 'GS-007', requirement: 'Any gate failure MUST freeze the affected Catalog status and block dependent phases.' })
]);

export const P1_GATE_SYNC_DOCUMENTS = Object.freeze([
  'AGENTS.md',
  'docs/testing.md',
  'docs/architecture/v3-clean-development-plan.md'
]);

export const P1_GATE_SYNC_EVIDENCE_DOCUMENTS = Object.freeze([
  'docs/testing.md',
  'docs/architecture/v3-clean-development-plan.md',
  'docs/architecture/v23-capability-matrix.md'
]);

export const P1_GATE_SYNC_COMMANDS = Object.freeze([
  'pnpm check',
  'pnpm audit:p1',
  'pnpm scan:clean',
  'pnpm test:p1',
  'pnpm recovery:plan',
  'pnpm recovery:catalog',
  'pnpm recovery:coverage',
  'pnpm recovery:impact -- --audit',
  'pnpm verify'
]);

export const P1_GATE_SYNC_CATALOG_PATHS = Object.freeze({
  source_files: Object.freeze([
    'AGENTS.md',
    'docs/architecture/v23-capability-matrix.md',
    'docs/architecture/v3-clean-development-plan.md',
    'docs/testing.md',
    'scripts/lib/v3-clean-p1-scope.mjs',
    'scripts/v3-clean-workspace-audit.mjs',
    'scripts/v3-clean-architecture-scan.mjs',
    'scripts/catalog-loader.mjs',
    'scripts/layered-gate.mjs',
    'scripts/lib/immutable-evidence-writer.mjs',
    'scripts/v3-clean-p31-evidence.mjs',
    'docs/architecture/decision-log.md'
  ]),
  target_modules: Object.freeze([
    'feature-catalog.json',
    'package.json',
    'apps/api/src/modules/registry.mjs',
    'apps/api/src/modules/platform',
    'scripts/recovery-governance.mjs',
    'scripts/recovery-evidence.mjs',
    'scripts/check.mjs',
    'scripts/verify.mjs',
    'scripts/v3-clean-p1-global-sync-evidence.mjs',
    'scripts/v3-clean-p3-evidence.mjs',
    'feature-catalog.index.json',
    'feature-catalog.clean.json',
    'feature-catalog.historical.json'
  ]),
  behavior_tests: Object.freeze([
    'tests/unit/recovery-governance.test.mjs',
    'tests/p1/workspace-sync.test.mjs',
    'tests/p31/catalog-split.test.mjs',
    'tests/p31/layered-gates.test.mjs',
    'tests/p31/evidence-immutability.test.mjs'
  ]),
  ui_tests: Object.freeze([])
});

export const P1_EVIDENCE_REQUIRED_FILES = Object.freeze([
  'manifest.json',
  'modified-artifact.json',
  'original-hashes.json',
  'workspace-inventory.json',
  'workspace-scope-inventory.json',
  'verification.json',
  'change.patch',
  'rollback.ps1',
  'workspace-audit.json',
  'architecture-scan.json',
  'parent-receipt.json',
  'schema-snapshot.json',
  'schema-inventory.json',
  'cas-manifest.json',
  'golden-receipt.json',
  'route-inventory.json',
  'owner-manifest.json',
  'task-manifest.json',
  'gate-sync-contract.json'
]);

export const P1_PLATFORM_ROWS = Object.freeze(['P1-PLATFORM-001', 'P1-PLATFORM-002']);
export const P1_GOVERNANCE_ROWS = Object.freeze(['P1-GOVERNANCE-003']);
export const P1_MATRIX_ROWS = Object.freeze([...P1_PLATFORM_ROWS, ...P1_GOVERNANCE_ROWS]);

export const P1_RUNTIME_ENTRYPOINT = 'apps/api/server.mjs';
export const P1_HTTP_COMPOSITION = 'apps/api/clean-server.mjs';
export const P1_CLEAN_ROOT = 'apps/api/src/clean/';

export const P1_PACKAGE_SCRIPT_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries({
  dev: { command: 'node scripts/dev.mjs', role: 'active_process', phase: 'P1' },
  'dev:clean': { command: 'node apps/api/server.mjs', role: 'active_process', phase: 'P1' },
  'dev:api': { command: 'node apps/api/server.mjs', role: 'active_process', phase: 'P1' },
  'fixture:legacy:dev-broker': { command: 'node apps/runner-broker/server.mjs', role: 'deferred_fixture', phase: 'P6' },
  start: { command: 'node apps/api/server.mjs', role: 'active_process', phase: 'P1' },
  'start:clean': { command: 'node apps/api/server.mjs', role: 'active_process', phase: 'P1' },
  build: { command: 'corepack pnpm --filter @aiws/web build', role: 'characterization_gate', phase: 'P9' },
  check: { command: 'node scripts/check.mjs', role: 'p1_gate', phase: 'P1' },
  'scan:clean': { command: 'node scripts/v3-clean-architecture-scan.mjs', role: 'p1_gate', phase: 'P1' },
  'audit:p1': { command: 'node scripts/v3-clean-workspace-audit.mjs', role: 'p1_gate', phase: 'P1' },
  typecheck: { command: 'corepack pnpm --filter @aiws/web typecheck', role: 'characterization_gate', phase: 'P9' },
  test: { command: 'node --test tests/unit/*.test.mjs && corepack pnpm --filter @aiws/web test', role: 'characterization_gate', phase: 'P2-P9' },
  'test:p1': { command: 'node --test tests/p1/*.test.mjs tests/integration/v3-clean-p1.test.mjs tests/security/v3-clean-p1.test.mjs', role: 'p1_gate', phase: 'P1' },
  'test:p2': { command: 'node --test tests/p2/*.test.mjs', role: 'characterization_gate', phase: 'P2' },
  'test:p3': { command: 'node --test tests/p3/*.test.mjs', role: 'p3_gate', phase: 'P3' },
  'test:p31': { command: 'node --test tests/p31/*.test.mjs', role: 'p31_gate', phase: 'P3.1' },
  'evidence:p3': { command: 'node scripts/v3-clean-p3-evidence.mjs', role: 'p3_evidence', phase: 'P3' },
  'evidence:p31': { command: 'node scripts/v3-clean-p31-evidence.mjs', role: 'p31_evidence', phase: 'P3.1' },
  'test:integration': { command: 'node scripts/layered-gate.mjs integration', role: 'layered_gate', phase: 'P3.1' },
  'test:integration:clean': { command: 'node scripts/layered-gate.mjs integration --clean', role: 'p31_gate', phase: 'P3.1' },
  'fixture:legacy:integration': { command: 'node scripts/layered-gate.mjs integration --historical', role: 'deferred_fixture', phase: 'historical' },
  'test:e2e': { command: 'node scripts/e2e.mjs', role: 'characterization_gate', phase: 'P9' },
  'test:security': { command: 'node scripts/layered-gate.mjs security', role: 'layered_gate', phase: 'P3.1' },
  'test:security:clean': { command: 'node scripts/layered-gate.mjs security --clean', role: 'p31_gate', phase: 'P3.1' },
  'fixture:legacy:security': { command: 'node scripts/layered-gate.mjs security --historical', role: 'deferred_fixture', phase: 'historical' },
  'test:release': { command: 'node --test tests/release/*.test.mjs', role: 'characterization_gate', phase: 'P8-P9' },
  'test:runner-real': { command: 'node scripts/runner-real-smoke.mjs', role: 'characterization_gate', phase: 'P6' },
  'github:seed-fixture': { command: 'node scripts/github-seed-fixture.mjs', role: 'deferred_fixture', phase: 'P7' },
  verify: { command: 'node scripts/verify.mjs', role: 'p1_gate', phase: 'P1' },
  'fixture:seed-demo': { command: 'node scripts/seed-demo.mjs', role: 'deferred_fixture', phase: 'P3' },
  'archive:v23': { command: 'node scripts/archive-v23.mjs', role: 'historical_maintenance', phase: 'historical' },
  'fixture:legacy:acceptance': { command: 'node scripts/acceptance.mjs', role: 'deferred_fixture', phase: 'P2-P9' },
  'fixture:legacy:e2e': { command: 'node scripts/e2e-legacy.mjs', role: 'deferred_fixture', phase: 'historical' },
  'fixture:legacy:release-build': { command: 'node scripts/release-build.mjs', role: 'deferred_fixture', phase: 'P8-P9' },
  'fixture:legacy:release-rehearse': { command: 'node scripts/release-rehearsal.mjs', role: 'deferred_fixture', phase: 'P8-P9' },
  'fixture:legacy:release-promote': { command: 'node scripts/release-promote.mjs', role: 'deferred_fixture', phase: 'P8-P9' },
  'recovery:plan': { command: 'node scripts/recovery-governance.mjs plan', role: 'p1_governance', phase: 'P1' },
  'recovery:catalog': { command: 'node scripts/recovery-governance.mjs catalog', role: 'p1_governance', phase: 'P1' },
  'recovery:coverage': { command: 'node scripts/recovery-governance.mjs coverage', role: 'p1_governance', phase: 'P1' },
  'recovery:impact': { command: 'node scripts/recovery-governance.mjs impact', role: 'p1_governance', phase: 'P1' }
}).map(([name, definition]) => [name, Object.freeze(definition)])));

export const P1_PROCESS_SCRIPTS = Object.freeze(Object.fromEntries(Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS)
  .filter(([, definition]) => definition.role === 'active_process')
  .map(([name, definition]) => [name, definition.command])));

export const P1_DEFERRED_PACKAGE_SCRIPTS = Object.freeze(Object.fromEntries(Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS)
  .filter(([, definition]) => definition.phase !== 'P1')
  .map(([name, definition]) => [name, definition.command])));

export const P1_FORBIDDEN_PACKAGE_SCRIPTS = Object.freeze([
  'dev:broker',
  'acceptance',
  'release:build',
  'release:rehearse',
  'release:promote'
]);

export const P1_LEGACY_SERVER_IMPORTERS = Object.freeze([
  'scripts/acceptance.mjs',
  'scripts/e2e-legacy.mjs',
  'scripts/r5-e2e.mjs',
  'tests/integration/debt-regression.test.mjs',
  'tests/integration/helpers.mjs',
  'tests/security/credentials.test.mjs'
]);

export const P1_RETIRED_ROUTE_PROBES = Object.freeze([
  'tests/p1/clean-platform.test.mjs',
  'tests/security/v3-clean-p1.test.mjs'
]);

export const P1_ACTIVE_MARKDOWN = Object.freeze([
  'AGENTS.md',
  'README.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/document-index.md',
  'docs/requirements-traceability.md',
  'docs/runbook.md',
  'docs/testing.md',
  'docs/threat-model.md',
  'docs/architecture/api-v2-contract.md',
  'docs/architecture/clean-schema.md',
  'docs/architecture/decision-log.md',
  'docs/architecture/import-contract.md',
  'docs/architecture/v23-capability-matrix.md',
  'docs/architecture/v3-clean-break.md',
  'docs/architecture/v3-clean-development-plan.md'
]);

const P1_PLATFORM_FILES = new Set([
  P1_RUNTIME_ENTRYPOINT,
  P1_HTTP_COMPOSITION,
  'scripts/dev.mjs',
  'scripts/v3-clean-p1-evidence.mjs',
  'tests/p1/clean-platform.test.mjs',
  'tests/integration/v3-clean-p1.test.mjs',
  'tests/security/v3-clean-p1.test.mjs'
]);

const P1_GOVERNANCE_FILES = new Set([
  'scripts/check.mjs',
  'scripts/verify.mjs',
  'scripts/recovery-governance.mjs',
  'scripts/v3-clean-architecture-scan.mjs',
  'scripts/v3-clean-workspace-audit.mjs',
  'scripts/v3-clean-p1-global-sync-evidence.mjs',
  'scripts/lib/v3-clean-p1-scope.mjs',
  'tests/p1/workspace-sync.test.mjs',
  'tests/unit/recovery-governance.test.mjs'
]);

export function classifyWorkspacePath(value) {
  const file = normalize(value);
  if (!file) return null;
  if (P1_GOVERNANCE_FILES.has(file)) {
    const rows = file === 'scripts/v3-clean-architecture-scan.mjs' ? P1_MATRIX_ROWS : P1_GOVERNANCE_ROWS;
    return { kind: 'p1', phase: 'P1', rows: [...rows] };
  }
  if (file.startsWith(P1_CLEAN_ROOT) || file.startsWith('tests/p1/') || P1_PLATFORM_FILES.has(file)) {
    return { kind: 'p1', phase: 'P1', rows: [...P1_PLATFORM_ROWS] };
  }
  if (file === 'apps/api/server-legacy.mjs') return { kind: 'fixture', phase: 'P2-P9', reason: 'historical API runtime' };
  if (file.startsWith('apps/api/src/')) return { kind: 'fixture', phase: 'P2-P8', reason: 'historical domain/runtime input' };
  if (file.startsWith('apps/web/')) return { kind: 'fixture', phase: 'P9', reason: 'pre-clean Web characterization' };
  if (file.startsWith('apps/runner-broker/')) return { kind: 'fixture', phase: 'P6', reason: 'runner adapter characterization' };
  if (file.startsWith('packages/')) return { kind: 'fixture', phase: 'P2-P9', reason: 'pre-clean shared contract' };
  if (file.startsWith('tests/') || file.startsWith('scripts/')) return { kind: 'fixture', phase: 'P2-P9', reason: 'historical behavior or future-phase tool' };
  if (file.startsWith('docs/evidence/')) return { kind: 'evidence', phase: 'P0-P9' };
  if (file.startsWith('docs/archive/')) return { kind: 'archive', phase: 'historical' };
  if (file.startsWith('docs/architecture/') || P1_ACTIVE_MARKDOWN.includes(file)) return { kind: 'governance', phase: 'P0-P9' };
  if (file.startsWith('.github/') || file.startsWith('.githooks/')) return { kind: 'governance', phase: 'P0-P9' };
  if (file.startsWith('doc/') || file.startsWith('探索/') || file.startsWith('探索-1/') || file.startsWith('当前项目毕业设计任务书/') || file.startsWith('任务书/') || file.startsWith('愿景与范围文档模板/')) {
    return { kind: 'non_product', phase: 'unscoped research' };
  }
  if (file.startsWith('docs/')) return { kind: 'supporting_document', phase: 'P0-P9' };
  if (['Dockerfile', 'compose.yml', 'docker/'].some((prefix) => file === prefix || file.startsWith(prefix))) {
    return { kind: 'fixture', phase: 'P8-P9', reason: 'deferred deployment surface' };
  }
  if (/^(?:AGENTS\.md|README\.md|feature-catalog(?:\.(?:clean|historical|index))?\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|sbom\.spdx\.json|eslint\.config\.mjs|\.[^/]+)$/.test(file)) {
    return { kind: 'governance', phase: 'P0-P9' };
  }
  return null;
}

function normalize(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}
