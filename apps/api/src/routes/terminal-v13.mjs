import { makeRoute, send } from '../http.mjs';
import { createTerminalSession, getTerminalSession, listTerminalSessions, stopTerminalSession, terminalCapability } from '../terminal-service.mjs';
import { applyTerminalReview, commentTerminalReview, getTerminalReview, markTerminalReviewViewed, requestTerminalChanges, rollbackTerminalReview } from '../terminal-review-service.mjs';
import { hostBridgeCapability } from '../host-bridge-service.mjs';

export const terminalV13Routes = [
  makeRoute('GET', '/assist/v3/terminal-capabilities', async ({ res }) => { const capability = terminalCapability(); capability.windows_bridge = await hostBridgeCapability(); return send(res, 200, capability); }),
  makeRoute('GET', '/assist/v3/terminal-sessions', async ({ res, query }) => send(res, 200, await listTerminalSessions({ projectId: query.project_id, assistSessionId: query.assist_session_id }))),
  makeRoute('POST', '/assist/v3/terminal-sessions', async ({ res, body }) => send(res, 201, await createTerminalSession(body))),
  makeRoute('GET', '/assist/v3/terminal-sessions/:id', async ({ res, params }) => send(res, 200, await getTerminalSession(params.id))),
  makeRoute('POST', '/assist/v3/terminal-sessions/:id/stop', async ({ res, params }) => send(res, 200, await stopTerminalSession(params.id))),
  makeRoute('GET', '/assist/v3/terminal-sessions/:id/review', async ({ res, params }) => send(res, 200, await getTerminalReview(params.id))),
  makeRoute('POST', '/assist/v3/terminal-sessions/:id/review/viewed', async ({ res, params, body }) => send(res, 200, await markTerminalReviewViewed(params.id, body))),
  makeRoute('POST', '/assist/v3/terminal-sessions/:id/review/comments', async ({ res, params, body }) => send(res, 201, await commentTerminalReview(params.id, body))),
  makeRoute('POST', '/assist/v3/terminal-sessions/:id/review/request-changes', async ({ res, params, body }) => send(res, 200, await requestTerminalChanges(params.id, body))),
  makeRoute('POST', '/assist/v3/terminal-sessions/:id/review/apply', async ({ res, params, body }) => send(res, 200, await applyTerminalReview(params.id, body))),
  makeRoute('POST', '/assist/v3/terminal-sessions/:id/review/rollback', async ({ res, params, body }) => send(res, 200, await rollbackTerminalReview(params.id, body)))
];
