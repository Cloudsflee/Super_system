import { makeRoute } from '../http.mjs';
import { createPr } from '../handlers/github-pr.mjs';

export const githubRoutes = [makeRoute('POST', '/runs/:id/github/pr', createPr)];
