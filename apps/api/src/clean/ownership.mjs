import { canonicalJson } from './canonical.mjs';

// P1 is intentionally small, but every platform record still has one
// accountable owner. Later domain owners extend these maps without creating a
// second platform ledger or head source.
export const CLEAN_TABLE_OWNERS = Object.freeze({
  schema_meta: 'Platform',
  schema_migrations: 'Platform',
  actors: 'Platform',
  aggregate_heads: 'Platform',
  aggregate_revisions: 'Platform',
  operations: 'Operations',
  operation_links: 'Operations',
  events: 'Operations',
  event_cursors: 'Operations',
  idempotency_keys: 'Operations',
  audit_events: 'Operations',
  cas_objects: 'CAS',
  receipt_manifests: 'CAS'
});

export const CLEAN_P2_TABLE_OWNERS = Object.freeze({
  ...CLEAN_TABLE_OWNERS,
  actors: 'Identity',
  teams: 'Identity',
  team_memberships: 'Identity',
  sessions: 'Identity',
  project_memberships: 'Identity',
  project_invitations: 'Identity',
  project_acl_entries: 'Identity',
  credential_refs: 'Setup',
  provider_profiles: 'Setup',
  exchange_grants: 'Exchange'
});

export const CLEAN_P3_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P2_TABLE_OWNERS,
  projects: 'Project',
  project_intakes: 'Project',
  briefs: 'Project',
  brief_revisions: 'Project',
  repository_connections: 'Repository',
  repository_targets: 'Repository',
  repository_lines: 'Repository',
  repository_workspaces: 'Repository',
  repository_locks: 'Repository',
  workflows: 'Workflow',
  workflow_revisions: 'Workflow',
  workflow_nodes: 'Workflow',
  node_contracts: 'Workflow',
  workflow_generations: 'Workflow',
  workflow_critic_receipts: 'Critic',
  workflow_generation_proposals: 'Workflow',
  outcome_requirements: 'Project'
});

export const CLEAN_COMMAND_OWNERS = Object.freeze({
  'operations.get': 'Operations',
  'operations.events': 'Operations',
  'operations.cancel': 'Operations',
  'setup.get': 'Setup',
  'setup.complete': 'Identity',
  'account.get': 'Identity',
  'account.update': 'Identity',
  'actor.list': 'Identity',
  'actor.create': 'Identity',
  'actor.update': 'Identity',
  'actor.suspend': 'Identity',
  'actor.activate': 'Identity',
  'actor.revoke': 'Identity',
  'actor.switch': 'Identity',
  'session.list': 'Identity',
  'session.create': 'Identity',
  'session.revoke': 'Identity',
  'team.list': 'Identity',
  'team.get': 'Identity',
  'team.create': 'Identity',
  'team.status': 'Identity',
  'team.members.list': 'Identity',
  'team.member.grant': 'Identity',
  'team.member.status': 'Identity',
  'project.members.list': 'Identity',
  'membership.grant': 'Identity',
  'membership.status': 'Identity',
  'project.invitations.list': 'Identity',
  'invitation.create': 'Identity',
  'invitation.accept': 'Identity',
  'invitation.revoke': 'Identity',
  'project.permissions.list': 'Identity',
  'acl.set': 'Identity',
  'credential.list': 'Setup',
  'credential.create': 'Setup',
  'credential.rebind': 'Setup',
  'credential.rotate': 'Setup',
  'credential.revoke': 'Setup',
  'profile.list': 'Setup',
  'profile.create': 'Setup',
  'profile.probe': 'Setup',
  'project.list': 'Project',
  'project.get': 'Project',
  'project.create': 'Project',
  'project.update': 'Project',
  'project.archive': 'Project',
  'project.restore': 'Project',
  'intake.get': 'Project',
  'intake.submit': 'Project',
  'intake.retry': 'Project',
  'intake.cancel': 'Project',
  'brief.list': 'Project',
  'brief.get': 'Project',
  'brief.create': 'Project',
  'brief.confirm': 'Project',
  'brief.preview': 'Project',
  'repository.connection.list': 'Repository',
  'repository.connection.create': 'Repository',
  'repository.connection.update': 'Repository',
  'repository.target.list': 'Repository',
  'repository.target.create': 'Repository',
  'repository.line.list': 'Repository',
  'repository.line.reconcile': 'Repository',
  'repository.workspace.list': 'Repository',
  'repository.workspace.create': 'Repository',
  'repository.workspace.refresh': 'Repository',
  'repository.workspace.lock': 'Repository',
  'repository.workspace.release': 'Repository',
  'workflow.list': 'Workflow',
  'workflow.get': 'Workflow',
  'workflow.revise': 'Workflow',
  'workflow.generation.list': 'Workflow',
  'workflow.generation.get': 'Workflow',
  'generation.start': 'Workflow',
  'generation.retry': 'Workflow',
  'generation.cancel': 'Workflow',
  'critic.evaluate': 'Critic',
  'workflow.proposal.get': 'Workflow',
  'workflow.proposal.apply': 'Workflow',
  'outcome.requirement.list': 'Project',
  'outcome.requirement.create': 'Project'
});

export const CLEAN_EVENT_OWNERS = Object.freeze({
  'operation.*': 'Operations',
  'route.retired': 'Platform',
  'migration.*': 'Platform',
  'cas.*': 'CAS',
  'setup.state.*': 'Setup',
  'setup.completed': 'Identity',
  'actor.*': 'Identity',
  'team.*': 'Identity',
  'membership.*': 'Identity',
  'invitation.*': 'Identity',
  'acl.*': 'Identity',
  'credential.*': 'Setup',
  'profile.*': 'Setup',
  'session.*': 'Identity',
  'project.*': 'Project',
  'intake.*': 'Project',
  'brief.*': 'Project',
  'repository.*': 'Repository',
  'workspace.*': 'Repository',
  'workflow.*': 'Workflow',
  'generation.*': 'Workflow',
  'critic.*': 'Critic',
  'outcome.*': 'Project'
});

export const CLEAN_PLATFORM_OWNERSHIP = Object.freeze({
  schema_version: 'aiws.v3-clean.owner-manifest.v3',
  tables: CLEAN_P3_TABLE_OWNERS,
  commands: CLEAN_COMMAND_OWNERS,
  events: CLEAN_EVENT_OWNERS
});

export function validateCleanOwnership({ tables = [], registry = null } = {}) {
  const actualTables = [...new Set(tables.map((table) => String(table)))].sort();
  const tableOwners = actualTables.includes('projects') ? CLEAN_P3_TABLE_OWNERS : (actualTables.includes('teams') ? CLEAN_P2_TABLE_OWNERS : CLEAN_TABLE_OWNERS);
  const expectedTables = Object.keys(tableOwners).sort();
  const missingTables = expectedTables.filter((table) => !actualTables.includes(table));
  const unexpectedTables = actualTables.filter((table) => !expectedTables.includes(table));
  const missingCommands = [];
  const mismatchedCommands = [];
  const missingEvents = [];
  const mismatchedEvents = [];
  if (registry) {
    const entries = registry.entries || registry;
    for (const entry of entries) {
      const expected = CLEAN_COMMAND_OWNERS[entry.command_id];
      if (!expected) missingCommands.push(entry.command_id);
      else if (entry.owner !== expected) mismatchedCommands.push({ command_id: entry.command_id, expected, actual: entry.owner });
      for (const event of entry.events || []) {
        const eventOwner = ownerForEvent(event);
        if (!eventOwner) missingEvents.push(event);
        else if (eventOwner !== entry.owner) mismatchedEvents.push({ event, expected: eventOwner, actual: entry.owner });
      }
    }
    const p3Owners = new Set(['Project', 'Repository', 'Workflow', 'Critic']);
    const expectedCommandIds = Object.entries(CLEAN_COMMAND_OWNERS)
      .filter(([, owner]) => actualTables.includes('projects') || !p3Owners.has(owner))
      .map(([commandId]) => commandId);
    for (const commandId of expectedCommandIds) {
      if (!entries.some((entry) => entry.command_id === commandId)) missingCommands.push(commandId);
    }
  }
  return {
    valid: missingTables.length === 0 && unexpectedTables.length === 0 && missingCommands.length === 0 && mismatchedCommands.length === 0 && missingEvents.length === 0 && mismatchedEvents.length === 0,
    missing_tables: missingTables,
    unexpected_tables: unexpectedTables,
    missing_commands: [...new Set(missingCommands)].sort(),
    mismatched_commands: mismatchedCommands,
    missing_events: [...new Set(missingEvents)].sort(),
    mismatched_events: mismatchedEvents
  };
}

export function ownershipFingerprint() {
  return canonicalJson(CLEAN_PLATFORM_OWNERSHIP);
}

function ownerForEvent(event) {
  if (CLEAN_EVENT_OWNERS[event]) return CLEAN_EVENT_OWNERS[event];
  const wildcard = Object.entries(CLEAN_EVENT_OWNERS).find(([pattern]) => pattern.endsWith('*') && String(event).startsWith(pattern.slice(0, -1)));
  return wildcard?.[1] || null;
}
