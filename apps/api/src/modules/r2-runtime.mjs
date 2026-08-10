import { QueryRegistry } from './query-registry.mjs';
import { RouteRegistry } from './route-registry.mjs';

const ROUTES = Object.freeze([
  { method: 'GET', path: 'account', query: 'account.get' },
  { method: 'PATCH', path: 'account', command: 'account.update' },
  { method: 'GET', path: 'sessions', query: 'sessions.list' },
  { method: 'POST', path: 'sessions', command: 'session.create', responseStatus: 201 },
  { method: 'POST', path: 'sessions/:session_id/revoke', command: 'session.revoke' },

  { method: 'GET', path: 'setup', query: 'setup.get' },
  { method: 'POST', path: 'setup/complete', command: 'setup.complete' },
  { method: 'GET', path: 'setup/events', query: 'setup.events', stream: true },
  { method: 'GET', path: 'credentials', query: 'credentials.list' },
  { method: 'POST', path: 'credentials', command: 'credential.create', responseStatus: 201 },
  { method: 'POST', path: 'credentials/:credential_id/rotate', command: 'credential.rotate' },
  { method: 'POST', path: 'credentials/:credential_id/revoke', command: 'credential.revoke' },
  { method: 'DELETE', path: 'credentials/:credential_id', command: 'credential.delete' },

  { method: 'GET', path: 'profiles/codex', query: 'codex_profiles.list' },
  { method: 'POST', path: 'profiles/codex', command: 'codex_profile.create', responseStatus: 201 },
  { method: 'PATCH', path: 'profiles/codex/:profile_id', command: 'codex_profile.update' },
  { method: 'POST', path: 'profiles/codex/:profile_id/activate', command: 'codex_profile.activate' },
  { method: 'POST', path: 'profiles/codex/:profile_id/probe', command: 'codex_profile.probe', responseStatus: 202 },

  { method: 'GET', path: 'integrations/codex/discovery', query: 'codex_discovery.list' },
  { method: 'POST', path: 'integrations/codex/device-auth', command: 'codex.device_auth.start', responseStatus: 202 },
  { method: 'POST', path: 'integrations/codex/discovery', command: 'codex.discovery.start', responseStatus: 202 },
  { method: 'POST', path: 'integrations/codex/discovery/import', command: 'codex.discovery.import', responseStatus: 201 },
  { method: 'POST', path: 'integrations/codex/probe', command: 'codex.probe', responseStatus: 202 },

  { method: 'GET', path: 'github/apps', query: 'github_apps.list' },
  { method: 'POST', path: 'github/apps', command: 'github_app.create', responseStatus: 201 },
  { method: 'POST', path: 'github/apps/:app_config_id/installations', command: 'github_installation.create', responseStatus: 201 },
  { method: 'POST', path: 'github/apps/:app_config_id/installations/discover', command: 'github.installations.discover', responseStatus: 202 },
  { method: 'GET', path: 'github/installations', query: 'github_installations.list' },
  { method: 'POST', path: 'github/installations/:installation_id/repositories/sync', command: 'github.repositories.sync', responseStatus: 202 },
  { method: 'POST', path: 'integrations/github/probe', command: 'github.probe', responseStatus: 202 },

  { method: 'GET', path: 'operations/:operation_id', query: 'operations.get' },
  { method: 'GET', path: 'operations/:operation_id/events', query: 'operations.events', stream: true },
  { method: 'POST', path: 'operations/:operation_id/cancel', command: 'operation.cancel' }
]);

export const SETUP_GATED_COMMANDS = Object.freeze(new Set([
  'project.create', 'project.update', 'brief.create', 'workflow.create', 'node_contract.create',
  'workflow.generate', 'outcome_requirement.create', 'execution.create', 'execution.start',
  'execution.cancel', 'execution.evidence.resolve', 'outcome.evaluate', 'outcome.waive',
  'delivery.create', 'delivery.merge', 'delivery.retry'
]));

export function createR2Runtime(domain) {
  const queries = new QueryRegistry([
    ['account.get', () => domain.identityService.account()],
    ['sessions.list', () => domain.identityService.listSessions()],
    ['setup.get', () => domain.setupService.setupState()],
    ['setup.events', (input) => domain.setupService.setupEvents(input.after)],
    ['credentials.list', () => domain.setupService.listCredentials()],
    ['codex_profiles.list', () => domain.setupService.listCodexProfiles()],
    ['codex_discovery.list', () => domain.setupService.repository.discoverySources().then((sources) => sources.map(publicDiscoverySource))],
    ['github_apps.list', () => domain.setupService.listGithubApps()],
    ['github_installations.list', () => domain.setupService.repository.githubInstallations()],
    ['operations.get', (input) => domain.operationService.get(input.operation_id)],
    ['operations.events', (input) => domain.operationService.events(input.operation_id, input.after)]
  ]);
  const commands = new Map([
    ['account.update', (input, ctx) => domain.identityService.updateAccount(input, ctx)],
    ['session.create', (input, ctx) => domain.identityService.createSession(input, ctx)],
    ['session.revoke', (input, ctx) => domain.identityService.revokeSession(input.session_id, input, ctx)],
    ['setup.complete', (input, ctx) => domain.setupService.completeSetup(input, ctx)],
    ['credential.create', (input, ctx) => domain.setupService.createCredential(input, ctx)],
    ['credential.rotate', (input, ctx) => domain.setupService.rotateCredential(input.credential_id, input, ctx)],
    ['credential.revoke', (input, ctx) => domain.setupService.revokeCredential(input.credential_id, input, ctx)],
    ['credential.delete', (input, ctx) => domain.setupService.deleteCredential(input.credential_id, input, ctx)],
    ['codex_profile.create', (input, ctx) => domain.setupService.createCodexProfile(input, ctx)],
    ['codex_profile.update', (input, ctx) => domain.setupService.updateCodexProfile(input.profile_id, input, ctx)],
    ['codex_profile.activate', (input, ctx) => domain.setupService.activateCodexProfile(input.profile_id, input, ctx)],
    ['codex_profile.probe', (input, ctx) => domain.probeCodexProfile({ ...input, profile_id: input.profile_id }, ctx)],
    ['codex.device_auth.start', (input, ctx) => domain.startCodexDeviceAuth(input, ctx)],
    ['codex.discovery.start', (input, ctx) => domain.discoverCodex(input, ctx)],
    ['codex.discovery.import', (input, ctx) => domain.importCodexDiscovery(input, ctx)],
    ['codex.probe', (input, ctx) => domain.probeCodexProfile(input, ctx)],
    ['github_app.create', (input, ctx) => domain.setupService.createGithubApp(input, ctx)],
    ['github_installation.create', (input, ctx) => domain.setupService.createGithubInstallation(input.app_config_id, input, ctx)],
    ['github.installations.discover', (input, ctx) => domain.discoverGithubInstallations(input.app_config_id, input, ctx)],
    ['github.repositories.sync', (input, ctx) => domain.syncGithubRepositories(input.installation_id, input, ctx)],
    ['github.probe', (input, ctx) => domain.probeGithubApp(input, ctx)],
    ['operation.cancel', (input) => domain.operationService.cancel(input.operation_id, input)]
  ]);
  return {
    routes: new RouteRegistry(ROUTES),
    queries,
    commands,
    privateCommands: new Set(commands.keys())
  };
}

function publicDiscoverySource(source) {
  if (!source) return null;
  const { source_key: _sourceKey, ...metadata } = source;
  return metadata;
}
