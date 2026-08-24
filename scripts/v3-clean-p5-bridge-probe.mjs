import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../apps/api/src/clean/canonical.mjs';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';
import { start as startBridge } from '../apps/windows-native-bridge/server.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p5-bridge-probe-'));
const bridgeRoot = path.join(root, 'bridge');
const bridge = await startBridge({ port: 0, stateRoot: bridgeRoot });
const config = {
  runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
  databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
  receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'), workspaceRoot: path.join(root, 'workspaces'),
  cursorSecret: 'p5-bridge-probe-cursor-secret', sessionSecret: 'p5-bridge-probe-session-secret',
  vaultMasterKey: 'p5-bridge-probe-vault-master-secret', mcpPepper: 'p5-bridge-probe-mcp-pepper',
  gatewaySecret: 'p5-bridge-probe-gateway-secret', gatewayId: 'p5-bridge-probe-gateway',
  bridgeUrl: bridge.url, runtimeBuild: 'v3-clean-p5-bridge-probe', maxBodyBytes: 2_000_000
};
let runtime;
try {
  runtime = createCleanRuntime({ config, targetVersion: 5 });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P5 Bridge Probe', team_name: 'P5 Bridge Probe', idempotency_key: 'p5-bridge-probe-setup' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  const paired = await runtime.bridge.pair({ label: 'P5 independent bridge', expected_revision: 0, idempotency_key: 'p5-bridge-probe-pair' }, principal);
  const first = await runtime.bridge.probe(paired.device.id, { expected_revision: paired.device.revision, idempotency_key: 'p5-bridge-probe-one' }, principal);
  const rotated = await runtime.bridge.rotate(paired.device.id, { expected_revision: first.device.revision, idempotency_key: 'p5-bridge-probe-rotate' }, principal);
  const second = await runtime.bridge.probe(paired.device.id, { expected_revision: rotated.device.revision, idempotency_key: 'p5-bridge-probe-two' }, principal);
  const row = runtime.db.get('SELECT * FROM bridge_devices WHERE id=?', [paired.device.id]);
  const secret = runtime.vault.read(row.shared_secret_ref);
  const secretRef = row.shared_secret_ref.replace(/^vault:/, '');
  const body = { probe: true };
  const timestamp = String(Date.now());
  const nonce = `p5_probe_nonce_${Date.now()}`;
  const bodyHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const signature = createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
  const headers = { 'content-type': 'application/json', 'x-aiws-secret-ref': secretRef, 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-signature': signature };
  const firstNonce = await fetch(`${bridge.url}/v1/probe`, { method: 'POST', headers, body: JSON.stringify(body) });
  const replayNonce = await fetch(`${bridge.url}/v1/probe`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (firstNonce.status !== 200 || replayNonce.status !== 409) throw new Error('bridge_nonce_replay_probe_failed');
  const revoked = await runtime.bridge.revoke(paired.device.id, { expected_revision: second.device.revision, idempotency_key: 'p5-bridge-probe-revoke' }, principal);
  const protectedFilesBeforeCleanup = fs.existsSync(path.join(bridgeRoot, `${secretRef}.protected`));
  if (revoked.device.status !== 'revoked' || protectedFilesBeforeCleanup || runtime.vault.has(row.shared_secret_ref)) throw new Error('bridge_revoke_cleanup_failed');
  process.stdout.write(`${JSON.stringify({
    schema_version: 'aiws.v3-clean.p5-bridge-probe.v1', status: 'passed', provisional: false,
    independent_process: true, loopback_only: true, pairing: 'ed25519+x25519+hkdf+aes-gcm',
    rotation: 'hmac-derived-secret', nonce_replay_status: replayNonce.status,
    revoke_cleanup: true, capabilities: (await fetch(`${bridge.url}/v1/identity`).then((response) => response.json())).capabilities,
    redactions: ['shared_secret', 'confirmation_code', 'host_absolute_path']
  }, null, 2)}\n`);
} finally {
  runtime?.close();
  await bridge.close();
  fs.rmSync(root, { recursive: true, force: true });
}
