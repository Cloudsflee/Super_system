import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, assert } from '../../errors.mjs';
import { asJson, hashJson, id, now, parseJson, sha256 } from '../../crypto.mjs';
import { resolveWorkspacePath } from '../../path-policy.mjs';
import { gitHead } from '../../git-fixture.mjs';
import { auditStatement } from '../platform/repository.mjs';
import {
  atomicRename,
  createDeterministicArchive,
  manifestDirectory,
  normalizeRepositorySource,
  probeRepositorySource,
  publicSource,
  runGit,
  stageRepositorySource,
  copyDirectorySafe
} from '../repository/adapter.mjs';
import { ProjectRepository } from './repository.mjs';

const execFileAsync = promisify(execFile);
const DESCRIPTION_MAX_BYTES = 256 * 1024;
const INTAKE_STATUSES = new Set(['draft', 'running', 'ready', 'failed', 'cancelled']);
const LIFECYCLE_STATUSES = new Set(['draft', 'active', 'archived', 'trashed', 'purged']);

export class ProjectService {
  constructor({ db, config, operations, emit = () => undefined, clock = now, repositoryService = null, workflowDraft = null, executionReader = async () => [], eventFactory = () => null }) {
    this.db = db;
    this.repository = new ProjectRepository(db);
    this.repositoryService = repositoryService;
    this.workflowDraft = workflowDraft || defaultWorkflowDraftGateway();
    this.executionReader = executionReader;
    this.eventFactory = eventFactory;
    this.config = config;
    this.operations = operations;
    this.emit = emit;
    this.clock = clock;
    this.interruptedHandlers = new Map();
    this.operations.registerHandler?.('project.intake', {
      cancel: (operation) => this.cancelOperationIntake(operation),
      recover: async () => false
    });
    for (const kind of ['project.archive', 'project.trash', 'project.restore', 'project.purge']) {
      this.operations.registerHandler?.(kind, { recover: async () => false });
    }
  }

  async listProjects({ includePurged = false } = {}) {
    const rows = await this.repository.listProjects(includePurged);
    return Promise.all(rows.map((row) => this.aggregate(row)));
  }

  async getProject(projectId, { includePurged = false } = {}) {
    const row = await this.repository.project(projectId);
    if (!row || (!includePurged && row.status === 'purged')) throw new AppError('not_found', 'project not found');
    return this.aggregate(row);
  }

  async createProject(input = {}, ctx = {}) {
    const name = String(input.name || '').trim();
    assert(name.length >= 1 && name.length <= 160, 'invalid_input', 'project name must be between 1 and 160 characters', { status: 422 });
    const description = String(input.description || '');
    assert(Buffer.byteLength(description, 'utf8') <= DESCRIPTION_MAX_BYTES, 'invalid_input', 'project description exceeds 256 KiB', { status: 422 });
    const projectId = id('prj');
    const bindingId = id('repo');
    const intakeId = id('int');
    const workflowDraftId = id('wfd');
    const timestamp = this.clock();
    const sourceInput = input.repository?.source || input.source || null;
    const source = sourceInput ? normalizeRepositorySource(sourceInput, this.config) : null;
    const mode = String(input.mode || input.intake?.mode || (source ? 'existing' : 'brainstorm')).toLowerCase();
    assert(['brainstorm', 'existing'].includes(mode), 'invalid_input', 'intake mode is invalid', { status: 422 });
    if (mode === 'existing') assert(source, 'repository_source_invalid', 'existing intake requires a repository source', { status: 422 });
    const relative = `projects/${projectId}`;
    const emptyBrief = {};
    const emptyHash = hashJson(emptyBrief);
    const workflowStatement = this.workflowDraft.createStatement({ id: workflowDraftId, projectId, timestamp });
    const bindingStatement = this.repositoryService?.pendingBindingStatement({ bindingId, projectId, relative, sourceKind: source?.kind || 'none', locator: sourceLocator(source), timestamp });
    await this.repository.createDraft({ projectId, name, description, intakeId, mode, sourceKind: source?.kind || 'none', sourceLocator: sourceLocator(source), workflowDraftStatement: workflowStatement, briefHash: emptyHash, timestamp, bindingStatement, actor: ctx.actor });
    return this.getProject(projectId);
  }

  async updateProject(projectId, input = {}, ctx = {}) {
    const current = await this.requireProject(projectId, { includePurged: true });
    const expected = requiredRevision(input.expected_revision);
    const name = input.name == null ? null : String(input.name).trim();
    const description = input.description == null ? null : String(input.description);
    if (name != null) assert(name.length >= 1 && name.length <= 160, 'invalid_input', 'project name must be between 1 and 160 characters', { status: 422 });
    if (description != null) assert(Buffer.byteLength(description, 'utf8') <= DESCRIPTION_MAX_BYTES, 'invalid_input', 'project description exceeds 256 KiB', { status: 422 });
    try {
      await this.repository.updateProject({ projectId, expectedRevision: expected, name, description, timestamp: this.clock(), audit: auditStatement('project.updated', 'project', projectId, { expected_revision: expected }, ctx.actor, this.clock()) });
    } catch (error) { throw revisionError(error, current.revision); }
    return this.getProject(projectId);
  }

  async listBriefs(projectId) {
    await this.requireProject(projectId, { includePurged: true });
    return (await this.repository.briefs(projectId)).map(briefView);
  }

  async getBrief(projectId, revision = null) {
    await this.requireProject(projectId, { includePurged: true });
    const row = await this.repository.brief(projectId, revision);
    if (!row) throw new AppError('not_found', 'brief revision not found');
    return briefView(row);
  }

  async createBrief(projectId, input = {}, ctx = {}) {
    const project = await this.requireProject(projectId);
    const content = input.content && typeof input.content === 'object' && !Array.isArray(input.content)
      ? input.content
      : { objective: String(input.objective || ''), constraints: Array.isArray(input.constraints) ? input.constraints : [], acceptance: Array.isArray(input.acceptance) ? input.acceptance : [] };
    const encoded = asJson(content);
    assert(Buffer.byteLength(encoded, 'utf8') <= DESCRIPTION_MAX_BYTES, 'invalid_input', 'brief exceeds 256 KiB', { status: 422 });
    const revision = Number((await this.repository.nextBriefRevision(projectId)).revision);
    const contentHash = hashJson(content);
    const timestamp = this.clock();
    try {
      await this.repository.createBrief({ projectId, revision, contentJson: encoded, contentHash, projectRevision: project.revision, timestamp, actor: ctx.actor, workflowStatement: this.workflowDraft.updateBriefStatement({ projectId, revision, contentHash, timestamp }) });
    } catch (error) { throw revisionError(error, project.revision); }
    return this.getBrief(projectId, revision);
  }

  async listIntakes(projectId) {
    await this.requireProject(projectId, { includePurged: true });
    return (await this.repository.intakes(projectId)).map(intakeView);
  }

  async getIntake(intakeId, { internal = false } = {}) {
    const row = await this.repository.intake(intakeId);
    if (!row) throw new AppError('not_found', 'intake not found');
    return intakeView(row, { internal });
  }

  async startIntake(projectId, input = {}, ctx = {}) {
    const project = await this.requireProject(projectId);
    const intake = await this.currentIntake(projectId);
    const mode = String(input.mode || intake.mode || 'brainstorm').toLowerCase();
    assert(['brainstorm', 'existing'].includes(mode), 'invalid_input', 'intake mode is invalid', { status: 422 });
    const sourceInput = input.source || input.repository?.source || (intake.source_kind !== 'none' ? sourceFromIntake(intake) : null);
    const source = mode === 'existing' ? normalizeRepositorySource(sourceInput, this.config) : null;
    if (['running'].includes(intake.status)) throw new AppError('intake_already_running', 'intake is already running', { status: 409 });
    const expected = input.expected_revision == null ? project.revision : requiredRevision(input.expected_revision);
    if (expected !== project.revision) throw new AppError('revision_conflict', 'project revision has changed', { status: 409, details: { expected_revision: expected, current_revision: project.revision } });
    const executor = (op) => this.executeIntake(op, project.id, intake.id, mode, source, ctx);
    // Persist the running state before the worker is released.  This also
    // makes a process restart observe a coherent intake/operation pair.
    const operation = await this.operations.create({ kind: 'project.intake', resourceType: 'project_intake', resourceId: intake.id, actor: ctx.actor || 'usr_local_owner' });
    const timestamp = this.clock();
    await this.repository.startIntake({ intakeId: intake.id, projectId: project.id, mode, operationId: operation.operation_id, sourceKind: source?.kind || 'none', sourceLocator: source?.locator || source?.path || source?.url || '', projectRevision: project.revision, timestamp, actor: ctx.actor }).catch(async (error) => {
      await this.operations.cancel(operation.operation_id, { expected_revision: operation.revision }).catch(() => undefined);
      throw revisionError(error, project.revision);
    });
    queueMicrotask(() => this.operations.run(operation.operation_id, executor).catch(() => undefined));
    return { ...operation, status: 'running', resource_id: project.id, intake_id: intake.id, revision: intake.revision + 1 };
  }

  async retryIntake(intakeId, input = {}, ctx = {}) {
    const intake = await this.getIntake(intakeId, { internal: true });
    assert(intake.status === 'failed', 'invalid_state', 'only a failed intake can be retried', { status: 409 });
    return this.startIntake(intake.project_id, { ...input, expected_revision: undefined, mode: intake.mode, source: sourceFromIntake(intake) }, ctx);
  }

  async resumeIntake(intakeId, input = {}, ctx = {}) {
    const intake = await this.getIntake(intakeId, { internal: true });
    assert(['cancelled', 'failed'].includes(intake.status), 'invalid_state', 'only a cancelled or interrupted intake can be resumed', { status: 409 });
    return this.startIntake(intake.project_id, { ...input, expected_revision: undefined, mode: intake.mode, source: sourceFromIntake(intake) }, ctx);
  }

  async uploadIntake(intakeId, upload, ctx = {}) {
    const intake = await this.getIntake(intakeId, { internal: true });
    assert(upload && typeof upload === 'object' && Array.isArray(upload.files), 'invalid_input', 'upload payload is invalid', { status: 422 });
    const root = path.resolve(String(upload.staging_root || ''));
    const home = path.resolve(this.config.home);
    const uploadRoot = path.join(home, '.staging', 'uploads');
    assert(root.startsWith(`${uploadRoot}${path.sep}`), 'repository_source_invalid', 'upload staging path is outside the upload workspace', { status: 422 });
    assert(fs.existsSync(root) && fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'repository_source_invalid', 'upload staging directory is missing', { status: 422 });
    try {
      const operation = await this.startIntake(intake.project_id, { mode: 'existing', source: { kind: 'upload', locator: root }, expected_revision: undefined }, ctx);
      return { ...operation, upload_file_count: upload.files.length, upload_total_bytes: Number(upload.total_bytes || 0) };
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async cancelIntake(intakeId, input = {}, ctx = {}) {
    const intake = await this.getIntake(intakeId, { internal: true });
    assert(INTAKE_STATUSES.has(intake.status) && ['running', 'draft'].includes(intake.status), 'invalid_state', 'intake is not cancellable', { status: 409 });
    if (intake.operation_id) {
      const operation = await this.operations.get(intake.operation_id).catch(() => null);
      if (operation && !['completed', 'failed', 'cancelled'].includes(operation.status)) await this.operations.cancel(intake.operation_id, { expected_revision: Number(input.expected_revision || operation.revision) });
    }
    const timestamp = this.clock();
    await this.repository.cancelIntake({ intakeId: intake.id, projectId: intake.project_id, timestamp, actor: ctx.actor });
    return this.getIntake(intake.id);
  }

  async confirmBrief(projectId, revision, input = {}, ctx = {}) {
    const project = await this.requireProject(projectId);
    const briefRevision = Number(revision);
    assert(Number.isInteger(briefRevision) && briefRevision > 0, 'invalid_input', 'brief revision is required', { status: 422 });
    const brief = await this.repository.brief(projectId, briefRevision);
    if (!brief) throw new AppError('not_found', 'brief revision not found');
    const head = await this.repository.briefHead(projectId);
    if (Number(head?.confirmed_revision || 0) === briefRevision) return this.getProject(projectId);
    const intake = await this.currentIntake(projectId);
    const expectedIntake = input.intake_revision == null ? intake.revision : requiredRevision(input.intake_revision);
    const expectedProject = input.expected_revision == null ? project.revision : requiredRevision(input.expected_revision);
    const blockers = [];
    if (!['ready'].includes(intake.status)) blockers.push('intake_not_ready');
    if (expectedProject !== project.revision) blockers.push('project_revision');
    if (expectedIntake !== intake.revision) blockers.push('intake_revision');
    if (Number(head?.revision || 0) !== briefRevision) blockers.push('brief_revision');
    if (blockers.length) {
      if (blockers.includes('brief_revision')) throw new AppError('revision_conflict', 'brief preview revision has changed', { status: 409, details: { expected_revision: briefRevision, current_revision: Number(head?.revision || 0) } });
      throw new AppError('project_not_ready', 'project is not ready to confirm this brief', { status: 409, details: this.readinessDetails(project, intake, head, blockers) });
    }
    const timestamp = this.clock();
    try {
      await this.repository.confirmBrief({ projectId, briefRevision, briefHash: brief.content_hash, projectRevision: project.revision, timestamp, actor: ctx.actor, workflowStatement: this.workflowDraft.updateBriefStatement({ projectId, revision: briefRevision, contentHash: brief.content_hash, timestamp }), event: this.eventFactory('brief.confirmed', { project_id: projectId, revision: briefRevision, brief_hash: brief.content_hash }) });
    } catch (error) { throw revisionError(error, project.revision); }
    this.emit({ type: 'brief.confirmed', project_id: projectId, revision: briefRevision });
    return this.getProject(projectId);
  }

  async archiveProject(projectId, input = {}, ctx = {}) { return this.lifecycleOperation(projectId, 'archive', input, ctx); }
  async trashProject(projectId, input = {}, ctx = {}) { return this.lifecycleOperation(projectId, 'trash', input, ctx); }
  async restoreProject(projectId, input = {}, ctx = {}) { return this.lifecycleOperation(projectId, 'restore', input, ctx); }
  async purgeProject(projectId, input = {}, ctx = {}) { return this.lifecycleOperation(projectId, 'purge', input, ctx); }

  async assertReady(projectId, { command = '' } = {}) {
    const project = await this.requireProject(projectId);
    const intake = await this.currentIntake(projectId);
    const head = await this.repository.briefHead(projectId);
    const blockers = [];
    if (project.status !== 'active' || project.onboarding_state !== 'confirmed') blockers.push('project_not_confirmed');
    if (intake.status !== 'ready') blockers.push('intake_not_ready');
    if (!head?.confirmed_revision || !head?.confirmed_hash) blockers.push('brief_not_confirmed');
    if (blockers.length) throw new AppError('project_not_ready', `project is not ready for ${command || 'this operation'}`, { status: 409, details: this.readinessDetails(project, intake, head, blockers) });
    return { project_revision: project.revision, intake_revision: intake.revision, confirmed_brief_revision: head.confirmed_revision };
  }

  async recover() {
    const pending = await this.repository.pendingIntakes();
    for (const intake of pending) {
      const operation = intake.operation_id ? await this.operations.get(intake.operation_id).catch(() => null) : null;
      if (operation?.status === 'completed') continue;
      if (operation?.status === 'cancelled') {
        await this.repository.cancelIntake({ intakeId: intake.id, projectId: intake.project_id, timestamp: this.clock(), requireStatus: false }).catch(() => undefined);
        continue;
      }
      await this.repository.markIntakeInterrupted({ intakeId: intake.id, projectId: intake.project_id, timestamp: this.clock() }).catch(() => undefined);
    }
    return pending.length;
  }

  async cancelOperationIntake(operation) {
    const timestamp = this.clock();
    const intake = await this.repository.intake(operation.resource_id);
    if (!intake || intake.status !== 'running') return false;
    await this.repository.markCancelledByOperation({ intakeId: intake.id, projectId: intake.project_id, timestamp });
    return true;
  }

  async executeIntake(operationContext, projectId, intakeId, mode, source, ctx = {}) {
    const project = await this.requireProject(projectId);
    const intake = await this.repository.intake(intakeId);
    const relative = `projects/${projectId}`;
    const checkout = resolveWorkspacePath(this.config.home, relative);
    const staging = path.join(this.config.home, '.staging', `${projectId}-${operationContext ? 'intake' : 'probe'}-${Date.now()}`);
    fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
    try {
      operationContext.ensureActive();
      let imported;
      if (mode === 'brainstorm') imported = await createBrainstormBaseline(staging);
      else if (source?.kind === 'upload' || source?.kind === 'archive') {
        const sourceRoot = path.resolve(String(source.locator || ''));
        const home = path.resolve(this.config.home);
        if (!sourceRoot.startsWith(`${home}${path.sep}`) || !fs.existsSync(sourceRoot)) throw new AppError('repository_source_invalid', 'staged upload is missing', { status: 422 });
        copyDirectorySafe(sourceRoot, staging);
        const manifest = manifestDirectory(staging);
        imported = { revision: manifest.hash, hash: manifest.hash, manifest };
      } else {
        const before = await probeRepositorySource(source, this.config, { signal: operationContext.signal });
        await operationContext.emit('repository.probe.completed', { source_kind: before.kind, source_revision: before.revision, source_hash: before.hash });
        imported = await stageRepositorySource(source, staging, this.config, { signal: operationContext.signal });
        const after = await probeRepositorySource(source, this.config, { signal: operationContext.signal });
        assertIntakeSourceStable(before, after);
      }
      operationContext.ensureActive();
      if (!await gitHead(staging).catch(() => '')) await createImportedBaseline(staging);
      const manifest = manifestDirectory(staging);
      if (fs.existsSync(checkout)) {
        const stat = fs.lstatSync(checkout);
        if (stat.isSymbolicLink()) throw new AppError('repository_line_fault', 'managed checkout is a symlink', { status: 409 });
        fs.rmSync(checkout, { recursive: true, force: true });
      }
      atomicRename(staging, checkout);
      const headSha = await gitHead(checkout).catch(() => '');
      await this.commitIntakeReady(projectId, intakeId, {
        mode, source, sourceRevision: imported.revision || '', sourceHash: imported.hash || manifest.hash,
        result: { managed_relative_path: relative, baseline_sha: headSha, manifest_hash: manifest.hash, source: publicSource(source || { kind: 'none', label: 'managed' }) }
      }, ctx);
      if (source?.kind === 'upload' || source?.kind === 'archive') {
        try { fs.rmSync(path.resolve(String(source.locator || '')), { recursive: true, force: true }); } catch { /* Intake is already committed; cleanup is best effort. */ }
      }
      return { project_id: projectId, intake_id: intakeId, status: 'ready', revision: Number(intake.revision) + 1, baseline_sha: headSha, manifest_hash: manifest.hash };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      await this.commitIntakeFailed(projectId, intakeId, error, ctx);
      throw error;
    }
  }

  async commitIntakeReady(projectId, intakeId, details, ctx = {}) {
    const timestamp = this.clock();
    const source = details.source;
    const sourceKind = source?.kind || 'none';
    const locator = sourceLocator(source);
    const sourceHash = String(details.sourceHash || '');
    const sourceRevision = String(details.sourceRevision || '');
    const binding = await this.repositoryService.projectBinding(projectId);
    const extraStatements = this.repositoryService.intakeReadyStatements({ projectId, source, sourceRevision, sourceHash, result: details.result, timestamp, binding });
    await this.repository.markReady({ intakeId, projectId, sourceKind, sourceLocator: locator, sourceRevision, sourceHash, resultJson: asJson(details.result), timestamp, actor: ctx.actor, extraStatements });
    this.emit({ type: 'project.intake.ready', project_id: projectId, intake_id: intakeId });
  }

  async commitIntakeFailed(projectId, intakeId, error, ctx = {}) {
    const current = await this.repository.intake(intakeId);
    if (current?.status === 'cancelled' || error?.code === 'operation_cancelled') return;
    const code = String(error?.code || 'intake_failed').replace(/[^a-z0-9_]/gi, '_').slice(0, 120) || 'intake_failed';
    const timestamp = this.clock();
    await this.repository.markFailed({ intakeId, projectId, errorCode: code, timestamp, actor: ctx.actor }).catch(() => undefined);
  }

  async lifecycleOperation(projectId, action, input = {}, ctx = {}) {
    const project = await this.requireProject(projectId, { includePurged: true });
    const expected = requiredRevision(input.expected_revision);
    if (expected !== project.revision) throw new AppError('revision_conflict', 'project revision has changed', { status: 409, details: { expected_revision: expected, current_revision: project.revision } });
    if (action === 'purge') {
      assert(project.status === 'trashed', 'invalid_state', 'only a trashed project can be purged', { status: 409 });
      assert(String(input.confirm_name || input.project_name || '') === project.name, 'project_purge_confirmation_mismatch', 'project name confirmation does not match', { status: 409 });
    }
    const inUse = Number(await this.executionReader(projectId, { active: true }));
    const locked = Number(await this.repositoryService.projectActiveLocks(projectId));
    if (inUse || locked) throw new AppError('project_in_use', 'project has active work', { status: 409, details: { active_executions: inUse, locked_lines: locked } });
    const operation = await this.operations.create({ kind: `project.${action}`, resourceType: 'project', resourceId: projectId, actor: ctx.actor || 'usr_local_owner', executor: (op) => this.executeLifecycle(op, projectId, action, expected, input, ctx) });
    return { ...operation, status: 'pending', resource_id: projectId, action };
  }

  async executeLifecycle(operationContext, projectId, action, expected, input, ctx) {
    const project = await this.requireProject(projectId, { includePurged: true });
    if (project.revision !== expected) throw new AppError('revision_conflict', 'project revision has changed', { status: 409 });
    const lifecycle = await this.repositoryService.executeProjectLifecycle({ operationContext, project, action, ctx });
    await this.persistLifecycle(projectId, action, expected, lifecycle.result, ctx, lifecycle.repositoryStatement);
    return this.getProject(projectId, { includePurged: true });
  }

  async persistLifecycle(projectId, action, expected, result, ctx, repositoryStatement) {
    const timestamp = this.clock();
    const transition = { archive: ['active', 'active', 'archived'], trash: ['active', 'archived', 'trashed'], restore: ['trashed', 'trashed', 'active'], purge: ['trashed', 'trashed', 'purged'] }[action];
    if (!transition) throw new AppError('invalid_input', 'project lifecycle action is invalid', { status: 422 });
    try { await this.repository.lifecycle({ projectId, action, expectedRevision: expected, result, timestamp, actor: ctx.actor, repositoryStatement, event: this.eventFactory(`project.${action}`, { project_id: projectId, ...result }) }); } catch (error) { throw revisionError(error, expected); }
  }

  async currentIntake(projectId) {
    const row = await this.repository.currentIntake(projectId);
    if (!row) throw new AppError('not_found', 'project intake not found');
    return intakeView(row, { internal: true });
  }

  async requireProject(projectId, { includePurged = false } = {}) {
    const row = await this.repository.project(projectId);
    if (!row || (!includePurged && row.status === 'purged')) throw new AppError('not_found', 'project not found');
    return row;
  }

  async aggregate(project) {
    const briefHead = await this.repository.briefHead(project.id);
    const [brief, intake, workflowDraft, workflow, repositoryState, executions] = await Promise.all([
      this.repository.brief(project.id, briefHead?.revision ?? null),
      this.repository.currentIntake(project.id),
      this.workflowDraft.get(project.workflow_draft_id),
      this.workflowDraft.latest(project.id),
      this.repositoryService.projectRepositoryState(project.id),
      this.executionReader(project.id, { limit: 20 })
    ]);
    const { binding, connections, lines } = repositoryState;
    return {
      ...project,
      brief: briefView(brief),
      brief_head: briefHead ? { ...briefHead } : null,
      intake: intakeView(intake),
      workflow_draft: workflowDraftView(workflowDraft),
      workflow: workflowView(workflow),
      repository: binding ? {
        id: binding.id, project_id: binding.project_id, status: binding.status, revision: binding.revision,
        head_sha: binding.head_sha, baseline_sha: binding.baseline_sha,
        connection_id: binding.connection_id, target_id: binding.target_id, line_id: binding.line_id,
        source: binding.source_kind ? { kind: binding.source_kind, display_label: sourceDisplay(binding.source_kind, binding.source_locator), revision: binding.source_revision, hash: binding.source_hash, read_only: true } : null,
        fault_code: binding.fault_code || '', fault: parseJson(binding.fault_json, {})
      } : null,
      repository_connections: connections,
      repository_lines: lines,
      executions
    };
  }

  readinessDetails(project, intake, head, blockers = []) {
    return { project_revision: Number(project?.revision || 0), intake_revision: Number(intake?.revision || 0), confirmed_brief_revision: head?.confirmed_revision == null ? null : Number(head.confirmed_revision), blockers: [...new Set(blockers)] };
  }
}

function requiredRevision(value) {
  const revision = Number(value);
  assert(Number.isInteger(revision) && revision > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
  return revision;
}

function revisionError(error, currentRevision) {
  if (String(error?.message || '').includes('transaction_precondition_failed') || error?.code === 'revision_conflict') return new AppError('revision_conflict', 'revision has changed', { status: 409, details: { current_revision: currentRevision } });
  return error;
}

export function assertIntakeSourceStable(before, after) {
  if (before.revision !== after.revision || (before.hash && after.hash && before.hash !== after.hash)) {
    throw new AppError('intake_source_changed', 'repository source changed during intake', {
      status: 409,
      details: { source_kind: before.kind, before_revision: before.revision, after_revision: after.revision }
    });
  }
  return after;
}

function sourceFromIntake(intake) {
  if (!intake || intake.source_kind === 'none') return null;
  if (intake.source_kind === 'fixture') return { kind: 'fixture', id: String(intake.source_locator).replace(/^fixture:\/\//, '') };
  if (intake.source_kind === 'git') return { kind: 'git', url: intake.source_locator };
  if (intake.source_kind === 'local') return { kind: 'local', path: intake.source_locator };
  return { kind: intake.source_kind, locator: intake.source_locator };
}

function sourceLocator(source) {
  if (!source) return '';
  if (source.kind === 'fixture') return `fixture://${source.id}`;
  return String(source.locator || source.path || source.url || '');
}

function briefView(row) {
  if (!row) return null;
  const { content_json: _contentJson, ...metadata } = row;
  return { ...metadata, content: parseJson(row.content_json, {}) };
}

function intakeView(row, { internal = false } = {}) {
  if (!row) return null;
  const { payload_json: payloadJson, result_json: resultJson, ...metadata } = row;
  const result = parseJson(resultJson, {});
  if (internal) return { ...metadata, payload: parseJson(payloadJson, {}), result };
  const { source_locator: _sourceLocator, ...publicMetadata } = metadata;
  return {
    ...publicMetadata,
    source: { kind: row.source_kind, display_label: sourceDisplay(row.source_kind, row.source_locator), revision: row.source_revision, hash: row.source_hash, read_only: row.source_kind !== 'upload' },
    payload: parseJson(payloadJson, {}),
    result: Object.fromEntries(Object.entries(result).filter(([key]) => !/(?:path|locator)$/i.test(key)))
  };
}

function workflowDraftView(row) {
  if (!row) return null;
  const { graph_json: graphJson, ...metadata } = row;
  return { ...metadata, graph: parseJson(graphJson, {}) };
}

function workflowView(row) {
  if (!row) return null;
  const { tasks_json: tasksJson, ...metadata } = row;
  return { ...metadata, tasks: parseJson(tasksJson, []) };
}

function sourceDisplay(kind, locator) {
  const value = String(locator || '');
  if (kind === 'fixture') return value.replace(/^fixture:\/\//, '') || 'fixture';
  if (kind === 'git') { try { const parsed = new URL(value); return `${parsed.hostname}${parsed.pathname}`; } catch { return 'HTTPS Git'; } }
  if (kind === 'local' || kind === 'upload' || kind === 'archive') return path.basename(value) || kind;
  return kind === 'none' ? 'Managed project' : kind;
}

function defaultWorkflowDraftGateway() {
  const missing = () => { throw new Error('workflow_draft_gateway_required'); };
  return { createStatement: missing, updateBriefStatement: missing, get: async () => null, latest: async () => null };
}

async function createBrainstormBaseline(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  await execFileAsync('git', ['init', directory], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  await runGit(directory, ['config', 'user.email', 'aiws-fixture@example.invalid']);
  await runGit(directory, ['config', 'user.name', 'AIWS Fixture']);
  fs.writeFileSync(path.join(directory, 'README.md'), '# AIWS project\n', { encoding: 'utf8', mode: 0o600 });
  await runGit(directory, ['add', '--', 'README.md']);
  await execFileAsync('git', ['-C', path.resolve(directory), 'commit', '-m', 'AIWS project baseline', '--no-gpg-sign'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' } });
  const revision = (await runGit(directory, ['rev-parse', 'HEAD'])).stdout;
  return { revision, hash: manifestDirectory(directory).hash };
}

async function createImportedBaseline(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  await execFileAsync('git', ['init', directory], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  await runGit(directory, ['config', 'user.email', 'aiws-fixture@example.invalid']);
  await runGit(directory, ['config', 'user.name', 'AIWS Fixture']);
  await runGit(directory, ['add', '--all']);
  await execFileAsync('git', ['-C', path.resolve(directory), 'commit', '--allow-empty', '-m', 'AIWS imported baseline', '--no-gpg-sign'], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' }
  });
}
