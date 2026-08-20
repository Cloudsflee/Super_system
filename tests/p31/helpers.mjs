import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';

export function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p31-'));
  return {
    root,
    config: {
      runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
      databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
      receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'p31-cursor-secret', sessionSecret: 'p31-session-secret',
      vaultMasterKey: 'p31-vault-master-secret', runtimeBuild: 'p31-test', maxBodyBytes: 1_000_000,
      ...overrides
    }
  };
}

export async function open(overrides = {}) {
  const state = fixture(overrides);
  const runtime = createCleanRuntime({ config: state.config, targetVersion: 3, ...overrides });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P31 owner', team_name: 'P31 team', idempotency_key: 'p31-setup-key' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal };
}

export function close(state) {
  state.runtime.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

export async function settle(runtime) { await runtime.db.transactionTail; await new Promise((resolve) => setTimeout(resolve, 5)); }
