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
const p4Revision = { type: 'integer', minimum: 0 };
const p4String = { type: 'string' };
const p4StringArray = { type: 'array', items: p4String, uniqueItems: true };
const p4Items = { type: 'array', items: looseObject };
const p4Operation = { anyOf: [looseObject, { type: 'null' }] };
const p4Mutation = (properties = {}, required = []) => closed({ ...properties, idempotency_key: idempotency, expected_revision: p4Revision }, [...required, 'idempotency_key', 'expected_revision']);
const p4List = (name) => closed({ [name]: p4Items }, [name]);
const p4DomainReceipt = (name, extra = {}) => closed({ [name]: looseObject, operation: p4Operation, replayed: { type: 'boolean' }, ...extra }, [name]);
const p5StringArray = { type: 'array', items: id, uniqueItems: true };
const p5Mutation = (properties = {}, required = []) => closed({ ...properties, idempotency_key: idempotency, expected_revision: p4Revision }, [...required, 'idempotency_key', 'expected_revision']);
const p5Query = (properties = {}, required = []) => closed(properties, required);
const p5List = (name) => closed({ [name]: { type: 'array', items: looseObject } }, [name]);
const p5Receipt = (name, extra = {}) => closed({ [name]: looseObject, operation: p4Operation, replayed: { type: 'boolean' }, ...extra }, [name]);
const p6Mutation = p5Mutation;
const p6Query = p5Query;
const p6List = p5List;
const p6Receipt = p5Receipt;
const p7Mutation = p5Mutation;
const p7Query = p5Query;
const p7List = p5List;
const p7Receipt = p5Receipt;
const p8Mutation = p5Mutation;
const p8Query = p5Query;
const p8List = p5List;
const p8Receipt = p5Receipt;
const p8Status = { type: 'string', minLength: 1, maxLength: 80 };
const p8Checks = { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } };

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

  // P4 Context, Projection, MCP, Exchange and Gateway contracts. Every
  // command boundary is closed; named metadata and domain payloads remain
  // owner-defined objects behind their explicit top-level fields.
  'context.project.query.v2': closed({ project_id: id }, ['project_id']),
  'context.search.query.v2': closed({ project_id: id, q: p4String, query: p4String, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['project_id']),
  'context.read.query.v2': closed({ project_id: id, node_id: id, version_id: id }, ['project_id', 'node_id']),
  'context.node.query.v2': closed({ project_id: id, node_id: id, version_id: id }, ['project_id', 'node_id']),
  'context.pack.query.v2': closed({ project_id: id, pack_id: id }, ['project_id', 'pack_id']),
  'context.events.query.v2': closed({ project_id: id, job_id: id, cursor: { anyOf: [{ type: 'integer', minimum: 0 }, p4String] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, format: { const: 'json' } }, ['project_id', 'job_id']),
  'context.job.query.v2': closed({ project_id: id, job_id: id }, ['project_id', 'job_id']),
  'context.source.create.v2': p4Mutation({ project_id: id, source_type: p4String, kind: p4String, title: p4String, name: p4String, canonical_uri: p4String, uri: p4String, path: p4String, content: p4String, body: p4String, sensitivity: p4String, metadata: looseObject, media_type: p4String, adapter: p4String, source_revision: p4String }, ['project_id']),
  'context.policy.update.v2': p4Mutation({ project_id: id, policy: looseObject, pinned_node_ids: p4StringArray, excluded_node_ids: p4StringArray, source_allowlist: p4StringArray, sensitivity_max: p4String, freshness: p4String }, ['project_id']),
  'context.selection.create.v2': p4Mutation({ project_id: id, query: p4String, token_budget: { type: 'integer', minimum: 256, maximum: 128000 }, retrieval_plan: looseObject, node_ids: p4StringArray, mandatory_node_ids: p4StringArray }, ['project_id']),
  'context.pack.create.v2': p4Mutation({ project_id: id, selection_id: id, require_authoritative: { type: 'boolean' }, grant_id: id, scope: looseObject }, ['project_id']),
  'context.rebuild.v2': p4Mutation({ project_id: id, mode: { enum: ['full', 'incremental', 'index_rebuild'] }, defer: { type: 'boolean' }, retry_of_job_id: id }, ['project_id']),
  'context.job.mutation.v2': p4Mutation({ project_id: id, job_id: id, mode: p4String }, ['project_id', 'job_id']),
  'mcp.rpc.v2': closed({ jsonrpc: { const: '2.0' }, id: { anyOf: [p4String, { type: 'integer' }, { type: 'null' }] }, method: p4String, params: looseObject }, ['jsonrpc', 'method']),
  'mcp.list.query.v2': closed({ project_id: id }),
  'mcp.client.create.v2': p4Mutation({ name: p4String, transport: { enum: ['http', 'stdio'] }, endpoint: p4String, ttl_seconds: { type: 'integer', minimum: 300, maximum: 31622400 }, scope: looseObject, project_ids: p4StringArray, tools: p4StringArray }, ['name']),
  'mcp.client.mutation.v2': p4Mutation({ id, client_id: id }),
  'exchange.request.create.v2': p4Mutation({ project_id: id, source_project_id: id, source_project: id, target_project_id: id, target_project: id, ttl_seconds: { type: 'integer', minimum: 60, maximum: 31622400 }, scope: looseObject, project_ids: p4StringArray, tools: p4StringArray, actions: p4StringArray, resources: p4StringArray }, ['source_project_id', 'target_project_id']),
  'exchange.approval.v2': p4Mutation({ id, request_id: id, side: { enum: ['source', 'target'] }, approver_side: { enum: ['source', 'target'] }, reason: p4String }),
  'exchange.grant.mutation.v2': p4Mutation({ id, grant_id: id, reason: p4String }),
  'exchange.pack.create.v2': p4Mutation({ id, grant_id: id, selection_id: id, require_authoritative: { type: 'boolean' } }),
  'gateway.forward.v2': closed({ name: p4String, command: p4String, tool: p4String, command_id: p4String, arguments: looseObject, args: looseObject, mcp_token: p4String }),
  'gateway.receipt.query.v2': closed({ id }, ['id']),
  'context.sources.v2': p4List('sources'),
  'context.source.receipt.v2': p4DomainReceipt('source'),
  'context.map.v2': closed({ schema_version: p4String, project_id: id, root_uri: p4String, nodes: p4Items, edges: p4Items, index: looseObject }, ['schema_version', 'project_id', 'nodes', 'edges', 'index']),
  'context.search.v2': p4List('results'),
  'context.node.v2': looseObject,
  'context.versions.v2': p4List('versions'),
  'context.policy.v2': closed({ project_id: id, revision: p4Revision, hash: sha256, policy: looseObject, operation: p4Operation, replayed: { type: 'boolean' } }, ['project_id', 'revision', 'hash', 'policy']),
  'context.selections.v2': p4List('selections'),
  'context.selection.receipt.v2': p4DomainReceipt('selection'),
  'context.packs.v2': p4List('packs'),
  'context.pack.v2': looseObject,
  'context.pack.receipt.v2': p4DomainReceipt('pack', { grant: looseObject }),
  'context.status.v2': looseObject,
  'context.jobs.v2': p4List('jobs'),
  'context.job.v2': looseObject,
  'mcp.rpc.response.v2': closed({ jsonrpc: { const: '2.0' }, id: { anyOf: [p4String, { type: 'integer' }, { type: 'null' }] }, result: looseObject, error: looseObject, request_id: id }, ['jsonrpc', 'id']),
  'mcp.tools.v2': p4List('tools'),
  'mcp.clients.v2': p4List('clients'),
  'mcp.client.receipt.v2': p4DomainReceipt('client', { token: p4String, protocol_version: p4String }),
  'exchange.requests.v2': p4List('requests'),
  'exchange.request.receipt.v2': p4DomainReceipt('request'),
  'exchange.approval.receipt.v2': p4DomainReceipt('request', { grant: { anyOf: [looseObject, { type: 'null' }] } }),
  'exchange.grants.v2': p4List('grants'),
  'exchange.grant.receipt.v2': p4DomainReceipt('grant'),
  'gateway.forward.receipt.v2': closed({ result: looseObject, receipt: looseObject }, ['result', 'receipt']),
  'gateway.receipt.v2': closed({ id, gateway_id: id, nonce_hash: sha256, command_id: p4String, request_hash: sha256, response_hash: sha256, decision: p4String, operation_id: nullableString, created_at: timestamp }, ['id', 'gateway_id', 'nonce_hash', 'command_id', 'request_hash', 'response_hash', 'decision', 'created_at']),

  // P5 Assist, Files, Interaction, Terminal and Windows Bridge contracts.
  // Provider payloads remain opaque only below explicitly named fields.
  'assist.sessions.query.v2': p5Query({ project_id: id, status: p4String }),
  'assist.session.query.v2': p5Query({ id, session_id: id }, ['session_id']),
  'assist.session.create.v2': p5Mutation({ project_id: id, scope: { enum: ['project', 'workflow', 'workstream', 'task'] }, scope_id: id, context_pack_id: id, profile_id: id, repository_workspace_id: id }, ['project_id', 'scope', 'scope_id', 'context_pack_id', 'profile_id']),
  'assist.session.mutation.v2': p5Mutation({ session_id: id, reason: { type: 'string', maxLength: 500 } }, ['session_id']),
  'assist.turn.create.v2': p5Mutation({ session_id: id, message: { type: 'string', minLength: 1, maxLength: 262144 }, goal: looseObject, references: p5StringArray, defer: { type: 'boolean' }, fixture: looseObject }, ['session_id', 'message']),
  'assist.turn.mutation.v2': p5Mutation({ turn_id: id, message: { type: 'string', maxLength: 262144 }, reason: { type: 'string', maxLength: 500 }, fixture: looseObject }, ['turn_id']),
  'assist.events.query.v2': p5Query({ session_id: id, cursor: { anyOf: [{ type: 'integer', minimum: 0 }, p4String] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, format: { enum: ['json'] } }, ['session_id']),
  'assist.goal.update.v2': p5Mutation({ session_id: id, goal: looseObject }, ['session_id', 'goal']),
  'assist.reference.create.v2': p5Mutation({ session_id: id, reference_type: p4String, reference_id: id, reference_revision: { type: 'integer', minimum: 0 }, reference_hash: sha256, metadata: looseObject }, ['session_id', 'reference_type', 'reference_id']),
  'assist.sessions.v2': p5List('sessions'),
  'assist.session.v2': looseObject,
  'assist.session.receipt.v2': p5Receipt('session'),
  'assist.turn.receipt.v2': p5Receipt('turn'),
  'assist.goal.v2': closed({ goal: { anyOf: [looseObject, { type: 'null' }] }, operation: p4Operation, replayed: { type: 'boolean' } }, ['goal']),
  'assist.references.v2': closed({ references: { type: 'array', items: looseObject }, operation: p4Operation, replayed: { type: 'boolean' } }, ['references']),

  'files.query.v2': p5Query({ project_id: id, path: p4String, workspace_id: id }, ['project_id']),
  'files.v2': p5List('files'),
  'file.content.v2': looseObject,
  'attachment.query.v2': p5Query({ project_id: id, attachment_id: id }, ['attachment_id']),
  'attachment.create.v2': p5Mutation({ project_id: id, session_id: id, filename: { type: 'string', minLength: 1, maxLength: 240 }, media_type: { type: 'string', minLength: 1, maxLength: 160 }, content_base64: { type: 'string', maxLength: 13981016 }, content_sha256: sha256 }, ['project_id', 'filename', 'content_base64']),
  'attachment.lifecycle.v2': p5Mutation({ attachment_id: id }, ['attachment_id']),
  'attachments.v2': p5List('attachments'),
  'attachment.receipt.v2': p5Receipt('attachment'),
  'attachment.content.v2': looseObject,
  'change.batch.query.v2': p5Query({ project_id: id, batch_id: id }, ['batch_id']),
  'change.batch.create.v2': p5Mutation({ project_id: id, workspace_id: id, assist_turn_id: id, changes: { type: 'array', minItems: 1, maxItems: 100, items: closed({ path: { type: 'string', minLength: 1, maxLength: 1024 }, action: { enum: ['create', 'replace', 'delete'] }, content: { type: 'string', maxLength: 1048576 }, content_base64: { type: 'string', maxLength: 1398104 }, before_sha256: sha256 }, ['path', 'action']) } }, ['project_id', 'workspace_id', 'changes']),
  'change.batch.mutation.v2': p5Mutation({ batch_id: id }, ['batch_id']),
  'change.batches.v2': p5List('batches'),
  'change.batch.v2': looseObject,
  'change.batch.receipt.v2': p5Receipt('batch'),

  'interaction.query.v2': p5Query({ project_id: id, status: p4String }),
  'approval.create.v2': p5Mutation({ project_id: id, operation_id: id, assist_turn_id: id, action: { type: 'string', minLength: 1, maxLength: 160 }, request: looseObject, ttl_seconds: { type: 'integer', minimum: 1, maximum: 86400 } }, ['project_id', 'action']),
  'approval.decide.v2': p5Mutation({ approval_id: id, decision: { enum: ['approved', 'rejected'] }, reason: { type: 'string', maxLength: 500 } }, ['approval_id', 'decision']),
  'approval.lifecycle.v2': p5Mutation({ approval_id: id }, ['approval_id']),
  'approvals.v2': p5List('approvals'),
  'approval.receipt.v2': p5Receipt('approval'),
  'user.input.create.v2': p5Mutation({ project_id: id, operation_id: id, assist_turn_id: id, prompt_summary: { type: 'string', minLength: 1, maxLength: 1000 }, input_schema: looseObject, ttl_seconds: { type: 'integer', minimum: 1, maximum: 86400 } }, ['project_id', 'prompt_summary']),
  'user.input.answer.v2': p5Mutation({ input_id: id, response: looseObject }, ['input_id', 'response']),
  'user.input.lifecycle.v2': p5Mutation({ input_id: id }, ['input_id']),
  'user.inputs.v2': p5List('inputs'),
  'user.input.receipt.v2': p5Receipt('input'),
  'proposal.create.v2': p5Mutation({ project_id: id, operation_id: id, assist_turn_id: id, proposal_type: p4String, target_type: p4String, target_id: id, target_revision: { type: 'integer', minimum: 0 }, payload: looseObject }, ['project_id', 'proposal_type', 'target_type', 'target_id', 'payload']),
  'proposal.mutation.p5.v2': p5Mutation({ proposal_id: id }, ['proposal_id']),
  'proposals.v2': p5List('proposals'),
  'proposal.p5.receipt.v2': p5Receipt('proposal'),

  'terminal.capabilities.query.v2': p5Query({}),
  'terminal.query.v2': p5Query({ project_id: id, terminal_id: id, cursor: { anyOf: [{ type: 'integer', minimum: 0 }, p4String] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, format: { enum: ['json'] } }),
  'terminal.open.v2': p5Mutation({ project_id: id, workspace_id: id, approval_id: id, assist_session_id: id, runtime: { enum: ['windows_native', 'linux_native'] }, cwd: { type: 'string', maxLength: 1024 }, cols: { type: 'integer', minimum: 20, maximum: 400 }, rows: { type: 'integer', minimum: 5, maximum: 200 } }, ['project_id', 'workspace_id', 'approval_id']),
  'terminal.action.v2': p5Mutation({ terminal_id: id, client_sequence: { type: 'integer', minimum: 1 }, data: { type: 'string', maxLength: 65536 }, cols: { type: 'integer', minimum: 20, maximum: 400 }, rows: { type: 'integer', minimum: 5, maximum: 200 }, signal: { enum: ['SIGINT'] } }, ['terminal_id']),
  'terminal.capabilities.v2': looseObject,
  'terminals.v2': p5List('terminals'),
  'terminal.v2': looseObject,
  'terminal.receipt.v2': p5Receipt('terminal', { lease: { anyOf: [looseObject, { type: 'null' }] } }),

  'bridge.query.v2': p5Query({ device_id: id }),
  'bridge.pair.v2': p5Mutation({ label: { type: 'string', minLength: 1, maxLength: 160 }, identity_public_key: p4String, transport_public_key: p4String, confirmation_code: { type: 'string', minLength: 6, maxLength: 12 }, transcript: looseObject, encrypted_secret: looseObject }, ['label']),
  'bridge.device.mutation.v2': p5Mutation({ device_id: id }, ['device_id']),
  'bridge.transfer.create.v2': p5Mutation({ device_id: id, direction: { enum: ['send', 'receive'] }, transfer_type: { enum: ['git_bundle', 'terminal_control'] }, repository_ref: p4String, head_sha: p4String, bundle_sha256: sha256, byte_length: { type: 'integer', minimum: 0, maximum: 1073741824 } }, ['device_id', 'direction', 'transfer_type']),
  'bridge.devices.v2': p5List('devices'),
  'bridge.device.receipt.v2': p5Receipt('device'),
  'bridge.transfer.receipt.v2': p5Receipt('transfer'),

  // P6 Runner and Execution contracts. Public payloads contain opaque refs,
  // bounded metadata and hashes; adapter credentials and host paths are absent.
  'runner.profile.query.v2': p6Query({ profile_id: id }),
  'runner.profile.create.v2': p6Mutation({ label: { type: 'string', minLength: 1, maxLength: 160 }, runner_type: { enum: ['docker', 'host', 'windows_bridge'] }, endpoint_ref: { type: 'string', maxLength: 256 }, image_digest: { type: 'string', maxLength: 71 }, bridge_device_id: id, capabilities: p5StringArray, limits: looseObject }, ['label', 'runner_type']),
  'runner.profile.update.v2': p6Mutation({ profile_id: id, label: { type: 'string', minLength: 1, maxLength: 160 }, endpoint_ref: { type: 'string', maxLength: 256 }, image_digest: { type: 'string', maxLength: 71 }, capabilities: p5StringArray, limits: looseObject }, ['profile_id']),
  'runner.profile.mutation.v2': p6Mutation({ profile_id: id }, ['profile_id']),
  'runner.profiles.v2': p6List('profiles'),
  'runner.profile.v2': closed({ profile: looseObject }, ['profile']),
  'runner.profile.receipt.v2': p6Receipt('profile'),

  'execution.project.query.v2': p6Query({ project_id: id, status: p4String }),
  'execution.create.v2': p6Mutation({ project_id: id, workflow_id: id, workflow_revision: revision, repository_workspace_id: id, context_pack_id: id, runner_profile_id: id, tasks: { type: 'array', maxItems: 100, items: looseObject }, plan: looseObject, input_refs: { type: 'array', maxItems: 256, items: looseObject }, requires_approval: { type: 'boolean' }, check_ids: p5StringArray }, ['project_id', 'runner_profile_id']),
  'execution.query.v2': p6Query({ execution_id: id, cursor: { anyOf: [{ type: 'integer', minimum: 0 }, p4String] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, format: { enum: ['json'] } }),
  'execution.mutation.v2': p6Mutation({ execution_id: id }, ['execution_id']),
  'execution.replan.v2': p6Mutation({ execution_id: id, tasks: { type: 'array', maxItems: 100, items: looseObject }, plan: looseObject }, ['execution_id']),
  'execution.stage.replay.v2': p6Mutation({ execution_id: id, stage: { enum: ['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver'] }, generation: { type: 'integer', minimum: 1 }, checkpoint_token: { type: 'string', minLength: 32, maxLength: 256 }, workspace_hash: sha256, pins_hash: sha256 }, ['execution_id', 'stage', 'generation', 'checkpoint_token']),
  'executions.v2': p6List('executions'),
  'execution.v2': closed({ execution: looseObject }, ['execution']),
  'execution.receipt.v2': p6Receipt('execution'),
  'execution.attempts.v2': p6List('attempts'),
  'execution.checkpoints.v2': p6List('checkpoints'),

  // P7 Evidence, isolated Parser, Quality and deterministic Outcome contracts.
  // Public values are bounded metadata and hashes. Raw parser text, worker
  // paths, prompts and credentials are not members of these schemas.
  'parser.formats.query.v2': p7Query({ format_key: id, family: p4String, status: p4String }),
  'parser.formats.v2': p7List('formats'),
  'parser.run.query.v2': p7Query({ parser_run_id: id }, ['parser_run_id']),
  'parser.run.start.v2': p7Mutation({ asset_id: id, version_id: id, format_key: id, limits: looseObject, fixture: looseObject }, ['asset_id', 'version_id']),
  'parser.run.mutation.v2': p7Mutation({ parser_run_id: id, reason: { type: 'string', maxLength: 500 }, fixture: looseObject }, ['parser_run_id']),
  'parser.run.v2': closed({ parser_run: looseObject }, ['parser_run']),
  'parser.run.receipt.v2': p7Receipt('parser_run'),

  'asset.project.query.v2': p7Query({ project_id: id, status: p4String, asset_kind: p4String }, ['project_id']),
  'asset.query.v2': p7Query({ asset_id: id, version_id: id }, ['asset_id']),
  'asset.capture.v2': p7Mutation({ project_id: id, execution_id: id, logical_name: { type: 'string', minLength: 1, maxLength: 512 }, asset_kind: p4String, source_type: { enum: ['execution', 'attachment', 'file_ref', 'managed_output', 'parser', 'quality', 'manual'] }, source_ref: { type: 'string', minLength: 1, maxLength: 512 }, attachment_id: id, file_ref_id: id, relative_path: { type: 'string', maxLength: 1024 }, media_type: { type: 'string', maxLength: 160 }, content_base64: { type: 'string', maxLength: 34952536 }, content_sha256: sha256, metadata: looseObject }, ['project_id', 'logical_name', 'source_type', 'source_ref']),
  'asset.relation.create.v2': p7Mutation({ asset_id: id, from_version_id: id, to_asset_id: id, to_version_id: id, relation_type: { enum: ['derived_from', 'generated_by', 'contains', 'references', 'attests', 'supersedes', 'tests', 'changes'] }, execution_id: id, task_attempt_id: id, input_sha256: sha256, output_sha256: sha256, metadata: looseObject }, ['asset_id', 'from_version_id', 'to_asset_id', 'to_version_id', 'relation_type']),
  'asset.attestation.create.v2': p7Mutation({ asset_id: id, version_id: id, attestation_type: { type: 'string', minLength: 1, maxLength: 120 }, policy_revision: revision, statement: looseObject, signature: { type: 'string', maxLength: 4096 }, validity: { enum: ['valid', 'invalid', 'revoked', 'expired'] }, expires_at: timestamp }, ['asset_id', 'version_id', 'attestation_type', 'statement', 'validity']),
  'asset.tombstone.v2': p7Mutation({ asset_id: id, reason: { type: 'string', maxLength: 500 } }, ['asset_id']),
  'assets.v2': p7List('assets'),
  'asset.v2': closed({ asset: looseObject }, ['asset']),
  'asset.receipt.v2': p7Receipt('asset'),
  'asset.versions.v2': p7List('versions'),
  'asset.content.v2': looseObject,
  'asset.relations.v2': p7List('relations'),
  'asset.relation.receipt.v2': p7Receipt('relation'),
  'asset.attestations.v2': p7List('attestations'),
  'asset.attestation.receipt.v2': p7Receipt('attestation'),
  'execution.evidence.query.v2': p7Query({ execution_id: id, cursor: { anyOf: [{ type: 'integer', minimum: 0 }, p4String] }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['execution_id']),
  'execution.evidence.v2': closed({ assets: p4Items, traces: p4Items, digests: p4Items, code_changes: p4Items, test_results: p4Items }, ['assets', 'traces', 'digests', 'code_changes', 'test_results']),
  'execution.traces.v2': p7List('traces'),
  'execution.digests.v2': p7List('digests'),
  'execution.code_changes.v2': p7List('code_changes'),
  'execution.test_results.v2': p7List('test_results'),

  'quality.list.query.v2': p7Query({ execution_id: id, status: p4String }, ['execution_id']),
  'quality.query.v2': p7Query({ quality_review_id: id, cursor: { anyOf: [{ type: 'integer', minimum: 0 }, p4String] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, format: { enum: ['json'] } }, ['quality_review_id']),
  'quality.start.v2': p7Mutation({ execution_id: id, asset_ids: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: id }, rubric: looseObject, threshold: { type: 'number', minimum: 0, maximum: 100 }, fixture: looseObject }, ['execution_id', 'asset_ids', 'rubric']),
  'quality.mutation.v2': p7Mutation({ quality_review_id: id, reason: { type: 'string', maxLength: 500 }, fixture: looseObject }, ['quality_review_id']),
  'quality.decision.v2': p7Mutation({ quality_review_id: id, decision: { enum: ['approved', 'rejected'] }, dimensions: { type: 'array', minItems: 1, maxItems: 20, items: closed({ key: { type: 'string', minLength: 1, maxLength: 120 }, score: { type: 'number', minimum: 0, maximum: 100 }, reasoning: { type: 'string', minLength: 1, maxLength: 2000 } }, ['key', 'score', 'reasoning']) }, reasoning: { type: 'string', minLength: 1, maxLength: 4000 }, report_sha256: sha256, input_sha256: sha256, rubric_sha256: sha256 }, ['quality_review_id', 'decision', 'dimensions', 'reasoning', 'report_sha256', 'input_sha256', 'rubric_sha256']),
  'quality.reviews.v2': p7List('quality_reviews'),
  'quality.review.v2': closed({ quality_review: looseObject }, ['quality_review']),
  'quality.review.receipt.v2': p7Receipt('quality_review'),
  'quality.report.v2': closed({ report: looseObject }, ['report']),

  'outcome.query.v2': p7Query({ execution_id: id }, ['execution_id']),
  'outcome.evaluate.v2': p7Mutation({ execution_id: id }, ['execution_id']),
  'outcome.waiver.create.v2': p7Mutation({ execution_id: id, requirement_id: id, reason: { type: 'string', minLength: 1, maxLength: 2000 }, expires_at: timestamp }, ['execution_id', 'reason']),
  'outcome.waiver.revoke.v2': p7Mutation({ waiver_id: id, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, ['waiver_id', 'reason']),
  'outcome.v2': closed({ evaluation: { anyOf: [looseObject, { type: 'null' }] }, waivers: p4Items }, ['evaluation', 'waivers']),
  'outcome.receipt.v2': p7Receipt('evaluation', { waivers: p4Items }),
  'outcome.waiver.receipt.v2': p7Receipt('waiver'),

  // P8 Delivery, GitHub, Deployment, Backup, Importer and Operations
  // contracts. Every transport-level object is closed; provider-owned
  // metadata remains opaque only inside explicitly named fields.
  'delivery.policy.query.v2': p8Query({ project_id: id }, ['project_id']),
  'delivery.policy.create.v2': p8Mutation({ project_id: id, name: { type: 'string', minLength: 1, maxLength: 120 }, required_checks: p8Checks, approval_policy: looseObject }, ['project_id', 'name', 'required_checks']),
  'delivery.policies.v2': p8List('policies'),
  'delivery.policy.receipt.v2': p8Receipt('policy'),
  'delivery.list.query.v2': p8Query({ project_id: id, status: p8Status, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['project_id']),
  'delivery.get.query.v2': p8Query({ delivery_id: id }, ['delivery_id']),
  'delivery.submit.v2': p8Mutation({ execution_id: id, policy_id: id, repository_target_id: id, target_head_sha: { type: 'string', minLength: 7, maxLength: 128 } }, ['execution_id', 'policy_id', 'repository_target_id']),
  'delivery.intent.create.v2': p8Mutation({ delivery_id: id, patch_cas_sha256: sha256, patch_sha256: sha256, base_sha: { type: 'string', minLength: 7, maxLength: 128 }, head_sha: { type: 'string', minLength: 7, maxLength: 128 }, required_checks: p8Checks, approval_sha256: sha256 }, ['delivery_id', 'patch_cas_sha256', 'patch_sha256', 'head_sha']),
  'delivery.intent.ready.v2': p8Mutation({ delivery_id: id, required_checks: p8Checks, approval_id: id }, ['delivery_id', 'approval_id']),
  'delivery.intent.merge.v2': p8Mutation({ delivery_id: id, approval_id: id, expected_base_sha: { type: 'string', minLength: 7, maxLength: 128 }, expected_head_sha: { type: 'string', minLength: 7, maxLength: 128 } }, ['delivery_id', 'approval_id', 'expected_base_sha', 'expected_head_sha']),
  'delivery.reconcile.v2': p8Mutation({ delivery_id: id, reason: { type: 'string', maxLength: 500 } }, ['delivery_id']),
  'deliveries.v2': p8List('deliveries'),
  'delivery.v2': closed({ delivery: looseObject, intents: { type: 'array', items: looseObject }, events: { type: 'array', items: looseObject } }, ['delivery', 'intents', 'events']),
  'delivery.receipt.v2': p8Receipt('delivery', { intent: looseObject }),

  'github.repositories.query.v2': p8Query({ profile_id: id, installation_id: id, cursor: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['profile_id']),
  'github.repositories.v2': closed({ repositories: { type: 'array', items: looseObject }, next_cursor: nullableString }, ['repositories', 'next_cursor']),
  'github.webhook.v2': closed({ delivery_id: id, event: { type: 'string', minLength: 1, maxLength: 120 }, delivery_guid: { type: 'string', minLength: 1, maxLength: 200 }, payload_sha256: sha256 }, ['delivery_id', 'event', 'delivery_guid', 'payload_sha256']),
  'github.webhook.receipt.v2': closed({ accepted: { type: 'boolean' }, duplicate: { type: 'boolean' }, delivery_id: id, event_id: nullableString, status: p8Status }, ['accepted', 'duplicate', 'delivery_id', 'status']),

  'deployment.query.v2': p8Query({}),
  'deployment.candidate.query.v2': p8Query({ candidate_id: id }, ['candidate_id']),
  'deployment.candidate.create.v2': p8Mutation({ app_digest: sha256, broker_digest: sha256, runner_digest: sha256, parser_digest: sha256, bridge_identity: { type: 'string', minLength: 1, maxLength: 512 }, sbom_sha256: sha256, source_tree_sha256: sha256, lockfile_sha256: sha256, gate_fingerprint: sha256, compose_sha256: sha256, volume_manifest: looseObject, approval_id: id }, ['app_digest', 'broker_digest', 'runner_digest', 'parser_digest', 'bridge_identity', 'sbom_sha256', 'source_tree_sha256', 'lockfile_sha256', 'gate_fingerprint', 'compose_sha256', 'volume_manifest', 'approval_id']),
  'deployment.verify.v2': p8Mutation({ candidate_id: id, checks: { type: 'array', minItems: 1, maxItems: 100, items: looseObject }, viewport_evidence: { type: 'array', maxItems: 20, items: looseObject }, volume_manifest_sha256: sha256, approval_id: id }, ['candidate_id', 'checks', 'volume_manifest_sha256', 'approval_id']),
  'deployment.v2': closed({ active: { anyOf: [looseObject, { type: 'null' }] }, candidates: { type: 'array', items: looseObject } }, ['active', 'candidates']),
  'deployment.candidate.v2': closed({ candidate: looseObject, verifications: { type: 'array', items: looseObject } }, ['candidate', 'verifications']),
  'deployment.receipt.v2': p8Receipt('candidate', { verification: looseObject }),

  'backup.list.query.v2': p8Query({ limit: { type: 'integer', minimum: 1, maximum: 500 } }),
  'backup.create.v2': p8Mutation({ retention_class: { enum: ['permanent', 'standard', 'diagnostic'] }, components: looseObject, approval_id: id }, ['retention_class', 'components', 'approval_id']),
  'restore.prepare.v2': p8Mutation({ backup_id: id, approval_id: id, target_volume_ref: { type: 'string', minLength: 1, maxLength: 256 } }, ['backup_id', 'approval_id', 'target_volume_ref']),
  'system.reset.prepare.v2': p8Mutation({ approval_id: id, target_volume_ref: { type: 'string', minLength: 1, maxLength: 256 }, preserve_backups: { type: 'boolean' } }, ['approval_id', 'target_volume_ref']),
  'backups.v2': p8List('backups'),
  'backup.receipt.v2': p8Receipt('backup', { restore: looseObject, reset: looseObject }),

  'import.list.query.v2': p8Query({ status: p8Status, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
  'import.get.query.v2': p8Query({ import_id: id }, ['import_id']),
  'imports.v2': p8List('imports'),
  'import.v2': closed({ import: looseObject, checkpoints: { type: 'array', items: looseObject }, conflicts: { type: 'array', items: looseObject }, id_map_count: { type: 'integer', minimum: 0 } }, ['import', 'checkpoints', 'conflicts', 'id_map_count']),

  'operations.list.query.v2': p8Query({ project_id: id, status: p8Status, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
  'operations.replay.v2': p8Mutation({ operation_id: id }, ['operation_id']),
  'operations.v2': p8List('operations'),
  'cas.gc.plan.v2': p8Mutation({ cutoff: timestamp, limit: { type: 'integer', minimum: 1, maximum: 1000 } }),
  'cas.gc.apply.v2': p8Mutation({ plan: closed({ cutoff: timestamp, candidates: { type: 'array', maxItems: 1000, uniqueItems: true, items: sha256 }, protected_references_sha256: sha256, plan_sha256: sha256, count: { type: 'integer', minimum: 0, maximum: 1000 } }, ['cutoff', 'candidates', 'protected_references_sha256', 'plan_sha256', 'count']), approval_id: id }, ['plan', 'approval_id']),
  'cas.gc.plan.receipt.v2': closed({ plan: looseObject }, ['plan']),
  'cas.gc.apply.receipt.v2': closed({ receipt: looseObject, operation: p4Operation }, ['receipt']),

  // P1 query/input contracts.
  'operation.id.v2': closed({ id: id }, ['id']),
  'operation.events.query.v2': closed({ format: { const: 'json' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
  'project.events.query.v2': closed({ project_id: id, cursor: { type: 'string', minLength: 1, maxLength: 4096 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, format: { const: 'json' } }, ['project_id']),
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
  'event.replay.v2': closed({ events: { type: 'array', items: looseObject }, next_cursor: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }, { type: 'null' }] }, cursor_sequence: { type: 'integer', minimum: 0 }, cursor: { anyOf: [looseObject, { type: 'null' }] }, has_more: { type: 'boolean' }, terminal: { type: 'boolean' }, resource: closed({ id, type: { type: 'string' }, revision }, ['id', 'type', 'revision']) }, ['events', 'next_cursor', 'terminal', 'resource']),
  'project.event.replay.v2': closed({ events: { type: 'array', items: looseObject }, project_id: id, next_cursor: { type: 'string', minLength: 1 }, cursor_sequence: { type: 'integer', minimum: 0 }, has_more: { type: 'boolean' } }, ['events', 'project_id', 'next_cursor', 'cursor_sequence', 'has_more']),
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
