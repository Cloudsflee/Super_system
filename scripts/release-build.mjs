import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const version = '3.0.0';
const releaseRoot = path.join(root, '.ai-workspace', 'release', 'v3-transition');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const records = [];
fs.mkdirSync(releaseRoot, { recursive: true });

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function commandText(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

async function runLogged(label, command, args) {
  const log = path.join(releaseRoot, `${stamp}-${label}.log`);
  const output = fs.createWriteStream(log, { flags: 'wx', mode: 0o444 });
  const exactCommand = commandText(command, args);
  output.write(`command: ${exactCommand}\ncwd: ${root}\n--- output ---\n`);
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: process.env });
    child.once('error', reject);
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); output.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); output.write(chunk); });
    child.once('close', (status, signal) => resolve({ status: status ?? 1, signal: signal || null }));
  }).finally(() => output.end());
  await new Promise((resolve) => output.closed ? resolve() : output.once('close', resolve));
  const record = {
    label,
    command: exactCommand,
    cwd: root,
    exit_status: result.status,
    signal: result.signal,
    duration_ms: Math.round(performance.now() - started),
    output_log: path.relative(root, log).replaceAll('\\', '/'),
    output_sha256: sha256File(log)
  };
  records.push(record);
  if (result.status !== 0) throw Object.assign(new Error(`${label} failed with exit status ${result.status}`), { record });
  return record;
}

function writeReceipt(name, body) {
  const unsigned = { ...body, created_at: new Date().toISOString() };
  const receipt = { ...unsigned, receipt_sha256: sha256Json(unsigned) };
  const target = path.join(releaseRoot, name);
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(target, 0o444);
  return { path: target, receipt };
}

const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (dirty) throw new Error('release_build_requires_clean_commit');

const commit = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const shortCommit = git(['rev-parse', '--short=12', 'HEAD']);
const releaseBase = process.env.AIWS_RELEASE_BASE || '6517a17';
const baseCommit = git(['rev-parse', releaseBase]);
execFileSync('git', ['merge-base', '--is-ancestor', baseCommit, commit], { cwd: root, windowsHide: true });
const lockfileSha256 = sha256File(path.join(root, 'pnpm-lock.yaml'));
const sourceSbom = path.join(root, 'sbom.spdx.json');
const sourceSbomSha256 = sha256File(sourceSbom);
const pnpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
const sourcePatch = path.join(releaseRoot, `aiws-${version}-${shortCommit}-${stamp}.patch`);
fs.writeFileSync(sourcePatch, execFileSync('git', ['diff', '--binary', baseCommit, commit], {
  cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024
}), { flag: 'wx', mode: 0o444 });
fs.chmodSync(sourcePatch, 0o444);
const sourcePatchSha256 = sha256File(sourcePatch);

try {
  const gate = await runLogged('gate', process.execPath, [pnpmCli, 'verify']);
  const patchRollbackCheck = await runLogged('patch-rollback-check', 'git', ['apply', '--check', '--reverse', sourcePatch]);
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('gate_modified_source_tree');
  const gateFingerprint = sha256Json({
    schema: 'aiws.gate_fingerprint.v1', base_commit: baseCommit, commit, tree, lockfile_sha256: lockfileSha256,
    command: gate.command, output_sha256: gate.output_sha256, exit_status: gate.exit_status,
    source_patch_sha256: sourcePatchSha256, patch_rollback_check_sha256: patchRollbackCheck.output_sha256
  });
  const gateReceipt = writeReceipt(`v3-gate-${stamp}.json`, {
    schema_version: 'aiws.v3.gate_receipt.v1',
    status: 'passed',
    source: { base_commit: baseCommit, commit, tree, clean: true, lockfile_sha256: lockfileSha256 },
    gate_fingerprint: gateFingerprint,
    verification: gate,
    source_patch: {
      path: path.relative(root, sourcePatch).replaceAll('\\', '/'),
      sha256: sourcePatchSha256,
      rollback_check: patchRollbackCheck
    }
  });

  const buildArgs = [
    '--build-arg', `AIWS_VERSION=${version}`,
    '--build-arg', `AIWS_COMMIT=${commit}`,
    '--build-arg', `AIWS_TREE=${tree}`,
    '--build-arg', `AIWS_LOCKFILE_SHA256=${lockfileSha256}`,
    '--build-arg', `AIWS_GATE_FINGERPRINT=${gateFingerprint}`,
    '--build-arg', `AIWS_SBOM_SHA256=${sourceSbomSha256}`
  ];
  const definitions = [
    { role: 'runner', target: 'codex-runner', repository: 'aiws-codex-runner' },
    { role: 'broker', target: 'broker', repository: 'aiws-runner-broker' },
    { role: 'app', target: 'production', repository: 'aiws-app' }
  ];
  const images = [];
  for (const definition of definitions) {
    const candidateTag = `${definition.repository}:${version}-${shortCommit}`;
    const build = await runLogged(`build-${definition.role}`, 'docker', [
      'build', '--target', definition.target, '--tag', candidateTag, ...buildArgs, '.'
    ]);
    const inspected = JSON.parse(execFileSync('docker', ['image', 'inspect', candidateTag], { cwd: root, encoding: 'utf8', windowsHide: true }))[0];
    const labels = inspected.Config?.Labels || {};
    const expectedLabels = {
      'org.opencontainers.image.version': version,
      'org.opencontainers.image.revision': commit,
      'aiws.source.tree': tree,
      'aiws.source.lockfile-sha256': lockfileSha256,
      'aiws.gate.fingerprint': gateFingerprint,
      'aiws.sbom.sha256': sourceSbomSha256
    };
    for (const [key, value] of Object.entries(expectedLabels)) {
      if (labels[key] !== value) throw new Error(`image_label_mismatch:${definition.role}:${key}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(inspected.Id)) throw new Error(`image_digest_invalid:${definition.role}`);
    const imageSbom = path.join(releaseRoot, `sbom-${definition.role}-${version}-${shortCommit}.spdx.json`);
    const sbom = await runLogged(`sbom-${definition.role}`, 'docker', [
      'sbom', inspected.Id, '--format', 'spdx-json', '--output', imageSbom
    ]);
    images.push({
      role: definition.role,
      candidate_tag: candidateTag,
      image_id: inspected.Id,
      repo_digests: inspected.RepoDigests || [],
      size_bytes: inspected.Size,
      labels: expectedLabels,
      build,
      image_sbom: path.relative(root, imageSbom).replaceAll('\\', '/'),
      image_sbom_sha256: sha256File(imageSbom),
      sbom_command: sbom
    });
  }

  const imageReceipt = writeReceipt(`v3-images-${stamp}.json`, {
    schema_version: 'aiws.v3.image_receipt.v1',
    status: 'candidate',
    source: { commit, tree, clean: true, lockfile_sha256: lockfileSha256 },
    gate_fingerprint: gateFingerprint,
    gate_receipt: path.relative(root, gateReceipt.path).replaceAll('\\', '/'),
    source_sbom: { path: 'sbom.spdx.json', sha256: sourceSbomSha256 },
    images
  });
  process.stdout.write(`${JSON.stringify({
    status: 'candidate', commit, gate_receipt: gateReceipt.path,
    image_receipt: imageReceipt.path,
    images: Object.fromEntries(images.map((image) => [image.role, image.image_id]))
  }, null, 2)}\n`);
} catch (error) {
  const failure = writeReceipt(`v3-build-failure-${stamp}.json`, {
    schema_version: 'aiws.v3.build_failure_receipt.v1',
    status: 'failed',
    source: { commit, tree, clean_at_start: true, lockfile_sha256: lockfileSha256 },
    failed_step: error.record?.label || 'identity_verification',
    error: error.message,
    commands: records
  });
  process.stderr.write(`release build failed; receipt: ${failure.path}\n`);
  process.exitCode = 1;
}
