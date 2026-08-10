import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'setup',
  dependencies: ['platform', 'identity'],
  tables: ['credential_refs', 'setup_states', 'codex_profiles', 'github_app_configs', 'github_installations'],
  commands: [
    'integration.codex.probe', 'integration.github.probe',
    'credential.create', 'credential.rotate', 'credential.revoke', 'credential.delete',
    'codex_profile.create', 'codex_profile.update',
    'github_app.create', 'github_installation.create'
  ],
  events: [
    'credential.created', 'credential.rotated', 'credential.revoked', 'credential.deleted',
    'codex_profile.created', 'codex_profile.updated', 'github_app.created',
    'github_installation.selected', 'integration.probed'
  ]
});
