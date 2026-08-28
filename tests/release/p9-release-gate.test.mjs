import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('P9 release gate is isolated, reproducible and restores the P8 schema-v8 boundary', () => {
  const source = fs.readFileSync('scripts/v3-clean-p9-release-probe.mjs', 'utf8');
  for (const marker of [
    "fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p9-release-'))",
    "AIWS_CLEAN_CORS_ORIGINS: dynamicOrigin",
    "'--provenance=false'",
    "['sbom', '--format', 'spdx-json'",
    "['volume', 'create', volume]",
    "'127.0.0.1::4317'",
    "production_cutover: false",
    "restored_user_version: userVersion",
    "[1,2,3,4,5,6,7,8]",
    "byte_exact_mismatches: mismatches"
  ]) assert.ok(source.includes(marker), marker);
  assert.doesNotMatch(source, /docker\s+(?:system|image|volume|builder)\s+prune/);
  assert.doesNotMatch(source, /aiws-data-v3(?:\b|['"])/);
});

test('P9 release SBOM declares router, query, IndexedDB and Workbox inputs', () => {
  const sbom = JSON.parse(fs.readFileSync('sbom.spdx.json', 'utf8'));
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  const packages = new Map(sbom.packages.map((entry) => [entry.name, entry.versionInfo]));
  assert.equal(packages.get('@tanstack/react-query'), '5.102.8');
  assert.equal(packages.get('react-router-dom'), '7.18.2');
  assert.equal(packages.get('idb'), '8.0.3');
  assert.equal(packages.get('vite-plugin-pwa'), '1.3.0');
  for (const name of ['workbox-precaching', 'workbox-routing', 'workbox-strategies']) assert.equal(packages.get(name), '7.4.1');
});

test('production Clean process composes API and static app shell without caching business data', () => {
  const server = fs.readFileSync('apps/api/clean-server.mjs', 'utf8');
  const staticHandler = fs.readFileSync('apps/api/src/clean/web-static.mjs', 'utf8');
  assert.match(server, /createCleanWebHandler/);
  assert.match(staticHandler, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(staticHandler, /public, max-age=31536000, immutable/);
  assert.match(staticHandler, /no-cache, no-store/);
});
