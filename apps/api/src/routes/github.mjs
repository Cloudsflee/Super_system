import { makeRoute } from '../http.mjs';
import { checkRepoAccess, connectToken, disconnect, githubStatus } from '../handlers/github-account.mjs';
import { createPr } from '../handlers/github-pr.mjs';

export const githubRoutes = [
  makeRoute('POST', '/runs/:id/github/pr', createPr),
  makeRoute('POST', '/integrations/github/connect-token', connectToken),
  makeRoute('GET', '/integrations/github/status', githubStatus),
  makeRoute('POST', '/integrations/github/disconnect', disconnect),
  makeRoute('POST', '/integrations/github/check-repo-access', checkRepoAccess)
];
