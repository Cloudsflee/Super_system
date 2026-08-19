import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ACTIVE_TARGET_VERSION, createApp, start } from '../../apps/api/server.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-active-entrypoint-'));
  return {
    root,
    config: {
      runtime: 'v3-clean',
      apiVersion: '2',
      host: '127.0.0.1',
      port: 0,
      home: root,
      databaseFile: path.join(root, 'data', 'state.sqlite'),
      casRoot: path.join(root, 'cas'),
      receiptRoot: path.join(root, 'receipts'),
      vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'active-entrypoint-cursor-secret',
      sessionSecret: 'active-entrypoint-session-secret',
      vaultMasterKey: 'active-entrypoint-vault-secret',
      runtimeBuild: 'p3-active-entrypoint-test',
      maxBodyBytes: 100000
    }
  };
}

test('active API entrypoint boots the P3 schema and serves V3-Clean health', async () => {
  const f = fixture();
  const app = await createApp({
    env: {
      AIWS_CLEAN_HOME: f.root,
      AIWS_CLEAN_PORT: '4317',
      AIWS_CLEAN_CURSOR_SECRET: 'active-entrypoint-cursor-secret',
      AIWS_CLEAN_SESSION_SECRET: 'active-entrypoint-session-secret',
      AIWS_CLEAN_VAULT_KEY: 'active-entrypoint-vault-secret'
    }
  });
  try {
    await app.recovery;
    assert.equal(ACTIVE_TARGET_VERSION, 3);
    assert.equal(app.p3, true);
    assert.equal(app.metadata.user_version, 3);
    assert.equal(app.db.integrity().user_version, 3);
  } finally {
    await app.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('active API HTTP wrapper exposes only the P3 clean health and API surfaces', async () => {
  const f = fixture();
  const running = await start({ config: f.config });
  const base = `http://127.0.0.1:${running.server.address().port}`;
  try {
    const ready = await fetch(`${base}/readyz`);
    const readyBody = await ready.json();
    assert.equal(ready.status, 200);
    assert.equal(readyBody.data.user_version, 3);
    assert.equal(readyBody.data.schema_family, 'v3-clean');

    const retired = await fetch(`${base}/api/v1/projects`);
    const retiredBody = await retired.json();
    assert.equal(retired.status, 410);
    assert.equal(retiredBody.error.code, 'route_retired');

    const account = await fetch(`${base}/api/v2/account`);
    assert.equal(account.status, 401);
  } finally {
    await running.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
