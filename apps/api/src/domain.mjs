import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { asJson, hashJson, id, now, parseJson, sha256 } from './crypto.mjs';
import { AppError, assert } from './errors.mjs';
import { assertReviewablePath, normalizeRelativePath, resolveWorkspacePath } from './path-policy.mjs';
import { MODEL_SUGGESTION_STATUSES } from '../../../packages/contracts/src/index.mjs';
import { DIFF_MAX_BYTES, DiffCaptureError, captureDiff, createWorktree, ensureExecutionExcludes, gitHead, gitStatus, initializeFixture, removeWorktree } from './git-fixture.mjs';
import { removeExecutionInputs, stageExecutionInputs } from './input-staging.mjs';
import { EvidenceService } from './evidence-service.mjs';
import { CODEX_ERROR_CODES, IntegrationProbeService } from './integration-probes.mjs';
import { TerminalService } from './terminal-service.mjs';
import { SecretRegistry } from './secret-registry.mjs';
import { IdentityService } from './modules/identity/service.mjs';
import { OperationService } from './modules/operations/service.mjs';
import { createR2Runtime, PROJECT_READY_COMMANDS, SETUP_GATED_COMMANDS } from './modules/r2-runtime.mjs';
import { SetupService } from './modules/setup/service.mjs';
import { CodexService } from './modules/setup/codex-service.mjs';
import { GithubService } from './modules/setup/github-service.mjs';
import { prepareOutcomeEvaluations } from './modules/outcome/evaluation.mjs';
import { qualityReviewMediaKind } from './modules/quality/media-contract.mjs';
import { ProjectService } from './modules/project/service.mjs';
import { ProjectRepository } from './modules/project/repository.mjs';
import { RepositoryService } from './modules/repository/service.mjs';
import { WorkflowRepository } from './modules/workflow/repository.mjs';
import { WorkflowService } from './modules/workflow/service.mjs';

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const RUNNER_UID = 10001;
const RUNNER_GID = 10001;
const RUNNER_RESULT_ERRORS = new Set(['runner_failed', 'runner_setup_failed', 'runner_spawn_failed', 'runner_deadline_exceeded', 'runner_output_too_large', 'broker_job_unknown', 'invalid_job_spec', 'cancelled', 'evidence_diff_too_large', 'evidence_capture_failed', 'evidence_output_missing', 'evidence_output_too_large', 'evidence_output_contains_secret', 'diff_whitespace_error', 'diff_size_check_failed', ...CODEX_ERROR_CODES]);

function grantRunnerPath(target, { directory = false } = {}) {
  try { fs.chownSync(target, RUNNER_UID, RUNNER_GID); } catch { /* Rootless and Windows hosts keep their native ownership. */ }
  try { fs.chmodSync(target, directory ? 0o770 : 0o660); } catch { /* The runner mount remains the enforcement boundary. */ }
}

function rowJson(row, field, fallback) {
  return row?.[field] == null ? fallback : parseJson(row[field], fallback);
}

function projectView(row) {
  if (!row) return null;
  return { ...row };
}

function briefView(row) {
  return row ? { ...row, content: rowJson(row, 'content_json', {}) } : null;
}

function workflowView(row) {
  if (!row) return null;
  const { tasks_json: _tasksJson, metadata_json: metadataJson, ...metadata } = row;
  return { ...metadata, tasks: rowJson(row, 'tasks_json', []), metadata: rowJson(row, 'metadata_json', {}) };
}

function contextPackView(row) {
  return row ? { ...row, source_ids: rowJson(row, 'source_ids_json', []), pack: rowJson(row, 'pack_json', {}) } : null;
}

function executionView(row, attempts = []) {
  if (!row) return null;
  const latest = new Map();
  for (const attempt of attempts) {
    const current = latest.get(attempt.task_id);
    if (!current || current.attempt_no < attempt.attempt_no) latest.set(attempt.task_id, attempt);
  }
  const attemptViews = attempts.map((attempt) => {
    const output = rowJson(attempt, 'output_json', {});
    const { output_json: _outputJson, ...metadata } = attempt;
    return { ...metadata, output };
  });
  return {
    ...row,
    input_assets: rowJson(row, 'input_assets_json', []),
    tasks: [...latest.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)).map((attempt) => attemptViews.find((item) => item.id === attempt.id)),
    attempts: attemptViews.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id) || a.attempt_no - b.attempt_no)
  };
}

function auditStatement(action, entityType, entityId, payload, actor = 'local-user') {
  return {
    sql: 'INSERT INTO audit_events(id, actor, action, entity_type, entity_id, payload_json, created_at) VALUES(?,?,?,?,?,?,?)',
    params: [id('aud'), actor, action, entityType, entityId, asJson(payload), now()]
  };
}

function eventStatement(type, executionId, taskId, data) {
  return {
    sql: 'INSERT INTO events(type, execution_id, task_id, data_json, created_at) VALUES(?,?,?,?,?)',
    params: [type, executionId ?? null, taskId ?? null, asJson(data), now()]
  };
}

function safeRunnerResult(result = {}, secrets = []) {
  const safeSecrets = (Array.isArray(secrets) ? secrets : []).filter((secret) => secret != null && String(secret).length > 0).map(String);
  const redact = (value) => safeSecrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value || ''));
  const safePaths = (value) => (Array.isArray(value) ? value : []).map((item) => String(item).replaceAll('\\', '/').slice(0, 512)).filter((item) => item && !item.startsWith('/') && !/^[A-Za-z]:/.test(item) && !item.split('/').includes('..')).slice(0, 100);
  const checks = Array.isArray(result.checks) ? result.checks.slice(0, 32).map((check) => ({
    id: String(check?.id || 'unknown').slice(0, 80), passed: Boolean(check?.passed),
    exit_code: Number.isInteger(check?.exit_code) ? check.exit_code : null,
    stdout_sha256: /^[a-f0-9]{64}$/.test(String(check?.stdout_sha256 || '')) ? String(check.stdout_sha256) : null,
    error_code: String(check?.error_code || '').slice(0, 120) || null
  })) : [];
  const events = Array.isArray(result.events) ? result.events.slice(0, 100).map((event) => ({
    type: /^runner\.[a-z._-]{1,80}$/.test(String(event?.type || '')) ? String(event.type) : 'runner.unknown',
    phase: String(event?.phase || 'unknown').slice(0, 40),
    exit_code: Number.isInteger(event?.exit_code) ? event.exit_code : null,
    file_count: Number.isInteger(event?.file_count) ? event.file_count : null,
    summary: redact(event?.summary).replace(/[\r\n\t]/g, ' ').slice(0, 240),
    summary_sha256: null
  })) : [];
  for (const event of events) event.summary_sha256 = sha256(event.summary);
  return {
    outcome: ['completed', 'failed', 'cancelled'].includes(result.outcome) ? result.outcome : 'failed',
    summary: redact(result.summary).replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]').replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/[\r\n\t]/g, ' ').slice(0, 500),
    error_code: RUNNER_RESULT_ERRORS.has(String(result.error_code || '')) ? String(result.error_code) : null,
    retryable: Boolean(result.retryable),
    changed_files: safePaths(result.changed_files),
    checks,
    events,
    output_paths: safePaths(result.output_paths),
    usage: result.usage && typeof result.usage === 'object' ? Object.fromEntries(Object.entries(result.usage).filter(([, amount]) => Number.isFinite(amount)).slice(0, 16)) : {}
  };
}

function redactText(value, secrets = []) {
  return secrets.filter(Boolean).map(String).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value || ''));
}

function assertNoStorageSymlinks(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new AppError('storage_path_invalid', 'CAS storage path is invalid', { status: 500 });
  let current = base;
  const components = [base, ...path.relative(base, resolved).split(path.sep).filter(Boolean).map((segment) => {
    current = path.join(current, segment);
    return current;
  })];
  for (const component of components) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) throw new AppError('storage_path_invalid', 'CAS storage path is invalid', { status: 500 });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
}

function isTransactionPrecondition(error) {
  return error?.name === 'TransactionPreconditionError' || error?.message === 'transaction_precondition_failed';
}

function workspaceFile(root, relative, { missingOk = true } = {}) {
  const target = resolveWorkspacePath(root, relative);
  let current = path.resolve(root);
  const segments = path.relative(current, target).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new AppError('file_symlink_forbidden', 'workspace symlinks are not editable', { status: 422, details: { path: relative } });
    } catch (error) {
      if (error?.code === 'ENOENT') return missingOk ? null : (() => { throw new AppError('file_not_found', 'workspace file not found', { status: 404, details: { path: relative } }); })();
      throw error;
    }
  }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new AppError('file_not_regular', 'workspace path is not a regular file', { status: 422, details: { path: relative } });
    return target;
  } catch (error) {
    if (error?.code === 'ENOENT' && missingOk) return null;
    if (error?.code === 'ENOENT') throw new AppError('file_not_found', 'workspace file not found', { status: 404, details: { path: relative } });
    throw error;
  }
}

function workspaceBytes(root, relative) {
  const file = workspaceFile(root, relative);
  return file ? fs.readFileSync(file) : null;
}

function assertWorkspacePathNoSymlink(root, target) {
  const base = path.resolve(root);
  let current = base;
  const segments = path.relative(base, path.resolve(target)).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new AppError('file_symlink_forbidden', 'workspace symlinks are not editable', { status: 422 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function writeWorkspaceBytes(root, relative, content) {
  const target = resolveWorkspacePath(root, relative);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o770 });
  assertWorkspacePathNoSymlink(root, parent);
  const temporary = `${target}.aiws-${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o660 });
  try { fs.renameSync(temporary, target); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function removeWorkspaceFile(root, relative) {
  const file = workspaceFile(root, relative);
  if (file) fs.rmSync(file, { force: true });
}

function topologicalOrder(tasks) {
  const pending = new Map(tasks.map((task) => [task.id, new Set(task.deps)]));
  const order = [];
  while (pending.size) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([taskId]) => taskId);
    if (!ready.length) throw new AppError('invalid_workflow', 'workflow graph contains a cycle', { status: 422 });
    for (const taskId of ready.sort()) {
      pending.delete(taskId);
      order.push(taskId);
      for (const deps of pending.values()) deps.delete(taskId);
    }
  }
  return order;
}

export function validateWorkflowTasks(input) {
  assert(Array.isArray(input) && input.length > 0 && input.length <= 80, 'invalid_workflow', 'workflow must contain 1-80 tasks', { status: 422 });
  const ids = new Set();
  const tasks = input.map((raw, index) => {
    const task = raw && typeof raw === 'object' ? raw : {};
    const taskId = String(task.id || `task_${index + 1}`).trim();
    assert(/^[A-Za-z0-9_-]{1,80}$/.test(taskId), 'invalid_workflow', 'task id is invalid', { status: 422 });
    assert(!ids.has(taskId), 'invalid_workflow', `duplicate task id: ${taskId}`, { status: 422 });
    ids.add(taskId);
    const level = Number(task.level ?? 1);
    assert(level === 1 || level === 2, 'invalid_workflow', 'workflow has exactly two DAG levels', { status: 422 });
    const deps = [...new Set(Array.isArray(task.deps) ? task.deps.map(String) : [])];
    const mode = task.mode === 'write' ? 'write' : 'read';
    const normalizeTaskPaths = (value, field) => {
      assert(value == null || Array.isArray(value), 'invalid_workflow', `${field} must be an array`, { status: 422 });
      const paths = (value || []).map((item) => {
        assert(typeof item === 'string' && item.length > 0, 'invalid_workflow', `${field} contains an empty path`, { status: 422 });
        try { return normalizeRelativePath(item); } catch (error) {
          throw new AppError('invalid_workflow', `${field} contains an invalid path`, { status: 422, details: { path: item, cause: error?.message } });
        }
      });
      assert(new Set(paths).size === paths.length, 'invalid_workflow', `${field} contains a duplicate path`, { status: 422 });
      return paths;
    };
    return {
      id: taskId,
      title: String(task.title || taskId).slice(0, 200),
      level,
      deps,
      mode,
      inputs: normalizeTaskPaths(task.inputs, `task ${taskId} inputs`).slice(0, 64),
      outputs: normalizeTaskPaths(task.outputs, `task ${taskId} outputs`).slice(0, 64)
    };
  });
  for (const task of tasks) {
    for (const dep of task.deps) {
      const parent = tasks.find((candidate) => candidate.id === dep);
      assert(parent, 'invalid_workflow', `unknown dependency: ${dep}`, { status: 422 });
      assert(parent.id !== task.id, 'invalid_workflow', 'task cannot depend on itself', { status: 422 });
      assert(parent.level <= task.level, 'invalid_workflow', 'dependency points backwards across DAG levels', { status: 422 });
    }
  }
  topologicalOrder(tasks);
  assert(tasks.filter((task) => task.mode === 'write').length <= 1, 'invalid_workflow', 'a workflow may contain at most one write task', { status: 422 });
  const producers = new Map();
  for (const task of tasks) {
    for (const output of task.outputs) {
      const producer = producers.get(output);
      assert(!producer, 'invalid_workflow', `duplicate output path is produced by multiple tasks: ${output}`, { status: 422, details: { path: output, producers: [producer, task.id] } });
      producers.set(output, task.id);
    }
  }
  const producedPaths = [...producers.keys()].sort();
  for (let index = 1; index < producedPaths.length; index += 1) {
    assert(!producedPaths[index].startsWith(`${producedPaths[index - 1]}/`) && !producedPaths[index - 1].startsWith(`${producedPaths[index]}/`), 'invalid_workflow', `output paths conflict: ${producedPaths[index - 1]} and ${producedPaths[index]}`, { status: 422 });
  }
  return tasks;
}

export class Domain {
  constructor({ db, config, broker, github = null, evidence = null, integrationProbes = null, terminalService = null, emit = () => undefined }) {
    this.db = db;
    this.config = config;
    this.broker = broker;
    this.github = github;
    this.emit = emit;
    this.driving = new Set();
    this.stopping = false;
    this.activeJobs = new Map();
    this.repositoryLocks = new Map();
    this.retryInstructions = new Map();
    this.secretRegistry = new SecretRegistry([
      ['bootstrap:codex', config.codexCredential?.auth],
      ['bootstrap:github', config.githubCredential?.token]
    ]);
    this.identityService = new IdentityService({ db });
    this.operationService = new OperationService({ db, secrets: this.secretRegistry });
    const projectRepository = new ProjectRepository(db);
    const workflowRepository = new WorkflowRepository(db);
    this.repositoryService = new RepositoryService({
      db, config, operations: this.operationService,
      emit: (event) => this.emit(event),
      projectReader: async (projectId) => {
        const project = await projectRepository.project(projectId);
        return project?.status === 'purged' ? null : project;
      }
    });
    this.workflowService = new WorkflowService({
      db,
      operations: this.operationService,
      config,
      projectReader: async (projectId) => projectRepository.project(projectId),
      emit: (event) => this.emit(event)
    });
    this.projectService = new ProjectService({
      db, config, operations: this.operationService, repositoryService: this.repositoryService,
      workflowDraft: {
        createStatement: (input) => workflowRepository.createDraftStatement(input),
        updateBriefStatement: (input) => workflowRepository.updateDraftBriefStatement(input),
        get: (workflowDraftId) => workflowRepository.draft(workflowDraftId),
        latest: (projectId) => workflowRepository.latest(projectId)
      },
      executionReader: async (projectId, options = {}) => {
        const executions = await this.listExecutions(projectId);
        if (options.active) return executions.filter((item) => ['queued', 'running', 'awaiting_human'].includes(item.status)).length;
        return options.limit ? executions.slice(0, options.limit) : executions;
      },
      eventFactory: (type, data) => eventStatement(type, null, null, data),
      emit: (event) => this.emit(event)
    });
    this.setupService = new SetupService({
      db, config, identity: this.identityService, operations: this.operationService, secrets: this.secretRegistry
    });
    this.codexService = new CodexService({
      config, broker, setup: this.setupService, operations: this.operationService
    });
    this.githubService = new GithubService({ config, setup: this.setupService, operations: this.operationService, github });
    this.operationService.cancelExternal = (kind, externalRef) => this.codexService.cancelExternal(kind, externalRef);
    this.operationService.resumeExternal = (operation) => this.codexService.resumeOperation(operation);
    this.vault = this.setupService.vault;
    this.r2 = createR2Runtime(this);
    this.evidence = evidence || new EvidenceService({
      db,
      config,
      prepareAsset: (projectId, input) => this.prepareAsset(projectId, input),
      assetInsertStatements: (asset, actor) => this.assetInsertStatement(asset, actor),
      cleanupPreparedAssets: (assets) => this.cleanupPreparedAssets(assets),
      sanitizeRunnerResult: safeRunnerResult
    });
    this.integrationProbes = integrationProbes || new IntegrationProbeService({ config, broker, github });
    this.terminals = terminalService || new TerminalService({
      db,
      config,
      resolveWorkspace: (projectId) => this.projectWorkspace(projectId),
      secrets: () => this.activeCredentialSecrets(),
      captureArtifact: (projectId, sessionId, content) => this.captureTerminalArtifact(projectId, sessionId, content)
    });
  }

  async listProjects() {
    return this.projectService.listProjects();
  }

  async setupState() {
    return this.setupService.setupState();
  }

  startCodexDeviceAuth(input, ctx = {}) {
    return this.codexService.startDeviceAuth(input, ctx);
  }

  discoverCodex(input, ctx = {}) {
    return this.codexService.discover(input, ctx);
  }

  importCodexDiscovery(input, ctx = {}) {
    return this.codexService.importDiscovery(input, ctx);
  }

  probeCodexProfile(input, ctx = {}) {
    return this.codexService.probe(input, ctx);
  }

  discoverGithubInstallations(appConfigId, input, ctx = {}) {
    return this.githubService.discoverInstallations(appConfigId, input, ctx);
  }

  syncGithubRepositories(installationId, input, ctx = {}) {
    return this.githubService.syncRepositories(installationId, input, ctx);
  }

  probeGithubApp(input, ctx = {}) {
    return this.githubService.probe(input, ctx);
  }

  githubWebhook(rawBody, headers) {
    return this.githubService.webhook(rawBody, headers);
  }

  authenticate(authorization) {
    return this.identityService.authenticate(authorization);
  }

  redact(value) {
    return this.secretRegistry.redactObject(value);
  }

  async assertCommandReady(command, input = {}) {
    let setup = null;
    if (this.config.testOnlyBypassSetupGate !== true && SETUP_GATED_COMMANDS.has(command)) setup = await this.setupService.assertReady(command);
    if (PROJECT_READY_COMMANDS.has(command)) {
      let projectId = input.project_id || input.projectId || '';
      if (!projectId && input.execution_id) projectId = (await this.db.get('SELECT project_id FROM executions WHERE id=?', [input.execution_id]))?.project_id || '';
      if (!projectId && input.generation_id) projectId = (await this.db.get('SELECT project_id FROM workflow_generations WHERE id=?', [input.generation_id]))?.project_id || '';
      if (!projectId && input.proposal_id) projectId = (await this.db.get('SELECT project_id FROM workflow_generation_proposals WHERE id=?', [input.proposal_id]))?.project_id || '';
      if (!projectId && input.operation_id) {
        const operation = await this.db.get('SELECT resource_type,resource_id FROM operations WHERE id=?', [input.operation_id]);
        if (operation?.resource_type === 'workflow_generation') projectId = (await this.db.get('SELECT project_id FROM workflow_generations WHERE id=?', [operation.resource_id]))?.project_id || '';
        else if (operation?.resource_type === 'workflow_proposal') projectId = (await this.db.get('SELECT project_id FROM workflow_generation_proposals WHERE id=?', [operation.resource_id]))?.project_id || '';
        else if (operation?.resource_type === 'execution') projectId = (await this.db.get('SELECT project_id FROM executions WHERE id=?', [operation.resource_id]))?.project_id || '';
      }
      if (projectId) await this.projectService.assertReady(projectId, { command });
    }
    return setup;
  }

  async listCredentials() {
    return this.setupService.listCredentials();
  }

  async createSession(input = {}, ctx = {}) {
    return this.identityService.createSession(input, ctx);
  }

  async listSessions() {
    return this.identityService.listSessions();
  }

  async revokeSession(sessionId, input, ctx = {}) {
    return this.identityService.revokeSession(sessionId, input, ctx);
  }

  async createCredential(input, ctx = {}) {
    return this.setupService.createCredential(input, ctx);
  }

  async rotateCredential(credentialId, input, ctx = {}) {
    return this.setupService.rotateCredential(credentialId, input, ctx);
  }

  async revokeCredential(credentialId, input, ctx = {}) {
    return this.setupService.revokeCredential(credentialId, input, ctx);
  }

  async deleteCredential(credentialId, input, ctx = {}) {
    return this.setupService.deleteCredential(credentialId, input, ctx);
  }

  async listCodexProfiles() {
    return this.setupService.listCodexProfiles();
  }

  async createCodexProfile(input, ctx = {}) {
    return this.setupService.createCodexProfile(input, ctx);
  }

  async listGithubAppConfigs() {
    return this.setupService.listGithubApps();
  }

  async listMcpClients() {
    const rows = await this.db.query('SELECT id,name,transport,endpoint,scope_json,status,created_at,updated_at FROM mcp_clients ORDER BY created_at DESC,id');
    return rows.map((row) => ({ ...row, scope: rowJson(row, 'scope_json', {}) }));
  }

  async createMcpClient(input, ctx = {}) {
    const name = String(input?.name || '').trim();
    const transport = String(input?.transport || '').trim();
    const endpoint = String(input?.endpoint || '').trim();
    const scope = input?.scope && typeof input.scope === 'object' ? input.scope : {};
    assert(name.length >= 1 && name.length <= 120, 'invalid_input', 'MCP client name is required', { status: 422 });
    assert(['http', 'stdio', 'docker'].includes(transport), 'invalid_input', 'MCP transport is invalid', { status: 422 });
    assert(endpoint.length >= 1 && endpoint.length <= 1024 && !/[\u0000\r\n]/.test(endpoint), 'invalid_input', 'MCP endpoint is invalid', { status: 422 });
    if (transport === 'http') {
      let parsed;
      try { parsed = new URL(endpoint); } catch { throw new AppError('invalid_input', 'MCP HTTP endpoint is invalid', { status: 422 }); }
      assert(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)), 'invalid_input', 'MCP HTTP endpoint must use HTTPS or loopback HTTP', { status: 422 });
    }
    const projectIds = Array.isArray(scope.project_ids) ? [...new Set(scope.project_ids.map(String))].slice(0, 100) : [];
    const token = randomBytes(32).toString('base64url');
    const clientId = id('mcp');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO mcp_clients(id,user_id,name,transport,endpoint,token_hash,scope_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', params: [clientId, 'usr_local_owner', name, transport, endpoint, sha256(token), asJson({ ...scope, project_ids: projectIds }), 'available', timestamp, timestamp] },
      auditStatement('mcp_client.created', 'mcp_client', clientId, { name, transport, project_count: projectIds.length }, ctx.actor)
    ]);
    const metadata = (await this.listMcpClients()).find((client) => client.id === clientId);
    return { ...metadata, token };
  }

  async revokeMcpClient(clientId, _input, ctx = {}) {
    const client = await this.db.get('SELECT id FROM mcp_clients WHERE id=?', [clientId]);
    if (!client) throw new AppError('not_found', 'MCP client not found');
    await this.db.transaction([
      { sql: "UPDATE mcp_clients SET status='revoked',updated_at=? WHERE id=?", params: [now(), clientId] },
      auditStatement('mcp_client.revoked', 'mcp_client', clientId, {}, ctx.actor)
    ]);
    return (await this.listMcpClients()).find((item) => item.id === clientId);
  }

  async normalizeMcpScope(projectId, scope = {}) {
    const projectIds = [...new Set((Array.isArray(scope?.project_ids) ? scope.project_ids : [projectId]).map(String).filter(Boolean))].slice(0, 100);
    assert(projectIds.length > 0, 'invalid_input', 'scope must include at least one project', { status: 422 });
    for (const idValue of projectIds) await this.requireProject(idValue);
    const tools = [...new Set((Array.isArray(scope?.tools) ? scope.tools : []).map(String).filter((name) => /^[A-Za-z0-9_.-]{1,120}$/.test(name)))].slice(0, 200);
    assert(tools.length === (Array.isArray(scope?.tools) ? new Set(scope.tools.map(String)).size : 0), 'invalid_input', 'scope tools contain an invalid name', { status: 422 });
    return { project_ids: projectIds, tools };
  }

  async listMcpScopes(projectId = null) {
    const requests = projectId
      ? await this.db.query('SELECT * FROM exchange_requests WHERE project_id=? ORDER BY created_at DESC,id', [projectId])
      : await this.db.query('SELECT * FROM exchange_requests ORDER BY created_at DESC,id LIMIT 200');
    return Promise.all(requests.map(async (request) => ({
      ...request,
      scope: rowJson(request, 'scope_json', {}),
      grants: (await this.db.query('SELECT id,request_id,scope_json,expires_at,revoked_at FROM exchange_grants WHERE request_id=? ORDER BY expires_at DESC,id', [request.id])).map((grant) => ({ ...grant, scope: rowJson(grant, 'scope_json', {}) }))
    })));
  }

  async createMcpScopeRequest(input, ctx = {}) {
    const projectId = String(input?.project_id || '').trim();
    const scope = await this.normalizeMcpScope(projectId, input?.scope || {});
    const ttl = Number(input?.ttl_seconds ?? 3600);
    assert(Number.isInteger(ttl) && ttl >= 300 && ttl <= 90 * 24 * 60 * 60, 'invalid_input', 'scope ttl is invalid', { status: 422 });
    const requestId = id('mreq');
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await this.db.transaction([
      { sql: 'INSERT INTO exchange_requests(id,project_id,scope_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?)', params: [requestId, projectId, asJson(scope), 'pending', timestamp, expiresAt] },
      auditStatement('mcp_scope.requested', 'exchange_request', requestId, { project_id: projectId, scope, ttl_seconds: ttl }, ctx.actor)
    ]);
    return (await this.listMcpScopes(projectId)).find((item) => item.id === requestId);
  }

  async grantMcpScope(requestId, input = {}, ctx = {}) {
    const request = await this.db.get('SELECT * FROM exchange_requests WHERE id=?', [requestId]);
    if (!request) throw new AppError('not_found', 'MCP scope request not found');
    assert(request.status === 'pending', 'invalid_state', 'MCP scope request is not pending', { status: 409 });
    assert(!request.expires_at || new Date(request.expires_at).getTime() > Date.now(), 'scope_expired', 'MCP scope request has expired', { status: 409 });
    const requested = rowJson(request, 'scope_json', {});
    const scope = await this.normalizeMcpScope(request.project_id, input?.scope || requested);
    const ttl = Number(input?.ttl_seconds ?? 3600);
    assert(Number.isInteger(ttl) && ttl >= 300 && ttl <= 90 * 24 * 60 * 60, 'invalid_input', 'grant ttl is invalid', { status: 422 });
    const token = randomBytes(32).toString('base64url');
    const grantId = id('mgrant');
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const timestamp = now();
    await this.db.transaction([
      { sql: "UPDATE exchange_requests SET status='granted' WHERE id=? AND status='pending'", params: [requestId], expect_changes: 1 },
      { sql: 'INSERT INTO exchange_grants(id,request_id,token_hash,scope_json,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)', params: [grantId, requestId, sha256(token), asJson(scope), expiresAt] },
      auditStatement('mcp_scope.granted', 'exchange_grant', grantId, { request_id: requestId, scope, ttl_seconds: ttl }, ctx.actor)
    ]);
    return { id: grantId, request_id: requestId, scope, expires_at: expiresAt, revoked_at: null, token };
  }

  async revokeMcpScope(grantId, _input, ctx = {}) {
    const grant = await this.db.get('SELECT id,request_id,revoked_at FROM exchange_grants WHERE id=?', [grantId]);
    if (!grant) throw new AppError('not_found', 'MCP scope grant not found');
    await this.db.transaction([
      { sql: 'UPDATE exchange_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', params: [now(), grantId] },
      auditStatement('mcp_scope.revoked', 'exchange_grant', grantId, { request_id: grant.request_id }, ctx.actor)
    ]);
    return this.db.get('SELECT id,request_id,scope_json,expires_at,revoked_at FROM exchange_grants WHERE id=?', [grantId]).then((row) => ({ ...row, scope: rowJson(row, 'scope_json', {}) }));
  }

  async authorizeMcpToken(token, projectId = '') {
    if (!token) return { local: true, client: null };
    const client = await this.db.get('SELECT id,name,scope_json,status FROM mcp_clients WHERE token_hash=?', [sha256(token)]);
    if (client && client.status === 'available') {
      const scope = rowJson(client, 'scope_json', {});
      const projects = Array.isArray(scope.project_ids) ? scope.project_ids.map(String) : [];
      if (projectId && projects.length && !projects.includes(String(projectId))) throw new AppError('mcp_scope_denied', 'MCP token is not scoped to this project', { status: 403 });
      return { local: false, client: { id: client.id, name: client.name, scope } };
    }
    const grant = await this.db.get('SELECT g.id,g.scope_json,g.expires_at,g.revoked_at,r.project_id FROM exchange_grants g JOIN exchange_requests r ON r.id=g.request_id WHERE g.token_hash=?', [sha256(token)]);
    if (!grant || grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now()) throw new AppError('mcp_token_invalid', 'MCP token is invalid or revoked', { status: 401 });
    const scope = rowJson(grant, 'scope_json', {});
    const projects = Array.isArray(scope.project_ids) ? scope.project_ids.map(String) : [];
    if (projectId && projects.length && !projects.includes(String(projectId))) throw new AppError('mcp_scope_denied', 'MCP token is not scoped to this project', { status: 403 });
    return { local: false, client: { id: grant.id, name: `grant:${grant.id}`, scope } };
  }

  async createGithubAppConfig(input, ctx = {}) {
    return this.setupService.createGithubApp(input, ctx);
  }

  async createGithubInstallation(appConfigId, input, ctx = {}) {
    return this.setupService.createGithubInstallation(appConfigId, input, ctx);
  }

  async updateCodexProfile(profileId, input, ctx = {}) {
    return this.setupService.updateCodexProfile(profileId, input, ctx);
  }

  validateCodexProfile(input) {
    const label = String(input?.label || '').trim();
    const provider = String(input?.provider || 'openai').trim();
    const model = String(input?.model || '').trim();
    const baseUrl = String(input?.base_url || '').trim();
    const wireApi = String(input?.wire_api || 'responses').trim();
    const reasoning = String(input?.reasoning || 'medium').trim();
    const timeoutMs = Number(input?.timeout_ms ?? 120000);
    const credentialRef = String(input?.credential_ref || '').trim();
    assert(label.length >= 1 && label.length <= 120, 'invalid_input', 'profile label is required', { status: 422 });
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(provider), 'invalid_input', 'provider is invalid', { status: 422 });
    assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model), 'invalid_input', 'model is invalid', { status: 422 });
    assert(['responses', 'chat'].includes(wireApi), 'invalid_input', 'wire_api is invalid', { status: 422 });
    assert(['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning), 'invalid_input', 'reasoning is invalid', { status: 422 });
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3600000, 'invalid_input', 'timeout_ms is invalid', { status: 422 });
    if (baseUrl) {
      let parsed;
      try { parsed = new URL(baseUrl); } catch { throw new AppError('invalid_input', 'base_url is invalid', { status: 422 }); }
      assert(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)), 'invalid_input', 'base_url must use HTTPS or loopback HTTP', { status: 422 });
    }
    return { label, provider, model, base_url: baseUrl, wire_api: wireApi, reasoning, timeout_ms: timeoutMs, credential_ref: credentialRef };
  }

  async getProject(projectId) {
    return this.projectService.getProject(projectId);
  }

  async createProject(input, ctx = {}) {
    return this.projectService.createProject(input, ctx);
  }

  async updateProject(projectId, input, ctx = {}) {
    return this.projectService.updateProject(projectId, input, ctx);
  }

  async listBriefs(projectId) {
    return this.projectService.listBriefs(projectId);
  }

  async createBrief(projectId, input, ctx = {}) {
    return this.projectService.createBrief(projectId, input, ctx);
  }

  async listIntakes(projectId) { return this.projectService.listIntakes(projectId); }
  async getIntake(intakeId) { return this.projectService.getIntake(intakeId); }
  async startIntake(projectId, input, ctx = {}) { return this.projectService.startIntake(projectId, input, ctx); }
  async retryIntake(intakeId, input, ctx = {}) { return this.projectService.retryIntake(intakeId, input, ctx); }
  async cancelIntake(intakeId, input, ctx = {}) { return this.projectService.cancelIntake(intakeId, input, ctx); }
  async resumeIntake(intakeId, input, ctx = {}) { return this.projectService.resumeIntake(intakeId, input, ctx); }
  async uploadIntake(intakeId, input, ctx = {}) { return this.projectService.uploadIntake(intakeId, input, ctx); }
  async getBrief(projectId, revision) { return this.projectService.getBrief(projectId, revision); }
  async confirmBrief(projectId, revision, input, ctx = {}) { return this.projectService.confirmBrief(projectId, revision, input, ctx); }
  async archiveProject(projectId, input, ctx = {}) { return this.projectService.archiveProject(projectId, input, ctx); }
  async trashProject(projectId, input, ctx = {}) { return this.projectService.trashProject(projectId, input, ctx); }
  async restoreProject(projectId, input, ctx = {}) { return this.projectService.restoreProject(projectId, input, ctx); }
  async purgeProject(projectId, input, ctx = {}) { return this.projectService.purgeProject(projectId, input, ctx); }

  async listRepositoryConnections(projectId) { return this.repositoryService.listConnections(projectId); }
  async getRepositoryConnection(connectionId) { return this.repositoryService.getConnection(connectionId); }
  async createRepositoryConnection(projectId, input, ctx = {}) { return this.repositoryService.createConnection(projectId, input, ctx); }
  async updateRepositoryConnection(connectionId, input, ctx = {}) { return this.repositoryService.updateConnection(connectionId, input, ctx); }
  async deleteRepositoryConnection(connectionId, input, ctx = {}) { return this.repositoryService.deleteConnection(connectionId, input, ctx); }
  async listRepositoryTargets(connectionId) { return this.repositoryService.listTargets(connectionId); }
  async getRepositoryTarget(targetId) { return this.repositoryService.getTarget(targetId); }
  async createRepositoryTarget(connectionId, input, ctx = {}) { return this.repositoryService.createTarget(connectionId, input, ctx); }
  async updateRepositoryTarget(targetId, input, ctx = {}) { return this.repositoryService.updateTarget(targetId, input, ctx); }
  async deleteRepositoryTarget(targetId, input, ctx = {}) { return this.repositoryService.deleteTarget(targetId, input, ctx); }
  async listRepositoryLines(projectId) { return this.repositoryService.listLines(projectId); }
  async getRepositoryLine(lineId) { return this.repositoryService.getLine(lineId); }
  async createRepositoryLine(projectId, input, ctx = {}) { return this.repositoryService.createLine(projectId, input, ctx); }
  async updateRepositoryLine(lineId, input, ctx = {}) { return this.repositoryService.updateLine(lineId, input, ctx); }
  async deleteRepositoryLine(lineId, input, ctx = {}) { return this.repositoryService.deleteLine(lineId, input, ctx); }
  async probeRepositoryLine(lineId, input, ctx = {}) { return this.repositoryService.probeLine(lineId, input, ctx); }
  async recoverRepositoryLine(lineId, input, ctx = {}) { return this.repositoryService.recoverLine(lineId, input, ctx); }
  async syncRepositoryLine(lineId, input, ctx = {}) { return this.repositoryService.syncLine(lineId, input, ctx); }
  async archiveRepository(projectId, input, ctx = {}) { return this.repositoryService.archiveProject(projectId, input, ctx); }

  async listWorkflows(projectId) {
    await this.requireProject(projectId);
    return (await this.db.query('SELECT * FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC', [projectId])).map(workflowView);
  }

  async listNodeContracts(projectId, workflowRevision = null) {
    await this.requireProject(projectId);
    const revision = workflowRevision == null ? Number((await this.db.get('SELECT revision FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]))?.revision || 0) : Number(workflowRevision);
    if (!revision) return [];
    const rows = await this.db.query('SELECT * FROM node_contracts WHERE project_id=? AND workflow_revision=? ORDER BY node_id', [projectId, revision]);
    return Promise.all(rows.map(async (row) => {
      const latest = await this.db.get('SELECT revision,contract_hash,source,created_at FROM node_contract_revisions WHERE project_id=? AND workflow_revision=? AND node_id=? ORDER BY revision DESC LIMIT 1', [projectId, revision, row.node_id]);
      const { contract_json: _contractJson, ...metadata } = row;
      return { ...metadata, revision: Number(latest?.revision || 1), contract_hash: latest?.contract_hash || '', source: latest?.source || 'workflow', contract: rowJson(row, 'contract_json', {}) };
    }));
  }

  async createNodeContract(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const workflowRevision = Number(input?.workflow_revision);
    const nodeId = String(input?.node_id || '').trim();
    const contract = input?.contract && typeof input.contract === 'object' ? input.contract : {};
    assert(Number.isInteger(workflowRevision) && workflowRevision > 0, 'invalid_input', 'workflow_revision is required', { status: 422 });
    assert(/^[A-Za-z0-9_-]{1,80}$/.test(nodeId), 'invalid_input', 'node_id is invalid', { status: 422 });
    assert(!Array.isArray(contract) && Buffer.byteLength(asJson(contract), 'utf8') <= 64 * 1024, 'workflow_contract_invalid', 'node contract is too large', { status: 413 });
    const workflow = await this.db.get('SELECT tasks_json FROM workflow_revisions WHERE project_id=? AND revision=?', [projectId, workflowRevision]);
    assert(workflow, 'not_found', 'workflow revision not found');
    assert(rowJson(workflow, 'tasks_json', []).some((task) => task.id === nodeId), 'invalid_input', 'node is not present in workflow', { status: 422 });
    const contractId = id('nct');
    const previousRevision = Number((await this.db.get('SELECT MAX(revision) AS revision FROM node_contract_revisions WHERE project_id=? AND workflow_revision=? AND node_id=?', [projectId, workflowRevision, nodeId]))?.revision || 0);
    const contractRevision = previousRevision + 1;
    const timestamp = now();
    try {
      await this.db.transaction([
        { sql: 'INSERT INTO node_contracts(id,project_id,workflow_revision,node_id,contract_json,created_at) VALUES(?,?,?,?,?,?)', params: [contractId, projectId, workflowRevision, nodeId, asJson(contract), timestamp] },
        { sql: 'INSERT INTO node_contract_revisions(id,project_id,workflow_revision,node_id,revision,contract_json,contract_hash,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [id('ncr'), projectId, workflowRevision, nodeId, contractRevision, asJson(contract), hashJson(contract), 'manual', timestamp] },
        auditStatement('node_contract.created', 'node_contract', contractId, { project_id: projectId, workflow_revision: workflowRevision, node_id: nodeId }, ctx.actor, timestamp)
      ]);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('already_exists', 'node contract already exists', { status: 409 });
      throw error;
    }
    return (await this.listNodeContracts(projectId, workflowRevision)).find((row) => row.id === contractId);
  }

  async updateNodeContract(projectId, input = {}, ctx = {}) {
    await this.requireProject(projectId);
    const contractId = String(input.contract_id || '').trim();
    const current = await this.db.get('SELECT * FROM node_contracts WHERE id=? AND project_id=?', [contractId, projectId]);
    assert(current, 'not_found', 'node contract not found');
    const expected = Number(input.expected_revision);
    const latest = await this.db.get('SELECT revision FROM node_contract_revisions WHERE project_id=? AND workflow_revision=? AND node_id=? ORDER BY revision DESC LIMIT 1', [projectId, current.workflow_revision, current.node_id]);
    const currentRevision = Number(latest?.revision || 1);
    assert(Number.isInteger(expected) && expected > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (expected !== currentRevision) throw new AppError('revision_conflict', 'node contract revision changed', { status: 409, details: { current_revision: currentRevision } });
    const contract = input.contract && typeof input.contract === 'object' && !Array.isArray(input.contract) ? input.contract : {};
    assert(Buffer.byteLength(asJson(contract), 'utf8') <= 64 * 1024, 'workflow_contract_invalid', 'node contract is too large', { status: 413 });
    const revision = currentRevision + 1;
    const timestamp = now();
    try {
      await this.db.transaction([
        {
          sql: `UPDATE node_contracts SET contract_json=? WHERE id=? AND project_id=? AND
            ?=(SELECT MAX(revision) FROM node_contract_revisions WHERE project_id=? AND workflow_revision=? AND node_id=?)`,
          params: [asJson(contract), contractId, projectId, expected, projectId, current.workflow_revision, current.node_id],
          expect_changes: 1
        },
        { sql: 'INSERT INTO node_contract_revisions(id,project_id,workflow_revision,node_id,revision,contract_json,contract_hash,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [id('ncr'), projectId, current.workflow_revision, current.node_id, revision, asJson(contract), hashJson(contract), 'manual', timestamp] },
        auditStatement('node_contract.updated', 'node_contract', contractId, { project_id: projectId, workflow_revision: current.workflow_revision, node_id: current.node_id, revision }, ctx.actor, timestamp)
      ]);
    } catch (error) {
      if (!isTransactionPrecondition(error) && !String(error?.message || '').includes('UNIQUE constraint failed')) throw error;
      const latestRevision = Number((await this.db.get('SELECT MAX(revision) AS revision FROM node_contract_revisions WHERE project_id=? AND workflow_revision=? AND node_id=?', [projectId, current.workflow_revision, current.node_id]))?.revision || currentRevision);
      throw new AppError('revision_conflict', 'node contract revision changed', { status: 409, details: { current_revision: latestRevision } });
    }
    return (await this.listNodeContracts(projectId, current.workflow_revision)).find((row) => row.id === contractId);
  }

  async listWorkflowGenerations(projectId) {
    return this.workflowService.listGenerations(projectId);
  }

  async generateWorkflow(projectId, input, ctx = {}) {
    /* R3 kept provider-unavailable generation explicit.  R4's deterministic
     * adapter is opt-in so legacy clients retain that response contract. */
    if (input?.provider === 'fixture' || input?.provider === 'deterministic' || this.config.workflowGenerationFixture === true || input?.async === true) {
      return this.workflowService.generate(projectId, input, ctx);
    }
    await this.requireProject(projectId);
    const brief = await this.confirmedBrief(projectId);
    assert(brief, 'invalid_input', 'a brief is required before workflow generation', { status: 422 });
    const generationId = id('wgen');
    const candidate = {};
    const critic = { status: 'not_run', issues: ['workflow_generator_unavailable'], brief_hash: brief.content_hash };
    const status = 'failed';
    await this.db.transaction([
      { sql: 'INSERT INTO workflow_generations(id,project_id,mode,phase,brief_revision,brief_hash,candidate_json,error_code,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', params: [generationId, projectId, input?.mode === 'replan' ? 'replan' : 'initial', status, brief.revision, brief.content_hash, asJson(candidate), 'workflow_generator_unavailable', now(), now(), now()] },
      { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, null, `workflow.generation.${status}`, asJson({ brief_revision: brief.revision, brief_hash: brief.content_hash, error_code: 'workflow_generator_unavailable' }), now()] },
      auditStatement(`workflow.generation.${status}`, 'workflow_generation', generationId, { project_id: projectId, brief_revision: brief.revision }, ctx.actor)
    ]);
    const result = (await this.listWorkflowGenerations(projectId)).find((row) => row.id === generationId);
    if (result) {
      // Preserve the pre-R4 synchronous response shape only on the legacy path.
      result.candidate = candidate;
      result.critic = critic;
    }
    return result;
  }

  async getWorkflowDraft(projectId) { return this.workflowService.getDraft(projectId); }
  async updateWorkflowDraft(projectId, input, ctx = {}) { return this.workflowService.updateDraft(projectId, input, ctx); }
  async listWorkflowLayouts(projectId, draftId = null) { return this.workflowService.listLayouts(projectId, draftId); }
  async saveWorkflowLayout(projectId, input, ctx = {}) { return this.workflowService.saveLayout(projectId, input, ctx); }
  async getWorkflowGeneration(generationId) { return this.workflowService.getGeneration(generationId); }
  async workflowGenerationEvents(generationId, cursor = 0) { return this.workflowService.generationEvents(generationId, cursor); }
  async retryWorkflowGeneration(generationId, input, ctx = {}) { return this.workflowService.retryGeneration(generationId, input, ctx); }
  async cancelWorkflowGeneration(input = {}, ctx = {}) {
    const operation = await this.operationService.cancel(input.operation_id, input);
    return this.operationService.receipt(operation);
  }
  async applyWorkflowProposal(proposalId, input, ctx = {}) { return this.workflowService.applyProposal(proposalId, input, ctx); }
  async getWorkflowProposal(proposalId) { return this.workflowService.getProposal(proposalId); }
  async rejectWorkflowProposal(proposalId, input, ctx = {}) { return this.workflowService.rejectProposal(proposalId, input, ctx); }
  async replanWorkflow(projectId, input, ctx = {}) { return this.workflowService.replan(projectId, input, ctx); }

  async listOutcomeRequirements(projectId, workflowRevision = null) {
    await this.requireProject(projectId);
    const revision = workflowRevision == null ? Number((await this.db.get('SELECT revision FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]))?.revision || 0) : Number(workflowRevision);
    return (await this.db.query('SELECT * FROM outcome_requirements WHERE project_id=? AND workflow_revision=? ORDER BY created_at,id', [projectId, revision])).map((row) => ({ ...row, rubric: rowJson(row, 'rubric_json', {}) }));
  }

  async createOutcomeRequirement(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const latestWorkflow = await this.db.get('SELECT revision FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    const workflowRevision = Number(input?.workflow_revision ?? latestWorkflow?.revision ?? 0);
    const key = String(input?.requirement_key || input?.key || '').trim();
    const rubric = input?.rubric && typeof input.rubric === 'object' ? input.rubric : { min_score: 80 };
    assert(Number.isInteger(workflowRevision) && workflowRevision > 0, 'invalid_input', 'workflow_revision is required', { status: 422 });
    assert(/^[A-Za-z0-9._-]{1,120}$/.test(key), 'invalid_input', 'requirement key is invalid', { status: 422 });
    const requirementId = id('out');
    try {
      await this.db.transaction([
        { sql: 'INSERT INTO outcome_requirements(id,project_id,workflow_revision,requirement_key,rubric_json,created_at) VALUES(?,?,?,?,?,?)', params: [requirementId, projectId, workflowRevision, key, asJson(rubric), now()] },
        auditStatement('outcome_requirement.created', 'outcome_requirement', requirementId, { project_id: projectId, workflow_revision: workflowRevision, requirement_key: key }, ctx.actor)
      ]);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('already_exists', 'outcome requirement already exists', { status: 409 });
      throw error;
    }
    return (await this.listOutcomeRequirements(projectId, workflowRevision)).find((row) => row.id === requirementId);
  }

  async listAssistSessions(projectId = null) {
    const rows = projectId
      ? await this.db.query('SELECT * FROM assist_sessions WHERE project_id=? ORDER BY created_at DESC', [projectId])
      : await this.db.query('SELECT * FROM assist_sessions ORDER BY created_at DESC LIMIT 200');
    return rows.map((row) => ({ ...row, snapshot: rowJson(row, 'snapshot_json', {}) }));
  }

  async createAssistSession(input, ctx = {}) {
    const projectId = String(input?.project_id || '').trim();
    await this.requireProject(projectId);
    const scope = String(input?.scope || 'project');
    assert(['project', 'workflow', 'workstream', 'task'].includes(scope), 'invalid_input', 'Assist scope is invalid', { status: 422 });
    const scopeId = String(input?.scope_id || projectId).trim();
    assert(scopeId.length >= 1 && scopeId.length <= 160, 'invalid_input', 'Assist scope_id is required', { status: 422 });
    const [brief, workflow, repository] = await Promise.all([
      this.confirmedBrief(projectId),
      this.db.get('SELECT revision,graph_hash FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]),
      this.db.get('SELECT head_sha FROM repository_bindings WHERE project_id=?', [projectId])
    ]);
    const snapshot = { project_id: projectId, scope, scope_id: scopeId, brief_revision: brief?.revision || null, brief_hash: brief?.content_hash || null, workflow_revision: workflow?.revision || null, workflow_hash: workflow?.graph_hash || null, repository_sha: repository?.head_sha || '' };
    const sessionId = id('ast');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO assist_sessions(id,project_id,scope,scope_id,snapshot_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', params: [sessionId, projectId, scope, scopeId, asJson(snapshot), 'active', timestamp, timestamp] },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, null, 'assist.session.created', asJson({ scope, scope_id: scopeId }), timestamp] },
      auditStatement('assist_session.created', 'assist_session', sessionId, { project_id: projectId, scope, scope_id: scopeId }, ctx.actor)
    ]);
    return (await this.listAssistSessions(projectId)).find((row) => row.id === sessionId);
  }

  async getAssistSession(sessionId) {
    const session = await this.db.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    const turns = await this.db.query('SELECT * FROM assist_turns WHERE session_id=? ORDER BY turn_no', [sessionId]);
    const turnViews = await Promise.all(turns.map(async (turn) => ({
      ...turn,
      goal: rowJson(turn, 'goal_json', {}),
      plan: rowJson(turn, 'plan_json', []),
      messages: await this.db.query('SELECT id,role,content,sequence_no,created_at FROM assist_messages WHERE turn_id=? ORDER BY sequence_no', [turn.id])
    })));
    return { ...session, snapshot: rowJson(session, 'snapshot_json', {}), turns: turnViews };
  }

  async createAssistTurn(sessionId, input, ctx = {}) {
    const session = await this.db.get('SELECT id,status FROM assist_sessions WHERE id=?', [sessionId]);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    assert(session.status === 'active', 'assist_session_inactive', 'Assist session is not active', { status: 409 });
    const message = String(input?.message || '').trim();
    assert(message.length >= 1 && message.length <= 100000, 'invalid_input', 'Assist message is required', { status: 422 });
    const goal = input?.goal && typeof input.goal === 'object' ? input.goal : {};
    const plan = Array.isArray(input?.plan) ? input.plan.slice(0, 100) : [];
    const turnNo = Number((await this.db.get('SELECT COALESCE(MAX(turn_no),0)+1 AS turn_no FROM assist_turns WHERE session_id=?', [sessionId])).turn_no);
    const turnId = id('atr');
    const operationId = id('aop');
    const receipt = { operation_id: operationId, resource_id: turnId, session_id: sessionId, turn_id: turnId, status: 'failed', cursor: 0, error_code: 'assist_runtime_unavailable' };
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO assist_turns(id,session_id,turn_no,status,goal_json,plan_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', params: [turnId, sessionId, turnNo, 'failed', asJson(goal), asJson(plan), timestamp, timestamp] },
      { sql: 'INSERT INTO assist_messages(id,turn_id,role,content,sequence_no,created_at) VALUES(?,?,?,?,?,?)', params: [id('ams'), turnId, 'user', message, 1, timestamp] },
      { sql: 'INSERT INTO assist_operations(id,session_id,kind,status,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: [operationId, sessionId, 'turn', 'failed', asJson(receipt), timestamp, timestamp] },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, turnId, 'assist.turn.created', asJson({ turn_no: turnNo, operation_id: operationId }), timestamp] },
      ...(Object.keys(goal).length ? [{ sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, turnId, 'assist.goal', asJson(goal), timestamp] }] : []),
      ...(plan.length ? [{ sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, turnId, 'assist.plan', asJson({ steps: plan }), timestamp] }] : []),
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, turnId, 'assist.message', asJson({ role: 'user', sequence_no: 1 }), timestamp] },
      { sql: 'UPDATE assist_sessions SET updated_at=? WHERE id=?', params: [timestamp, sessionId] },
      auditStatement('assist_turn.created', 'assist_turn', turnId, { session_id: sessionId, turn_no: turnNo, operation_id: operationId }, ctx.actor)
    ]);
    return { ...(await this.getAssistSession(sessionId)).turns.find((turn) => turn.id === turnId), operation: receipt };
  }

  async transitionAssistSession(sessionId, input, ctx = {}) {
    const action = String(input?.action || '').trim();
    const transitions = { cancel: 'cancelled', interrupt: 'paused', resume: 'active', complete: 'completed' };
    const next = transitions[action];
    assert(next, 'invalid_input', 'Assist transition is invalid', { status: 422 });
    const session = await this.db.get('SELECT id,status FROM assist_sessions WHERE id=?', [sessionId]);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    if (action === 'resume') assert(session.status === 'paused', 'invalid_state', 'only paused Assist sessions can resume', { status: 409 });
    await this.db.transaction([
      { sql: 'UPDATE assist_sessions SET status=?,updated_at=? WHERE id=?', params: [next, now(), sessionId] },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, null, `assist.session.${action}`, asJson({ from: session.status, to: next }), now()] },
      auditStatement(`assist_session.${action}`, 'assist_session', sessionId, { from: session.status, to: next }, ctx.actor)
    ]);
    return this.getAssistSession(sessionId);
  }

  async projectWorkspace(projectId) {
    await this.requireProject(projectId);
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]);
    const relative = repository?.local_path || `projects/${projectId}`;
    return { repository, root: resolveWorkspacePath(this.config.home, relative) };
  }

  async readProjectFile(projectId, relativePath) {
    const relative = normalizeRelativePath(String(relativePath || ''));
    const { root } = await this.projectWorkspace(projectId);
    const bytes = workspaceBytes(root, relative);
    if (!bytes) throw new AppError('file_not_found', 'workspace file not found', { status: 404, details: { path: relative } });
    assert(bytes.byteLength <= 5 * 1024 * 1024, 'file_too_large', 'file exceeds the 5 MiB editor limit', { status: 413 });
    const binary = bytes.includes(0);
    return { project_id: projectId, path: relative, sha256: sha256(bytes), byte_size: bytes.byteLength, encoding: binary ? 'base64' : 'utf8', content: binary ? bytes.toString('base64') : bytes.toString('utf8') };
  }

  async getChangeBatch(batchId) {
    const batch = await this.db.get('SELECT * FROM assist_change_batches WHERE id=?', [batchId]);
    if (!batch) throw new AppError('not_found', 'change batch not found');
    return {
      ...batch,
      changes: rowJson(batch, 'changes_json', []),
      checkpoints: await this.db.query('SELECT id,batch_id,revision,created_at FROM assist_checkpoints WHERE batch_id=? ORDER BY revision', [batchId]),
      file_changes: await this.db.query('SELECT id,path,operation,before_sha256,after_sha256,created_at FROM file_changes WHERE batch_id=? ORDER BY created_at,id', [batchId])
    };
  }

  async createChangeBatch(input, ctx = {}) {
    const projectId = String(input?.project_id || '').trim();
    const sessionId = String(input?.session_id || '').trim();
    const session = await this.db.get('SELECT id,project_id,status FROM assist_sessions WHERE id=?', [sessionId]);
    assert(session && session.project_id === projectId, 'invalid_input', 'Assist session does not belong to project', { status: 422 });
    assert(['active', 'paused'].includes(session.status), 'assist_session_inactive', 'Assist session is not editable', { status: 409 });
    const rawChanges = Array.isArray(input?.changes) ? input.changes : [];
    assert(rawChanges.length > 0 && rawChanges.length <= 64, 'invalid_input', 'change batch must contain 1-64 changes', { status: 422 });
    const { root, repository } = await this.projectWorkspace(projectId);
    const changes = [];
    let totalBytes = 0;
    for (const raw of rawChanges) {
      const operation = String(raw?.operation || 'update');
      assert(['create', 'update', 'delete', 'rename'].includes(operation), 'invalid_input', 'change operation is invalid', { status: 422 });
      const relative = normalizeRelativePath(String(raw?.path || ''));
      const before = workspaceBytes(root, relative);
      const beforeSha = before ? sha256(before) : null;
      const expected = raw?.expected_sha256 == null ? null : String(raw.expected_sha256);
      if (expected && expected !== beforeSha) throw new AppError('change_batch_stale', 'file changed since the proposal was created', { status: 409, details: { path: relative, expected_sha256: expected, actual_sha256: beforeSha } });
      if (operation === 'create') assert(!before, 'file_exists', 'create target already exists', { status: 409, details: { path: relative } });
      if (operation === 'update' || operation === 'delete') assert(before, 'file_not_found', 'change target does not exist', { status: 404, details: { path: relative } });
      let content = null;
      if (operation !== 'delete') {
        content = raw?.encoding === 'base64' ? Buffer.from(String(raw?.content || ''), 'base64') : Buffer.from(String(raw?.content || ''), 'utf8');
        assert(content.byteLength <= 2 * 1024 * 1024, 'change_too_large', 'individual change exceeds the 2 MiB limit', { status: 413, details: { path: relative } });
        totalBytes += content.byteLength;
      }
      assert(totalBytes <= 10 * 1024 * 1024, 'change_batch_too_large', 'change batch exceeds the 10 MiB limit', { status: 413 });
      changes.push({ path: relative, operation, before_sha256: beforeSha, after_sha256: content ? sha256(content) : null, content_base64: content?.toString('base64') || null });
    }
    const batchId = id('batch');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO assist_change_batches(id,session_id,base_revision,changes_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: [batchId, sessionId, Number(input?.base_revision || 1), asJson(changes), 'proposed', timestamp, timestamp] },
      ...changes.map((change) => ({ sql: 'INSERT INTO file_changes(id,project_id,batch_id,path,operation,before_sha256,after_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [id('fch'), projectId, batchId, change.path, change.operation, change.before_sha256, change.after_sha256, timestamp] })),
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [sessionId, null, 'assist.change_batch.proposed', asJson({ batch_id: batchId, project_id: projectId, change_count: changes.length }), timestamp] },
      auditStatement('assist_change_batch.proposed', 'assist_change_batch', batchId, { project_id: projectId, session_id: sessionId, change_count: changes.length, repository: repository?.local_path || null }, ctx.actor)
    ]);
    return this.getChangeBatch(batchId);
  }

  async applyChangeBatch(batchId, input = {}, ctx = {}) {
    const batch = await this.db.get('SELECT * FROM assist_change_batches WHERE id=?', [batchId]);
    if (!batch) throw new AppError('not_found', 'change batch not found');
    const session = await this.db.get('SELECT project_id FROM assist_sessions WHERE id=?', [batch.session_id]);
    assert(!(await this.terminals.isProjectLocked(session.project_id)), 'terminal_write_locked', 'an active terminal owns the project write lock', { status: 409 });
    const repository = await this.db.get('SELECT local_path FROM repository_bindings WHERE project_id=?', [session.project_id]);
    return this.withRepositoryLock(repository?.local_path || session.project_id, () => this.applyChangeBatchLocked(batchId, input, ctx));
  }

  async applyChangeBatchLocked(batchId, input = {}, ctx = {}) {
    const batch = await this.db.get('SELECT * FROM assist_change_batches WHERE id=?', [batchId]);
    if (!batch) throw new AppError('not_found', 'change batch not found');
    assert(['proposed', 'approved'].includes(batch.status), 'invalid_state', 'change batch is not applicable', { status: 409 });
    const session = await this.db.get('SELECT project_id FROM assist_sessions WHERE id=?', [batch.session_id]);
    const { root, repository } = await this.projectWorkspace(session.project_id);
    const changes = rowJson(batch, 'changes_json', []);
    const snapshots = [];
    let snapshotBytes = 0;
    for (const change of changes) {
      const before = workspaceBytes(root, change.path);
      const actual = before ? sha256(before) : null;
      if (actual !== (change.before_sha256 || null)) {
        await this.db.run("UPDATE assist_change_batches SET status='stale',updated_at=? WHERE id=?", [now(), batchId]);
        throw new AppError('change_batch_stale', 'workspace changed after proposal', { status: 409, details: { path: change.path, expected_sha256: change.before_sha256 || null, actual_sha256: actual } });
      }
      snapshots.push({ path: change.path, operation: change.operation, before_sha256: actual, before_base64: before?.toString('base64') || null, after_sha256: change.after_sha256 || null });
      snapshotBytes += before?.byteLength || 0;
      assert(snapshotBytes <= 10 * 1024 * 1024, 'change_batch_too_large', 'rollback checkpoint exceeds the 10 MiB limit', { status: 413 });
    }
    try {
      for (const change of changes) {
        if (change.operation === 'delete') removeWorkspaceFile(root, change.path);
        else writeWorkspaceBytes(root, change.path, Buffer.from(change.content_base64 || '', 'base64'));
      }
      const timestamp = now();
      await this.db.transaction([
        { sql: "UPDATE assist_change_batches SET status='applied',updated_at=? WHERE id=? AND status IN ('proposed','approved')", params: [timestamp, batchId], expect_changes: 1 },
        { sql: 'INSERT INTO assist_checkpoints(id,batch_id,revision,snapshot_json,created_at) VALUES(?,?,?,?,?)', params: [id('chk'), batchId, 1, asJson({ files: snapshots }), timestamp] },
        { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [batch.session_id, null, 'assist.change_batch.applied', asJson({ batch_id: batchId, change_count: changes.length }), timestamp] },
        auditStatement('assist_change_batch.applied', 'assist_change_batch', batchId, { project_id: session.project_id, change_count: changes.length, repository: repository?.local_path || null }, ctx.actor)
      ]);
    } catch (error) {
      await this.restoreChangeSnapshot(root, snapshots).catch(() => undefined);
      throw error;
    }
    return this.getChangeBatch(batchId);
  }

  async restoreChangeSnapshot(root, snapshots) {
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.before_base64) writeWorkspaceBytes(root, snapshot.path, Buffer.from(snapshot.before_base64, 'base64'));
      else removeWorkspaceFile(root, snapshot.path);
    }
  }

  async rollbackChangeBatch(batchId, input = {}, ctx = {}) {
    const batch = await this.db.get('SELECT * FROM assist_change_batches WHERE id=?', [batchId]);
    if (!batch) throw new AppError('not_found', 'change batch not found');
    const session = await this.db.get('SELECT project_id FROM assist_sessions WHERE id=?', [batch.session_id]);
    assert(!(await this.terminals.isProjectLocked(session.project_id)), 'terminal_write_locked', 'an active terminal owns the project write lock', { status: 409 });
    const repository = await this.db.get('SELECT local_path FROM repository_bindings WHERE project_id=?', [session.project_id]);
    return this.withRepositoryLock(repository?.local_path || session.project_id, () => this.rollbackChangeBatchLocked(batchId, input, ctx));
  }

  async rollbackChangeBatchLocked(batchId, input = {}, ctx = {}) {
    const batch = await this.db.get('SELECT * FROM assist_change_batches WHERE id=?', [batchId]);
    if (!batch) throw new AppError('not_found', 'change batch not found');
    assert(batch.status === 'applied', 'invalid_state', 'only applied change batches can be rolled back', { status: 409 });
    const checkpoint = await this.db.get('SELECT * FROM assist_checkpoints WHERE batch_id=? ORDER BY revision DESC LIMIT 1', [batchId]);
    const session = await this.db.get('SELECT project_id FROM assist_sessions WHERE id=?', [batch.session_id]);
    const { root } = await this.projectWorkspace(session.project_id);
    const snapshots = rowJson(checkpoint, 'snapshot_json', {}).files || [];
    const changes = rowJson(batch, 'changes_json', []);
    const force = input?.force === true;
    for (const change of changes) {
      const current = workspaceBytes(root, change.path);
      const currentSha = current ? sha256(current) : null;
      if (currentSha !== change.after_sha256 && !force) throw new AppError('change_batch_stale', 'workspace changed after apply; force is required to undo', { status: 409, details: { path: change.path, expected_sha256: change.after_sha256 || null, actual_sha256: currentSha } });
    }
    await this.restoreChangeSnapshot(root, snapshots);
    const timestamp = now();
    await this.db.transaction([
      { sql: "UPDATE assist_change_batches SET status='rolled_back',updated_at=? WHERE id=? AND status='applied'", params: [timestamp, batchId], expect_changes: 1 },
      { sql: 'INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [batch.session_id, null, 'assist.change_batch.rolled_back', asJson({ batch_id: batchId, force }), timestamp] },
      auditStatement('assist_change_batch.rolled_back', 'assist_change_batch', batchId, { project_id: session.project_id, force }, ctx.actor)
    ]);
    return this.getChangeBatch(batchId);
  }

  terminalCapabilities() {
    return this.terminals.capabilities();
  }

  listTerminalSessions(projectId = null) {
    return this.terminals.list(projectId);
  }

  getTerminalSession(sessionId) {
    return this.terminals.get(sessionId);
  }

  createTerminalSession(input, ctx = {}) {
    return this.terminals.create(String(input?.project_id || ''), input, ctx);
  }

  terminalEvents(sessionId, cursor = 0) {
    return this.terminals.events(sessionId, cursor);
  }

  terminalAction(sessionId, input, ctx = {}) {
    return this.terminals.action(sessionId, String(input?.action || ''), input, ctx);
  }

  attachTerminalTransport(server) {
    return this.terminals.attach(server);
  }

  async activeCredentialSecrets() {
    return this.setupService.activeCredentialSecrets();
  }

  async captureTerminalArtifact(projectId, sessionId, content) {
    const asset = await this.prepareAsset(projectId, {
      name: `terminal/${sessionId}.log`,
      media_type: 'text/plain',
      content: Buffer.isBuffer(content) ? content : Buffer.from(content || '')
    });
    try {
      await this.db.transaction(this.assetInsertStatement(asset, 'system'));
      return this.db.get('SELECT * FROM asset_versions WHERE id=?', [asset.id]);
    } catch (error) {
      await this.cleanupPreparedAssets([asset]);
      throw error;
    }
  }

  async listRuntimeApprovals(projectId = null) {
    await this.db.run("UPDATE runtime_approvals SET decision='expired',decided_at=COALESCE(decided_at,?) WHERE decision='pending' AND expires_at IS NOT NULL AND expires_at<=?", [now(), now()]);
    const rows = projectId
      ? await this.db.query('SELECT * FROM runtime_approvals WHERE project_id=? ORDER BY created_at DESC,id', [projectId])
      : await this.db.query('SELECT * FROM runtime_approvals ORDER BY created_at DESC,id LIMIT 300');
    return rows.map((row) => ({ ...row, request: rowJson(row, 'request_json', {}) }));
  }

  async createRuntimeApproval(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const executionId = String(input?.execution_id || '').trim() || null;
    if (executionId) {
      const execution = await this.db.get('SELECT id FROM executions WHERE id=? AND project_id=?', [executionId, projectId]);
      assert(execution, 'invalid_input', 'execution does not belong to project', { status: 422 });
    }
    const action = String(input?.action || '').trim();
    assert(/^[A-Za-z0-9._:-]{1,120}$/.test(action), 'invalid_input', 'approval action is invalid', { status: 422 });
    const request = input?.request && typeof input.request === 'object' && !Array.isArray(input.request) ? input.request : {};
    const ttl = Number(input?.ttl_seconds ?? 3600);
    assert(Number.isInteger(ttl) && ttl >= 60 && ttl <= 7 * 24 * 60 * 60, 'invalid_input', 'approval ttl is invalid', { status: 422 });
    const approvalId = id('rap');
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await this.db.transaction([
      { sql: 'INSERT INTO runtime_approvals(id,project_id,execution_id,action,request_json,decision,expires_at,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,NULL)', params: [approvalId, projectId, executionId, action, asJson(request), 'pending', expiresAt, timestamp] },
      ...(executionId ? [eventStatement('runtime.approval.requested', executionId, null, { approval_id: approvalId, action, expires_at: expiresAt })] : []),
      auditStatement('runtime_approval.requested', 'runtime_approval', approvalId, { project_id: projectId, execution_id: executionId, action, expires_at: expiresAt }, ctx.actor)
    ]);
    return (await this.listRuntimeApprovals(projectId)).find((item) => item.id === approvalId);
  }

  async decideRuntimeApproval(approvalId, input, ctx = {}) {
    const decision = String(input?.decision || '');
    assert(['approved', 'rejected'].includes(decision), 'invalid_input', 'approval decision is invalid', { status: 422 });
    await this.listRuntimeApprovals();
    const approval = await this.db.get('SELECT * FROM runtime_approvals WHERE id=?', [approvalId]);
    if (!approval) throw new AppError('not_found', 'runtime approval not found');
    assert(approval.decision === 'pending', 'invalid_state', 'runtime approval is already resolved', { status: 409 });
    const timestamp = now();
    await this.db.transaction([
      { sql: "UPDATE runtime_approvals SET decision=?,decided_at=? WHERE id=? AND decision='pending'", params: [decision, timestamp, approvalId], expect_changes: 1 },
      ...(approval.execution_id ? [eventStatement(`runtime.approval.${decision}`, approval.execution_id, null, { approval_id: approvalId, action: approval.action })] : []),
      auditStatement('runtime_approval.decided', 'runtime_approval', approvalId, { decision, project_id: approval.project_id, execution_id: approval.execution_id }, ctx.actor)
    ]);
    return (await this.listRuntimeApprovals(approval.project_id)).find((item) => item.id === approvalId);
  }

  async listRuntimeUserInputs(executionId = null) {
    return executionId
      ? this.db.query('SELECT * FROM runtime_user_inputs WHERE execution_id=? ORDER BY created_at DESC,id', [executionId])
      : this.db.query('SELECT * FROM runtime_user_inputs ORDER BY created_at DESC,id LIMIT 300');
  }

  async createRuntimeUserInput(executionId, input, ctx = {}) {
    const execution = await this.db.get('SELECT id,project_id FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const prompt = String(input?.prompt || '').trim();
    assert(prompt.length >= 1 && prompt.length <= 10000, 'invalid_input', 'runtime input prompt is required', { status: 422 });
    const inputId = id('rui');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO runtime_user_inputs(id,execution_id,prompt,response,status,created_at,answered_at) VALUES(?,?,?,NULL,?,?,NULL)', params: [inputId, executionId, prompt, 'pending', timestamp] },
      eventStatement('runtime.user_input.requested', executionId, null, { input_id: inputId }),
      auditStatement('runtime_user_input.requested', 'runtime_user_input', inputId, { execution_id: executionId, project_id: execution.project_id }, ctx.actor)
    ]);
    return (await this.listRuntimeUserInputs(executionId)).find((item) => item.id === inputId);
  }

  async resolveRuntimeUserInput(inputId, input, ctx = {}) {
    const action = String(input?.action || 'answer');
    assert(['answer', 'cancel'].includes(action), 'invalid_input', 'runtime input action is invalid', { status: 422 });
    const current = await this.db.get('SELECT * FROM runtime_user_inputs WHERE id=?', [inputId]);
    if (!current) throw new AppError('not_found', 'runtime user input not found');
    assert(current.status === 'pending', 'invalid_state', 'runtime user input is already resolved', { status: 409 });
    const response = action === 'answer' ? String(input?.response || '').trim() : null;
    if (action === 'answer') assert(response.length >= 1 && response.length <= 100000, 'invalid_input', 'runtime input response is required', { status: 422 });
    const status = action === 'answer' ? 'answered' : 'cancelled';
    const timestamp = now();
    await this.db.transaction([
      { sql: "UPDATE runtime_user_inputs SET response=?,status=?,answered_at=? WHERE id=? AND status='pending'", params: [response, status, timestamp, inputId], expect_changes: 1 },
      eventStatement(`runtime.user_input.${status}`, current.execution_id, null, { input_id: inputId }),
      auditStatement(`runtime_user_input.${status}`, 'runtime_user_input', inputId, { execution_id: current.execution_id }, ctx.actor)
    ]);
    return (await this.listRuntimeUserInputs(current.execution_id)).find((item) => item.id === inputId);
  }

  async listUiActionIntents(projectId = null) {
    const rows = projectId
      ? await this.db.query('SELECT * FROM ui_action_intents WHERE project_id=? ORDER BY created_at DESC,id', [projectId])
      : await this.db.query('SELECT * FROM ui_action_intents ORDER BY created_at DESC,id LIMIT 300');
    return rows.map((row) => ({ ...row, payload: rowJson(row, 'payload_json', {}) }));
  }

  async createUiActionIntent(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const action = String(input?.action || '').trim();
    assert(/^[A-Za-z0-9._:-]{1,120}$/.test(action), 'invalid_input', 'UI action is invalid', { status: 422 });
    const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
    const intentId = id('uai');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO ui_action_intents(id,project_id,action,payload_json,status,created_at,resolved_at) VALUES(?,?,?,?,?,?,NULL)', params: [intentId, projectId, action, asJson(payload), 'pending', timestamp] },
      auditStatement('ui_action_intent.created', 'ui_action_intent', intentId, { project_id: projectId, action }, ctx.actor)
    ]);
    return (await this.listUiActionIntents(projectId)).find((item) => item.id === intentId);
  }

  async resolveUiActionIntent(intentId, input, ctx = {}) {
    const status = String(input?.status || '');
    assert(['accepted', 'rejected'].includes(status), 'invalid_input', 'UI action decision is invalid', { status: 422 });
    const current = await this.db.get('SELECT * FROM ui_action_intents WHERE id=?', [intentId]);
    if (!current) throw new AppError('not_found', 'UI action intent not found');
    assert(current.status === 'pending', 'invalid_state', 'UI action intent is already resolved', { status: 409 });
    await this.db.transaction([
      { sql: "UPDATE ui_action_intents SET status=?,resolved_at=? WHERE id=? AND status='pending'", params: [status, now(), intentId], expect_changes: 1 },
      auditStatement('ui_action_intent.resolved', 'ui_action_intent', intentId, { project_id: current.project_id, action: current.action, status }, ctx.actor)
    ]);
    return (await this.listUiActionIntents(current.project_id)).find((item) => item.id === intentId);
  }

  async assistEvents(sessionId, cursor = 0) {
    const session = await this.db.get('SELECT id FROM assist_sessions WHERE id=?', [sessionId]);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    return (await this.db.query('SELECT cursor,session_id,turn_id,type,data_json,created_at FROM assist_events WHERE session_id=? AND cursor>? ORDER BY cursor LIMIT 1000', [sessionId, Number(cursor) || 0])).map((row) => ({ cursor: row.cursor, session_id: row.session_id, turn_id: row.turn_id, type: row.type, data: rowJson(row, 'data_json', {}), created_at: row.created_at }));
  }

  async outcomeView(executionId) {
    const execution = await this.db.get('SELECT id,project_id,workflow_revision,status FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const [requirements, evaluations, waivers] = await Promise.all([
      this.listOutcomeRequirements(execution.project_id, execution.workflow_revision),
      this.db.query('SELECT * FROM outcome_evaluations WHERE execution_id=? ORDER BY created_at,id', [executionId]),
      this.db.query('SELECT * FROM outcome_waivers WHERE execution_id=? ORDER BY created_at,id', [executionId])
    ]);
    const evaluated = new Map(evaluations.map((row) => [row.requirement_id, { ...row, evidence: rowJson(row, 'evidence_json', []) }]));
    const waived = new Map(waivers.map((row) => [row.requirement_id, row]));
    const results = requirements.map((requirement) => ({ ...requirement, evaluation: evaluated.get(requirement.id) || null, waiver: waived.get(requirement.id) || null }));
    const eligible = execution.status === 'completed' && results.length > 0 && results.every((item) => item.waiver || item.evaluation?.status === 'passed');
    return { execution_id: executionId, status: execution.status, completion_status: eligible ? 'completed' : execution.status === 'completed' ? 'incomplete' : execution.status, release_eligible: eligible, requirements: results };
  }

  async evaluateOutcome(executionId, input, ctx = {}) {
    const execution = await this.db.get('SELECT id,project_id,workflow_revision,status FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const requirements = await this.listOutcomeRequirements(execution.project_id, execution.workflow_revision);
    assert(requirements.length > 0, 'invalid_input', 'outcome requirements are not configured', { status: 422 });
    const normalized = prepareOutcomeEvaluations(requirements, input, (await this.evidence.executionEvidence(executionId)).map((item) => item.asset_version_id));
    const timestamp = now();
    await this.db.transaction([
      ...normalized.map((item) => ({ sql: 'INSERT INTO outcome_evaluations(id,execution_id,requirement_id,status,score,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('oev'), executionId, item.requirement.id, item.status, item.score, asJson(item.evidence), timestamp] })),
      auditStatement('outcome.evaluated', 'execution', executionId, { requirement_count: normalized.length, execution_status: execution.status, evidence_count: new Set(normalized.flatMap((item) => item.evidence)).size }, ctx.actor)
    ]);
    return this.outcomeView(executionId);
  }

  async waiveOutcome(executionId, input, ctx = {}) {
    const execution = await this.db.get('SELECT id,project_id,workflow_revision FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const requirementId = String(input?.requirement_id || '').trim();
    const reason = String(input?.reason || '').trim();
    assert(requirementId && reason.length >= 3 && reason.length <= 1000, 'invalid_input', 'requirement_id and waiver reason are required', { status: 422 });
    const requirement = await this.db.get('SELECT id FROM outcome_requirements WHERE id=? AND project_id=? AND workflow_revision=?', [requirementId, execution.project_id, execution.workflow_revision]);
    assert(requirement, 'invalid_input', 'outcome requirement does not belong to execution', { status: 422 });
    const waiverId = id('owaiver');
    try {
      await this.db.transaction([
        { sql: 'INSERT INTO outcome_waivers(id,execution_id,requirement_id,reason,actor,created_at) VALUES(?,?,?,?,?,?)', params: [waiverId, executionId, requirementId, reason, ctx.actor || 'local-user', now()] },
        auditStatement('outcome.waived', 'execution', executionId, { requirement_id: requirementId }, ctx.actor)
      ]);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('already_exists', 'outcome requirement is already waived', { status: 409 });
      throw error;
    }
    return this.outcomeView(executionId);
  }

  async createWorkflow(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const tasks = validateWorkflowTasks(input?.tasks);
    const revision = Number((await this.db.get('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM workflow_revisions WHERE project_id=?', [projectId])).revision);
    const graphHash = hashJson(tasks);
    const timestamp = now();
    const contracts = tasks.map((task) => ({
      task,
      contract: {
        goal: task.goal || task.title || task.id,
        inputs: task.inputs || [],
        outputs: task.outputs || [],
        dependencies: task.deps || [],
        allowed_tools: task.allowed_tools || [],
        acceptance: task.acceptance || []
      }
    }));
    await this.db.transaction([
      { sql: 'INSERT INTO workflow_revisions(project_id,revision,name,tasks_json,graph_hash,created_at) VALUES(?,?,?,?,?,?)', params: [projectId, revision, String(input?.name || `Workflow ${revision}`).slice(0, 160), asJson(tasks), graphHash, timestamp] },
      { sql: 'INSERT INTO workflow_heads(project_id,revision,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at', params: [projectId, revision, timestamp] },
      ...contracts.map(({ task, contract }) => ({ sql: 'INSERT INTO node_contracts(id,project_id,workflow_revision,node_id,contract_json,created_at) VALUES(?,?,?,?,?,?)', params: [id('nct'), projectId, revision, task.id, asJson(contract), timestamp] })),
      ...contracts.map(({ task, contract }) => ({ sql: 'INSERT INTO node_contract_revisions(id,project_id,workflow_revision,node_id,revision,contract_json,contract_hash,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [id('ncr'), projectId, revision, task.id, 1, asJson(contract), hashJson(contract), 'legacy_compat', timestamp] })),
      auditStatement('workflow.created', 'project', projectId, { revision, graph_hash: graphHash }, ctx.actor)
    ]);
    return workflowView(await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? AND revision=?', [projectId, revision]));
  }

  async listContextSources(projectId, query = '') {
    await this.requireProject(projectId);
    if (query.trim()) {
      return this.db.query('SELECT s.* FROM context_source_fts f JOIN context_sources s ON s.id=f.source_id WHERE f.context_source_fts MATCH ? AND s.project_id=? ORDER BY s.created_at DESC', [query.trim(), projectId]);
    }
    return this.db.query('SELECT * FROM context_sources WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  }

  async createContextSource(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const kind = ['brief', 'repository', 'file', 'diff', 'test_report', 'image', 'note'].includes(input?.kind) ? input.kind : 'note';
    const sourcePath = input?.path ? normalizeRelativePath(String(input.path)) : '';
    if (kind === 'file' || kind === 'diff' || kind === 'test_report') assertReviewablePath(sourcePath);
    const content = String(input?.content || '');
    assert(content.length <= 2_000_000, 'invalid_input', 'context source is too large');
    const sourceId = id('src');
    const timestamp = now();
    const hash = sha256(content);
    await this.db.transaction([
      { sql: 'INSERT INTO context_sources(id,project_id,kind,path,title,content,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [sourceId, projectId, kind, sourcePath, String(input?.title || sourcePath || kind).slice(0, 200), content, hash, timestamp] },
      { sql: 'INSERT INTO context_source_fts(source_id,title,content) VALUES(?,?,?)', params: [sourceId, String(input?.title || sourcePath || kind), content] },
      auditStatement('context_source.created', 'context_source', sourceId, { project_id: projectId, kind }, ctx.actor)
    ]);
    return this.db.get('SELECT * FROM context_sources WHERE id=?', [sourceId]);
  }

  async listContextPacks(projectId) {
    await this.requireProject(projectId);
    return (await this.db.query('SELECT * FROM context_packs WHERE project_id=? ORDER BY created_at DESC', [projectId])).map(contextPackView);
  }

  async contextMap(projectId) {
    await this.requireProject(projectId);
    const nodes = await this.db.query(`SELECT n.id,n.parent_id,n.uri,n.title,n.kind,n.sensitivity,n.created_at,n.updated_at,
      (SELECT content_hash FROM context_document_versions v WHERE v.node_id=n.id ORDER BY version DESC LIMIT 1) AS content_hash
      FROM context_nodes n WHERE n.project_id=? ORDER BY n.uri`, [projectId]);
    return { project_id: projectId, root_uri: `aiws://context/${projectId}`, nodes };
  }

  async rebuildContextMap(projectId, _input, ctx = {}) {
    await this.requireProject(projectId);
    const jobId = id('cpj');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO context_projection_jobs(id,project_id,status,cursor,created_at,updated_at) VALUES(?,?,?,?,?,?)', params: [jobId, projectId, 'pending', '', timestamp, timestamp] },
      auditStatement('context.projection.queued', 'context_projection_job', jobId, { project_id: projectId }, ctx.actor)
    ]);
    return this.withRepositoryLock(`context:${projectId}`, () => this.runContextProjection(jobId, projectId, ctx));
  }

  async runContextProjection(jobId, projectId, ctx = {}) {
    const job = await this.db.get('SELECT * FROM context_projection_jobs WHERE id=? AND project_id=?', [jobId, projectId]);
    if (!job) throw new AppError('not_found', 'context projection job not found');
    if (job.status === 'completed') return { job, map: await this.contextMap(projectId) };
    const sources = await this.db.query('SELECT * FROM context_sources WHERE project_id=? ORDER BY created_at,id', [projectId]);
    const rootId = `ctx_${sha256(`root:${projectId}`).slice(0, 32)}`;
    const rootUri = `aiws://context/${projectId}`;
    const timestamp = now();
    await this.db.run("UPDATE context_projection_jobs SET status='running',error_code=NULL,updated_at=? WHERE id=?", [timestamp, jobId]);
    const statements = [
      { sql: `INSERT INTO context_nodes(id,project_id,parent_id,uri,title,kind,sensitivity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(uri) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`, params: [rootId, projectId, null, rootUri, 'Context', 'root', 'normal', timestamp, timestamp] }
    ];
    for (const source of sources) {
      const nodeId = `ctx_${sha256(`source:${source.id}`).slice(0, 32)}`;
      const uri = `${rootUri}/${encodeURIComponent(source.kind)}/${encodeURIComponent(source.id)}`;
      const existing = await this.db.get('SELECT id FROM context_nodes WHERE uri=?', [uri]);
      const resolvedNodeId = existing?.id || nodeId;
      statements.push(
        { sql: `INSERT INTO context_nodes(id,project_id,parent_id,uri,title,kind,sensitivity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(uri) DO UPDATE SET parent_id=excluded.parent_id,title=excluded.title,kind=excluded.kind,updated_at=excluded.updated_at`, params: [resolvedNodeId, projectId, rootId, uri, source.title, source.kind, 'normal', timestamp, timestamp] },
        { sql: 'INSERT OR IGNORE INTO context_edges(parent_id,child_id,relation,created_at) VALUES(?,?,?,?)', params: [rootId, resolvedNodeId, 'contains', timestamp] }
      );
      const latest = await this.db.get('SELECT version,content_hash FROM context_document_versions WHERE node_id=? ORDER BY version DESC LIMIT 1', [resolvedNodeId]);
      if (latest?.content_hash !== source.content_hash) statements.push({ sql: 'INSERT INTO context_document_versions(id,node_id,version,content_hash,content,created_at) VALUES(?,?,?,?,?,?)', params: [id('cdv'), resolvedNodeId, Number(latest?.version || 0) + 1, source.content_hash, source.content, timestamp] });
    }
    statements.push(
      { sql: "UPDATE context_projection_jobs SET status='completed',cursor=?,updated_at=? WHERE id=?", params: [String(sources.length), timestamp, jobId] },
      auditStatement('context.projection.completed', 'context_projection_job', jobId, { project_id: projectId, source_count: sources.length }, ctx.actor)
    );
    try {
      await this.db.transaction(statements);
      return { job: await this.db.get('SELECT * FROM context_projection_jobs WHERE id=?', [jobId]), map: await this.contextMap(projectId) };
    } catch (error) {
      await this.db.transaction([
        { sql: "UPDATE context_projection_jobs SET status='failed',error_code='context_projection_failed',updated_at=? WHERE id=?", params: [now(), jobId] },
        auditStatement('context.projection.failed', 'context_projection_job', jobId, { project_id: projectId, error_code: 'context_projection_failed' }, ctx.actor)
      ]).catch(() => undefined);
      throw error;
    }
  }

  async contextProjectionStatus(projectId) {
    await this.requireProject(projectId);
    return this.db.get('SELECT * FROM context_projection_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 1', [projectId]);
  }

  async readContextNode(projectId, uri) {
    await this.requireProject(projectId);
    const node = await this.db.get('SELECT * FROM context_nodes WHERE project_id=? AND uri=?', [projectId, String(uri || '')]);
    if (!node) throw new AppError('not_found', 'context node not found');
    const version = await this.db.get('SELECT id,version,content_hash,content,created_at FROM context_document_versions WHERE node_id=? ORDER BY version DESC LIMIT 1', [node.id]);
    return { ...node, document: version };
  }

  async createContextSelection(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const nodeIds = Array.isArray(input?.node_ids) ? [...new Set(input.node_ids.map(String))].slice(0, 200) : [];
    assert(nodeIds.length > 0, 'invalid_input', 'context selection needs at least one node', { status: 422 });
    const rows = await this.db.query(`SELECT id FROM context_nodes WHERE project_id=? AND id IN (${nodeIds.map(() => '?').join(',')})`, [projectId, ...nodeIds]);
    assert(rows.length === nodeIds.length, 'invalid_input', 'context node does not belong to project', { status: 422 });
    const selectionId = id('csel');
    const retrievalPlan = input?.retrieval_plan && typeof input.retrieval_plan === 'object' ? input.retrieval_plan : { strategy: 'explicit', token_budget: 12000 };
    await this.db.transaction([
      { sql: 'INSERT INTO context_selections(id,project_id,session_id,node_ids_json,retrieval_plan_json,created_at) VALUES(?,?,?,?,?,?)', params: [selectionId, projectId, input?.session_id || null, asJson(nodeIds), asJson(retrievalPlan), now()] },
      auditStatement('context.selection.created', 'context_selection', selectionId, { project_id: projectId, node_count: nodeIds.length }, ctx.actor)
    ]);
    return { id: selectionId, project_id: projectId, node_ids: nodeIds, retrieval_plan: retrievalPlan };
  }

  async createContextPack(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const requested = Array.isArray(input?.source_ids) ? [...new Set(input.source_ids.map(String))] : [];
    const sources = requested.length
      ? await this.db.query(`SELECT * FROM context_sources WHERE project_id=? AND id IN (${requested.map(() => '?').join(',')})`, [projectId, ...requested])
      : await this.db.query('SELECT * FROM context_sources WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]);
    assert(sources.length > 0, 'invalid_input', 'context pack needs at least one source');
    assert(sources.length === requested.length || !requested.length, 'invalid_input', 'context source does not belong to project');
    const pack = {
      schema_version: 'aiws.context_pack.v5',
      sources: sources.map((source) => ({ id: source.id, title: source.title, path: source.path, content: source.content })),
      selection: { schema_version: 'aiws.context_selection.v2', mode: String(input?.selection || 'explicit'), source_ids: sources.map((source) => source.id) },
      retrieval_plan: input?.retrieval_plan && typeof input.retrieval_plan === 'object' ? input.retrieval_plan : { strategy: 'explicit', token_budget: 12000 },
      memory_manifest: { brief_revision: Number((await this.confirmedBrief(projectId))?.revision || 0), source_hashes: Object.fromEntries(sources.map((source) => [source.id, source.content_hash])) }
    };
    const packId = id('pack');
    const packHash = hashJson(pack);
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO context_packs(id,project_id,source_ids_json,pack_json,pack_hash,created_at) VALUES(?,?,?,?,?,?)', params: [packId, projectId, asJson(sources.map((source) => source.id)), asJson(pack), packHash, timestamp] },
      auditStatement('context_pack.created', 'context_pack', packId, { project_id: projectId, pack_hash: packHash }, ctx.actor)
    ]);
    return contextPackView(await this.db.get('SELECT * FROM context_packs WHERE id=?', [packId]));
  }

  async listAssets(projectId) {
    await this.requireProject(projectId);
    return this.db.query('SELECT * FROM asset_versions WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  }

  async prepareAsset(projectId, input) {
    await this.requireProject(projectId);
    const name = normalizeRelativePath(String(input?.name || 'attachment.bin'));
    const mediaType = String(input?.media_type || 'text/plain').slice(0, 120);
    const content = Buffer.isBuffer(input?.content)
      ? Buffer.from(input.content)
      : input?.encoding === 'base64'
        ? Buffer.from(String(input.content || ''), 'base64')
        : Buffer.from(String(input?.content || ''), 'utf8');
    assert(content.byteLength <= DIFF_MAX_BYTES, 'invalid_input', 'asset is too large');
    const casHash = sha256(content);
    const casRelative = path.posix.join('sha256', casHash.slice(0, 2), casHash);
    const casPath = path.join(this.config.casRoot, casHash.slice(0, 2), casHash);
    let newBlob = false;
    try {
      assertNoStorageSymlinks(this.config.home, path.dirname(casPath));
      fs.mkdirSync(path.dirname(casPath), { recursive: true, mode: 0o770 });
      assertNoStorageSymlinks(this.config.home, path.dirname(casPath));
      grantRunnerPath(this.config.casRoot, { directory: true });
      grantRunnerPath(path.dirname(casPath), { directory: true });
      if (!fs.existsSync(casPath)) {
        try { fs.writeFileSync(casPath, content, { flag: 'wx', mode: 0o660 }); newBlob = true; }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
      }
      assertNoStorageSymlinks(this.config.home, casPath);
      const stored = fs.readFileSync(casPath);
      if (!fs.lstatSync(casPath).isFile() || stored.byteLength !== content.byteLength || !stored.equals(content)) throw new AppError('cas_blob_corrupt', 'CAS blob does not match its content hash', { status: 500 });
      grantRunnerPath(casPath);
      const version = Number((await this.db.get('SELECT COALESCE(MAX(version),0)+1 AS version FROM asset_versions WHERE project_id=? AND name=?', [projectId, name])).version);
      return {
        id: id('asset'), project_id: projectId, name, media_type: mediaType, byte_size: content.byteLength,
        cas_hash: casHash, cas_path: casRelative, version, created_at: now(), _cas_path: casPath, _new_blob: newBlob
      };
    } catch (error) {
      if (newBlob) {
        const referenced = await this.db.get('SELECT 1 AS present FROM asset_versions WHERE cas_hash=? LIMIT 1', [casHash]).catch(() => null);
        if (!referenced) fs.rmSync(casPath, { force: true });
      }
      throw error;
    }
  }

  assetInsertStatement(asset, actor = 'local-user') {
    return [
      { sql: 'INSERT INTO asset_versions(id,project_id,name,media_type,byte_size,cas_hash,cas_path,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [asset.id, asset.project_id, asset.name, asset.media_type, asset.byte_size, asset.cas_hash, asset.cas_path, asset.version, asset.created_at] },
      auditStatement('asset.created', 'asset_version', asset.id, { project_id: asset.project_id, cas_hash: asset.cas_hash }, actor)
    ];
  }

  async cleanupPreparedAssets(assets = []) {
    for (const asset of assets) {
      if (!asset?._new_blob || !asset._cas_path) continue;
      const referenced = await this.db.get('SELECT 1 AS present FROM asset_versions WHERE cas_hash=? LIMIT 1', [asset.cas_hash]).catch(() => null);
      if (!referenced) fs.rmSync(asset._cas_path, { force: true });
    }
  }

  async createAsset(projectId, input, ctx = {}) {
    const asset = await this.prepareAsset(projectId, input);
    try {
      await this.db.transaction(this.assetInsertStatement(asset, ctx.actor));
      return this.db.get('SELECT * FROM asset_versions WHERE id=?', [asset.id]);
    } catch (error) {
      await this.cleanupPreparedAssets([asset]);
      throw error;
    }
  }

  async listAttachments(projectId) {
    await this.requireProject(projectId);
    return this.db.query('SELECT id,project_id,name,media_type,byte_size,sha256,created_at FROM attachments WHERE project_id=? ORDER BY created_at DESC,id', [projectId]);
  }

  async createAttachment(projectId, input, ctx = {}) {
    const allowed = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv', 'application/xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'text/html', 'application/pdf']);
    const mediaType = String(input?.media_type || 'application/octet-stream').toLowerCase().split(';')[0].trim();
    assert(allowed.has(mediaType), 'attachment_media_type_unsupported', 'attachment media type is not supported', { status: 415 });
    const asset = await this.prepareAsset(projectId, { ...input, media_type: mediaType });
    const declared = String(input?.sha256 || '').trim();
    if (declared && declared !== asset.cas_hash) {
      await this.cleanupPreparedAssets([asset]);
      throw new AppError('attachment_hash_mismatch', 'attachment SHA-256 does not match content', { status: 422 });
    }
    const quota = Number((await this.db.get('SELECT COALESCE(SUM(byte_size),0) AS total FROM attachments WHERE project_id=?', [projectId])).total || 0);
    if (quota + asset.byte_size > 100 * 1024 * 1024) {
      await this.cleanupPreparedAssets([asset]);
      throw new AppError('attachment_quota_exceeded', 'project attachment quota exceeded', { status: 413 });
    }
    const attachmentId = id('attc');
    try {
      await this.db.transaction([
        { sql: 'INSERT INTO attachments(id,project_id,name,media_type,byte_size,sha256,cas_path,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [attachmentId, projectId, asset.name, mediaType, asset.byte_size, asset.cas_hash, asset.cas_path, now()] },
        auditStatement('attachment.created', 'attachment', attachmentId, { project_id: projectId, media_type: mediaType, byte_size: asset.byte_size, sha256: asset.cas_hash }, ctx.actor)
      ]);
    } catch (error) {
      await this.cleanupPreparedAssets([asset]);
      throw error;
    }
    return (await this.listAttachments(projectId)).find((row) => row.id === attachmentId);
  }

  async listQualityReviewRuns(projectId) {
    await this.requireProject(projectId);
    const runs = await this.db.query('SELECT * FROM quality_review_runs WHERE project_id=? ORDER BY created_at DESC,id', [projectId]);
    return Promise.all(runs.map(async (run) => ({ ...run, policy: rowJson(run, 'policy_json', {}), reports: (await this.db.query('SELECT * FROM quality_review_reports WHERE run_id=? ORDER BY created_at,id', [run.id])).map((report) => ({ ...report, report: rowJson(report, 'report_json', {}) })) })));
  }

  async createQualityReview(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const assetId = String(input?.asset_id || '').trim();
    const attachmentId = String(input?.attachment_id || '').trim();
    assert(Boolean(assetId) !== Boolean(attachmentId), 'invalid_input', 'exactly one asset_id or attachment_id is required', { status: 422 });
    const source = assetId
      ? await this.db.get('SELECT id,name,media_type,byte_size,cas_hash FROM asset_versions WHERE id=? AND project_id=?', [assetId, projectId])
      : await this.db.get('SELECT id,name,media_type,byte_size,sha256 AS cas_hash FROM attachments WHERE id=? AND project_id=?', [attachmentId, projectId]);
    if (!source) throw new AppError('not_found', 'quality review input not found');
    const mediaType = String(source.media_type).toLowerCase().split(';')[0];
    const mediaKind = qualityReviewMediaKind(source.name, mediaType, { hasBody: Number(source.byte_size) > 0 });
    assert(['text', 'json', 'xml', 'image', 'pdf'].includes(mediaKind), 'quality_media_type_unsupported', 'quality review parser does not support this media type', { status: 415 });
    const file = path.join(this.config.casRoot, source.cas_hash.slice(0, 2), source.cas_hash);
    assertNoStorageSymlinks(this.config.home, file);
    let content;
    try { content = fs.readFileSync(file); } catch { throw new AppError('quality_input_missing', 'quality review input is missing', { status: 422 }); }
    assert(content.byteLength === Number(source.byte_size), 'quality_input_corrupt', 'quality review input size does not match metadata', { status: 422 });
    const parser = mediaType.startsWith('image/') ? 'image-metadata' : mediaType === 'application/pdf' ? 'pdf-metadata' : mediaType === 'application/json' ? 'json' : mediaType.includes('xml') || mediaType === 'image/svg+xml' ? 'xml' : mediaType === 'text/csv' ? 'csv' : 'text';
    const text = parser === 'image-metadata' || parser === 'pdf-metadata' ? '' : content.toString('utf8');
    if (parser === 'json') {
      try { JSON.parse(text); } catch { throw new AppError('quality_parse_failed', 'JSON quality input is invalid', { status: 422 }); }
    }
    assert(input?.semantic_human_score != null, 'quality_human_score_required', 'semantic_human_score is required', { status: 422 });
    const score = Number(input.semantic_human_score);
    assert(Number.isFinite(score) && score >= 0 && score <= 100, 'invalid_input', 'semantic_human_score must be 0-100', { status: 422 });
    const runId = id('qrr');
    const reportId = id('qrep');
    const readiness = score >= 80 ? 'ready' : 'blocked';
    const report = { source_id: source.id, name: source.name, parser, byte_size: source.byte_size, cas_hash: source.cas_hash, reviewer_readiness: readiness, anchor: { sha256: source.cas_hash, bytes: source.byte_size } };
    const policy = { semantic_human_score_threshold: 80, freshness: 'fresh', source_type: assetId ? 'asset' : 'attachment' };
    await this.db.transaction([
      { sql: 'INSERT INTO quality_review_runs(id,project_id,execution_id,status,policy_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: [runId, projectId, input?.execution_id || null, 'completed', asJson(policy), now(), now()] },
      { sql: 'INSERT INTO quality_review_reports(id,run_id,parser,media_type,freshness,semantic_human_score,report_json,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [reportId, runId, parser, mediaType, 'fresh', score, asJson(report), now()] },
      { sql: 'INSERT INTO quality_review_events(run_id,type,data_json,created_at) VALUES(?,?,?,?)', params: [runId, 'quality.review.completed', asJson({ report_id: reportId, reviewer_readiness: readiness }), now()] },
      auditStatement('quality_review.created', 'quality_review_run', runId, { project_id: projectId, parser, score, reviewer_readiness: readiness }, ctx.actor)
    ]);
    return (await this.listQualityReviewRuns(projectId)).find((run) => run.id === runId);
  }

  async createExecution(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const workflow = input?.workflow_revision
      ? await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? AND revision=?', [projectId, Number(input.workflow_revision)])
      : await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    const brief = await this.confirmedBrief(projectId);
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]);
    assert(workflow, 'invalid_input', 'a workflow revision is required');
    assert(brief, 'invalid_input', 'a confirmed brief revision is required');
    if (input?.brief_revision != null) {
      const requestedBriefRevision = Number(input.brief_revision);
      assert(Number.isInteger(requestedBriefRevision) && requestedBriefRevision === Number(brief.revision), 'invalid_input', 'brief_revision must reference the confirmed brief revision', { status: 422 });
    }
    const contextPack = input?.context_pack_id ? await this.db.get('SELECT * FROM context_packs WHERE id=? AND project_id=?', [input.context_pack_id, projectId]) : null;
    if (input?.context_pack_id && !contextPack) throw new AppError('not_found', 'context pack not found');
    const requestedAssets = Array.isArray(input?.asset_ids) ? [...new Set(input.asset_ids.map(String))] : [];
    const assets = requestedAssets.length
      ? await this.db.query(`SELECT id,name,media_type,byte_size,cas_hash,cas_path FROM asset_versions WHERE project_id=? AND id IN (${requestedAssets.map(() => '?').join(',')})`, [projectId, ...requestedAssets])
      : [];
    assert(assets.length === requestedAssets.length, 'invalid_input', 'execution input asset is not in project');
    assert(new Set(assets.map((asset) => asset.name)).size === assets.length, 'invalid_input', 'execution input assets contain duplicate paths');
    const inputNames = assets.map((asset) => asset.name).sort();
    for (let index = 1; index < inputNames.length; index += 1) assert(!inputNames[index].startsWith(`${inputNames[index - 1]}/`), 'invalid_input', 'execution input assets contain conflicting paths');
    const executionId = id('exe');
    const timestamp = now();
    const tasks = rowJson(workflow, 'tasks_json', []);
    const execution = {
      id: executionId,
      project_id: projectId,
      workflow_revision: workflow.revision,
      brief_revision: brief.revision,
      brief_hash: brief.content_hash,
      repository_sha: repository?.head_sha || '',
      context_pack_id: contextPack?.id || null,
      context_pack_hash: contextPack?.pack_hash || '',
      input_assets_json: asJson(assets.map((asset) => ({
        id: asset.id, name: asset.name, relative_path: asset.name, media_type: asset.media_type,
        byte_size: asset.byte_size, cas_hash: asset.cas_hash
      }))),
      status: 'queued',
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp
    };
    const statements = [
      { sql: 'INSERT INTO executions(id,project_id,workflow_revision,brief_revision,brief_hash,repository_sha,context_pack_id,context_pack_hash,input_assets_json,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [execution.id, execution.project_id, execution.workflow_revision, execution.brief_revision, execution.brief_hash, execution.repository_sha, execution.context_pack_id, execution.context_pack_hash, execution.input_assets_json, execution.status, execution.revision, execution.created_at, execution.updated_at] },
      ...tasks.map((task) => ({ sql: 'INSERT INTO task_attempts(id,execution_id,task_id,attempt_no,status,mode,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('att'), executionId, task.id, 1, 'pending', 'initial', timestamp] })),
      ...assets.map((asset) => ({ sql: 'INSERT INTO execution_inputs(execution_id,asset_version_id,cas_hash) VALUES(?,?,?)', params: [executionId, asset.id, asset.cas_hash] })),
      eventStatement('execution.created', executionId, null, { workflow_revision: workflow.revision, brief_hash: brief.content_hash }),
      auditStatement('execution.created', 'execution', executionId, { project_id: projectId }, ctx.actor)
    ];
    await this.db.transaction(statements);
    await this.emitExecutionEvents(executionId);
    return this.getExecution(executionId);
  }

  async getExecution(executionId, options = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const attempts = await this.db.query('SELECT * FROM task_attempts WHERE execution_id=? ORDER BY task_id,attempt_no', [executionId]);
    const [diff, evidence, worktree, evidenceState, retryAudit] = await Promise.all([
      this.db.get('SELECT execution_id,project_id,baseline_sha,files_json,diff_sha256,asset_version_id,created_at,length(CAST(diff AS BLOB)) AS diff_bytes FROM execution_diffs WHERE execution_id=?', [executionId]),
      options.includeEvidence === false ? [] : this.executionEvidence(executionId),
      this.db.get('SELECT baseline_sha,removed_at FROM repository_worktrees WHERE execution_id=?', [executionId]),
      this.db.get("SELECT action,payload_json FROM audit_events WHERE entity_type='execution' AND entity_id=? AND action IN ('execution.evidence_failed','execution.evidence_resolved') ORDER BY created_at DESC,rowid DESC LIMIT 1", [executionId]),
      this.db.get("SELECT payload_json FROM audit_events WHERE entity_type='execution' AND entity_id=? AND action='execution.human_retry_requested' ORDER BY created_at DESC,rowid DESC LIMIT 1", [executionId])
    ]);
    if (diff && worktree && !worktree.removed_at && ['completed', 'cancelled'].includes(execution.status)) {
      await this.cleanupExecutionWorkspace(executionId, { capture: false });
    }
    const finalWorktree = diff && worktree && !worktree.removed_at && ['completed', 'cancelled'].includes(execution.status)
      ? await this.db.get('SELECT baseline_sha,removed_at FROM repository_worktrees WHERE execution_id=?', [executionId])
      : worktree;
    const view = executionView(execution, attempts);
    view.diff = diff ? { execution_id: diff.execution_id, project_id: diff.project_id, baseline_sha: diff.baseline_sha, files: rowJson(diff, 'files_json', []), diff_sha256: diff.diff_sha256, byte_size: Number(diff.diff_bytes || 0), asset_version_id: diff.asset_version_id } : null;
    view.evidence = evidence;
    const latestAttempt = attempts.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.attempt_no - b.attempt_no).at(-1);
    const evidenceError = evidenceState?.action === 'execution.evidence_failed' ? rowJson(evidenceState, 'payload_json', {}) : {};
    const retryPayload = rowJson(retryAudit, 'payload_json', {});
    view.runner = {
      status: execution.status,
      baseline_sha: finalWorktree?.baseline_sha || execution.repository_sha || null,
      worktree_status: finalWorktree ? (finalWorktree.removed_at ? 'removed' : 'active') : 'none',
      auto_correct_count: attempts.filter((attempt) => attempt.mode === 'auto_correct').length,
      last_error_code: [...attempts].reverse().find((attempt) => attempt.error_code)?.error_code || null,
      latest_attempt: latestAttempt ? { id: latestAttempt.id, task_id: latestAttempt.task_id, attempt_no: latestAttempt.attempt_no, status: latestAttempt.status } : null,
      human_instruction: String(retryPayload.instruction || '').slice(0, 2000) || null,
      evidence_status: diff ? 'captured' : evidenceError.error_code ? 'failed' : execution.status === 'running' ? 'pending' : 'not_captured',
      evidence_error_code: evidenceError.error_code || null,
      evidence_error_details: evidenceError.details || null,
      diff_bytes: diff ? Number(diff.diff_bytes || 0) : 0
    };
    return view;
  }

  async listExecutions(projectId) {
    await this.requireProject(projectId);
    const rows = await this.db.query('SELECT * FROM executions WHERE project_id=? ORDER BY created_at DESC', [projectId]);
    return Promise.all(rows.map((row) => this.getExecution(row.id, { includeEvidence: false })));
  }

  async withRepositoryLock(key, fn) {
    const previous = this.repositoryLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.repositoryLocks.set(key, current);
    await previous;
    try { return await fn(); } finally {
      release();
      if (this.repositoryLocks.get(key) === current) this.repositoryLocks.delete(key);
    }
  }

  async startExecution(executionId, input = {}, ctx = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    assert(['queued', 'failed', 'awaiting_human'].includes(execution.status), 'invalid_state', 'execution is not startable', { status: 409 });
    const evidenceState = execution.status === 'failed'
      ? await this.db.get("SELECT action FROM audit_events WHERE entity_type='execution' AND entity_id=? AND action IN ('execution.evidence_failed','execution.evidence_resolved') ORDER BY created_at DESC,rowid DESC LIMIT 1", [executionId])
      : null;
    if (evidenceState?.action === 'execution.evidence_failed') throw new AppError('evidence_resolution_required', 'resolve execution evidence before restarting', { status: 409 });
    if (execution.status === 'awaiting_human' && input.mode !== 'human_retry' && input.mode !== 'replan') {
      throw new AppError('human_review_required', 'choose human_retry or replan before continuing', { status: 409 });
    }
    if (input.mode === 'replan') {
      throw new AppError('feature_unavailable', 'replan is unavailable', { status: 501, retryable: false });
    }
    const instruction = input.mode === 'human_retry' ? String(input.instruction || '').trim() : '';
    if (input.mode === 'human_retry') assert(instruction.length <= 2000, 'invalid_input', 'human retry instruction is limited to 2000 characters');
    const expected = input.expected_revision == null ? execution.revision : Number(input.expected_revision);
    if (expected !== execution.revision) throw new AppError('revision_conflict', 'execution revision has changed', { details: { expected_revision: expected } });
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [execution.project_id]);
    const start = async () => {
      const current = await this.db.get('SELECT status,revision FROM executions WHERE id=?', [executionId]);
      assert(current && ['queued', 'failed', 'awaiting_human'].includes(current.status) && current.revision === expected, 'revision_conflict', 'execution revision has changed', { status: 409, details: { expected_revision: expected } });
      let worktreePath = null;
      let worktreeRecordCreated = false;
      let preservedWorktree = false;
      let stagedInputs = false;
      let inputSubpath = `inputs/${execution.project_id}/${execution.id}`;
      const outputRoot = resolveWorkspacePath(this.config.home, `projects/${execution.project_id}/outputs/${execution.id}`);
      try {
        if (repository?.head_sha) {
          const repositoryRoot = resolveWorkspacePath(this.config.home, repository.local_path);
          const actualHead = await gitHead(repositoryRoot);
          assert(actualHead === repository.head_sha, 'repository_baseline_changed', 'repository baseline changed since project creation', { status: 409, details: { expected_sha: repository.head_sha, actual_sha: actualHead || null } });
          await ensureExecutionExcludes(repositoryRoot);
          assert((await gitStatus(repositoryRoot)) === '', 'repository_baseline_dirty', 'repository baseline has uncommitted changes', { status: 409 });
          const worktreeRelative = `projects/${execution.project_id}/worktrees/${execution.id}`;
          worktreePath = resolveWorkspacePath(this.config.home, worktreeRelative);
          const existingWorktree = await this.db.get('SELECT execution_id,worktree_path,removed_at FROM repository_worktrees WHERE execution_id=?', [executionId]);
          assert(!existingWorktree || existingWorktree.worktree_path === worktreeRelative, 'worktree_record_invalid', 'execution worktree record is invalid', { status: 409 });
          preservedWorktree = Boolean(current.status === 'awaiting_human' && existingWorktree && !existingWorktree.removed_at && fs.existsSync(worktreePath));
          await createWorktree(repositoryRoot, worktreePath, repository.head_sha, { preserveChanges: preservedWorktree });
          if (!existingWorktree) {
            await this.db.run('INSERT INTO repository_worktrees(execution_id,project_id,baseline_sha,worktree_path,mode,created_at) VALUES(?,?,?,?,?,?)', [executionId, execution.project_id, repository.head_sha, worktreeRelative, 'write', now()]);
            worktreeRecordCreated = true;
          } else await this.db.run('UPDATE repository_worktrees SET baseline_sha=?,worktree_path=?,removed_at=NULL WHERE execution_id=?', [repository.head_sha, worktreeRelative, executionId]);
        }
        fs.mkdirSync(this.config.casRoot, { recursive: true, mode: 0o770 });
        grantRunnerPath(this.config.casRoot, { directory: true });
        const inputAssets = await this.db.query(`SELECT a.id,a.name,a.media_type,a.byte_size,a.cas_hash,a.cas_path
          FROM execution_inputs i JOIN asset_versions a ON a.id=i.asset_version_id
          WHERE i.execution_id=? ORDER BY a.name`, [executionId]);
        stagedInputs = true;
        const staged = stageExecutionInputs(this.config, execution.project_id, execution.id, inputAssets);
        inputSubpath = staged.subpath;
        fs.mkdirSync(outputRoot, { recursive: true, mode: 0o770 });
        grantRunnerPath(outputRoot, { directory: true });
        await this.db.transaction([
          { sql: 'UPDATE executions SET status=\'running\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), executionId, expected], expect_changes: 1 },
          eventStatement('execution.started', executionId, null, { mode: input.mode || 'initial', input_subpath: inputSubpath }),
          ...(input.mode === 'human_retry' ? [auditStatement('execution.human_retry_requested', 'execution', executionId, { instruction }, ctx.actor)] : []),
          auditStatement('execution.started', 'execution', executionId, { mode: input.mode || 'initial', input_subpath: inputSubpath }, ctx.actor)
        ]);
        if (input.mode === 'human_retry') this.retryInstructions.set(executionId, instruction);
      } catch (error) {
        if (worktreePath && !preservedWorktree) await removeWorktree(resolveWorkspacePath(this.config.home, repository.local_path), worktreePath).catch(() => undefined);
        if (worktreeRecordCreated) await this.db.run('DELETE FROM repository_worktrees WHERE execution_id=?', [executionId]).catch(() => undefined);
        else if (worktreePath && !preservedWorktree) await this.db.run('UPDATE repository_worktrees SET removed_at=? WHERE execution_id=?', [now(), executionId]).catch(() => undefined);
        if (!preservedWorktree) fs.rmSync(outputRoot, { recursive: true, force: true });
        if (stagedInputs && !preservedWorktree) removeExecutionInputs(this.config, execution.project_id, execution.id);
        if (isTransactionPrecondition(error) || error?.code === 'revision_conflict') throw new AppError('revision_conflict', 'execution revision has changed', { details: { expected_revision: expected } });
        throw error;
      }
      await this.emitExecutionEvents(executionId);
      void this.driveExecution(executionId, input.mode === 'human_retry' ? 'human_retry' : 'initial', instruction);
      return this.getExecution(executionId);
    };
    return repository?.local_path ? this.withRepositoryLock(repository.local_path, start) : start();
  }

  async cancelExecution(executionId, input = {}, ctx = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    assert(['queued', 'running', 'failed', 'awaiting_human'].includes(execution.status), 'invalid_state', 'execution is not cancellable', { status: 409 });
    const expected = Number(input.expected_revision ?? execution.revision);
    const running = await this.db.query("SELECT id,broker_job_id FROM task_attempts WHERE execution_id=? AND status='running'", [executionId]);
    try {
      await this.db.transaction([
        { sql: 'UPDATE executions SET status=\'cancelled\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), executionId, expected], expect_changes: 1 },
        { sql: 'UPDATE task_attempts SET status=\'cancelled\',finished_at=? WHERE execution_id=? AND status IN (\'pending\',\'ready\',\'running\',\'failed\',\'awaiting_human\')', params: [now(), executionId] },
        eventStatement('execution.cancelled', executionId, null, {}),
        auditStatement('execution.cancelled', 'execution', executionId, {}, ctx.actor)
      ]);
    } catch (error) {
      if (!isTransactionPrecondition(error)) throw error;
      throw new AppError('revision_conflict', 'execution revision has changed', { details: { expected_revision: expected } });
    }
    for (const attempt of running) {
      if (attempt.broker_job_id) await this.broker.cancel(attempt.broker_job_id).catch(() => undefined);
      this.releaseAttempt(attempt.id);
    }
    try {
      await this.captureExecutionEvidence(executionId);
    } catch (error) {
      await this.recordMinimalEvidenceError(executionId, error, 'cancelled', ctx.actor);
    }
    await this.cleanupExecutionWorkspace(executionId, { capture: false });
    await this.emitExecutionEvents(executionId);
    return this.getExecution(executionId);
  }

  async createReview(input, ctx = {}) {
    const projectId = String(input?.project_id || '');
    await this.requireProject(projectId);
    const status = MODEL_SUGGESTION_STATUSES.includes(input?.model_status) ? input.model_status : 'unavailable';
    const suggestion = input?.suggestion && typeof input.suggestion === 'object' ? input.suggestion : {};
    const reviewId = id('rev');
    const inputHash = input?.input_hash && /^[a-f0-9]{64}$/.test(input.input_hash) ? input.input_hash : hashJson({ projectId, execution_id: input.execution_id || null, suggestion });
    await this.db.transaction([
      { sql: 'INSERT INTO reviews(id,project_id,execution_id,kind,model_status,suggestion_json,input_hash,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [reviewId, projectId, input.execution_id || null, input.kind || 'task', status, asJson(suggestion), inputHash, 1, now()] },
      auditStatement('review.created', 'review', reviewId, { project_id: projectId, model_status: status }, ctx.actor)
    ]);
    if (input.execution_id) {
      const links = await this.db.query("SELECT DISTINCT asset_version_id FROM evidence_links WHERE (target_type='execution' AND target_id=?) OR (target_type='task' AND target_id LIKE ?)", [input.execution_id, `${input.execution_id}:%`]);
      if (links.length) await this.db.transaction(links.map((link) => ({ sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), projectId, link.asset_version_id, 'review', reviewId, now()] })));
    }
    return this.getReview(reviewId);
  }

  async getReview(reviewId) {
    const review = await this.db.get('SELECT * FROM reviews WHERE id=?', [reviewId]);
    if (!review) throw new AppError('not_found', 'review not found');
    const decision = await this.db.get('SELECT * FROM review_decisions WHERE review_id=?', [reviewId]);
    return { ...review, suggestion: rowJson(review, 'suggestion_json', {}), decision };
  }

  async listReviews(projectId) {
    const rows = projectId ? await this.db.query('SELECT * FROM reviews WHERE project_id=? ORDER BY created_at DESC', [projectId]) : await this.db.query('SELECT * FROM reviews ORDER BY created_at DESC');
    return Promise.all(rows.map((row) => this.getReview(row.id)));
  }

  async decideReview(reviewId, input, ctx = {}) {
    const review = await this.db.get('SELECT * FROM reviews WHERE id=?', [reviewId]);
    if (!review) throw new AppError('not_found', 'review not found');
    const decision = String(input?.decision || '');
    assert(['approved', 'rejected', 'changes_requested'].includes(decision), 'invalid_input', 'review decision is invalid');
    const decisionId = id('dec');
    try {
      await this.db.transaction([
        { sql: 'INSERT INTO review_decisions(id,review_id,decision,note,created_at) VALUES(?,?,?,?,?)', params: [decisionId, reviewId, decision, String(input?.note || ''), now()] },
        auditStatement('review.decided', 'review', reviewId, { decision }, ctx.actor)
      ]);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new AppError('immutable_review_decision', 'review already has a human decision', { status: 409 });
      throw error;
    }
    return this.getReview(reviewId);
  }

  async createDelivery(input, ctx = {}) {
    const projectId = String(input?.project_id || '');
    await this.requireProject(projectId);
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]);
    assert(repository, 'invalid_input', 'delivery requires a repository binding');
    const execution = input?.execution_id ? await this.db.get('SELECT id,project_id,status FROM executions WHERE id=?', [String(input.execution_id)]) : null;
    assert(execution && execution.project_id === projectId && execution.status === 'completed', 'invalid_state', 'delivery requires a completed execution from this project', { status: 409 });
    assert(input.review_id, 'review_required', 'an approved human review is required before delivery', { status: 409 });
    const review = await this.getReview(input.review_id);
    assert(review.project_id === projectId && review.execution_id === execution.id && review.kind === 'delivery_create' && review.decision?.decision === 'approved', 'review_required', 'an approved delivery review for this execution is required', { status: 409 });
    const deliveryId = id('del');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO deliveries(id,project_id,execution_id,repository_binding_id,kind,status,title,body,external_ref,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', params: [deliveryId, projectId, input.execution_id || null, repository.id, 'draft_pr', 'draft', String(input.title || 'AIWS draft change'), String(input.body || ''), '', 1, timestamp, timestamp] },
      auditStatement('delivery.created', 'delivery', deliveryId, { project_id: projectId }, ctx.actor)
    ]);
    const delivery = await this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
    return this.github?.configured ? this.submitDelivery(delivery, ctx) : this.deliveryView(delivery);
  }

  async deliveryView(delivery) {
    if (!delivery) return null;
    const latest = await this.db.get("SELECT action,payload_json FROM audit_events WHERE entity_type='delivery' AND entity_id=? AND action IN ('delivery.submitted','delivery.blocked','delivery.merged') ORDER BY created_at DESC LIMIT 1", [delivery.id]);
    const payload = rowJson(latest, 'payload_json', {});
    return {
      ...delivery,
      remote_status: delivery.status === 'merged' ? 'merged' : delivery.status === 'submitted' ? payload.state || 'open' : delivery.status,
      blocked_reason: delivery.status === 'blocked' ? payload.error_code || 'github_delivery_failed' : null,
      pull_number: payload.pull_number || null,
      head_sha: payload.head_sha || null,
      merge_sha: payload.merge_sha || null,
      branch: payload.branch || null
    };
  }

  async submitDelivery(delivery, ctx = {}) {
    const execution = delivery.execution_id ? await this.db.get('SELECT * FROM executions WHERE id=?', [delivery.execution_id]) : null;
    assert(execution?.status === 'completed', 'invalid_state', 'delivery execution must be completed', { status: 409 });
    const diff = await this.db.get('SELECT diff,diff_sha256 FROM execution_diffs WHERE execution_id=?', [execution.id]);
    assert(diff, 'invalid_state', 'delivery requires captured execution evidence', { status: 409 });
    try {
      const submitted = await this.github.submitDraft({
        projectId: delivery.project_id, deliveryId: delivery.id, baselineSha: execution.repository_sha,
        diff: diff.diff, title: delivery.title, body: delivery.body
      });
      await this.db.transaction([
        { sql: 'UPDATE deliveries SET status=\'submitted\',external_ref=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [submitted.url, now(), delivery.id, delivery.revision], expect_changes: 1 },
        auditStatement('delivery.submitted', 'delivery', delivery.id, { pull_number: submitted.number, url: submitted.url, state: submitted.state, draft: submitted.draft, head_sha: submitted.head_sha, base_branch: submitted.base_branch, branch: submitted.branch }, ctx.actor)
      ]);
    } catch (error) {
      const code = String(error?.code || 'github_delivery_failed').slice(0, 120);
      await this.db.transaction([
        { sql: 'UPDATE deliveries SET status=\'blocked\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), delivery.id, delivery.revision], expect_changes: 1 },
        auditStatement('delivery.blocked', 'delivery', delivery.id, { error_code: code, phase: 'submit' }, ctx.actor)
      ]).catch((transactionError) => { if (!isTransactionPrecondition(transactionError)) throw transactionError; });
    }
    return this.deliveryView(await this.db.get('SELECT * FROM deliveries WHERE id=?', [delivery.id]));
  }

  async retryDelivery(deliveryId, input = {}, ctx = {}) {
    const delivery = await this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
    if (!delivery) throw new AppError('not_found', 'delivery not found');
    const expected = Number(input.expected_revision ?? delivery.revision);
    if (expected !== delivery.revision) throw new AppError('revision_conflict', 'delivery revision has changed', { status: 409 });
    assert(['blocked', 'draft', 'submitted'].includes(delivery.status), 'invalid_state', 'delivery is not retryable', { status: 409 });
    if (delivery.status === 'submitted') return this.deliveryView(delivery);
    const blocked = await this.db.get("SELECT payload_json FROM audit_events WHERE entity_type='delivery' AND entity_id=? AND action='delivery.blocked' ORDER BY created_at DESC LIMIT 1", [deliveryId]);
    const blockedPayload = rowJson(blocked, 'payload_json', {});
    if (blockedPayload.phase === 'merge') return this.mergeDelivery(deliveryId, { ...input, review_id: input.review_id || blockedPayload.review_id }, ctx);
    return this.submitDelivery(delivery, ctx);
  }

  async mergeDelivery(deliveryId, input, ctx = {}) {
    const delivery = await this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
    if (!delivery) throw new AppError('not_found', 'delivery not found');
    const expected = Number(input?.expected_revision ?? delivery.revision);
    if (expected !== delivery.revision) throw new AppError('revision_conflict', 'delivery revision has changed', { status: 409, details: { expected_revision: expected } });
    assert(input?.review_id, 'review_required', 'a separate merge review is required', { status: 409 });
    const review = await this.getReview(input.review_id);
    assert(review.project_id === delivery.project_id && review.execution_id === delivery.execution_id && review.kind === 'delivery_merge' && review.decision?.decision === 'approved', 'review_required', 'an approved merge review for this execution is required', { status: 409 });
    if (this.github?.configured) {
      const metadata = await this.db.get("SELECT payload_json FROM audit_events WHERE entity_type='delivery' AND entity_id=? AND action='delivery.submitted' ORDER BY created_at DESC LIMIT 1", [deliveryId]);
      const submitted = rowJson(metadata, 'payload_json', {});
      assert(submitted.pull_number && submitted.head_sha, 'invalid_state', 'submitted pull request metadata is missing', { status: 409 });
      const repository = await this.db.get('SELECT * FROM repository_bindings WHERE id=?', [delivery.repository_binding_id]);
      let remoteMerged = null;
      try {
        remoteMerged = await this.github.merge({ pullNumber: submitted.pull_number, expectedHeadSha: submitted.head_sha, branch: submitted.branch });
        const repositoryRoot = resolveWorkspacePath(this.config.home, repository.local_path);
        await this.github.fastForwardLocal(repositoryRoot, remoteMerged.base_branch, remoteMerged.base_sha);
        await this.db.transaction([
          { sql: 'UPDATE repository_bindings SET head_sha=?,revision=revision+1,updated_at=? WHERE id=? AND head_sha=?', params: [remoteMerged.base_sha, now(), repository.id, repository.head_sha], expect_changes: 1 },
          { sql: 'UPDATE deliveries SET status=\'merged\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), deliveryId, delivery.revision], expect_changes: 1 },
          auditStatement('delivery.merged', 'delivery', deliveryId, { review_id: input.review_id, pull_number: submitted.pull_number, merge_sha: remoteMerged.merge_sha, head_sha: submitted.head_sha, branch: submitted.branch }, ctx.actor)
        ]);
      } catch (error) {
        const code = String(error?.code || 'github_merge_failed').slice(0, 120);
        await this.db.transaction([
          { sql: 'UPDATE deliveries SET status=\'blocked\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), deliveryId, delivery.revision], expect_changes: 1 },
          auditStatement('delivery.blocked', 'delivery', deliveryId, { error_code: code, phase: 'merge', review_id: input.review_id, pull_number: submitted.pull_number, head_sha: submitted.head_sha, branch: submitted.branch, remote_merge_sha: remoteMerged?.merge_sha || null, remote_base_sha: remoteMerged?.base_sha || null, remote_base_branch: remoteMerged?.base_branch || null }, ctx.actor)
        ]).catch((transactionError) => { if (!isTransactionPrecondition(transactionError)) throw transactionError; });
      }
      return this.deliveryView(await this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]));
    }
    try {
      await this.db.transaction([
        { sql: 'UPDATE deliveries SET status=\'merged\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), deliveryId, delivery.revision], expect_changes: 1 },
        auditStatement('delivery.merged', 'delivery', deliveryId, { review_id: input.review_id }, ctx.actor)
      ]);
    } catch (error) {
      if (!isTransactionPrecondition(error)) throw error;
      throw new AppError('revision_conflict', 'delivery revision has changed');
    }
    return this.deliveryView(await this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]));
  }

  async listDeliveries(projectId) {
    const rows = projectId ? await this.db.query('SELECT * FROM deliveries WHERE project_id=? ORDER BY created_at DESC', [projectId]) : await this.db.query('SELECT * FROM deliveries ORDER BY created_at DESC');
    return Promise.all(rows.map((row) => this.deliveryView(row)));
  }

  async listAudit(limit = 100) {
    return this.db.query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?', [Math.min(Math.max(Number(limit) || 100, 1), 500)]);
  }

  async gitDiff(projectId) {
    await this.requireProject(projectId);
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]);
    if (!repository) throw new AppError('not_found', 'repository binding not found');
    const repositoryRoot = resolveWorkspacePath(this.config.home, repository.local_path);
    if (!fs.existsSync(path.join(repositoryRoot, '.git'))) {
      return { project_id: projectId, repository_sha: repository.head_sha, files: [], diff: '', diff_bytes: 0, diff_sha256: sha256('') };
    }
    try {
      const captured = await captureDiff(repositoryRoot, 'HEAD');
      const diff = redactText(captured.diff, [this.config.codexCredential?.auth, this.config.githubCredential?.token]);
      return { project_id: projectId, repository_sha: repository.head_sha, files: captured.files, diff, diff_bytes: Buffer.byteLength(diff), diff_sha256: sha256(diff) };
    } catch (error) {
      throw new AppError(error?.code || 'git_diff_failed', 'failed to read repository diff', { status: 422, details: error?.details || {} });
    }
  }

  async captureExecutionEvidence(executionId, { terminalStatus = null } = {}) {
    const capture = await this.evidence.prepareCapture(executionId, { terminalStatus });
    if (capture.kind === 'missing') return null;
    if (capture.kind === 'existing') {
      if (capture.statements.length) await this.db.transaction(capture.statements);
      return capture.existing;
    }
    try {
      await this.db.transaction(capture.statements);
      return this.db.get('SELECT * FROM execution_diffs WHERE execution_id=?', [executionId]);
    } catch (error) {
      await this.cleanupPreparedAssets(capture.prepared);
      if (error instanceof DiffCaptureError || isTransactionPrecondition(error)) throw error;
      throw this.evidence.normalizeCommitError(error);
    }
  }

  async executionDiff(executionId) {
    return this.evidence.executionDiff(executionId);
  }

  async executionEvidence(executionId) {
    return this.evidence.executionEvidence(executionId);
  }

  async resolveEvidence(executionId, input = {}, ctx = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const expected = Number(input.expected_revision);
    assert(Number.isInteger(expected) && expected === execution.revision, 'revision_conflict', 'execution revision has changed', { status: 409, details: { expected_revision: expected } });
    assert(['retry_capture', 'discard_worktree'].includes(input.action), 'invalid_input', 'evidence resolve action is invalid');
    const failure = await this.db.get("SELECT action,payload_json FROM audit_events WHERE entity_type='execution' AND entity_id=? AND action IN ('execution.evidence_failed','execution.evidence_resolved') ORDER BY created_at DESC,rowid DESC LIMIT 1", [executionId]);
    assert(failure?.action === 'execution.evidence_failed', 'invalid_state', 'execution has no evidence failure to resolve', { status: 409 });
    const failurePayload = rowJson(failure, 'payload_json', {});
    if (input.action === 'retry_capture') {
      const planned = ['completed', 'failed', 'cancelled'].includes(failurePayload.planned_status) ? failurePayload.planned_status : 'failed';
      try {
        await this.captureExecutionEvidence(executionId, { terminalStatus: planned });
      } catch (error) {
        await this.markEvidenceFailure(executionId, error, planned);
        throw new AppError(String(error?.code || 'evidence_capture_failed'), 'evidence capture retry failed', { status: 422, retryable: true });
      }
      await this.cleanupExecutionWorkspace(executionId, { capture: false });
      await this.db.transaction([
        auditStatement('execution.evidence_resolved', 'execution', executionId, { action: 'retry_capture', restored_status: planned }, ctx.actor),
        eventStatement('execution.evidence_resolved', executionId, null, { action: 'retry_capture', restored_status: planned })
      ]);
      await this.emitExecutionEvents(executionId);
      return this.getExecution(executionId);
    }
    let errorReport = null;
    try {
      errorReport = await this.prepareAsset(execution.project_id, {
        name: `evidence/${executionId}-capture-error.json`, media_type: 'application/json',
        content: JSON.stringify({ execution_id: executionId, error_code: failurePayload.error_code || 'evidence_capture_failed', planned_status: failurePayload.planned_status || 'failed' })
      });
      await this.db.transaction([
        ...this.assetInsertStatement(errorReport, 'runner'),
        { sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, errorReport.id, 'execution', executionId, now()] },
        { sql: 'UPDATE executions SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), executionId, execution.revision], expect_changes: 1 },
        auditStatement('execution.evidence_resolved', 'execution', executionId, { action: 'discard_worktree', error_code: failurePayload.error_code || 'evidence_capture_failed' }, ctx.actor),
        eventStatement('execution.evidence_resolved', executionId, null, { action: 'discard_worktree' })
      ]);
    } catch (error) {
      if (errorReport) await this.cleanupPreparedAssets([errorReport]);
      if (!isTransactionPrecondition(error)) await this.cleanupExecutionWorkspace(executionId, { capture: false }).catch(() => undefined);
      throw error;
    }
    await this.cleanupExecutionWorkspace(executionId, { capture: false });
    await this.emitExecutionEvents(executionId);
    return this.getExecution(executionId);
  }

  async events(executionId, cursor = 0) {
    const rows = await this.db.query('SELECT cursor,type,execution_id,task_id,data_json,created_at FROM events WHERE execution_id=? AND cursor>? ORDER BY cursor LIMIT 500', [executionId, Number(cursor) || 0]);
    return rows.map((row) => ({ cursor: row.cursor, type: row.type, execution_id: row.execution_id, task_id: row.task_id, data: rowJson(row, 'data_json', {}), created_at: row.created_at }));
  }

  async capabilities() {
    return this.integrationProbes.capabilities();
  }

  async probeCodex({ force = false } = {}) {
    return this.integrationProbes.probeCodex({ force });
  }

  async probeGithub({ force = false } = {}) {
    return this.integrationProbes.probeGithub({ force });
  }

  async health() {
    const sqlite = await this.db.integrity().catch((error) => ({ integrity: ['error'], error: error.message }));
    const capabilities = await this.capabilities();
    return { sqlite, broker: capabilities.broker, runner_digest: this.config.runnerDigest };
  }

  async recover() {
    this.stopping = false;
    await this.identityService.initialize();
    await this.setupService.initialize();
    await this.projectService.recover();
    await this.operationService.recover();
    await this.repositoryService.recoverInterrupted();
    await this.terminals.recover();
    const pendingProjections = await this.db.query("SELECT id,project_id FROM context_projection_jobs WHERE status IN ('pending','running') ORDER BY created_at,id");
    for (const job of pendingProjections) {
      await this.withRepositoryLock(`context:${job.project_id}`, () => this.runContextProjection(job.id, job.project_id, { actor: 'system-recovery' })).catch(() => undefined);
    }
    const committedResiduals = await this.db.query(`SELECT e.id FROM executions e
      JOIN execution_diffs d ON d.execution_id=e.id
      LEFT JOIN repository_worktrees w ON w.execution_id=e.id
      WHERE e.status IN ('completed','failed','cancelled') AND (w.execution_id IS NULL OR w.removed_at IS NULL)`);
    for (const residual of committedResiduals) await this.cleanupExecutionWorkspace(residual.id, { capture: false });
    const running = await this.db.query("SELECT id FROM executions WHERE status='running'");
    for (const execution of running) {
      const row = await this.db.get('SELECT project_id,workflow_revision FROM executions WHERE id=?', [execution.id]);
      const [repository, workflow, attempts] = await Promise.all([
        this.db.get('SELECT local_path FROM repository_bindings WHERE project_id=?', [row.project_id]),
        this.db.get('SELECT tasks_json FROM workflow_revisions WHERE project_id=? AND revision=?', [row.project_id, row.workflow_revision]),
        this.db.query("SELECT id,task_id FROM task_attempts WHERE execution_id=? AND status='running'", [execution.id])
      ]);
      const taskDefinitions = rowJson(workflow, 'tasks_json', []);
      for (const attempt of attempts) this.reserveAttempt(attempt.id, repository?.local_path || row.project_id, taskDefinitions.find((task) => task.id === attempt.task_id)?.mode || 'read');
      const retryAudit = await this.db.get("SELECT payload_json FROM audit_events WHERE entity_type='execution' AND entity_id=? AND action='execution.human_retry_requested' ORDER BY created_at DESC LIMIT 1", [execution.id]);
      const retryInstruction = rowJson(retryAudit, 'payload_json', {}).instruction || '';
      void this.driveExecution(execution.id, 'recovery', retryInstruction);
    }
    return running.length;
  }

  async requireProject(projectId) {
    const project = await this.db.get('SELECT id FROM projects WHERE id=?', [projectId]);
    if (!project) throw new AppError('not_found', 'project not found');
    return project;
  }

  async confirmedBrief(projectId) {
    return this.db.get(`SELECT brief.* FROM projects project
      JOIN brief_revisions brief ON brief.project_id=project.id AND brief.revision=project.confirmed_brief_revision
      WHERE project.id=?`, [projectId]);
  }

  async driveExecution(executionId, mode, instruction = '') {
    if (this.stopping || this.driving.has(executionId)) return;
    this.driving.add(executionId);
    const deadline = Date.now() + Number(this.config.schedulerDeadlineMs || 10 * 60 * 1000);
    try {
      while (!this.stopping && Date.now() < deadline) {
        const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
        if (!execution || ['completed', 'cancelled'].includes(execution.status)) break;
        const workflow = await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? AND revision=?', [execution.project_id, execution.workflow_revision]);
        const brief = await this.db.get('SELECT content_json FROM brief_revisions WHERE project_id=? AND revision=?', [execution.project_id, execution.brief_revision]);
        const contextPack = execution.context_pack_id ? await this.db.get('SELECT pack_json FROM context_packs WHERE id=?', [execution.context_pack_id]) : null;
        const repository = await this.db.get('SELECT local_path,head_sha FROM repository_bindings WHERE project_id=?', [execution.project_id]);
        const worktree = await this.db.get('SELECT worktree_path,baseline_sha FROM repository_worktrees WHERE execution_id=?', [executionId]);
        const inputSubpath = `inputs/${execution.project_id}/${execution.id}`;
        const tasks = rowJson(workflow, 'tasks_json', []);
        const attempts = await this.db.query('SELECT * FROM task_attempts WHERE execution_id=? ORDER BY task_id,attempt_no', [executionId]);
        const latest = new Map();
        for (const attempt of attempts) {
          if (!latest.has(attempt.task_id) || latest.get(attempt.task_id).attempt_no < attempt.attempt_no) latest.set(attempt.task_id, attempt);
        }
        if (tasks.length && tasks.every((task) => latest.get(task.id)?.status === 'completed')) {
          await this.finishExecution(executionId, 'completed');
          break;
        }
        const humanContinuation = mode === 'human_retry' || mode === 'recovery';
        if (!humanContinuation && [...latest.values()].some((attempt) => attempt.status === 'awaiting_human')) {
          await this.finishExecution(executionId, 'awaiting_human');
          break;
        }
        const repositoryKey = repository?.local_path || execution.project_id;
        const workspaceSubpath = worktree?.worktree_path || repository?.local_path || `projects/${execution.project_id}`;
        for (const task of tasks) {
          const current = latest.get(task.id);
          if (!current || !['pending', 'failed', ...(humanContinuation ? ['awaiting_human'] : [])].includes(current.status)) continue;
          const depsComplete = task.deps.every((dep) => latest.get(dep)?.status === 'completed');
          if (!depsComplete) continue;
          if (!this.canReserve(repositoryKey, task.mode)) continue;
          const retrying = current.status === 'failed' || current.status === 'awaiting_human';
          const nextAttempt = retrying ? current.attempt_no + 1 : current.attempt_no;
          const attemptMode = retrying ? (current.status === 'failed' && current.attempt_no === 1 ? 'auto_correct' : mode === 'human_retry' || mode === 'recovery' ? 'human_retry' : 'initial') : 'initial';
          const attemptId = retrying ? id('att') : current.id;
          const timestamp = now();
          this.reserveAttempt(attemptId, repositoryKey, task.mode);
          let job;
          try {
            await this.db.transaction([
              retrying
                ? { sql: 'INSERT INTO task_attempts(id,execution_id,task_id,attempt_no,status,mode,started_at,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [attemptId, executionId, task.id, nextAttempt, 'ready', attemptMode, timestamp, timestamp] }
                : { sql: 'UPDATE task_attempts SET status=\'ready\',mode=?,started_at=? WHERE id=? AND status=\'pending\'', params: [attemptMode, timestamp, attemptId], expect_changes: 1 },
              eventStatement('task.ready', executionId, task.id, { attempt: nextAttempt, mode: attemptMode })
            ]);
            const previousOutput = rowJson(current, 'output_json', {});
            const priorChecks = Array.isArray(previousOutput.checks) ? previousOutput.checks.filter((check) => !check.passed).map((check) => ({ id: check.id, exit_code: check.exit_code })) : [];
            const retryContext = retrying ? {
              prior_error_code: current.error_code || 'runner_failed',
              failed_checks: priorChecks,
              security_summary: 'credentials are redacted from retry context',
              instruction: String(instruction || this.retryInstructions.get(executionId) || '').slice(0, 2000)
            } : null;
            const activeProfile = await this.setupService.activeProfileSnapshot({ includeSecret: true });
            const profileEnvelope = activeProfile ? Object.fromEntries(Object.entries(activeProfile).filter(([key]) => key !== 'secret')) : null;
            const jobSpec = {
              task_id: task.id,
              execution_id: executionId,
              project_id: execution.project_id,
              workspace_subpath: workspaceSubpath,
              worktree_subpath: worktree?.worktree_path || null,
              baseline_sha: worktree?.baseline_sha || execution.repository_sha || null,
              output_subpath: `projects/${execution.project_id}/outputs/${executionId}`,
              input_subpath: inputSubpath,
              model: activeProfile?.model || this.config.codexModel || 'gpt-5.5',
              image_digest: this.config.runnerDigest,
              execution_mode: task.mode === 'write' ? 'write' : 'read',
              resource_profile: 'standard',
              network_profile: activeProfile ? 'model' : 'none',
              credential_ref: activeProfile?.credential_ref || null,
              profile_id: activeProfile?.profile_id || null,
              profile_revision: activeProfile?.profile_revision || null,
              profile_hash: activeProfile?.profile_hash || null,
              bundle: {
                objective: `${task.title}${rowJson(brief, 'content_json', {}).objective ? `\nProject objective: ${rowJson(brief, 'content_json', {}).objective}` : ''}`,
                acceptance: Array.isArray(rowJson(brief, 'content_json', {}).acceptance) ? rowJson(brief, 'content_json', {}).acceptance : [],
                context_pack: rowJson(contextPack, 'pack_json', null),
                context_pack_id: execution.context_pack_id || null,
                input_assets: rowJson(execution, 'input_assets_json', []),
                output_paths: task.outputs,
                checks: ['node_test', 'git_diff_check'],
                retry_context: retryContext,
                input_paths: task.inputs,
                prior_outputs_root: `/outputs`
              },
              input_paths: task.inputs,
              output_paths: task.outputs,
              deadline_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
            };
            job = await this.broker.submit(jobSpec, {
              profile: profileEnvelope,
              credential: activeProfile ? {
                ref: activeProfile.credential_ref,
                kind: activeProfile.auth_kind === 'oauth_bundle' ? 'codex_oauth_bundle' : 'codex_api_key',
                revision: activeProfile.credential_revision,
                auth: activeProfile.secret
              } : null
            });
            await this.db.transaction([
              { sql: 'UPDATE task_attempts SET status=\'running\',broker_job_id=? WHERE id=? AND status=\'ready\'', params: [job.job_id, attemptId], expect_changes: 1 },
              eventStatement('task.running', executionId, task.id, { attempt: nextAttempt, broker_job_id: job.job_id })
            ]);
          } catch (error) {
            if (job?.job_id) await this.broker.cancel(job.job_id).catch(() => undefined);
            this.releaseAttempt(attemptId);
            await this.failAttempt(attemptId, executionId, task.id, error.code || 'broker_unavailable', { outcome: 'failed', summary: error.code || 'broker_unavailable' });
          }
        }
        const runningRows = await this.db.query("SELECT * FROM task_attempts WHERE execution_id=? AND status='running'", [executionId]);
        let observed = false;
        for (const attempt of runningRows) {
          const job = await this.broker.status(attempt.broker_job_id).catch(() => ({ status: 'unknown' }));
          if (!TERMINAL_JOB_STATUSES.has(job.status)) continue;
          observed = true;
          if (job.status === 'completed' && job.result?.outcome !== 'failed') await this.completeAttempt(attempt, job);
          else if (job.status === 'unknown') await this.failAttempt(attempt.id, executionId, attempt.task_id, 'broker_job_unknown', { outcome: 'failed', summary: 'Runner job state was lost; retrying is safe', retryable: true });
          else await this.failAttempt(attempt.id, executionId, attempt.task_id, job.status === 'cancelled' ? 'cancelled' : job.result?.error_code || 'runner_failed', job.result);
        }
        if (!observed && runningRows.length === 0) await new Promise((resolve) => setTimeout(resolve, 40));
        else await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!this.stopping && Date.now() >= deadline) {
        const running = await this.db.query("SELECT id,task_id,broker_job_id FROM task_attempts WHERE execution_id=? AND status IN ('ready','running')", [executionId]);
        for (const attempt of running) {
          if (attempt.broker_job_id) await this.broker.cancel(attempt.broker_job_id).catch(() => undefined);
          this.releaseAttempt(attempt.id);
        }
        await this.db.transaction([
          { sql: "UPDATE task_attempts SET status='failed',error_code='scheduling_deadline_exceeded',finished_at=? WHERE execution_id=? AND status IN ('pending','ready','running','failed','awaiting_human')", params: [now(), executionId] },
          eventStatement('execution.deadline_exceeded', executionId, null, { error_code: 'scheduling_deadline_exceeded' })
        ]);
        await this.finishExecution(executionId, 'failed');
      }
    } finally {
      this.driving.delete(executionId);
    }
  }

  async completeAttempt(attempt, job) {
    this.releaseAttempt(attempt.id);
    try {
      const raw = job.result && typeof job.result === 'object' ? job.result : {};
      const safe = safeRunnerResult(raw.outcome ? raw : { ...raw, outcome: 'completed' }, [this.config.codexCredential?.auth, this.config.githubCredential?.token]);
      await this.db.transaction([
        { sql: 'UPDATE task_attempts SET status=\'completed\',output_json=?,finished_at=? WHERE id=? AND status=\'running\'', params: [asJson(safe), now(), attempt.id], expect_changes: 1 },
        ...safe.events.map((event) => eventStatement(event.type, attempt.execution_id, attempt.task_id, { attempt: attempt.attempt_no, phase: event.phase, exit_code: event.exit_code, file_count: event.file_count, summary: event.summary, summary_sha256: event.summary_sha256 })),
        eventStatement('task.completed', attempt.execution_id, attempt.task_id, { attempt: attempt.attempt_no })
      ]);
    } catch (error) {
      if (isTransactionPrecondition(error)) return;
      throw error;
    }
    await this.emitExecutionEvents(attempt.execution_id);
  }

  async failAttempt(attemptId, executionId, taskId, errorCode, result = null) {
    this.releaseAttempt(attemptId);
    const attempt = await this.db.get('SELECT * FROM task_attempts WHERE id=?', [attemptId]);
    if (!attempt || !['ready', 'running'].includes(attempt.status)) return;
    const terminal = attempt.attempt_no >= 2;
    const normalizedErrorCode = RUNNER_RESULT_ERRORS.has(String(errorCode || '')) ? String(errorCode) : 'runner_failed';
    const nextStatus = terminal ? 'awaiting_human' : 'failed';
    const safe = safeRunnerResult(result || { outcome: 'failed', error_code: normalizedErrorCode, summary: normalizedErrorCode }, [this.config.codexCredential?.auth, this.config.githubCredential?.token]);
    try {
      await this.db.transaction([
        { sql: 'UPDATE task_attempts SET status=?,error_code=?,output_json=?,finished_at=? WHERE id=? AND status IN (\'ready\',\'running\')', params: [nextStatus, normalizedErrorCode, asJson(safe), now(), attemptId], expect_changes: 1 },
        eventStatement(terminal ? 'task.awaiting_human' : 'task.failed', executionId, taskId, { attempt: attempt.attempt_no, error_code: normalizedErrorCode, summary: safe.summary })
      ]);
    } catch (error) {
      if (isTransactionPrecondition(error)) return;
      throw error;
    }
    await this.emitExecutionEvents(executionId);
  }

  async cleanupExecutionWorkspace(executionId, { capture = false } = {}) {
    if (capture) await this.captureExecutionEvidence(executionId);
    const worktree = await this.db.get('SELECT * FROM repository_worktrees WHERE execution_id=?', [executionId]);
    if (worktree && !worktree.removed_at) {
      const repository = await this.db.get('SELECT local_path FROM repository_bindings WHERE project_id=?', [worktree.project_id]);
      const worktreeRoot = resolveWorkspacePath(this.config.home, worktree.worktree_path);
      if (repository) await removeWorktree(resolveWorkspacePath(this.config.home, repository.local_path), worktreeRoot).catch(() => undefined);
      if (!fs.existsSync(worktreeRoot)) await this.db.run('UPDATE repository_worktrees SET removed_at=? WHERE execution_id=?', [now(), executionId]).catch(() => undefined);
    }
    const execution = await this.db.get('SELECT project_id FROM executions WHERE id=?', [executionId]);
    if (execution) {
      const outputRoot = resolveWorkspacePath(this.config.home, `projects/${execution.project_id}/outputs/${executionId}`);
      fs.rmSync(outputRoot, { recursive: true, force: true });
      removeExecutionInputs(this.config, execution.project_id, executionId);
    }
  }

  async recordMinimalEvidenceError(executionId, error, outcome, actor = 'local-user') {
    const execution = await this.db.get('SELECT project_id FROM executions WHERE id=?', [executionId]);
    if (!execution) return;
    const errorCode = String(error?.code || 'evidence_capture_failed').slice(0, 120);
    let report = null;
    try {
      report = await this.prepareAsset(execution.project_id, {
        name: `evidence/${executionId}-${outcome}-error.json`, media_type: 'application/json',
        content: JSON.stringify({ execution_id: executionId, outcome, error_code: errorCode, checks: [] })
      });
      await this.db.transaction([
        ...this.assetInsertStatement(report, 'runner'),
        { sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, report.id, 'execution', executionId, now()] },
        auditStatement(`execution.${outcome}_evidence_error`, 'execution', executionId, { error_code: errorCode }, actor)
      ]);
    } catch {
      if (report) await this.cleanupPreparedAssets([report]);
      await this.db.run('INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', [id('aud'), actor || 'local-user', `execution.${outcome}_evidence_error`, 'execution', executionId, asJson({ error_code: errorCode }), now()]).catch(() => undefined);
    }
  }

  async markEvidenceFailure(executionId, error, plannedStatus = 'failed') {
    const code = String(error?.code || 'evidence_capture_failed').slice(0, 120);
    const details = error?.details || {};
    const current = await this.db.get('SELECT status,revision FROM executions WHERE id=?', [executionId]);
    if (!current || ['completed', 'cancelled'].includes(current.status)) return;
    await this.db.transaction([
      { sql: 'UPDATE executions SET status=\'failed\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), executionId, current.revision], expect_changes: 1 },
      eventStatement('execution.failed', executionId, null, { error_code: code, evidence_status: 'failed', planned_status: plannedStatus, details }),
      auditStatement('execution.evidence_failed', 'execution', executionId, { error_code: code, planned_status: plannedStatus, details })
    ]).catch((transactionError) => { if (!isTransactionPrecondition(transactionError)) throw transactionError; });
    await this.emitExecutionEvents(executionId);
  }

  async finishExecution(executionId, status) {
    const execution = await this.db.get('SELECT project_id FROM executions WHERE id=?', [executionId]);
    if (!execution) return;
    if (status !== 'awaiting_human' && ['completed', 'failed'].includes(status)) {
      try {
        await this.captureExecutionEvidence(executionId, { terminalStatus: status });
      } catch (error) {
        await this.markEvidenceFailure(executionId, error, status);
        return;
      }
      // The database terminal state is committed before removing host files.
      await this.cleanupExecutionWorkspace(executionId, { capture: false });
      await this.emitExecutionEvents(executionId);
      return;
    }
    if (status === 'cancelled') {
      try { await this.captureExecutionEvidence(executionId, { terminalStatus: 'cancelled' }); }
      catch (error) {
        await this.db.transaction([
          { sql: 'UPDATE executions SET status=\'cancelled\',revision=revision+1,updated_at=? WHERE id=? AND status=?', params: [now(), executionId, execution.status], expect_changes: 1 },
          eventStatement('execution.cancelled', executionId, null, { error_code: String(error?.code || 'evidence_capture_failed').slice(0, 120) }),
          auditStatement('execution.cancelled', 'execution', executionId, { error_code: String(error?.code || 'evidence_capture_failed').slice(0, 120) })
        ]).catch((transactionError) => { if (!isTransactionPrecondition(transactionError)) throw transactionError; });
        await this.recordMinimalEvidenceError(executionId, error, 'cancelled');
      }
      await this.cleanupExecutionWorkspace(executionId, { capture: false });
      await this.emitExecutionEvents(executionId);
      return;
    }
    try {
      await this.db.transaction([
        { sql: 'UPDATE executions SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status=\'running\'', params: [status, now(), executionId], expect_changes: 1 },
        eventStatement(`execution.${status}`, executionId, null, {})
      ]);
    } catch (error) {
      if (isTransactionPrecondition(error)) return;
      throw error;
    }
    await this.emitExecutionEvents(executionId);
  }

  async emitExecutionEvents(executionId) {
    const rows = await this.events(executionId, 0);
    for (const event of rows.slice(-10)) this.emit(event);
  }

  canReserve(repositoryKey, mode) {
    const active = [...this.activeJobs.values()].filter((entry) => entry.repositoryKey === repositoryKey);
    if (mode === 'write') return active.length === 0;
    return !active.some((entry) => entry.mode === 'write') && active.filter((entry) => entry.mode !== 'write').length < 2;
  }

  reserveAttempt(attemptId, repositoryKey, mode) {
    this.activeJobs.set(attemptId, { repositoryKey, mode });
  }

  releaseAttempt(attemptId) {
    this.activeJobs.delete(attemptId);
  }

  async shutdown() {
    this.stopping = true;
    await this.terminals.shutdown();
    const running = await this.db.query("SELECT id,broker_job_id FROM task_attempts WHERE status IN ('ready','running')").catch(() => []);
    await Promise.all(running.map(async (attempt) => {
      if (attempt.broker_job_id) await this.broker.cancel(attempt.broker_job_id).catch(() => undefined);
      this.releaseAttempt(attempt.id);
    }));
    const deadline = Date.now() + 5_000;
    while (this.driving.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
