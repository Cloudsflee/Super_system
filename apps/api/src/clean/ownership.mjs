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

export const CLEAN_P6_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P5_TABLE_OWNERS,
  runner_profiles: 'Runner',
  job_specs: 'Runner',
  runner_receipts: 'Runner',
  executions: 'Execution',
  execution_inputs: 'Execution',
  task_attempts: 'Execution',
  execution_stage_checkpoints: 'Execution',
  execution_events: 'Execution'
});

export const CLEAN_P7_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P6_TABLE_OWNERS,
  parser_formats: 'Parser',
  parser_runs: 'Parser',
  assets: 'Evidence',
  asset_versions: 'Evidence',
  asset_blobs: 'Evidence',
  asset_relations: 'Evidence',
  asset_attestations: 'Evidence',
  traces: 'Evidence',
  digests: 'Evidence',
  code_changes: 'Evidence',
  test_results: 'Evidence',
  quality_review_runs: 'Quality',
  quality_review_reports: 'Quality',
  quality_review_events: 'Quality',
  human_reviews: 'Quality',
  outcome_evaluations: 'Outcome',
  outcome_waivers: 'Outcome'
});

export const CLEAN_P8_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P7_TABLE_OWNERS,
  delivery_policies: 'Delivery',
  deliveries: 'Delivery',
  pull_request_intents: 'Delivery',
  delivery_events: 'Delivery',
  deployment_candidates: 'Deployment',
  deployment_verifications: 'Deployment',
  backup_manifests: 'Operations',
  import_batches: 'Importer',
  import_checkpoints: 'Importer',
  import_id_map: 'Importer',
  import_conflicts: 'Importer'
});

export const CLEAN_P10_TABLE_OWNERS = Object.freeze({
  ...CLEAN_P8_TABLE_OWNERS,
  brief_templates: 'Project',
  brief_template_revisions: 'Project',
  workflow_quality_policies: 'Quality',
  quality_review_asset_selections: 'Quality',
  quality_review_advices: 'Quality',
  assist_review_comments: 'Assist',
  project_deletion_intents: 'Project',
  repository_deletion_intents: 'Repository'
});

export const CLEAN_COMMAND_OWNERS = Object.freeze({
  'operations.get': 'Operations',
  'operations.events': 'Operations',
  'operations.cancel': 'Operations',
  'events.project.replay': 'Operations',
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
  , 'runner.profile.list': 'Runner'
  , 'runner.profile.create': 'Runner'
  , 'runner.profile.get': 'Runner'
  , 'runner.profile.update': 'Runner'
  , 'runner.profile.probe': 'Runner'
  , 'runner.profile.disable': 'Runner'
  , 'execution.list': 'Execution'
  , 'execution.create': 'Execution'
  , 'execution.get': 'Execution'
  , 'execution.events': 'Execution'
  , 'execution.attempts': 'Execution'
  , 'execution.checkpoints': 'Execution'
  , 'execution.start': 'Execution'
  , 'execution.pause': 'Execution'
  , 'execution.resume': 'Execution'
  , 'execution.cancel': 'Execution'
  , 'execution.replan': 'Execution'
  , 'execution.stage.replay': 'Execution'
  , 'parser.format.list': 'Parser'
  , 'parser.run.start': 'Parser'
  , 'parser.run.get': 'Parser'
  , 'parser.run.retry': 'Parser'
  , 'parser.run.cancel': 'Parser'
  , 'asset.list': 'Evidence'
  , 'asset.capture': 'Evidence'
  , 'asset.get': 'Evidence'
  , 'asset.version.list': 'Evidence'
  , 'asset.content': 'Evidence'
  , 'asset.relation.list': 'Evidence'
  , 'asset.relation.create': 'Evidence'
  , 'asset.attestation.list': 'Evidence'
  , 'asset.attest': 'Evidence'
  , 'asset.tombstone': 'Evidence'
  , 'evidence.execution.get': 'Evidence'
  , 'evidence.trace.list': 'Evidence'
  , 'evidence.digest.list': 'Evidence'
  , 'evidence.test-result.list': 'Evidence'
  , 'evidence.code-change.list': 'Evidence'
  , 'quality.list': 'Quality'
  , 'quality.start': 'Quality'
  , 'quality.get': 'Quality'
  , 'quality.events': 'Quality'
  , 'quality.report.get': 'Quality'
  , 'quality.decision': 'Quality'
  , 'quality.cancel': 'Quality'
  , 'quality.retry': 'Quality'
  , 'outcome.get': 'Outcome'
  , 'outcome.evaluate': 'Outcome'
  , 'outcome.waiver.create': 'Outcome'
  , 'outcome.waiver.revoke': 'Outcome'
  , 'delivery.policy.list': 'Delivery'
  , 'delivery.policy.create': 'Delivery'
  , 'delivery.list': 'Delivery'
  , 'delivery.get': 'Delivery'
  , 'delivery.submit': 'Delivery'
  , 'delivery.intent.create': 'Delivery'
  , 'delivery.intent.ready': 'Delivery'
  , 'delivery.intent.merge': 'Delivery'
  , 'delivery.reconcile': 'Delivery'
  , 'github.repository.list': 'Delivery'
  , 'github.webhook.receive': 'Delivery'
  , 'deployment.get': 'Deployment'
  , 'deployment.candidate.get': 'Deployment'
  , 'deployment.candidate.create': 'Deployment'
  , 'deployment.verify': 'Deployment'
  , 'backup.list': 'Operations'
  , 'backup.create': 'Operations'
  , 'restore.prepare': 'Operations'
  , 'system.reset.prepare': 'Operations'
  , 'import.list': 'Importer'
  , 'import.get': 'Importer'
  , 'operations.list': 'Operations'
  , 'operations.replay': 'Operations'
  , 'cas.gc.plan': 'CAS'
  , 'cas.gc.apply': 'CAS'
  , 'profile.update': 'Setup'
  , 'profile.disable': 'Setup'
  , 'profile.enable': 'Setup'
  , 'brief.template.list': 'Project'
  , 'brief.template.create': 'Project'
  , 'brief.template.update': 'Project'
  , 'brief.template.archive': 'Project'
  , 'project.deletion.prepare': 'Project'
  , 'project.deletion.get': 'Project'
  , 'project.deletion.confirm': 'Project'
  , 'project.deletion.execute': 'Project'
  , 'project.deletion.cancel': 'Project'
  , 'repository.deletion.prepare': 'Repository'
  , 'repository.deletion.get': 'Repository'
  , 'repository.deletion.creator_confirm': 'Repository'
  , 'repository.deletion.owner_confirm': 'Repository'
  , 'repository.deletion.execute': 'Repository'
  , 'repository.deletion.reconcile': 'Repository'
  , 'repository.deletion.cancel': 'Repository'
  , 'assist.session.metadata': 'Assist'
  , 'assist.session.archive': 'Assist'
  , 'assist.session.restore': 'Assist'
  , 'assist.session.delete': 'Assist'
  , 'assist.session.restore_deleted': 'Assist'
  , 'assist.session.fork': 'Assist'
  , 'assist.session.side_thread': 'Assist'
  , 'assist.configuration.create': 'Assist'
  , 'assist.review.comments': 'Assist'
  , 'assist.review.comment': 'Assist'
  , 'assist.review.request_changes': 'Assist'
  , 'quality.policy.get': 'Quality'
  , 'quality.policy.update': 'Quality'
  , 'quality.prepare': 'Quality'
  , 'quality.advice.get': 'Quality'
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
  'brief_template.*': 'Project',
  'repository.*': 'Repository',
  'workspace.*': 'Repository',
  'workflow.*': 'Workflow',
  'generation.*': 'Workflow',
  'critic.*': 'Critic',
  'outcome.requirement.*': 'Project'
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
  , 'assist_configuration.*': 'Assist'
  , 'assist_review.*': 'Assist'
  , 'runtime_approval.*': 'Assist'
  , 'runtime_user_input.*': 'Assist'
  , 'semantic_proposal.*': 'Assist'
  , 'attachment.*': 'Files'
  , 'file_ref.*': 'Files'
  , 'file_change_batch.*': 'Files'
  , 'terminal.*': 'Terminal'
  , 'bridge_device.*': 'Bridge'
  , 'bridge_transfer.*': 'Bridge'
  , 'runner_profile.*': 'Runner'
  , 'runner_job.*': 'Runner'
  , 'runner_receipt.*': 'Runner'
  , 'execution.*': 'Execution'
  , 'execution_stage.*': 'Execution'
  , 'task_attempt.*': 'Execution'
  , 'parser_format.*': 'Parser'
  , 'parser_run.*': 'Parser'
  , 'asset.*': 'Evidence'
  , 'evidence.*': 'Evidence'
  , 'trace.*': 'Evidence'
  , 'digest.*': 'Evidence'
  , 'code_change.*': 'Evidence'
  , 'test_result.*': 'Evidence'
  , 'quality_review.*': 'Quality'
  , 'quality_policy.*': 'Quality'
  , 'outcome.*': 'Outcome'
  , 'delivery.*': 'Delivery'
  , 'deployment.*': 'Deployment'
  , 'backup.*': 'Operations'
  , 'restore.*': 'Operations'
  , 'system.reset.*': 'Operations'
  , 'import.*': 'Importer'
});

export const CLEAN_PLATFORM_OWNERSHIP = Object.freeze({
  schema_version: 'aiws.v3-clean.owner-manifest.v8',
  tables: CLEAN_P8_TABLE_OWNERS,
  commands: CLEAN_COMMAND_OWNERS,
  events: CLEAN_EVENT_OWNERS
});

export const CLEAN_P10_PLATFORM_OWNERSHIP = Object.freeze({
  schema_version: 'aiws.v3-clean.owner-manifest.v10',
  tables: CLEAN_P10_TABLE_OWNERS,
  commands: CLEAN_COMMAND_OWNERS,
  events: CLEAN_EVENT_OWNERS
});

export function validateCleanOwnership({ tables = [], registry = null } = {}) {
  const actualTables = [...new Set(tables.map((table) => String(table)))].sort();
  const tableOwners = actualTables.includes('brief_templates') ? CLEAN_P10_TABLE_OWNERS : (actualTables.includes('delivery_policies') ? CLEAN_P8_TABLE_OWNERS : (actualTables.includes('parser_formats') ? CLEAN_P7_TABLE_OWNERS : (actualTables.includes('runner_profiles') ? CLEAN_P6_TABLE_OWNERS : (actualTables.includes('assist_sessions') ? CLEAN_P5_TABLE_OWNERS : (actualTables.includes('context_sources') ? CLEAN_P4_TABLE_OWNERS : (actualTables.includes('projects') ? CLEAN_P3_TABLE_OWNERS : (actualTables.includes('teams') ? CLEAN_P2_TABLE_OWNERS : CLEAN_TABLE_OWNERS)))))));
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
    const p6Owners = new Set(['Runner', 'Execution']);
    const p7Owners = new Set(['Parser', 'Evidence', 'Quality', 'Outcome']);
    const p8Owners = new Set(['Delivery', 'Deployment', 'Importer']);
    const hasP8Tables = actualTables.includes('delivery_policies');
    const hasP10Tables = actualTables.includes('brief_templates');
    const hasP9Routes = entries.some((entry) => entry.phase === 'p9');
    const hasP7Tables = actualTables.includes('parser_formats');
    const hasP6Tables = actualTables.includes('runner_profiles');
    const hasP5Tables = actualTables.includes('assist_sessions');
    const hasP4Tables = actualTables.includes('context_sources');
    const hasP3Tables = actualTables.includes('projects');
    const p8OperationCommands = new Set(['operations.list', 'operations.replay', 'backup.list', 'backup.create', 'restore.prepare', 'system.reset.prepare', 'cas.gc.plan', 'cas.gc.apply']);
    const p10Commands = new Set(Object.keys(CLEAN_COMMAND_OWNERS).filter((commandId) => ['profile.update','profile.disable','profile.enable','brief.template.list','brief.template.create','brief.template.update','brief.template.archive','project.deletion.prepare','project.deletion.get','project.deletion.confirm','project.deletion.execute','project.deletion.cancel','repository.deletion.prepare','repository.deletion.get','repository.deletion.creator_confirm','repository.deletion.owner_confirm','repository.deletion.execute','repository.deletion.reconcile','repository.deletion.cancel','assist.session.metadata','assist.session.archive','assist.session.restore','assist.session.delete','assist.session.restore_deleted','assist.session.fork','assist.session.side_thread','assist.configuration.create','assist.review.comments','assist.review.comment','assist.review.request_changes','quality.policy.get','quality.policy.update','quality.prepare','quality.advice.get'].includes(commandId)));
    const expectedCommandIds = Object.entries(CLEAN_COMMAND_OWNERS)
      .filter(([commandId, owner]) => {
        if (commandId === 'events.project.replay' && !hasP9Routes) return false;
        if (p10Commands.has(commandId) && !hasP10Tables) return false;
        if (!hasP8Tables && p8OperationCommands.has(commandId)) return false;
        if (hasP8Tables) return true;
        if (hasP7Tables) return !p8Owners.has(owner);
        if (hasP6Tables) return !p7Owners.has(owner) && !p8Owners.has(owner);
        if (hasP5Tables) return !p6Owners.has(owner) && !p7Owners.has(owner) && !p8Owners.has(owner);
        if (hasP4Tables) return !p5Owners.has(owner) && !p6Owners.has(owner) && !p7Owners.has(owner) && !p8Owners.has(owner);
        if (hasP3Tables) return !p4Owners.has(owner) && !p5Owners.has(owner) && !p6Owners.has(owner) && !p7Owners.has(owner) && !p8Owners.has(owner);
        return !p3Owners.has(owner) && !p4Owners.has(owner) && !p5Owners.has(owner) && !p6Owners.has(owner) && !p7Owners.has(owner) && !p8Owners.has(owner);
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
