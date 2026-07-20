import { HttpError } from './http.mjs';
import { assertProjectAccess, assertScopes } from './mcp-client-service.mjs';
import { executeRegistryOperation } from './api-route-registry.mjs';
import { readState } from './state.mjs';
import { maskSecretsDeep } from '../../../packages/shared/index.mjs';
import { assertProjectRead, assertProjectWrite } from './project-governance-v19.mjs';

const terminalStatuses = new Set(['completed', 'completed_with_failures', 'succeeded', 'failed', 'cancelled', 'canceled', 'stopped', 'exited', 'interrupted', 'applied', 'rejected', 'stale', 'superseded']);
const operationCollections = [
  'assist_operations', 'assist_turns', 'node_runs', 'terminal_sessions', 'test_tasks', 'import_jobs',
  'workflow_generations', 'deliveries', 'workflow_migration_batches', 'workflow_migration_jobs',
  'change_proposals', 'runtime_approvals'
];

export async function getMcpOperation(operationId, client) {
  const state = await readState(), found = findOperation(state, operationId);
  if (!found) throw new HttpError(404, { error: 'mcp_operation_handle_not_found', operation_id: operationId });
  assertProjectAccess(client, found.item.project_id || null);
  assertOperationMembership(state, client, found.item.project_id, 'read');
  return publicOperation(found.collection, found.item);
}

export async function waitForMcpOperation(operationId, { timeout_ms = 30_000, poll_ms = 150 } = {}, client) {
  const requestedTimeout = timeout_ms == null ? 30_000 : Number(timeout_ms);
  const timeout = Math.min(Math.max(Number.isFinite(requestedTimeout) ? requestedTimeout : 30_000, 0), 30_000), poll = Math.min(Math.max(Number(poll_ms) || 150, 50), 2000), started = Date.now();
  while (true) {
    const operation = await getMcpOperation(operationId, client);
    if (operation.terminal || Date.now() - started >= timeout) return { operation, timed_out: !operation.terminal, waited_ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

export async function readMcpOperationEvents(operationId, { cursor = null, limit = 100 } = {}, client) {
  const state = await readState(), found = findOperation(state, operationId);
  if (!found) throw new HttpError(404, { error: 'mcp_operation_handle_not_found', operation_id: operationId });
  assertProjectAccess(client, found.item.project_id || null);
  assertOperationMembership(state, client, found.item.project_id, 'read');
  const related = relatedEvents(state, found.item).sort((a, b) => String(a.created_at || a.updated_at || '').localeCompare(String(b.created_at || b.updated_at || '')) || String(a.id).localeCompare(String(b.id)));
  const offset = decodeCursor(cursor), size = Math.min(Math.max(Number(limit) || 100, 1), 500), items = related.slice(offset, offset + size);
  return { operation: publicOperation(found.collection, found.item), items: maskSecretsDeep(items), cursor: encodeCursor(offset + items.length), has_more: offset + items.length < related.length };
}

export async function cancelMcpOperation(registry, operationId, body, client) {
  const state = await readState(), found = findOperation(state, operationId);
  if (!found) throw new HttpError(404, { error: 'mcp_operation_handle_not_found', operation_id: operationId });
  assertProjectAccess(client, found.item.project_id || null);
  assertOperationMembership(state, client, found.item.project_id, 'write');
  const target = cancelTarget(registry, found.collection);
  if (!target) throw new HttpError(409, { error: 'mcp_operation_not_cancellable', operation_id: operationId, status: found.item.status || null });
  assertScopes(client, target.required_scopes);
  return executeRegistryOperation(registry, target.operation_id, { params: cancelParams(found.collection, found.item), body: { reason: String(body?.reason || 'mcp_cancelled').slice(0, 500) } }, { client });
}

function findOperation(state, id) {
  for (const collection of operationCollections) {
    const item = state[collection]?.find((candidate) => candidate.id === id);
    if (item) return { collection, item };
  }
  return null;
}

function publicOperation(collection, item) {
  return maskSecretsDeep({
    id: item.id, collection, project_id: item.project_id || null, status: item.status || 'unknown', terminal: terminalStatuses.has(String(item.status || '').toLowerCase()),
    created_at: item.created_at || null, updated_at: item.updated_at || null, completed_at: item.completed_at || item.applied_at || item.rejected_at || null,
    error_code: item.error_code || item.error || null, summary: item.summary || item.title || null
  });
}

function relatedEvents(state, item) {
  const ids = new Set([item.id, item.turn_id, item.session_id].filter(Boolean));
  const events = [];
  for (const event of state.workflow_generation_events || []) if (event.generation_id === item.id) events.push({ ...event, source: 'workflow_generation_event' });
  for (const event of state.delivery_events || []) if (event.delivery_id === item.id) events.push({ ...event, source: 'delivery_event' });
  for (const event of state.assist_events || []) if (ids.has(event.id) || ids.has(event.turn_id) || ids.has(event.session_id) || ids.has(event.operation_id)) events.push({ ...event, source: 'assist_event' });
  for (const trace of state.traces || []) {
    const payload = trace.data || trace.payload || {};
    if (ids.has(trace.id) || ids.has(payload.target_id) || ids.has(payload.operation_id) || item.project_id && payload.project_id === item.project_id && String(trace.created_at || '') >= String(item.created_at || '')) events.push({ ...trace, source: 'trace' });
  }
  return events;
}

function cancelTarget(registry, collection) {
  const pattern = ({
    assist_turns: '/assist/v3/turns/:id/stop', node_runs: '/runs/:id/cancel', terminal_sessions: '/assist/v3/terminal-sessions/:id/stop',
    workflow_generations: '/projects/:id/workflow-draft/generations/:generationId/cancel', deliveries: '/deliveries/:id/cancel',
    workflow_migration_batches: '/workflow-migrations/batches/:id/cancel'
  })[collection];
  return pattern ? registry.find((item) => item.pattern === pattern && item.method === 'POST') : null;
}

function cancelParams(collection, item) {
  if (collection === 'workflow_generations') return { id: item.project_id, generationId: item.id };
  return { id: item.id };
}

function encodeCursor(offset) { return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url'); }
function decodeCursor(cursor) { if (!cursor) return 0; try { const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error('invalid'); return value.offset; } catch { throw new HttpError(400, { error: 'mcp_cursor_invalid' }); } }
function assertOperationMembership(state, client, projectId, action) { if (!projectId) return; if (!client.subject_user_id) throw new HttpError(403, { error: 'mcp_subject_user_required' }); return action === 'write' ? assertProjectWrite(state, projectId, client.subject_user_id) : assertProjectRead(state, projectId, client.subject_user_id); }
