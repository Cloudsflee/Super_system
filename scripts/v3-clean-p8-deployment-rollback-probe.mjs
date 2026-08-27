import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256Hex } from '../apps/api/src/clean/canonical.mjs';
import { approved, close, open, prepare } from '../tests/p8/helpers.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p8-deployment-probe.v2', async () => {
  const state = await open({ config: { runtimeBuild: 'v3-clean-p8-deployment-probe' } });
  try {
    const base = await prepare(state, 'deployment-probe');
    const approval = await approved(state, base.project.id, 'deployment.create', {}, 'deployment-probe-create');
    const digest = 'd'.repeat(64);
    const candidate = await state.runtime.p8Service.createDeploymentCandidate({ app_digest: digest, broker_digest: digest, runner_digest: digest, parser_digest: digest, bridge_identity: 'bridge-probe-identity', sbom_sha256: digest, source_tree_sha256: digest, lockfile_sha256: digest, gate_fingerprint: digest, compose_sha256: digest, volume_manifest: { sqlite: digest, cas: digest }, approval_id: approval.id, expected_revision: 0, idempotency_key: 'p8-deployment-probe-create' }, state.principal);
    const verificationApproval = await approved(state, base.project.id, 'deployment.verify', { candidate_id: candidate.candidate.id }, 'deployment-probe-verify');
    const verification = await state.runtime.p8Service.verifyDeployment(candidate.candidate.id, { checks: [{ name: 'livez', status: 'passed', passed: true }, { name: 'readyz', status: 'passed', passed: true }, { name: 'schema', status: 'passed', passed: true }, { name: 'cas', status: 'passed', passed: true }], viewport_evidence: [[1440, 900], [1024, 768], [390, 844]].map(([width, height]) => ({ width, height, status: 'passed' })), volume_manifest_sha256: digest, approval_id: verificationApproval.id, expected_revision: candidate.candidate.revision, idempotency_key: 'p8-deployment-probe-verify' }, state.principal);
    const external = await dockerProbe();
    return { local: { candidate_status: verification.candidate.status, verification_status: verification.verification.status, receipt_sha256: verification.verification.receipt_sha256, viewports: [[1440, 900], [1024, 768], [390, 844]] }, external, provisional: external.status !== 'verified' };
  } finally { await close(state); }
});

async function dockerProbe() {
  const version = run('docker', ['version', '--format', '{{.Server.Version}}'], 15_000);
  if (version.status !== 0 || !version.stdout.trim()) return { status: 'missing', reason: 'docker_daemon_unavailable', provisional: true };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-deployment-external-'));
  const suffix = `${process.pid}-${Date.now()}`;
  const targets = { app: 'production', broker: 'broker', runner: 'codex-runner', parser: 'parser-worker' };
  const images = {};
  let container = '';
  let volume = '';
  try {
    const commit = run('git', ['rev-parse', 'HEAD']).stdout.trim();
    const tree = run('git', ['write-tree']).stdout.trim();
    const lockfile = sha256Hex(fs.readFileSync('pnpm-lock.yaml'));
    const gate = sha256Hex(`${commit}:${tree}:${lockfile}`);
    const sbomSource = sha256Hex(fs.readFileSync('sbom.spdx.json'));
    for (const [name, target] of Object.entries(targets)) {
      const tag = `aiws-p8-${name}:${suffix}`;
      const build = run('docker', ['build', '--target', target, '--tag', tag, '--build-arg', 'AIWS_VERSION=3.0.0', '--build-arg', `AIWS_COMMIT=${commit}`, '--build-arg', `AIWS_TREE=${tree}`, '--build-arg', `AIWS_LOCKFILE_SHA256=${lockfile}`, '--build-arg', `AIWS_GATE_FINGERPRINT=${gate}`, '--build-arg', `AIWS_SBOM_SHA256=${sbomSource}`, '.'], 900_000);
      if (build.status !== 0) return { status: 'failed', reason: `build_${name}`, exit_status: build.status, provisional: true };
      const inspected = run('docker', ['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "aiws.component"}}', tag]);
      if (inspected.status !== 0) return { status: 'failed', reason: `inspect_${name}`, provisional: true };
      const [id, component] = inspected.stdout.trim().split(/\s+/, 2);
      images[name] = { tag, digest: id.replace(/^sha256:/, ''), component };
      const sbom = run('docker', ['sbom', '--format', 'spdx-json', tag], 120_000);
      if (sbom.status !== 0) return { status: 'failed', reason: `sbom_${name}`, provisional: true };
      const sbomFile = path.join(root, `${name}.spdx.json`);
      fs.writeFileSync(sbomFile, sbom.stdout);
      images[name].sbom_sha256 = sha256Hex(fs.readFileSync(sbomFile));
    }
    volume = `aiws-p8-probe-${suffix}`;
    if (run('docker', ['volume', 'create', volume]).status !== 0) return { status: 'failed', reason: 'volume_create', provisional: true };
    container = `aiws-p8-probe-${suffix}`;
    const started = run('docker', ['run', '--detach', '--name', container, '--publish', '127.0.0.1::4317', '--mount', `source=${volume},target=/var/lib/aiws`, '--env', 'AIWS_CLEAN_VAULT_KEY=p8-probe-vault-master-key-00000000', '--env', 'AIWS_CLEAN_MCP_PEPPER=p8-probe-mcp-pepper-000000000000', '--env', 'AIWS_GATEWAY_SECRET=p8-probe-gateway-secret-000000000', images.app.tag], 30_000);
    if (started.status !== 0) return { status: 'failed', reason: 'container_start', provisional: true };
    const portResult = run('docker', ['port', container, '4317/tcp']);
    const port = Number(portResult.stdout.trim().match(/:(\d+)$/)?.[1]);
    if (!port) return { status: 'failed', reason: 'dynamic_port', provisional: true };
    let ready = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { const response = await fetch(`http://127.0.0.1:${port}/readyz`); if (response.ok) { ready = await response.json(); break; } } catch { /* wait for health */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (ready?.data?.user_version !== 8) return { status: 'failed', reason: 'readyz', provisional: true };
    return { status: 'verified', docker_version: version.stdout.trim(), images, dynamic_loopback_port: port, readyz: { runtime: ready.data.runtime, user_version: ready.data.user_version }, temporary_volume: volume, provisional: false };
  } finally {
    if (container) run('docker', ['rm', '--force', container], 30_000);
    if (volume) run('docker', ['volume', 'rm', volume], 30_000);
    for (const image of Object.values(images)) run('docker', ['image', 'rm', '--force', image.tag], 30_000);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function run(command, args, timeout = 30_000) { return spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); }
