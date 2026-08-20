import { IDENTITY_OWNER_TABLES } from './identity-helpers.mjs';

export class ActorService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('identity_core_required');
    this.core = core;
    this.owner = 'Actor';
    this.tables = IDENTITY_OWNER_TABLES.Actor;
  }
  account(principal) { return this.core.account(principal); }
  list(principal, options) { return this.core.actors(principal, options); }
  create(input, principal) { return this.core.createActor(input, principal); }
  update(id, input, principal, commandId) { return this.core.updateActor(id, input, principal, commandId); }
  setStatus(id, status, input, principal) { return this.core.setActorStatus(id, status, input, principal); }
  switch(input) { return this.core.actorSwitch(input); }
}
