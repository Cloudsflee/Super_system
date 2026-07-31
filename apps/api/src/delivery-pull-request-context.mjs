import { createInstallationToken, githubJson, resolveGithubAppConfig } from './github-service.mjs';
import { HttpError } from './http.mjs';
import { assertProjectMembership } from './project-governance-v19.mjs';
import { readState } from './state.mjs';

export async function deliveryPullRequestContext(deliveryId, actorId, action, dependencies = {}) {
  const stateReader = dependencies.readState || readState,
    state = await stateReader(),
    { delivery, pullNumber } = requireDelivery(state, deliveryId, actorId, action),
    connection = requireConnection(state, delivery, action),
    access = await installationAccess(state, connection, dependencies);
  assertAccessPermissions(access, action);
  return {
    state,
    delivery,
    connection,
    pullNumber,
    repositoryUrl: `https://api.github.com/repos/${connection.full_name}`,
    token: access.token,
    permissions: access.permissions || {},
    request: dependencies.githubJson || githubJson,
    mergeabilityAttempts: Math.max(1, Math.min(6, Number(dependencies.mergeabilityAttempts || 4))),
    mergeabilityDelayMs: Math.max(0, Math.min(2000, Number(dependencies.mergeabilityDelayMs ?? 500)))
  };
}

function requireDelivery(state, deliveryId, actorId, action) {
  const delivery = state.deliveries?.find((item) => item.id === String(deliveryId || ''));
  if (!delivery) throw new HttpError(404, { error: 'delivery_not_found' });
  assertProjectMembership(state, delivery.project_id, actorId, action);
  if (delivery.pull_request_intent_id)
    throw new HttpError(409, {
      error: 'delivery_pull_request_intent_required',
      pull_request_intent_id: delivery.pull_request_intent_id,
      endpoint: `/pull-request-intents/${delivery.pull_request_intent_id}`
    });
  if (delivery.status !== 'completed')
    throw new HttpError(409, { error: 'delivery_not_completed', status: delivery.status });
  const pullNumber = Number(delivery.pr_number);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
    throw new HttpError(409, { error: 'delivery_pull_request_required' });
  return { delivery, pullNumber };
}

function requireConnection(state, delivery, action) {
  const connection = state.repository_connections?.find(
    (item) => item.id === delivery.connection_id && item.project_id === delivery.project_id
  );
  if (!connection || connection.sync_status !== 'ready')
    throw new HttpError(409, { error: 'repository_connection_required' });
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(connection.full_name || '')))
    throw new HttpError(409, { error: 'github_repository_binding_invalid' });
  if (!connection.installation_id) throw new HttpError(409, { error: 'github_installation_required' });
  if (action === 'github:write' && connection.permissions?.pull_requests === false)
    throw new HttpError(403, { error: 'github_pull_request_write_required' });
  return connection;
}

async function installationAccess(state, connection, dependencies) {
  const resolveConfig = dependencies.resolveGithubAppConfig || resolveGithubAppConfig,
    config = resolveConfig(state);
  if (!config) throw new HttpError(409, { error: 'github_app_config_required' });
  const issueToken = dependencies.createInstallationToken || createInstallationToken;
  return issueToken(config, connection.installation_id);
}

function assertAccessPermissions(access, action) {
  const permissions = access?.permissions || {},
    hasPermissions = Object.keys(permissions).length > 0;
  if (hasPermissions && !['read', 'write'].includes(permissions.pull_requests))
    throw new HttpError(403, { error: 'github_pull_request_read_required' });
  if (action === 'github:write' && hasPermissions && permissions.pull_requests !== 'write')
    throw new HttpError(403, { error: 'github_pull_request_write_required' });
  if (!access?.token) throw new HttpError(502, { error: 'github_installation_token_missing' });
}
