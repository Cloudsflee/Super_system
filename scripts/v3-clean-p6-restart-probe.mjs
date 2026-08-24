import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrokerRunnerAdapter } from '../apps/api/src/clean/runner-adapters.mjs';
import { start as startBroker } from '../apps/runner-broker/clean-server.mjs';
import {
  createDockerVolumeFixture, createServiceIdentity, emitProbe, publicReceipt,
  signedSpec, verifyTerminal, waitForRunner
} from './lib/v3-clean-p6-runner-probe.mjs';

const execFileAsync = promisify(execFile);

await emitProbe('aiws.v3-clean.p6-restart-probe.v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-restart-probe-'));
  const suffix = 'restart_probe'; const fixture = await createDockerVolumeFixture(suffix);
  const secret = 'p6-restart-probe-transport-secret'; const identity = createServiceIdentity();
  const servicePublicKey = identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let first; let second; let liveContainer = '';
  try {
    first = await startBroker({ port: 0, secret, runnerDigest: fixture.digest, stateRoot: path.join(root, 'broker'), dataVolume: fixture.volume, servicePublicKey });
    const before = new BrokerRunnerAdapter({ baseUrl: first.url, secret });
    const signed = signedSpec({ identity, suffix, runnerType: 'docker', imageDigest: fixture.digest });
    const submitted = await before.submit(signed.spec, { specHash: signed.spec_sha256, specSignature: signed.signature, servicePublicKey });
    const terminal = await waitForRunner(before, submitted.job_id, {}, 120_000);
    verifyTerminal(terminal, signed);
    const firstIdentity = first.identity_public_key;
    await first.close(); first = null;

    const liveSigned = signedSpec({ identity, suffix: 'restart_running', runnerType: 'docker', imageDigest: fixture.digest });
    const liveJobId = 'broker_job_7265737461727472756e6e696e67';
    const liveJob = {
      job_id: liveJobId, status: 'running', spec: liveSigned.spec, spec_hash: liveSigned.spec_sha256,
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), receipt: null,
      signature: null, signer_public_key: firstIdentity
    };
    fs.writeFileSync(path.join(root, 'broker', 'jobs', `${liveJobId}.json`), `${JSON.stringify(liveJob, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    liveContainer = `aiws-${liveSigned.spec.job_spec_id}`;
    await execFileAsync('docker', [
      'run', '--detach', '--name', liveContainer,
      '--label', 'aiws.owner=v3-clean', '--label', `aiws.execution=${liveSigned.spec.execution_ref}`, '--label', `aiws.job=${liveSigned.spec.job_spec_id}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--network', 'none',
      fixture.digest, 'node', '-e', 'setInterval(()=>{},1000)'
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });

    second = await startBroker({ port: 0, secret, runnerDigest: fixture.digest, stateRoot: path.join(root, 'broker'), dataVolume: fixture.volume, servicePublicKey });
    const after = new BrokerRunnerAdapter({ baseUrl: second.url, secret });
    const recovered = await after.status(submitted.job_id);
    const verified = verifyTerminal(recovered, signed);
    const running = await after.status(liveJobId);
    const labelProbe = await execFileAsync('docker', ['inspect', '--format', '{{index .Config.Labels "aiws.owner"}} {{index .Config.Labels "aiws.job"}}', liveContainer], { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 });
    await execFileAsync('docker', ['rm', '--force', liveContainer], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 }); liveContainer = '';
    const reconciledUnknown = await after.status(liveJobId);
    const unknown = await after.status('broker_job_missing_fixture');
    const labels = String(labelProbe.stdout || '').trim();
    if (second.identity_public_key !== firstIdentity || running.status !== 'running'
        || labels !== `v3-clean ${liveSigned.spec.job_spec_id}`
        || reconciledUnknown.status !== 'external_result_unknown' || unknown.status !== 'unknown') {
      const flags = [second.identity_public_key === firstIdentity, running.status, labels === `v3-clean ${liveSigned.spec.job_spec_id}`, reconciledUnknown.status, unknown.status].join('_');
      throw Object.assign(new Error('restart_reconciliation_failed'), { code: `restart_reconciliation_failed_${flags}` });
    }
    return {
      adapter: 'clean-broker', persistent_identity: true, terminal_receipt_recovered: true,
      running_container_reconciled: true, unknown_external_result: reconciledUnknown.status,
      docker_label_query: { status: 'passed', owner: 'v3-clean', job_spec_id: liveSigned.spec.job_spec_id },
      receipt: publicReceipt({ receipt: verified.receipt })
    };
  } finally {
    await first?.close?.(); await second?.close?.();
    if (liveContainer) await execFileAsync('docker', ['rm', '--force', liveContainer], { encoding: 'utf8', timeout: 30_000, windowsHide: true }).catch(() => undefined);
    await fixture.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});
