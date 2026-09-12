import fs from 'node:fs';
import { CandidateWorkspace } from './candidate-workspace.mjs';
import { executeHostCommand, hostInvocation } from './runner-adapters.mjs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { compileWorkflowToExecutionPlan } from './workflow-adapters.mjs';
import {
  appendAggregate, createOperation, priorResponse, requestHash, requireIdempotency,
  requirePrincipal, requireRevision, assertRevision, saveResponse, time
} from './p5-domain-helpers.mjs';
import { RUNNER_STAGES } from './runner-protocol.mjs';
import { profileSnapshotHash } from './runner-service.mjs';

const TERMINAL_EXECUTIONS = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_ATTEMPTS = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'external_result_unknown']);
const TRANSIENT = new Set(['runner_unavailable', 'runner_spawn_failed', 'runner_timeout', 'runner_deadline_exceeded', 'transient_failure']);
const CHECK_IDS = new Set(['node_test', 'git_diff_check']);
const execFileAsync = promisify(execFile);

export class CleanExecutionService {
  constructor({ db, events, operations, authorization, runner, projectWorkflow, assist, clock, config = {}, sleep = null, retryDelays = [1000, 4000] } = {}) {
    if (!db || !events || !operations || !authorization || !runner || !projectWorkflow) throw new TypeError('execution_service_dependencies_required');
    this.db = db; this.events = events; this.operations = operations; this.authorization = authorization; this.runner = runner;
    this.projectWorkflow = projectWorkflow; this.assist = assist; this.clock = clock; this.config = config;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); this.retryDelays = retryDelays; this.active = new Map();
    this.workspaceRoot = path.resolve(config.workspaceRoot || path.join(process.cwd(), '.ai-workspace', 'v3-clean', 'workspaces'));
    this.candidates = new CandidateWorkspace({ db, root: this.workspaceRoot, repository: projectWorkflow });
    this.taskRoot = path.join(this.workspaceRoot, '.p6-tasks'); this.replaySecret = String(config.cursorSecret || 'v3-clean-p6-replay');
    fs.mkdirSync(this.taskRoot, { recursive: true, mode: 0o700 });
  }

  list(projectId, _input = {}, principal) {
    this.assertProject(principal, 'read', projectId);
    return { executions: this.db.query('SELECT * FROM executions WHERE project_id=? ORDER BY updated_at DESC,id', [String(projectId)]).map(executionView) };
  }

  get(id, principal) { return executionView(this.executionRow(id, principal, 'read')); }

  eventsFor(id, input = {}, principal) {
    const row = this.executionRow(id, principal, 'read');
    return this.events.replay({ actorId: principal.actorId, projectId: row.project_id, aggregateType: 'execution', aggregateId: row.id, cursor: input.cursor || 0, limit: input.limit || 500 });
  }

  attemptsFor(id, _input = {}, principal) {
    const row = this.executionRow(id, principal, 'read');
    return { attempts: this.db.query('SELECT * FROM task_attempts WHERE execution_id=? ORDER BY generation,task_ordinal,attempt_no,id', [row.id]).map(attemptView) };
  }

  checkpointsFor(id, _input = {}, principal) {
    const row = this.executionRow(id, principal, 'read');
    return { checkpoints: this.db.query('SELECT * FROM execution_stage_checkpoints WHERE execution_id=? ORDER BY generation,stage_ordinal,id', [row.id]).map((item) => this.checkpointView(item)) };
  }

  async create(projectId, input = {}, principal) {
    requirePrincipal(principal); const project = this.assertProject(principal, 'run', projectId);
    const expected = requireRevision(input.expected_revision); assertRevision(project, expected); const key = requireIdempotency(input.idempotency_key);
    const pins = this.resolvePins(project, input, principal); const tasks = normalizePlanWithContracts(input.tasks || input.plan?.tasks || this.tasksFromWorkflow(pins.workflowRevisionRow));
    const plan = { schema_version: 'aiws.execution-plan.v1', tasks, requires_approval: Boolean(input.requires_approval ?? input.plan?.requires_approval), check_ids: normalizeChecks(input.check_ids || input.plan?.check_ids || []) };
    this.runner.cas?.policy?.assertSafe?.({ tasks: tasks.map(({ fixture: _fixture, ...task }) => task) });
    const planJson = canonicalJson(plan); const id = opaqueId('execution'); const now = time(this.clock);
    const hash = requestHash({ project_id: project.id, expected_revision: expected, pins: pins.hashes, plan });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.create', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const currentProject = tx.get('SELECT * FROM projects WHERE id=?', [project.id]); assertRevision(currentProject, expected);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.create', resourceType: 'execution', resourceId: id, projectId: project.id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO executions(id,project_id,workflow_id,workflow_revision,workflow_hash,brief_revision,brief_hash,repository_workspace_id,repository_revision,repository_hash,context_pack_id,context_pack_hash,runner_profile_id,runner_profile_revision,runner_profile_hash,parent_execution_id,replanned_from_stage,status,current_stage,generation,plan_json,plan_sha256,task_count,dependency_edge_count,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft','',1,?,?,?,?,?,?,?,?)`, [id, project.id, pins.workflow.id, pins.workflowRevision, pins.workflowHash, pins.briefRevision, pins.briefHash, pins.workspace.id, pins.repositoryRevision, pins.repositoryHash, pins.pack.id, pins.contextPackHash, pins.profile.id, pins.profile.revision, pins.runnerProfileHash, input.parent_execution_id || null, input.replanned_from_stage || '', planJson, sha256Hex(planJson), tasks.length, edgeCount(tasks), now, now, principal.actorId, principal.actorId]);
      this.insertInputs(tx, id, pins, input.input_refs || [], principal.actorId, now);
      const created = tx.get('SELECT * FROM executions WHERE id=?', [id]); this.appendExecution(tx, created, op.id, principal.actorId, 'execution.created', { execution_id: id }, now);
      this.operations.linkInTransaction(tx, op.id, [['execution', id], ['workflow', pins.workflow.id], ['context_pack', pins.pack.id], ['runner_profile', pins.profile.id]], now);
      const response = { execution: executionView(created), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.create', idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 201, now }); return response;
    });
  }

  async start(id, input = {}, principal) {
    const row = this.executionRow(id, principal, 'run'); const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const now = time(this.clock);
    const hash = requestHash({ execution_id: row.id, expected_revision: expected }); this.validatePins(row, principal);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.start', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM executions WHERE id=?', [row.id]); assertRevision(current, expected); if (current.status !== 'draft') throw stateConflict('execution is not a draft', current.status);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.start', resourceType: 'execution', resourceId: row.id, projectId: row.project_id, requestHash: hash, idempotencyKey: `op-${key}`, status: 'queued', now });
      const next = this.updateExecution(tx, current, { status: 'queued', current_stage: '' }, now, principal.actorId);
      this.appendExecution(tx, next, operation.id, principal.actorId, 'execution.queued', { execution_id: row.id, generation: next.generation }, now);
      this.operations.linkInTransaction(tx, operation.id, [['execution', row.id]], now);
      const response = { execution: executionView(next), operation: this.operations.summary(operation) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.start', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 202, now });
      tx.afterCommit(() => this.schedule(row.id, operation.id, 0, principal)); return response;
    });
  }

  async pause(id, input = {}, principal) {
    const row = this.executionRow(id, principal, 'run'); return this.control(row, input, principal, 'execution.pause', (current) => {
      if (!['queued', 'running'].includes(current.status)) throw stateConflict('execution cannot be paused', current.status);
      return { status: 'pause_requested' };
    }, 'execution.pause_requested');
  }

  async resume(id, input = {}, principal) {
    const row = this.executionRow(id, principal, 'run'); this.validatePins(row, principal); this.validateWorkspaceForResume(row);
    if (row.status === 'awaiting_approval') this.assertReviewApproved(row);
    const result = await this.control(row, input, principal, 'execution.resume', (current) => {
      if (!['paused', 'awaiting_approval'].includes(current.status)) throw stateConflict('execution cannot be resumed', current.status);
      const unknown = this.db.get("SELECT count(*) AS count FROM task_attempts WHERE execution_id=? AND generation=? AND status='external_result_unknown'", [current.id, current.generation]);
      if (Number(unknown.count)) throw new PlatformError('runner_result_unknown', 'execution requires stage replay after an unknown external result', {}, 409);
      return { status: 'queued' };
    }, 'execution.resumed', { queuedOperation: true });
    await this.settleSupersededTop(row.id, result.operation.operation_id, principal.actorId);
    const start = this.resumeStageIndex(row.id, row.generation);
    this.schedule(row.id, result.operation.operation_id, start, principal); return result;
  }

  async cancel(id, input = {}, principal) {
    const row = this.executionRow(id, principal, 'run');
    const result = await this.control(row, input, principal, 'execution.cancel', (current) => {
      if (TERMINAL_EXECUTIONS.has(current.status)) throw stateConflict('execution is terminal', current.status);
      return { status: 'cancelled', completed_at: time(this.clock) };
    }, 'execution.cancelled');
    const active = this.active.get(row.id); if (active) active.cancelled = true;
    await this.requestExecutionCancellation(row.id, active?.operationId || this.latestExecutionOperation(row.id)?.id, principal.actorId);
    await this.cancelRunningAttempts(row.id, principal.actorId);
    return result;
  }

  async replan(id, input = {}, principal) {
    const source = this.executionRow(id, principal, 'run'); const expected = requireRevision(input.expected_revision); assertRevision(source, expected);
    if (!['paused', 'failed', 'completed'].includes(source.status)) throw stateConflict('execution cannot be replanned', source.status);
    const project = this.assertProject(principal, 'run', source.project_id); const key = requireIdempotency(input.idempotency_key); const tasks = normalizePlanWithContracts(input.tasks || input.plan?.tasks || JSON.parse(source.plan_json).tasks);
    const plan = { ...JSON.parse(source.plan_json), ...input.plan, tasks }; delete plan.full_prompt;
    this.runner.cas?.policy?.assertSafe?.({ tasks: tasks.map(({ fixture: _fixture, ...task }) => task) });
    const planJson = canonicalJson(plan); const newId = opaqueId('execution'); const now = time(this.clock); const hash = requestHash({ execution_id: source.id, expected_revision: expected, plan });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.replan', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM executions WHERE id=?', [source.id]); assertRevision(current, expected);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.replan', resourceType: 'execution', resourceId: newId, projectId: source.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run(`INSERT INTO executions(id,project_id,workflow_id,workflow_revision,workflow_hash,brief_revision,brief_hash,repository_workspace_id,repository_revision,repository_hash,context_pack_id,context_pack_hash,runner_profile_id,runner_profile_revision,runner_profile_hash,parent_execution_id,replanned_from_stage,status,current_stage,generation,plan_json,plan_sha256,task_count,dependency_edge_count,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        SELECT ?,project_id,workflow_id,workflow_revision,workflow_hash,brief_revision,brief_hash,repository_workspace_id,repository_revision,repository_hash,context_pack_id,context_pack_hash,runner_profile_id,runner_profile_revision,runner_profile_hash,id,current_stage,'draft','',1,?,?,?,?,?,?,?,? FROM executions WHERE id=?`, [newId, planJson, sha256Hex(planJson), tasks.length, edgeCount(tasks), now, now, principal.actorId, principal.actorId, source.id]);
      const inputs = tx.query('SELECT * FROM execution_inputs WHERE execution_id=? ORDER BY ordinal', [source.id]); for (const item of inputs) tx.run('INSERT INTO execution_inputs(id,execution_id,ordinal,input_type,ref_id,ref_revision,ref_hash,metadata_json,metadata_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('execution_input'), newId, item.ordinal, item.input_type, item.ref_id, item.ref_revision, item.ref_hash, item.metadata_json, item.metadata_sha256, now, principal.actorId]);
      const created = tx.get('SELECT * FROM executions WHERE id=?', [newId]); this.appendExecution(tx, created, op.id, principal.actorId, 'execution.replanned', { execution_id: newId, parent_execution_id: source.id }, now);
      this.operations.linkInTransaction(tx, op.id, [['execution', newId], ['execution', source.id, 'parent']], now);
      const response = { execution: executionView(created), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.replan', idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 201, now }); return response;
    });
  }

  async replayStage(id, stage, input = {}, principal) {
    const row = this.executionRow(id, principal, 'run'); const target = String(stage || input.stage || ''); const stageIndex = RUNNER_STAGES.indexOf(target); if (stageIndex < 0) throw new PlatformError('stage_invalid', 'execution stage is invalid', {}, 422);
    const expected = requireRevision(input.expected_revision); const generation = Number(input.generation); if (!Number.isInteger(generation) || generation < 1 || generation !== Number(row.generation)) throw new PlatformError('replay_conflict', 'execution generation changed', { expected_generation: generation, actual_generation: row.generation }, 409);
    const checkpoint = this.db.get('SELECT * FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? AND stage=?', [row.id, generation, target]); if (!checkpoint) throw new PlatformError('checkpoint_not_found', 'execution checkpoint not found', {}, 404);
    if (sha256Hex(String(input.checkpoint_token || '')) !== checkpoint.checkpoint_token_hash) throw new PlatformError('checkpoint_token_invalid', 'checkpoint replay token is invalid', {}, 409);
    if (String(input.workspace_hash || '') !== checkpoint.workspace_sha256) throw new PlatformError('workspace_changed', 'replay workspace hash does not match the checkpoint', {}, 409);
    if (String(input.pins_hash || '') !== checkpoint.pins_sha256) throw new PlatformError('execution_pins_changed', 'replay pins hash does not match the checkpoint', {}, 409);
    if (!TERMINAL_EXECUTIONS.has(row.status) && !['paused', 'awaiting_approval'].includes(row.status)) throw stateConflict('execution must be stopped before replay', row.status);
    this.validatePins(row, principal); const workspaceHash = this.workspaceHash(row.repository_workspace_id, row); if (workspaceHash !== checkpoint.workspace_sha256) throw new PlatformError('workspace_changed', 'workspace no longer matches the checkpoint', { expected_hash: checkpoint.workspace_sha256, actual_hash: workspaceHash }, 409);
    const active = this.db.get("SELECT count(*) AS count FROM task_attempts WHERE execution_id=? AND status IN ('leased','running')", [row.id]); if (Number(active.count)) throw new PlatformError('runner_busy', 'execution still has an active runner job', {}, 409);
    const key = requireIdempotency(input.idempotency_key); const now = time(this.clock); const hash = requestHash({ execution_id: row.id, stage: target, generation, checkpoint_sha256: checkpoint.checkpoint_sha256, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.stage.replay', idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM executions WHERE id=?', [row.id]); assertRevision(current, expected); if (Number(current.generation) !== generation) throw new PlatformError('replay_conflict', 'execution generation changed', {}, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.stage.replay', resourceType: 'execution', resourceId: row.id, projectId: row.project_id, requestHash: hash, idempotencyKey: `op-${key}`, status: 'queued', now });
      const next = this.updateExecution(tx, current, { status: 'queued', current_stage: '', generation: generation + 1, error_code: '', handoff_manifest_json: '{}', handoff_manifest_sha256: '', completed_at: null }, now, principal.actorId);
      this.appendExecution(tx, next, operation.id, principal.actorId, 'execution.stage_replay_queued', { execution_id: row.id, stage: target, source_generation: generation, generation: generation + 1 }, now);
      this.operations.linkInTransaction(tx, operation.id, [['execution', row.id], ['execution_stage_checkpoint', checkpoint.id, 'replay_of']], now);
      const response = { execution: executionView(next), operation: this.operations.summary(operation) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.stage.replay', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 202, now });
      tx.afterCommit(() => this.schedule(row.id, operation.id, stageIndex, principal)); return response;
    });
  }

  async recoverPending() {
    const rows = this.db.query("SELECT * FROM executions WHERE status IN ('queued','running','pause_requested','awaiting_approval') ORDER BY created_at,id"); let recovered = 0;
    for (const row of rows) {
      const attempts = this.db.query("SELECT * FROM task_attempts WHERE execution_id=? AND status IN ('leased','running')", [row.id]);
      if (attempts.length) {
        const reconciled = await this.reconcileAfterRestart(row, attempts); recovered += 1;
        if (!reconciled) continue;
      }
      if (['queued', 'running'].includes(row.status)) {
        const operation = this.latestExecutionOperation(row.id); if (operation) { const principal = { actorId: row.updated_by_actor_id, effectiveActorId: row.updated_by_actor_id, scopes: ['*'] }; this.schedule(row.id, operation.id, this.resumeStageIndex(row.id, row.generation), principal); recovered += 1; }
      } else if (row.status === 'pause_requested') { await this.markPaused(row.id, this.latestExecutionOperation(row.id)?.id || null, row.updated_by_actor_id); recovered += 1; }
    }
    return recovered;
  }

  schedule(executionId, operationId, startIndex, principal) {
    if (this.active.has(String(executionId))) return;
    queueMicrotask(() => this.executeStages(executionId, operationId, startIndex, principal).catch(() => undefined));
  }

  async executeStages(executionId, operationId, startIndex = 0, principal) {
    if (this.active.has(String(executionId))) return this.get(executionId, principal);
    const control = { cancelled: false, operationId }; this.active.set(String(executionId), control);
    try {
      let top = this.operations.get(operationId); if (['queued', 'paused'].includes(top.status)) top = await this.operations.start(operationId, { expectedRevision: top.revision, actorId: top.actor_id, projectId: top.project_id });
      for (let index = startIndex; index < RUNNER_STAGES.length; index += 1) {
        let execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
        if (control.cancelled || execution.status === 'cancelled') return executionView(execution);
        if (execution.status === 'pause_requested') { await this.markPaused(executionId, operationId, principal.actorId); return this.get(executionId, principal); }
        const stage = RUNNER_STAGES[index]; const boundary = await this.beginStage(execution, stage, index, operationId, principal);
        const outcome = await this.runStage(stage, executionId, principal);
        execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
        if (control.cancelled || execution.status === 'cancelled') { await this.acknowledgeExecutionCancellation(executionId, operationId, principal.actorId); return executionView(execution); }
        if (outcome?.awaiting_approval) { await this.markAwaitingApproval(executionId, boundary.operation_id, operationId, principal.actorId); return this.get(executionId, principal); }
        await this.completeStage(executionId, stage, boundary.operation_id, outcome || {}, principal.actorId);
        execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
        if (execution.status === 'pause_requested') { await this.markPaused(executionId, operationId, principal.actorId); return this.get(executionId, principal); }
      }
      const latest = this.operations.get(operationId); if (!['succeeded', 'cancelled'].includes(latest.status)) await this.operations.succeed(operationId, { expectedRevision: latest.revision, actorId: latest.actor_id, projectId: latest.project_id, result: { execution_id: executionId, status: 'completed' } });
      return this.get(executionId, principal);
    } catch (error) {
      const current = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
      if (control.cancelled || current?.status === 'cancelled') { await this.acknowledgeExecutionCancellation(executionId, operationId, principal.actorId).catch(() => undefined); return current ? executionView(current) : null; }
      await this.failExecution(executionId, operationId, error, principal.actorId).catch(() => undefined); throw error;
    } finally { this.active.delete(String(executionId)); }
  }

  async beginStage(execution, stage, index, topOperationId, principal) {
    const existing = this.db.get('SELECT * FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? AND stage=?', [execution.id, execution.generation, stage]);
    if (existing) {
      const operation = this.db.get('SELECT * FROM operations WHERE id=?', [existing.operation_id]);
      if (operation?.status === 'paused') await this.operations.start(operation.id, { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id });
      return { ...this.checkpointView(existing), operation_id: existing.operation_id };
    }
    this.validatePins(execution, principal); await this.prepareCandidate(execution); const workspaceHash = this.workspaceHash(execution.repository_workspace_id, execution); const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM executions WHERE id=?', [execution.id]); const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: `execution.stage.${stage}`, resourceType: 'execution_stage', resourceId: `${current.id}:${current.generation}:${stage}`, projectId: current.project_id, requestHash: requestHash({ execution_id: current.id, generation: current.generation, stage, plan_sha256: current.plan_sha256, workspace_sha256: workspaceHash }), status: 'running', now, parentOperationId: topOperationId });
      const prior = tx.get(`SELECT checkpoint_sha256 FROM execution_stage_checkpoints
        WHERE execution_id=? AND ((generation=? AND stage_ordinal<?) OR generation<?)
        ORDER BY generation DESC,stage_ordinal DESC LIMIT 1`, [current.id, current.generation, index + 1, current.generation]);
      const checkpointId = opaqueId('execution_checkpoint'); const pins = pinsPayload(current); const checkpointPayload = { schema_version: 'aiws.execution-checkpoint.v1', checkpoint_id: checkpointId, execution_id: current.id, generation: Number(current.generation), stage, stage_ordinal: index + 1, input_sha256: stageInputHash(current, stage), workspace_sha256: workspaceHash, pins_sha256: sha256Hex(canonicalJson(pins)), prior_checkpoint_sha256: prior?.checkpoint_sha256 || '' };
      const checkpointJson = canonicalJson(checkpointPayload); const checkpointHash = sha256Hex(checkpointJson); const token = this.checkpointToken(checkpointId, checkpointHash);
      tx.run(`INSERT INTO execution_stage_checkpoints(id,execution_id,generation,stage,stage_ordinal,operation_id,input_sha256,workspace_sha256,pins_sha256,prior_checkpoint_sha256,checkpoint_token_hash,checkpoint_json,checkpoint_sha256,created_at,created_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [checkpointId, current.id, current.generation, stage, index + 1, operation.id, checkpointPayload.input_sha256, workspaceHash, checkpointPayload.pins_sha256, checkpointPayload.prior_checkpoint_sha256, sha256Hex(token), checkpointJson, checkpointHash, now, principal.actorId]);
      const next = this.updateExecution(tx, current, { status: 'running', current_stage: stage }, now, principal.actorId);
      this.appendExecution(tx, next, operation.id, principal.actorId, 'execution.stage_started', { execution_id: current.id, generation: current.generation, stage, checkpoint_sha256: checkpointHash }, now);
      this.operations.linkInTransaction(tx, operation.id, [['execution', current.id], ['execution_stage_checkpoint', checkpointId]], now);
      return { ...this.checkpointView(tx.get('SELECT * FROM execution_stage_checkpoints WHERE id=?', [checkpointId])), operation_id: operation.id };
    });
  }

  async completeStage(executionId, stage, stageOperationId, outcome, actorId) {
    const currentExecution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    const workspaceHash = this.workspaceHash(currentExecution.repository_workspace_id, currentExecution);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM executions WHERE id=?', [executionId]); const now = time(this.clock); const terminal = stage === 'deliver';
      const updates = { status: terminal ? 'completed' : current.status === 'pause_requested' ? 'pause_requested' : 'running', current_stage: stage, ...(terminal ? { handoff_manifest_json: canonicalJson(outcome.handoff_manifest || {}), handoff_manifest_sha256: sha256Hex(canonicalJson(outcome.handoff_manifest || {})), completed_at: now } : {}) };
      const next = this.updateExecution(tx, current, updates, now, actorId); this.appendExecution(tx, next, stageOperationId, actorId, terminal ? 'execution.completed' : 'execution.stage_completed', { execution_id: executionId, generation: next.generation, stage, result_sha256: sha256Hex(canonicalJson(outcome)), workspace_sha256: workspaceHash }, now);
      const operation = tx.get('SELECT revision,status,actor_id,project_id FROM operations WHERE id=?', [stageOperationId]); if (operation && operation.status === 'running') this.operations.transitionInTransaction(tx, stageOperationId, 'succeeded', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, result: { stage, result_sha256: sha256Hex(canonicalJson(outcome)) } }, now);
      return executionView(next);
    });
  }

  async runStage(stage, executionId, principal) {
    if (stage === 'prepare') { const row = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); this.validatePins(row, principal); normalizePlan(JSON.parse(row.plan_json).tasks); return { pins_sha256: sha256Hex(canonicalJson(pinsPayload(row))) }; }
    if (stage === 'context') { const row = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); const pack = this.db.get('SELECT status,pack_hash,payload_cas_hash FROM context_packs WHERE id=?', [row.context_pack_id]); if (!pack || pack.status !== 'sealed' || pack.pack_hash !== row.context_pack_hash) throw new PlatformError('context_inputs_changed', 'Context Pack pin is stale', {}, 409); return { context_pack_hash: pack.pack_hash, staging: 'bounded_cas' }; }
    if (stage === 'run') return this.executePlan(executionId, principal);
    if (stage === 'check') return this.runChecks(executionId, principal);
    if (stage === 'review') return this.review(executionId, principal);
    if (stage === 'finalize') return this.finalize(executionId, principal);
    if (stage === 'deliver') return { handoff_manifest: this.handoff(executionId) };
    throw new PlatformError('stage_invalid', 'execution stage is invalid', {}, 422);
  }

  async runChecks(executionId, principal) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    const tasks = JSON.parse(execution.plan_json || '{}').tasks || [];
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [execution.repository_workspace_id]);
    const root = this.candidates.directory(execution); const results = [];
    for (const task of tasks) for (const checkId of task.check_ids || []) {
      const attempt = this.effectiveAttempt(execution, task.id); const started = Date.now();
      const command = checkId === 'git_diff_check' ? { command: 'git', args: ['diff', '--no-index', '--check', '--', this.workspaceDirectory(workspace), root] } : { command: process.execPath, args: ['--test'] };
      let status = 'passed'; let exitCode = 0; let stdout = ''; let stderr = '';
      try { const value = await executeHostCommand(command, { root, allowedExitCodes: checkId === 'git_diff_check' ? [0,1] : [0] }); stdout = String(value.stdout || ''); stderr = String(value.stderr || ''); exitCode = value.exit_code; status = value.status === 'succeeded' ? 'passed' : 'failed'; }
      catch (error) { status = error?.killed ? 'error' : 'failed'; exitCode = typeof error?.code === 'number' ? error.code : 1; stdout = String(error?.stdout || ''); stderr = String(error?.stderr || error?.message || ''); }
      const inputHash = sha256Hex(canonicalJson({ execution_id: execution.id, generation: execution.generation, task_id: task.id, check_id: checkId, workspace_hash: this.workspaceHash(execution.repository_workspace_id, execution), task_attempt_id: attempt?.id || null }));
      const outputHash = sha256Hex(`${stdout}\n${stderr}`); const details = { command: [command.command, ...command.args], exit_code: exitCode, stdout_sha256: sha256Hex(stdout), stderr_sha256: sha256Hex(stderr), task_attempt_id: attempt?.id || null };
      if (this.checkEvidence) await this.checkEvidence.recordCheckResult({ execution, attempt, checkId, status, commandHash: sha256Hex(canonicalJson({ command: checkId === 'node_test' ? 'node' : 'git', args: command.args })), inputHash, outputHash, durationMs: Date.now() - started, details: { ...details, command: checkId === 'node_test' ? ['node','--test'] : ['git','diff','--no-index','--check','--','<BASE>','<CANDIDATE>'] } }, principal);
      results.push({ check_id: checkId, status, input_sha256: inputHash, output_sha256: outputHash });
    }
    if (results.some((item) => item.status !== 'passed')) throw new PlatformError('check_failed', 'independent checks failed', { checks: results.filter((item) => item.status !== 'passed').map((item) => item.check_id) }, 409);
    return { status: 'passed', checks: results };
  }

  async executePlan(executionId, principal) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); const tasks = JSON.parse(execution.plan_json).tasks; const completed = new Set(); const results = [];
    for (const task of tasks) {
      const latest = this.db.get('SELECT * FROM task_attempts WHERE execution_id=? AND generation=? AND task_id=? ORDER BY attempt_no DESC LIMIT 1', [execution.id, execution.generation, task.id]);
      if (latest?.status === 'succeeded') { if (!this.effectiveAttempt(execution, task.id)) throw new PlatformError('runner_output_mismatch', 'successful task output is stale', {}, 409); completed.add(task.id); results.push(attemptView(latest)); }
      else if (latest?.status === 'external_result_unknown') throw new PlatformError('external_result_unknown', 'runner result could not be reconciled', { task_id: task.id }, 409);
      else if (latest && TERMINAL_ATTEMPTS.has(latest.status) && (!TRANSIENT.has(latest.error_code) || Number(latest.attempt_no) >= 3)) throw new PlatformError(latest.error_code || 'runner_failed', 'runner task failed', { task_id: task.id }, 409);
    }
    while (completed.size < tasks.length) {
      const ready = tasks.filter((task) => !completed.has(task.id) && task.depends_on.every((dependency) => completed.has(dependency))).sort(taskOrder);
      if (!ready.length) throw new PlatformError('execution_dag_cycle', 'execution task graph has a cycle', {}, 422);
      const firstWrite = ready.findIndex((task) => task.mode === 'write'); const batch = firstWrite === 0 ? [ready[0]] : ready.slice(0, Math.min(firstWrite < 0 ? ready.length : firstWrite, 4));
      const batchResults = await Promise.all(batch.map((task) => this.runTask(executionId, task, principal)));
      for (let index = 0; index < batch.length; index += 1) { const result = batchResults[index]; results.push(result); if (result.status !== 'succeeded') { if (result.status === 'external_result_unknown') throw new PlatformError('external_result_unknown', 'runner result could not be reconciled', {}, 409); throw new PlatformError(result.error_code || 'runner_failed', 'runner task failed', { task_id: batch[index].id, ...(result.error_details || {}) }, 409); } completed.add(batch[index].id); }
    }
    return { task_count: results.length, receipt_hashes: results.map((result) => result.receipt_sha256).filter(Boolean) };
  }

  async runTask(executionId, task, principal) {
    let last; const prior = this.db.get('SELECT max(attempt_no) AS attempt_no FROM task_attempts WHERE execution_id=? AND generation=(SELECT generation FROM executions WHERE id=?) AND task_id=?', [executionId, executionId, task.id]);
    for (let attemptNo = Number(prior?.attempt_no || 0) + 1; attemptNo <= 3; attemptNo += 1) {
      const started = await this.startAttempt(executionId, task, attemptNo, principal); let result; let merge = null; let fatalError = null;
      try {
        result = await this.runner.runSignedJob(started.signed, started.profile, {
          workspacePath: started.taskWorkspace,
          task,
          fixture: fixtureFor(task, attemptNo),
          onSubmitted: async (job) => {
            await this.leaseAttempt(started.attempt.id, job, principal.actorId);
            const currentExecution = this.db.get('SELECT status FROM executions WHERE id=?', [started.execution.id]);
            if (currentExecution?.status === 'cancelled') await this.runner.adapterFor(started.profile).cancel(job.job_id, { profile: started.profile }).catch(() => undefined);
          },
          onStatus: (job) => this.markAttemptRunning(started.attempt.id, job, principal.actorId)
        });
        if (result.status === 'succeeded' && task.mode === 'write') merge = await this.mergeWriteAttempt(started, task, principal);
      } catch (error) { fatalError = error?.code === 'runner_input_mismatch' ? error : null; result = { status: String(error?.code || '') === 'external_result_unknown' ? 'external_result_unknown' : 'failed', error_code: String(error?.code || 'runner_failed'), error_details: error?.details || {}, job_id: '' }; }
      last = await this.finishAttempt(started, result, merge, principal.actorId); fs.rmSync(started.taskWorkspace, { recursive: true, force: true });
      if (fatalError) throw fatalError;
      if (last.status === 'succeeded' || last.status === 'external_result_unknown') return last;
      if (!TRANSIENT.has(last.error_code) || attemptNo >= 3) return last;
      await this.sleep(Number(this.retryDelays[attemptNo - 1] || 0));
    }
    return last;
  }

  async startAttempt(executionId, task, attemptNo, principal) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); const profile = this.db.get('SELECT * FROM runner_profiles WHERE id=?', [execution.runner_profile_id]);
    if (!profile || profile.status !== 'ready' || Number(profile.revision) !== Number(execution.runner_profile_revision) || profileSnapshotHash(profile) !== execution.runner_profile_hash) throw new PlatformError('runner_profile_changed', 'runner profile pin changed', {}, 409);
    const workspaceHash = this.workspaceHash(execution.repository_workspace_id, execution); const taskWorkspace = this.prepareTaskWorkspace(execution, task, attemptNo); const now = time(this.clock); const id = opaqueId('task_attempt');
    return this.db.withTransaction((tx) => {
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'execution.task.run', resourceType: 'task_attempt', resourceId: id, projectId: execution.project_id, requestHash: requestHash({ execution_id: execution.id, generation: execution.generation, task_id: task.id, attempt: attemptNo, workspace_hash: workspaceHash }), status: 'running', now });
      tx.run(`INSERT INTO task_attempts(id,execution_id,generation,task_id,task_ordinal,attempt_no,execution_mode,operation_id,runner_profile_id,status,dependency_hash,workspace_hash,revision,created_at,updated_at,started_at)
        VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?,1,?,?,?)`, [id, execution.id, execution.generation, task.id, task.ordinal, attemptNo, task.mode, operation.id, profile.id, sha256Hex(canonicalJson(task.depends_on)), workspaceHash, now, now, now]);
      let attempt = tx.get('SELECT * FROM task_attempts WHERE id=?', [id]); const inputs = tx.query('SELECT * FROM execution_inputs WHERE execution_id=? ORDER BY ordinal', [execution.id]);
      const signed = this.runner.createJobSpecInTransaction(tx, { execution, attempt, task, profile, inputRefs: inputs, workspaceHash, contextPackHash: execution.context_pack_hash, now, actorId: principal.actorId }); attempt = tx.get('SELECT * FROM task_attempts WHERE id=?', [id]);
      appendAggregate(this.events, tx, { aggregateType: 'task_attempt', aggregateId: id, revision: 1, operationId: operation.id, actorId: principal.actorId, projectId: execution.project_id, type: 'task_attempt.ready', data: { execution_id: execution.id, task_id: task.id, attempt: attemptNo, job_spec_hash: signed.spec_sha256 }, payload: attemptPayload(attempt), now });
      this.operations.linkInTransaction(tx, operation.id, [['execution', execution.id], ['task_attempt', id], ['job_spec', signed.spec.job_spec_id]], now);
      return { execution, profile, attempt, signed, taskWorkspace };
    });
  }

  async finishAttempt(started, result, merge, actorId) {
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM task_attempts WHERE id=?', [started.attempt.id]); if (TERMINAL_ATTEMPTS.has(current.status)) return attemptView(current); const now = time(this.clock);
      let status = String(result.status || 'failed'); if (!TERMINAL_ATTEMPTS.has(status)) status = 'failed'; const receiptId = result.receipt ? this.runner.persistReceiptInTransaction(tx, { attempt: current, profile: started.profile, result, now }) : null;
      const errorCode = status === 'succeeded' ? '' : String(result.error_code || result.receipt?.error_code || status); const nextRevision = Number(current.revision) + 1;
      tx.run(`UPDATE task_attempts SET runner_receipt_id=?,status=?,lease_id=?,fencing_token_hash=?,stdout_sha256=?,stderr_sha256=?,output_sha256=?,error_code=?,revision=?,updated_at=?,completed_at=? WHERE id=? AND revision=?`, [receiptId, status, String(result.job_id || ''), merge?.fencing_token_hash || '', result.receipt?.stdout_sha256 || '', result.receipt?.stderr_sha256 || '', result.receipt?.output_sha256 || '', errorCode, nextRevision, now, now, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM task_attempts WHERE id=?', [current.id]); appendAggregate(this.events, tx, { aggregateType: 'task_attempt', aggregateId: current.id, revision: nextRevision, operationId: current.operation_id, actorId, projectId: started.execution.project_id, type: `task_attempt.${status}`, data: { execution_id: started.execution.id, task_id: current.task_id, attempt: current.attempt_no, error_code: errorCode || undefined, receipt_sha256: result.receipt_sha256 || undefined }, payload: attemptPayload(next), now });
      let operation = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
      if (status === 'cancelled' && operation && !operation.cancel_requested_at) {
        this.operations.requestCancelInTransaction(tx, operation.id, { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, idempotencyKey: `p6-cancel-${operation.id}`, requestHash: requestHash({ operation_id: operation.id, reason: 'runner_cancelled' }), reason: 'runner_cancelled' }, now);
        operation = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
      }
      if (operation?.status === 'running') this.operations.transitionInTransaction(tx, current.operation_id, status === 'succeeded' ? 'succeeded' : status === 'external_result_unknown' ? 'paused' : status === 'cancelled' ? 'cancelled' : 'failed', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, ...(status === 'succeeded' ? { result: { receipt_sha256: result.receipt_sha256 } } : { errorCode }) }, now);
      return { ...attemptView(next), receipt_sha256: result.receipt_sha256 || null };
    });
  }

  async leaseAttempt(attemptId, job, actorId) {
    return this.transitionAttempt(attemptId, 'leased', { lease_id: String(job?.job_id || '') }, actorId);
  }

  async markAttemptRunning(attemptId, job, actorId) {
    const row = this.db.get('SELECT status FROM task_attempts WHERE id=?', [String(attemptId)]);
    if (!row || row.status === 'running' || TERMINAL_ATTEMPTS.has(row.status)) return row;
    return this.transitionAttempt(attemptId, 'running', { lease_id: String(job?.job_id || '') }, actorId);
  }

  async transitionAttempt(attemptId, status, changes, actorId) {
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT ta.*,e.project_id FROM task_attempts ta JOIN executions e ON e.id=ta.execution_id WHERE ta.id=?', [String(attemptId)]);
      if (!current || TERMINAL_ATTEMPTS.has(current.status) || current.status === status) return current;
      const now = time(this.clock); const revision = Number(current.revision) + 1;
      tx.run('UPDATE task_attempts SET status=?,lease_id=?,revision=?,updated_at=? WHERE id=? AND revision=?', [status, changes.lease_id || current.lease_id || '', revision, now, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM task_attempts WHERE id=?', [current.id]);
      appendAggregate(this.events, tx, { aggregateType: 'task_attempt', aggregateId: current.id, revision, operationId: current.operation_id, actorId, projectId: current.project_id, type: `task_attempt.${status}`, data: { execution_id: current.execution_id, task_id: current.task_id, attempt: current.attempt_no, job_id: changes.lease_id || undefined }, payload: attemptPayload(next), now });
      return next;
    });
  }

  async review(executionId, principal) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); const plan = JSON.parse(execution.plan_json); if (!plan.requires_approval) return { status: 'not_required' };
    const approvals = this.db.query("SELECT * FROM runtime_approvals WHERE project_id=? AND action='execution.review' ORDER BY created_at DESC,id", [execution.project_id]); const existing = approvals.find((item) => JSON.parse(item.request_json || '{}').execution_id === executionId && Number(JSON.parse(item.request_json || '{}').generation) === Number(execution.generation));
    if (existing?.status === 'approved') return { status: 'approved', approval_id: existing.id };
    if (existing?.status === 'rejected') throw new PlatformError('approval_rejected', 'execution review was rejected', {}, 409);
    if (!existing && this.assist) await this.assist.createApproval({ project_id: execution.project_id, action: 'execution.review', request: { execution_id: execution.id, generation: execution.generation }, expected_revision: 0, idempotency_key: `p6-review-${execution.id}-${execution.generation}` }, principal);
    return { awaiting_approval: true };
  }

  async finalize(executionId, principal) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); const tasks = JSON.parse(execution.plan_json).tasks;
    for (const task of tasks) { const attempt = this.effectiveAttempt(execution, task.id); if (!attempt || attempt.status !== 'succeeded' || !attempt.job_spec_id || !attempt.runner_receipt_id) throw new PlatformError('execution_incomplete', 'execution has an incomplete task receipt', { task_id: task.id }, 409); }
    for (const stage of RUNNER_STAGES.slice(0, 6)) { const checkpoint = this.db.get('SELECT id FROM execution_stage_checkpoints WHERE execution_id=? AND generation<=? AND stage=? ORDER BY generation DESC LIMIT 1', [execution.id, execution.generation, stage]); if (!checkpoint) throw new PlatformError('execution_incomplete', 'execution stage checkpoints are incomplete', { stage }, 409); }
    await this.candidates.publish(execution, this.workspaceDirectory(this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [execution.repository_workspace_id])), principal);
    return { status: 'verified', task_count: tasks.length };
  }

  handoff(executionId) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [executionId]); const tasks = JSON.parse(execution.plan_json).tasks;
    const receipts = tasks.map((task) => { const attempt = this.effectiveAttempt(execution, task.id); const receipt = attempt ? this.db.get('SELECT receipt_sha256 FROM runner_receipts WHERE id=?', [attempt.runner_receipt_id]) : null; return receipt ? { receipt_sha256: receipt.receipt_sha256, task_id: task.id, attempt_no: attempt.attempt_no } : null; }).filter(Boolean);
    return { schema_version: 'aiws.delivery-handoff.v1', execution_ref: execution.id, generation: Number(execution.generation), project_ref: execution.project_id, workflow: { ref: execution.workflow_id, revision: Number(execution.workflow_revision), hash: execution.workflow_hash }, receipts: receipts.map((item) => ({ task_ref: item.task_id, attempt: Number(item.attempt_no), receipt_hash: item.receipt_sha256 })), delivery_ready: true };
  }

  async control(row, input, principal, commandId, transition, eventType, { queuedOperation = false } = {}) {
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const now = time(this.clock); const hash = requestHash({ execution_id: row.id, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM executions WHERE id=?', [row.id]); assertRevision(current, expected); const updates = transition(current);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'execution', resourceId: row.id, projectId: row.project_id, requestHash: hash, idempotencyKey: queuedOperation ? `op-${key}` : undefined, status: queuedOperation ? 'queued' : 'succeeded', now });
      const next = this.updateExecution(tx, current, updates, now, principal.actorId); this.appendExecution(tx, next, operation.id, principal.actorId, eventType, { execution_id: row.id, generation: next.generation }, now);
      this.operations.linkInTransaction(tx, operation.id, [['execution', row.id]], now); const response = { execution: executionView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: queuedOperation ? 202 : 200, now }); return response;
    });
  }

  async markPaused(executionId, topOperationId, actorId) {
    return this.db.withTransaction((tx) => { const current = tx.get('SELECT * FROM executions WHERE id=?', [executionId]); if (!current || current.status === 'paused') return current; const now = time(this.clock); const next = this.updateExecution(tx, current, { status: 'paused' }, now, actorId); this.appendExecution(tx, next, topOperationId, actorId, 'execution.paused', { execution_id: executionId, stage: current.current_stage }, now); if (topOperationId) { const op = tx.get('SELECT * FROM operations WHERE id=?', [topOperationId]); if (op?.status === 'running') this.operations.transitionInTransaction(tx, topOperationId, 'paused', { expectedRevision: op.revision, actorId: op.actor_id, projectId: op.project_id }, now); } return next; });
  }

  async markAwaitingApproval(executionId, stageOperationId, topOperationId, actorId) {
    return this.db.withTransaction((tx) => { const current = tx.get('SELECT * FROM executions WHERE id=?', [executionId]); const now = time(this.clock); const next = this.updateExecution(tx, current, { status: 'awaiting_approval' }, now, actorId); this.appendExecution(tx, next, stageOperationId, actorId, 'execution.awaiting_approval', { execution_id: executionId, stage: 'review' }, now); for (const id of [stageOperationId, topOperationId]) { const op = tx.get('SELECT * FROM operations WHERE id=?', [id]); if (op?.status === 'running') this.operations.transitionInTransaction(tx, id, 'paused', { expectedRevision: op.revision, actorId: op.actor_id, projectId: op.project_id }, now); } return next; });
  }

  async failExecution(executionId, topOperationId, error, actorId) {
    return this.db.withTransaction((tx) => { const current = tx.get('SELECT * FROM executions WHERE id=?', [executionId]); if (!current || TERMINAL_EXECUTIONS.has(current.status)) return current; const now = time(this.clock); const unknown = String(error?.code || '') === 'external_result_unknown'; const errorDetails = error?.details && typeof error.details === 'object' ? error.details : {}; const next = this.updateExecution(tx, current, { status: unknown ? 'paused' : 'failed', error_code: String(error?.code || 'execution_failed'), ...(!unknown ? { completed_at: now } : {}) }, now, actorId); this.appendExecution(tx, next, topOperationId, actorId, unknown ? 'execution.paused' : 'execution.failed', { execution_id: executionId, stage: current.current_stage, error_code: String(error?.code || 'execution_failed') }, now); const stage = tx.get("SELECT o.* FROM operations o JOIN execution_stage_checkpoints c ON c.operation_id=o.id WHERE c.execution_id=? AND c.generation=? AND c.stage=?", [executionId, current.generation, current.current_stage]); if (stage?.status === 'running') this.operations.transitionInTransaction(tx, stage.id, unknown ? 'paused' : 'failed', { expectedRevision: stage.revision, actorId: stage.actor_id, projectId: stage.project_id, errorCode: String(error?.code || 'execution_failed'), errorDetails }, now); const top = tx.get('SELECT * FROM operations WHERE id=?', [topOperationId]); if (top?.status === 'running') this.operations.transitionInTransaction(tx, topOperationId, unknown ? 'paused' : 'failed', { expectedRevision: top.revision, actorId: top.actor_id, projectId: top.project_id, errorCode: String(error?.code || 'execution_failed'), errorDetails }, now); return next; });
  }

  async markUnknownAfterRestart(execution, attempts) {
    return this.db.withTransaction((tx) => {
      const now = time(this.clock);
      for (const item of attempts) {
        const current = tx.get('SELECT * FROM task_attempts WHERE id=?', [item.id]); if (!current || TERMINAL_ATTEMPTS.has(current.status)) continue;
        const revision = Number(current.revision) + 1;
        tx.run("UPDATE task_attempts SET status='external_result_unknown',error_code='broker_restart_unknown',revision=?,updated_at=?,completed_at=? WHERE id=? AND revision=?", [revision, now, now, current.id, current.revision], 1);
        appendAggregate(this.events, tx, { aggregateType: 'task_attempt', aggregateId: current.id, revision, operationId: current.operation_id, actorId: execution.updated_by_actor_id, projectId: execution.project_id, type: 'task_attempt.external_result_unknown', data: { execution_id: execution.id, task_id: current.task_id }, payload: attemptPayload(tx.get('SELECT * FROM task_attempts WHERE id=?', [current.id])), now });
        const operation = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]); if (operation?.status === 'running') this.operations.transitionInTransaction(tx, operation.id, 'paused', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, errorCode: 'broker_restart_unknown' }, now);
      }
      const current = tx.get('SELECT * FROM executions WHERE id=?', [execution.id]); const next = this.updateExecution(tx, current, { status: 'paused', error_code: 'external_result_unknown' }, now, execution.updated_by_actor_id);
      this.appendExecution(tx, next, null, execution.updated_by_actor_id, 'execution.paused', { execution_id: execution.id, error_code: 'external_result_unknown' }, now);
      const operationIds = new Set([
        tx.get('SELECT operation_id FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? AND stage=?', [current.id, current.generation, current.current_stage])?.operation_id,
        tx.get(`SELECT o.id FROM operations o JOIN operation_links l ON l.operation_id=o.id WHERE l.aggregate_type='execution' AND l.aggregate_id=? AND o.command_id IN ('execution.start','execution.resume','execution.stage.replay') ORDER BY o.created_at DESC,o.id DESC LIMIT 1`, [current.id])?.id
      ].filter(Boolean));
      for (const id of operationIds) { const operation = tx.get('SELECT * FROM operations WHERE id=?', [id]); if (operation?.status === 'running') this.operations.transitionInTransaction(tx, id, 'paused', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, errorCode: 'external_result_unknown' }, now); }
      return next;
    });
  }

  async reconcileAfterRestart(execution, attempts) {
    const principal = { actorId: execution.updated_by_actor_id, effectiveActorId: execution.updated_by_actor_id, scopes: ['*'] };
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const profile = this.db.get('SELECT * FROM runner_profiles WHERE id=?', [attempt.runner_profile_id]);
      const result = profile && attempt.lease_id ? await this.runner.reconcileJob(attempt, profile).catch(() => ({ status: 'external_result_unknown' })) : { status: 'external_result_unknown' };
      if (result.status === 'external_result_unknown') { await this.markUnknownAfterRestart(execution, attempts.slice(index)); return false; }
      if (!TERMINAL_ATTEMPTS.has(String(result.status || ''))) { this.monitorRecoveredAttempts(execution, attempts.slice(index), principal); return false; }
      const task = JSON.parse(execution.plan_json).tasks.find((item) => item.id === attempt.task_id); const started = { execution, profile, attempt, taskWorkspace: this.taskWorkspace(execution, task, attempt.attempt_no) }; let merge = null;
      if (result.status === 'succeeded' && task?.mode === 'write') merge = await this.mergeWriteAttempt(started, task, principal);
      await this.finishAttempt(started, result, merge, execution.updated_by_actor_id);
    }
    return true;
  }

  monitorRecoveredAttempts(execution, attempts, principal) {
    if (this.active.has(String(execution.id))) return;
    const control = { recovered: true, operationId: this.latestExecutionOperation(execution.id)?.id || null }; this.active.set(String(execution.id), control);
    queueMicrotask(async () => {
      try {
        for (const original of attempts) {
          const profile = this.db.get('SELECT * FROM runner_profiles WHERE id=?', [original.runner_profile_id]); let result;
          do { await this.sleep(this.runner.pollIntervalMs); result = await this.runner.reconcileJob(original, profile).catch(() => ({ status: 'external_result_unknown' })); } while (!TERMINAL_ATTEMPTS.has(String(result.status || '')));
          if (result.status === 'external_result_unknown') { await this.markUnknownAfterRestart(execution, [original]); return; }
          const task = JSON.parse(execution.plan_json).tasks.find((item) => item.id === original.task_id); const current = this.db.get('SELECT * FROM task_attempts WHERE id=?', [original.id]); const started = { execution, profile, attempt: current, taskWorkspace: this.taskWorkspace(execution, task, current.attempt_no) }; let merge = null;
          if (result.status === 'succeeded' && task?.mode === 'write') merge = await this.mergeWriteAttempt(started, task, principal);
          await this.finishAttempt(started, result, merge, execution.updated_by_actor_id);
        }
      } catch { await this.markUnknownAfterRestart(execution, attempts).catch(() => undefined); return; }
      finally { this.active.delete(String(execution.id)); }
      const operation = this.latestExecutionOperation(execution.id); if (operation) this.schedule(execution.id, operation.id, this.resumeStageIndex(execution.id, execution.generation), principal);
    });
  }

  async requestExecutionCancellation(executionId, topOperationId, actorId) {
    return this.db.withTransaction((tx) => {
      const execution = tx.get('SELECT * FROM executions WHERE id=?', [String(executionId)]); if (!execution) return;
      const operationIds = new Set([topOperationId, tx.get("SELECT operation_id FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? AND stage=?", [execution.id, execution.generation, execution.current_stage])?.operation_id].filter(Boolean));
      for (const id of operationIds) this.requestOperationCancellationInTransaction(tx, id, actorId, 'execution_cancelled', time(this.clock));
    });
  }

  async acknowledgeExecutionCancellation(executionId, topOperationId, actorId) {
    return this.db.withTransaction((tx) => {
      const execution = tx.get('SELECT * FROM executions WHERE id=?', [String(executionId)]); if (!execution) return;
      const operationIds = new Set([topOperationId, tx.get("SELECT operation_id FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? AND stage=?", [execution.id, execution.generation, execution.current_stage])?.operation_id].filter(Boolean));
      const now = time(this.clock);
      for (const id of operationIds) {
        this.requestOperationCancellationInTransaction(tx, id, actorId, 'execution_cancelled', now);
        const operation = tx.get('SELECT * FROM operations WHERE id=?', [id]);
        if (operation && ['accepted', 'queued', 'running', 'paused'].includes(operation.status)) this.operations.transitionInTransaction(tx, id, 'cancelled', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, errorCode: 'execution_cancelled' }, now);
      }
    });
  }

  requestOperationCancellationInTransaction(tx, operationId, actorId, reason, now) {
    const operation = tx.get('SELECT * FROM operations WHERE id=?', [String(operationId)]);
    if (!operation || ['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status) || operation.cancel_requested_at) return operation;
    this.operations.requestCancelInTransaction(tx, operation.id, { expectedRevision: operation.revision, actorId: operation.actor_id || actorId, projectId: operation.project_id, idempotencyKey: `p6-cancel-${operation.id}`, requestHash: requestHash({ operation_id: operation.id, reason }), reason }, now);
    return tx.get('SELECT * FROM operations WHERE id=?', [operation.id]);
  }

  async cancelRunningAttempts(executionId, actorId) {
    const attempts = this.db.query("SELECT * FROM task_attempts WHERE execution_id=? AND status IN ('ready','leased','running')", [executionId]);
    this.db.withTransaction((tx) => { const now = time(this.clock); for (const attempt of attempts) this.requestOperationCancellationInTransaction(tx, attempt.operation_id, actorId, 'execution_cancelled', now); });
    for (const attempt of attempts) { const profile = this.db.get('SELECT * FROM runner_profiles WHERE id=?', [attempt.runner_profile_id]); if (attempt.lease_id && profile) await this.runner.adapterFor(profile).cancel(attempt.lease_id, { profile }).catch(() => undefined); }
  }

  async settleSupersededTop(executionId, currentOperationId, actorId) {
    const prior = this.db.get(`SELECT o.* FROM operations o JOIN operation_links l ON l.operation_id=o.id
      WHERE l.aggregate_type='execution' AND l.aggregate_id=? AND o.id<>? AND o.command_id IN ('execution.start','execution.resume','execution.stage.replay') AND o.status='paused'
      ORDER BY o.created_at DESC,o.id DESC LIMIT 1`, [String(executionId), String(currentOperationId)]);
    if (!prior) return null;
    const running = await this.operations.start(prior.id, { expectedRevision: prior.revision, actorId: prior.actor_id || actorId, projectId: prior.project_id });
    return this.operations.succeed(prior.id, { expectedRevision: running.revision, actorId: prior.actor_id || actorId, projectId: prior.project_id, result: { execution_id: executionId, status: 'resumed', continued_by_operation_id: currentOperationId } });
  }

  async mergeWriteAttempt(started, task, _principal) {
    const base = this.candidates.directory(started.execution);
    if (this.workspaceHash(started.execution.repository_workspace_id, started.execution) !== started.attempt.workspace_hash) throw new PlatformError('workspace_changed', 'candidate changed during task', {}, 409);
    for (const relative of task.output_paths) {
      const source = safeJoin(started.taskWorkspace, relative);
      if (!fs.existsSync(source)) { if (task.argv?.length) throw new PlatformError('runner_artifact_missing', 'output missing', {}, 409); continue; }
      const target = safeJoin(base, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    return { candidate_hash: this.workspaceHash(started.execution.repository_workspace_id, started.execution) };
  }

  async prepareCandidate(execution) {
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [execution.repository_workspace_id]);
    return this.candidates.prepare(execution, this.workspaceDirectory(workspace));
  }

  taskWorkspace(execution, task, attemptNo) { return path.join(this.taskRoot, execution.id, String(execution.generation), task.id, String(attemptNo)); }
  prepareTaskWorkspace(execution, task, attemptNo) { const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [execution.repository_workspace_id]); const source = this.candidates.directory(execution); const target = this.taskWorkspace(execution, task, attemptNo); fs.rmSync(target, { recursive: true, force: true }); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); if (fs.existsSync(source)) { assertTreeSafe(source); fs.cpSync(source, target, { recursive: true, force: false, filter: (entry) => !path.relative(source, entry).replaceAll('\\', '/').startsWith('.p6-tasks') }); } return target; }
  workspaceDirectory(workspace) { return safeJoin(this.workspaceRoot, workspace.relative_path || `projects/${workspace.project_id}/workspace`); }
  workspaceHash(workspaceId, execution = null) { const workspace = this.db.get('SELECT rw.*,rl.source_hash,rl.revision AS line_revision FROM repository_workspaces rw JOIN repository_lines rl ON rl.id=rw.line_id WHERE rw.id=?', [String(workspaceId)]); if (!workspace) throw new PlatformError('not_found', 'repository workspace not found', {}, 404); const root = execution ? this.candidates.directory(execution) : this.workspaceDirectory(workspace); const hash = createHash('sha256'); hash.update(canonicalJson({ workspace_id: workspace.id, line_revision: Number(workspace.line_revision), source_hash: workspace.source_hash || '' })); if (!fs.existsSync(root)) return hash.digest('hex'); for (const file of walkFiles(root)) { const relative = path.relative(root, file).replaceAll('\\', '/'); hash.update(relative); hash.update(fs.readFileSync(file)); } return hash.digest('hex'); }

  validateWorkspaceForResume(execution) { const completed = this.db.query("SELECT data_json FROM events WHERE aggregate_type='execution' AND aggregate_id=? AND type IN ('execution.stage_completed','execution.completed') ORDER BY sequence DESC", [execution.id]).map((item) => JSON.parse(item.data_json || '{}')).find((item) => Number(item.generation) === Number(execution.generation) && item.workspace_sha256); const checkpoint = this.db.get('SELECT * FROM execution_stage_checkpoints WHERE execution_id=? AND generation=? ORDER BY stage_ordinal DESC LIMIT 1', [execution.id, execution.generation]); const expected = completed?.workspace_sha256 || checkpoint?.workspace_sha256; if (expected && this.workspaceHash(execution.repository_workspace_id, execution) !== expected) throw new PlatformError('workspace_changed', 'workspace changed since the last safe boundary', {}, 409); }
  validatePins(execution, principal) { if (sha256Hex(execution.plan_json) !== execution.plan_sha256) throw new PlatformError('execution_pins_changed', 'plan hash changed', {}, 409); const pins = this.resolvePins(this.assertProject(principal, 'run', execution.project_id), { workflow_id: execution.workflow_id, workflow_revision: execution.workflow_revision, repository_workspace_id: execution.repository_workspace_id, context_pack_id: execution.context_pack_id, runner_profile_id: execution.runner_profile_id }, principal); const expected = pinsPayload(execution); const actual = { workflow_revision: pins.workflowRevision, workflow_hash: pins.workflowHash, brief_revision: pins.briefRevision, brief_hash: pins.briefHash, repository_revision: pins.repositoryRevision, repository_hash: pins.repositoryHash, context_pack_hash: pins.contextPackHash, runner_profile_revision: Number(pins.profile.revision), runner_profile_hash: pins.runnerProfileHash }; if (canonicalJson(expected) !== canonicalJson(actual)) throw new PlatformError('execution_pins_changed', 'execution pins are stale', { expected_sha256: sha256Hex(canonicalJson(expected)), actual_sha256: sha256Hex(canonicalJson(actual)) }, 409); return true; }

  resolvePins(project, input, principal) { const workflow = this.db.get('SELECT * FROM workflows WHERE id=? AND project_id=?', [String(input.workflow_id || this.db.get('SELECT id FROM workflows WHERE project_id=?', [project.id])?.id || ''), project.id]); if (!workflow) throw new PlatformError('workflow_required', 'workflow is required', {}, 409); const workflowRevision = Number(input.workflow_revision || workflow.current_revision); const workflowRevisionRow = this.db.get('SELECT * FROM workflow_revisions WHERE workflow_id=? AND revision=?', [workflow.id, workflowRevision]); if (!workflowRevisionRow) throw new PlatformError('workflow_required', 'workflow revision is required', {}, 409); const brief = this.db.get('SELECT * FROM briefs WHERE project_id=?', [project.id]); if (!brief?.confirmed_revision || !brief.confirmed_hash) throw new PlatformError('brief_required', 'confirmed Brief is required', {}, 409); const workspace = input.repository_workspace_id ? this.db.get('SELECT * FROM repository_workspaces WHERE id=? AND project_id=?', [String(input.repository_workspace_id), project.id]) : this.db.get("SELECT * FROM repository_workspaces WHERE project_id=? AND status IN ('ready','released') ORDER BY updated_at DESC,id LIMIT 1", [project.id]); if (!workspace) throw new PlatformError('workspace_required', 'managed repository workspace is required', {}, 409); const line = this.db.get('SELECT * FROM repository_lines WHERE id=?', [workspace.line_id]); if (!line || line.status !== 'ready') throw new PlatformError('workspace_changed', 'repository source is not ready', {}, 409); const pack = input.context_pack_id ? this.db.get('SELECT * FROM context_packs WHERE id=? AND project_id=?', [String(input.context_pack_id), project.id]) : this.db.get("SELECT * FROM context_packs WHERE project_id=? AND status='sealed' ORDER BY created_at DESC,id LIMIT 1", [project.id]); if (!pack || pack.status !== 'sealed') throw new PlatformError('context_pack_required', 'sealed Context Pack is required', {}, 409); const profile = this.runner.profileForExecution(input.runner_profile_id, principal, project.id); const runnerProfileHash = profileSnapshotHash(profile); return { workflow, workflowRevision, workflowRevisionRow, workflowHash: workflowRevisionRow.graph_sha256, briefRevision: Number(brief.confirmed_revision), briefHash: brief.confirmed_hash, workspace, repositoryRevision: Number(line.revision), repositoryHash: line.source_hash || sha256Hex(canonicalJson({ line_id: line.id, revision: line.revision })), pack, contextPackHash: pack.pack_hash, profile, runnerProfileHash, hashes: { workflow_hash: workflowRevisionRow.graph_sha256, brief_hash: brief.confirmed_hash, repository_hash: line.source_hash, context_pack_hash: pack.pack_hash, runner_profile_hash: runnerProfileHash } }; }

  tasksFromWorkflow(revision) {
    const graph = JSON.parse(revision.graph_json || '{}');
    return compileWorkflowToExecutionPlan(graph, {}, this.projectWorkflow?.policy).tasks;
  }
  insertInputs(tx, executionId, pins, extra, actorId, now) { const values = [{ input_type: 'brief', ref_id: `brief_${pins.workflow.project_id}`, ref_revision: pins.briefRevision, ref_hash: pins.briefHash }, { input_type: 'workflow', ref_id: pins.workflow.id, ref_revision: pins.workflowRevision, ref_hash: pins.workflowHash }, { input_type: 'repository', ref_id: pins.workspace.id, ref_revision: pins.repositoryRevision, ref_hash: pins.repositoryHash }, { input_type: 'context_pack', ref_id: pins.pack.id, ref_revision: Number(pins.pack.revision), ref_hash: pins.contextPackHash }, ...extra].slice(0, 256); values.forEach((item, index) => { const metadataJson = canonicalJson(item.metadata || {}); tx.run('INSERT INTO execution_inputs(id,execution_id,ordinal,input_type,ref_id,ref_revision,ref_hash,metadata_json,metadata_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('execution_input'), executionId, index + 1, item.input_type || item.type, String(item.ref_id || item.ref), Number(item.ref_revision ?? item.revision ?? 0), String(item.ref_hash || item.hash), metadataJson, sha256Hex(metadataJson), now, actorId]); }); }

  updateExecution(tx, row, changes, now, actorId) { const nextRevision = Number(row.revision) + 1; const fields = { status: row.status, current_stage: row.current_stage, generation: Number(row.generation), handoff_manifest_json: row.handoff_manifest_json, handoff_manifest_sha256: row.handoff_manifest_sha256, error_code: row.error_code, started_at: row.started_at, completed_at: row.completed_at, ...changes }; if (fields.status === 'running' && !fields.started_at) fields.started_at = now; tx.run('UPDATE executions SET status=?,current_stage=?,generation=?,handoff_manifest_json=?,handoff_manifest_sha256=?,error_code=?,revision=?,updated_at=?,started_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [fields.status, fields.current_stage, fields.generation, fields.handoff_manifest_json, fields.handoff_manifest_sha256, fields.error_code, nextRevision, now, fields.started_at || null, fields.completed_at || null, actorId, row.id, row.revision], 1); return tx.get('SELECT * FROM executions WHERE id=?', [row.id]); }
  appendExecution(tx, row, operationId, actorId, type, data, now) { const event = appendAggregate(this.events, tx, { aggregateType: 'execution', aggregateId: row.id, revision: Number(row.revision), operationId, actorId, projectId: row.project_id, type, data, payload: executionPayload(row), now }); tx.run('INSERT INTO execution_events(id,execution_id,generic_event_id,generic_sequence,generation,stage,event_type,created_at) VALUES(?,?,?,?,?,?,?,?)', [opaqueId('execution_event'), row.id, event.id, event.sequence, row.generation, row.current_stage || '', type, now]); return event; }
  checkpointToken(id, hash) { return createHmac('sha256', this.replaySecret).update(`${id}\n${hash}`).digest('base64url'); }
  checkpointView(row) { return { id: row.id, execution_id: row.execution_id, generation: Number(row.generation), stage: row.stage, stage_ordinal: Number(row.stage_ordinal), operation_id: row.operation_id, input_sha256: row.input_sha256, workspace_sha256: row.workspace_sha256, pins_sha256: row.pins_sha256, prior_checkpoint_sha256: row.prior_checkpoint_sha256, checkpoint_sha256: row.checkpoint_sha256, checkpoint_token: this.checkpointToken(row.id, row.checkpoint_sha256), created_at: row.created_at }; }
  resumeStageIndex(executionId, generation) { const completed = this.db.query("SELECT data_json FROM events WHERE aggregate_type='execution' AND aggregate_id=? AND type IN ('execution.stage_completed','execution.completed') ORDER BY sequence", [executionId]).map((item) => JSON.parse(item.data_json || '{}')).filter((item) => Number(item.generation) === Number(generation)); if (!completed.length) { const current = this.db.get('SELECT current_stage FROM executions WHERE id=?', [executionId]); return Math.max(0, RUNNER_STAGES.indexOf(current?.current_stage || '')); } return Math.min(RUNNER_STAGES.length - 1, RUNNER_STAGES.indexOf(completed.at(-1).stage) + 1); }
  assertReviewApproved(row) { const approval = this.db.query("SELECT * FROM runtime_approvals WHERE project_id=? AND action='execution.review' ORDER BY created_at DESC,id", [row.project_id]).find((item) => { const value = JSON.parse(item.request_json || '{}'); return value.execution_id === row.id && Number(value.generation) === Number(row.generation); }); if (!approval || approval.status !== 'approved') throw new PlatformError('approval_required', 'execution review approval is pending', {}, 409); }
  latestExecutionOperation(id) { return this.db.get("SELECT o.* FROM operations o JOIN operation_links l ON l.operation_id=o.id WHERE l.aggregate_type='execution' AND l.aggregate_id=? AND o.command_id IN ('execution.start','execution.resume','execution.stage.replay') ORDER BY o.created_at DESC,o.id DESC LIMIT 1", [id]); }
  effectiveAttempt(execution, taskId) {
    const attempt = this.db.get('SELECT * FROM task_attempts WHERE execution_id=? AND generation<=? AND task_id=? ORDER BY generation DESC,attempt_no DESC LIMIT 1', [execution.id,execution.generation,String(taskId)]);
    if (!attempt || attempt.status !== 'succeeded') return null;
    const signed = this.db.get('SELECT * FROM job_specs WHERE id=?',[attempt.job_spec_id]);
    const spec = signed ? JSON.parse(signed.spec_json) : null;
    const ref = spec?.input_refs.find((item) => item.type === 'task_contract');
    if (!ref) return attempt;
    const task = JSON.parse(execution.plan_json).tasks.find((item) => item.id === taskId);
    if (!task || task.task_contract_sha256 !== ref.hash || spec.runner_profile_hash !== execution.runner_profile_hash || spec.runner_profile_revision !== Number(execution.runner_profile_revision)) return null;
    try {
      const manifest = JSON.parse(this.runner.cas.read(attempt.output_sha256).toString('utf8'));
      const root = this.candidates.directory(execution);
      for (const entry of manifest.entries) if (sha256Hex(fs.readFileSync(safeJoin(root,entry.path))) !== entry.sha256) return null;
    } catch { return null; }
    return attempt;
  }
  executionRow(id, principal, action) { requirePrincipal(principal); const row = this.db.get('SELECT * FROM executions WHERE id=?', [String(id)]); if (!row) throw new PlatformError('not_found', 'execution not found', {}, 404); this.assertProject(principal, action, row.project_id); return row; }
  assertProject(principal, action, projectId) { requirePrincipal(principal); const project = this.db.get('SELECT * FROM projects WHERE id=?', [String(projectId)]); if (!project) throw new PlatformError('not_found', 'project not found', {}, 404); this.authorization.assert(principal, action, project.id, { execution: true }); return project; }
}

function normalizePlan(input) { if (!Array.isArray(input) || input.length > 100) throw new PlatformError('execution_task_limit', 'execution plan must contain at most 100 tasks', {}, 422); const ids = new Set(); const tasks = input.map((value, index) => { const id = String(value?.id || value?.task_id || `task_${index + 1}`); if (!/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(id) || ids.has(id)) throw new PlatformError('execution_task_invalid', 'execution task id is invalid or duplicated', { task_id: id }, 422); ids.add(id); const mode = value?.mode === 'write' ? 'write' : 'read'; const dependencies = [...new Set((value?.depends_on || value?.dependencies || []).map(String))].sort(); return { id, ordinal: index + 1, title: String(value?.title || id).slice(0, 200), mode, depends_on: dependencies, input_paths: normalizePaths(value?.input_paths || []), output_paths: normalizePaths(value?.output_paths || []), check_ids: normalizeChecks(value?.check_ids || []), resource_profile: value?.resource_profile === 'standard' ? 'standard' : 'light', ...(value?.fixture && typeof value.fixture === 'object' ? { fixture: JSON.parse(canonicalJson(value.fixture)) } : {}) }; }); const edges = edgeCount(tasks); if (edges > 500) throw new PlatformError('execution_edge_limit', 'execution dependency edge limit exceeded', {}, 422); for (const task of tasks) for (const dependency of task.depends_on) if (!ids.has(dependency) || dependency === task.id) throw new PlatformError('execution_dependency_invalid', 'execution dependency is missing or self-referential', { task_id: task.id, dependency }, 422); const pending = new Set(ids); const complete = new Set(); while (pending.size) { const ready = tasks.filter((task) => pending.has(task.id) && task.depends_on.every((item) => complete.has(item))).sort(taskOrder); if (!ready.length) throw new PlatformError('execution_dag_cycle', 'execution task graph has a cycle', {}, 422); for (const task of ready) { pending.delete(task.id); complete.add(task.id); } } return tasks; }
function normalizePlanWithContracts(input) {
  const tasks = normalizePlan(input);
  return tasks.map((task, index) => {
    const source = Array.isArray(input) ? input[index] || {} : {};
    const argv = Array.isArray(source.argv) ? source.argv.map(String) : [];
    if (argv.length && !['node', 'pnpm', 'npm', 'git', 'codex'].includes(argv[0])) throw new PlatformError('runner_command_not_allowed', 'task command is not registered', { task_id: task.id }, 422);
    const next = { ...task, argv, cwd_role: String(source.cwd_role || 'task'), deadline_seconds: Math.max(1, Number(source.deadline_seconds || 900)), runner_profile_ref: String(source.runner_profile_ref || ''), capabilities: Array.isArray(source.capabilities) ? source.capabilities.map(String) : ['network:none'] };
    next.task_contract = { argv: next.argv, cwd_role: next.cwd_role, mode: next.mode, input_paths: next.input_paths, output_paths: next.output_paths, runner_profile_ref: next.runner_profile_ref, resource_profile: next.resource_profile, deadline_seconds: next.deadline_seconds, check_ids: next.check_ids, capabilities: next.capabilities };
    next.task_contract_sha256 = sha256Hex(canonicalJson(next.task_contract));
    return next;
  });
}
function normalizePaths(value) { if (!Array.isArray(value) || value.length > 64) throw new PlatformError('runner_path_invalid', 'task path list is invalid', {}, 422); const paths = value.map((item) => { const text = String(item || ''); if (!text || text.length > 512 || text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw new PlatformError('runner_path_invalid', 'task path is invalid', {}, 422); return text; }); if (new Set(paths).size !== paths.length) throw new PlatformError('runner_path_invalid', 'task path is duplicated', {}, 422); return paths; }
function normalizeChecks(value) { if (!Array.isArray(value) || value.length > 16) throw new PlatformError('check_invalid', 'check list is invalid', {}, 422); const checks = [...new Set(value.map(String))].sort(); if (checks.some((item) => !CHECK_IDS.has(item))) throw new PlatformError('check_invalid', 'check id is outside the allowlist', {}, 422); return checks; }
function edgeCount(tasks) { return tasks.reduce((total, task) => total + task.depends_on.length, 0); }
function taskOrder(left, right) { return Number(left.ordinal) - Number(right.ordinal) || left.id.localeCompare(right.id); }
function fixtureFor(task, attemptNo) { if (Array.isArray(task.fixture?.attempts)) return task.fixture.attempts[attemptNo - 1] || {}; return task.fixture || {}; }
function executionPayload(row) { return { id: row.id, project_id: row.project_id, status: row.status, current_stage: row.current_stage, generation: Number(row.generation), plan_sha256: row.plan_sha256, handoff_manifest_sha256: row.handoff_manifest_sha256, error_code: row.error_code, revision: Number(row.revision) }; }
function pinsPayload(row) { return { workflow_revision: Number(row.workflow_revision), workflow_hash: row.workflow_hash, brief_revision: Number(row.brief_revision), brief_hash: row.brief_hash, repository_revision: Number(row.repository_revision), repository_hash: row.repository_hash, context_pack_hash: row.context_pack_hash, runner_profile_revision: Number(row.runner_profile_revision), runner_profile_hash: row.runner_profile_hash }; }
function stageInputHash(row, stage) { return sha256Hex(canonicalJson({ execution_id: row.id, generation: Number(row.generation), stage, plan_sha256: row.plan_sha256, pins: pinsPayload(row) })); }
function executionView(row) { return { id: row.id, project_id: row.project_id, workflow_id: row.workflow_id, workflow_revision: Number(row.workflow_revision), workflow_hash: row.workflow_hash, brief_revision: Number(row.brief_revision), brief_hash: row.brief_hash, repository_workspace_id: row.repository_workspace_id, repository_revision: Number(row.repository_revision), repository_hash: row.repository_hash, context_pack_id: row.context_pack_id, context_pack_hash: row.context_pack_hash, runner_profile_id: row.runner_profile_id, runner_profile_revision: Number(row.runner_profile_revision), runner_profile_hash: row.runner_profile_hash, parent_execution_id: row.parent_execution_id || null, replanned_from_stage: row.replanned_from_stage || '', status: row.status, current_stage: row.current_stage, generation: Number(row.generation), plan: publicPlan(JSON.parse(row.plan_json || '{}')), plan_sha256: row.plan_sha256, task_count: Number(row.task_count), dependency_edge_count: Number(row.dependency_edge_count), handoff_manifest: JSON.parse(row.handoff_manifest_json || '{}'), handoff_manifest_sha256: row.handoff_manifest_sha256, error_code: row.error_code, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at || null, completed_at: row.completed_at || null }; }
function publicPlan(plan) { return { ...plan, tasks: Array.isArray(plan.tasks) ? plan.tasks.map(({ fixture: _fixture, ...task }) => task) : [] }; }
function attemptPayload(row) { return { id: row.id, execution_id: row.execution_id, generation: Number(row.generation), task_id: row.task_id, attempt_no: Number(row.attempt_no), status: row.status, job_spec_id: row.job_spec_id || null, runner_receipt_id: row.runner_receipt_id || null, workspace_hash: row.workspace_hash, output_sha256: row.output_sha256, error_code: row.error_code, revision: Number(row.revision) }; }
function attemptView(row) { return { ...attemptPayload(row), task_ordinal: Number(row.task_ordinal), execution_mode: row.execution_mode, operation_id: row.operation_id, runner_profile_id: row.runner_profile_id, lease_id: row.lease_id || '', stdout_sha256: row.stdout_sha256, stderr_sha256: row.stderr_sha256, created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at || null, completed_at: row.completed_at || null }; }
function stateConflict(message, status) { return new PlatformError('state_conflict', message, { status }, 409); }
function safeJoin(root, relative) { const base = path.resolve(root); const target = path.resolve(base, String(relative || '').replaceAll('/', path.sep)); if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new PlatformError('runner_path_invalid', 'path escapes the managed workspace', {}, 422); return target; }
function assertTreeSafe(root) { for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const target = path.join(root, entry.name); if (entry.isSymbolicLink()) throw new PlatformError('workspace_special_path', 'workspace contains a symbolic link', {}, 422); if (entry.isDirectory()) assertTreeSafe(target); } }
function walkFiles(root) { const files = []; const visit = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name === '.p6-tasks') continue; const target = path.join(directory, entry.name); if (entry.isSymbolicLink()) throw new PlatformError('workspace_special_path', 'workspace contains a symbolic link', {}, 422); if (entry.isDirectory()) visit(target); else if (entry.isFile()) files.push(target); } }; visit(root); return files; }
