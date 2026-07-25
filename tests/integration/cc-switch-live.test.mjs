import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.RUN_CC_SWITCH_LIVE_TESTS !== '1') {
  console.log('cc-switch live tests skipped; set RUN_CC_SWITCH_LIVE_TESTS=1 to run');
  process.exit(0);
}

assert.equal(process.env.AIWS_TEST_CC_SWITCH_CONFIRM, 'isolated', 'isolated cc-switch confirmation is required');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-cc-switch-live-'));
const externalDir = process.env.CC_SWITCH_CONFIG_DIR ? path.resolve(process.env.CC_SWITCH_CONFIG_DIR) : null;
const externalBefore = externalDir ? snapshotTree(externalDir) : null;
process.env.AIWS_HOME = home;

try {
  const { CC_SWITCH_VERSION, installManagedCcSwitch, managedCcSwitchStatus, parseProviderList, runManagedCcSwitch } =
    await import('../../apps/api/src/cc-switch-managed-cli.mjs');
  const installed = await installManagedCcSwitch();
  assert.equal(installed.installed, true);
  assert.equal(installed.version, CC_SWITCH_VERSION);
  assert.equal(installed.checksum_verified, true);
  const status = await managedCcSwitchStatus();
  assert.equal(status.installed, true);
  assert.equal(status.checksum_verified, true);
  const catalog = await runManagedCcSwitch(['--app', 'codex', 'provider', 'list']);
  assert.equal(catalog.ok, true, catalog.stderr || catalog.error);
  assert.ok(Array.isArray(parseProviderList(catalog.stdout)));
  if (externalDir) assert.deepEqual(snapshotTree(externalDir), externalBefore);
  console.log(`cc-switch live test passed (${CC_SWITCH_VERSION}, isolated AIWS_HOME)`);
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return null;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory())
        return snapshotTree(full)?.map((item) => ({ ...item, path: `${entry.name}/${item.path}` })) || [];
      if (!entry.isFile()) return [{ path: entry.name, type: entry.isSymbolicLink() ? 'symlink' : 'other' }];
      const stat = fs.statSync(full);
      return [
        {
          path: entry.name,
          type: 'file',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
      ];
    });
}
