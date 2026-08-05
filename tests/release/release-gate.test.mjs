import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('release identity is V3 and formal service remains 4317', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const webPackage = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/package.json'), 'utf8'));
  const compose = fs.readFileSync(path.join(root, 'compose.yml'), 'utf8');
  assert.equal(packageJson.version, '3.0.0');
  assert.equal(webPackage.version, '3.0.0');
  assert.match(compose, /127\.0\.0\.1:\$\{AIWS_PORT:-4317\}:4317/);
  assert.doesNotMatch(compose, /4320/);
  assert.match(compose, /aiws-data-v3/);
  assert.doesNotMatch(compose, /sha256:0{64}/);
  assert.match(compose, /AIWS_RUNNER_IMAGE:\?set AIWS_RUNNER_IMAGE/);
});

test('legacy runtime directories and versioned runner tests are absent', () => {
  for (const directory of ['apps/worker', 'apps/mcp-gateway', 'bridge', 'prisma']) assert.equal(fs.existsSync(path.join(root, directory)), false, directory);
  const runtimeFiles = walk(path.join(root, 'apps')).filter((file) => /\.(mjs|ts|tsx)$/.test(file));
  assert.equal(runtimeFiles.some((file) => /v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(path.basename(file))), false);
});

test('V2.3 archive receipt and immutable revocation receipt exist', () => {
  const directory = path.join(root, '.ai-workspace', 'release', 'v3-transition');
  const files = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  assert.ok(files.some((file) => file.startsWith('v23-cold-archive-') && file.endsWith('.json')));
  assert.ok(files.some((file) => file.startsWith('v23-revocation-') && file.endsWith('.json')));
});

test('candidate builds carry reproducible source labels and an embedded SBOM', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const releaseBuild = fs.readFileSync(path.join(root, 'scripts', 'release-build.mjs'), 'utf8');
  assert.match(dockerfile, /aiws\.source\.tree/);
  assert.match(dockerfile, /aiws\.gate\.fingerprint/);
  assert.match(dockerfile, /COPY sbom\.spdx\.json/);
  assert.match(releaseBuild, /release_build_requires_clean_commit/);
  assert.match(releaseBuild, /'sbom', inspected\.Id, '--format', 'spdx-json'/);
});

test('release rehearsal and promotion use dynamic acceptance ports and targeted cleanup only', () => {
  const rehearsal = fs.readFileSync(path.join(root, 'scripts', 'release-rehearsal.mjs'), 'utf8');
  const promotion = fs.readFileSync(path.join(root, 'scripts', 'release-promote.mjs'), 'utf8');
  assert.match(rehearsal, /listen\(0, '127\.0\.0\.1'/);
  assert.doesNotMatch(rehearsal, /4320/);
  assert.match(promotion, /aiws-v22-app-1/);
  assert.match(promotion, /aiws-data-v22/);
  assert.ok(promotion.includes("const Helper = '$($Helper)';"));
  assert.ok(promotion.includes('docker cp $BackupArchive "${Helper}:/tmp/data.tar.gz"'));
  assert.doesNotMatch(`${rehearsal}\n${promotion}`, /\b(?:system|image|volume|builder) prune\b/);
});

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}
