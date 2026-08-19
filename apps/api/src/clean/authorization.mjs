import { PlatformError } from './platform-error.mjs';

export const TEAM_ROLES = Object.freeze(['owner', 'admin', 'member', 'observer']);
export const PROJECT_ROLES = Object.freeze(['owner', 'admin', 'editor', 'runner', 'reviewer', 'viewer']);

const ROLE_ACTIONS = Object.freeze({
  owner: new Set(['read', 'write', 'run', 'approve', 'manage', 'member.manage', 'acl.manage', 'credential.manage']),
  admin: new Set(['read', 'write', 'run', 'approve', 'manage', 'member.manage', 'acl.manage', 'credential.manage']),
  editor: new Set(['read', 'write']),
  runner: new Set(['read', 'run']),
  reviewer: new Set(['read', 'approve']),
  viewer: new Set(['read']),
  member: new Set(['read']),
  observer: new Set(['read'])
});

/**
 * Shared authorization predicate used by REST, MCP metadata, replay and
 * adapters.  It is deliberately data-driven so a caller cannot bypass an
 * explicit deny by supplying a broader scope header.
 */
export class AuthorizationService {
  constructor({ db, projectScopeResolver = null, exchangeResolver = null, clientAllowlist = null, clock = () => new Date().toISOString() } = {}) {
    if (!db) throw new TypeError('authorization_database_required');
    this.db = db;
    this.projectScopeResolver = projectScopeResolver;
    this.exchangeResolver = exchangeResolver;
    this.clientAllowlist = clientAllowlist;
    this.clock = clock;
  }

  authorize(principal, action = 'read', project = null, resource = {}, policyRevision = null) {
    const actorId = String(principal?.effectiveActorId || principal?.actorId || '');
    if (!actorId) return deny('authentication_required', 'active actor proof is required');
    const actor = this.db.get('SELECT id,kind,status,revision FROM actors WHERE id=?', [actorId]);
    if (!actor || actor.status !== 'active') return deny('authentication_required', 'active actor proof is required');
    const projectId = project == null ? (principal?.projectId == null ? null : String(principal.projectId)) : String(project);
    const requestedAction = normalizeAction(action);
    const scopes = new Set(Array.isArray(principal?.scopes) ? principal.scopes.map(String) : []);
    if (scopes.size && !hasScope(scopes, requestedAction)) return deny('scope_denied', 'requested scope is not granted', { action: requestedAction });

    if (projectId == null) {
      // Account/team resources are governed by actor/session scope.  A
      // principal may manage only itself unless it is a system/service actor.
      if (requestedAction === 'read' || requestedAction === 'write') return allow('actor_scope');
      if (actor.kind === 'system') return allow('system');
      const manager = this.db.get("SELECT 1 AS ok FROM team_memberships WHERE actor_id=? AND status='active' AND role IN ('owner','admin') LIMIT 1", [actorId]);
      if (manager) return allow('team_manager');
      return deny('permission_denied', 'project scope is required for this action');
    }

    const resolved = this.#resolveProject(projectId, resource);
    if (resolved === false) return deny('project_denied', 'project reference is outside the clean scope');

    const memberships = this.db.query(`SELECT role,status FROM project_memberships WHERE project_id=? AND actor_id=? ORDER BY id`, [projectId, actorId]);
    const activeMemberships = memberships.filter((row) => row.status === 'active');
    const teamRoles = this.#teamRoles(projectId, actorId, requestedAction, resource);
    const roles = [...activeMemberships.map((row) => row.role), ...teamRoles];
    const roleAllows = roles.some((role) => ROLE_ACTIONS[role]?.has(requestedAction));
    if (!roleAllows && actor.kind !== 'system') return deny('permission_denied', 'actor is not a member of the project');

    const explicit = this.#explicitAcl(projectId, actorId, requestedAction, resource);
    // Explicit deny always wins, including over owner/admin role grants.
    if (explicit.some((entry) => entry.effect === 'deny')) return deny('permission_denied', 'explicit ACL deny', { policy_revision: Number(policyRevision || explicit[0]?.policy_revision || 1) });
    if (explicit.length && !explicit.some((entry) => entry.effect === 'allow')) return deny('permission_denied', 'ACL does not allow action');
    if (explicit.length && explicit.some((entry) => entry.effect === 'allow') && !roleAllows && actor.kind !== 'system') return deny('permission_denied', 'ACL cannot exceed role ceiling');

    const narrowing = this.#exchangeNarrowing(principal, requestedAction, projectId, resource);
    if (!narrowing.allowed) return narrowing;
    const client = this.#clientDecision(principal, projectId, resource);
    if (!client.allowed) return client;
    if (resource?.operationId && !this.#operationOwned(actorId, resource.operationId, projectId)) return deny('permission_denied', 'operation is outside actor ownership');
    return allow('role', { role: roles[0] || null, policy_revision: Number(policyRevision || 1), project_id: projectId });
  }

  assert(principal, action, project, resource, policyRevision) {
    const decision = this.authorize(principal, action, project, resource, policyRevision);
    if (!decision.allowed) throw new PlatformError(decision.code, decision.message, decision.details || {}, decision.code === 'authentication_required' ? 401 : 403);
    return decision;
  }

  #resolveProject(projectId, resource) {
    if (typeof this.projectScopeResolver !== 'function') return false;
    try {
      const result = this.projectScopeResolver(projectId, resource);
      return result === undefined ? true : Boolean(result);
    } catch {
      return false;
    }
  }

  #teamRoles(projectId, actorId, action, resource) {
    const resourceName = String(resource?.resource || resource?.name || '*');
    const rows = this.db.query(`SELECT tm.role FROM team_memberships tm
      JOIN teams t ON t.id=tm.team_id AND t.status='active'
      JOIN project_acl_entries pae ON pae.principal_team_id=tm.team_id
      WHERE pae.project_id=? AND tm.actor_id=? AND tm.status='active' AND pae.effect='allow'
        AND pae.action IN (?, '*') AND pae.resource IN (?, '*')`, [projectId, actorId, action, resourceName]);
    return rows.map((row) => row.role).filter((role) => ROLE_ACTIONS[role]);
  }

  #explicitAcl(projectId, actorId, action, resource) {
    const resourceName = String(resource?.resource || resource?.name || '*');
    return this.db.query(`SELECT effect,policy_revision FROM project_acl_entries
      WHERE project_id=? AND action IN (?, '*')
      AND resource IN (?, '*')
      AND (principal_actor_id=? OR principal_team_id IN (SELECT team_id FROM team_memberships WHERE actor_id=? AND status='active'))
      ORDER BY CASE effect WHEN 'deny' THEN 0 ELSE 1 END, id`, [projectId, action, resourceName, actorId, actorId]);
  }

  #exchangeNarrowing(principal, action, projectId, resource) {
    if (typeof this.exchangeResolver === 'function') {
      const value = this.exchangeResolver({ principal, action, projectId, resource });
      if (value && value.allowed === false) return deny(value.code || 'permission_denied', value.message || 'exchange grant narrowed this action', value.details || {});
      return allow('exchange');
    }
    const grants = this.db.query(`SELECT scope_json,expires_at,status FROM exchange_grants
      WHERE target_project_id=? AND (grantee_actor_id=? OR grantee_actor_id IS NULL) AND status='active'`, [projectId, String(principal?.effectiveActorId || principal?.actorId)]);
    if (!grants.length) return allow('no_exchange_narrowing');
    const now = Date.parse(String(this.clock()));
    for (const grant of grants) {
      if (grant.expires_at && Number.isFinite(now) && Date.parse(grant.expires_at) <= now) continue;
      try {
        const scope = JSON.parse(grant.scope_json || '{}');
        const actions = Array.isArray(scope.actions) ? scope.actions.map(String) : null;
        const resources = Array.isArray(scope.resources) ? scope.resources.map(String) : null;
        if ((!actions || actions.includes(action) || actions.includes('*')) && (!resources || resources.includes(String(resource?.resource || '*')) || resources.includes('*'))) return allow('exchange_grant');
      } catch { /* malformed grants narrow access */ }
    }
    return deny('permission_denied', 'exchange grant does not cover requested action');
  }

  #clientDecision(principal, projectId, resource) {
    if (typeof this.clientAllowlist === 'function') {
      const result = this.clientAllowlist({ principal, projectId, resource });
      if (result === false || result?.allowed === false) return deny('permission_denied', 'client allowlist denied the resource');
    }
    return allow('client_allowlist');
  }

  #operationOwned(actorId, operationId, projectId) {
    const row = this.db.get('SELECT actor_id,project_id FROM operations WHERE id=?', [String(operationId)]);
    return Boolean(row && row.actor_id === actorId && (projectId == null || row.project_id == null || row.project_id === String(projectId)));
  }
}

export function authorize(principal, action, project, resource, policyRevision, options = {}) {
  if (!options.db) throw new TypeError('authorization_database_required');
  return new AuthorizationService(options).authorize(principal, action, project, resource, policyRevision);
}

function normalizeAction(action) {
  const value = String(action || 'read');
  if (value.endsWith(':read')) return 'read';
  if (value.endsWith(':write')) return 'write';
  if (value.endsWith(':run')) return 'run';
  if (value.endsWith(':approve')) return 'approve';
  if (value.includes('member') || value.includes('membership')) return 'member.manage';
  if (value.includes('acl') || value.includes('permission')) return 'acl.manage';
  if (value.includes('credential') || value.includes('profile')) return 'credential.manage';
  if (['read', 'write', 'run', 'approve', 'manage', 'member.manage', 'acl.manage', 'credential.manage'].includes(value)) return value;
  return value;
}

function hasScope(scopes, action) {
  if (scopes.has('*') || scopes.has(action)) return true;
  if (action === 'read' && [...scopes].some((scope) => scope.endsWith(':read') || scope === 'operations:control')) return true;
  if (action === 'write' && [...scopes].some((scope) => scope.endsWith(':write'))) return true;
  return false;
}

function allow(reason, details = {}) { return { allowed: true, reason, details }; }
function deny(code, message, details = {}) { return { allowed: false, code, message, details }; }

export { ROLE_ACTIONS };
