import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const releaseDirectory = path.join(root, '.ai-workspace', 'release', 'v3-transition');

function latest(prefix) {
  const files = fs.readdirSync(releaseDirectory).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort();
  assert.ok(files.length, `missing receipt ${prefix}`);
  return path.join(releaseDirectory, files.at(-1));
}

function readReceipt(prefix, pretty = false) {
  const file = latest(prefix);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { receipt_sha256: recorded, ...unsigned } = receipt;
  assert.match(recorded, /^[a-f0-9]{64}$/);
  const serialized = pretty ? JSON.stringify(unsigned, null, 2) : JSON.stringify(unsigned);
  assert.equal(createHash('sha256').update(serialized).digest('hex'), recorded, `${path.basename(file)} hash`);
  return { file, receipt };
}

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

test('V2.3 archive and revocation receipts are immutable and verifiable', () => {
  const archive = readReceipt('v23-cold-archive-', true).receipt;
  assert.equal(archive.schema_version, 'aiws.cold_archive_receipt.v1');
  assert.equal(archive.product_version, '2.3.0');
  assert.equal(archive.status, 'verified');
  assert.equal(archive.source.volume, 'aiws-data-v23');
  assert.equal(archive.recovery_drill.status, 'passed');
  assert.equal(archive.recovery_drill.removed_after_validation, true);
  assert.ok(archive.v3_mount_prohibition.includes('aiws-data-v23'));
  assert.ok(fs.existsSync(path.join(root, archive.archive.path)));
  const revocation = readReceipt('v23-revocation-', true).receipt;
  assert.equal(revocation.schema_version, 'aiws.release_receipt_revocation.v1');
  assert.equal(revocation.status, 'revoked');
  assert.equal(revocation.immutable_source_receipt.original_status, 'accepted');
  assert.match(revocation.immutable_source_receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(revocation.current_source.clean, false);
});

test('candidate builds carry reproducible source labels, image identity, and an embedded SBOM', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const releaseBuild = fs.readFileSync(path.join(root, 'scripts', 'release-build.mjs'), 'utf8');
  assert.match(dockerfile, /aiws\.source\.tree/);
  assert.match(dockerfile, /aiws\.gate\.fingerprint/);
  assert.match(dockerfile, /COPY sbom\.spdx\.json/);
  assert.match(releaseBuild, /release_build_requires_clean_commit/);
  assert.match(releaseBuild, /'sbom', inspected\.Id, '--format', 'spdx-json'/);
  const imageReceipt = readReceipt('v3-images-').receipt;
  assert.equal(imageReceipt.schema_version, 'aiws.v3.image_receipt.v1');
  assert.equal(imageReceipt.status, 'candidate');
  for (const image of imageReceipt.images) {
    assert.match(image.image_id, /^sha256:[a-f0-9]{64}$/);
    const inspected = spawnSync('docker', ['image', 'inspect', image.image_id, '--format', '{{json .}}'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (inspected.status === 0) {
      const actual = JSON.parse(inspected.stdout);
      assert.equal(actual.Id, image.image_id);
      for (const [key, value] of Object.entries(image.labels)) assert.equal(actual.Config?.Labels?.[key], value, `${image.role}:${key}`);
    } else {
      // Candidate images may be garbage-collected after promotion; retain the
      // immutable build and SBOM receipts as the verification source in that case.
      assert.equal(image.build?.exit_status, 0, `${image.role}: recorded build failed`);
      assert.equal(image.sbom_command?.exit_status, 0, `${image.role}: recorded SBOM export failed`);
      assert.match(image.output_sha256 || image.build?.output_sha256 || '', /^[a-f0-9]{64}$/, `${image.role}: missing build evidence hash`);
    }
    assert.ok(fs.existsSync(path.join(root, image.image_sbom)));
  }
});

test('release rehearsal and promotion use dynamic acceptance ports and targeted cleanup only', () => {
  const rehearsal = fs.readFileSync(path.join(root, 'scripts', 'release-rehearsal.mjs'), 'utf8');
  const promotion = fs.readFileSync(path.join(root, 'scripts', 'release-promote.mjs'), 'utf8');
  assert.match(rehearsal, /listen\(0, '127\.0\.0\.1'/);
  assert.doesNotMatch(rehearsal, /4320/);
  assert.match(rehearsal, /acceptanceStatus/);
  assert.match(rehearsal, /unavailableCapabilities/);
  assert.match(promotion, /aiws-v22-app-1/);
  assert.match(promotion, /aiws-data-v22/);
  assert.match(promotion, /assertFormalCapabilities/);
  assert.match(promotion, /formal_capability_gate_failed/);
  assert.ok(promotion.includes("const Helper = '$($Helper)';"));
  assert.ok(promotion.includes('docker cp $BackupArchive "${Helper}:/tmp/data.tar.gz"'));
  assert.doesNotMatch(`${rehearsal}\n${promotion}`, /\b(?:system|image|volume|builder) prune\b/);
});

test('latest acceptance and final receipts expose capability state explicitly', () => {
  const acceptance = readReceipt('v3-acceptance-docker-').receipt;
  assert.ok(acceptance.capabilities?.codex?.status);
  assert.ok(acceptance.capabilities?.github?.status);
  const final = readReceipt('v3-final-release-').receipt;
  assert.equal(final.schema_version, 'aiws.v3.final_release_receipt.v1');
  assert.match(final.images.app, /^sha256:[a-f0-9]{64}$/);
  assert.match(final.images.broker, /^sha256:[a-f0-9]{64}$/);
  assert.match(final.images.runner, /^sha256:[a-f0-9]{64}$/);
  if (acceptance.capabilities.codex.status !== 'available' || acceptance.capabilities.github.status !== 'available') {
    assert.notEqual(final.status, 'formal');
  }
  const capabilityFiles = fs.readdirSync(releaseDirectory).filter((name) => name.startsWith('v3-capability-review-') && name.endsWith('.json'));
  if (capabilityFiles.length) {
    const review = readReceipt('v3-capability-review-').receipt;
    assert.equal(review.schema_version, 'aiws.v3.capability_review_receipt.v1');
    assert.equal(review.status, 'candidate');
    assert.equal(review.observed_capabilities.codex.status, 'unavailable');
    assert.equal(review.observed_capabilities.github.status, 'unavailable');
    assert.ok(fs.existsSync(path.join(root, review.supersedes.path)));
  }
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
