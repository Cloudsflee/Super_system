import fs from 'node:fs';
import path from 'node:path';
import { asJson, hashJson, id, now, parseJson, sha256 } from './crypto.mjs';
import { AppError, assert } from './errors.mjs';
import { assertReviewablePath, normalizeRelativePath, resolveWorkspacePath } from './path-policy.mjs';
import { MODEL_SUGGESTION_STATUSES } from '../../../packages/contracts/src/index.mjs';
import { DIFF_MAX_BYTES, DiffCaptureError, captureDiff, createWorktree, ensureExecutionExcludes, gitHead, gitStatus, initializeFixture, removeWorktree } from './git-fixture.mjs';
import { removeExecutionInputs, stageExecutionInputs } from './input-staging.mjs';
import { EvidenceService } from './evidence-service.mjs';
import { CODEX_ERROR_CODES, IntegrationProbeService } from './integration-probes.mjs';

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
  return row ? { ...row, tasks: rowJson(row, 'tasks_json', []) } : null;
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
  constructor({ db, config, broker, github = null, evidence = null, integrationProbes = null, emit = () => undefined }) {
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
    this.evidence = evidence || new EvidenceService({
      db,
      config,
      prepareAsset: (projectId, input) => this.prepareAsset(projectId, input),
      assetInsertStatements: (asset, actor) => this.assetInsertStatement(asset, actor),
      cleanupPreparedAssets: (assets) => this.cleanupPreparedAssets(assets),
      sanitizeRunnerResult: safeRunnerResult
    });
    this.integrationProbes = integrationProbes || new IntegrationProbeService({ config, broker, github });
  }

  async listProjects() {
    const rows = await this.db.query('SELECT * FROM projects ORDER BY updated_at DESC');
    return rows.map(projectView);
  }

  async getProject(projectId) {
    const project = await this.db.get('SELECT * FROM projects WHERE id=?', [projectId]);
    if (!project) throw new AppError('not_found', 'project not found');
    const [brief, workflow, repository, executions] = await Promise.all([
      this.db.get('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]),
      this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]),
      this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]),
      this.db.query('SELECT * FROM executions WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId])
    ]);
    const executionViews = await Promise.all(executions.map((execution) => this.getExecution(execution.id, { includeEvidence: false })));
    return {
      ...projectView(project),
      brief: briefView(brief),
      workflow: workflowView(workflow),
      repository: repository ? {
        ...repository,
        source: repository.remote_url.startsWith('fixture://')
          ? { kind: 'fixture', id: repository.remote_url.slice('fixture://'.length) }
          : null
      } : null,
      executions: executionViews
    };
  }

  async createProject(input, ctx = {}) {
    const name = String(input?.name || '').trim();
    assert(name.length > 0, 'invalid_input', 'project name is required');
    const projectId = id('prj');
    const repositoryId = id('repo');
    const timestamp = now();
    const source = input?.repository?.source;
    if (source != null) {
      assert(source && typeof source === 'object' && !Array.isArray(source) && source.kind === 'fixture' && source.id === 'designsignal-v1', 'invalid_input', 'repository source is not supported', { status: 422 });
      assert(Object.keys(source).every((key) => key === 'kind' || key === 'id'), 'invalid_input', 'repository source contains unsupported fields', { status: 422 });
    }
    const localPath = source?.kind === 'fixture'
      ? `projects/${projectId}`
      : input?.repository?.local_path
        ? normalizeRelativePath(input.repository.local_path)
        : `projects/${projectId}`;
    const workspacePath = resolveWorkspacePath(this.config.home, localPath);
    fs.mkdirSync(workspacePath, { recursive: true, mode: 0o770 });
    grantRunnerPath(workspacePath, { directory: true });
    let headSha = '';
    if (source?.kind === 'fixture') {
      headSha = await initializeFixture(workspacePath, source.id);
    } else {
      headSha = await gitHead(workspacePath);
    }
    const statements = [
      { sql: 'INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: [projectId, name, String(input.description || ''), 'active', 1, timestamp, timestamp] },
      { sql: 'INSERT INTO repository_bindings(id,project_id,local_path,remote_url,head_sha,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', params: [repositoryId, projectId, localPath, source?.kind === 'fixture' ? `fixture://${source.id}` : String(input?.repository?.remote_url || ''), headSha, 1, timestamp, timestamp] },
      auditStatement('project.created', 'project', projectId, { name }, ctx.actor)
    ];
    await this.db.transaction(statements);
    return this.getProject(projectId);
  }

  async updateProject(projectId, input, ctx = {}) {
    const expected = Number(input?.expected_revision);
    assert(Number.isInteger(expected) && expected > 0, 'invalid_input', 'expected_revision is required');
    const timestamp = now();
    try {
      await this.db.transaction([
        { sql: 'UPDATE projects SET name=COALESCE(?,name), description=COALESCE(?,description), revision=revision+1, updated_at=? WHERE id=? AND revision=?', params: [input.name == null ? null : String(input.name).trim(), input.description == null ? null : String(input.description), timestamp, projectId, expected], expect_changes: 1 },
        auditStatement('project.updated', 'project', projectId, { expected_revision: expected }, ctx.actor)
      ]);
    } catch (error) {
      if (!isTransactionPrecondition(error)) throw error;
      const exists = await this.db.get('SELECT id FROM projects WHERE id=?', [projectId]);
      if (!exists) throw new AppError('not_found', 'project not found');
      throw new AppError('revision_conflict', 'project revision has changed', { details: { expected_revision: expected } });
    }
    return this.getProject(projectId);
  }

  async listBriefs(projectId) {
    await this.requireProject(projectId);
    return (await this.db.query('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC', [projectId])).map(briefView);
  }

  async createBrief(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const content = input?.content && typeof input.content === 'object' ? input.content : {
      objective: String(input?.objective || ''),
      constraints: Array.isArray(input?.constraints) ? input.constraints : [],
      acceptance: Array.isArray(input?.acceptance) ? input.acceptance : []
    };
    assert(String(content.objective || '').trim().length > 0, 'invalid_input', 'brief objective is required');
    const revision = Number((await this.db.get('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM brief_revisions WHERE project_id=?', [projectId])).revision);
    const briefHash = hashJson(content);
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)', params: [projectId, revision, asJson(content), briefHash, timestamp] },
      { sql: 'INSERT INTO brief_heads(project_id,revision,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at', params: [projectId, revision, timestamp] },
      auditStatement('brief.created', 'project', projectId, { revision, brief_hash: briefHash }, ctx.actor)
    ]);
    return briefView(await this.db.get('SELECT * FROM brief_revisions WHERE project_id=? AND revision=?', [projectId, revision]));
  }

  async listWorkflows(projectId) {
    await this.requireProject(projectId);
    return (await this.db.query('SELECT * FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC', [projectId])).map(workflowView);
  }

  async createWorkflow(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const tasks = validateWorkflowTasks(input?.tasks);
    const revision = Number((await this.db.get('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM workflow_revisions WHERE project_id=?', [projectId])).revision);
    const graphHash = hashJson(tasks);
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO workflow_revisions(project_id,revision,name,tasks_json,graph_hash,created_at) VALUES(?,?,?,?,?,?)', params: [projectId, revision, String(input?.name || `Workflow ${revision}`).slice(0, 160), asJson(tasks), graphHash, timestamp] },
      { sql: 'INSERT INTO workflow_heads(project_id,revision,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at', params: [projectId, revision, timestamp] },
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

  async createContextPack(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const requested = Array.isArray(input?.source_ids) ? [...new Set(input.source_ids.map(String))] : [];
    const sources = requested.length
      ? await this.db.query(`SELECT * FROM context_sources WHERE project_id=? AND id IN (${requested.map(() => '?').join(',')})`, [projectId, ...requested])
      : await this.db.query('SELECT * FROM context_sources WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]);
    assert(sources.length > 0, 'invalid_input', 'context pack needs at least one source');
    assert(sources.length === requested.length || !requested.length, 'invalid_input', 'context source does not belong to project');
    const pack = {
      sources: sources.map((source) => ({ id: source.id, title: source.title, path: source.path, content: source.content })),
      selection: String(input?.selection || 'explicit')
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

  async createExecution(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const workflow = input?.workflow_revision
      ? await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? AND revision=?', [projectId, Number(input.workflow_revision)])
      : await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    const brief = input?.brief_revision
      ? await this.db.get('SELECT * FROM brief_revisions WHERE project_id=? AND revision=?', [projectId, Number(input.brief_revision)])
      : await this.db.get('SELECT * FROM brief_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [projectId]);
    assert(workflow, 'invalid_input', 'a workflow revision is required');
    assert(brief, 'invalid_input', 'a brief revision is required');
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
    if (this.config.codexCredential) {
      await this.db.run('INSERT OR IGNORE INTO credential_refs(id,provider,label,secret_ref,created_at) VALUES(?,?,?,?,?)', [this.config.codexCredential.ref, 'codex', this.config.codexCredential.profile, 'secret_bundle:codex_default', now()]);
    }
    if (this.config.githubCredential) {
      await this.db.run('INSERT OR IGNORE INTO credential_refs(id,provider,label,secret_ref,created_at) VALUES(?,?,?,?,?)', [this.config.githubCredential.ref, 'github', 'default', 'docker_secret:github_token', now()]);
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
            job = await this.broker.submit({
              task_id: task.id,
              execution_id: executionId,
              project_id: execution.project_id,
              workspace_subpath: workspaceSubpath,
              worktree_subpath: worktree?.worktree_path || null,
              baseline_sha: worktree?.baseline_sha || execution.repository_sha || null,
              output_subpath: `projects/${execution.project_id}/outputs/${executionId}`,
              input_subpath: inputSubpath,
              model: this.config.codexModel || 'gpt-5.5',
              image_digest: this.config.runnerDigest,
              execution_mode: task.mode === 'write' ? 'write' : 'read',
              resource_profile: 'standard',
              network_profile: this.config.codexCredential ? 'model' : 'none',
              credential_ref: this.config.codexCredential?.ref || null,
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
    const running = await this.db.query("SELECT id,broker_job_id FROM task_attempts WHERE status IN ('ready','running')").catch(() => []);
    await Promise.all(running.map(async (attempt) => {
      if (attempt.broker_job_id) await this.broker.cancel(attempt.broker_job_id).catch(() => undefined);
      this.releaseAttempt(attempt.id);
    }));
    const deadline = Date.now() + 5_000;
    while (this.driving.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
