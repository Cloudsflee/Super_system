import { makeRoute } from '../http.mjs';
import { applyAssistSession, createAssistSession, getAssistSession, rejectAssistSession } from '../handlers/assist-sessions.mjs';

export const assistRoutes = [
  makeRoute('POST', '/assist/sessions', createAssistSession),
  makeRoute('GET', '/assist/sessions/:id', getAssistSession),
  makeRoute('POST', '/assist/sessions/:id/reject', rejectAssistSession),
  makeRoute('POST', '/assist/sessions/:id/apply', applyAssistSession)
];
