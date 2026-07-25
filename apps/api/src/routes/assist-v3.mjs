import { HttpError, makeRoute, send, sendOneTimeSecret } from '../http.mjs';
import {
  addV3ReviewComment,
  applyV3Review,
  archiveV3Session,
  createAssistBtw,
  createAssistBtwTurn,
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
  restoreDeletedV3Session,
  restoreV3Session,
  retryV3Turn,
  rollbackV3Review,
  stopV3Turn,
  streamAssistBtwEvents,
  streamV3Events,
  applyChangeBatch,
  claimAssistOperation,
  clearAssistGoal,
  confirmAssistOperation,
  deleteAssistBtw,
  deleteAssistConfiguration,
  deleteV3Attachment,
  deleteV3Session,
  getAssistConfiguration,
  getAssistGoal,
  getChangeBatchReview,
  listAssistConfigurations,
  listAssistCapabilities,
  listAssistModels,
  listAssistOperations,
  listAssistReferences,
  respondToAssistUserInput,
  reviseAssistOperation,
  rollbackChangeBatch,
  saveAssistConfiguration,
  serveAttachmentContent,
  setAssistGoal,
  submitAssistOperationResult,
  undoAssistOperation,
  updateAssistConfiguration,
  uploadV3Attachment,
  updateV3Session
} from '../assist-v3-service.mjs';
import { testAdapter } from '../test-adapter.mjs';

export const assistV3Routes = [
  makeRoute('GET', '/assist/v3/capabilities', async ({ res, query }) =>
    send(res, 200, await listAssistCapabilities(query))
  ),
  makeRoute('GET', '/assist/v3/models', async ({ res, query }) =>
    send(res, 200, await listAssistModels(query.profile_id))
  ),
  makeRoute('GET', '/assist/v3/configurations', async ({ res, query }) =>
    send(res, 200, await listAssistConfigurations(query))
  ),
  makeRoute('POST', '/assist/v3/configurations', async ({ res, body }) =>
    send(res, 201, await saveAssistConfiguration(body))
  ),
  makeRoute('GET', '/assist/v3/configurations/:id', async ({ res, params }) =>
    send(res, 200, await getAssistConfiguration(params.id))
  ),
  makeRoute('PATCH', '/assist/v3/configurations/:id', async ({ res, params, body }) =>
    send(res, 200, await updateAssistConfiguration(params.id, body))
  ),
  makeRoute('DELETE', '/assist/v3/configurations/:id', async ({ res, params }) =>
    send(res, 200, await deleteAssistConfiguration(params.id))
  ),
  makeRoute('GET', '/assist/v3/sessions', async ({ res, query }) => send(res, 200, await listV3Sessions(query))),
  makeRoute('POST', '/assist/v3/sessions', async ({ res, body }) => send(res, 201, await createV3Session(body))),
  makeRoute('GET', '/assist/v3/sessions/:id', async ({ res, params }) => send(res, 200, await getV3Session(params.id))),
  makeRoute('PATCH', '/assist/v3/sessions/:id', async ({ res, params, body }) =>
    send(res, 200, await updateV3Session(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/rename', async ({ res, params, body }) =>
    send(res, 200, await updateV3Session(params.id, { title: body.title }))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/pin', async ({ res, params, body }) =>
    send(res, 200, await updateV3Session(params.id, { pinned: body.pinned !== false }))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/archive', async ({ res, params }) =>
    send(res, 200, await archiveV3Session(params.id))
  ),
  makeRoute('DELETE', '/assist/v3/sessions/:id', async ({ res, params }) =>
    send(res, 200, await deleteV3Session(params.id))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/restore', async ({ res, params }) =>
    send(res, 200, await restoreV3Session(params.id))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/restore-deleted', async ({ res, params }) =>
    send(res, 200, await restoreDeletedV3Session(params.id))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/fork', async ({ res, params, body }) =>
    send(res, 201, await forkV3Session(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/btw', async ({ req, res, params, body }) =>
    sendOneTimeSecret(res, 201, await createAssistBtw(params.id, body, { browserId: req.headers['x-aiws-browser-id'] }))
  ),
  makeRoute('POST', '/assist/v3/btw/:id/turns', async ({ req, res, params, body }) =>
    send(res, 202, await createAssistBtwTurn(params.id, body, { accessToken: req.headers['x-aiws-btw-token'] }))
  ),
  makeRoute('GET', '/assist/v3/btw/:id/events', async ({ req, res, params, query }) =>
    streamAssistBtwEvents(req, res, params.id, { token: query.token, after: query.after })
  ),
  makeRoute('DELETE', '/assist/v3/btw/:id', async ({ req, res, params, query }) =>
    send(
      res,
      200,
      await deleteAssistBtw(params.id, { access_token: query.token }, { accessToken: req.headers['x-aiws-btw-token'] })
    )
  ),
  makeRoute('GET', '/assist/v3/sessions/:id/goal', async ({ res, params, query }) =>
    send(res, 200, await getAssistGoal(params.id, { adapted: testAdapter({}, query) }))
  ),
  makeRoute('PUT', '/assist/v3/sessions/:id/goal', async ({ res, params, body, query }) =>
    send(res, 200, await setAssistGoal(params.id, body, { adapted: testAdapter(body, query) }))
  ),
  makeRoute('DELETE', '/assist/v3/sessions/:id/goal', async ({ res, params, query }) =>
    send(res, 200, await clearAssistGoal(params.id, { adapted: testAdapter({}, query) }))
  ),

  makeRoute('POST', '/assist/v3/sessions/:id/turns', async ({ res, params, body }) =>
    send(res, 202, await createV3Turn(params.id, body))
  ),
  makeRoute('GET', '/assist/v3/turns/:id', async ({ res, params }) => send(res, 200, await getV3Turn(params.id))),
  makeRoute('POST', '/assist/v3/turns/:id/retry', async ({ res, params, body }) =>
    send(res, 202, await retryV3Turn(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/stop', async ({ res, params, body }) =>
    send(res, 200, await stopV3Turn(params.id, body.reason))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/actions/:actionId/result', async ({ res, params, body }) =>
    send(res, 200, await recordV3PageActionResult(params.id, params.actionId, body))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/user-input/:itemId/respond', async ({ res, params, body }) =>
    send(res, 200, await respondToAssistUserInput(params.id, params.itemId, body))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/turns/:turnId/retry', retrySessionTurn),
  makeRoute('POST', '/assist/v3/sessions/:id/turns/:turnId/stop', stopSessionTurn),

  makeRoute('POST', '/assist/v3/sessions/:id/follow-ups', async ({ res, params, body }) =>
    send(res, 202, await createV3FollowUp(params.id, body, body.behavior || 'queue'))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/follow-up', async ({ res, params, body }) =>
    send(res, 202, await createV3FollowUp(params.id, body, body.behavior || 'queue'))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/follow-ups/queue', async ({ res, params, body }) =>
    send(res, 202, await createV3FollowUp(params.id, body, 'queue'))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/steer', async ({ res, params, body }) =>
    send(res, 202, await createV3FollowUp(params.id, body, 'steer'))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/interrupt', async ({ res, params, body }) =>
    send(res, 202, await createV3FollowUp(params.id, body, 'interrupt'))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/steer', async ({ res, params, body }) => {
    const turn = await getV3Turn(params.id);
    return send(res, 202, await createV3FollowUp(turn.session_id, body, 'steer'));
  }),
  makeRoute('POST', '/assist/v3/turns/:id/interrupt', async ({ res, params, body }) => {
    const turn = await getV3Turn(params.id);
    return send(res, 202, await createV3FollowUp(turn.session_id, body, 'interrupt'));
  }),

  makeRoute('GET', '/assist/v3/sessions/:id/events', async ({ req, res, params, query }) =>
    streamV3Events(req, res, { sessionId: params.id, after: query.after })
  ),
  makeRoute('GET', '/assist/v3/turns/:id/events', async ({ req, res, params, query }) =>
    streamV3Events(req, res, { turnId: params.id, after: query.after })
  ),

  makeRoute('GET', '/assist/v3/sessions/:id/attachments', async ({ res, params, query }) =>
    send(res, 200, await listV3Attachments(params.id, query))
  ),
  makeRoute('POST', '/assist/v3/sessions/:id/attachments', async ({ res, params, body }) =>
    send(res, 201, await createV3Attachment(params.id, body))
  ),
  makeRoute(
    'POST',
    '/assist/v3/sessions/:id/attachments/upload',
    async ({ req, res, params }) => send(res, 201, await uploadV3Attachment(params.id, req)),
    { body: 'stream' }
  ),
  makeRoute('GET', '/assist/v3/sessions/:id/references', async ({ res, params, query }) =>
    send(res, 200, await listAssistReferences(params.id, query))
  ),
  makeRoute('GET', '/assist/v3/attachments/:id/content', async ({ req, res, params }) =>
    serveAttachmentContent(req, res, params.id)
  ),
  makeRoute('GET', '/assist/v3/attachments/:id/download', async ({ req, res, params }) =>
    serveAttachmentContent(req, res, params.id, { download: true })
  ),
  makeRoute('DELETE', '/assist/v3/attachments/:id', async ({ res, params, query }) =>
    send(res, 200, await deleteV3Attachment(params.id, { confirmReferenced: query.confirm_referenced === 'true' }))
  ),

  makeRoute('GET', '/assist/v3/turns/:id/review', async ({ res, params }) =>
    send(res, 200, await getV3Review(params.id))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/review/viewed', async ({ res, params, body }) =>
    send(res, 200, await markV3ReviewViewed(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/review/comments', async ({ res, params, body }) =>
    send(res, 201, await addV3ReviewComment(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/review/request-changes', async ({ res, params, body }) =>
    send(res, 200, await requestV3ReviewChanges(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/review/apply', async ({ res, params, body }) =>
    send(res, 200, await applyV3Review(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/turns/:id/review/rollback', async ({ res, params, body }) =>
    send(res, 200, await rollbackV3Review(params.id, body))
  ),
  makeRoute('GET', '/assist/v3/operations', async ({ res, query }) =>
    send(res, 200, await listAssistOperations(query))
  ),
  makeRoute('POST', '/assist/v3/operations/:id/confirm', async ({ res, params, body }) =>
    send(res, 200, await confirmAssistOperation(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/operations/:id/claim', async ({ res, params, body }) =>
    send(res, 200, await claimAssistOperation(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/operations/:id/result', async ({ res, params, body }) =>
    send(res, 200, await submitAssistOperationResult(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/operations/:id/undo', async ({ res, params, body }) =>
    send(res, 202, await undoAssistOperation(params.id, body))
  ),
  makeRoute('POST', '/assist/v3/operations/:id/revisions', async ({ res, params, body }) =>
    send(res, 202, await reviseAssistOperation(params.id, body))
  ),
  makeRoute('GET', '/assist/v3/change-batches/:id/review', async ({ res, params }) =>
    send(res, 200, await getChangeBatchReview(params.id))
  ),
  makeRoute('POST', '/assist/v3/change-batches/:id/review/apply', async ({ res, params, body }) =>
    send(res, 200, await applyChangeBatch(params.id, body.target_hash, body))
  ),
  makeRoute('POST', '/assist/v3/change-batches/:id/review/rollback', async ({ res, params, body }) =>
    send(res, 200, await rollbackChangeBatch(params.id, body.target_hash || null))
  )
];

async function retrySessionTurn({ res, params, body }) {
  await assertTurnSession(params.id, params.turnId);
  return send(res, 202, await retryV3Turn(params.turnId, body));
}
async function stopSessionTurn({ res, params, body }) {
  await assertTurnSession(params.id, params.turnId);
  return send(res, 200, await stopV3Turn(params.turnId, body.reason));
}
async function assertTurnSession(sessionId, turnId) {
  const turn = await getV3Turn(turnId);
  if (turn.session_id !== sessionId) throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
}
