import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLEAN_P4_MIGRATION_REGISTRY, CLEAN_P5_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import { CLEAN_P4_TABLE_OWNERS, CLEAN_P5_TABLE_OWNERS } from '../../apps/api/src/clean/ownership.mjs';
import { createCleanCommandRegistry, registryParity } from '../../apps/api/src/clean/registry.mjs';
import { CLEAN_CATALOG_IDS, loadCatalogIndex, loadCatalogLayers, validateCatalogLayers, validateP4EvidenceManifest } from '../../scripts/catalog-loader.mjs';
import { commandFor } from '../../scripts/layered-gate.mjs';
import { P1_PACKAGE_SCRIPT_DEFINITIONS, classifyWorkspacePath } from '../../scripts/lib/v3-clean-p1-scope.mjs';

const root = process.cwd();
const promotedIds = ['REC-D4-MCP-004', 'REC-D4-SCOPE-016', 'REC-D9-CONTEXT-017', 'REC-D9-PROJECTION-018'];

test('P4 migration, ownership, registry and package gate inventories are synchronized', () => {
  assert.deepEqual(CLEAN_P4_MIGRATION_REGISTRY.map((migration) => migration.id), [
    '001-clean-baseline', '002-identity-acl', '003-project-workflow', '004-context-projection-mcp'
  ]);
  for (const table of ['context_sources', 'context_nodes', 'context_document_versions', 'context_edges', 'context_policies', 'context_selections', 'context_packs', 'context_projection_jobs', 'context_index_snapshots', 'exchange_requests', 'mcp_clients', 'gateway_forward_receipts']) {
    assert.equal(typeof CLEAN_P4_TABLE_OWNERS[table], 'string', table);
  }
  const registry = createCleanCommandRegistry({ targetVersion: 4 });
  assert.equal(registryParity(registry).valid, true);
  for (const command of ['context.map', 'context.projection.rebuild', 'mcp.rpc', 'exchange.request.approve', 'gateway.forward']) assert.ok(registry.get(command), command);
  assert.deepEqual(CLEAN_P5_MIGRATION_REGISTRY.map((migration) => migration.id).slice(-1), ['005-assist-files-terminal-bridge']);
  for (const table of ['assist_sessions', 'assist_turns', 'assist_messages', 'assist_goals', 'assist_configurations', 'assist_references', 'attachments', 'file_refs', 'file_change_batches', 'file_change_items', 'runtime_approvals', 'runtime_user_inputs', 'semantic_proposals', 'terminal_sessions', 'terminal_events', 'bridge_devices', 'bridge_transfers']) assert.equal(typeof CLEAN_P5_TABLE_OWNERS[table], 'string', table);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys(packageJson.scripts).length, 47);
  assert.deepEqual(packageJson.scripts, Object.fromEntries(Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS).map(([name, value]) => [name, value.command])));
  assert.match(packageJson.scripts.test, /--test-skip-pattern="committed sanitized V2\.3 golden"/);
  const [, cleanIntegrationArgs] = commandFor('clean', 'integration');
  const [, historicalIntegrationArgs] = commandFor('historical', 'integration');
  assert.equal(cleanIntegrationArgs.includes('tests/unit/recovery-golden.test.mjs'), false);
  assert.equal(historicalIntegrationArgs.includes('tests/unit/recovery-golden.test.mjs'), true);
  const evidenceSource = fs.readFileSync(path.join(root, 'scripts', 'v3-clean-p4-evidence.mjs'), 'utf8');
  assert.match(evidenceSource, /\$VerificationStatus = \$VerificationProbe \| & node - \$Verification/);
  assert.match(evidenceSource, /'x'\.repeat\(256 \* 1024\)/);
  assert.match(evidenceSource, /aiws-p4-db-probe-/);
  assert.match(evidenceSource, /Remove-Item -LiteralPath \$DatabaseProbeRoot -Recurse -Force/);
  assert.match(evidenceSource, /superseded-final-\$\{supersededRunId\}/);
  assert.match(evidenceSource, /supersedes_run_id/);
});

test('P4 Catalog promotion is disjoint, complete and backed by final Evidence', () => {
  const index = loadCatalogIndex(root);
  const layers = loadCatalogLayers(root, index);
  const validation = validateCatalogLayers({ root, index, layers });
  assert.equal(validation.valid, true, JSON.stringify(validation.failures));
  assert.deepEqual(validation.counts, { clean: 21, historical: 6, total: 27 });
  const clean = new Map(layers.clean.features.map((feature) => [feature.id, feature]));
  const historicalRows = new Map(layers.historical.features.map((feature) => [feature.id, feature]));
  const historical = new Set(layers.historical.features.map((feature) => feature.id));
  assert.ok(historicalRows.get('REC-D1-CONTRACTS-023')?.target_modules.includes('scripts/layered-gate.mjs'));
  for (const id of promotedIds) {
    assert.ok(CLEAN_CATALOG_IDS.includes(id), id);
    assert.equal(historical.has(id), false, id);
    assert.equal(clean.get(id)?.status, 'verified', id);
    assert.ok(clean.get(id)?.evidence.includes('docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json'), id);
  }
});

test('Gateway remains an independently classified stateless forwarding process', () => {
  for (const file of ['apps/gateway/package.json', 'apps/gateway/server.mjs']) assert.equal(classifyWorkspacePath(file)?.phase, 'P4');
  const source = fs.readFileSync(path.join(root, 'apps/gateway/server.mjs'), 'utf8');
  assert.doesNotMatch(source, /node:sqlite|sqlite3|better-sqlite3|database\.mjs|cas\.mjs|docker_engine|\/var\/run\/docker\.sock/i);
  assert.match(source, /\/api\/v2\/gateway\/forward/);
});

test('P4 final manifest is hash-complete and rejects unlisted SQLite sidecars', () => {
  const evidenceRoot = path.join(root, 'docs', 'evidence', 'v3-clean-p4-context-mcp-20260820');
  assert.deepEqual(validateP4EvidenceManifest(evidenceRoot), []);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-manifest-'));
  try {
    for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(evidenceRoot, entry.name), path.join(fixture, entry.name));
    }
    fs.writeFileSync(path.join(fixture, 'rollback-v3.sqlite-wal'), 'orphan');
    assert.ok(validateP4EvidenceManifest(fixture).includes('manifest_file_orphan:rollback-v3.sqlite-wal'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
