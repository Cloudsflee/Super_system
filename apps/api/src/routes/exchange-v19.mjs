import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, readState } from '../state.mjs';
import { actorForRequest, assertProjectRead, membershipFor } from '../project-governance-v19.mjs';
import {
  approveExchangeRequestInState,
  createExchangeContextPackInState,
  createExchangeRequestInState,
  expireExchangeRequestInState,
  expireExchangeRequestsInState,
  revokeExchangeInState
} from '../exchange-v19.mjs';

export const exchangeV19Routes = [
  makeRoute('GET', '/projects/:id/exchange-requests', listRequests),
  makeRoute('POST', '/projects/:id/exchange-requests', createRequest),
  makeRoute('GET', '/projects/:id/exchanges', listRequests),
  makeRoute('POST', '/projects/:id/exchanges', createRequest),
  makeRoute('GET', '/exchange-requests/:id', getRequest),
  makeRoute('POST', '/exchange-requests/:id/approve', approveRequest),
  makeRoute('POST', '/exchange-requests/:id/approve-source', (ctx) =>
    approveRequest({ ...ctx, body: { ...ctx.body, side: 'source' } })
  ),
  makeRoute('POST', '/exchange-requests/:id/approve-target', (ctx) =>
    approveRequest({ ...ctx, body: { ...ctx.body, side: 'target' } })
  ),
  makeRoute('POST', '/exchange-requests/:id/revoke', revokeRequest),
  makeRoute('POST', '/exchange-requests/:id/context-packs', createContextPack),
  makeRoute('POST', '/exchange-grants/:id/context-packs', createContextPackFromGrant)
];

async function listRequests({ req, res, params }) {
  await mutate((state) => expireExchangeRequestsInState(state));
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor.id);
  return send(res, 200, {
    project_id: params.id,
    requests: state.exchange_requests
      .filter((item) => item.source_project_id === params.id || item.target_project_id === params.id)
      .map((item) => publicExchangeRequest(state, item, actor.id)),
    grants: state.exchange_grants.filter(
      (item) => item.source_project_id === params.id || item.target_project_id === params.id
    )
  });
}
async function getRequest({ req, res, params }) {
  await mutate((state) => expireExchangeRequestInState(state, params.id));
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
    request = state.exchange_requests.find((item) => item.id === params.id);
  if (!request) return send(res, 404, { error: 'exchange_request_not_found' });
  if (
    !membershipFor(state, request.source_project_id, actor.id) &&
    !membershipFor(state, request.target_project_id, actor.id) &&
    state.instance_owner_user_id !== actor.id
  )
    return send(res, 403, { error: 'project_access_denied' });
  return send(res, 200, {
    request: publicExchangeRequest(state, request, actor.id),
    grant: state.exchange_grants.find((item) => item.exchange_request_id === request.id) || null
  });
}
async function createRequest({ req, res, params, body }) {
  if (body.source_project_id && String(body.source_project_id) !== String(params.id))
    throw new HttpError(409, { error: 'exchange_source_project_mismatch', path_project_id: params.id });
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const created = createExchangeRequestInState(state, { ...body, source_project_id: params.id }, actor.id);
    addTrace(
      state,
      'exchange.request.created',
      {
        project_id: created.request.source_project_id,
        target_type: 'exchange_request',
        target_id: created.request.id,
        summary: '创建跨 Project Exchange 请求',
        data: { target_project_id: created.request.target_project_id, snapshot_hash: created.request.snapshot_hash }
      },
      actor.id
    );
    return { ...created, request: publicExchangeRequest(state, created.request, actor.id) };
  });
  return send(res, result.idempotent ? 200 : 201, result);
}
async function approveRequest({ req, res, params, body }) {
  await mutate((state) => expireExchangeRequestInState(state, params.id));
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const approved = approveExchangeRequestInState(state, params.id, body, actor.id);
    addTrace(
      state,
      'exchange.request.approved',
      {
        project_id: approved.request.source_project_id,
        target_type: 'exchange_request',
        target_id: approved.request.id,
        summary: `批准 Exchange：${body.side || 'owner'}`,
        data: { target_project_id: approved.request.target_project_id, grant_id: approved.grant?.id || null }
      },
      actor.id
    );
    return { ...approved, request: publicExchangeRequest(state, approved.request, actor.id) };
  });
  return send(res, 200, result);
}
async function revokeRequest({ req, res, params, body }) {
  await mutate((state) => expireExchangeRequestInState(state, params.id));
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const revoked = revokeExchangeInState(state, params.id, actor.id, body.reason);
    addTrace(
      state,
      'exchange.request.revoked',
      {
        project_id: revoked.request.source_project_id,
        target_type: 'exchange_request',
        target_id: revoked.request.id,
        summary: '撤销 Exchange 请求',
        data: { target_project_id: revoked.request.target_project_id }
      },
      actor.id
    );
    return { ...revoked, request: publicExchangeRequest(state, revoked.request, actor.id) };
  });
  return send(res, 200, result);
}
async function createContextPack({ req, res, params, body }) {
  await mutate((state) => expireExchangeRequestInState(state, params.id));
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      request = state.exchange_requests.find((item) => item.id === params.id),
      grant = state.exchange_grants.find(
        (item) => item.exchange_request_id === request?.id && item.status === 'active'
      );
    if (!grant) return { error: 'exchange_grant_not_found' };
    const pack = createExchangeContextPackInState(state, grant.id, actor.id, body);
    addTrace(
      state,
      'exchange.context_pack.created',
      {
        project_id: grant.target_project_id,
        target_type: 'context_pack',
        target_id: pack.id,
        summary: '注入 External Context Pack',
        data: { exchange_grant_id: grant.id, snapshot_hash: grant.snapshot_hash }
      },
      actor.id
    );
    return { context_pack: pack, grant };
  });
  return result.error ? send(res, 409, result) : send(res, 201, result);
}
async function createContextPackFromGrant({ req, res, params, body }) {
  await mutate((state) => {
    const grant = state.exchange_grants.find((item) => item.id === params.id);
    return expireExchangeRequestInState(state, grant?.exchange_request_id);
  });
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      grant = state.exchange_grants.find((item) => item.id === params.id);
    const pack = createExchangeContextPackInState(state, params.id, actor.id, body);
    addTrace(
      state,
      'exchange.context_pack.created',
      {
        project_id: grant.target_project_id,
        target_type: 'context_pack',
        target_id: pack.id,
        summary: '注入 External Context Pack',
        data: { exchange_grant_id: grant.id, snapshot_hash: grant.snapshot_hash }
      },
      actor.id
    );
    return { context_pack: pack, grant };
  });
  return send(res, 201, result);
}

function publicExchangeRequest(state, request, actorId) {
  if (actorId === state.instance_owner_user_id || membershipFor(state, request.source_project_id, actorId))
    return request;
  const value = structuredClone(request);
  value.items = (value.items || []).map(({ type, id, version_id }) => ({
    type,
    id,
    ...(version_id ? { version_id } : {})
  }));
  value.snapshot = {
    source_project: { id: request.source_project_id },
    root_scope: structuredClone(request.root_scope),
    allowed_depth: request.allowed_depth,
    scope_path: (request.snapshot?.scope_path || []).map(({ type, id }) => ({ type, id })),
    items: value.items,
    captured_at: request.snapshot?.captured_at || null,
    content_withheld_until_context_pack: true
  };
  return value;
}
