import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'setup',
  dependencies: ['platform', 'identity', 'operations'],
  tables: [
    'credential_refs', 'setup_states', 'setup_events', 'codex_profiles', 'codex_discovery_sources',
    'github_app_configs', 'github_installations', 'github_repositories', 'github_webhook_deliveries'
  ],
  commands: [
    'setup.complete',
    'credential.create', 'credential.rotate', 'credential.revoke', 'credential.delete',
    'codex_profile.create', 'codex_profile.update', 'codex_profile.activate', 'codex_profile.probe',
    'codex.device_auth.start', 'codex.discovery.start', 'codex.discovery.import', 'codex.probe',
    'github_app.create', 'github_installation.create', 'github.installations.discover',
    'github.repositories.sync', 'github.probe'
  ],
  events: [
    'setup.completed', 'codex.discovery.scanned',
    'credential.created', 'credential.rotated', 'credential.activated', 'credential.expired',
    'credential.revoked', 'credential.deleted',
    'codex_profile.created', 'codex_profile.updated', 'codex_profile.activated',
    'codex_probe.started', 'codex_probe.finished',
    'github_app.created', 'github_installation.created', 'github_installations.discovered',
    'github_repositories.synced', 'github_probe.finished', 'github.webhook',
    'github.installation.discovered'
  ]
});
