import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';

export function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p4-'));
  return {
    root,
    config: {
      runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
      databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
      receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'p4-cursor-fixture-secret', sessionSecret: 'p4-session-fixture-secret',
      vaultMasterKey: 'p4-vault-master-fixture-secret', mcpPepper: 'p4-mcp-pepper-fixture-secret',
      gatewaySecret: 'p4-gateway-fixture-secret', gatewayId: 'gateway-p4-test',
      runtimeBuild: 'p4-test', maxBodyBytes: 2_000_000, ...overrides
    }
  };
}

export async function open(overrides = {}) {
  const state = fixture(overrides.config || overrides);
  const runtime = createCleanRuntime({ config: state.config, targetVersion: 4, ...overrides });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P4 Owner', team_name: 'P4 Team', idempotency_key: 'p4-setup-key' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal, proof: setup.session.proof };
}

export async function project(state, suffix = 'fixture') {
  return state.runtime.project.createProject({ name: `P4 ${suffix}`, idempotency_key: `p4-${suffix}-project-key` }, state.principal);
}

export async function listen(runtime) {
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: String(error?.code || 'internal_error') } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function close(state) {
  state.runtime?.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

export async function closeServer(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}
