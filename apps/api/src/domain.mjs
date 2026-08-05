import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asJson, hashJson, id, now, parseJson, sha256, stableStringify } from './crypto.mjs';
import { AppError, assert } from './errors.mjs';
import { assertReviewablePath, normalizeRelativePath, resolveWorkspacePath } from './path-policy.mjs';
import { MODEL_SUGGESTION_STATUSES } from '../../../packages/contracts/src/index.mjs';

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const execFileAsync = promisify(execFile);

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
  return {
    ...row,
    input_assets: rowJson(row, 'input_assets_json', []),
    tasks: [...latest.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)).map((attempt) => ({
      ...attempt,
      output: rowJson(attempt, 'output_json', {})
    }))
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
    return {
      id: taskId,
      title: String(task.title || taskId).slice(0, 200),
      level,
      deps,
      mode,
      inputs: Array.isArray(task.inputs) ? task.inputs.map(String).slice(0, 32) : [],
      outputs: Array.isArray(task.outputs) ? task.outputs.map(String).slice(0, 32) : []
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
  return tasks;
}

export class Domain {
  constructor({ db, config, broker, emit = () => undefined }) {
    this.db = db;
    this.config = config;
    this.broker = broker;
    this.emit = emit;
    this.driving = new Set();
    this.activeJobs = new Map();
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
    return {
      ...projectView(project),
      brief: briefView(brief),
      workflow: workflowView(workflow),
      repository,
      executions: executions.map((execution) => executionView(execution))
    };
  }

  async createProject(input, ctx = {}) {
    const name = String(input?.name || '').trim();
    assert(name.length > 0, 'invalid_input', 'project name is required');
    const projectId = id('prj');
    const repositoryId = id('repo');
    const timestamp = now();
    const localPath = input?.repository?.local_path
      ? normalizeRelativePath(input.repository.local_path)
      : `projects/${projectId}`;
    const workspacePath = resolveWorkspacePath(this.config.home, localPath);
    fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    const statements = [
      { sql: 'INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', params: [projectId, name, String(input.description || ''), 'active', 1, timestamp, timestamp] },
      { sql: 'INSERT INTO repository_bindings(id,project_id,local_path,remote_url,head_sha,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', params: [repositoryId, projectId, localPath, String(input?.repository?.remote_url || ''), String(input?.repository?.head_sha || ''), 1, timestamp, timestamp] },
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

  async createAsset(projectId, input, ctx = {}) {
    await this.requireProject(projectId);
    const name = normalizeRelativePath(String(input?.name || 'attachment.bin'));
    const mediaType = String(input?.media_type || 'text/plain').slice(0, 120);
    const content = input?.encoding === 'base64'
      ? Buffer.from(String(input.content || ''), 'base64')
      : Buffer.from(String(input?.content || ''), 'utf8');
    assert(content.byteLength <= 20 * 1024 * 1024, 'invalid_input', 'asset is too large');
    const casHash = sha256(content);
    const casRelative = path.posix.join('sha256', casHash.slice(0, 2), casHash);
    const casPath = path.join(this.config.casRoot, casHash.slice(0, 2), casHash);
    fs.mkdirSync(path.dirname(casPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(casPath)) fs.writeFileSync(casPath, content, { flag: 'wx', mode: 0o600 });
    const version = Number((await this.db.get('SELECT COALESCE(MAX(version),0)+1 AS version FROM asset_versions WHERE project_id=? AND name=?', [projectId, name])).version);
    const assetId = id('asset');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO asset_versions(id,project_id,name,media_type,byte_size,cas_hash,cas_path,version,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [assetId, projectId, name, mediaType, content.byteLength, casHash, casRelative, version, timestamp] },
      auditStatement('asset.created', 'asset_version', assetId, { project_id: projectId, cas_hash: casHash }, ctx.actor)
    ]);
    return this.db.get('SELECT * FROM asset_versions WHERE id=?', [assetId]);
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
      ? await this.db.query(`SELECT id,cas_hash FROM asset_versions WHERE project_id=? AND id IN (${requestedAssets.map(() => '?').join(',')})`, [projectId, ...requestedAssets])
      : [];
    assert(assets.length === requestedAssets.length, 'invalid_input', 'execution input asset is not in project');
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
      input_assets_json: asJson(assets),
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

  async getExecution(executionId) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const attempts = await this.db.query('SELECT * FROM task_attempts WHERE execution_id=? ORDER BY task_id,attempt_no', [executionId]);
    return executionView(execution, attempts);
  }

  async listExecutions(projectId) {
    await this.requireProject(projectId);
    const rows = await this.db.query('SELECT * FROM executions WHERE project_id=? ORDER BY created_at DESC', [projectId]);
    return Promise.all(rows.map((row) => this.getExecution(row.id)));
  }

  async startExecution(executionId, input = {}, ctx = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    assert(['queued', 'failed', 'awaiting_human'].includes(execution.status), 'invalid_state', 'execution is not startable', { status: 409 });
    if (execution.status === 'awaiting_human' && input.mode !== 'human_retry' && input.mode !== 'replan') {
      throw new AppError('human_review_required', 'choose human_retry or replan before continuing', { status: 409 });
    }
    const expected = input.expected_revision == null ? execution.revision : Number(input.expected_revision);
    try {
      await this.db.transaction([
        { sql: 'UPDATE executions SET status=\'running\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), executionId, expected], expect_changes: 1 },
        eventStatement('execution.started', executionId, null, { mode: input.mode || 'initial' }),
        auditStatement('execution.started', 'execution', executionId, { mode: input.mode || 'initial' }, ctx.actor)
      ]);
    } catch (error) {
      if (!isTransactionPrecondition(error)) throw error;
      throw new AppError('revision_conflict', 'execution revision has changed', { details: { expected_revision: expected } });
    }
    await this.emitExecutionEvents(executionId);
    void this.driveExecution(executionId, input.mode === 'replan' ? 'replan' : input.mode === 'human_retry' ? 'human_retry' : 'initial');
    return this.getExecution(executionId);
  }

  async cancelExecution(executionId, input = {}, ctx = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const expected = Number(input.expected_revision ?? execution.revision);
    const running = await this.db.query("SELECT id,broker_job_id FROM task_attempts WHERE execution_id=? AND status='running'", [executionId]);
    try {
      await this.db.transaction([
        { sql: 'UPDATE executions SET status=\'cancelled\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), executionId, expected], expect_changes: 1 },
        { sql: 'UPDATE task_attempts SET status=\'cancelled\',finished_at=? WHERE execution_id=? AND status IN (\'pending\',\'ready\',\'running\')', params: [now(), executionId] },
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
    assert(input.review_id, 'review_required', 'an approved human review is required before delivery', { status: 409 });
    const review = await this.getReview(input.review_id);
    assert(review.project_id === projectId && review.kind === 'delivery_create' && review.decision?.decision === 'approved', 'review_required', 'an approved delivery review is required', { status: 409 });
    const deliveryId = id('del');
    const timestamp = now();
    await this.db.transaction([
      { sql: 'INSERT INTO deliveries(id,project_id,execution_id,repository_binding_id,kind,status,title,body,external_ref,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', params: [deliveryId, projectId, input.execution_id || null, repository.id, 'draft_pr', 'draft', String(input.title || 'AIWS draft change'), String(input.body || ''), '', 1, timestamp, timestamp] },
      auditStatement('delivery.created', 'delivery', deliveryId, { project_id: projectId }, ctx.actor)
    ]);
    return this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
  }

  async mergeDelivery(deliveryId, input, ctx = {}) {
    const delivery = await this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
    if (!delivery) throw new AppError('not_found', 'delivery not found');
    assert(input?.review_id, 'review_required', 'a separate merge review is required', { status: 409 });
    const review = await this.getReview(input.review_id);
    assert(review.project_id === delivery.project_id && review.kind === 'delivery_merge' && review.decision?.decision === 'approved', 'review_required', 'an approved merge review is required', { status: 409 });
    try {
      await this.db.transaction([
        { sql: 'UPDATE deliveries SET status=\'merged\',revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [now(), deliveryId, delivery.revision], expect_changes: 1 },
        auditStatement('delivery.merged', 'delivery', deliveryId, { review_id: input.review_id }, ctx.actor)
      ]);
    } catch (error) {
      if (!isTransactionPrecondition(error)) throw error;
      throw new AppError('revision_conflict', 'delivery revision has changed');
    }
    return this.db.get('SELECT * FROM deliveries WHERE id=?', [deliveryId]);
  }

  async listDeliveries(projectId) {
    const rows = projectId ? await this.db.query('SELECT * FROM deliveries WHERE project_id=? ORDER BY created_at DESC', [projectId]) : await this.db.query('SELECT * FROM deliveries ORDER BY created_at DESC');
    return rows;
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
      return { project_id: projectId, repository_sha: repository.head_sha, files: [], diff: '' };
    }
    try {
      const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'diff', '--no-ext-diff', '--binary', 'HEAD'], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true
      });
      const files = [...stdout.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
      return { project_id: projectId, repository_sha: repository.head_sha, files, diff: stdout };
    } catch (error) {
      throw new AppError('git_diff_failed', 'failed to read repository diff', { status: 422, details: { cause: error.message } });
    }
  }

  async events(executionId, cursor = 0) {
    const rows = await this.db.query('SELECT cursor,type,execution_id,task_id,data_json,created_at FROM events WHERE execution_id=? AND cursor>? ORDER BY cursor LIMIT 500', [executionId, Number(cursor) || 0]);
    return rows.map((row) => ({ cursor: row.cursor, type: row.type, execution_id: row.execution_id, task_id: row.task_id, data: rowJson(row, 'data_json', {}), created_at: row.created_at }));
  }

  async capabilities() {
    const broker = await this.broker.probe().catch((error) => ({ ready: false, error: error.message }));
    return {
      version: this.config.version,
      api: this.config.apiPrefix,
      codex: { status: this.config.codexAvailable ? 'available' : 'unavailable' },
      github: { status: this.config.githubAvailable ? 'available' : 'unavailable' },
      broker: { status: broker.ready ? 'available' : 'unavailable', runner_digest: broker.runner_digest || this.config.runnerDigest }
    };
  }

  async health() {
    const sqlite = await this.db.integrity().catch((error) => ({ integrity: ['error'], error: error.message }));
    const capabilities = await this.capabilities();
    return { sqlite, broker: capabilities.broker, runner_digest: this.config.runnerDigest };
  }

  async recover() {
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
      void this.driveExecution(execution.id, 'recovery');
    }
    return running.length;
  }

  async requireProject(projectId) {
    const project = await this.db.get('SELECT id FROM projects WHERE id=?', [projectId]);
    if (!project) throw new AppError('not_found', 'project not found');
    return project;
  }

  async driveExecution(executionId, mode) {
    if (this.driving.has(executionId)) return;
    this.driving.add(executionId);
    const deadline = Date.now() + 10 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
        if (!execution || ['completed', 'cancelled'].includes(execution.status)) break;
        const workflow = await this.db.get('SELECT * FROM workflow_revisions WHERE project_id=? AND revision=?', [execution.project_id, execution.workflow_revision]);
        const repository = await this.db.get('SELECT local_path FROM repository_bindings WHERE project_id=?', [execution.project_id]);
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
        const humanContinuation = mode === 'human_retry' || mode === 'replan';
        if (!humanContinuation && [...latest.values()].some((attempt) => attempt.status === 'awaiting_human')) {
          await this.finishExecution(executionId, 'awaiting_human');
          break;
        }
        const repositoryKey = repository?.local_path || execution.project_id;
        for (const task of tasks) {
          const current = latest.get(task.id);
          if (!current || !['pending', 'failed', ...(humanContinuation ? ['awaiting_human'] : [])].includes(current.status)) continue;
          const depsComplete = task.deps.every((dep) => latest.get(dep)?.status === 'completed');
          if (!depsComplete) continue;
          if (!this.canReserve(repositoryKey, task.mode)) continue;
          const retrying = current.status === 'failed' || current.status === 'awaiting_human';
          const nextAttempt = retrying ? current.attempt_no + 1 : current.attempt_no;
          const attemptMode = retrying ? (current.status === 'failed' && current.attempt_no === 1 ? 'auto_correct' : mode === 'human_retry' ? 'human_retry' : 'replan') : 'initial';
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
            job = await this.broker.submit({
              task_id: task.id,
              execution_id: executionId,
              project_id: execution.project_id,
              workspace_subpath: repository?.local_path || `projects/${execution.project_id}`,
              image_digest: this.config.runnerDigest,
              execution_mode: task.mode === 'write' ? 'write' : 'read',
              resource_profile: 'standard',
              network_profile: 'none',
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
            await this.failAttempt(attemptId, executionId, task.id, error.code || 'broker_unavailable');
          }
        }
        const runningRows = await this.db.query("SELECT * FROM task_attempts WHERE execution_id=? AND status='running'", [executionId]);
        let observed = false;
        for (const attempt of runningRows) {
          const job = await this.broker.status(attempt.broker_job_id).catch(() => ({ status: 'unknown' }));
          if (!TERMINAL_JOB_STATUSES.has(job.status)) continue;
          observed = true;
          if (job.status === 'completed') await this.completeAttempt(attempt, job);
          else await this.failAttempt(attempt.id, executionId, attempt.task_id, job.status === 'cancelled' ? 'cancelled' : 'runner_failed');
        }
        if (!observed && runningRows.length === 0) await new Promise((resolve) => setTimeout(resolve, 40));
        else await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } finally {
      this.driving.delete(executionId);
    }
  }

  async completeAttempt(attempt, job) {
    this.releaseAttempt(attempt.id);
    try {
      await this.db.transaction([
        { sql: 'UPDATE task_attempts SET status=\'completed\',output_json=?,finished_at=? WHERE id=? AND status=\'running\'', params: [asJson(job.result || {}), now(), attempt.id], expect_changes: 1 },
        eventStatement('task.completed', attempt.execution_id, attempt.task_id, { attempt: attempt.attempt_no })
      ]);
    } catch (error) {
      if (isTransactionPrecondition(error)) return;
      throw error;
    }
    await this.emitExecutionEvents(attempt.execution_id);
  }

  async failAttempt(attemptId, executionId, taskId, errorCode) {
    this.releaseAttempt(attemptId);
    const attempt = await this.db.get('SELECT * FROM task_attempts WHERE id=?', [attemptId]);
    if (!attempt || !['ready', 'running'].includes(attempt.status)) return;
    const terminal = attempt.attempt_no >= 2;
    const nextStatus = terminal ? 'awaiting_human' : 'failed';
    try {
      await this.db.transaction([
        { sql: 'UPDATE task_attempts SET status=?,error_code=?,finished_at=? WHERE id=? AND status IN (\'ready\',\'running\')', params: [nextStatus, String(errorCode || 'runner_failed'), now(), attemptId], expect_changes: 1 },
        eventStatement(terminal ? 'task.awaiting_human' : 'task.failed', executionId, taskId, { attempt: attempt.attempt_no, error_code: errorCode })
      ]);
    } catch (error) {
      if (isTransactionPrecondition(error)) return;
      throw error;
    }
    await this.emitExecutionEvents(executionId);
  }

  async finishExecution(executionId, status) {
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
}
