export const roleCapabilities = Object.freeze({
  owner: new Set(['read', 'write', 'review', 'run', 'git_commit', 'git_push', 'configure']),
  collaborator: new Set(['read', 'write', 'run', 'git_commit']),
  reviewer: new Set(['read', 'review'])
});

export function roleAllows(role, operation) {
  return Boolean(roleCapabilities[role]?.has(operation));
}

export function githubAllows(permissions = {}, operation) {
  if (operation === 'read' || operation === 'review') return permissions.pull !== false;
  if (operation === 'configure') return permissions.admin === true;
  return permissions.push === true || permissions.admin === true;
}

export function authorizeRepositoryAction({ role, permissions, operation }) {
  const role_allowed = roleAllows(role, operation);
  const github_allowed = githubAllows(permissions, operation);
  return {
    allowed: role_allowed && github_allowed,
    role_allowed,
    github_allowed,
    role,
    operation,
    github_permissions: permissions
  };
}
