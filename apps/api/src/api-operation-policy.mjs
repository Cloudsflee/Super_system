const SCOPE_RULES = Object.freeze([
  rule((item, domain) => domain === 'context', contextScopes),
  rule(
    (item) => item.pattern === '/projects' && item.method === 'POST',
    () => ['project:create']
  ),
  rule(
    (item) => item.pattern.endsWith('/share') && item.method === 'POST',
    () => ['project:share']
  ),
  rule(
    (item) => item.pattern.endsWith('/project-invitations/:id/accept'),
    () => ['project:read']
  ),
  rule(
    (item) => item.pattern.endsWith('/project-invitations/:id/revoke'),
    () => ['project:share']
  ),
  rule(
    (item) => /\/(?:members|memberships|invitations)(?:\/|$)/.test(item.pattern) && item.method !== 'GET',
    () => ['project:share']
  ),
  rule((item) => /exchange-(?:requests|grants)|\/exchanges(?:$|\/)/.test(item.pattern), exchangeScopes),
  rule((item) => /repository-deletion-intents|\/deletion-intent(?:s)?$/.test(item.pattern), deletionScopes),
  rule(
    (item) => item.pattern.startsWith('/mcp/clients'),
    () => ['mcp:admin']
  ),
  rule(
    (item) => item.pattern.startsWith('/setup') && item.method !== 'GET',
    () => ['setup:admin']
  ),
  rule(
    (item) => /^\/approvals\/:type\/:id\/decision$/.test(item.pattern),
    () => ['approval:decide']
  ),
  rule((item) => /^\/(?:tasks|workstreams)\/:id\/review$/.test(item.pattern), workflowApprovalScopes),
  rule((item) => /^\/task-executions\/:id\/human-approve$/.test(item.pattern), projectApprovalScopes),
  rule((item) => /^\/workflow-executions\/:id\/outcome-waivers/.test(item.pattern), projectApproveScopes),
  rule(
    (item) => /^\/task-executions\/:id\/stages\/:stage\/replay$/.test(item.pattern),
    () => ['project:run']
  ),
  rule(
    (item) => /^\/asset-versions\/:id\/attestations$/.test(item.pattern) && item.method === 'POST',
    assetApprovalScopes
  ),
  rule(
    (item) => /^\/workstreams\/:id\/delivery-policies$/.test(item.pattern) && item.method === 'POST',
    githubApprovalScopes
  ),
  rule((item) => /^\/pull-request-intents\/:id\/(?:approve|execute)$/.test(item.pattern), githubApprovalScopes),
  rule((item, domain) => domain === 'admin', adminScopes)
]);

export function scopesFor(item, domain) {
  const matched = SCOPE_RULES.find((candidate) => candidate.matches(item, domain));
  if (matched) return matched.resolve(item);
  const scopeDomain = { projects: 'project', governance: 'governance' }[domain] || domain,
    scopes = [`${scopeDomain}:${item.method === 'GET' ? 'read' : 'write'}`];
  if (isDestructive(item)) scopes.push('destructive:execute');
  return scopes;
}

export function operationHandle(data) {
  const id = firstNestedValue(data, ['operation', 'turn', 'task', 'run', 'build'], 'id') || valueAt(data, 'id') || null,
    status = firstNestedValue(data, ['operation', 'turn', 'task', 'run'], 'status') || valueAt(data, 'status');
  return {
    type: 'operation',
    id,
    status: status || 'accepted',
    resource_uri: id ? `aiws://operations/${encodeURIComponent(id)}/events` : null,
    data
  };
}

function rule(matches, resolve) {
  return Object.freeze({ matches, resolve });
}

function contextScopes(item) {
  return [item.pattern.endsWith('/rebuild') || item.pattern.endsWith('/status') ? 'context:admin' : 'context:read'];
}

function exchangeScopes(item) {
  return [`exchange:${item.method === 'GET' ? 'read' : 'write'}`];
}

function deletionScopes(item) {
  return [
    item.method === 'GET' ? 'github:read' : 'github:write',
    ...(item.pattern.endsWith('/execute') || item.method === 'DELETE' ? ['destructive:execute'] : [])
  ];
}

function adminScopes(item) {
  return [item.method === 'GET' ? 'setup:read' : 'setup:admin'];
}

function workflowApprovalScopes() {
  return ['workflow:write', 'approval:decide'];
}

function projectApprovalScopes() {
  return ['project:write', 'approval:decide'];
}

function projectApproveScopes() {
  return ['project:approve', 'approval:decide'];
}

function assetApprovalScopes() {
  return ['assets:write', 'approval:decide'];
}

function githubApprovalScopes() {
  return ['github:write', 'approval:decide'];
}

function isDestructive(item) {
  return (
    /\/(?:purge|reset|disconnect)$/.test(item.pattern) ||
    item.pattern === '/projects/:id/trash' ||
    (item.method === 'DELETE' &&
      (item.pattern === '/projects/:id' || /^\/(?:mcp\/clients|codex\/profiles)/.test(item.pattern)))
  );
}

function firstNestedValue(data, keys, field) {
  for (const key of keys) {
    const value = valueAt(valueAt(data, key), field);
    if (value) return value;
  }
  return null;
}

function valueAt(value, key) {
  return value && value[key];
}
