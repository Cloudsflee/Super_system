import fs from 'node:fs';
import path from 'node:path';
import { AppError, assert } from '../../errors.mjs';
import { hashJson, id, now, parseJson } from '../../crypto.mjs';
import { resolveWorkspacePath } from '../../path-policy.mjs';
import {
  atomicRename,
  createDeterministicArchive,
  manifestDirectory,
  normalizeRepositorySource,
  probeRepositorySource,
  publicSource
} from './adapter.mjs';
import { RepositoryRepository } from './repository.mjs';

export class RepositoryService {
  constructor({ db, config, operations, emit = () => undefined, clock = now, projectReader = async () => null }) {
    this.db = db;
    this.repository = new RepositoryRepository(db);
    this.projectReader = projectReader;
    this.config = config;
    this.operations = operations;
    this.emit = emit;
    this.clock = clock;
    for (const kind of ['repository.probe', 'repository.recover', 'repository.archive']) {
      this.operations.registerHandler?.(kind, {
        cancel: (operation) => this.cancelLineOperation(operation),
        recover: async () => false
      });
    }
  }

  async listConnections(projectId) {
    await this.requireProject(projectId);
    return (await this.repository.connections(projectId)).map(connectionView);
  }

  async getConnection(connectionId) {
    const row = await this.repository.connection(connectionId);
    if (!row) throw new AppError('not_found', 'repository connection not found');
    return connectionView(row);
  }

  async createConnection(projectId, input = {}, ctx = {}) {
    await this.requireProject(projectId);
    const source = normalizeRepositorySource(input.source || input, this.config);
    const timestamp = this.clock(), connectionId = id('con');
    try {
      await this.repository.createConnection({ id: connectionId, projectId, source, remoteUrl: source.kind === 'git' ? source.url : '', locator: sourceLocator(source), timestamp, actor: ctx.actor });
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('already_exists', 'project already has a repository connection', { status: 409 });
      throw error;
    }
    return this.getConnection(connectionId);
  }

  async updateConnection(connectionId, input = {}, ctx = {}) {
    const current = await this.connectionRow(connectionId);
    const expected = requiredRevision(input.expected_revision);
    const source = input.source ? normalizeRepositorySource(input.source, this.config) : null;
    const timestamp = this.clock();
    try {
      await this.repository.updateConnection({ connectionId, expected, sourceKind: source?.kind || null, locator: source ? sourceLocator(source) : null, remoteUrl: source?.kind === 'git' ? source.url : null, label: source?.label || null, timestamp, actor: ctx.actor });
    } catch (error) { throw revisionError(error, current.revision); }
    return this.getConnection(connectionId);
  }

  async deleteConnection(connectionId, input = {}, ctx = {}) {
    const current = await this.connectionRow(connectionId);
    const expected = requiredRevision(input.expected_revision);
    const targets = Number((await this.repository.targetCount(connectionId)).count);
    if (targets) throw new AppError('project_in_use', 'repository connection still has targets', { status: 409, details: { target_count: targets } });
    try {
      await this.repository.deleteConnection({ connectionId, expected, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) { throw revisionError(error, current.revision); }
    return { id: connectionId, deleted: true, revision: expected };
  }

  async listTargets(connectionId) {
    await this.connectionRow(connectionId);
    return (await this.repository.targets(connectionId)).map(targetView);
  }

  async getTarget(targetId) {
    const row = await this.targetRow(targetId);
    return targetView(row);
  }

  async createTarget(connectionId, input = {}, ctx = {}) {
    const connection = await this.connectionRow(connectionId);
    const repository = String(input.repository || input.name || connection.display_label || 'repository').trim();
    const branch = String(input.default_branch || 'main').trim();
    assert(repository.length >= 1 && repository.length <= 500, 'invalid_input', 'repository target is required', { status: 422 });
    assert(/^[A-Za-z0-9._\/-]{1,240}$/.test(branch) && !branch.includes('..'), 'invalid_input', 'default branch is invalid', { status: 422 });
    const targetId = id('tgt'), timestamp = this.clock();
    try {
      await this.repository.createTarget({ id: targetId, connectionId, repository, branch, timestamp, actor: ctx.actor, projectId: connection.project_id });
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('already_exists', 'repository connection already has a target', { status: 409 });
      throw error;
    }
    return this.getTarget(targetId);
  }

  async updateTarget(targetId, input = {}, ctx = {}) {
    const current = await this.targetRow(targetId), expected = requiredRevision(input.expected_revision);
    const branch = input.default_branch == null ? null : String(input.default_branch).trim();
    if (branch != null) assert(/^[A-Za-z0-9._\/-]{1,240}$/.test(branch) && !branch.includes('..'), 'invalid_input', 'default branch is invalid', { status: 422 });
    try {
      await this.repository.updateTarget({ targetId, expected, repository: input.repository == null ? null : String(input.repository).trim(), branch, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) { throw revisionError(error, current.revision); }
    return this.getTarget(targetId);
  }

  async deleteTarget(targetId, input = {}, ctx = {}) {
    const current = await this.targetRow(targetId), expected = requiredRevision(input.expected_revision);
    const lines = Number((await this.repository.lineCount(targetId)).count);
    if (lines) throw new AppError('project_in_use', 'repository target still has lines', { status: 409, details: { line_count: lines } });
    try {
      await this.repository.deleteTarget({ targetId, expected, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) { throw revisionError(error, current.revision); }
    return { id: targetId, deleted: true, revision: expected };
  }

  async listLines(projectId) {
    await this.requireProject(projectId);
    return (await this.repository.lines(projectId)).map(lineView);
  }

  async getLine(lineId) { return lineView(await this.lineRow(lineId)); }

  async createLine(projectId, input = {}, ctx = {}) {
    await this.requireProject(projectId);
    const target = input.target_id ? await this.targetRow(input.target_id) : null;
    const lineKind = String(input.line_kind || 'managed_checkout');
    assert(['external_readonly', 'managed_staging', 'managed_checkout'].includes(lineKind), 'invalid_input', 'repository line kind is invalid', { status: 422 });
    const relative = String(input.managed_relative_path || `projects/${projectId}`);
    resolveWorkspacePath(this.config.home, relative);
    const lineId = id('lin'), timestamp = this.clock();
    try {
      await this.repository.createLine({ id: lineId, projectId, targetId: target?.id || null, lineKind, branch: String(input.branch || target?.default_branch || ''), relative, timestamp, actor: ctx.actor });
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('already_exists', 'repository line kind already exists for this project', { status: 409 });
      throw error;
    }
    return this.getLine(lineId);
  }

  async updateLine(lineId, input = {}, ctx = {}) {
    const current = await this.lineRow(lineId), expected = requiredRevision(input.expected_revision);
    if (current.locked_by_operation_id) throw lockedError(current);
    const branch = input.branch == null ? null : String(input.branch).trim();
    const timestamp = this.clock();
    try {
      await this.repository.updateLine({ lineId, expected, branch, status: input.status == null ? null : String(input.status), timestamp, actor: ctx.actor });
    } catch (error) { throw revisionError(error, current.revision); }
    return this.getLine(lineId);
  }

  async deleteLine(lineId, input = {}, ctx = {}) {
    const current = await this.lineRow(lineId), expected = requiredRevision(input.expected_revision);
    if (current.locked_by_operation_id) throw lockedError(current);
    const artifacts = Number((await this.repository.artifactCount(lineId)).count);
    if (artifacts) throw new AppError('project_in_use', 'repository line has retained artifacts', { status: 409, details: { artifact_count: artifacts } });
    try {
      await this.repository.deleteLine({ lineId, expected, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) { throw revisionError(error, current.revision); }
    return { id: lineId, deleted: true, revision: expected };
  }

  async probeLine(lineId, input = {}, ctx = {}) {
    const line = await this.lineRow(lineId), expected = requiredRevision(input.expected_revision);
    if (line.revision !== expected) throw new AppError('revision_conflict', 'repository line revision changed', { status: 409, details: { current_revision: line.revision } });
    if (line.locked_by_operation_id) throw lockedError(line);
    const operation = await this.operations.create({ kind: 'repository.probe', resourceType: 'repository_line', resourceId: lineId, actor: ctx.actor || 'usr_local_owner' });
    await this.acquireLine(lineId, operation.operation_id, expected);
    queueMicrotask(() => this.operations.run(operation.operation_id, (op) => this.executeProbe(op, lineId, ctx)).catch(() => undefined));
    return { ...operation, status: 'running', resource_id: lineId, revision: expected + 1 };
  }

  async recoverLine(lineId, input = {}, ctx = {}) {
    const line = await this.lineRow(lineId), expected = requiredRevision(input.expected_revision);
    if (line.revision !== expected) throw new AppError('revision_conflict', 'repository line revision changed', { status: 409, details: { current_revision: line.revision } });
    if (line.locked_by_operation_id) throw lockedError(line);
    const operation = await this.operations.create({ kind: 'repository.recover', resourceType: 'repository_line', resourceId: lineId, actor: ctx.actor || 'usr_local_owner' });
    await this.acquireLine(lineId, operation.operation_id, expected);
    queueMicrotask(() => this.operations.run(operation.operation_id, (op) => this.executeRecover(op, lineId, ctx)).catch(() => undefined));
    return { ...operation, status: 'running', resource_id: lineId, revision: expected + 1 };
  }

  async syncLine(lineId, input = {}, ctx = {}) {
    // R3 sync is deliberately a validated probe.  Source replacement remains
    // an intake operation so it retains the same staging and revision checks.
    return this.probeLine(lineId, input, ctx);
  }

  async archiveProject(projectId, input = {}, ctx = {}) {
    const project = await this.requireProject(projectId), expected = requiredRevision(input.expected_revision);
    if (project.revision !== expected) throw new AppError('revision_conflict', 'project revision has changed', { status: 409, details: { current_revision: project.revision } });
    const line = await this.repository.managedCheckout(projectId);
    if (!line) throw new AppError('not_found', 'managed checkout line not found');
    if (line.locked_by_operation_id) throw lockedError(line);
    const operation = await this.operations.create({ kind: 'repository.archive', resourceType: 'project', resourceId: projectId, actor: ctx.actor || 'usr_local_owner' });
    await this.acquireLine(line.id, operation.operation_id, line.revision);
    queueMicrotask(() => this.operations.run(operation.operation_id, (op) => this.executeArchive(op, project, line, ctx)).catch(() => undefined));
    return { ...operation, status: 'running', resource_id: projectId, revision: expected };
  }

  async executeProbe(operationContext, lineId, ctx = {}) {
    const line = await this.lineRow(lineId);
    try {
      operationContext.ensureActive();
      const connection = line.target_id ? await this.repository.targetConnection(line.target_id) : null;
      let probe;
      if (line.line_kind === 'external_readonly' && connection && connection.source_kind !== 'none') probe = await probeRepositorySource(sourceFromConnection(connection), this.config, { signal: operationContext.signal });
      else {
        if (!line.managed_relative_path) throw new AppError('repository_line_fault', 'managed repository line is no longer materialized', { status: 409 });
        const root = resolveWorkspacePath(this.config.home, line.managed_relative_path);
        if (!fs.existsSync(root)) throw new AppError('repository_line_fault', 'managed repository line is missing', { status: 409 });
        const manifest = manifestDirectory(root);
        probe = { kind: 'managed', display_label: path.basename(root), revision: line.head_sha || manifest.hash, hash: manifest.hash, file_count: manifest.entries.length, read_only: false };
      }
      await this.repository.probeComplete({ lineId, operationId: operationContext.operationId, probe: publicProbe(probe), timestamp: this.clock(), actor: ctx.actor }).catch(async () => {
        await this.releaseLine(lineId);
      });
      await this.releaseLine(lineId);
      this.emit({ type: 'repository.probe.completed', line_id: lineId, source_revision: probe.revision, source_hash: probe.hash });
      return publicProbe(probe);
    } catch (error) {
      if (error?.code === 'operation_cancelled') { await this.releaseLine(lineId); throw error; }
      await this.markFault(lineId, error, ctx);
      throw error;
    }
  }

  async executeRecover(operationContext, lineId, ctx = {}) {
    const line = await this.lineRow(lineId);
    try {
      const root = resolveWorkspacePath(this.config.home, line.managed_relative_path);
      if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) throw new AppError('repository_line_fault', 'managed repository line is unavailable', { status: 409 });
      const manifest = manifestDirectory(root);
      await this.repository.recoverComplete({ lineId, probeJson: { manifest_hash: manifest.hash, file_count: manifest.entries.length }, manifestHash: manifest.hash, timestamp: this.clock(), actor: ctx.actor });
      this.emit({ type: 'repository.line.recovered', line_id: lineId });
      return { line_id: lineId, status: 'ready', manifest_hash: manifest.hash };
    } catch (error) {
      if (error?.code === 'operation_cancelled') { await this.releaseLine(lineId); throw error; }
      await this.markFault(lineId, error, ctx);
      throw error;
    }
  }

  async executeArchive(operationContext, project, line, ctx = {}) {
    try {
      const root = resolveWorkspacePath(this.config.home, line.managed_relative_path);
      if (!fs.existsSync(root)) throw new AppError('repository_line_fault', 'managed checkout is missing', { status: 409 });
      const archive = createDeterministicArchive(root);
      operationContext.ensureActive();
      const relative = `.archives/projects/${project.id}/r${project.revision}-${archive.sha256}.aiws-archive`;
      const target = resolveWorkspacePath(this.config.home, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, archive.bytes, { mode: 0o600 });
      const timestamp = this.clock();
      await this.repository.insertArtifact({ projectId: project.id, lineId: line.id, operationId: operationContext.operationId, kind: 'archive', relativePath: relative, manifest: archive.manifest, manifestHash: archive.manifest.hash, sourceHash: line.source_hash || '', byteSize: archive.bytes.byteLength, timestamp });
      await this.repository.archiveComplete({ lineId: line.id, manifestHash: archive.manifest.hash, timestamp });
      await this.repository.recordArchive({ projectId: project.id, archiveSha: archive.sha256, manifestHash: archive.manifest.hash, byteSize: archive.bytes.byteLength, actor: ctx.actor, timestamp });
      return { project_id: project.id, archive_sha256: archive.sha256, manifest_hash: archive.manifest.hash, byte_size: archive.bytes.byteLength };
    } catch (error) {
      if (error?.code === 'operation_cancelled') { await this.releaseLine(line.id); throw error; }
      await this.markFault(line.id, error, ctx);
      throw error;
    }
  }

  async acquireLine(lineId, operationId, expectedRevision) {
    try {
      await this.repository.acquireLine({ lineId, operationId, expectedRevision, timestamp: this.clock() });
      const row = await this.lineRow(lineId);
      if (row.locked_by_operation_id !== operationId) throw lockedError(row);
    } catch (error) {
      if (error?.code === 'repository_line_locked') throw error;
      throw new AppError('revision_conflict', 'repository line revision changed', { status: 409 });
    }
  }

  async releaseLine(lineId) {
    await this.repository.releaseLine(lineId, this.clock());
  }

  async markFault(lineId, error, ctx = {}) {
    const code = stableFaultCode(error);
    const timestamp = this.clock();
    await this.repository.markFault({ lineId, code, timestamp, actor: ctx.actor }).catch(() => undefined);
    this.emit({ type: 'repository.line.fault', line_id: lineId, error_code: code });
  }

  async recoverInterrupted() {
    const locked = await this.repository.lockedLines();
    for (const line of locked) {
      const operation = await this.operations.get(line.locked_by_operation_id).catch(() => null);
      if (operation && !['completed', 'failed', 'cancelled'].includes(operation.status)) continue;
      await this.repository.markInterrupted(line.id, this.clock());
    }
    return locked.length;
  }

  async cancelLineOperation(operation) {
    if (!operation.resource_id) return false;
    const line = await this.repository.lineForOperation(operation.resource_type, operation.resource_id);
    if (!line) return false;
    await this.releaseLine(line.id);
    return true;
  }

  pendingBindingStatement({ bindingId, projectId, relative, sourceKind, locator, timestamp }) {
    return this.repository.pendingBindingStatement({ bindingId, projectId, relative, sourceKind, locator, timestamp });
  }

  intakeReadyStatements({ projectId, source, sourceRevision, sourceHash, result, timestamp, binding }) {
    const sourceKind = source?.kind || 'none';
    const locator = sourceLocator(source);
    const baseline = String(result.baseline_sha || '');
    const localPath = result.managed_relative_path;
    const bindingId = binding?.id || id('repo');
    const connectionId = binding?.connection_id || `con_${bindingId}`;
    const targetId = binding?.target_id || `tgt_${bindingId}`;
    const lineId = binding?.line_id || `lin_${bindingId}`;
    return this.repository.commitBindingStatements({
      binding, projectId, connectionId, targetId, lineId, localPath,
      remoteUrl: source?.kind === 'git' ? source.url : '', sourceKind, locator,
      sourceRevision: String(sourceRevision || ''), sourceHash: String(sourceHash || ''), baseline,
      displayLabel: source?.label || sourceKind, manifestHash: result.manifest_hash || '', timestamp,
      artifactId: id('rla')
    });
  }

  async projectRepositoryState(projectId) {
    const [binding, connections, lines] = await Promise.all([
      this.repository.binding(projectId), this.repository.connections(projectId), this.repository.lines(projectId)
    ]);
    return { binding, connections: connections.map(connectionView), lines: lines.map(lineView) };
  }

  lifecycleStatement({ projectId, status, trashRelativePath, timestamp }) {
    return this.repository.updateBindingLifecycle({ projectId, status, trashRelativePath, timestamp });
  }

  async projectLine(projectId) { return this.repository.managedCheckout(projectId); }
  async projectBinding(projectId) { return this.repository.binding(projectId); }
  async projectActiveLocks(projectId) {
    const row = await this.repository.activeLocks(projectId);
    return Number(row?.count || 0);
  }

  async executeProjectLifecycle({ operationContext, project, action, ctx = {} }) {
    const projectId = project.id;
    const binding = await this.projectBinding(projectId);
    const root = binding?.managed_relative_path || binding?.local_path;
    const result = {};
    if (!root) return { result, repositoryStatement: this.lifecycleStatement({ projectId, status: action === 'purge' ? 'purged' : action === 'trash' ? 'trashed' : action === 'restore' ? 'ready' : 'ready', timestamp: this.clock() }) };
    const workspace = resolveWorkspacePath(this.config.home, root);
    if (fs.existsSync(workspace) && fs.lstatSync(workspace).isSymbolicLink()) throw new AppError('repository_line_fault', 'managed workspace is a symlink', { status: 409 });
    if (action === 'archive') {
      if (!fs.existsSync(workspace)) throw new AppError('repository_line_fault', 'managed workspace is missing', { status: 409 });
      const archive = createDeterministicArchive(workspace);
      const relative = `.archives/projects/${projectId}/r${project.revision}-${archive.sha256}.aiws-archive`;
      const target = resolveWorkspacePath(this.config.home, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, archive.bytes, { mode: 0o600 });
      const line = await this.projectLine(projectId);
      if (line) await this.repository.insertArtifact({ projectId, lineId: line.id, operationId: operationContext.operationId, kind: 'archive', relativePath: relative, manifest: archive.manifest, manifestHash: archive.manifest.hash, sourceHash: line.source_hash || '', byteSize: archive.bytes.byteLength, timestamp: this.clock() });
      result.archive_sha256 = archive.sha256;
      result.manifest_hash = archive.manifest.hash;
      result.byte_size = archive.bytes.byteLength;
    } else if (['trash', 'restore', 'purge'].includes(action)) {
      if (binding?.source_kind && ['local', 'git', 'fixture'].includes(binding.source_kind) && fs.existsSync(workspace)) {
        const before = manifestDirectory(workspace).hash;
        const after = manifestDirectory(workspace).hash;
        if (before !== after) throw new AppError('repository_source_changed', 'repository manifest changed', { status: 409 });
      }
      const line = await this.projectLine(projectId);
      if (action === 'trash') {
        const trashRelative = `.trash/projects/${projectId}/${path.basename(root)}`;
        const trashPath = resolveWorkspacePath(this.config.home, trashRelative);
        const manifest = fs.existsSync(workspace) ? manifestDirectory(workspace) : { hash: hashJson({}), entries: [] };
        if (fs.existsSync(workspace)) atomicRename(workspace, trashPath);
        if (line) await this.repository.insertArtifact({ projectId, lineId: line.id, operationId: operationContext.operationId, kind: 'trash', relativePath: trashRelative, manifest, manifestHash: manifest.hash, sourceHash: line.source_hash || '', byteSize: 0, timestamp: this.clock() });
        result.trash_relative_path = trashRelative;
      } else if (action === 'restore') {
        const trashRelative = binding?.trash_relative_path || `.trash/projects/${projectId}/${path.basename(root)}`;
        const trashPath = resolveWorkspacePath(this.config.home, trashRelative);
        const destination = resolveWorkspacePath(this.config.home, root);
        if (fs.existsSync(trashPath)) atomicRename(trashPath, destination);
        const manifest = fs.existsSync(destination) ? manifestDirectory(destination) : null;
        if (binding?.source_hash && manifest && binding.source_hash !== manifest.hash && binding.source_kind !== 'git') throw new AppError('repository_source_changed', 'restored manifest does not match baseline', { status: 409 });
        if (line && manifest) await this.repository.insertArtifact({ projectId, lineId: line.id, operationId: operationContext.operationId, kind: 'restore', relativePath: root, manifest, manifestHash: manifest.hash, sourceHash: line.source_hash || '', byteSize: 0, timestamp: this.clock() });
        result.managed_relative_path = root;
      } else {
        const trashRelative = binding?.trash_relative_path || `.trash/projects/${projectId}/${path.basename(root)}`;
        const trashPath = resolveWorkspacePath(this.config.home, trashRelative);
        if (fs.existsSync(trashPath)) {
          const manifest = manifestDirectory(trashPath);
          const recorded = await this.repository.bindingTrashArtifact(projectId);
          if (recorded?.manifest_hash && recorded.manifest_hash !== manifest.hash) throw new AppError('repository_source_changed', 'trashed workspace manifest changed', { status: 409 });
          fs.rmSync(trashPath, { recursive: true, force: true });
        }
      }
    }
    const status = action === 'purge' ? 'purged' : action === 'trash' ? 'trashed' : 'ready';
    return { result, repositoryStatement: this.lifecycleStatement({ projectId, status, trashRelativePath: result.trash_relative_path || '', timestamp: this.clock() }) };
  }

  requireProject(projectId) {
    return this.projectReader(projectId).then((row) => {
      if (!row) throw new AppError('not_found', 'project not found');
      return row;
    });
  }

  async connectionRow(idValue) {
    const row = await this.repository.connection(idValue);
    if (!row) throw new AppError('not_found', 'repository connection not found');
    return row;
  }

  async targetRow(idValue) {
    const row = await this.repository.target(idValue);
    if (!row) throw new AppError('not_found', 'repository target not found');
    return row;
  }

  async lineRow(idValue) {
    const row = await this.repository.line(idValue);
    if (!row) throw new AppError('not_found', 'repository line not found');
    return row;
  }
}

function connectionView(row) {
  if (!row) return null;
  return {
    id: row.id, project_id: row.project_id, provider: row.provider, status: row.status,
    revision: row.revision, source_kind: row.source_kind, display_label: row.display_label,
    source_revision: row.source_revision, source_hash: row.source_hash, read_only: Boolean(row.read_only),
    fault_code: row.fault_code || '', fault: parseJson(row.fault_json, {}), created_at: row.created_at, updated_at: row.updated_at
  };
}

function targetView(row) {
  if (!row) return null;
  return { id: row.id, connection_id: row.connection_id, repository: row.repository, default_branch: row.default_branch, baseline_sha: shortSha(row.baseline_sha), revision: row.revision, source_revision: row.source_revision, source_hash: row.source_hash, fault_code: row.fault_code || '', fault: parseJson(row.fault_json, {}), created_at: row.created_at, updated_at: row.updated_at };
}

function lineView(row) {
  if (!row) return null;
  return { id: row.id, project_id: row.project_id, target_id: row.target_id, line_kind: row.line_kind, branch: row.branch, head_sha: shortSha(row.head_sha), baseline_sha: shortSha(row.baseline_sha), status: row.status, revision: row.revision, source_revision: row.source_revision, source_hash: row.source_hash, probe_status: row.probe_status, probe: parseJson(row.probe_json, {}), fault_code: row.fault_code || '', fault: parseJson(row.fault_json, {}), locked: Boolean(row.locked_by_operation_id), last_manifest_hash: row.last_manifest_hash, created_at: row.created_at, updated_at: row.updated_at };
}

function sourceFromConnection(connection) {
  if (connection.source_kind === 'fixture') return { kind: 'fixture', id: String(connection.source_locator).replace(/^fixture:\/\//, '') };
  if (connection.source_kind === 'git') return { kind: 'git', url: connection.source_locator || connection.remote_url };
  if (connection.source_kind === 'local') return { kind: 'local', path: connection.source_locator };
  return { kind: connection.source_kind, locator: connection.source_locator };
}

function sourceLocator(source) {
  if (!source) return '';
  if (source.kind === 'fixture') return `fixture://${source.id}`;
  return String(source.locator || source.path || source.url || '');
}

function publicProbe(probe) {
  return { source_kind: probe.kind, display_label: probe.display_label, revision: probe.revision || '', hash: probe.hash || '', file_count: probe.file_count, read_only: Boolean(probe.read_only) };
}

function requiredRevision(value) {
  const revision = Number(value);
  assert(Number.isInteger(revision) && revision > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
  return revision;
}

function revisionError(error, currentRevision) {
  if (String(error?.message || '').includes('transaction_precondition_failed')) return new AppError('revision_conflict', 'repository revision changed', { status: 409, details: { current_revision: currentRevision } });
  return error;
}

function lockedError(line) {
  return new AppError('repository_line_locked', 'repository line is locked by another operation', { status: 409, details: { line_id: line.id, revision: line.revision } });
}

function stableFaultCode(error) {
  const candidate = String(error?.code || 'repository_line_fault');
  return /^[a-z][a-z0-9_]{2,119}$/.test(candidate) ? candidate : 'repository_line_fault';
}

function shortSha(value) { return /^[a-f0-9]{40}$/.test(String(value || '')) ? String(value).slice(0, 12) : String(value || ''); }
