import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ACTIVE_TARGET_VERSION, createApp, start } from '../../apps/api/server.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p4-entrypoint-'));
  return {
    root,
    config: {
      runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
      databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
      receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'p4-entrypoint-cursor-secret', sessionSecret: 'p4-entrypoint-session-secret',
      vaultMasterKey: 'p4-entrypoint-vault-secret', mcpPepper: 'p4-entrypoint-mcp-pepper',
      gatewaySecret: 'p4-entrypoint-gateway-secret', gatewayId: 'gateway-p4-entrypoint',
      runtimeBuild: 'p4-active-entrypoint-test', maxBodyBytes: 100000
    }
  };
}

test('active API entrypoint boots schema v9 with the complete P10 owner surface', async () => {
  const f = fixture();
  const app = await createApp({ config: f.config });
  try {
    await app.recovery;
    assert.equal(ACTIVE_TARGET_VERSION, 9);
    assert.equal(app.p3, true);
    assert.equal(app.p4, true);
    assert.equal(app.p5, true);
    assert.equal(app.p6, true);
    assert.equal(app.p7, true);
    assert.equal(app.p8, true);
    assert.equal(app.p10, true);
    assert.equal(app.metadata.user_version, 9);
    assert.equal(app.db.integrity().user_version, 9);
    assert.equal(app.ownership.valid, true);
    assert.ok(app.registry.get('context.map'));
    assert.ok(app.registry.get('gateway.forward'));
    assert.ok(app.registry.get('assist.session.create'));
    assert.ok(app.registry.get('runner.profile.list'));
    assert.ok(app.registry.get('execution.create'));
    assert.ok(app.registry.get('asset.capture'));
    assert.ok(app.registry.get('quality.start'));
    assert.ok(app.registry.get('outcome.evaluate'));
    assert.ok(app.registry.get('delivery.submit'));
    assert.ok(app.registry.get('operations.replay'));
    assert.ok(app.registry.get('project.deletion.prepare'));
  } finally {
    await app.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('active HTTP wrapper serves schema v9 health and keeps API v1 retired', async () => {
  const f = fixture();
  const running = await start({ config: f.config });
  const base = `http://127.0.0.1:${running.server.address().port}`;
  try {
    const ready = await fetch(`${base}/readyz`);
    const readyBody = await ready.json();
    assert.equal(ready.status, 200);
    assert.equal(readyBody.data.user_version, 9);
    assert.equal(readyBody.data.schema_family, 'v3-clean');

    const retired = await fetch(`${base}/api/v1/projects`);
    const retiredBody = await retired.json();
    assert.equal(retired.status, 410);
    assert.equal(retiredBody.error.code, 'route_retired');

    const context = await fetch(`${base}/api/v2/projects/missing/context/map`);
    assert.equal(context.status, 401);
  } finally {
    await running.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
