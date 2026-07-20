export const ProjectStatus = Object.freeze({ Draft: 'draft', Active: 'active', Blocked: 'blocked', Completed: 'completed', Archived: 'archived' });
export const ApprovalAttention = Object.freeze({ Interrupting: 'interrupting', Queued: 'queued', Resolved: 'resolved' });
export const AssistTurnMode = Object.freeze({ Ask: 'ask', Plan: 'plan', Agent: 'agent', Cli: 'cli' });
export const WorkspaceStatus = Object.freeze({ Draft: 'draft', Active: 'active', Blocked: 'blocked', NeedsReview: 'needs_review', Completed: 'completed', Archived: 'archived' });
export const WorkflowStatus = Object.freeze({ Draft: 'draft', Proposed: 'proposed', Confirmed: 'confirmed', Active: 'active', Completed: 'completed', Archived: 'archived' });
export const NodeStatus = Object.freeze({ Draft: 'draft', Ready: 'ready', Running: 'running', Blocked: 'blocked', NeedsReview: 'needs_review', Completed: 'completed', Skipped: 'skipped' });
export const NodeType = Object.freeze({ GoalDefinition: 'goal_definition', Research: 'research', Analysis: 'analysis', Execution: 'execution', Retrospective: 'retrospective' });
export const WorkflowNodeRole = Object.freeze({ Workstream: 'workstream', Task: 'task' });
export const WorkstreamCategory = Object.freeze({ Deliverable: 'deliverable', Decision: 'decision', Coordination: 'coordination', Operation: 'operation' });
export const TaskKind = Object.freeze({ Research: 'research', Analysis: 'analysis', Design: 'design', Content: 'content', Code: 'code', Test: 'test', Review: 'review', Deploy: 'deploy', Manual: 'manual', Integration: 'integration' });
export const AssetStatus = Object.freeze({ Candidate: 'candidate', Confirmed: 'confirmed', Rejected: 'rejected', Archived: 'archived', Stale: 'stale', Disputed: 'disputed', Superseded: 'superseded' });
export const RunnerStatus = Object.freeze({ Queued: 'queued', Running: 'running', Succeeded: 'succeeded', Failed: 'failed', Cancelled: 'cancelled', Partial: 'partial' });
export const MemoryAuthority = Object.freeze({ UserConfirmed: 'user_confirmed', SystemConfirmed: 'system_confirmed', AiDraft: 'ai_draft', Imported: 'imported', CodexMemoryHint: 'codex_memory_hint' });
export const Freshness = Object.freeze({ Current: 'current', Stale: 'stale', Disputed: 'disputed', Superseded: 'superseded', Unknown: 'unknown' });
export const ToolType = Object.freeze({ BuiltIn: 'built_in', Cli: 'cli', Api: 'api', Link: 'link', McpStdio: 'mcp_stdio', McpHttp: 'mcp_http', DockerCompose: 'docker_compose' });
export const TRACE_EVENTS = Object.freeze([
  'project.created', 'workflow.recommended', 'workflow.confirmed', 'node_contract.created', 'node_contract.confirmed',
  'assist.requested', 'assist.context_pack.generated', 'assist.questions.generated', 'assist.options.generated', 'assist.option.selected', 'assist.draft.applied', 'assist.rejected',
  'memory.sufficiency.checked', 'memory.manifest.generated', 'memory.conflict.detected', 'runner_memory_candidate.created', 'runner_memory_candidate.applied',
  'context_pack.generated', 'context_pack.confirmed', 'node_run.queued', 'node_run.started', 'node_run.approval.consumed', 'runner.invoked', 'runner.output', 'runner.raw_event',
  'runner.completed', 'runner.failed', 'runner.cancelled', 'file.snapshot.before', 'file.snapshot.after', 'file.changed',
  'git.diff.captured', 'git.branch.created', 'git.commit.created', 'git.pr.created', 'test.started', 'test.completed',
  'asset_candidate.created', 'asset.confirmed', 'asset.rejected', 'decision.proposed', 'decision.accepted', 'digest.generated', 'digest.confirmed',
  'node.completed', 'node.blocked', 'human.reviewed', 'tool.health.checked',
  'integration.checked', 'integration.synced', 'integration.degraded',
  'agent_session.created', 'agent_session.submission.created',
  'change_proposal.created', 'change_proposal.approved', 'change_proposal.rejected', 'change_proposal.applied'
  ,'setup.mode.updated', 'setup.completed', 'github.app.configured', 'github.account.connected',
  'github.installation.synced', 'github.webhook.received', 'codex.authenticated', 'codex.profile.created',
  'codex.probe.completed', 'workflow.layout.saved', 'node.workspace.updated', 'file.saved',
  'assist.session.created', 'assist.session.forked', 'assist.native_thread.orphaned', 'assist.session.deleted', 'assist.session.restored_deleted', 'assist.session.purged',
  'assist.message.created', 'assist.action.confirmed', 'assist.action.rejected', 'assist.action.failed'
  ,'git.push.created', 'project.intake.updated', 'project.source.imported', 'project.activated', 'project.workspace.migrated',
  'project.trashed', 'project.restored', 'change_proposal.deferred', 'runtime_approval.decided',
  'github.repository.created',
  'config_revision.activated',
  'assist.turn.created', 'assist.turn.completed', 'assist.turn.interrupted', 'assist.review.updated', 'terminal.session.created', 'terminal.session.completed',
  'mcp.client.created', 'mcp.client.revoked',
  'workflow.generation.queued', 'workflow.generation.completed', 'workflow.generation.failed', 'workflow.migration.completed',
  'repository.connection.created', 'repository.target.updated', 'delivery.policy.approved', 'delivery.started', 'delivery.completed', 'delivery.failed',
  'delivery.pull_request.ready', 'delivery.pull_request.merged',
  'assist.scope.invalidated'
  ,'project.invitation.created', 'project.invitation.accepted', 'project.invitation.revoked', 'project.membership.revoked',
  'repository.deletion_intent.created', 'repository.deletion_intent.consented', 'repository.deletion_intent.confirmed', 'repository.deleted', 'repository.deletion.rejected', 'repository.deletion.reconciled',
  'exchange.request.created', 'exchange.request.approved', 'exchange.request.revoked', 'exchange.context_pack.created'
]);
