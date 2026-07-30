#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { apiRoutes } from '../apps/api/src/api-routes.mjs';
import { collections } from '../apps/api/src/config.mjs';
import {
  CONTEXT_EDGE_TYPES,
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_STATE_ADAPTERS,
  contextNodeId,
  contextSourceRecordId,
  reconcileContextProjectionState
} from '../packages/system-context/src/index.mjs';
import { readJson } from './v175-lib.mjs';

const errors = [];
const coverage = readJson('tests/v20/coverage-map.json');
const sources = coverage.state_collections || [];
for (const collection of sources)
  if (!collections.includes(collection)) errors.push(`schema 20 collection no longer supported: ${collection}`);
if (!sameSet(CONTEXT_INTERNAL_COLLECTIONS, coverage.context_collections))
  errors.push('context collection coverage is not exact');
if (!sameSet(CONTEXT_EDGE_TYPES, coverage.edge_types)) errors.push('edge type coverage is not exact');
for (const collection of sources)
  if (!CONTEXT_STATE_ADAPTERS[collection]) errors.push(`missing context adapter: ${collection}`);

const state = Object.fromEntries(sources.map((name) => [name, [{ id: `coverage-${name}` }]]));
const projected = reconcileContextProjectionState(state, {
  sourceCollections: sources,
  timestamp: '2026-07-26T00:00:00.000Z'
});
if (projected.warnings.length) errors.push(`adapter warnings: ${JSON.stringify(projected.warnings)}`);
for (const collection of sources) {
  const record = state[collection][0];
  const sourceId = contextSourceRecordId(collection, record);
  const node = state.context_nodes.find(
    (item) => item.id === contextNodeId(collection, sourceId) && item.source_collection === collection
  );
  if (!node || !['active', 'tombstone'].includes(node.status))
    errors.push(`source record not covered: ${collection}:${sourceId}`);
  if (node?.status === 'active' && !state.context_projection_jobs.some((job) => job.node_id === node.id))
    errors.push(`source record lacks projection lifecycle: ${collection}:${sourceId}`);
}
const removedCollection = sources.find((name) => name !== 'projects');
const removedNodeId = contextNodeId(
  removedCollection,
  contextSourceRecordId(removedCollection, state[removedCollection][0])
);
state[removedCollection] = [];
reconcileContextProjectionState(state, { sourceCollections: sources, timestamp: '2026-07-26T01:00:00.000Z' });
if (state.context_nodes.find((node) => node.id === removedNodeId)?.status !== 'tombstone')
  errors.push('deleted source record lacks explicit tombstone');

const routeKeys = new Set(apiRoutes.map((route) => `${route.method} ${route.pattern}`));
for (const route of coverage.rest) if (!routeKeys.has(route)) errors.push(`REST coverage route missing: ${route}`);
const mcpSource = fs.readFileSync('apps/api/src/mcp-server-factory.mjs', 'utf8');
for (const action of coverage.mcp_actions)
  if (!mcpSource.includes(`'${action}'`)) errors.push(`MCP action missing: ${action}`);
for (const uri of coverage.mcp_resources) if (!mcpSource.includes(uri)) errors.push(`MCP resource missing: ${uri}`);
const routerSource = fs.readFileSync('apps/web/src/app/router.tsx', 'utf8');
for (const route of coverage.ui_routes)
  if (!routerSource.includes(`path: '${route}'`)) errors.push(`UI route missing: ${route}`);

const stateFile = process.env.AIWS_CONTEXT_STATE_FILE || path.join('.ai-workspace', 'data', 'state.json');
if (fs.existsSync(stateFile)) {
  const live = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (Number(live.schema_version) === 20) auditMaterializedState(live, errors);
}

if (errors.length) {
  console.error(`V2.0 coverage gate failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(`V2.0 coverage gate passed (${sources.length} source collections, ${coverage.rest.length} REST contracts)`);

function auditMaterializedState(live, output) {
  for (const collection of sources) {
    for (const record of live[collection] || []) {
      const sourceId = contextSourceRecordId(collection, record);
      const node = live.context_nodes?.find(
        (item) => item.source_collection === collection && String(item.source_id) === sourceId
      );
      if (!node) output.push(`live state source missing node: ${collection}:${sourceId}`);
      else if (node.status !== 'tombstone' && !node.current_version_id)
        output.push(`live state source lacks current document: ${collection}:${sourceId}`);
    }
  }
}

function sameSet(left, right) {
  return left.length === right?.length && left.every((item) => right.includes(item));
}
