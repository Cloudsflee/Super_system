import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MODULE_REGISTRY, ownerOf } from '../../apps/api/src/modules/registry.mjs';

const root = process.cwd();
const statusFlow = ['planned', 'scaffolded', 'implemented', 'verified', 'released'];

test('recovery catalog uses the five evidence-derived states and separate Terminal and Bridge items', () => {
  const raw = fs.readFileSync(path.join(root, 'feature-catalog.json'));
  const catalog = JSON.parse(raw);
  assert.equal(catalog.schema_version, 'aiws.v3.feature_catalog.v2');
  assert.equal(catalog.product_version, '3.0.0');
  assert.deepEqual(catalog.status_flow, statusFlow);
  assert.ok(catalog.features.length >= 27);
  assert.equal(new Set(catalog.features.map((feature) => feature.id)).size, catalog.features.length);
  for (const feature of catalog.features) {
    assert.match(feature.id, /^REC-D\d+-[A-Z]+-\d{3}$/);
    assert.ok(statusFlow.includes(feature.status), feature.id);
    assert.ok(feature.tests.some((entry) => /^T[0-8]$/.test(entry)), feature.id);
    const clean = feature.target_modules.some((target) => target.startsWith('apps/api/src/clean/'))
      || feature.evidence.some((entry) => entry.includes('/v3-clean-p2-'));
    for (const table of feature.tables) assert.ok(feature.owner_modules.includes(ownerOf('table', table, { clean })), `${feature.id}:${table}`);
    for (const event of feature.events) assert.ok(feature.owner_modules.includes(ownerOf('event', event, { clean })), `${feature.id}:${event}`);
    if (statusFlow.indexOf(feature.status) >= statusFlow.indexOf('implemented')) {
      assert.ok(feature.behavior_tests.length, `${feature.id}: behavior tests`);
      if (feature.ui.length) assert.ok(feature.ui_tests.length, `${feature.id}: UI tests`);
      assert.ok(feature.evidence.length, `${feature.id}: evidence`);
    }
  }
  const terminal = catalog.features.find((feature) => feature.id === 'REC-D8-TERMINAL-025');
  const bridge = catalog.features.find((feature) => feature.id === 'REC-D8-BRIDGE-026');
  assert.equal(terminal.domain, 'terminal');
  assert.equal(bridge.domain, 'bridge');
  assert.doesNotMatch(terminal.name, /Bridge/);
  const governance = fs.readFileSync(path.join(root, 'scripts/recovery-governance.mjs'), 'utf8');
  assert.match(governance, /docs\/architecture\/v3-clean-development-plan\.md/);
  assert.doesNotMatch(governance, /docs\/开发计划v3功能恢复\.md/);
  const governanceFeature = catalog.features.find((feature) => feature.id === 'REC-D0-GOVERNANCE-000');
  assert.ok(governanceFeature.source_files.includes('AGENTS.md'));
  assert.ok(governanceFeature.target_modules.includes('package.json'));
  assert.ok(governanceFeature.target_modules.includes('scripts/v3-clean-p1-global-sync-evidence.mjs'));
  assert.deepEqual(governanceFeature.gate_sync_rules, ['GS-001', 'GS-002', 'GS-003', 'GS-004', 'GS-005', 'GS-006', 'GS-007']);
  assert.match(createHash('sha256').update(raw).digest('hex'), /^[a-f0-9]{64}$/);
});

test('module registry gives every table, command, and event one owner without dependency cycles', () => {
  const ids = new Set(MODULE_REGISTRY.map((module) => module.id));
  for (const field of ['tables', 'commands', 'events']) {
    const values = MODULE_REGISTRY.flatMap((module) => module[field]);
    assert.equal(new Set(values).size, values.length, field);
  }
  const visit = (id, trail = []) => {
    assert.ok(!trail.includes(id), [...trail, id].join(' -> '));
    const module = MODULE_REGISTRY.find((item) => item.id === id);
    for (const dependency of module.dependencies) {
      assert.ok(ids.has(dependency), `${id}:${dependency}`);
      visit(dependency, [...trail, id]);
    }
  };
  for (const id of ids) visit(id);
});

test('recovery plan, catalog, coverage, and audited impact gates emit V2 passed receipts', () => {
  for (const command of ['plan', 'catalog', 'coverage', 'impact']) {
    const run = spawnSync(process.execPath, ['scripts/recovery-governance.mjs', command, '--skip-evidence'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.ai-workspace', 'recovery', `${command}.json`), 'utf8'));
    assert.equal(receipt.schema_version, 'aiws.v3.recovery_governance_receipt.v2');
    assert.equal(receipt.command, command);
    assert.equal(receipt.status, 'passed');
    assert.match(receipt.catalog_sha256, /^[a-f0-9]{64}$/);
  }
  const audited = spawnSync(process.execPath, ['scripts/recovery-governance.mjs', 'impact', '--audit', '--skip-evidence'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(audited.status, 0, audited.stderr || audited.stdout);
});
