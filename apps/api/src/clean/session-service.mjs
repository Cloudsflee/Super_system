import { IDENTITY_OWNER_TABLES } from './identity-helpers.mjs';

export class SessionService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('identity_core_required');
    this.core = core;
    this.owner = 'Session';
    this.tables = IDENTITY_OWNER_TABLES.Session;
  }
  authenticateProof(proof, options) { return this.core.authenticateProof(proof, options); }
  principalFromRequest(request) { return this.core.principalFromRequest(request); }
  get(id, principal) { return this.core.session(id, principal); }
  list(principal) { return this.core.sessions(principal); }
  create(input) { return this.core.createSession(input); }
  createLocalOwner(input) { return this.core.createLocalOwnerSession(input); }
  revoke(id, input) { return this.core.revokeSession(id, input); }
}
