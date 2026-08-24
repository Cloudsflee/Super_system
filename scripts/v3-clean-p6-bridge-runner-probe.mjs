import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeJobAdapter } from '../apps/api/src/clean/runner-adapters.mjs';
import { WindowsBridgeAdapter } from '../apps/api/src/clean/windows-bridge-adapter.mjs';
import { start as startBridge } from '../apps/windows-native-bridge/server.mjs';
import {
  createServiceIdentity, emitProbe, publicReceipt, signedSpec, verifyTerminal, waitForRunner
} from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p6-bridge-runner-probe.v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-bridge-runner-probe-'));
  const bridge = await startBridge({ port: 0, stateRoot: path.join(root, 'bridge') });
  let paired;
  try {
    const transport = new WindowsBridgeAdapter({ baseUrl: bridge.url });
    paired = await transport.pair();
    const leases = [];
    const adapter = new BridgeJobAdapter({
      bridgeAdapter: transport,
      leaseForProfile: () => {
        const lease = { secretRef: paired.secretRef, secret: Buffer.from(paired.secret) };
        leases.push(lease.secret); return lease;
      }
    });
    const probe = await adapter.probe({ bridge_device_id: 'bridge_probe_device' });
    const identity = createServiceIdentity();
    const servicePublicKey = identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signed = signedSpec({ identity, suffix: 'bridge_probe', runnerType: 'windows_bridge' });
    const submitted = await adapter.submit(signed.spec, { profile: {}, specHash: signed.spec_sha256, specSignature: signed.signature, servicePublicKey });
    const terminal = await waitForRunner(adapter, submitted.job_id, { profile: {} });
    const verified = verifyTerminal(terminal, signed);
    const cancelSigned = signedSpec({ identity, suffix: 'bridge_probe_cancel', runnerType: 'windows_bridge' });
    const cancelSubmitted = await adapter.submit(cancelSigned.spec, { profile: {}, specHash: cancelSigned.spec_sha256, specSignature: cancelSigned.signature, servicePublicKey });
    await adapter.cancel(cancelSubmitted.job_id, { profile: {} });
    const cancelTerminal = await waitForRunner(adapter, cancelSubmitted.job_id, { profile: {} });
    verifyTerminal(cancelTerminal, cancelSigned, 'cancelled');
    if (leases.some((secret) => secret.some((value) => value !== 0))) throw Object.assign(new Error('bridge_lease_not_zeroed'), { code: 'bridge_lease_not_zeroed' });
    const identityReceipt = await transport.identity();
    if (process.platform === 'win32' && identityReceipt.capabilities.dpapi !== true) throw Object.assign(new Error('dpapi_missing'), { code: 'dpapi_missing' });
    return {
      runner_type: 'windows_bridge', independent_loopback_process: true,
      dpapi: identityReceipt.capabilities.dpapi, conpty: identityReceipt.capabilities.conpty,
      credential_lease: 'memory_only_zeroed', transport: 'timestamp+nonce+body-hash+hmac',
      receipt: publicReceipt({ receipt: verified.receipt }), cancel_status: cancelTerminal.status
    };
  } finally {
    if (paired?.secret) { try { await new WindowsBridgeAdapter({ baseUrl: bridge.url }).revoke({ secretRef: paired.secretRef, secret: paired.secret }); } catch { /* cleanup only */ } paired.secret.fill(0); }
    await bridge.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
