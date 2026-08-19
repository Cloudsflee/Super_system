import { CLEAN_V2_SCHEMAS } from '@aiws/contracts/clean-v2';

const entries = [
  {
    command_id: 'operations.get',
    version: 2,
    method: 'GET',
    path: '/api/v2/operations/{id}',
    owner: 'Operations',
    scope: 'operations:read',
    project_scoped: true,
    idempotency: 'forbidden',
    expected_revision: 'none',
    input_schema: 'operation.id.v2',
    output_schema: 'operation.receipt.v2',
    long_running: false,
    events: ['operation.*'],
    mcp: { mapping: 'resource', name: 'operation_get' },
    redaction_policy: 'v3-clean-default',
    external_adapter: null,
    ui_metadata: { surface: 'operations', state: 'receipt' },
    evidence_metadata: { receipt_kind: 'operation.receipt.v2', verification: 'p1-platform' }
  },
  {
    command_id: 'operations.events',
    version: 2,
    method: 'GET',
    path: '/api/v2/operations/{id}/events',
    owner: 'Operations',
    scope: 'operations:read',
    project_scoped: true,
    idempotency: 'forbidden',
    expected_revision: 'none',
    input_schema: 'operation.events.query.v2',
    output_schema: 'event.replay.v2',
    long_running: false,
    events: ['operation.*'],
    mcp: { mapping: 'resource', name: 'operation_events' },
    redaction_policy: 'v3-clean-default',
    external_adapter: null,
    ui_metadata: { surface: 'operations', state: 'event-replay' },
    evidence_metadata: { receipt_kind: 'event.replay.v2', verification: 'p1-platform' }
  },
  {
    command_id: 'operations.cancel',
    version: 2,
    method: 'POST',
    path: '/api/v2/operations/{id}/cancel',
    owner: 'Operations',
    scope: 'operations:control',
    project_scoped: true,
    idempotency: 'required',
    expected_revision: 'operation',
    input_schema: 'operation.cancel.v2',
    output_schema: 'operation.receipt.v2',
    long_running: true,
    events: ['operation.cancel_requested', 'operation.cancelled'],
    mcp: { mapping: 'tool', name: 'operation_cancel' },
    redaction_policy: 'v3-clean-default',
    external_adapter: null,
    ui_metadata: { surface: 'operations', state: 'cancel' },
    evidence_metadata: { receipt_kind: 'operation.receipt.v2', verification: 'p1-platform' }
  },
  ...identityEntries(),
  ...p3Entries()
];

function identityEntries() {
  const common = (command_id, method, path, owner, scope, input_schema, output_schema, events, options = {}) => ({
    command_id, version: 2, method, path, owner, scope,
    project_scoped: Boolean(options.project_scoped),
    idempotency: method === 'GET' ? 'forbidden' : 'required',
    expected_revision: method === 'GET' ? 'none' : (options.expected_revision || 'resource'),
    input_schema, output_schema, long_running: Boolean(options.long_running), events,
    mcp: { mapping: method === 'GET' ? 'resource' : 'tool', name: command_id.replaceAll('.', '_') },
    redaction_policy: 'v3-clean-default', external_adapter: options.external_adapter || null,
    ui_metadata: { surface: options.surface || 'identity', state: options.state || command_id },
    evidence_metadata: { receipt_kind: options.long_running ? 'operation.receipt.v2' : 'resource.receipt.v2', verification: 'p2-identity-acl' }
  });
  return [
    common('setup.get', 'GET', '/api/v2/setup', 'Setup', 'identity:read', 'setup.query.v2', 'setup.state.v2', ['setup.state.read'], { surface: 'setup', state: 'state' }),
    common('setup.complete', 'POST', '/api/v2/setup', 'Identity', 'identity:write', 'setup.complete.v2', 'setup.receipt.v2', ['setup.completed', 'actor.created', 'team.created', 'team.membership.granted', 'session.created'], { surface: 'setup', state: 'complete', expected_revision: 'parent' }),
    common('account.get', 'GET', '/api/v2/account', 'Identity', 'identity:read', 'account.query.v2', 'actor.receipt.v2', ['actor.*'], { surface: 'account', state: 'read' }),
    common('account.update', 'PATCH', '/api/v2/account', 'Identity', 'identity:write', 'account.update.v2', 'actor.receipt.v2', ['actor.updated'], { surface: 'account', state: 'update' }),
    common('actor.list', 'GET', '/api/v2/actors', 'Identity', 'identity:read', 'actor.list.v2', 'actor.list.v2', ['actor.*'], { surface: 'actors', state: 'list' }),
    common('actor.create', 'POST', '/api/v2/actors', 'Identity', 'identity:write', 'actor.create.v2', 'actor.receipt.v2', ['actor.created'], { surface: 'actors', state: 'create', expected_revision: 'parent' }),
    common('actor.update', 'PATCH', '/api/v2/actors/{id}', 'Identity', 'identity:write', 'actor.update.v2', 'actor.receipt.v2', ['actor.updated'], { surface: 'actors', state: 'update' }),
    common('actor.suspend', 'POST', '/api/v2/actors/{id}/suspend', 'Identity', 'identity:write', 'actor.lifecycle.v2', 'actor.receipt.v2', ['actor.suspended'], { surface: 'actors', state: 'suspend' }),
    common('actor.activate', 'POST', '/api/v2/actors/{id}/activate', 'Identity', 'identity:write', 'actor.lifecycle.v2', 'actor.receipt.v2', ['actor.activated'], { surface: 'actors', state: 'activate' }),
    common('actor.revoke', 'POST', '/api/v2/actors/{id}/revoke', 'Identity', 'identity:write', 'actor.lifecycle.v2', 'actor.receipt.v2', ['actor.revoked'], { surface: 'actors', state: 'revoke' }),
    common('actor.switch', 'POST', '/api/v2/sessions/{id}/switch', 'Identity', 'identity:write', 'actor.switch.v2', 'actor.receipt.v2', ['actor.switched'], { surface: 'account', state: 'switch' }),
    common('session.list', 'GET', '/api/v2/sessions', 'Identity', 'identity:read', 'session.list.v2', 'session.list.v2', ['session.*'], { surface: 'sessions', state: 'list' }),
    common('session.create', 'POST', '/api/v2/sessions', 'Identity', 'identity:write', 'session.create.v2', 'session.receipt.v2', ['session.created'], { surface: 'sessions', state: 'create', expected_revision: 'parent' }),
    common('session.revoke', 'POST', '/api/v2/sessions/{id}/revoke', 'Identity', 'identity:write', 'session.lifecycle.v2', 'session.receipt.v2', ['session.revoked'], { surface: 'sessions', state: 'revoke' }),
    common('team.list', 'GET', '/api/v2/teams', 'Identity', 'team:read', 'team.list.v2', 'team.list.v2', ['team.*'], { surface: 'teams', state: 'list' }),
    common('team.create', 'POST', '/api/v2/teams', 'Identity', 'team:write', 'team.create.v2', 'team.receipt.v2', ['team.created', 'team.membership.granted'], { surface: 'teams', state: 'create', expected_revision: 'parent' }),
    common('team.get', 'GET', '/api/v2/teams/{id}', 'Identity', 'team:read', 'team.id.v2', 'team.receipt.v2', ['team.*'], { surface: 'teams', state: 'read' }),
    common('team.status', 'PATCH', '/api/v2/teams/{id}', 'Identity', 'team:write', 'team.lifecycle.v2', 'team.receipt.v2', ['team.*'], { surface: 'teams', state: 'status' }),
    common('team.members.list', 'GET', '/api/v2/teams/{id}/memberships', 'Identity', 'team:read', 'membership.list.v2', 'membership.list.v2', ['team.membership.*'], { surface: 'members', state: 'list' }),
    common('team.member.grant', 'POST', '/api/v2/teams/{id}/memberships', 'Identity', 'team:write', 'membership.grant.v2', 'membership.receipt.v2', ['team.membership.granted'], { surface: 'members', state: 'grant', expected_revision: 'parent' }),
    common('team.member.status', 'PATCH', '/api/v2/teams/{id}/memberships/{membership_id}', 'Identity', 'team:write', 'membership.status.v2', 'membership.receipt.v2', ['team.membership.*'], { surface: 'members', state: 'status' }),
    common('project.members.list', 'GET', '/api/v2/projects/{project_id}/members', 'Identity', 'project:read', 'membership.list.v2', 'membership.list.v2', ['membership.*'], { surface: 'members', state: 'list', project_scoped: true }),
    common('membership.grant', 'POST', '/api/v2/projects/{project_id}/members', 'Identity', 'project:write', 'membership.grant.v2', 'membership.receipt.v2', ['membership.granted'], { surface: 'members', state: 'grant', project_scoped: true, expected_revision: 'parent' }),
    common('membership.status', 'PATCH', '/api/v2/projects/{project_id}/members/{membership_id}', 'Identity', 'project:write', 'membership.status.v2', 'membership.receipt.v2', ['membership.*'], { surface: 'members', state: 'status', project_scoped: true }),
    common('project.invitations.list', 'GET', '/api/v2/projects/{project_id}/invitations', 'Identity', 'project:read', 'invitation.list.v2', 'invitation.list.v2', ['invitation.*'], { surface: 'members', state: 'invitations', project_scoped: true }),
    common('invitation.create', 'POST', '/api/v2/projects/{project_id}/invitations', 'Identity', 'project:write', 'invitation.create.v2', 'invitation.receipt.v2', ['invitation.created'], { surface: 'members', state: 'invite', project_scoped: true, expected_revision: 'parent' }),
    common('invitation.accept', 'POST', '/api/v2/projects/{project_id}/invitations/{invitation_id}/accept', 'Identity', 'project:write', 'invitation.lifecycle.v2', 'invitation.receipt.v2', ['invitation.accepted', 'membership.granted'], { surface: 'members', state: 'accept', project_scoped: true }),
    common('invitation.revoke', 'POST', '/api/v2/projects/{project_id}/invitations/{invitation_id}/revoke', 'Identity', 'project:write', 'invitation.lifecycle.v2', 'invitation.receipt.v2', ['invitation.revoked'], { surface: 'members', state: 'revoke', project_scoped: true }),
    common('project.permissions.list', 'GET', '/api/v2/projects/{project_id}/permissions', 'Identity', 'project:read', 'acl.list.v2', 'acl.list.v2', ['acl.*'], { surface: 'permissions', state: 'list', project_scoped: true }),
    common('acl.set', 'POST', '/api/v2/projects/{project_id}/permissions', 'Identity', 'project:write', 'acl.set.v2', 'acl.receipt.v2', ['acl.allowed', 'acl.denied', 'acl.policy.updated'], { surface: 'permissions', state: 'set', project_scoped: true, expected_revision: 'parent' }),
    common('credential.list', 'GET', '/api/v2/credentials', 'Setup', 'credential:read', 'credential.list.v2', 'credential.list.v2', ['credential.*'], { surface: 'credentials', state: 'list' }),
    common('credential.create', 'POST', '/api/v2/credentials', 'Setup', 'credential:write', 'credential.create.v2', 'credential.receipt.v2', ['credential.created'], { surface: 'credentials', state: 'create', expected_revision: 'parent' }),
    common('credential.rebind', 'POST', '/api/v2/credentials/{id}/rebind', 'Setup', 'credential:write', 'credential.rebind.v2', 'operation.receipt.v2', ['credential.rebind.queued', 'credential.rebound', 'credential.failed'], { surface: 'credentials', state: 'rebind', long_running: true }),
    common('credential.rotate', 'POST', '/api/v2/credentials/{id}/rotate', 'Setup', 'credential:write', 'credential.rotate.v2', 'operation.receipt.v2', ['credential.rotate.queued', 'credential.rotated', 'credential.failed'], { surface: 'credentials', state: 'rotate', long_running: true }),
    common('credential.revoke', 'POST', '/api/v2/credentials/{id}/revoke', 'Setup', 'credential:write', 'credential.lifecycle.v2', 'credential.receipt.v2', ['credential.revoked'], { surface: 'credentials', state: 'revoke' }),
    common('profile.list', 'GET', '/api/v2/profiles', 'Setup', 'credential:read', 'profile.list.v2', 'profile.list.v2', ['profile.*'], { surface: 'profiles', state: 'list' }),
    common('profile.create', 'POST', '/api/v2/profiles', 'Setup', 'credential:write', 'profile.create.v2', 'profile.receipt.v2', ['profile.created'], { surface: 'profiles', state: 'create', expected_revision: 'parent' }),
    common('profile.probe', 'POST', '/api/v2/profiles/{id}/probe', 'Setup', 'credential:write', 'profile.probe.v2', 'operation.receipt.v2', ['profile.probe.queued', 'profile.probed', 'profile.probe.failed'], { surface: 'profiles', state: 'probe', long_running: true })
  ];
}

function p3Entries() {
  const common = (command_id, method, path, owner, scope, input_schema, output_schema, events, options = {}) => ({
    command_id, version: 2, method, path, owner, scope, phase: 'p3',
    project_scoped: options.project_scoped !== false,
    idempotency: method === 'GET' ? 'forbidden' : 'required',
    expected_revision: method === 'GET' ? 'none' : (options.expected_revision || 'resource'),
    input_schema, output_schema, long_running: Boolean(options.long_running), events,
    mcp: { mapping: method === 'GET' ? 'resource' : 'tool', name: command_id.replaceAll('.', '_') },
    redaction_policy: 'v3-clean-default', external_adapter: options.external_adapter || null,
    ui_metadata: { surface: options.surface || 'project', state: options.state || command_id },
    evidence_metadata: { receipt_kind: options.long_running ? 'operation.receipt.v2' : 'resource.receipt.v2', verification: 'p3-project-workflow' }
  });
  return [
    common('project.list', 'GET', '/api/v2/projects', 'Project', 'project:read', 'account.query.v2', 'project.list.v2', ['project.*'], { project_scoped: false, surface: 'projects', state: 'list' }),
    common('project.create', 'POST', '/api/v2/projects', 'Project', 'project:write', 'project.create.v2', 'project.receipt.v2', ['project.created', 'intake.created', 'brief.created', 'project.workflow_initialized'], { project_scoped: false, expected_revision: 'parent', surface: 'projects', state: 'create' }),
    common('project.get', 'GET', '/api/v2/projects/{id}', 'Project', 'project:read', 'project.id.v2', 'project.get.v2', ['project.*'], { surface: 'projects', state: 'detail' }),
    common('project.update', 'PATCH', '/api/v2/projects/{id}', 'Project', 'project:write', 'project.update.v2', 'project.receipt.v2', ['project.updated'], { surface: 'projects', state: 'edit' }),
    common('project.archive', 'POST', '/api/v2/projects/{id}/archive', 'Project', 'project:write', 'project.lifecycle.v2', 'project.receipt.v2', ['project.archived'], { surface: 'projects', state: 'archive' }),
    common('project.restore', 'POST', '/api/v2/projects/{id}/restore', 'Project', 'project:write', 'project.lifecycle.v2', 'project.receipt.v2', ['project.restored'], { surface: 'projects', state: 'restore' }),
    common('intake.get', 'GET', '/api/v2/projects/{project_id}/intake', 'Project', 'project:read', 'project.id.v2', 'intake.receipt.v2', ['intake.*'], { surface: 'intake', state: 'detail' }),
    common('intake.submit', 'POST', '/api/v2/projects/{project_id}/intake', 'Project', 'project:write', 'intake.submit.v2', 'operation.receipt.v2', ['intake.submitted', 'intake.ready', 'intake.source_drift', 'intake.failed'], { long_running: true, external_adapter: 'repository.fixture', surface: 'intake', state: 'processing' }),
    common('intake.retry', 'POST', '/api/v2/projects/{project_id}/intake/retry', 'Project', 'project:write', 'intake.lifecycle.v2', 'operation.receipt.v2', ['intake.submitted', 'intake.ready', 'intake.source_drift', 'intake.failed'], { long_running: true, external_adapter: 'repository.fixture', surface: 'intake', state: 'retry' }),
    common('intake.cancel', 'POST', '/api/v2/projects/{project_id}/intake/cancel', 'Project', 'project:write', 'intake.lifecycle.v2', 'intake.receipt.v2', ['intake.cancelled'], { surface: 'intake', state: 'cancel' }),
    common('brief.list', 'GET', '/api/v2/projects/{project_id}/briefs', 'Project', 'project:read', 'project.id.v2', 'brief.list.v2', ['brief.*'], { surface: 'brief', state: 'list' }),
    common('brief.create', 'POST', '/api/v2/projects/{project_id}/briefs', 'Project', 'project:write', 'brief.create.v2', 'brief.receipt.v2', ['brief.revised', 'brief.revision.created', 'project.brief_updated'], { surface: 'brief', state: 'edit' }),
    common('brief.get', 'GET', '/api/v2/projects/{project_id}/briefs/{revision}', 'Project', 'project:read', 'brief.preview.v2', 'brief.receipt.v2', ['brief.*'], { surface: 'brief', state: 'detail' }),
    common('brief.confirm', 'POST', '/api/v2/projects/{project_id}/briefs/{revision}/confirm', 'Project', 'project:approve', 'brief.confirm.v2', 'brief.receipt.v2', ['brief.confirmed', 'project.confirmed'], { surface: 'brief', state: 'confirm' }),
    common('brief.preview', 'GET', '/api/v2/projects/{project_id}/briefs/{revision}/preview', 'Project', 'project:read', 'brief.preview.v2', 'brief.receipt.v2', ['brief.*'], { surface: 'brief', state: 'preview' }),
    common('repository.connection.list', 'GET', '/api/v2/projects/{project_id}/repository-connections', 'Repository', 'repository:read', 'project.id.v2', 'repository.connection.list.v2', ['repository.*'], { surface: 'repository', state: 'connections' }),
    common('repository.connection.create', 'POST', '/api/v2/projects/{project_id}/repository-connections', 'Repository', 'repository:write', 'repository.connection.create.v2', 'repository.connection.receipt.v2', ['repository.connection.created', 'repository.target.created', 'repository.line.created'], { expected_revision: 'parent', external_adapter: 'repository.fixture', surface: 'repository', state: 'connect' }),
    common('repository.connection.update', 'PATCH', '/api/v2/repository-connections/{id}', 'Repository', 'repository:write', 'repository.connection.update.v2', 'repository.connection.receipt.v2', ['repository.connection.updated'], { surface: 'repository', state: 'connection-edit' }),
    common('repository.target.list', 'GET', '/api/v2/repository-connections/{id}/targets', 'Repository', 'repository:read', 'project.id.v2', 'repository.target.list.v2', ['repository.*'], { surface: 'repository', state: 'targets' }),
    common('repository.target.create', 'POST', '/api/v2/repository-connections/{id}/targets', 'Repository', 'repository:write', 'repository.target.create.v2', 'repository.target.receipt.v2', ['repository.target.created'], { expected_revision: 'parent', surface: 'repository', state: 'target-create' }),
    common('repository.line.list', 'GET', '/api/v2/projects/{project_id}/repository-lines', 'Repository', 'repository:read', 'project.id.v2', 'repository.line.list.v2', ['repository.*'], { surface: 'repository', state: 'lines' }),
    common('repository.line.reconcile', 'POST', '/api/v2/repository-lines/{id}/reconcile', 'Repository', 'repository:write', 'repository.line.reconcile.v2', 'repository.line.receipt.v2', ['repository.line.reconciled', 'repository.line.drifted'], { external_adapter: 'repository.fixture', surface: 'repository', state: 'reconcile' }),
    common('repository.workspace.list', 'GET', '/api/v2/projects/{project_id}/repository-workspaces', 'Repository', 'repository:read', 'project.id.v2', 'repository.workspace.list.v2', ['workspace.*'], { surface: 'repository', state: 'workspaces' }),
    common('repository.workspace.create', 'POST', '/api/v2/projects/{project_id}/repository-workspaces', 'Repository', 'repository:write', 'repository.workspace.create.v2', 'repository.workspace.receipt.v2', ['workspace.created'], { expected_revision: 'parent', surface: 'repository', state: 'workspace-create' }),
    common('repository.workspace.refresh', 'POST', '/api/v2/repository-workspaces/{id}/refresh', 'Repository', 'repository:write', 'repository.workspace.lifecycle.v2', 'repository.workspace.receipt.v2', ['workspace.refreshed'], { surface: 'repository', state: 'refresh' }),
    common('repository.workspace.lock', 'POST', '/api/v2/repository-workspaces/{id}/lock', 'Repository', 'repository:write', 'repository.workspace.lifecycle.v2', 'repository.workspace.receipt.v2', ['workspace.locked'], { surface: 'repository', state: 'lock' }),
    common('repository.workspace.release', 'POST', '/api/v2/repository-workspaces/{id}/release', 'Repository', 'repository:write', 'repository.workspace.lifecycle.v2', 'repository.workspace.receipt.v2', ['workspace.released'], { surface: 'repository', state: 'release' }),
    common('workflow.list', 'GET', '/api/v2/projects/{project_id}/workflows', 'Workflow', 'workflow:read', 'project.id.v2', 'workflow.list.v2', ['workflow.*'], { surface: 'workflow', state: 'list' }),
    common('workflow.get', 'GET', '/api/v2/projects/{project_id}/workflow-draft', 'Workflow', 'workflow:read', 'project.id.v2', 'workflow.receipt.v2', ['workflow.*'], { surface: 'workflow', state: 'draft' }),
    common('workflow.revise', 'POST', '/api/v2/projects/{project_id}/workflow-draft', 'Workflow', 'workflow:write', 'workflow.revise.v2', 'workflow.receipt.v2', ['workflow.revised', 'workflow.revision.created', 'workflow.node.created', 'workflow.contract.created'], { surface: 'workflow', state: 'edit' }),
    common('workflow.generation.list', 'GET', '/api/v2/projects/{project_id}/workflow-generations', 'Workflow', 'workflow:read', 'project.id.v2', 'generation.list.v2', ['generation.*'], { surface: 'workflow', state: 'generations' }),
    common('generation.start', 'POST', '/api/v2/projects/{project_id}/workflow-generations', 'Workflow', 'workflow:run', 'generation.start.v2', 'operation.receipt.v2', ['generation.queued', 'generation.running', 'generation.critic_pending', 'generation.failed'], { long_running: true, external_adapter: 'workflow.fake-generator', surface: 'workflow', state: 'generating' }),
    common('workflow.generation.get', 'GET', '/api/v2/workflow-generations/{id}', 'Workflow', 'workflow:read', 'project.id.v2', 'generation.receipt.v2', ['generation.*'], { surface: 'workflow', state: 'generation-detail' }),
    common('generation.retry', 'POST', '/api/v2/workflow-generations/{id}/retry', 'Workflow', 'workflow:run', 'generation.lifecycle.v2', 'operation.receipt.v2', ['generation.queued', 'generation.running', 'generation.critic_pending', 'generation.failed'], { long_running: true, external_adapter: 'workflow.fake-generator', surface: 'workflow', state: 'generation-retry' }),
    common('generation.cancel', 'POST', '/api/v2/workflow-generations/{id}/cancel', 'Workflow', 'workflow:run', 'generation.lifecycle.v2', 'generation.receipt.v2', ['generation.cancelled'], { surface: 'workflow', state: 'generation-cancel' }),
    common('critic.evaluate', 'POST', '/api/v2/workflow-generations/{id}/critic', 'Critic', 'workflow:approve', 'critic.evaluate.v2', 'critic.receipt.v2', ['critic.evaluated'], { external_adapter: 'workflow.fake-critic', surface: 'workflow', state: 'critic' }),
    common('workflow.proposal.get', 'GET', '/api/v2/workflow-proposals/{id}', 'Workflow', 'workflow:read', 'project.id.v2', 'proposal.receipt.v2', ['workflow.*'], { surface: 'workflow', state: 'proposal' }),
    common('workflow.proposal.apply', 'POST', '/api/v2/workflow-proposals/{id}/apply', 'Workflow', 'workflow:write', 'proposal.apply.v2', 'proposal.receipt.v2', ['workflow.proposal.applied'], { surface: 'workflow', state: 'proposal-apply' }),
    common('outcome.requirement.list', 'GET', '/api/v2/projects/{project_id}/outcome-requirements', 'Project', 'project:read', 'project.id.v2', 'outcome.requirement.list.v2', ['outcome.*'], { surface: 'workflow', state: 'requirements' }),
    common('outcome.requirement.create', 'POST', '/api/v2/projects/{project_id}/outcome-requirements', 'Project', 'project:write', 'outcome.requirement.create.v2', 'outcome.requirement.receipt.v2', ['outcome.requirement.created'], { expected_revision: 'parent', surface: 'workflow', state: 'requirement-create' })
  ];
}

export const CLEAN_COMMAND_REGISTRY = Object.freeze(entries.map((entry) => Object.freeze({
  ...entry,
  phase: entry.phase || 'p2',
  pattern: entry.path,
  required_scopes: Object.freeze([entry.scope]),
  mcp: Object.freeze({ ...entry.mcp }),
  events: Object.freeze([...entry.events]),
  ui_metadata: Object.freeze({ ...entry.ui_metadata }),
  evidence_metadata: Object.freeze({ ...entry.evidence_metadata })
})));

export function createCleanCommandRegistry(options = {}) {
  validateRegistry(CLEAN_COMMAND_REGISTRY);
  const includeP3 = options.phase === 'p3' || options.cleanPhase === 'p3' || Number(options.targetVersion || 0) >= 3;
  const selected = includeP3 ? CLEAN_COMMAND_REGISTRY : CLEAN_COMMAND_REGISTRY.filter((entry) => entry.phase !== 'p3');
  return {
    entries: selected,
    get(commandId) { return selected.find((entry) => entry.command_id === commandId) || null; },
    match(method, pathname) {
      const normalized = String(pathname).replace(/\/$/, '') || '/';
      return selected.find((entry) => entry.method === method && matchPattern(entry.path, normalized)) || null;
    },
    inventory() { return selected.map(projectEntry); },
    mcp() { return selected.map((entry) => ({ ...projectEntry(entry), name: entry.mcp.name, mapping: entry.mcp.mapping })); },
    web() { return selected.map((entry) => ({ ...projectEntry(entry), mcp: { ...entry.mcp } })); }
  };
}

export function validateRegistry(registry = CLEAN_COMMAND_REGISTRY) {
  const ids = new Set();
  const paths = new Set();
  for (const entry of registry) {
    for (const field of ['command_id', 'version', 'method', 'path', 'owner', 'scope', 'project_scoped', 'idempotency', 'expected_revision', 'input_schema', 'output_schema', 'long_running', 'events', 'mcp', 'redaction_policy', 'ui_metadata', 'evidence_metadata']) {
      if (entry[field] == null) throw new Error(`registry_field_missing:${field}`);
    }
    if (ids.has(entry.command_id)) throw new Error(`registry_duplicate_command:${entry.command_id}`);
    ids.add(entry.command_id);
    const routeKey = `${entry.method} ${entry.path}`;
    if (paths.has(routeKey)) throw new Error(`registry_duplicate_route:${routeKey}`);
    paths.add(routeKey);
    if (!/^\/api\/v2\//.test(entry.path)) throw new Error(`registry_non_v2_route:${entry.path}`);
    if (entry.method !== 'GET' && entry.idempotency !== 'required') throw new Error(`registry_mutation_idempotency_missing:${entry.command_id}`);
    if (entry.method !== 'GET' && entry.expected_revision === 'none') throw new Error(`registry_mutation_revision_missing:${entry.command_id}`);
    if (entry.long_running && (!entry.events.length || !entry.output_schema.includes('operation'))) throw new Error(`registry_long_running_mapping_missing:${entry.command_id}`);
    if (!CLEAN_V2_SCHEMAS[entry.input_schema]) throw new Error(`registry_input_schema_missing:${entry.command_id}:${entry.input_schema}`);
    if (!CLEAN_V2_SCHEMAS[entry.output_schema]) throw new Error(`registry_output_schema_missing:${entry.command_id}:${entry.output_schema}`);
    if (!entry.mcp?.name) throw new Error(`registry_mcp_mapping_missing:${entry.command_id}`);
    if (typeof entry.redaction_policy !== 'string' || !entry.redaction_policy) throw new Error(`registry_redaction_policy_missing:${entry.command_id}`);
    if (entry.external_adapter !== null && typeof entry.external_adapter !== 'string') throw new Error(`registry_external_adapter_invalid:${entry.command_id}`);
    if (!entry.ui_metadata || typeof entry.ui_metadata !== 'object') throw new Error(`registry_ui_metadata_missing:${entry.command_id}`);
    if (!entry.evidence_metadata || typeof entry.evidence_metadata !== 'object') throw new Error(`registry_evidence_metadata_missing:${entry.command_id}`);
  }
  return true;
}

function matchPattern(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every((part, index) => part.startsWith('{') && part.endsWith('}') || part === actual[index]);
}

export function routeParams(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  const params = {};
  expected.forEach((part, index) => { if (part.startsWith('{') && part.endsWith('}')) params[part.slice(1, -1)] = decodeURIComponent(actual[index]); });
  return params;
}

export function registryParity(registry = createCleanCommandRegistry()) {
  const rest = registry.inventory();
  const mcp = registry.mcp();
  const web = registry.web();
  const byId = (rows) => new Map(rows.map((row) => [row.command_id, row]));
  const mcpById = byId(mcp);
  const webById = byId(web);
  const mismatches = [];
  for (const entry of rest) {
    const mcpEntry = mcpById.get(entry.command_id);
    const webEntry = webById.get(entry.command_id);
    if (!mcpEntry || !sameContract(entry, mcpEntry) || mcpEntry.external_adapter !== entry.external_adapter) mismatches.push(`${entry.command_id}:mcp`);
    if (!webEntry || !sameContract(entry, webEntry) || webEntry.external_adapter !== entry.external_adapter) mismatches.push(`${entry.command_id}:web`);
  }
  return { valid: mismatches.length === 0, mismatches, rest_count: rest.length, mcp_count: mcp.length, web_count: web.length };
}

function sameContract(left, right) {
  for (const field of ['version', 'method', 'path', 'owner', 'scope', 'project_scoped', 'idempotency', 'expected_revision', 'long_running', 'input_schema', 'output_schema', 'redaction_policy']) {
    if (left[field] !== right[field]) return false;
  }
  return JSON.stringify(left.events) === JSON.stringify(right.events)
    && JSON.stringify(left.ui_metadata) === JSON.stringify(right.ui_metadata)
    && JSON.stringify(left.evidence_metadata) === JSON.stringify(right.evidence_metadata);
}

function projectEntry(entry) {
  return {
    command_id: entry.command_id,
    version: entry.version,
    method: entry.method,
    path: entry.path,
    pattern: entry.pattern,
    owner: entry.owner,
    scope: entry.scope,
    required_scopes: [...entry.required_scopes],
    project_scoped: entry.project_scoped,
    idempotency: entry.idempotency,
    expected_revision: entry.expected_revision,
    input_schema: entry.input_schema,
    output_schema: entry.output_schema,
    long_running: entry.long_running,
    events: [...entry.events],
    redaction_policy: entry.redaction_policy,
    external_adapter: entry.external_adapter,
    ui_metadata: { ...entry.ui_metadata },
    evidence_metadata: { ...entry.evidence_metadata }
  };
}
