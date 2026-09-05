import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLEAN_COMMAND_REGISTRY, createCleanCommandRegistry, registryParity } from '../../apps/api/src/clean/registry.mjs';
import { auditParity } from '../../scripts/lib/v3-clean-p10-parity.mjs';
import { createFormalVerificationPlan } from '../../scripts/verify.mjs';

test('fixed V2.3 inventories map bidirectionally to 19 business groups with zero gaps', async () => {
  const result = await auditParity({ root: path.resolve('.'), registry: CLEAN_COMMAND_REGISTRY });
  assert.deepEqual(result, {
    schema_version: 'aiws.v3-clean.p10-parity-audit.v1', phase: 'P10', status: 'passed',
    counts: { cases: 14, routes: 360, collections: 98, web_routes: 11, optimization_packages: 7 },
    business_groups: 19, gaps: 0, findings: []
  });
});

test('P10 registry is API v2-only and preserves synchronized transport contracts', () => {
  const registry = createCleanCommandRegistry({ targetVersion: 9, runtimePhase: 10 });
  const entries = registry.entries.filter((entry) => entry.phase === 'p10');
  assert.equal(entries.length, 42);
  assert.ok(entries.every((entry) => entry.path.startsWith('/api/v2/')));
  assert.ok(entries.filter((entry) => entry.command_id.includes('deletion')).every((entry) => !entry.transport_allowlist.includes('mcp')));
  assert.ok(entries.filter((entry) => entry.command_id.startsWith('provider.codex.')).every((entry) => !entry.transport_allowlist.includes('mcp')));
  assert.deepEqual(entries.filter((entry) => entry.command_id.startsWith('provider.github.')).map((entry) => entry.path), [
    '/api/v2/provider-discovery/github',
    '/api/v2/provider-auth/github/manifest',
    '/api/v2/provider-auth/github/installations'
  ]);
  assert.ok(entries.filter((entry) => entry.command_id.startsWith('provider.github.')).every((entry) => !entry.transport_allowlist.includes('mcp')));
  assert.deepEqual(registryParity(registry), { valid: true, mismatches: [], rest_count: registry.entries.length, mcp_count: registry.entries.length, web_count: registry.entries.length });
});

test('P10 verify orders parity, external adapters, Web, build, E2E, release, and Evidence', () => {
  const ids = createFormalVerificationPlan().map((entry) => entry.id);
  const positions = [
    'audit-parity', 'test-p10', 'evidence-p9', 'p10-parser-probe',
    'p10-github-deletion-probe', 'web-test', 'integration', 'build', 'e2e',
    'p10-release-probe', 'release-test', 'evidence-p10'
  ].map((id) => ids.indexOf(id));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('P10 Evidence patch excludes its append-only tree and enforces a publishable size bound', () => {
  const source = fs.readFileSync('scripts/v3-clean-p10-evidence.mjs', 'utf8');
  assert.match(source, /const maxPatchBytes = 50 \* 1024 \* 1024/);
  assert.match(source, /`:\(exclude\)\$\{evidencePrefix\}\*\*`/);
  assert.match(source, /p10_change_patch_too_large/);
  assert.match(fs.readFileSync('.gitattributes', 'utf8'), /docs\/evidence\/v3-clean-p10-final-governance-20260829\/\*\* -text/);
});
