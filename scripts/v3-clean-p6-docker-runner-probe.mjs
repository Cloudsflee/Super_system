import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrokerRunnerAdapter } from '../apps/api/src/clean/runner-adapters.mjs';
import { start as startBroker } from '../apps/runner-broker/clean-server.mjs';
import {
  createDockerVolumeFixture, createServiceIdentity, emitProbe, publicReceipt,
  signedSpec, verifyTerminal, waitForRunner
} from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p6-docker-runner-probe.v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-docker-probe-'));
  const suffix = 'docker_probe'; const fixture = await createDockerVolumeFixture(suffix);
  const secret = 'p6-docker-probe-transport-secret'; let broker;
  try {
    const identity = createServiceIdentity();
    broker = await startBroker({
      port: 0, secret, runnerDigest: fixture.digest, stateRoot: path.join(root, 'broker'),
      dataVolume: fixture.volume,
      servicePublicKey: identity.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });
    const adapter = new BrokerRunnerAdapter({ baseUrl: broker.url, secret });
    const probe = await adapter.probe();
    const signed = signedSpec({ identity, suffix, runnerType: 'docker', imageDigest: fixture.digest });
    const submitted = await adapter.submit(signed.spec, { specHash: signed.spec_sha256, specSignature: signed.signature, servicePublicKey: identity.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    const terminal = await waitForRunner(adapter, submitted.job_id, {}, 120_000);
    const verified = verifyTerminal(terminal, signed);

    const cancelSigned = signedSpec({ identity, suffix: `${suffix}_cancel`, runnerType: 'docker', imageDigest: fixture.digest });
    const cancelSubmitted = await adapter.submit(cancelSigned.spec, { specHash: cancelSigned.spec_sha256, specSignature: cancelSigned.signature, servicePublicKey: identity.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    await adapter.cancel(cancelSubmitted.job_id);
    const cancelTerminal = await waitForRunner(adapter, cancelSubmitted.job_id);
    verifyTerminal(cancelTerminal, cancelSigned, 'cancelled');
    return {
      runner_type: 'docker', docker_server_version: probe.docker_server_version,
      image_digest: fixture.digest, real_container: true, isolation: probe.capabilities,
      transport: 'timestamp+nonce+body-hash+hmac', receipt: publicReceipt({ receipt: verified.receipt }),
      cancel_status: cancelTerminal.status
    };
  } finally {
    await broker?.close?.(); await fixture.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});
