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

export const CLEAN_P4_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P3_TABLE_OWNERS,
  context_sources: 'Context',
  context_nodes: 'Context',
  context_document_versions: 'Context',
  context_edges: 'Context',
  context_policies: 'Context',
  context_selections: 'Context',
  context_packs: 'Context',
  context_projection_jobs: 'Projection',
  context_index_snapshots: 'Projection',
  exchange_requests: 'Exchange',
  mcp_clients: 'MCP',
  gateway_forward_receipts: 'Gateway'
});

export const CLEAN_P5_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P4_TABLE_OWNERS,
  assist_sessions: 'Assist',
  assist_turns: 'Assist',
  assist_messages: 'Assist',
  assist_goals: 'Assist',
  assist_configurations: 'Assist',
  assist_references: 'Assist',
  attachments: 'Files',
  file_refs: 'Files',
  file_change_batches: 'Files',
  file_change_items: 'Files',
  runtime_approvals: 'Assist',
  runtime_user_inputs: 'Assist',
  semantic_proposals: 'Assist',
  terminal_sessions: 'Terminal',
  terminal_events: 'Terminal',
  bridge_devices: 'Bridge',
  bridge_transfers: 'Bridge'
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
  , 'context.source.create': 'Context'
  , 'context.source.list': 'Context'
  , 'context.map': 'Context'
  , 'context.search': 'Context'
  , 'context.read': 'Context'
  , 'context.node.get': 'Context'
  , 'context.node.versions': 'Context'
  , 'context.policy.get': 'Context'
  , 'context.policy.update': 'Context'
  , 'context.selection.list': 'Context'
  , 'context.selection.create': 'Context'
  , 'context.pack.list': 'Context'
  , 'context.pack.get': 'Context'
  , 'context.pack.create': 'Context'
  , 'context.projection.status': 'Projection'
  , 'context.projection.rebuild': 'Projection'
  , 'context.projection.jobs': 'Projection'
  , 'context.projection.job': 'Projection'
  , 'context.projection.events': 'Projection'
  , 'context.projection.cancel': 'Projection'
  , 'context.projection.retry': 'Projection'
  , 'mcp.client.list': 'MCP'
  , 'mcp.client.create': 'MCP'
  , 'mcp.client.revoke': 'MCP'
  , 'mcp.rpc': 'MCP'
  , 'mcp.tools.list': 'MCP'
  , 'exchange.request.list': 'Exchange'
  , 'exchange.request.create': 'Exchange'
  , 'exchange.request.approve': 'Exchange'
  , 'exchange.request.reject': 'Exchange'
  , 'exchange.grant.list': 'Exchange'
  , 'exchange.grant.revoke': 'Exchange'
  , 'exchange.grant.pack.create': 'Exchange'
  , 'gateway.forward': 'Gateway'
  , 'gateway.receipt.get': 'Gateway'
  , 'assist.session.list': 'Assist'
  , 'assist.session.create': 'Assist'
  , 'assist.session.get': 'Assist'
  , 'assist.turn.create': 'Assist'
  , 'assist.session.events': 'Assist'
  , 'assist.goal.get': 'Assist'
  , 'assist.goal.update': 'Assist'
  , 'assist.reference.list': 'Assist'
  , 'assist.reference.create': 'Assist'
  , 'assist.session.pause': 'Assist'
  , 'assist.session.resume': 'Assist'
  , 'assist.session.cancel': 'Assist'
  , 'assist.turn.retry': 'Assist'
  , 'assist.turn.cancel': 'Assist'
  , 'assist.turn.steer': 'Assist'
  , 'assist.turn.interrupt': 'Assist'
  , 'assist.turn.follow-ups': 'Assist'
  , 'file.list': 'Files'
  , 'file.get': 'Files'
  , 'attachment.list': 'Files'
  , 'attachment.create': 'Files'
  , 'attachment.content': 'Files'
  , 'attachment.preview': 'Files'
  , 'attachment.delete': 'Files'
  , 'change.batch.list': 'Files'
  , 'change.batch.create': 'Files'
  , 'change.batch.review': 'Files'
  , 'change.batch.approve': 'Files'
  , 'change.batch.apply': 'Files'
  , 'change.batch.undo': 'Files'
  , 'approval.list': 'Assist'
  , 'approval.create': 'Assist'
  , 'approval.decide': 'Assist'
  , 'user.input.list': 'Assist'
  , 'user.input.create': 'Assist'
  , 'user.input.answer': 'Assist'
  , 'user.input.cancel': 'Assist'
  , 'proposal.list': 'Assist'
  , 'proposal.create': 'Assist'
  , 'proposal.apply': 'Assist'
  , 'proposal.reject': 'Assist'
  , 'proposal.undo': 'Assist'
  , 'terminal.capabilities': 'Terminal'
  , 'terminal.list': 'Terminal'
  , 'terminal.open': 'Terminal'
  , 'terminal.get': 'Terminal'
  , 'terminal.events': 'Terminal'
  , 'terminal.ws': 'Terminal'
  , 'terminal.resize': 'Terminal'
  , 'terminal.signal': 'Terminal'
  , 'terminal.stop': 'Terminal'
  , 'bridge.device.list': 'Bridge'
  , 'bridge.pair': 'Bridge'
  , 'bridge.device.probe': 'Bridge'
  , 'bridge.device.rotate': 'Bridge'
  , 'bridge.device.revoke': 'Bridge'
  , 'bridge.transfer.list': 'Bridge'
  , 'bridge.transfer.create': 'Bridge'
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
  , 'context_source.*': 'Context'
  , 'context_policy.*': 'Context'
  , 'context_selection.*': 'Context'
  , 'context_pack.*': 'Context'
  , 'context_projection.*': 'Projection'
  , 'context.*': 'Context'
  , 'context.map.read': 'Context'
  , 'exchange_request.*': 'Exchange'
  , 'exchange_grant.*': 'Exchange'
  , 'mcp_client.*': 'MCP'
  , 'mcp.*': 'MCP'
  , 'gateway.*': 'Gateway'
  , 'assist_session.*': 'Assist'
  , 'assist_turn.*': 'Assist'
  , 'assist_message.*': 'Assist'
  , 'assist_goal.*': 'Assist'
  , 'assist_reference.*': 'Assist'
  , 'runtime_approval.*': 'Assist'
  , 'runtime_user_input.*': 'Assist'
  , 'semantic_proposal.*': 'Assist'
  , 'attachment.*': 'Files'
  , 'file_ref.*': 'Files'
  , 'file_change_batch.*': 'Files'
  , 'terminal.*': 'Terminal'
  , 'bridge_device.*': 'Bridge'
  , 'bridge_transfer.*': 'Bridge'
});

export const CLEAN_PLATFORM_OWNERSHIP = Object.freeze({
  schema_version: 'aiws.v3-clean.owner-manifest.v4',
  tables: CLEAN_P5_TABLE_OWNERS,
  commands: CLEAN_COMMAND_OWNERS,
  events: CLEAN_EVENT_OWNERS
});

export function validateCleanOwnership({ tables = [], registry = null } = {}) {
  const actualTables = [...new Set(tables.map((table) => String(table)))].sort();
  const tableOwners = actualTables.includes('assist_sessions') ? CLEAN_P5_TABLE_OWNERS : (actualTables.includes('context_sources') ? CLEAN_P4_TABLE_OWNERS : (actualTables.includes('projects') ? CLEAN_P3_TABLE_OWNERS : (actualTables.includes('teams') ? CLEAN_P2_TABLE_OWNERS : CLEAN_TABLE_OWNERS)));
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
    const p4Owners = new Set(['Context', 'Projection', 'Exchange', 'MCP', 'Gateway']);
    const p5Owners = new Set(['Assist', 'Files', 'Terminal', 'Bridge']);
    const hasP5Tables = actualTables.includes('assist_sessions');
    const hasP4Tables = actualTables.includes('context_sources');
    const hasP3Tables = actualTables.includes('projects');
    const expectedCommandIds = Object.entries(CLEAN_COMMAND_OWNERS)
      .filter(([, owner]) => {
        if (hasP5Tables) return true;
        if (hasP4Tables) return !p5Owners.has(owner);
        if (hasP3Tables) return !p4Owners.has(owner) && !p5Owners.has(owner);
        return !p3Owners.has(owner) && !p4Owners.has(owner) && !p5Owners.has(owner);
      })
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
