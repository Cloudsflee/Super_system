import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, mutate, request } from '../tests/integration/helpers.mjs';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || '') : null;
const nodeCount = 1000;
const sampleCounts = { map: 30, search: 30, selection: 20, mcp_read: 100 };
const thresholds = { map_p95_ms: 150, search_p95_ms: 250, selection_p95_ms: 500 };
let env;

try {
  env = await fixture();
  const project = await mutate(env.base, '/api/v1/projects', { name: 'R5 performance fixture' }, 'r5-performance-project');
  requireStatus(project, 201, 'project_create');
  const timestamp = '2026-08-16T00:00:00.000Z';
  await env.app.database.transaction(Array.from({ length: nodeCount }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    const content = `performance context node ${suffix} shared retrieval signal`;
    return {
      sql: 'INSERT INTO context_sources(id,project_id,kind,path,title,content,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
      params: [`src_perf_${suffix}`, project.json.id, 'note', '', `Performance node ${suffix}`, content, digest(content), timestamp]
    };
  }));
  const rebuildStarted = performance.now();
  const rebuild = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/rebuild`, {}, 'r5-performance-rebuild');
  requireStatus(rebuild, 201, 'context_rebuild');
  const rebuildMs = elapsed(rebuildStarted);
  const sourceNodeIds = rebuild.json.map.nodes.filter((node) => node.source_type === 'context_source').map((node) => node.id);
  if (sourceNodeIds.length !== nodeCount) throw new Error(`performance_node_count_mismatch:${sourceNodeIds.length}`);

  await request(env.base, `/api/v1/projects/${project.json.id}/context/map`);
  await request(env.base, `/api/v1/projects/${project.json.id}/context/search?q=retrieval`);
  await mutate(env.base, `/api/v1/projects/${project.json.id}/context/selections`, { node_ids: sourceNodeIds, token_budget: 100000 }, 'r5-performance-selection-warmup');

  const mapSamples = await samples(sampleCounts.map, async () => {
    const response = await request(env.base, `/api/v1/projects/${project.json.id}/context/map`);
    requireStatus(response, 200, 'context_map');
  });
  const searchSamples = await samples(sampleCounts.search, async () => {
    const response = await request(env.base, `/api/v1/projects/${project.json.id}/context/search?q=retrieval`);
    requireStatus(response, 200, 'context_search');
  });
  let selectionSequence = 0;
  const selectionSamples = await samples(sampleCounts.selection, async () => {
    selectionSequence += 1;
    const response = await mutate(env.base, `/api/v1/projects/${project.json.id}/context/selections`, { node_ids: sourceNodeIds, token_budget: 100000 }, `r5-performance-selection-${selectionSequence}`);
    requireStatus(response, 201, 'context_selection');
  });

  const client = await mutate(env.base, '/api/v1/mcp/clients', { name: 'R5 performance MCP', transport: 'stdio', scope: { project_ids: [project.json.id], tools: ['project.get'] }, ttl_seconds: 900 }, 'r5-performance-mcp-client');
  requireStatus(client, 201, 'mcp_client');
  let mcpSequence = 0;
  const mcpSamples = await samples(sampleCounts.mcp_read, async () => {
    mcpSequence += 1;
    const response = await request(env.base, '/api/v1/mcp', {
      method: 'POST', key: `r5-performance-mcp-${mcpSequence}`, headers: { 'x-aiws-mcp-token': client.json.token },
      body: { jsonrpc: '2.0', id: mcpSequence, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: project.json.id } } }
    });
    requireStatus(response, 200, 'mcp_read');
  });

  const results = {
    rebuild_ms: rebuildMs,
    projected_nodes: sourceNodeIds.length,
    map: metrics(mapSamples),
    search: metrics(searchSamples),
    selection: metrics(selectionSamples),
    mcp_read: metrics(mcpSamples)
  };
  const checks = {
    map_p95: results.map.p95_ms <= thresholds.map_p95_ms,
    search_p95: results.search.p95_ms <= thresholds.search_p95_ms,
    selection_p95: results.selection.p95_ms <= thresholds.selection_p95_ms,
    mcp_reads_completed: results.mcp_read.samples === sampleCounts.mcp_read
  };
  const receipt = {
    schema_version: 'aiws.v3.r5_performance_receipt.v1',
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    created_at: new Date().toISOString(),
    fixture: { nodes: nodeCount, transport: 'loopback_only', production_volume_touched: false },
    sample_counts: sampleCounts,
    thresholds,
    results,
    checks
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== 'passed') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: String(error?.message || 'r5_performance_failed').replace(/[^a-zA-Z0-9_:.-]/g, '_') })}\n`);
  process.exitCode = 1;
} finally {
  await env?.close().catch(() => undefined);
}

async function samples(count, callback) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await callback(index);
    values.push(elapsed(started));
  }
  return values;
}

function metrics(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] || 0;
  return {
    samples: values.length,
    min_ms: round(sorted[0] || 0),
    median_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    max_ms: round(sorted.at(-1) || 0)
  };
}

function elapsed(started) { return round(performance.now() - started); }
function round(value) { return Math.round(Number(value) * 100) / 100; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function requireStatus(result, expected, label) {
  if (result.response.status !== expected) throw new Error(`${label}_status_${result.response.status}_${result.json?.error?.code || 'unknown'}`);
}
