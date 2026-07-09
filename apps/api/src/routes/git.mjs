import { makeRoute } from '../http.mjs';
import { bindRepo, captureDiff, createBranch } from '../handlers/git-basic.mjs';
import { commitRun } from '../handlers/git-commit.mjs';

export const gitRoutes = [
  makeRoute('POST', '/projects/:id/git-repositories', bindRepo),
  makeRoute('POST', '/runs/:id/git/branch', createBranch),
  makeRoute('POST', '/runs/:id/git/diff', captureDiff),
  makeRoute('POST', '/runs/:id/git/commit', commitRun)
];
