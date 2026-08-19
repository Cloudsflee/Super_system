import Ajv from 'ajv';

const idempotency = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$' };
const revision = { type: 'integer', minimum: 1 };
const closed = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const looseObject = { type: 'object', additionalProperties: true };
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const id = { type: 'string', minLength: 1, maxLength: 256 };
const timestamp = { type: 'string', minLength: 1, maxLength: 64 };
const sha256 = { type: 'string', pattern: '^[a-fA-F0-9]{64}$' };

// Response schemas are intentionally closed at the command boundary. Nested
// metadata/config/result objects remain provider-owned and are therefore
// opaque objects; redaction runs before these schemas are applied.
const actor = closed({ id, kind: { enum: ['system', 'user', 'service', 'agent'] }, display_name: { type: 'string' }, status: { enum: ['active', 'suspended', 'revoked'] }, metadata: looseObject, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'kind', 'display_name', 'status', 'revision']);
const team = closed({ id, name: { type: 'string' }, status: { enum: ['active', 'suspended', 'archived'] }, metadata: looseObject, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'name', 'status', 'revision']);
const session = closed({ id, subject_actor_id: id, effective_actor_id: id, status: { enum: ['active', 'revoked', 'expired'] }, expires_at: timestamp, last_seen_at: timestamp, revoked_at: nullableString, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'subject_actor_id', 'effective_actor_id', 'expires_at', 'revision']);
const operation = closed({ id, operation_id: id, command_id: { type: 'string' }, command_version: { type: 'integer' }, kind: { type: 'string' }, status: { type: 'string' }, resource_type: nullableString, resource_id: nullableString, project_id: nullableString, actor_id: nullableString, revision, accepted_revision: { type: 'integer' }, cursor: { type: 'integer', minimum: 0 }, result: looseObject, error_code: nullableString, error_details: looseObject, retryable: { type: 'boolean' }, audit_reference: nullableString, created_at: timestamp, updated_at: timestamp, completed_at: nullableString, cancellation_requested: { type: 'boolean' }, cancel_requested_at: nullableString, poll_uri: { type: 'string' }, events_uri: { type: 'string' }, replay_uri: { type: 'string' }, operation: looseObject, terminal: { type: 'boolean' }, replayed: { type: 'boolean' } }, ['id', 'operation_id', 'status', 'revision']);
const operationSummary = closed({ id, kind: { type: 'string' }, status: { type: 'string' }, resource_type: nullableString, resource_id: nullableString, accepted_revision: { type: 'integer' }, poll_uri: { type: 'string' }, events_uri: { type: 'string' }, replay_uri: { type: 'string' } }, ['id', 'kind', 'status']);
const operationEnvelope = closed({ operation_id: id, status: { type: 'string' }, revision, resource_type: nullableString, resource_id: nullableString, audit_reference: nullableString, terminal: { type: 'boolean' }, operation: operationSummary }, ['operation_id', 'status', 'revision']);
const membership = closed({ id, team_id: id, project_id: id, actor_id: id, role: { type: 'string' }, status: { type: 'string' }, actor: looseObject, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'actor_id', 'role', 'status', 'revision']);
const invitation = closed({ id, project_id: id, invitee_actor_id: nullableString, invitee_ref: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' }, expires_at: nullableString, accepted_by_actor_id: nullableString, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'role', 'status', 'revision']);
const aclEntry = closed({ id, project_id: id, principal_actor_id: nullableString, principal_team_id: nullableString, resource: { type: 'string' }, action: { type: 'string' }, effect: { enum: ['allow', 'deny'] }, policy_revision: { type: 'integer', minimum: 1 }, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'action', 'effect', 'policy_revision', 'revision']);
const credential = closed({ id, owner_actor_id: id, provider: { enum: ['codex', 'github', 'mcp'] }, scope: looseObject, status: { enum: ['rebind_required', 'pending', 'active', 'failed', 'revoked'] }, external_ref: { type: 'string' }, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'owner_actor_id', 'provider', 'status', 'revision']);
const profile = closed({ id, owner_actor_id: id, provider: { enum: ['codex', 'github', 'mcp'] }, label: { type: 'string' }, credential_ref_id: nullableString, config: looseObject, status: { enum: ['unprobed', 'probing', 'available', 'unavailable', 'rebind_required'] }, last_probe_at: nullableString, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'owner_actor_id', 'provider', 'label', 'status', 'revision']);
const project = closed({ id, team_id: id, owner_actor_id: id, name: { type: 'string' }, description: { type: 'string' }, status: { enum: ['draft', 'confirming', 'active', 'archived'] }, onboarding_state: { type: 'string' }, current_brief_revision: { type: 'integer', minimum: 0 }, confirmed_brief_revision: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }, confirmed_brief_hash: { type: 'string' }, current_workflow_revision: { type: 'integer', minimum: 0 }, metadata: looseObject, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'team_id', 'owner_actor_id', 'name', 'status', 'revision']);
const intake = closed({ id, project_id: id, status: { enum: ['collecting', 'submitted', 'processing', 'ready', 'failed', 'cancelled'] }, mode: { enum: ['brainstorm', 'existing'] }, source_kind: { type: 'string' }, source_revision: { type: 'string' }, source_hash: { type: 'string' }, result: looseObject, error_code: { type: 'string' }, attempt: { type: 'integer', minimum: 0 }, revision, operation_id: nullableString, created_at: timestamp, updated_at: timestamp, completed_at: nullableString }, ['id', 'project_id', 'status', 'mode', 'revision']);
const briefRevision = closed({ id, brief_id: id, project_id: id, revision, content: looseObject, content_sha256: { type: 'string' }, template: { type: 'string' }, created_at: timestamp }, ['id', 'project_id', 'revision', 'content', 'content_sha256']);
const brief = closed({ id, project_id: id, status: { enum: ['draft', 'confirming', 'confirmed'] }, current_revision: { type: 'integer', minimum: 0 }, confirmed_revision: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }, confirmed_hash: { type: 'string' }, revision, current: { anyOf: [briefRevision, { type: 'null' }] }, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'status', 'current_revision', 'revision']);
const repositoryConnection = closed({ id, project_id: id, provider: { type: 'string' }, credential_ref_id: nullableString, status: { enum: ['pending', 'ready', 'faulted', 'archived'] }, source_kind: { type: 'string' }, source_revision: { type: 'string' }, source_hash: { type: 'string' }, read_only: { type: 'boolean' }, fault_code: { type: 'string' }, metadata: looseObject, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'status', 'revision']);
const repositoryTarget = closed({ id, connection_id: id, name: { type: 'string' }, branch: { type: 'string' }, remote_ref: { type: 'string' }, expected_head_sha: { type: 'string' }, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'connection_id', 'name', 'revision']);
const repositoryLine = closed({ id, project_id: id, target_id: id, line_kind: { type: 'string' }, status: { enum: ['pending', 'ready', 'faulted', 'recovering', 'removed'] }, source_revision: { type: 'string' }, source_hash: { type: 'string' }, expected_head_sha: { type: 'string' }, fault_code: { type: 'string' }, fault: looseObject, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'target_id', 'status', 'revision']);
const repositoryWorkspace = closed({ id, project_id: id, line_id: id, status: { enum: ['requested', 'provisioning', 'ready', 'locked', 'released', 'orphaned'] }, relative_path: { type: 'string' }, owner_operation_id: nullableString, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'line_id', 'status', 'revision']);
const repositoryLock = closed({ id, workspace_id: id, holder_operation_id: id, fencing_token: { type: 'string' }, status: { enum: ['active', 'released', 'expired'] }, expires_at: timestamp, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'workspace_id', 'holder_operation_id', 'status', 'revision']);
const workflow = closed({ id, project_id: id, status: { enum: ['draft', 'proposed', 'active', 'superseded', 'archived'] }, current_revision: { type: 'integer', minimum: 0 }, revision, current: { anyOf: [looseObject, { type: 'null' }] }, created_at: timestamp, updated_at: timestamp }, ['id', 'project_id', 'status', 'current_revision', 'revision']);
const workflowRevision = closed({ id, workflow_id: id, project_id: id, revision, graph: looseObject, graph_sha256: { type: 'string' }, layout: looseObject, layout_sha256: { type: 'string' }, source_brief_revision: { type: 'integer', minimum: 0 }, source_brief_hash: { type: 'string' }, proposal_id: nullableString, created_at: timestamp }, ['id', 'workflow_id', 'project_id', 'revision', 'graph', 'graph_sha256']);
const workflowGeneration = closed({ id, project_id: id, workflow_id: id, operation_id: nullableString, phase: { enum: ['queued', 'running', 'critic_pending', 'proposed', 'applied', 'rejected', 'failed', 'cancelled'] }, source_brief_revision: { type: 'integer', minimum: 0 }, source_brief_hash: { type: 'string' }, source_workflow_revision: { type: 'integer', minimum: 0 }, source_workflow_hash: { type: 'string' }, source_repository_revision: { type: 'integer', minimum: 0 }, source_repository_hash: { type: 'string' }, input: looseObject, input_sha256: { type: 'string' }, candidate: looseObject, candidate_sha256: { type: 'string' }, attempt: { type: 'integer', minimum: 1 }, retry_of_generation_id: nullableString, critic_receipt_id: nullableString, proposal_id: nullableString, error_code: { type: 'string' }, revision, created_at: timestamp, updated_at: timestamp, completed_at: nullableString }, ['id', 'project_id', 'workflow_id', 'phase', 'revision']);
const criticReceipt = closed({ id, generation_id: id, project_id: id, status: { enum: ['passed', 'rejected', 'failed'] }, candidate_sha256: { type: 'string' }, input_sha256: { type: 'string' }, issues: { type: 'array', items: looseObject }, issues_sha256: { type: 'string' }, policy_revision: { type: 'integer', minimum: 1 }, provider: { type: 'string' }, created_at: timestamp }, ['id', 'generation_id', 'project_id', 'status', 'candidate_sha256', 'input_sha256']);
const workflowProposal = closed({ id, generation_id: id, project_id: id, base_workflow_revision: { type: 'integer', minimum: 0 }, candidate: looseObject, candidate_sha256: { type: 'string' }, critic_receipt_id: id, proposal_sha256: { type: 'string' }, status: { enum: ['pending', 'applied', 'rejected', 'stale'] }, applied_workflow_revision: { type: 'integer', minimum: 0 }, revision, created_at: timestamp, updated_at: timestamp }, ['id', 'generation_id', 'project_id', 'status', 'revision']);
const outcomeRequirement = closed({ id, project_id: id, workflow_revision: { type: 'integer', minimum: 0 }, requirement_key: { type: 'string' }, rubric: looseObject, rubric_sha256: { type: 'string' }, revision, created_at: timestamp }, ['id', 'project_id', 'requirement_key', 'rubric', 'revision']);
const receipt = (properties = {}, required = []) => closed({ actor, team, membership, invitation, project, entry: aclEntry, credential, profile, session, operation: operationEnvelope, revision, replayed: { type: 'boolean' }, status: { type: 'string' }, ...properties }, required);

export const CLEAN_V2_SCHEMAS = Object.freeze({
  'setup.complete.v2': closed({ display_name: { type: 'string', minLength: 1, maxLength: 160 }, team_name: { type: 'string', minLength: 1, maxLength: 160 }, ttl_seconds: { type: 'integer', minimum: 300, maximum: 7776000 }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0, maximum: 0 } }, ['display_name', 'team_name']),
  'actor.create.v2': closed({ kind: { enum: ['service', 'agent'] }, display_name: { type: 'string', minLength: 1, maxLength: 160 }, metadata: { type: 'object', additionalProperties: true }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['kind', 'display_name']),
  'actor.update.v2': closed({ display_name: { type: 'string', minLength: 1, maxLength: 160 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'account.update.v2': closed({ display_name: { type: 'string', minLength: 1, maxLength: 160 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'actor.lifecycle.v2': closed({ reason: { type: 'string', maxLength: 200 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'actor.switch.v2': closed({ target_actor_id: { type: 'string', minLength: 1 }, effective_actor_id: { type: 'string', minLength: 1 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'session.create.v2': closed({ ttl_seconds: { type: 'integer', minimum: 300, maximum: 7776000 }, idempotency_key: idempotency, expected_revision: revision }),
  'session.lifecycle.v2': closed({ reason: { type: 'string', maxLength: 200 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'team.create.v2': closed({ name: { type: 'string', minLength: 1, maxLength: 160 }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['name']),
  'team.lifecycle.v2': closed({ status: { enum: ['active', 'suspended', 'archived'] }, idempotency_key: idempotency, expected_revision: revision }, ['status', 'expected_revision']),
  'membership.grant.v2': closed({ actor_id: { type: 'string', minLength: 1 }, role: { enum: ['owner', 'admin', 'member', 'observer', 'editor', 'runner', 'reviewer', 'viewer'] }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['actor_id', 'role']),
  'membership.status.v2': closed({ status: { enum: ['active', 'suspended', 'revoked', 'expired'] }, reason: { type: 'string', maxLength: 200 }, idempotency_key: idempotency, expected_revision: revision }, ['status', 'expected_revision']),
  'invitation.create.v2': closed({ invitee_actor_id: { type: 'string' }, actor_id: { type: 'string' }, invitee_ref: { type: 'string', maxLength: 256 }, role: { enum: ['owner', 'admin', 'editor', 'runner', 'reviewer', 'viewer'] }, expires_at: { anyOf: [{ type: 'string' }, { type: 'null' }] }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['role']),
  'invitation.lifecycle.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'acl.set.v2': closed({ id: { type: 'string' }, principal_actor_id: { type: 'string' }, principal_team_id: { type: 'string' }, actor_id: { type: 'string' }, team_id: { type: 'string' }, resource: { type: 'string', minLength: 1, maxLength: 160 }, action: { type: 'string', minLength: 1, maxLength: 120 }, effect: { enum: ['allow', 'deny'] }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['action', 'effect']),
  'credential.create.v2': closed({ provider: { enum: ['codex', 'github', 'mcp'] }, scope: { type: 'object', additionalProperties: true }, external_ref: { type: 'string', minLength: 1, maxLength: 256 }, origin: { type: 'string', maxLength: 80 }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['provider']),
  'credential.rebind.v2': closed({ proof: { type: 'string', minLength: 1, maxLength: 4096 }, idempotency_key: idempotency, expected_revision: revision }, ['proof', 'expected_revision']),
  'credential.rotate.v2': closed({ proof: { type: 'string', minLength: 1, maxLength: 4096 }, idempotency_key: idempotency, expected_revision: revision }, ['proof', 'expected_revision']),
  'credential.lifecycle.v2': closed({ reason: { type: 'string', maxLength: 200 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'profile.create.v2': closed({ provider: { enum: ['codex', 'github', 'mcp'] }, label: { type: 'string', minLength: 1, maxLength: 160 }, credential_ref_id: { type: 'string' }, credential_id: { type: 'string' }, config: { type: 'object', additionalProperties: true }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['provider', 'label']),
  'profile.probe.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'operation.cancel.v2': closed({ idempotency_key: idempotency, expected_revision: revision, reason: { type: 'string', maxLength: 200 } }),

  // P3 project, repository and workflow contracts.
  'project.id.v2': closed({ id }, ['id']),
  'project.create.v2': closed({ name: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', maxLength: 65536 }, team_id: { type: 'string' }, metadata: looseObject, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['name']),
  'project.update.v2': closed({ name: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', maxLength: 65536 }, metadata: looseObject, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'project.lifecycle.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'intake.submit.v2': closed({ mode: { enum: ['brainstorm', 'existing'] }, source: looseObject, content: looseObject, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'intake.lifecycle.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'brief.create.v2': closed({ content: looseObject, objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } }, template: { type: 'string', maxLength: 80 }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'brief.confirm.v2': closed({ brief_revision: revision, idempotency_key: idempotency, expected_revision: revision }, ['brief_revision', 'expected_revision']),
  'brief.preview.v2': closed({ brief_revision: { type: 'integer', minimum: 1 } }),
  'repository.connection.create.v2': closed({ provider: { type: 'string' }, source_kind: { type: 'string' }, source_locator: { type: 'string', maxLength: 512 }, source_revision: { type: 'string', maxLength: 160 }, source_hash: sha256, branch: { type: 'string', maxLength: 256 }, credential_ref_id: { type: 'string' }, read_only: { type: 'boolean' }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['provider']),
  'repository.connection.update.v2': closed({ source_kind: { type: 'string' }, source_locator: { type: 'string', maxLength: 512 }, source_revision: { type: 'string', maxLength: 160 }, source_hash: sha256, branch: { type: 'string', maxLength: 256 }, read_only: { type: 'boolean' }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'repository.target.create.v2': closed({ name: { type: 'string', minLength: 1, maxLength: 160 }, branch: { type: 'string', maxLength: 256 }, remote_ref: { type: 'string', maxLength: 512 }, expected_head_sha: { type: 'string', maxLength: 128 }, idempotency_key: idempotency, expected_revision: revision }, ['name', 'expected_revision']),
  'repository.line.reconcile.v2': closed({ source_revision: { type: 'string' }, source_hash: { type: 'string' }, expected_head_sha: { type: 'string' }, probe_status: { type: 'string' }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'repository.workspace.create.v2': closed({ line_id: id, relative_path: { type: 'string', maxLength: 512 }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['line_id']),
  'repository.workspace.lifecycle.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'workflow.revise.v2': closed({ graph: looseObject, nodes: { type: 'array', items: looseObject }, layout: looseObject, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'generation.start.v2': closed({ mode: { enum: ['initial', 'replan'] }, candidate: looseObject, provider: { type: 'string' }, idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'generation.lifecycle.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'critic.evaluate.v2': closed({ candidate: looseObject, status: { enum: ['passed', 'rejected', 'failed'] }, issues: { type: 'array', items: looseObject }, idempotency_key: idempotency, expected_revision: revision }, ['status', 'expected_revision']),
  'proposal.apply.v2': closed({ idempotency_key: idempotency, expected_revision: revision }, ['expected_revision']),
  'outcome.requirement.create.v2': closed({ requirement_key: { type: 'string', minLength: 1, maxLength: 160 }, rubric: looseObject, workflow_revision: { type: 'integer', minimum: 0 }, idempotency_key: idempotency, expected_revision: { type: 'integer', minimum: 0 } }, ['requirement_key']),

  // P1 query/input contracts.
  'operation.id.v2': closed({ id: id }, ['id']),
  'operation.events.query.v2': closed({ format: { const: 'json' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
  'setup.query.v2': closed({}),
  'account.query.v2': closed({}),
  'team.id.v2': closed({ id }, ['id']),

  // P2 query/list outputs.
  'setup.state.v2': closed({ needs_setup: { type: 'boolean' }, actor_count: { type: 'integer', minimum: 0 }, bootstrap_actor_id: id }, ['needs_setup', 'actor_count', 'bootstrap_actor_id']),
  'actor.list.v2': closed({ actors: { type: 'array', items: actor } }, ['actors']),
  'session.list.v2': closed({ sessions: { type: 'array', items: session } }, ['sessions']),
  'team.list.v2': closed({ teams: { type: 'array', items: team } }, ['teams']),
  'membership.list.v2': closed({ memberships: { type: 'array', items: membership } }, ['memberships']),
  'invitation.list.v2': closed({ invitations: { type: 'array', items: invitation } }, ['invitations']),
  'acl.list.v2': closed({ entries: { type: 'array', items: aclEntry } }, ['entries']),
  'credential.list.v2': closed({ credentials: { type: 'array', items: credential } }, ['credentials']),
  'profile.list.v2': closed({ profiles: { type: 'array', items: profile } }, ['profiles']),
  'project.list.v2': closed({ projects: { type: 'array', items: project } }, ['projects']),
  'project.receipt.v2': receipt({ project, intake, brief, workflow, operation: operationEnvelope }, []),
  'project.get.v2': receipt({ project, intake, brief, workflow }, ['project']),
  'intake.list.v2': closed({ intakes: { type: 'array', items: intake } }, ['intakes']),
  'intake.receipt.v2': receipt({ intake, operation: operationEnvelope }, []),
  'brief.list.v2': closed({ briefs: { type: 'array', items: briefRevision } }, ['briefs']),
  'brief.receipt.v2': receipt({ brief, revision_record: briefRevision, operation: operationEnvelope }, []),
  'repository.connection.list.v2': closed({ connections: { type: 'array', items: repositoryConnection } }, ['connections']),
  'repository.connection.receipt.v2': receipt({ connection: repositoryConnection, operation: operationEnvelope }, []),
  'repository.target.list.v2': closed({ targets: { type: 'array', items: repositoryTarget } }, ['targets']),
  'repository.target.receipt.v2': receipt({ target: repositoryTarget, operation: operationEnvelope }, []),
  'repository.line.list.v2': closed({ lines: { type: 'array', items: repositoryLine } }, ['lines']),
  'repository.line.receipt.v2': receipt({ line: repositoryLine, source_drift: { type: 'boolean' }, operation: operationEnvelope }, []),
  'repository.workspace.list.v2': closed({ workspaces: { type: 'array', items: repositoryWorkspace } }, ['workspaces']),
  'repository.workspace.receipt.v2': receipt({ workspace: repositoryWorkspace, lock: { anyOf: [repositoryLock, { type: 'null' }] }, operation: operationEnvelope }, []),
  'workflow.list.v2': closed({ workflows: { type: 'array', items: workflow } }, ['workflows']),
  'workflow.receipt.v2': receipt({ workflow, revision_record: workflowRevision, operation: operationEnvelope }, []),
  'generation.list.v2': closed({ generations: { type: 'array', items: workflowGeneration } }, ['generations']),
  'generation.receipt.v2': receipt({ generation: workflowGeneration, critic: { anyOf: [criticReceipt, { type: 'null' }] }, proposal: { anyOf: [workflowProposal, { type: 'null' }] }, operation: operationEnvelope }, []),
  'critic.receipt.v2': receipt({ critic: criticReceipt, generation: workflowGeneration, proposal: { anyOf: [workflowProposal, { type: 'null' }] }, operation: operationEnvelope }, []),
  'proposal.receipt.v2': receipt({ proposal: workflowProposal, workflow, operation: operationEnvelope }, []),
  'outcome.requirement.list.v2': closed({ requirements: { type: 'array', items: outcomeRequirement } }, ['requirements']),
  'outcome.requirement.receipt.v2': receipt({ requirement: outcomeRequirement, operation: operationEnvelope }, []),

  // P1/P2 receipts. These are data payloads inside the common API envelope.
  'operation.receipt.v2': operation,
  'event.replay.v2': closed({ events: { type: 'array', items: looseObject }, next_cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] }, terminal: { type: 'boolean' }, resource: closed({ id, type: { type: 'string' }, revision }, ['id', 'type', 'revision']) }, ['events', 'next_cursor', 'terminal', 'resource']),
  'resource.receipt.v2': receipt(),
  'setup.receipt.v2': receipt({ actor, team, membership, session, operation: operationEnvelope }, ['actor', 'team', 'membership', 'session', 'operation']),
  'actor.receipt.v2': receipt({ account: actor, actor, session, operation: operationEnvelope }, []),
  'session.receipt.v2': receipt({ session, operation: operationEnvelope }, []),
  'team.receipt.v2': receipt({ team, membership, operation: operationEnvelope }, []),
  'membership.receipt.v2': receipt({ membership, operation: operationEnvelope }, []),
  'invitation.receipt.v2': receipt({ invitation, operation: operationEnvelope }, []),
  'acl.receipt.v2': receipt({ entry: aclEntry, policy_revision: { type: 'integer', minimum: 1 }, operation: operationEnvelope }, []),
  'credential.receipt.v2': receipt({ credential, operation: operationEnvelope }, []),
  'profile.receipt.v2': receipt({ profile, operation: operationEnvelope }, [])
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: false });
const validators = new Map(Object.entries(CLEAN_V2_SCHEMAS).map(([id, schema]) => [id, ajv.compile({ ...schema, $id: id })]));

export function validateCleanV2(schemaId, value) {
  const validate = validators.get(String(schemaId));
  if (!validate) return { valid: false, errors: [{ keyword: 'schema', message: `unknown schema: ${schemaId}` }] };
  const valid = validate(value);
  return { valid: Boolean(valid), errors: valid ? [] : (validate.errors || []).map((error) => ({ instancePath: error.instancePath, keyword: error.keyword, message: error.message, params: error.params })) };
}

export function assertCleanV2(schemaId, value) {
  const result = validateCleanV2(schemaId, value);
  if (!result.valid) {
    const error = new Error('schema_invalid');
    error.code = result.errors.some((item) => item.keyword === 'additionalProperties') ? 'unknown_field' : 'schema_invalid';
    error.status = 400;
    error.details = { schema_id: schemaId, errors: result.errors };
    throw error;
  }
  return value;
}

export const cleanV2Validator = Object.freeze({ validate: validateCleanV2, assert: assertCleanV2, schemas: CLEAN_V2_SCHEMAS });
