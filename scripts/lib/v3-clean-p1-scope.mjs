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
    'scripts/production-lifecycle.mjs',
    'scripts/v3-clean-workspace-audit.mjs',
    'scripts/v3-clean-architecture-scan.mjs',
    'scripts/catalog-loader.mjs',
    'scripts/layered-gate.mjs',
    'scripts/lib/immutable-evidence-writer.mjs',
    'scripts/v3-clean-p31-evidence.mjs',
    'scripts/v3-clean-p4-evidence.mjs',
    'scripts/lib/gate-process.mjs',
    'scripts/lib/git-blob.mjs',
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
    'scripts/verify-dev.mjs',
    'scripts/test.mjs',
    'scripts/recovery-golden.mjs',
    'scripts/v3-clean-p1-global-sync-evidence.mjs',
    'scripts/v3-clean-p3-evidence.mjs',
    'feature-catalog.index.json',
    'feature-catalog.clean.json',
    'feature-catalog.historical.json',
    'scripts/v3-clean-p10-parity.mjs',
    'scripts/v3-clean-p10-evidence.mjs',
    'scripts/lib/p10-post-closure.mjs',
    '.githooks/pre-push'
  ]),
  behavior_tests: Object.freeze([
    'tests/unit/recovery-governance.test.mjs',
    'tests/p1/workspace-sync.test.mjs',
    'tests/p31/catalog-split.test.mjs',
    'tests/p31/layered-gates.test.mjs',
    'tests/p31/evidence-immutability.test.mjs',
    'tests/p4/governance-sync.test.mjs',
    'tests/p5/migration.test.mjs',
    'tests/p6/governance-sync.test.mjs',
    'tests/p7/governance-sync.test.mjs',
    'tests/p8/governance.test.mjs',
    'tests/release/p10-final-gate.test.mjs',
    'tests/security/boundary.test.mjs',
    'tests/p10/parity-governance.test.mjs',
    'tests/p10/migration.test.mjs',
    'tests/p10/post-closure.test.mjs',
    'tests/p10/development-reliability.test.mjs',
    'tests/unit/recovery-golden.test.mjs',
    'tests/integration/mcp-stdio-r5.test.mjs',
    'tests/integration/codex-provider-flow.test.mjs'
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
  'dev:broker': { command: 'node apps/runner-broker/clean-server.mjs', role: 'active_process', phase: 'P6' },
  'fixture:legacy:dev-broker': { command: 'node apps/runner-broker/server.mjs', role: 'deferred_fixture', phase: 'P6' },
  start: { command: 'node apps/api/server.mjs', role: 'active_process', phase: 'P1' },
  'start:clean': { command: 'node apps/api/server.mjs', role: 'active_process', phase: 'P1' },
  build: { command: 'corepack pnpm --filter @aiws/web build', role: 'characterization_gate', phase: 'P9' },
  check: { command: 'node scripts/check.mjs', role: 'p1_gate', phase: 'P1' },
  'scan:clean': { command: 'node scripts/v3-clean-architecture-scan.mjs', role: 'p1_gate', phase: 'P1' },
  'audit:p1': { command: 'node scripts/v3-clean-workspace-audit.mjs', role: 'p1_gate', phase: 'P1' },
  typecheck: { command: 'corepack pnpm --filter @aiws/web typecheck', role: 'characterization_gate', phase: 'P9' },
  test: { command: 'node scripts/test.mjs', role: 'characterization_gate', phase: 'P2-P10' },
  'test:p1': { command: 'node --test tests/p1/*.test.mjs tests/integration/v3-clean-p1.test.mjs tests/security/v3-clean-p1.test.mjs', role: 'p1_gate', phase: 'P1' },
  'test:p2': { command: 'node --test tests/p2/*.test.mjs', role: 'characterization_gate', phase: 'P2' },
  'test:p3': { command: 'node --test tests/p3/http-contract.test.mjs tests/p3/migration.test.mjs tests/p3/project-workflow.test.mjs', role: 'p3_gate', phase: 'P3' },
  'test:p31': { command: 'node --test tests/p31/*.test.mjs', role: 'p31_gate', phase: 'P3.1' },
  'test:p4': { command: 'node --test tests/p4/*.test.mjs', role: 'p4_gate', phase: 'P4' },
  'test:p5': { command: 'node --test tests/p5/*.test.mjs', role: 'p5_gate', phase: 'P5' },
  'test:p6': { command: 'node --test tests/p6/*.test.mjs', role: 'p6_gate', phase: 'P6' },
  'test:p7': { command: 'node --test tests/p7/*.test.mjs', role: 'p7_gate', phase: 'P7' },
  'test:p8': { command: 'node --test tests/p8/*.test.mjs', role: 'p8_gate', phase: 'P8' },
  'test:p9': { command: 'node --test tests/p9/*.test.mjs', role: 'p9_gate', phase: 'P9' },
  'test:p10': { command: 'node --test tests/p10/*.test.mjs', role: 'p10_gate', phase: 'P10' },
  'audit:parity': { command: 'node scripts/v3-clean-p10-parity.mjs', role: 'p10_gate', phase: 'P10' },
  'evidence:p3': { command: 'node scripts/v3-clean-p3-evidence.mjs', role: 'p3_evidence', phase: 'P3' },
  'evidence:p31': { command: 'node scripts/v3-clean-p31-evidence.mjs', role: 'p31_evidence', phase: 'P3.1' },
  'evidence:p4': { command: 'node scripts/v3-clean-p4-evidence.mjs', role: 'p4_evidence', phase: 'P4' },
  'evidence:p5': { command: 'node scripts/v3-clean-p5-evidence.mjs', role: 'p5_evidence', phase: 'P5' },
  'evidence:p6': { command: 'node scripts/v3-clean-p6-evidence.mjs', role: 'p6_evidence', phase: 'P6' },
  'evidence:p7': { command: 'node scripts/v3-clean-p7-evidence.mjs', role: 'p7_evidence', phase: 'P7' },
  'evidence:p8': { command: 'node scripts/v3-clean-p8-evidence.mjs', role: 'p8_evidence', phase: 'P8' },
  'evidence:p9': { command: 'node scripts/v3-clean-p9-evidence.mjs', role: 'p9_evidence', phase: 'P9' },
  'evidence:p10': { command: 'node scripts/v3-clean-p10-evidence.mjs', role: 'p10_evidence', phase: 'P10' },
  'test:integration': { command: 'node scripts/layered-gate.mjs integration', role: 'layered_gate', phase: 'P3.1' },
  'test:integration:clean': { command: 'node scripts/layered-gate.mjs integration --clean', role: 'p31_gate', phase: 'P3.1' },
  'fixture:legacy:integration': { command: 'node scripts/layered-gate.mjs integration --historical', role: 'deferred_fixture', phase: 'historical' },
  'test:e2e': { command: 'node scripts/e2e.mjs', role: 'characterization_gate', phase: 'P9' },
  'test:security': { command: 'node scripts/layered-gate.mjs security', role: 'layered_gate', phase: 'P3.1' },
  'test:security:clean': { command: 'node scripts/layered-gate.mjs security --clean', role: 'p31_gate', phase: 'P3.1' },
  'fixture:legacy:security': { command: 'node scripts/layered-gate.mjs security --historical', role: 'deferred_fixture', phase: 'historical' },
  'test:release': { command: 'node --test tests/release/*.test.mjs', role: 'characterization_gate', phase: 'P8-P9' },
  'test:runner-real': { command: 'node scripts/runner-real-smoke.mjs', role: 'characterization_gate', phase: 'P6' },
  'test:development': { command: 'node --test tests/p10/development-reliability.test.mjs', role: 'development_gate', phase: 'P10+' },
  'probe:development': { command: 'node scripts/runner-real-smoke.mjs', role: 'development_probe', phase: 'P10+' },
  'github:seed-fixture': { command: 'node scripts/github-seed-fixture.mjs', role: 'deferred_fixture', phase: 'P7' },
  'verify:dev': { command: 'node scripts/verify-dev.mjs', role: 'development_gate', phase: 'P10+' },
  verify: { command: 'node scripts/verify.mjs', role: 'p1_gate', phase: 'P1' },
  'development:receipt': { command: 'node scripts/development-receipt.mjs', role: 'operations_receipt', phase: 'P10+' },
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
  'scripts/verify-dev.mjs',
  'scripts/test.mjs',
  'scripts/lib/gate-process.mjs',
  'scripts/recovery-governance.mjs',
  'scripts/v3-clean-architecture-scan.mjs',
  'scripts/v3-clean-workspace-audit.mjs',
  'scripts/v3-clean-p1-global-sync-evidence.mjs',
  'scripts/lib/v3-clean-p1-scope.mjs',
  'tests/p1/workspace-sync.test.mjs',
  'tests/unit/recovery-governance.test.mjs'
]);

const P4_FILES = new Set([
  'apps/api/src/clean/command-dispatcher.mjs',
  'apps/api/src/clean/context-service.mjs',
  'apps/api/src/clean/gateway-service.mjs',
  'apps/api/src/clean/mcp-service.mjs',
  'apps/api/src/clean/migrations/004-context-projection-mcp.mjs',
  'apps/gateway/package.json',
  'apps/gateway/server.mjs',
  'scripts/mcp-stdio.mjs',
  'scripts/v3-clean-p4-evidence.mjs',
  'scripts/v3-clean-p4-gateway-probe.mjs',
  'scripts/v3-clean-p4-performance.mjs',
  'apps/web/src/features/context/ContextPage.tsx',
  'apps/web/src/features/context/McpSettings.tsx',
  'apps/web/src/features/context/McpSettingsPage.tsx',
  'apps/web/src/features/context/index.ts',
  'apps/web/src/features/context/types.ts',
  'apps/web/src/test/context.test.tsx'
]);

const P5_FILES = new Set([
  'apps/api/src/clean/assist-service.mjs',
  'apps/api/src/clean/app-server-adapter.mjs',
  'apps/api/src/clean/bridge-service.mjs',
  'apps/api/src/clean/files-service.mjs',
  'apps/api/src/clean/p5-domain-helpers.mjs',
  'apps/api/src/clean/terminal-service.mjs',
  'apps/api/src/clean/windows-bridge-adapter.mjs',
  'apps/api/src/clean/migrations/005-assist-files-terminal-bridge.mjs',
  'apps/windows-native-bridge/package.json',
  'apps/windows-native-bridge/probe.mjs',
  'apps/windows-native-bridge/server.mjs',
  'apps/windows-native-bridge/src/protocol.mjs',
  'scripts/v3-clean-p5-assist-probe.mjs',
  'scripts/v3-clean-p5-bridge-probe.mjs',
  'scripts/v3-clean-p5-performance.mjs',
  'scripts/v3-clean-p5-evidence.mjs',
  'tests/p5/assist-files.test.mjs',
  'tests/p5/helpers.mjs',
  'tests/p5/migration.test.mjs',
  'tests/p5/terminal-bridge.test.mjs'
]);

const P5_WEB_FILES = new Set([
  'apps/web/src/App.tsx',
  'apps/web/src/styles.css',
  'apps/web/src/workspace.ts',
  'apps/web/src/features/context/McpSettingsPage.tsx',
  'apps/web/src/test/assist.test.tsx',
  'apps/web/src/test/approvals-p5.test.tsx',
  'apps/web/src/test/connections-p5.test.tsx',
  'apps/web/src/test/files-p5.test.tsx',
  'apps/web/src/test/terminal.test.tsx'
]);

const P5_WEB_PREFIXES = Object.freeze([
  'apps/web/src/features/assist/',
  'apps/web/src/features/approvals/',
  'apps/web/src/features/connections/',
  'apps/web/src/features/files/',
  'apps/web/src/features/terminal/'
]);

const P6_FILES = new Set([
  'apps/api/src/clean/execution-service.mjs',
  'apps/api/src/clean/runner-adapters.mjs',
  'apps/api/src/clean/runner-protocol.mjs',
  'apps/api/src/clean/runner-service.mjs',
  'apps/api/src/clean/windows-bridge-adapter.mjs',
  'apps/api/src/clean/migrations/006-runner-execution-checkpoint-replay.mjs',
  'apps/runner-broker/package.json',
  'apps/runner-broker/clean-server.mjs',
  'apps/windows-native-bridge/server.mjs',
  'apps/windows-native-bridge/src/protocol.mjs',
  'packages/contracts/src/clean-v2.mjs',
  'scripts/lib/v3-clean-p6-runner-probe.mjs',
  'scripts/v3-clean-p6-performance.mjs',
  'scripts/v3-clean-p6-docker-runner-probe.mjs',
  'scripts/v3-clean-p6-host-runner-probe.mjs',
  'scripts/v3-clean-p6-bridge-runner-probe.mjs',
  'scripts/v3-clean-p6-restart-probe.mjs',
  'scripts/v3-clean-p6-evidence.mjs',
  'apps/web/src/App.tsx',
  'apps/web/src/styles.css',
  'apps/web/src/workspace.ts',
  'apps/web/src/features/connections/ConnectionsPage.tsx',
  'apps/web/src/test/connections-p6.test.tsx',
  'apps/web/src/test/execution-p6.test.tsx'
]);

const P6_PREFIXES = Object.freeze([
  'apps/web/src/features/execution/',
  'tests/p6/'
]);

const P7_FILES = new Set([
  'Dockerfile',
  'apps/web/src/features/execution/ExecutionPage.tsx',
  'apps/web/src/features/execution/ExecutionP7Panels.tsx',
  'apps/web/src/test/evidence-p7.test.tsx',
  'apps/web/src/test/execution-p7.test.tsx',
  'apps/api/src/clean/evidence-service.mjs',
  'apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs',
  'apps/api/src/clean/outcome-evaluation-service.mjs',
  'apps/api/src/clean/parser-adapters.mjs',
  'apps/api/src/clean/parser-docker.mjs',
  'apps/api/src/clean/parser-limits.mjs',
  'apps/api/src/clean/parser-protocol.mjs',
  'apps/api/src/clean/parser-service.mjs',
  'apps/api/src/clean/quality-service.mjs',
  'apps/api/src/modules/registry.mjs',
  'apps/runner-broker/clean-server.mjs',
  'packages/contracts/src/clean-v2.mjs',
  'scripts/lib/v3-clean-p7-parser-probe.mjs',
  'scripts/v3-clean-p7-cas-tamper-probe.mjs',
  'scripts/v3-clean-p7-parser-probe.mjs',
  'scripts/v3-clean-p7-performance.mjs',
  'scripts/v3-clean-p7-quality-outcome-probe.mjs',
  'scripts/v3-clean-p7-restart-probe.mjs',
  'scripts/v3-clean-p7-evidence.mjs'
]);

const P7_PREFIXES = Object.freeze([
  'apps/parser-worker/',
  'apps/web/src/features/evidence/',
  'tests/p7/'
]);

const P8_FILES = new Set([
  'apps/web/src/test/operations-p8.test.tsx',
  'apps/api/src/clean/migrations/008-delivery-deployment-importer-operations.mjs',
  'apps/api/src/clean/p8-service.mjs',
  'apps/api/src/clean/p8/repository.mjs',
  'scripts/v3-clean-p8-evidence.mjs',
  'scripts/v3-clean-p8-performance.mjs',
  'scripts/v3-clean-p8-github-delivery-probe.mjs',
  'scripts/v3-clean-p8-importer-probe.mjs',
  'scripts/v3-clean-p8-deployment-rollback-probe.mjs',
  'scripts/v3-clean-p8-backup-restore-gc-probe.mjs'
]);

const P8_PREFIXES = Object.freeze(['apps/api/src/clean/p8/', 'apps/importer/', 'tests/p8/', 'apps/web/src/features/operations/']);

const P9_FILES = new Set([
  'scripts/v3-clean-p9-evidence.mjs',
  'scripts/v3-clean-p9-release-probe.mjs',
  'scripts/v3-clean-p9-github-delivery-probe.mjs',
  'scripts/e2e.mjs',
  'apps/web/package.json',
  'apps/web/vite.config.ts',
  'apps/web/src/App.tsx',
  'apps/web/src/api.ts',
  'apps/web/src/events.ts',
  'apps/web/src/main.tsx',
  'apps/web/src/query.ts',
  'apps/web/src/styles.css',
  'apps/web/src/sw.ts',
  'apps/web/src/workspace.ts',
  'apps/web/src/test/events-p9.test.ts',
  'apps/web/src/test/offline-p9.test.ts',
  'apps/web/src/test/workflows-p9.test.tsx',
  'apps/web/src/test/setup-flow.test.tsx',
  'apps/api/src/clean/web-static.mjs'
]);
const P9_PREFIXES = Object.freeze(['tests/p9/', 'apps/web/src/offline/', 'apps/web/src/features/outcome/', 'apps/web/src/features/delivery/']);

const P10_FILES = new Set([
  'scripts/development-receipt.mjs',
  'apps/api/src/clean/migrations/009-final-business-parity-governance.mjs',
  'apps/api/src/clean/p10-service.mjs',
  'apps/api/src/clean/local-setup-service.mjs',
  'apps/api/src/clean/github-setup-service.mjs',
  'apps/parser-worker/archive-worker.mjs',
  'apps/web/src/features/assets/AssetsPage.tsx',
  'apps/web/src/features/audit/AuditPage.tsx',
  'apps/web/src/features/assist/AssistMarkdown.tsx',
  'apps/web/src/features/assist/AttachmentPreview.tsx',
  'apps/web/src/features/assist/OfficePreview.tsx',
  'apps/web/src/features/assist/PdfPreview.tsx',
  'apps/web/src/features/assist/TurnTimeline.tsx',
  'apps/web/src/features/assist/TypedEvent.tsx',
  'apps/web/src/features/assist/office-preview.worker.ts',
  'apps/web/src/features/context/ContextMapPage.tsx',
  'apps/web/src/features/execution/QualityPolicyPanel.tsx',
  'apps/web/src/features/nodes/NodeWorkspacePage.tsx',
  'apps/web/src/features/project/WorkflowCanvas.tsx',
  'apps/web/src/features/projects/ProjectsPage.tsx',
  'apps/web/src/features/projects/onboarding/ProjectOnboardingPage.tsx',
  'apps/web/src/features/settings/BriefTemplatesPanel.tsx',
  'apps/web/src/features/setup/CodexDiscoveryPicker.tsx',
  'apps/web/src/features/setup/CodexSetup.tsx',
  'apps/web/src/features/setup/SystemOnboarding.tsx',
  'apps/web/src/features/setup/GithubSetup.tsx',
  'apps/web/src/features/setup/codex-device-auth.ts',
  'apps/web/src/features/setup/index.ts',
  'config/github-app.local.example.json',
  'apps/web/src/features/workflow/WorkstreamPage.tsx',
  'apps/web/src/features/quality/',
  'apps/web/src/test/p10-business-parity.test.tsx',
  'apps/web/src/test/p10-quality.test.tsx',
  'scripts/lib/v3-clean-p10-parity.mjs',
  'scripts/v3-clean-p10-parity.mjs',
  'scripts/v3-clean-p10-evidence.mjs',
  'scripts/v3-clean-p10-release-probe.mjs',
  'scripts/v3-clean-p10-github-deletion-probe.mjs',
  'scripts/v3-clean-p10-parser-probe.mjs',
  'tests/p10/'
]);
const P10_PREFIXES = Object.freeze([
  'tests/p10/', 'apps/web/src/features/quality/', 'apps/web/src/features/p10/',
  'apps/web/src/features/assets/', 'apps/web/src/features/audit/',
  'apps/web/src/features/nodes/', 'apps/web/src/features/projects/',
  'apps/web/src/features/workflow/'
]);

export function classifyWorkspacePath(value) {
  const file = normalize(value);
  if (!file) return null;
  if (P1_GOVERNANCE_FILES.has(file)) {
    const rows = file === 'scripts/v3-clean-architecture-scan.mjs' ? P1_MATRIX_ROWS : P1_GOVERNANCE_ROWS;
    return { kind: 'p1', phase: 'P1', rows: [...rows] };
  }
  if (P10_FILES.has(file) || P10_PREFIXES.some((prefix) => file.startsWith(prefix))) return { kind: 'clean', phase: 'P10', rows: [] };
  if (P9_FILES.has(file) || P9_PREFIXES.some((prefix) => file.startsWith(prefix))) return { kind: 'clean', phase: 'P9', rows: [] };
  if (P8_FILES.has(file) || P8_PREFIXES.some((prefix) => file.startsWith(prefix))) return { kind: 'clean', phase: 'P8', rows: [] };
  if (P7_FILES.has(file) || P7_PREFIXES.some((prefix) => file.startsWith(prefix))) return { kind: 'clean', phase: 'P7', rows: [] };
  if (P6_FILES.has(file) || P6_PREFIXES.some((prefix) => file.startsWith(prefix))) return { kind: 'clean', phase: 'P6', rows: [] };
  if (P5_FILES.has(file) || P5_WEB_FILES.has(file) || P5_WEB_PREFIXES.some((prefix) => file.startsWith(prefix)) || file.startsWith('tests/p5/')) return { kind: 'clean', phase: 'P5', rows: [] };
  if (file.startsWith('apps/windows-native-bridge/')) return { kind: 'clean', phase: 'P5', rows: [] };
  if (P4_FILES.has(file) || file.startsWith('tests/p4/')) return { kind: 'clean', phase: 'P4', rows: [] };
  if (file.startsWith('apps/gateway/')) return { kind: 'clean', phase: 'P4', rows: [] };
  if (file.startsWith(P1_CLEAN_ROOT) || file.startsWith('tests/p1/') || P1_PLATFORM_FILES.has(file)) {
    return { kind: 'p1', phase: 'P1', rows: [...P1_PLATFORM_ROWS] };
  }
  if (file === 'apps/api/server-legacy.mjs') return { kind: 'fixture', phase: 'P2-P9', reason: 'historical API runtime' };
  if (file.startsWith('apps/api/src/')) return { kind: 'fixture', phase: 'P2-P8', reason: 'historical domain/runtime input' };
  if (file.startsWith('apps/web/')) return { kind: 'fixture', phase: 'P9', reason: 'pre-clean Web characterization' };
  if (file.startsWith('apps/runner-broker/')) return { kind: 'fixture', phase: 'P6', reason: 'runner adapter characterization' };
  if (file.startsWith('packages/')) return { kind: 'fixture', phase: 'P2-P9', reason: 'pre-clean shared contract' };
  if (file.startsWith('tests/') || file.startsWith('scripts/')) return { kind: 'fixture', phase: 'P2-P9', reason: 'historical behavior or future-phase tool' };
  if (file.startsWith('docs/evidence/')) return { kind: 'evidence', phase: 'P0-P10' };
  if (file.startsWith('docs/archive/')) return { kind: 'archive', phase: 'historical' };
  if (file.startsWith('docs/architecture/') || P1_ACTIVE_MARKDOWN.includes(file)) return { kind: 'governance', phase: 'P0-P10' };
  if (file.startsWith('.github/') || file.startsWith('.githooks/')) return { kind: 'governance', phase: 'P0-P10' };
  if (file.startsWith('doc/') || file.startsWith('探索/') || file.startsWith('探索-1/') || file.startsWith('当前项目毕业设计任务书/') || file.startsWith('任务书/') || file.startsWith('愿景与范围文档模板/')) {
    return { kind: 'non_product', phase: 'unscoped research' };
  }
  if (file.startsWith('docs/')) return { kind: 'supporting_document', phase: 'P0-P10' };
  if (['Dockerfile', 'compose.yml', 'docker/'].some((prefix) => file === prefix || file.startsWith(prefix))) {
    return { kind: 'fixture', phase: 'P8-P9', reason: 'deferred deployment surface' };
  }
  if (/^(?:AGENTS\.md|README\.md|feature-catalog(?:\.(?:clean|historical|index))?\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|sbom\.spdx\.json|eslint\.config\.mjs|\.[^/]+)$/.test(file)) {
    return { kind: 'governance', phase: 'P0-P10' };
  }
  return null;
}

function normalize(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}
