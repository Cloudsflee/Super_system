import assert from 'node:assert/strict';
import fs from 'node:fs';
import { apiRoutes } from '../../apps/api/src/api-routes.mjs';
import { createApiRouteRegistry, MCP_MAPPINGS } from '../../apps/api/src/api-route-registry.mjs';
import { MCP_SPECIAL_CAPABILITIES, MCP_TOOL_NAMES } from '../../apps/api/src/mcp-server-factory.mjs';
import { MCP_SCOPES } from '../../apps/api/src/mcp-client-service.mjs';
import { collections } from '../../apps/api/src/config.mjs';
import { missingBaselineItems } from '../../scripts/legacy-baseline-policy.mjs';
import { resolveV18ImpactBase } from '../../scripts/v18-impact.mjs';

const coverage = JSON.parse(fs.readFileSync('tests/v18/coverage-map.json', 'utf8'));
const routeBaseline = JSON.parse(fs.readFileSync(coverage.route_baseline_file, 'utf8'));
const registry = createApiRouteRegistry(apiRoutes);
const routeKeys = registry.map((item) => `${item.method} ${item.pattern}`);
const baselineRouteCount = routeBaseline.routes.length;

assert.equal(resolveV18ImpactBase(undefined, { AIWS_TEST_BASE_SHA: 'remote-main-sha' }), 'remote-main-sha');
assert.equal(resolveV18ImpactBase('cli-sha', { AIWS_TEST_BASE_SHA: 'remote-main-sha' }), 'cli-sha');
assert.equal(resolveV18ImpactBase(undefined, {}), 'HEAD');
assert.equal(baselineRouteCount, coverage.expected_http_routes);
assert.equal(baselineRouteCount - routeBaseline.v18_routes.length, coverage.expected_legacy_http_routes);
assert.equal(new Set(routeBaseline.routes).size, baselineRouteCount);
assert.equal(new Set(routeBaseline.v18_routes).size, routeBaseline.v18_routes.length);
assert.deepEqual(missingBaselineItems(routeBaseline.routes, routeBaseline.v18_routes), []);
assert.deepEqual(missingBaselineItems(routeKeys, routeBaseline.routes), []);
assert.ok(registry.length >= baselineRouteCount);
assert.equal(new Set(routeKeys).size, apiRoutes.length);
assert.equal(new Set(registry.map((item) => item.operation_id)).size, registry.length);
assert.deepEqual(missingBaselineItems(MCP_MAPPINGS, coverage.mappings), []);
assert.deepEqual(missingBaselineItems(MCP_TOOL_NAMES, coverage.tools), []);
assert.deepEqual(missingBaselineItems(collections, coverage.state_collections), []);

const knownScopes = new Set(MCP_SCOPES);
for (const operation of registry) {
  assert.match(operation.operation_id, /^aiws\.[a-z0-9-]+\.(get|post|put|patch|delete)\./);
  assert.equal(typeof operation.handler, 'function');
  assert.equal(MCP_MAPPINGS.includes(operation.mapping), true);
  assert.equal(typeof operation.callable, 'boolean');
  for (const scope of operation.required_scopes) assert.equal(knownScopes.has(scope), true, `${operation.operation_id}: ${scope}`);
  if (operation.mapping === 'resource' || operation.mapping === 'async_adapter') assert.ok(operation.mcp_binding.resource_uri_template);
  if (operation.method !== 'GET' && operation.mapping === 'resource') assert.fail(`${operation.operation_id} maps a write as resource`);
}

const transports = registry.filter((item) => item.pattern === '/mcp');
assert.deepEqual(transports.map((item) => item.method).sort(), ['DELETE', 'GET', 'POST']);
assert.equal(transports.every((item) => item.mapping === 'external_callback' && !item.callable && item.protocol_reason === 'mcp_transport_endpoint'), true);
assert.equal(registry.find((item) => item.pattern === '/github/webhook').mapping, 'external_callback');
assert.equal(registry.filter((item) => item.mapping === 'async_adapter').every((item) => item.pattern.endsWith('/events')), true);

const specialIds = new Set();
for (const capability of MCP_SPECIAL_CAPABILITIES) {
  assert.equal(specialIds.has(capability.operation_id), false, capability.operation_id);
  specialIds.add(capability.operation_id);
  assert.equal(MCP_MAPPINGS.includes(capability.mapping), true);
  for (const scope of capability.required_scopes) assert.equal(knownScopes.has(scope), true, `${capability.operation_id}: ${scope}`);
}
for (const item of coverage.frontend_only) assert.equal(specialIds.has(`aiws.frontend.${item}`), true, item);
for (const websocket of coverage.websockets) {
  if (websocket.id === 'terminal-session-ws') assert.equal(specialIds.has('aiws.terminal.input'), true);
  else assert.equal(specialIds.has('aiws.external.host_bridge_ws'), true);
}

console.log(`V1.8 registry contract passed (${baselineRouteCount} baseline/${registry.length} current routes, ${MCP_SPECIAL_CAPABILITIES.length} special capabilities)`);
