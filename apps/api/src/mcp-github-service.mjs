import { HttpError } from './http.mjs';
import { connectedGithubAccount, createInstallationToken, githubJson, resolveGithubAppConfig } from './github-service.mjs';
import { assertProjectAccess, assertScopes } from './mcp-client-service.mjs';
import { mutate, owner, readState } from './state.mjs';
import { maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { assertProjectMembership } from './project-governance-v19.mjs';

export async function closeMcpGithubPullRequest(input, client, dependencies = {}) {
  assertScopes(client, ['github:write']);
  const context = await githubContext(input, client);
  const pullNumber = pullNumberFor(context.change, input.pull_number);
  const request = dependencies.githubJson || githubJson;
  const result = await request(`${context.repositoryUrl}/pulls/${pullNumber}`, {
    method: 'PATCH', headers: githubHeaders(context.token), body: JSON.stringify({ state: 'closed' })
  });
  if (result?.state !== 'closed') throw new HttpError(502, { error: 'github_pull_request_close_unconfirmed' });
  await mutate((state) => {
    const change = state.code_changes.find((item) => item.id === context.change.id);
    if (change) Object.assign(change, { pr_state: 'closed', pr_closed_at: now(), updated_at: now() });
  });
  return maskSecretsDeep({ run_id: context.run.id, repository: context.binding.full_name, pull_number: pullNumber, state: 'closed' });
}

export async function deleteMcpGithubBranch(input, client, dependencies = {}) {
  assertScopes(client, ['github:write', 'destructive:execute']);
  const context = await githubContext(input, client);
  const branch = String(input.branch || context.change.work_branch || '');
  if (!branch || branch !== context.change.work_branch || !/^[a-zA-Z0-9._/-]{1,240}$/.test(branch)) throw new HttpError(400, { error: 'github_cleanup_branch_invalid' });
  if (context.change.pr_url && context.change.pr_state !== 'closed') throw new HttpError(409, { error: 'github_pull_request_must_be_closed_first' });
  const request = dependencies.githubJson || githubJson;
  await request(`${context.repositoryUrl}/git/refs/${['heads', ...branch.split('/')].map(encodeURIComponent).join('/')}`, {
    method: 'DELETE', headers: githubHeaders(context.token)
  });
  await mutate((state) => {
    const change = state.code_changes.find((item) => item.id === context.change.id);
    if (change) Object.assign(change, { remote_branch_deleted_at: now(), updated_at: now() });
  });
  return { run_id: context.run.id, repository: context.binding.full_name, branch, deleted: true };
}

async function githubContext(input, client) {
  const state = await readState();
  const run = state.node_runs.find((item) => item.id === String(input.run_id || ''));
  if (!run) throw new HttpError(404, { error: 'run_not_found' });
  assertProjectAccess(client, run.project_id);
  if (!client.subject_user_id) throw new HttpError(403, { error: 'mcp_subject_user_required' });
  assertProjectMembership(state, run.project_id, client.subject_user_id, 'github:write');
  const project = state.projects.find((item) => item.id === run.project_id);
  const change = state.code_changes.find((item) => item.run_id === run.id);
  const binding = state.repository_bindings.find((item) => item.project_id === run.project_id && item.status !== 'removed');
  const account = connectedGithubAccount(state, owner(state)?.id);
  const config = resolveGithubAppConfig(state);
  if (!project || !change) throw new HttpError(404, { error: 'run_code_change_not_found' });
  if (!binding || !account || !config) throw new HttpError(409, { error: 'github_repository_connection_required' });
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(binding.full_name || ''))) throw new HttpError(409, { error: 'github_repository_binding_invalid' });
  const token = await createInstallationToken(config, binding.installation_id);
  return { state, run, project, change, binding, token: token.token, repositoryUrl: `https://api.github.com/repos/${binding.full_name}` };
}

function pullNumberFor(change, requested) {
  const match = String(change.pr_url || '').match(/\/pull\/(\d+)(?:$|[?#])/);
  const recorded = match ? Number(match[1]) : null;
  const value = requested == null ? recorded : Number(requested);
  if (!Number.isSafeInteger(value) || value < 1 || recorded !== value) throw new HttpError(409, { error: 'github_cleanup_pull_request_mismatch' });
  return value;
}
function githubHeaders(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'aiws-v19-mcp' }; }
