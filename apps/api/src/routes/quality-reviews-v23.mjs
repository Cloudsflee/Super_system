import { HttpError, makeRoute, send } from '../http.mjs';
import { owner } from '../state.mjs';
import { currentActorId } from '../actor-context.mjs';
import {
  cancelQualityReview,
  decideQualityReview,
  getQualityReview,
  getQualityReviewEvents,
  listQualityReviews,
  prepareQualityReview,
  startQualityReview
} from '../quality-review-service.mjs';
import { updateQualityReviewPolicy } from '../quality-review-policy-service.mjs';

export const qualityReviewV23Routes = [
  makeRoute('PUT', '/workflows/:id/quality-review-policy', updatePolicy, { required_scopes: ['project:write'] }),
  makeRoute('GET', '/workflow-executions/:id/quality-reviews/prepare', getPrepare, {
    required_scopes: ['project:read']
  }),
  makeRoute('GET', '/workflow-executions/:id/quality-reviews', getHistory, { required_scopes: ['project:read'] }),
  makeRoute('POST', '/workflow-executions/:id/quality-reviews', start, { required_scopes: ['project:run'] }),
  makeRoute('GET', '/quality-reviews/:id', getOne, { required_scopes: ['project:read'] }),
  makeRoute('GET', '/quality-reviews/:id/events', events, {
    required_scopes: ['project:read'],
    body: 'stream'
  }),
  makeRoute('POST', '/quality-reviews/:id/cancel', cancel, { required_scopes: ['project:run'] }),
  makeRoute('POST', '/quality-reviews/:id/decision', decision, {
    required_scopes: ['project:approve', 'approval:decide']
  })
];

async function updatePolicy({ res, params, body }) {
  const state = await import('../state.mjs').then((module) => module.readState()),
    actorId = currentActorId() || owner(state)?.id;
  if (!actorId) throw new HttpError(401, { error: 'authenticated_actor_required' });
  return send(res, 200, await updateQualityReviewPolicy(params.id, body || {}, actorId));
}

async function getPrepare({ res, params }) {
  return send(res, 200, await prepareQualityReview(params.id));
}

async function getHistory({ res, params }) {
  return send(res, 200, await listQualityReviews(params.id));
}

async function start({ req, res, params, body }) {
  const operationKey = String(
      body.operation_key || body.idempotency_key || req.headers?.['x-idempotency-key'] || ''
    ).trim(),
    state = await import('../state.mjs').then((module) => module.readState()),
    actorId = currentActorId() || owner(state).id,
    result = await startQualityReview(params.id, { ...body, operation_key: operationKey || null }, actorId);
  return send(res, result.idempotent ? 200 : 202, result);
}

async function getOne({ res, params }) {
  return send(res, 200, await getQualityReview(params.id));
}

async function events({ req, res, params, query }) {
  const after = Math.max(0, Number(query.after || req.headers['last-event-id'] || 0) || 0);
  if (query.format === 'json') return send(res, 200, await getQualityReviewEvents(params.id, after));
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let cursor = after,
    closed = false,
    timer;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  };
  req.on?.('close', close);
  const poll = async () => {
    if (closed) return;
    try {
      const snapshot = await getQualityReviewEvents(params.id, cursor);
      for (const event of snapshot.events) {
        cursor = event.sequence;
        res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (snapshot.terminal) {
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot.run)}\n\n`);
        return close();
      }
      timer = setTimeout(poll, 500);
      timer.unref?.();
    } catch (error) {
      res.write(
        `event: error\ndata: ${JSON.stringify(error.payload || { error: 'quality_review_events_failed' })}\n\n`
      );
      close();
    }
  };
  await poll();
}

async function cancel({ res, params }) {
  const state = await import('../state.mjs').then((module) => module.readState()),
    actorId = currentActorId() || owner(state).id,
    result = await cancelQualityReview(params.id, actorId);
  return send(res, 202, result);
}

async function decision({ res, params, body }) {
  const state = await import('../state.mjs').then((module) => module.readState()),
    actorId = currentActorId() || owner(state)?.id;
  if (!actorId) throw new HttpError(401, { error: 'authenticated_actor_required' });
  return send(res, 200, await decideQualityReview(params.id, body || {}, actorId));
}
