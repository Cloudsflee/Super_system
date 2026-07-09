export const ProjectStatus = Object.freeze({ Draft: 'draft', Active: 'active', Blocked: 'blocked', Completed: 'completed', Archived: 'archived' });
export const WorkspaceStatus = Object.freeze({ Draft: 'draft', Active: 'active', Blocked: 'blocked', NeedsReview: 'needs_review', Completed: 'completed', Archived: 'archived' });
export const WorkflowStatus = Object.freeze({ Draft: 'draft', Proposed: 'proposed', Confirmed: 'confirmed', Active: 'active', Completed: 'completed', Archived: 'archived' });
export const NodeStatus = Object.freeze({ Draft: 'draft', Ready: 'ready', Running: 'running', Blocked: 'blocked', NeedsReview: 'needs_review', Completed: 'completed', Skipped: 'skipped' });
export const NodeType = Object.freeze({ GoalDefinition: 'goal_definition', Research: 'research', Analysis: 'analysis', Execution: 'execution', Retrospective: 'retrospective' });
export const AssetStatus = Object.freeze({ Candidate: 'candidate', Confirmed: 'confirmed', Rejected: 'rejected', Archived: 'archived', Stale: 'stale', Disputed: 'disputed', Superseded: 'superseded' });
export const RunnerStatus = Object.freeze({ Queued: 'queued', Running: 'running', Succeeded: 'succeeded', Failed: 'failed', Cancelled: 'cancelled', Partial: 'partial' });
export const MemoryAuthority = Object.freeze({ UserConfirmed: 'user_confirmed', SystemConfirmed: 'system_confirmed', AiDraft: 'ai_draft', Imported: 'imported', CodexMemoryHint: 'codex_memory_hint' });
export const Freshness = Object.freeze({ Current: 'current', Stale: 'stale', Disputed: 'disputed', Superseded: 'superseded', Unknown: 'unknown' });
export const ToolType = Object.freeze({ BuiltIn: 'built_in', Cli: 'cli', Api: 'api', Link: 'link', McpStdio: 'mcp_stdio', McpHttp: 'mcp_http', DockerCompose: 'docker_compose' });
export const TRACE_EVENTS = Object.freeze([
  'project.created', 'workflow.recommended', 'workflow.confirmed', 'node_contract.created', 'node_contract.confirmed',
  'assist.requested', 'assist.context_pack.generated', 'assist.questions.generated', 'assist.options.generated', 'assist.option.selected', 'assist.draft.applied', 'assist.rejected',
  'memory.sufficiency.checked', 'memory.manifest.generated', 'memory.conflict.detected', 'runner_memory_candidate.created', 'runner_memory_candidate.applied',
  'context_pack.generated', 'context_pack.confirmed', 'node_run.queued', 'node_run.started', 'runner.invoked', 'runner.output', 'runner.raw_event',
  'runner.completed', 'runner.failed', 'runner.cancelled', 'file.snapshot.before', 'file.snapshot.after', 'file.changed',
  'git.diff.captured', 'git.branch.created', 'git.commit.created', 'git.pr.created', 'test.started', 'test.completed',
  'asset_candidate.created', 'asset.confirmed', 'asset.rejected', 'decision.proposed', 'decision.accepted', 'digest.generated', 'digest.confirmed',
  'node.completed', 'node.blocked', 'human.reviewed', 'tool.health.checked'
]);
