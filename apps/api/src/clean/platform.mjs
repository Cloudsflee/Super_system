import { utcNow } from './canonical.mjs';
import { DEFAULT_REDACTION_POLICY } from './redaction.mjs';
import { EventService } from './events.mjs';
import { PrincipalResolver } from './principal.mjs';
import { PlatformError } from './platform-error.mjs';
import { ReceiptService } from './receipts.mjs';

export { PlatformError } from './platform-error.mjs';

export class CleanPlatform {
  constructor({ db, events = null, operations = null, policy = DEFAULT_REDACTION_POLICY, clock = utcNow, bootstrapActorId = 'actor_system_bootstrap', authorize = null, principalResolver = null } = {}) {
    if (!db) throw new TypeError('platform_database_required');
    this.db = db;
    this.policy = policy;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.events = events || new EventService({ db, policy, clock });
    this.receipts = new ReceiptService({ db, policy, clock });
    this.operations = operations || db.__cleanOperations || null;
    this.principalResolver = principalResolver || new PrincipalResolver({ db, bootstrapActorId });
    this.authorize = typeof authorize === 'function' ? authorize : ((context) => context.actorId === this.bootstrapActorId);
  }

  actorContext(input = {}) {
    return this.principalResolver.resolve(input);
  }

  assertAuthorized(context, action = 'read', resource = {}) {
    const normalized = context?.actorId ? context : this.actorContext(context || {});
    if (!normalized.scopes.some((scope) => scope === '*' || scope === action || scope === 'operations:control' || (action.endsWith(':read') && scope.endsWith(':read')))) {
      throw new PlatformError('scope_denied', 'requested scope is not granted', { action }, 403);
    }
    if (!this.authorize({ ...normalized, action, resource })) throw new PlatformError('permission_denied', 'policy denied the requested resource', { action }, 403);
    if (normalized.projectId != null && resource.projectId != null && String(resource.projectId) !== String(normalized.projectId)) throw new PlatformError('project_denied', 'resource is outside the project scope', {}, 403);
    return normalized;
  }

  createReceipt({ id: requestedId = null, kind, payload, status = 'created', casSha256 = null, expiresAt = null } = {}) {
    const manifest = this.receipts.createManifest({ id: requestedId, kind: kind || 'platform.receipt', payload, status, casSha256, expiresAt });
    // Preserve the historical facade shape while the Receipt owner retains
    // the complete persisted CAS and expiry metadata.
    return {
      receipt_id: manifest.receipt_id,
      kind: manifest.kind,
      status: manifest.status,
      payload: manifest.payload,
      payload_sha256: manifest.payload_sha256,
      redactions: manifest.redactions
    };
  }

  receipt(id) {
    const row = this.db.get('SELECT * FROM receipt_manifests WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'receipt not found', {}, 404);
    return { receipt_id: row.id, kind: row.kind, status: row.status, payload: JSON.parse(row.payload_json), payload_sha256: `sha256:${row.payload_sha256}`, cas_sha256: row.cas_sha256 ? `sha256:${row.cas_sha256}` : null, created_at: row.created_at, expires_at: row.expires_at || null };
  }

  redact(value) { return this.policy.redact(value).value; }

}
