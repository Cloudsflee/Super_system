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
  ...p3Entries(),
  ...p4Entries(),
  ...p5Entries(),
  ...p6Entries(),
  ...p7Entries()
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
    common('outcome.requirement.list', 'GET', '/api/v2/projects/{project_id}/outcome-requirements', 'Project', 'project:read', 'project.id.v2', 'outcome.requirement.list.v2', ['outcome.requirement.*'], { surface: 'workflow', state: 'requirements' }),
    common('outcome.requirement.create', 'POST', '/api/v2/projects/{project_id}/outcome-requirements', 'Project', 'project:write', 'outcome.requirement.create.v2', 'outcome.requirement.receipt.v2', ['outcome.requirement.created'], { expected_revision: 'parent', surface: 'workflow', state: 'requirement-create' })
  ];
}

function p4Entries() {
  const common = (command_id, method, path, owner, scope, input_schema, output_schema, events, options = {}) => ({
    command_id, version: 2, method, path, owner, scope, phase: 'p4',
    project_scoped: options.project_scoped !== false,
    idempotency: method === 'GET' ? 'forbidden' : 'required',
    expected_revision: method === 'GET' ? 'none' : (options.expected_revision || 'resource'),
    input_schema, output_schema, long_running: Boolean(options.long_running), events,
    mcp: { mapping: method === 'GET' ? 'resource' : 'tool', name: options.mcp_name || command_id.replaceAll('.', '_') },
    redaction_policy: 'v3-clean-default', external_adapter: null,
    ui_metadata: { surface: options.surface || 'context', state: options.state || command_id },
    evidence_metadata: { receipt_kind: options.long_running ? 'operation.receipt.v2' : 'resource.receipt.v2', verification: 'p4-context-mcp-gateway' }
  });
  return [
    common('context.source.list', 'GET', '/api/v2/projects/{project_id}/context/sources', 'Context', 'context:read', 'context.project.query.v2', 'context.sources.v2', ['context_source.*'], { state: 'sources' }),
    common('context.source.create', 'POST', '/api/v2/projects/{project_id}/context/sources', 'Context', 'context:write', 'context.source.create.v2', 'context.source.receipt.v2', ['context_source.created', 'context_source.updated'], { state: 'source-create' }),
    common('context.map', 'GET', '/api/v2/projects/{project_id}/context/map', 'Context', 'context:read', 'context.project.query.v2', 'context.map.v2', ['context.map.read'], { state: 'map', mcp_name: 'context_map' }),
    common('context.search', 'GET', '/api/v2/projects/{project_id}/context/search', 'Context', 'context:read', 'context.search.query.v2', 'context.search.v2', ['context.*'], { state: 'search', mcp_name: 'context_search' }),
    common('context.read', 'GET', '/api/v2/projects/{project_id}/context/read', 'Context', 'context:read', 'context.read.query.v2', 'context.node.v2', ['context.*'], { state: 'read', mcp_name: 'context_read' }),
    common('context.node.get', 'GET', '/api/v2/projects/{project_id}/context/nodes/{node_id}', 'Context', 'context:read', 'context.node.query.v2', 'context.node.v2', ['context.*'], { state: 'node' }),
    common('context.node.versions', 'GET', '/api/v2/projects/{project_id}/context/nodes/{node_id}/versions', 'Context', 'context:read', 'context.node.query.v2', 'context.versions.v2', ['context.*'], { state: 'versions' }),
    common('context.policy.get', 'GET', '/api/v2/projects/{project_id}/context/policy', 'Context', 'context:read', 'context.project.query.v2', 'context.policy.v2', ['context_policy.*'], { state: 'policy' }),
    common('context.policy.update', 'PATCH', '/api/v2/projects/{project_id}/context/policy', 'Context', 'context:write', 'context.policy.update.v2', 'context.policy.v2', ['context_policy.updated'], { state: 'policy-update' }),
    common('context.selection.list', 'GET', '/api/v2/projects/{project_id}/context/selections', 'Context', 'context:read', 'context.project.query.v2', 'context.selections.v2', ['context_selection.*'], { state: 'selections' }),
    common('context.selection.create', 'POST', '/api/v2/projects/{project_id}/context/selections', 'Context', 'context:read', 'context.selection.create.v2', 'context.selection.receipt.v2', ['context_selection.created'], { state: 'selection-create' }),
    common('context.pack.list', 'GET', '/api/v2/projects/{project_id}/context/packs', 'Context', 'context:read', 'context.project.query.v2', 'context.packs.v2', ['context_pack.*'], { state: 'packs', mcp_name: 'context_packs_list' }),
    common('context.pack.get', 'GET', '/api/v2/projects/{project_id}/context/packs/{pack_id}', 'Context', 'context:read', 'context.pack.query.v2', 'context.pack.v2', ['context_pack.*'], { state: 'pack', mcp_name: 'context_pack_get' }),
    common('context.pack.create', 'POST', '/api/v2/projects/{project_id}/context/packs', 'Context', 'context:read', 'context.pack.create.v2', 'context.pack.receipt.v2', ['context_pack.created'], { state: 'pack-create' }),
    common('context.projection.status', 'GET', '/api/v2/projects/{project_id}/context/status', 'Projection', 'context:read', 'context.project.query.v2', 'context.status.v2', ['context_projection.*'], { state: 'status', mcp_name: 'context_status' }),
    common('context.projection.rebuild', 'POST', '/api/v2/projects/{project_id}/context/rebuild', 'Projection', 'context:write', 'context.rebuild.v2', 'operation.receipt.v2', ['context_projection.queued', 'context_projection.completed', 'context_projection.failed'], { state: 'rebuild', long_running: true, mcp_name: 'context_rebuild' }),
    common('context.projection.jobs', 'GET', '/api/v2/projects/{project_id}/context/jobs', 'Projection', 'context:read', 'context.project.query.v2', 'context.jobs.v2', ['context_projection.*'], { state: 'jobs' }),
    common('context.projection.job', 'GET', '/api/v2/projects/{project_id}/context/jobs/{job_id}', 'Projection', 'context:read', 'context.job.query.v2', 'context.job.v2', ['context_projection.*'], { state: 'job' }),
    common('context.projection.events', 'GET', '/api/v2/projects/{project_id}/context/jobs/{job_id}/events', 'Projection', 'context:read', 'context.events.query.v2', 'event.replay.v2', ['context_projection.*'], { state: 'events' }),
    common('context.projection.cancel', 'POST', '/api/v2/projects/{project_id}/context/jobs/{job_id}/cancel', 'Projection', 'context:write', 'context.job.mutation.v2', 'operation.receipt.v2', ['context_projection.cancelled'], { state: 'cancel', long_running: true }),
    common('context.projection.retry', 'POST', '/api/v2/projects/{project_id}/context/jobs/{job_id}/retry', 'Projection', 'context:write', 'context.job.mutation.v2', 'operation.receipt.v2', ['context_projection.queued'], { state: 'retry', long_running: true }),
    common('mcp.rpc', 'POST', '/api/v2/mcp', 'MCP', 'mcp:call', 'mcp.rpc.v2', 'mcp.rpc.response.v2', ['mcp.tool.called'], { project_scoped: false, mcp_name: 'mcp_rpc' }),
    common('mcp.tools.list', 'GET', '/api/v2/mcp/tools', 'MCP', 'mcp:read', 'mcp.list.query.v2', 'mcp.tools.v2', ['mcp.*'], { project_scoped: false, state: 'tools', mcp_name: 'mcp_tools' }),
    common('mcp.client.list', 'GET', '/api/v2/mcp/clients', 'MCP', 'mcp:read', 'mcp.list.query.v2', 'mcp.clients.v2', ['mcp_client.*'], { project_scoped: false, state: 'clients' }),
    common('mcp.client.create', 'POST', '/api/v2/mcp/clients', 'MCP', 'mcp:write', 'mcp.client.create.v2', 'mcp.client.receipt.v2', ['mcp_client.created'], { project_scoped: false, state: 'client-create' }),
    common('mcp.client.revoke', 'POST', '/api/v2/mcp/clients/{id}/revoke', 'MCP', 'mcp:write', 'mcp.client.mutation.v2', 'mcp.client.receipt.v2', ['mcp_client.revoked'], { project_scoped: false, state: 'client-revoke' }),
    common('exchange.request.list', 'GET', '/api/v2/projects/{project_id}/exchange-requests', 'Exchange', 'exchange:read', 'context.project.query.v2', 'exchange.requests.v2', ['exchange_request.*'], { state: 'requests' }),
    common('exchange.request.create', 'POST', '/api/v2/projects/{project_id}/exchange-requests', 'Exchange', 'exchange:write', 'exchange.request.create.v2', 'exchange.request.receipt.v2', ['exchange_request.created'], { state: 'request-create' }),
    common('exchange.request.approve', 'POST', '/api/v2/exchange-requests/{id}/approve', 'Exchange', 'exchange:approve', 'exchange.approval.v2', 'exchange.approval.receipt.v2', ['exchange_request.approved', 'exchange_grant.created'], { project_scoped: false, state: 'approve' }),
    common('exchange.request.reject', 'POST', '/api/v2/exchange-requests/{id}/reject', 'Exchange', 'exchange:approve', 'exchange.approval.v2', 'exchange.approval.receipt.v2', ['exchange_request.rejected'], { project_scoped: false, state: 'reject' }),
    common('exchange.grant.list', 'GET', '/api/v2/projects/{project_id}/exchange-grants', 'Exchange', 'exchange:read', 'context.project.query.v2', 'exchange.grants.v2', ['exchange_grant.*'], { state: 'grants' }),
    common('exchange.grant.revoke', 'POST', '/api/v2/exchange-grants/{id}/revoke', 'Exchange', 'exchange:approve', 'exchange.grant.mutation.v2', 'exchange.grant.receipt.v2', ['exchange_grant.revoked'], { project_scoped: false, state: 'grant-revoke' }),
    common('exchange.grant.pack.create', 'POST', '/api/v2/exchange-grants/{id}/context-packs', 'Exchange', 'exchange:read', 'exchange.pack.create.v2', 'context.pack.receipt.v2', ['exchange_grant.pack_created'], { project_scoped: false, state: 'grant-pack' }),
    common('gateway.forward', 'POST', '/api/v2/gateway/forward', 'Gateway', 'gateway:forward', 'gateway.forward.v2', 'gateway.forward.receipt.v2', ['gateway.forwarded'], { project_scoped: false, state: 'forward', mcp_name: 'gateway_forward' }),
    common('gateway.receipt.get', 'GET', '/api/v2/gateway/receipts/{id}', 'Gateway', 'gateway:read', 'gateway.receipt.query.v2', 'gateway.receipt.v2', ['gateway.*'], { project_scoped: false, state: 'receipt', mcp_name: 'gateway_receipt' })
  ];
}

function p5Entries() {
  const common = (command_id, method, path, owner, scope, input_schema, output_schema, events, options = {}) => ({
    command_id, version: 2, method, path, owner, scope, phase: 'p5',
    project_scoped: options.project_scoped !== false,
    idempotency: method === 'GET' ? 'forbidden' : 'required',
    expected_revision: method === 'GET' ? 'none' : (options.expected_revision || 'resource'),
    input_schema, output_schema, long_running: Boolean(options.long_running), events,
    mcp: { mapping: options.mcp_exposed === false ? 'rest-only' : (method === 'GET' ? 'resource' : 'tool'), name: options.mcp_name || command_id.replaceAll('.', '_'), exposed: options.mcp_exposed !== false },
    transport_allowlist: Object.freeze(options.transport_allowlist || (options.mcp_exposed === false ? ['rest', 'web'] : ['rest', 'web', 'mcp', 'gateway'])),
    redaction_policy: 'v3-clean-default', external_adapter: options.external_adapter || null,
    ui_metadata: { surface: options.surface || owner.toLowerCase(), state: options.state || command_id },
    evidence_metadata: { receipt_kind: options.long_running ? 'operation.receipt.v2' : 'resource.receipt.v2', verification: 'p5-assist-files-terminal-bridge' }
  });
  return [
    common('assist.session.list', 'GET', '/api/v2/assist/sessions', 'Assist', 'assist:read', 'assist.sessions.query.v2', 'assist.sessions.v2', ['assist_session.*'], { project_scoped: false, surface: 'assist', state: 'sessions' }),
    common('assist.session.create', 'POST', '/api/v2/assist/sessions', 'Assist', 'assist:write', 'assist.session.create.v2', 'assist.session.receipt.v2', ['assist_session.created'], { project_scoped: false, surface: 'assist', state: 'session-create', expected_revision: 'parent', external_adapter: 'codex.app-server.v2' }),
    common('assist.session.get', 'GET', '/api/v2/assist/sessions/{id}', 'Assist', 'assist:read', 'assist.session.query.v2', 'assist.session.v2', ['assist_session.*'], { project_scoped: false, surface: 'assist', state: 'session' }),
    common('assist.turn.create', 'POST', '/api/v2/assist/sessions/{id}/turns', 'Assist', 'assist:run', 'assist.turn.create.v2', 'operation.receipt.v2', ['assist_turn.queued', 'assist_turn.running', 'assist_turn.awaiting_input', 'assist_turn.completed', 'assist_turn.failed'], { project_scoped: false, long_running: true, surface: 'assist', state: 'turn', external_adapter: 'codex.app-server.v2' }),
    common('assist.session.events', 'GET', '/api/v2/assist/sessions/{id}/events', 'Assist', 'assist:read', 'assist.events.query.v2', 'event.replay.v2', ['assist_turn.*', 'assist_message.*'], { project_scoped: false, surface: 'assist', state: 'events' }),
    common('assist.goal.get', 'GET', '/api/v2/assist/sessions/{id}/goal', 'Assist', 'assist:read', 'assist.session.query.v2', 'assist.goal.v2', ['assist_goal.*'], { project_scoped: false, surface: 'assist', state: 'goal' }),
    common('assist.goal.update', 'PATCH', '/api/v2/assist/sessions/{id}/goal', 'Assist', 'assist:write', 'assist.goal.update.v2', 'assist.goal.v2', ['assist_goal.updated'], { project_scoped: false, surface: 'assist', state: 'goal' }),
    common('assist.reference.list', 'GET', '/api/v2/assist/sessions/{id}/references', 'Assist', 'assist:read', 'assist.session.query.v2', 'assist.references.v2', ['assist_reference.*'], { project_scoped: false, surface: 'assist', state: 'references' }),
    common('assist.reference.create', 'POST', '/api/v2/assist/sessions/{id}/references', 'Assist', 'assist:write', 'assist.reference.create.v2', 'assist.references.v2', ['assist_reference.created'], { project_scoped: false, surface: 'assist', state: 'reference-create' }),
    ...['pause', 'resume', 'cancel'].map((action) => common(`assist.session.${action}`, 'POST', `/api/v2/assist/sessions/{id}/${action}`, 'Assist', 'assist:write', 'assist.session.mutation.v2', 'assist.session.receipt.v2', [`assist_session.${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled'}`], { project_scoped: false, surface: 'assist', state: action })),
    common('assist.turn.retry', 'POST', '/api/v2/assist/turns/{id}/retry', 'Assist', 'assist:run', 'assist.turn.mutation.v2', 'operation.receipt.v2', ['assist_turn.queued', 'assist_turn.running', 'assist_turn.completed', 'assist_turn.failed'], { project_scoped: false, long_running: true, surface: 'assist', state: 'retry', external_adapter: 'codex.app-server.v2' }),
    common('assist.turn.cancel', 'POST', '/api/v2/assist/turns/{id}/cancel', 'Assist', 'assist:run', 'assist.turn.mutation.v2', 'assist.turn.receipt.v2', ['assist_turn.cancelled'], { project_scoped: false, surface: 'assist', state: 'turn-cancel' }),
    common('assist.turn.steer', 'POST', '/api/v2/assist/turns/{id}/steer', 'Assist', 'assist:run', 'assist.turn.mutation.v2', 'assist.turn.receipt.v2', ['assist_turn.steered'], { project_scoped: false, surface: 'assist', state: 'steer', external_adapter: 'codex.app-server.v2' }),
    common('assist.turn.interrupt', 'POST', '/api/v2/assist/turns/{id}/interrupt', 'Assist', 'assist:run', 'assist.turn.mutation.v2', 'assist.turn.receipt.v2', ['assist_turn.interrupted'], { project_scoped: false, surface: 'assist', state: 'interrupt', external_adapter: 'codex.app-server.v2' }),
    common('assist.turn.follow-ups', 'POST', '/api/v2/assist/turns/{id}/follow-ups', 'Assist', 'assist:run', 'assist.turn.mutation.v2', 'assist.turn.receipt.v2', ['assist_turn.follow_up'], { project_scoped: false, surface: 'assist', state: 'follow-up', external_adapter: 'codex.app-server.v2' }),

    common('file.list', 'GET', '/api/v2/projects/{project_id}/files', 'Files', 'files:read', 'files.query.v2', 'files.v2', ['file_ref.*'], { surface: 'files', state: 'list' }),
    common('file.get', 'GET', '/api/v2/projects/{project_id}/files/{file_id}', 'Files', 'files:read', 'files.query.v2', 'file.content.v2', ['file_ref.*'], { surface: 'files', state: 'content' }),
    common('attachment.list', 'GET', '/api/v2/projects/{project_id}/attachments', 'Files', 'files:read', 'files.query.v2', 'attachments.v2', ['attachment.*'], { surface: 'assist', state: 'attachments' }),
    common('attachment.create', 'POST', '/api/v2/projects/{project_id}/attachments', 'Files', 'files:write', 'attachment.create.v2', 'attachment.receipt.v2', ['attachment.created', 'attachment.quarantined'], { surface: 'assist', state: 'attachment-create', mcp_exposed: false, expected_revision: 'parent' }),
    common('attachment.content', 'GET', '/api/v2/attachments/{id}/content', 'Files', 'files:read', 'attachment.query.v2', 'attachment.content.v2', ['attachment.*'], { project_scoped: false, surface: 'assist', state: 'attachment-content', mcp_exposed: false }),
    common('attachment.preview', 'GET', '/api/v2/attachments/{id}/preview', 'Files', 'files:read', 'attachment.query.v2', 'attachment.content.v2', ['attachment.*'], { project_scoped: false, surface: 'assist', state: 'attachment-preview', mcp_exposed: false }),
    common('attachment.delete', 'DELETE', '/api/v2/attachments/{id}', 'Files', 'files:write', 'attachment.lifecycle.v2', 'attachment.receipt.v2', ['attachment.deleted'], { project_scoped: false, surface: 'assist', state: 'attachment-delete' }),
    common('change.batch.list', 'GET', '/api/v2/projects/{project_id}/change-batches', 'Files', 'files:read', 'files.query.v2', 'change.batches.v2', ['file_change_batch.*'], { surface: 'files', state: 'batches' }),
    common('change.batch.create', 'POST', '/api/v2/projects/{project_id}/change-batches', 'Files', 'files:write', 'change.batch.create.v2', 'change.batch.receipt.v2', ['file_change_batch.proposed'], { surface: 'files', state: 'batch-create' }),
    common('change.batch.review', 'GET', '/api/v2/change-batches/{id}/review', 'Files', 'files:read', 'change.batch.query.v2', 'change.batch.v2', ['file_change_batch.*'], { project_scoped: false, surface: 'files', state: 'review' }),
    ...['approve', 'apply', 'undo'].map((action) => common(`change.batch.${action}`, 'POST', `/api/v2/change-batches/{id}/${action}`, 'Files', action === 'approve' ? 'files:approve' : 'files:write', 'change.batch.mutation.v2', action === 'approve' ? 'change.batch.receipt.v2' : 'operation.receipt.v2', [`file_change_batch.${action === 'approve' ? 'approved' : action === 'apply' ? 'applied' : 'undone'}`], { project_scoped: false, surface: 'files', state: action, long_running: action !== 'approve' })),

    common('approval.list', 'GET', '/api/v2/approvals', 'Assist', 'assist:approve', 'interaction.query.v2', 'approvals.v2', ['runtime_approval.*'], { project_scoped: false, surface: 'approvals', state: 'list', mcp_exposed: false }),
    common('approval.create', 'POST', '/api/v2/approvals', 'Assist', 'assist:run', 'approval.create.v2', 'approval.receipt.v2', ['runtime_approval.requested'], { project_scoped: false, surface: 'approvals', state: 'create', mcp_exposed: false, expected_revision: 'parent' }),
    common('approval.decide', 'POST', '/api/v2/approvals/{id}/decide', 'Assist', 'assist:approve', 'approval.decide.v2', 'approval.receipt.v2', ['runtime_approval.approved', 'runtime_approval.rejected'], { project_scoped: false, surface: 'approvals', state: 'decide', mcp_exposed: false }),
    common('user.input.list', 'GET', '/api/v2/user-inputs', 'Assist', 'assist:read', 'interaction.query.v2', 'user.inputs.v2', ['runtime_user_input.*'], { project_scoped: false, surface: 'approvals', state: 'input-list', mcp_exposed: false }),
    common('user.input.create', 'POST', '/api/v2/user-inputs', 'Assist', 'assist:run', 'user.input.create.v2', 'user.input.receipt.v2', ['runtime_user_input.requested'], { project_scoped: false, surface: 'approvals', state: 'input-create', mcp_exposed: false, expected_revision: 'parent' }),
    common('user.input.answer', 'POST', '/api/v2/user-inputs/{id}/answer', 'Assist', 'assist:write', 'user.input.answer.v2', 'user.input.receipt.v2', ['runtime_user_input.answered'], { project_scoped: false, surface: 'approvals', state: 'answer', mcp_exposed: false }),
    common('user.input.cancel', 'POST', '/api/v2/user-inputs/{id}/cancel', 'Assist', 'assist:write', 'user.input.lifecycle.v2', 'user.input.receipt.v2', ['runtime_user_input.cancelled'], { project_scoped: false, surface: 'approvals', state: 'input-cancel', mcp_exposed: false }),
    common('proposal.list', 'GET', '/api/v2/proposals', 'Assist', 'assist:read', 'interaction.query.v2', 'proposals.v2', ['semantic_proposal.*'], { project_scoped: false, surface: 'approvals', state: 'proposals' }),
    common('proposal.create', 'POST', '/api/v2/proposals', 'Assist', 'assist:run', 'proposal.create.v2', 'proposal.p5.receipt.v2', ['semantic_proposal.created'], { project_scoped: false, surface: 'approvals', state: 'proposal-create', expected_revision: 'parent' }),
    ...['apply', 'reject', 'undo'].map((action) => common(`proposal.${action}`, 'POST', `/api/v2/proposals/{id}/${action}`, 'Assist', action === 'reject' ? 'assist:approve' : 'assist:write', 'proposal.mutation.p5.v2', 'proposal.p5.receipt.v2', [`semantic_proposal.${action === 'apply' ? 'applied' : action === 'reject' ? 'rejected' : 'undone'}`], { project_scoped: false, surface: 'approvals', state: `proposal-${action}` })),

    common('terminal.capabilities', 'GET', '/api/v2/terminals/capabilities', 'Terminal', 'terminal:read', 'terminal.capabilities.query.v2', 'terminal.capabilities.v2', ['terminal.*'], { project_scoped: false, surface: 'terminal', state: 'capabilities', mcp_exposed: false }),
    common('terminal.list', 'GET', '/api/v2/terminals', 'Terminal', 'terminal:read', 'terminal.query.v2', 'terminals.v2', ['terminal.*'], { project_scoped: false, surface: 'terminal', state: 'list', mcp_exposed: false }),
    common('terminal.open', 'POST', '/api/v2/terminals', 'Terminal', 'terminal:run', 'terminal.open.v2', 'terminal.receipt.v2', ['terminal.opened'], { project_scoped: false, surface: 'terminal', state: 'open', mcp_exposed: false, expected_revision: 'parent', external_adapter: 'node-pty' }),
    common('terminal.get', 'GET', '/api/v2/terminals/{id}', 'Terminal', 'terminal:read', 'terminal.query.v2', 'terminal.v2', ['terminal.*'], { project_scoped: false, surface: 'terminal', state: 'session', mcp_exposed: false }),
    common('terminal.events', 'GET', '/api/v2/terminals/{id}/events', 'Terminal', 'terminal:read', 'terminal.query.v2', 'event.replay.v2', ['terminal.*'], { project_scoped: false, surface: 'terminal', state: 'events', mcp_exposed: false }),
    common('terminal.ws', 'GET', '/api/v2/terminals/{id}/ws', 'Terminal', 'terminal:run', 'terminal.query.v2', 'terminal.v2', ['terminal.*'], { project_scoped: false, surface: 'terminal', state: 'websocket', mcp_exposed: false }),
    ...['resize', 'signal', 'stop'].map((action) => common(`terminal.${action}`, 'POST', `/api/v2/terminals/{id}/${action}`, 'Terminal', 'terminal:run', 'terminal.action.v2', 'terminal.receipt.v2', [`terminal.${action === 'stop' ? 'stopped' : action === 'resize' ? 'resized' : 'signalled'}`], { project_scoped: false, surface: 'terminal', state: action, mcp_exposed: false })),

    common('bridge.device.list', 'GET', '/api/v2/bridge/devices', 'Bridge', 'bridge:read', 'bridge.query.v2', 'bridge.devices.v2', ['bridge_device.*'], { project_scoped: false, surface: 'connections', state: 'bridge-devices', mcp_exposed: false, external_adapter: 'windows-native-bridge' }),
    common('bridge.pair', 'POST', '/api/v2/bridge/pairing', 'Bridge', 'bridge:write', 'bridge.pair.v2', 'bridge.device.receipt.v2', ['bridge_device.paired'], { project_scoped: false, surface: 'connections', state: 'bridge-pair', mcp_exposed: false, expected_revision: 'parent', external_adapter: 'windows-native-bridge' }),
    ...['probe', 'rotate', 'revoke'].map((action) => common(`bridge.device.${action}`, 'POST', `/api/v2/bridge/devices/{id}/${action}`, 'Bridge', action === 'probe' ? 'bridge:read' : 'bridge:write', 'bridge.device.mutation.v2', 'bridge.device.receipt.v2', [`bridge_device.${action === 'probe' ? 'probed' : action === 'rotate' ? 'rotated' : 'revoked'}`], { project_scoped: false, surface: 'connections', state: `bridge-${action}`, mcp_exposed: false, external_adapter: 'windows-native-bridge' })),
    common('bridge.transfer.list', 'GET', '/api/v2/bridge/devices/{id}/transfers', 'Bridge', 'bridge:read', 'bridge.query.v2', 'bridge.transfer.receipt.v2', ['bridge_transfer.*'], { project_scoped: false, surface: 'connections', state: 'bridge-transfers', mcp_exposed: false, external_adapter: 'windows-native-bridge' }),
    common('bridge.transfer.create', 'POST', '/api/v2/bridge/devices/{id}/transfers', 'Bridge', 'bridge:write', 'bridge.transfer.create.v2', 'bridge.transfer.receipt.v2', ['bridge_transfer.verified', 'bridge_transfer.failed'], { project_scoped: false, surface: 'connections', state: 'bridge-transfer', mcp_exposed: false, external_adapter: 'windows-native-bridge' })
  ];
}

function p6Entries() {
  const common = (command_id, method, path, owner, scope, input_schema, output_schema, events, options = {}) => ({
    command_id, version: 2, method, path, owner, scope, phase: 'p6',
    project_scoped: options.project_scoped !== false,
    idempotency: method === 'GET' ? 'forbidden' : 'required',
    expected_revision: method === 'GET' ? 'none' : (options.expected_revision || 'resource'),
    input_schema, output_schema, long_running: Boolean(options.long_running), events,
    mcp: { mapping: options.mcp_exposed === false ? 'rest-only' : (method === 'GET' ? 'resource' : 'tool'), name: options.mcp_name || command_id.replaceAll('.', '_'), exposed: options.mcp_exposed !== false },
    transport_allowlist: Object.freeze(options.transport_allowlist || (options.mcp_exposed === false ? ['rest', 'web'] : ['rest', 'web', 'mcp', 'gateway'])),
    redaction_policy: 'v3-clean-default', external_adapter: options.external_adapter || null,
    ui_metadata: { surface: options.surface || owner.toLowerCase(), state: options.state || command_id },
    evidence_metadata: { receipt_kind: options.long_running ? 'operation.receipt.v2' : 'resource.receipt.v2', verification: 'p6-runner-execution-replay' }
  });
  return [
    common('runner.profile.list', 'GET', '/api/v2/runners/profiles', 'Runner', 'runner:read', 'runner.profile.query.v2', 'runner.profiles.v2', ['runner_profile.*'], { project_scoped: false, surface: 'connections', state: 'runner-profiles' }),
    common('runner.profile.create', 'POST', '/api/v2/runners/profiles', 'Runner', 'runner:write', 'runner.profile.create.v2', 'runner.profile.receipt.v2', ['runner_profile.created'], { project_scoped: false, surface: 'connections', state: 'runner-create', expected_revision: 'parent', mcp_exposed: false }),
    common('runner.profile.get', 'GET', '/api/v2/runners/profiles/{id}', 'Runner', 'runner:read', 'runner.profile.query.v2', 'runner.profile.v2', ['runner_profile.*'], { project_scoped: false, surface: 'connections', state: 'runner-profile' }),
    common('runner.profile.update', 'PATCH', '/api/v2/runners/profiles/{id}', 'Runner', 'runner:write', 'runner.profile.update.v2', 'runner.profile.receipt.v2', ['runner_profile.updated'], { project_scoped: false, surface: 'connections', state: 'runner-update', mcp_exposed: false }),
    common('runner.profile.probe', 'POST', '/api/v2/runners/profiles/{id}/probe', 'Runner', 'runner:write', 'runner.profile.mutation.v2', 'operation.receipt.v2', ['runner_profile.probe_queued', 'runner_profile.probed', 'runner_profile.probe_failed'], { project_scoped: false, surface: 'connections', state: 'runner-probe', long_running: true, mcp_exposed: false, external_adapter: 'runner-adapter.v2' }),
    common('runner.profile.disable', 'POST', '/api/v2/runners/profiles/{id}/disable', 'Runner', 'runner:write', 'runner.profile.mutation.v2', 'runner.profile.receipt.v2', ['runner_profile.disabled'], { project_scoped: false, surface: 'connections', state: 'runner-disable', mcp_exposed: false }),

    common('execution.list', 'GET', '/api/v2/projects/{project_id}/executions', 'Execution', 'execution:read', 'execution.project.query.v2', 'executions.v2', ['execution.*'], { surface: 'execution', state: 'list' }),
    common('execution.create', 'POST', '/api/v2/projects/{project_id}/executions', 'Execution', 'execution:run', 'execution.create.v2', 'execution.receipt.v2', ['execution.created'], { surface: 'execution', state: 'create', expected_revision: 'parent' }),
    common('execution.get', 'GET', '/api/v2/executions/{id}', 'Execution', 'execution:read', 'execution.query.v2', 'execution.v2', ['execution.*'], { project_scoped: false, surface: 'execution', state: 'detail' }),
    common('execution.events', 'GET', '/api/v2/executions/{id}/events', 'Execution', 'execution:read', 'execution.query.v2', 'event.replay.v2', ['execution.*'], { project_scoped: false, surface: 'execution', state: 'events' }),
    common('execution.attempts', 'GET', '/api/v2/executions/{id}/attempts', 'Execution', 'execution:read', 'execution.query.v2', 'execution.attempts.v2', ['execution.*'], { project_scoped: false, surface: 'execution', state: 'attempts' }),
    common('execution.checkpoints', 'GET', '/api/v2/executions/{id}/checkpoints', 'Execution', 'execution:read', 'execution.query.v2', 'execution.checkpoints.v2', ['execution.*'], { project_scoped: false, surface: 'execution', state: 'checkpoints' }),
    common('execution.start', 'POST', '/api/v2/executions/{id}/start', 'Execution', 'execution:run', 'execution.mutation.v2', 'operation.receipt.v2', ['execution.queued', 'execution.completed', 'execution.failed'], { project_scoped: false, surface: 'execution', state: 'start', long_running: true, external_adapter: 'runner.job-spec.v2' }),
    common('execution.pause', 'POST', '/api/v2/executions/{id}/pause', 'Execution', 'execution:run', 'execution.mutation.v2', 'execution.receipt.v2', ['execution.pause_requested', 'execution.paused'], { project_scoped: false, surface: 'execution', state: 'pause' }),
    common('execution.resume', 'POST', '/api/v2/executions/{id}/resume', 'Execution', 'execution:run', 'execution.mutation.v2', 'operation.receipt.v2', ['execution.resumed', 'execution.completed', 'execution.failed'], { project_scoped: false, surface: 'execution', state: 'resume', long_running: true, external_adapter: 'runner.job-spec.v2' }),
    common('execution.cancel', 'POST', '/api/v2/executions/{id}/cancel', 'Execution', 'execution:run', 'execution.mutation.v2', 'execution.receipt.v2', ['execution.cancelled'], { project_scoped: false, surface: 'execution', state: 'cancel' }),
    common('execution.replan', 'POST', '/api/v2/executions/{id}/replan', 'Execution', 'execution:run', 'execution.replan.v2', 'execution.receipt.v2', ['execution.replanned'], { project_scoped: false, surface: 'execution', state: 'replan' }),
    common('execution.stage.replay', 'POST', '/api/v2/executions/{id}/stages/{stage}/replay', 'Execution', 'execution:run', 'execution.stage.replay.v2', 'operation.receipt.v2', ['execution.stage_replay_queued', 'execution.completed', 'execution.failed'], { project_scoped: false, surface: 'execution', state: 'replay', long_running: true, external_adapter: 'runner.job-spec.v2' })
  ];
}

function p7Entries() {
  const common = (command_id, method, path, owner, scope, input_schema, output_schema, events, options = {}) => ({
    command_id, version: 2, method, path, owner, scope, phase: 'p7',
    project_scoped: options.project_scoped !== false,
    idempotency: method === 'GET' ? 'forbidden' : 'required',
    expected_revision: method === 'GET' ? 'none' : (options.expected_revision || 'resource'),
    input_schema, output_schema, long_running: Boolean(options.long_running), events,
    mcp: { mapping: options.mcp_exposed === false ? 'rest-only' : (method === 'GET' ? 'resource' : 'tool'), name: options.mcp_name || command_id.replaceAll('.', '_').replaceAll('-', '_'), exposed: options.mcp_exposed !== false },
    transport_allowlist: Object.freeze(options.transport_allowlist || (options.mcp_exposed === false ? ['rest', 'web'] : ['rest', 'web', 'mcp', 'gateway'])),
    redaction_policy: 'v3-clean-default', external_adapter: options.external_adapter || null,
    ui_metadata: { surface: options.surface || owner.toLowerCase(), state: options.state || command_id },
    evidence_metadata: { receipt_kind: options.long_running ? 'operation.receipt.v2' : 'resource.receipt.v2', verification: 'p7-evidence-quality-parser-outcome' }
  });
  return [
    common('parser.format.list', 'GET', '/api/v2/parser/formats', 'Parser', 'parser:read', 'parser.formats.query.v2', 'parser.formats.v2', ['parser_format.*'], { project_scoped: false, surface: 'evidence', state: 'parser-formats', external_adapter: 'parser.worker.v1' }),
    common('parser.run.start', 'POST', '/api/v2/assets/{id}/versions/{version_id}/parse', 'Parser', 'parser:run', 'parser.run.start.v2', 'operation.receipt.v2', ['parser_run.queued', 'parser_run.parsed', 'parser_run.failed'], { project_scoped: false, surface: 'evidence', state: 'parse-start', long_running: true, external_adapter: 'parser.job.v1' }),
    common('parser.run.get', 'GET', '/api/v2/parser-runs/{id}', 'Parser', 'parser:read', 'parser.run.query.v2', 'parser.run.v2', ['parser_run.*'], { project_scoped: false, surface: 'evidence', state: 'parser-run', external_adapter: 'parser.worker.v1' }),
    common('parser.run.retry', 'POST', '/api/v2/parser-runs/{id}/retry', 'Parser', 'parser:run', 'parser.run.mutation.v2', 'operation.receipt.v2', ['parser_run.retry_queued', 'parser_run.parsed', 'parser_run.failed'], { project_scoped: false, surface: 'evidence', state: 'parse-retry', long_running: true, external_adapter: 'parser.job.v1' }),
    common('parser.run.cancel', 'POST', '/api/v2/parser-runs/{id}/cancel', 'Parser', 'parser:run', 'parser.run.mutation.v2', 'parser.run.receipt.v2', ['parser_run.cancel_requested', 'parser_run.cancelled'], { project_scoped: false, surface: 'evidence', state: 'parse-cancel', external_adapter: 'parser.job.v1' }),

    common('asset.list', 'GET', '/api/v2/projects/{project_id}/assets', 'Evidence', 'evidence:read', 'asset.project.query.v2', 'assets.v2', ['asset.*'], { surface: 'evidence', state: 'asset-list' }),
    common('asset.capture', 'POST', '/api/v2/projects/{project_id}/assets', 'Evidence', 'evidence:write', 'asset.capture.v2', 'asset.receipt.v2', ['asset.captured'], { surface: 'evidence', state: 'asset-capture', expected_revision: 'parent' }),
    common('asset.get', 'GET', '/api/v2/assets/{id}', 'Evidence', 'evidence:read', 'asset.query.v2', 'asset.v2', ['asset.*'], { project_scoped: false, surface: 'evidence', state: 'asset-detail' }),
    common('asset.version.list', 'GET', '/api/v2/assets/{id}/versions', 'Evidence', 'evidence:read', 'asset.query.v2', 'asset.versions.v2', ['asset.*'], { project_scoped: false, surface: 'evidence', state: 'asset-versions' }),
    common('asset.content', 'GET', '/api/v2/assets/{id}/versions/{version_id}/content', 'Evidence', 'evidence:read', 'asset.query.v2', 'asset.content.v2', ['asset.*'], { project_scoped: false, surface: 'evidence', state: 'asset-content', mcp_exposed: false }),
    common('asset.relation.list', 'GET', '/api/v2/assets/{id}/relations', 'Evidence', 'evidence:read', 'asset.query.v2', 'asset.relations.v2', ['asset.*'], { project_scoped: false, surface: 'evidence', state: 'asset-lineage' }),
    common('asset.relation.create', 'POST', '/api/v2/assets/{id}/relations', 'Evidence', 'evidence:write', 'asset.relation.create.v2', 'asset.relation.receipt.v2', ['asset.relation.created'], { project_scoped: false, surface: 'evidence', state: 'relation-create' }),
    common('asset.attestation.list', 'GET', '/api/v2/assets/{id}/attestations', 'Evidence', 'evidence:read', 'asset.query.v2', 'asset.attestations.v2', ['asset.*'], { project_scoped: false, surface: 'evidence', state: 'asset-attestations' }),
    common('asset.attest', 'POST', '/api/v2/assets/{id}/attestations', 'Evidence', 'evidence:write', 'asset.attestation.create.v2', 'asset.attestation.receipt.v2', ['asset.attested'], { project_scoped: false, surface: 'evidence', state: 'asset-attest' }),
    common('asset.tombstone', 'POST', '/api/v2/assets/{id}/tombstone', 'Evidence', 'evidence:write', 'asset.tombstone.v2', 'asset.receipt.v2', ['asset.tombstoned'], { project_scoped: false, surface: 'evidence', state: 'asset-tombstone', mcp_exposed: false }),
    common('evidence.execution.get', 'GET', '/api/v2/executions/{id}/evidence', 'Evidence', 'evidence:read', 'execution.evidence.query.v2', 'execution.evidence.v2', ['evidence.*'], { project_scoped: false, surface: 'execution', state: 'evidence' }),
    common('evidence.trace.list', 'GET', '/api/v2/executions/{id}/traces', 'Evidence', 'evidence:read', 'execution.evidence.query.v2', 'execution.traces.v2', ['trace.*'], { project_scoped: false, surface: 'execution', state: 'traces' }),
    common('evidence.digest.list', 'GET', '/api/v2/executions/{id}/digests', 'Evidence', 'evidence:read', 'execution.evidence.query.v2', 'execution.digests.v2', ['digest.*'], { project_scoped: false, surface: 'execution', state: 'digests' }),
    common('evidence.test-result.list', 'GET', '/api/v2/executions/{id}/test-results', 'Evidence', 'evidence:read', 'execution.evidence.query.v2', 'execution.test_results.v2', ['test_result.*'], { project_scoped: false, surface: 'execution', state: 'test-results' }),
    common('evidence.code-change.list', 'GET', '/api/v2/executions/{id}/code-changes', 'Evidence', 'evidence:read', 'execution.evidence.query.v2', 'execution.code_changes.v2', ['code_change.*'], { project_scoped: false, surface: 'execution', state: 'code-changes' }),

    common('quality.list', 'GET', '/api/v2/executions/{id}/quality-reviews', 'Quality', 'quality:read', 'quality.list.query.v2', 'quality.reviews.v2', ['quality_review.*'], { project_scoped: false, surface: 'execution', state: 'quality-list' }),
    common('quality.start', 'POST', '/api/v2/executions/{id}/quality-reviews', 'Quality', 'quality:run', 'quality.start.v2', 'operation.receipt.v2', ['quality_review.queued', 'quality_review.awaiting_human', 'quality_review.failed'], { project_scoped: false, surface: 'execution', state: 'quality-start', long_running: true, external_adapter: 'quality.checker.v1' }),
    common('quality.get', 'GET', '/api/v2/quality-reviews/{id}', 'Quality', 'quality:read', 'quality.query.v2', 'quality.review.v2', ['quality_review.*'], { project_scoped: false, surface: 'execution', state: 'quality-detail' }),
    common('quality.events', 'GET', '/api/v2/quality-reviews/{id}/events', 'Quality', 'quality:read', 'quality.query.v2', 'event.replay.v2', ['quality_review.*'], { project_scoped: false, surface: 'execution', state: 'quality-events' }),
    common('quality.report.get', 'GET', '/api/v2/quality-reviews/{id}/report', 'Quality', 'quality:read', 'quality.query.v2', 'quality.report.v2', ['quality_review.*'], { project_scoped: false, surface: 'execution', state: 'quality-report' }),
    common('quality.decision', 'POST', '/api/v2/quality-reviews/{id}/decision', 'Quality', 'quality:approve', 'quality.decision.v2', 'quality.review.receipt.v2', ['quality_review.decided'], { project_scoped: false, surface: 'execution', state: 'quality-decision', mcp_exposed: false }),
    common('quality.cancel', 'POST', '/api/v2/quality-reviews/{id}/cancel', 'Quality', 'quality:run', 'quality.mutation.v2', 'quality.review.receipt.v2', ['quality_review.cancelled'], { project_scoped: false, surface: 'execution', state: 'quality-cancel' }),
    common('quality.retry', 'POST', '/api/v2/quality-reviews/{id}/retry', 'Quality', 'quality:run', 'quality.mutation.v2', 'operation.receipt.v2', ['quality_review.retry_queued', 'quality_review.awaiting_human', 'quality_review.failed'], { project_scoped: false, surface: 'execution', state: 'quality-retry', long_running: true, external_adapter: 'quality.checker.v1' }),

    common('outcome.get', 'GET', '/api/v2/executions/{id}/outcome', 'Outcome', 'outcome:read', 'outcome.query.v2', 'outcome.v2', ['outcome.*'], { project_scoped: false, surface: 'execution', state: 'outcome' }),
    common('outcome.evaluate', 'POST', '/api/v2/executions/{id}/outcome/evaluate', 'Outcome', 'outcome:run', 'outcome.evaluate.v2', 'operation.receipt.v2', ['outcome.evaluation.queued', 'outcome.evaluated'], { project_scoped: false, surface: 'execution', state: 'outcome-evaluate', long_running: true }),
    common('outcome.waiver.create', 'POST', '/api/v2/executions/{id}/outcome/waivers', 'Outcome', 'outcome:approve', 'outcome.waiver.create.v2', 'outcome.waiver.receipt.v2', ['outcome.waiver.created'], { project_scoped: false, surface: 'execution', state: 'waiver-create', mcp_exposed: false }),
    common('outcome.waiver.revoke', 'POST', '/api/v2/outcome-waivers/{id}/revoke', 'Outcome', 'outcome:approve', 'outcome.waiver.revoke.v2', 'outcome.waiver.receipt.v2', ['outcome.waiver.revoked'], { project_scoped: false, surface: 'execution', state: 'waiver-revoke', mcp_exposed: false })
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
  const includeP4 = options.phase === 'p4' || options.cleanPhase === 'p4' || Number(options.targetVersion || 0) >= 4;
  const includeP5 = options.phase === 'p5' || options.cleanPhase === 'p5' || Number(options.targetVersion || 0) >= 5;
  const includeP6 = options.phase === 'p6' || options.cleanPhase === 'p6' || Number(options.targetVersion || 0) >= 6;
  const includeP7 = options.phase === 'p7' || options.cleanPhase === 'p7' || Number(options.targetVersion || 0) >= 7;
  const selected = includeP7 ? CLEAN_COMMAND_REGISTRY : includeP6 ? CLEAN_COMMAND_REGISTRY.filter((entry) => entry.phase !== 'p7') : includeP5 ? CLEAN_COMMAND_REGISTRY.filter((entry) => !['p6', 'p7'].includes(entry.phase)) : includeP4 ? CLEAN_COMMAND_REGISTRY.filter((entry) => !['p5', 'p6', 'p7'].includes(entry.phase)) : includeP3 ? CLEAN_COMMAND_REGISTRY.filter((entry) => !['p4', 'p5', 'p6', 'p7'].includes(entry.phase)) : CLEAN_COMMAND_REGISTRY.filter((entry) => !['p3', 'p4', 'p5', 'p6', 'p7'].includes(entry.phase));
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
    if (['p5', 'p6', 'p7'].includes(entry.phase)) {
      if (!Array.isArray(entry.transport_allowlist) || entry.transport_allowlist.length === 0) throw new Error(`registry_transport_allowlist_missing:${entry.command_id}`);
      if (new Set(entry.transport_allowlist).size !== entry.transport_allowlist.length || entry.transport_allowlist.some((transport) => !['rest', 'web', 'mcp', 'gateway'].includes(transport))) throw new Error(`registry_transport_allowlist_invalid:${entry.command_id}`);
      if (entry.mcp.exposed === false && (entry.transport_allowlist.includes('mcp') || entry.transport_allowlist.includes('gateway'))) throw new Error(`registry_transport_exposure_mismatch:${entry.command_id}`);
    }
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
