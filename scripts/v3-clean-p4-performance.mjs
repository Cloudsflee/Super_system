import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-performance-'));
const config = {
  runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
  databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
  receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
  cursorSecret: 'p4-performance-cursor-secret', sessionSecret: 'p4-performance-session-secret',
  vaultMasterKey: 'p4-performance-vault-secret', mcpPepper: 'p4-performance-mcp-pepper',
  gatewaySecret: 'p4-performance-gateway-secret', gatewayId: 'p4-performance-gateway',
  runtimeBuild: 'v3-clean-p4-performance', maxBodyBytes: 2_000_000
};
const runtime = createCleanRuntime({ config, targetVersion: 4 });

try {
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P4 Performance', team_name: 'P4 Performance', idempotency_key: 'p4-performance-setup' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  const project = await runtime.project.createProject({ name: 'P4 1000 node fixture', idempotency_key: 'p4-performance-project' }, principal);
  for (let index = 0; index < 1000; index += 1) {
    await runtime.context.createSource(project.id, {
      kind: 'note', title: `Node ${String(index).padStart(4, '0')}`, uri: `performance/node-${String(index).padStart(4, '0')}`,
      // Reuse one bounded payload so this probe measures projection/search
      // throughput rather than repeatedly hashing distinct CAS objects.
      content: 'stable projection search evidence', source_revision: 'r1',
      idempotency_key: `p4-performance-source-${String(index).padStart(4, '0')}`
    }, principal);
  }
  const rebuildStart = performance.now();
  await runtime.context.rebuild(project.id, { mode: 'full', idempotency_key: 'p4-performance-rebuild' }, principal);
  const rebuildMs = performance.now() - rebuildStart;
  const status = runtime.context.status(project.id, principal);
  if (status.status !== 'completed') throw new Error(`p4_performance_rebuild_${status.status}:${status.error_code}`);

  const mapSamples = sample(30, () => runtime.context.map(project.id, principal));
  const searchSamples = sample(30, () => runtime.context.search(project.id, principal, 'projection evidence', { limit: 100 }));
  const selectionSamples = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await runtime.context.createSelection(project.id, { query: 'projection', token_budget: 128000, idempotency_key: `p4-performance-selection-${String(index).padStart(2, '0')}` }, principal);
    selectionSamples.push(performance.now() - started);
  }
  const mcpStarted = performance.now();
  for (let index = 0; index < 100; index += 1) {
    const result = await runtime.dispatcher.dispatch('context_map', { project_id: project.id }, principal);
    if (result.result.nodes.length !== 1001) throw new Error('p4_performance_mcp_read_incomplete');
  }
  const mcpMs = performance.now() - mcpStarted;
  const metrics = {
    map_p95_ms: round(percentile(mapSamples, 0.95)),
    search_p95_ms: round(percentile(searchSamples, 0.95)),
    selection_p95_ms: round(percentile(selectionSamples, 0.95)),
    rebuild_ms: round(rebuildMs),
    mcp_reads: 100,
    mcp_reads_total_ms: round(mcpMs),
    projected_nodes: status.stats.node_count
  };
  const thresholds = { map_p95_ms: 150, search_p95_ms: 250, selection_p95_ms: 500 };
  const failures = Object.entries(thresholds).filter(([name, maximum]) => metrics[name] > maximum).map(([name, maximum]) => `${name}>${maximum}`);
  const receipt = { schema_version: 'aiws.v3-clean.p4-performance.v1', status: failures.length ? 'failed' : 'passed', fixture_nodes: 1000, metrics, thresholds, failures };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} finally {
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function sample(count, callback) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    callback();
    values.push(performance.now() - started);
  }
  return values;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] || 0;
}

function round(value) { return Math.round(value * 100) / 100; }
