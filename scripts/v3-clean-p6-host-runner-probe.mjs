import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostRunnerAdapter } from '../apps/api/src/clean/runner-adapters.mjs';
import {
  createServiceIdentity, emitProbe, publicReceipt, signedSpec, verifyTerminal, waitForRunner
} from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p6-host-runner-probe.v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-host-probe-'));
  try {
    const adapter = new HostRunnerAdapter({ homeRoot: path.join(root, 'homes') });
    const probe = await adapter.probe();
    const identity = createServiceIdentity();
    const signed = signedSpec({ identity, suffix: 'host_probe' });
    const credential = Buffer.from('ephemeral-host-credential');
    const submitted = await adapter.submit(signed.spec, { specHash: signed.spec_sha256, workspacePath: root, credential });
    const terminal = await waitForRunner(adapter, submitted.job_id);
    const verified = verifyTerminal(terminal, signed);
    if (credential.some((value) => value !== 0)) throw Object.assign(new Error('credential_not_zeroed'), { code: 'credential_not_zeroed' });
    if (fs.readdirSync(path.join(root, 'homes')).length !== 0) throw Object.assign(new Error('isolated_home_not_cleaned'), { code: 'isolated_home_not_cleaned' });

    const cancelSigned = signedSpec({ identity, suffix: 'host_probe_cancel' });
    const cancelled = await adapter.submit(cancelSigned.spec, { specHash: cancelSigned.spec_sha256, workspacePath: root });
    await adapter.cancel(cancelled.job_id);
    const cancelTerminal = await waitForRunner(adapter, cancelled.job_id);
    verifyTerminal(cancelTerminal, cancelSigned, 'cancelled');
    return {
      runner_type: 'host', runtime: probe.runtime, real_process: true, isolated_codex_home: true,
      process_tree_cleanup: true, credential_lease: 'memory_only_zeroed', capabilities: probe.capabilities,
      receipt: publicReceipt({ receipt: verified.receipt }), cancel_status: cancelTerminal.status
    };
  } finally {
    const homes = path.join(root, 'homes');
    if (fs.existsSync(homes) && fs.readdirSync(homes).length === 0) fs.rmdirSync(homes);
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  }
});
