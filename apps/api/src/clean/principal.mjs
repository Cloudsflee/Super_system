import { PlatformError } from './platform-error.mjs';

export class PrincipalResolver {
  constructor({ db, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db) throw new TypeError('principal_database_required');
    this.db = db;
    this.bootstrapActorId = String(bootstrapActorId);
  }

  resolve(input = {}) {
    const actorId = String(input.actorId || this.bootstrapActorId);
    const actor = this.db.get('SELECT id,kind,status,revision FROM actors WHERE id=?', [actorId]);
    if (!actor || actor.status !== 'active') throw new PlatformError('authentication_required', 'active actor proof is required', {}, 401);
    return Object.freeze({
      actorId,
      teamId: input.teamId == null ? null : String(input.teamId),
      projectId: input.projectId == null ? null : String(input.projectId),
      scopes: Array.isArray(input.scopes) ? [...new Set(input.scopes.map(String))] : ['operations:read', 'operations:control'],
      policyRevision: Number(input.policyRevision || 1),
      actorRevision: Number(actor.revision)
    });
  }
}
