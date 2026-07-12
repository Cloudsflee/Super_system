import { makeRoute, send } from '../http.mjs';
import {
  addV3ReviewComment,
  applyV3Review,
  archiveV3Session,
  createV3Attachment,
  createV3FollowUp,
  createV3Session,
  createV3Turn,
  forkV3Session,
  getV3Review,
  getV3Session,
  getV3Turn,
  listV3Attachments,
  listV3Sessions,
  markV3ReviewViewed,
  requestV3ReviewChanges,
  recordV3PageActionResult,
  restoreV3Session,
  retryV3Turn,
  rollbackV3Review,
  stopV3Turn,
  streamV3Events,
  saveAssistConfiguration,
  updateV3Session
} from '../assist-v3-service.mjs';

export const assistV3Routes = [
  makeRoute('POST', '/assist/v3/configurations', async ({ res, body }) => send(res, 201, await saveAssistConfiguration(body))),
  makeRoute('GET', '/assist/v3/sessions', async ({ res, query }) => send(res, 200, await listV3Sessions(query))),
  makeRoute('POST', '/assist/v3/sessions', async ({ res, body }) => send(res, 201, await createV3Session(body))),
  makeRoute('GET', '/assist/v3/sessions/:id', async ({ res, params }) => send(res, 200, await getV3Session(params.id))),
  makeRoute('PATCH', '/assist/v3/sessions/:id', async ({ res, params, body }) => send(res, 200, await updateV3Session(params.id, body))),
  makeRoute('POST', '/assist/v3/sessions/:id/rename', async ({ res, params, body }) => send(res, 200, await updateV3Session(params.id, { title: body.title }))),
  makeRoute('POST', '/assist/v3/sessions/:id/pin', async ({ res, params, body }) => send(res, 200, await updateV3Session(params.id, { pinned: body.pinned !== false }))),
  makeRoute('POST', '/assist/v3/sessions/:id/archive', async ({ res, params }) => send(res, 200, await archiveV3Session(params.id))),
  makeRoute('DELETE', '/assist/v3/sessions/:id', async ({ res, params }) => send(res, 200, await archiveV3Session(params.id))),
  makeRoute('POST', '/assist/v3/sessions/:id/restore', async ({ res, params }) => send(res, 200, await restoreV3Session(params.id))),
  makeRoute('POST', '/assist/v3/sessions/:id/fork', async ({ res, params, body }) => send(res, 201, await forkV3Session(params.id, body))),

  makeRoute('POST', '/assist/v3/sessions/:id/turns', async ({ res, params, body }) => send(res, 202, await createV3Turn(params.id, body))),
  makeRoute('GET', '/assist/v3/turns/:id', async ({ res, params }) => send(res, 200, await getV3Turn(params.id))),
  makeRoute('POST', '/assist/v3/turns/:id/retry', async ({ res, params, body }) => send(res, 202, await retryV3Turn(params.id, body))),
  makeRoute('POST', '/assist/v3/turns/:id/stop', async ({ res, params, body }) => send(res, 200, await stopV3Turn(params.id, body.reason))),
  makeRoute('POST', '/assist/v3/turns/:id/actions/:actionId/result', async ({ res, params, body }) => send(res, 200, await recordV3PageActionResult(params.id, params.actionId, body))),
  makeRoute('POST', '/assist/v3/sessions/:id/turns/:turnId/retry', async ({ res, params, body }) => send(res, 202, await retryV3Turn(params.turnId, body))),
  makeRoute('POST', '/assist/v3/sessions/:id/turns/:turnId/stop', async ({ res, params, body }) => send(res, 200, await stopV3Turn(params.turnId, body.reason))),

  makeRoute('POST', '/assist/v3/sessions/:id/follow-ups', async ({ res, params, body }) => send(res, 202, await createV3FollowUp(params.id, body, body.behavior || 'queue'))),
  makeRoute('POST', '/assist/v3/sessions/:id/follow-up', async ({ res, params, body }) => send(res, 202, await createV3FollowUp(params.id, body, body.behavior || 'queue'))),
  makeRoute('POST', '/assist/v3/sessions/:id/follow-ups/queue', async ({ res, params, body }) => send(res, 202, await createV3FollowUp(params.id, body, 'queue'))),
  makeRoute('POST', '/assist/v3/sessions/:id/steer', async ({ res, params, body }) => send(res, 202, await createV3FollowUp(params.id, body, 'steer'))),
  makeRoute('POST', '/assist/v3/sessions/:id/interrupt', async ({ res, params, body }) => send(res, 202, await createV3FollowUp(params.id, body, 'interrupt'))),
  makeRoute('POST', '/assist/v3/turns/:id/steer', async ({ res, params, body }) => {
    const turn = await getV3Turn(params.id);
    return send(res, 202, await createV3FollowUp(turn.session_id, body, 'steer'));
  }),
  makeRoute('POST', '/assist/v3/turns/:id/interrupt', async ({ res, params, body }) => {
    const turn = await getV3Turn(params.id);
    return send(res, 202, await createV3FollowUp(turn.session_id, body, 'interrupt'));
  }),

  makeRoute('GET', '/assist/v3/sessions/:id/events', async ({ req, res, params, query }) => streamV3Events(req, res, { sessionId: params.id, after: query.after })),
  makeRoute('GET', '/assist/v3/turns/:id/events', async ({ req, res, params, query }) => streamV3Events(req, res, { turnId: params.id, after: query.after })),

  makeRoute('GET', '/assist/v3/sessions/:id/attachments', async ({ res, params, query }) => send(res, 200, await listV3Attachments(params.id, query))),
  makeRoute('POST', '/assist/v3/sessions/:id/attachments', async ({ res, params, body }) => send(res, 201, await createV3Attachment(params.id, body))),

  makeRoute('GET', '/assist/v3/turns/:id/review', async ({ res, params }) => send(res, 200, await getV3Review(params.id))),
  makeRoute('POST', '/assist/v3/turns/:id/review/viewed', async ({ res, params, body }) => send(res, 200, await markV3ReviewViewed(params.id, body))),
  makeRoute('POST', '/assist/v3/turns/:id/review/comments', async ({ res, params, body }) => send(res, 201, await addV3ReviewComment(params.id, body))),
  makeRoute('POST', '/assist/v3/turns/:id/review/request-changes', async ({ res, params, body }) => send(res, 200, await requestV3ReviewChanges(params.id, body))),
  makeRoute('POST', '/assist/v3/turns/:id/review/apply', async ({ res, params, body }) => send(res, 200, await applyV3Review(params.id, body))),
  makeRoute('POST', '/assist/v3/turns/:id/review/rollback', async ({ res, params, body }) => send(res, 200, await rollbackV3Review(params.id, body)))
];
