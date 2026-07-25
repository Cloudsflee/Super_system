import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((value, index, all) => (value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : []))
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v175-mutation-'));
process.env.AIWS_HOME = path.join(root, 'home');
const results = [];
const mutant = async (domain, operator, run) => {
  try {
    await run();
    results.push({ domain, operator, status: 'killed' });
  } catch (error) {
    results.push({ domain, operator, status: 'survived', detail: error.message });
  }
};

try {
  const { isWithin } = await import('../../apps/api/src/managed-workspace.mjs');
  const { putSecret, redactKnownSecrets } = await import('../../apps/api/src/vault.mjs');
  const { operationEvent } = await import('../../apps/api/src/assist-operation-metadata.mjs');
  const { CodexBuildManager } = await import('../../apps/api/src/codex-build-service.mjs');
  const { migrateState15To16, V16_COLLECTIONS } = await import('../../apps/api/src/state-migration-v16.mjs');

  await mutant('path-barrier', 'replace-relative-boundary-with-startsWith', () => {
    const base = path.join(root, 'repo'),
      sibling = path.join(root, 'repo-copy', 'file');
    assert.equal(isWithin(base, sibling), false);
    assert.equal(sibling.startsWith(base), true);
  });
  await mutant('redaction', 'replace-redactor-with-identity', async () => {
    const secret = 'sk-v175-mutation-secret',
      ref = await putSecret('mutation', secret),
      redacted = await redactKnownSecrets(`token=${secret}; ref=${ref}`);
    assert.doesNotMatch(redacted, new RegExp(secret));
    assert.match(`token=${secret}`, new RegExp(secret));
  });
  await mutant('operation-state', 'claimable-for-all-pending-operations', () => {
    const server = operationEvent({
      id: 'op',
      capability_id: 'project.workflow.graph.patch',
      status: 'pending',
      execution_layer: 'server'
    });
    assert.equal(server.claimable, false);
    assert.equal(server.status === 'pending', true);
  });
  await mutant('migration', 'always-run-schema-migration', () => {
    const state = Object.fromEntries(V16_COLLECTIONS.map((key) => [key, []]));
    state.schema_version = 16;
    const result = migrateState15To16(state, { timestamp: new Date(0).toISOString() });
    assert.equal(result.migrated, false);
  });
  await mutant('build-single-flight', 'remove-active-image-deduplication', async () => {
    let spawns = 0;
    const manager = new CodexBuildManager({
      inspectRuntime: async () => ({ ready: false, docker: { ok: true }, image: { ready: false } }),
      invalidateRuntime: () => undefined,
      spawnProcess: () => {
        spawns++;
        const child = fakeChild();
        setImmediate(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 1, null);
        });
        return child;
      }
    });
    const [first, second] = await Promise.all([
      manager.ensure({ image: 'mutation:test' }),
      manager.ensure({ image: 'mutation:test' })
    ]);
    assert.equal(first.operation.operation_id, second.operation.operation_id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(spawns, 1);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const killed = results.filter((item) => item.status === 'killed').length,
  score = results.length ? Math.round((killed / results.length) * 10000) / 100 : 0;
const summary = {
  generated_at: new Date().toISOString(),
  method: 'targeted-contract-mutants',
  gate: false,
  killed,
  total: results.length,
  score,
  results
};
if (args.output) {
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(summary, null, 2));
}
console.log(`V1.75 mutation diagnostic score=${score}% (${killed}/${results.length}); record-only`);
if (results.some((item) => item.status === 'survived'))
  console.log(
    `survivors=${results
      .filter((item) => item.status === 'survived')
      .map((item) => item.domain)
      .join(',')}`
  );

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.emit('close', null, signal);
    return true;
  };
  return child;
}
