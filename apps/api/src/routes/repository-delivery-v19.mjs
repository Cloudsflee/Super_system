import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import {
  approveDeliveryPolicyInState, createRepositoryConnectionInState, revokeDeliveryPolicyInState,
  setTaskRepositoryTargetsInState, setWorkstreamRepositoryTargetsInState
} from '../repository-delivery-domain.mjs';
import { cancelTaskDelivery, deliveryEvents, getDelivery, listDeliveries, retryTaskDelivery, startTaskDelivery } from '../delivery-service.mjs';
import {
  markDeliveryPullRequestReady, mergeDeliveryPullRequest, readDeliveryPullRequest, reconcileDeliveryPullRequest
} from '../delivery-pull-request-service.mjs';
import { testAdapter } from '../test-adapter.mjs';

export const repositoryDeliveryV19Routes = [
  makeRoute('GET', '/projects/:id/repository-connections', listConnections),
  makeRoute('POST', '/projects/:id/repository-connections', createConnection),
  makeRoute('PATCH', '/projects/:projectId/repository-connections/:connectionId', updateConnection),
  makeRoute('DELETE', '/projects/:projectId/repository-connections/:connectionId', disconnectConnection),
  makeRoute('GET', '/workstreams/:id/repository-targets', getWorkstreamTargets),
  makeRoute('PUT', '/workstreams/:id/repository-targets', setWorkstreamTargets),
  makeRoute('GET', '/tasks/:id/repository-targets', getTaskTargets),
  makeRoute('PUT', '/tasks/:id/repository-targets', setTaskTargets),
  makeRoute('GET', '/workstreams/:id/delivery-policies', listPolicies),
  makeRoute('POST', '/workstreams/:id/delivery-policies', approvePolicy),
  makeRoute('POST', '/delivery-policies/:id/revoke', revokePolicy),
  makeRoute('POST', '/tasks/:id/deliveries', createDelivery),
  makeRoute('GET', '/deliveries', listDeliveryRecords),
  makeRoute('GET', '/deliveries/:id', getDeliveryRecord),
  makeRoute('GET', '/deliveries/:id/events', getDeliveryEvents),
  makeRoute('GET', '/deliveries/:id/pull-request', getDeliveryPullRequest),
  makeRoute('POST', '/deliveries/:id/pull-request/ready', readyDeliveryPullRequest),
  makeRoute('POST', '/deliveries/:id/pull-request/merge', mergeDeliveryPullRequestRoute),
  makeRoute('POST', '/deliveries/:id/pull-request/reconcile', reconcileDeliveryPullRequestRoute),
  makeRoute('POST', '/deliveries/:id/cancel', cancelDelivery),
  makeRoute('POST', '/deliveries/:id/retry', retryDelivery)
];

async function listConnections({ res, params }) { const state = await readState(); requireProject(state, params.id); return send(res, 200, { items: state.repository_connections.filter((item) => item.project_id === params.id && item.sync_status !== 'disconnected') }); }
async function createConnection({ res, params, body, query }) { const adapted = testAdapter(body, query); const result = await mutate((state) => { const actor = owner(state), created = createRepositoryConnectionInState(state, params.id, body, actor.id, { allowLocalPath: adapted }); if (!created.idempotent) addTrace(state, 'repository.connection.created', { project_id: params.id, target_id: created.connection.id, summary: `Repository connected: ${created.connection.full_name}` }, actor.id); return created; }); return send(res, result.idempotent ? 200 : 201, result); }
async function updateConnection({ res, params, body }) { const result = await mutate((state) => { const connection = state.repository_connections.find((item) => item.id === params.connectionId && item.project_id === params.projectId); if (!connection) throw new HttpError(404, { error: 'repository_connection_not_found' }); for (const forbidden of ['token', 'access_token', 'secret', 'credential']) if (body[forbidden] != null) throw new HttpError(400, { error: 'repository_plaintext_credential_forbidden', field: forbidden }); if (body.local_path !== undefined) throw new HttpError(400, { error: 'repository_local_path_platform_managed' }); if (body.default_branch !== undefined) connection.default_branch = validRef(body.default_branch); if (body.permissions && typeof body.permissions === 'object') connection.permissions = { ...connection.permissions, ...body.permissions }; connection.updated_at = new Date().toISOString(); return connection; }); return send(res, 200, result); }
async function disconnectConnection({ res, params }) { const result = await mutate((state) => { const connection = state.repository_connections.find((item) => item.id === params.connectionId && item.project_id === params.projectId); if (!connection) throw new HttpError(404, { error: 'repository_connection_not_found' }); const inUse = state.repository_targets.some((item) => item.connection_id === connection.id); if (inUse) throw new HttpError(409, { error: 'repository_connection_in_use' }); Object.assign(connection, { sync_status: 'disconnected', disconnected_at: new Date().toISOString(), updated_at: new Date().toISOString() }); return connection; }); return send(res, 200, result); }

async function getWorkstreamTargets({ res, params }) { const state = await readState(); requireNode(state, params.id, 'workstream'); return send(res, 200, { items: state.repository_targets.filter((item) => item.workstream_id === params.id) }); }
async function setWorkstreamTargets({ res, params, body }) { const result = await mutate((state) => { const actor = owner(state), targets = setWorkstreamRepositoryTargetsInState(state, params.id, body, actor.id); addTrace(state, 'repository.target.updated', { project_id: targets[0]?.project_id, node_id: params.id, target_id: params.id, summary: `Workstream repository targets: ${targets.length}` }, actor.id); return { items: targets }; }); return send(res, 200, result); }
async function getTaskTargets({ res, params }) { const state = await readState(); requireNode(state, params.id, 'task'); return send(res, 200, { items: state.repository_targets.filter((item) => item.task_id === params.id) }); }
async function setTaskTargets({ res, params, body }) { const result = await mutate((state) => { const actor = owner(state), targets = setTaskRepositoryTargetsInState(state, params.id, body, actor.id); addTrace(state, 'repository.target.updated', { project_id: targets[0]?.project_id, node_id: params.id, target_id: params.id, summary: `Task repository targets: ${targets.length}` }, actor.id); return { items: targets }; }); return send(res, 200, result); }

async function listPolicies({ res, params }) { const state = await readState(); requireNode(state, params.id, 'workstream'); return send(res, 200, { items: state.delivery_policies.filter((item) => item.workstream_id === params.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) }); }
async function approvePolicy({ res, params, body }) { const result = await mutate((state) => { const actor = owner(state), policy = approveDeliveryPolicyInState(state, params.id, body, actor.id); addTrace(state, 'delivery.policy.approved', { project_id: policy.project_id, node_id: policy.workstream_id, target_id: policy.id, summary: 'Delivery Policy approved.' }, actor.id); return policy; }); return send(res, 201, result); }
async function revokePolicy({ res, params }) { const result = await mutate((state) => revokeDeliveryPolicyInState(state, params.id, owner(state).id)); return send(res, 200, result); }

async function createDelivery({ res, params, body, query }) { const state = await readState(), actor = owner(state); const result = await startTaskDelivery(params.id, { ...body, adapter: body.adapter || query.adapter }, actor?.id); return send(res, result.idempotent ? 200 : 202, deliveryHandle(result.delivery, result.idempotent)); }
async function listDeliveryRecords({ res, query }) { return send(res, 200, { items: await listDeliveries(query) }); }
async function getDeliveryRecord({ res, params }) { return send(res, 200, await getDelivery(params.id)); }
async function getDeliveryPullRequest({ res, params }) { const state = await readState(), actor = owner(state); return send(res, 200, await readDeliveryPullRequest(params.id, actor?.id)); }
async function readyDeliveryPullRequest({ res, params, body }) { const state = await readState(), actor = owner(state); return send(res, 200, await markDeliveryPullRequestReady(params.id, body, actor?.id)); }
async function mergeDeliveryPullRequestRoute({ res, params, body }) { const state = await readState(), actor = owner(state); return send(res, 200, await mergeDeliveryPullRequest(params.id, body, actor?.id)); }
async function reconcileDeliveryPullRequestRoute({ res, params }) { const state = await readState(), actor = owner(state); return send(res, 200, await reconcileDeliveryPullRequest(params.id, actor?.id)); }
async function cancelDelivery({ res, params }) { const state = await readState(), actor = owner(state); return send(res, 202, deliveryHandle(await cancelTaskDelivery(params.id, actor?.id))); }
async function retryDelivery({ res, params, body, query }) { const state = await readState(), actor = owner(state); const result = await retryTaskDelivery(params.id, { ...body, adapter: body.adapter || query.adapter }, actor?.id); return send(res, 202, deliveryHandle(result.delivery, result.idempotent)); }
async function getDeliveryEvents({ req, res, params, query }) {
  const after = Math.max(0, Number(query.after || req.headers['last-event-id'] || 0) || 0);
  if (query.format === 'json') return send(res, 200, await deliveryEvents(params.id, after));
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let cursor = after, closed = false, timer;
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); if (!res.writableEnded) res.end(); };
  req.on?.('close', close);
  const poll = async () => { if (closed) return; try { const batch = await deliveryEvents(params.id, cursor); for (const event of batch.events) { cursor = event.sequence; res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } if (batch.terminal) { res.write(`event: snapshot\ndata: ${JSON.stringify(batch.delivery)}\n\n`); return close(); } timer = setTimeout(poll, 300); timer.unref?.(); } catch (error) { res.write(`event: error\ndata: ${JSON.stringify(error?.payload || { error: 'delivery_events_failed' })}\n\n`); close(); } };
  await poll();
}

function deliveryHandle(delivery, idempotent = false) { return { operation: delivery, delivery, idempotent, events_url: `/deliveries/${delivery.id}/events`, cancel_url: `/deliveries/${delivery.id}/cancel`, retry_url: `/deliveries/${delivery.id}/retry` }; }
function requireProject(state, projectId) { const project = state.projects.find((item) => item.id === projectId && !item.deleted_at); if (!project) throw new HttpError(404, { error: 'project_not_found' }); return project; }
function requireNode(state, nodeId, role) { const node = state.workflow_nodes.find((item) => item.id === nodeId && item.role === role && !item.legacy_read_only); if (!node) throw new HttpError(404, { error: `${role}_not_found` }); return node; }
function validRef(value) { const ref = String(value || '').trim(); if (!/^[A-Za-z0-9._/-]{1,240}$/.test(ref)) throw new HttpError(400, { error: 'repository_default_branch_invalid' }); return ref; }
