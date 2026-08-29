import { IDENTITY_OWNER_TABLES } from './identity-helpers.mjs';

export class CredentialProfileService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('identity_core_required');
    this.core = core;
    this.owner = 'CredentialProfile';
    this.tables = IDENTITY_OWNER_TABLES.CredentialProfile;
  }
  listCredentials(principal) { return this.core.credentials(principal); }
  createCredential(input, principal) { return this.core.createCredential(input, principal); }
  rebind(id, input, principal) { return this.core.rebindCredential(id, input, principal); }
  rotate(id, input, principal) { return this.core.rotateCredential(id, input, principal); }
  revoke(id, input, principal) { return this.core.revokeCredential(id, input, principal); }
  listProfiles(principal) { return this.core.profiles(principal); }
  createProfile(input, principal) { return this.core.createProfile(input, principal); }
  updateProfile(id, input, principal) { return this.core.updateProfile(id, input, principal); }
  disableProfile(id, input, principal) { return this.core.setProfileLifecycle(id, 'disabled', input, principal); }
  enableProfile(id, input, principal) { return this.core.setProfileLifecycle(id, 'enabled', input, principal); }
  probeProfile(id, input, principal) { return this.core.probeProfile(id, input, principal); }
}
