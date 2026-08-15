import { asJson, hashJson, id, now, parseJson } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { candidateToLegacyTasks, criticIssues, validateWorkflowCandidate } from './validator.mjs';

const TERMINAL_GENERATIONS = new Set(['completed', 'rejected', 'failed', 'cancelled', 'applied', 'proposal_created']);
const MAX_CANDIDATE_BYTES = 256 * 1024;
const PUBLIC_EVENT_FIELDS = new Set([
  'status', 'revision', 'draft_revision', 'layout_revision', 'attempt', 'input_hash',
  'candidate_hash', 'proposal_hash', 'error_code', 'critic_status'
]);

function isTransactionConflict(error) {
  const message = String(error?.message || '');
  return error?.name === 'TransactionPreconditionError'
    || message.includes('transaction_precondition_failed')
    || message.includes('UNIQUE constraint failed');
}

function workflowContract(task) {
  return {
    goal: task.goal || task.title || task.id,
    inputs: task.input_slots?.length ? task.input_slots : task.inputs || [],
    outputs: task.output_slots?.length ? task.output_slots : task.outputs || [],
    dependencies: task.deps || [],
    allowed_tools: task.allowed_tools || [],
    acceptance: task.acceptance || []
  };
}

function taskDefinitionHash(task) {
  return hashJson({
    id: task.id,
    title: task.title || task.id,
    goal: task.goal || task.title || task.id,
    workstream_id: task.workstream_id || '',
    level: Number(task.level || 1),
    deps: task.deps || [],
    mode: task.mode || 'read',
    inputs: task.inputs || [],
    outputs: task.outputs || [],
    input_slots: task.input_slots || [],
    output_slots: task.output_slots || [],
    allowed_tools: task.allowed_tools || [],
    acceptance: task.acceptance || []
  });
}

function proposalDigest({ generationId, mode, workflowRevision, draftRevision, layoutRevision, candidateHash, criticReceiptId, inputHash }) {
  return hashJson({
    generation_id: generationId,
    mode,
    base_workflow_revision: Number(workflowRevision || 0),
    base_draft_revision: Number(draftRevision || 0),
    base_layout_revision: Number(layoutRevision || 0),
    candidate_hash: candidateHash,
    critic_receipt_id: criticReceiptId,
    input_hash: inputHash
  });
}

async function fixtureDelay(milliseconds, signal) {
  const delay = Math.max(0, Math.min(5_000, Number(milliseconds) || 0));
  if (!delay) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      reject(new AppError('operation_cancelled', 'operation was cancelled', { status: 409 }));
    }
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

function json(row, field, fallback) {
  return row?.[field] == null ? fallback : parseJson(row[field], fallback);
}

function normalizedDraftHash(row) {
  return row?.draft_hash || hashJson(json(row, 'graph_json', {}));
}

function generationView(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    operation_id: row.operation_id || null,
    mode: row.mode || 'initial',
    phase: row.phase || row.status || 'queued',
    status: row.phase || row.status || 'queued',
    brief_revision: Number(row.brief_revision || 0),
    brief_hash: row.brief_hash || '',
    source_revision: row.source_revision || '',
    source_hash: row.source_hash || '',
    repository_revision: Number(row.repository_revision || 0),
    repository_hash: row.repository_hash || '',
    draft_revision: Number(row.draft_revision || 0),
    layout_revision: Number(row.layout_revision || 0),
    attempt: Number(row.attempt || 1),
    retry_of_generation_id: row.retry_of_generation_id || null,
    input_hash: row.input_hash || '',
    candidate_hash: row.candidate_hash || '',
    error_code: row.error_code || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
    cancelled_at: row.cancelled_at || null
  };
}

function proposalView(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    generation_id: row.generation_id,
    mode: row.mode,
    status: row.status,
    base_workflow_revision: Number(row.base_workflow_revision || 0),
    base_draft_revision: Number(row.base_draft_revision || 0),
    base_layout_revision: Number(row.base_layout_revision || 0),
    candidate_hash: row.candidate_hash,
    proposal_hash: row.proposal_hash,
    applied_workflow_revision: Number(row.applied_workflow_revision || 0),
    apply_operation_id: row.apply_operation_id || null,
    candidate: json(row, 'candidate_json', {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function layoutView(row) {
  if (!row) return null;
  const { nodes_json: _nodes, viewport_json: _viewport, ...metadata } = row;
  return { ...metadata, nodes: json(row, 'nodes_json', []), viewport: json(row, 'viewport_json', {}) };
}

function criticView(row) {
  if (!row) return null;
  return {
    id: row.id,
    generation_id: row.generation_id,
    status: row.status,
    candidate_hash: row.candidate_hash,
    input_hash: row.input_hash,
    issues: json(row, 'issues_json', []),
    node_ids: json(row, 'node_ids_json', []),
    field_paths: json(row, 'field_paths_json', []),
    created_at: row.created_at
  };
}

function publicEventData(row) {
  const data = json(row, 'data_json', {});
  return Object.fromEntries(Object.entries(data).filter(([key]) => PUBLIC_EVENT_FIELDS.has(key)));
}

function workflowIssue(error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  return {
    code: String(error?.code || 'workflow_contract_invalid').slice(0, 120),
    ...(details.node_id || details.task_id ? { node_id: String(details.node_id || details.task_id).slice(0, 80) } : {}),
    ...(details.field || details.field_path ? { field_path: String(details.field || details.field_path).slice(0, 200) } : {})
  };
}

function boundedCandidate(candidate) {
  assert(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'workflow_contract_invalid', 'workflow candidate is required', { status: 422 });
  assert(Buffer.byteLength(asJson(candidate), 'utf8') <= MAX_CANDIDATE_BYTES, 'workflow_contract_invalid', 'workflow candidate exceeds 256 KiB', { status: 413 });
  return candidate;
}

export class WorkflowService {
  constructor({ db, operations, config = {}, projectReader = async () => null, emit = () => undefined }) {
    this.db = db;
    this.operations = operations;
    this.config = config;
    this.projectReader = projectReader;
    this.emit = emit;
    this.registerOperationHandlers();
  }

  registerOperationHandlers() {
    this.operations?.registerHandler('workflow.generate', {
      cancel: async (operation) => this.cancelGeneration(operation.resource_id),
      recover: async (operation, operations) => {
        const generation = await this.db.get('SELECT * FROM workflow_generations WHERE id=?', [operation.resource_id]);
        if (!generation) return false;
        if (TERMINAL_GENERATIONS.has(generation.phase)) {
          await operations.reconcile(operation, this.generationOperationOutcome(generation));
          return true;
        }
        return (context) => this.executeGeneration(operation.resource_id, context);
      }
    });
    this.operations?.registerHandler('workflow.critic', {
      cancel: async (operation) => this.cancelGeneration(operation.resource_id),
      recover: async (operation, operations) => {
        const generation = await this.db.get('SELECT * FROM workflow_generations WHERE id=?', [operation.resource_id]);
        if (!generation) return false;
        if (TERMINAL_GENERATIONS.has(generation.phase)) {
          await operations.reconcile(operation, this.generationOperationOutcome(generation));
          return true;
        }
        return (context) => this.executeGeneration(operation.resource_id, context);
      }
    });
    this.operations?.registerHandler('workflow.proposal.apply', {
      recover: async (operation, operations) => {
        const proposal = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [operation.resource_id]);
        if (!proposal) return false;
        if (proposal.status === 'applied') {
          await operations.reconcile(operation, { status: 'completed', result: this.appliedWorkflowReceipt(proposal) });
          return true;
        }
        if (proposal.status !== 'pending' || proposal.apply_operation_id !== operation.id) return false;
        return (context) => this.executeProposalApply(operation.resource_id, context, {});
      }
    });
  }

  async project(projectId) {
    const project = await this.projectReader(projectId) || await this.db.get('SELECT * FROM projects WHERE id=?', [projectId]);
    if (!project) throw new AppError('not_found', 'project not found');
    return project;
  }

  async getDraft(projectId) {
    await this.project(projectId);
    let row = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC,created_at DESC LIMIT 1', [projectId]);
    if (!row) {
      const timestamp = now();
      const draftId = id('wfd');
      await this.db.run(`INSERT INTO workflow_drafts(
        id,project_id,revision,graph_json,status,created_at,updated_at,source_brief_revision,source_brief_hash,
        hierarchy_mode,generation_status,critic_status,last_generation_id,applied_workflow_revision,layout_revision,draft_hash,draft_updated_at
      ) VALUES(?,?,1,'{}','draft',?,?,?,?,?,?,?,?,?,?,?,?)`, [
        draftId, projectId, timestamp, timestamp, 0, '', 'two_level', 'idle', 'not_run', null, 0, 0, hashJson({}), timestamp
      ]);
      row = await this.db.get('SELECT * FROM workflow_drafts WHERE id=?', [draftId]);
    }
    return this.draftView(row);
  }

  draftView(row) {
    if (!row) return null;
    const { graph_json: _graph, ...record } = row;
    const graph = json(row, 'graph_json', {});
    return { ...record, graph, draft_hash: normalizedDraftHash(row) };
  }

  async updateDraft(projectId, input = {}, ctx = {}) {
    await this.project(projectId);
    const current = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    assert(current, 'not_found', 'workflow draft not found');
    const expected = Number(input.expected_revision);
    assert(Number.isInteger(expected) && expected > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (expected !== Number(current.revision)) throw new AppError('workflow_draft_revision_conflict', 'workflow draft revision changed', { status: 409, details: { current_revision: current.revision } });
    const graph = input.graph && typeof input.graph === 'object' ? input.graph : input.draft && typeof input.draft === 'object' ? input.draft : {};
    const brief = await this.confirmedBrief(projectId);
    const candidate = validateWorkflowCandidate(graph, { brief: json(brief, 'content_json', {}) });
    const timestamp = now();
    const revision = Number(current.revision) + 1;
    const draftId = id('wfd');
    const graphJson = asJson(candidate);
    try {
      await this.db.transaction([
        {
          sql: `UPDATE projects SET updated_at=updated_at WHERE id=? AND workflow_draft_id=? AND workflow_draft_revision=?
            AND confirmed_brief_revision=? AND confirmed_brief_hash=?`,
          params: [projectId, current.id, expected, Number(brief?.revision || 0), brief?.content_hash || ''],
          expect_changes: 1
        },
        { sql: `INSERT INTO workflow_drafts(
          id,project_id,revision,graph_json,status,created_at,updated_at,source_brief_revision,source_brief_hash,
          hierarchy_mode,generation_status,critic_status,last_generation_id,applied_workflow_revision,layout_revision,draft_hash,draft_updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [
          draftId, projectId, revision, graphJson, 'draft', timestamp, timestamp,
          brief?.revision || 0, brief?.content_hash || '', 'two_level', 'idle', 'not_run', null, current.applied_workflow_revision || 0,
          0, hashJson(candidate), timestamp
        ] },
        {
          sql: 'UPDATE projects SET workflow_draft_id=?,workflow_draft_revision=?,revision=revision+1,updated_at=? WHERE id=? AND workflow_draft_id=? AND workflow_draft_revision=?',
          params: [draftId, revision, timestamp, projectId, current.id, expected],
          expect_changes: 1
        },
        { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('aud'), ctx.actor || 'local-user', 'workflow.draft.updated', 'workflow_draft', draftId, asJson({ project_id: projectId, revision }), timestamp] }
      ]);
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      const latest = await this.db.get('SELECT revision FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
      throw new AppError('workflow_draft_revision_conflict', 'workflow draft revision changed', { status: 409, details: { current_revision: Number(latest?.revision || 0) } });
    }
    return this.draftView(await this.db.get('SELECT * FROM workflow_drafts WHERE id=?', [draftId]));
  }

  async listLayouts(projectId, draftId = null) {
    await this.project(projectId);
    const rows = draftId
      ? await this.db.query('SELECT * FROM workflow_layout_revisions WHERE project_id=? AND draft_id=? ORDER BY revision DESC', [projectId, draftId])
      : await this.db.query('SELECT * FROM workflow_layout_revisions WHERE project_id=? ORDER BY created_at DESC,revision DESC', [projectId]);
    return rows.map(layoutView);
  }

  async saveLayout(projectId, input = {}, ctx = {}) {
    const draft = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    assert(draft, 'not_found', 'workflow draft not found');
    const draftRevision = Number(input.draft_revision ?? draft.revision);
    if (draftRevision !== Number(draft.revision)) throw new AppError('workflow_draft_revision_conflict', 'layout source draft is stale', { status: 409, details: { current_revision: draft.revision } });
    const nodes = Array.isArray(input.nodes) ? input.nodes.map((node) => ({ id: String(node.id || ''), position: node.position || { x: 0, y: 0 }, width: node.width || null, height: node.height || null })) : [];
    assert(nodes.length <= 1000, 'workflow_contract_invalid', 'layout contains too many nodes', { status: 422 });
    const viewport = input.viewport && typeof input.viewport === 'object' ? input.viewport : { x: 0, y: 0, zoom: 1 };
    const layoutHash = hashJson({ nodes, viewport, draft_revision: draftRevision });
    const expectedLayoutRevision = Number(input.expected_revision ?? draft.layout_revision ?? 0);
    if (!Number.isInteger(expectedLayoutRevision) || expectedLayoutRevision < 0) throw new AppError('expected_revision_required', 'expected_revision must be a non-negative layout revision', { status: 400 });
    if (expectedLayoutRevision !== Number(draft.layout_revision || 0)) throw new AppError('revision_conflict', 'workflow layout revision changed', { status: 409, details: { current_revision: Number(draft.layout_revision || 0) } });
    const revision = expectedLayoutRevision + 1;
    const timestamp = now();
    const layoutId = id('wlay');
    try {
      await this.db.transaction([
        {
          sql: 'UPDATE workflow_drafts SET layout_revision=?,updated_at=? WHERE id=? AND revision=? AND layout_revision=?',
          params: [revision, timestamp, draft.id, draftRevision, expectedLayoutRevision],
          expect_changes: 1
        },
        { sql: 'INSERT INTO workflow_layout_revisions(id,project_id,draft_id,draft_revision,revision,nodes_json,viewport_json,layout_hash,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', params: [layoutId, projectId, draft.id, draftRevision, revision, asJson(nodes), asJson(viewport), layoutHash, input.source === 'generator' ? 'generator' : 'manual', timestamp] },
        { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('aud'), ctx.actor || 'local-user', 'workflow.layout.created', 'workflow_layout_revision', layoutId, asJson({ project_id: projectId, draft_revision: draftRevision, revision, layout_hash: layoutHash }), timestamp] }
      ]);
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      const latest = await this.db.get('SELECT layout_revision FROM workflow_drafts WHERE id=?', [draft.id]);
      throw new AppError('revision_conflict', 'workflow layout revision changed', { status: 409, details: { current_revision: Number(latest?.layout_revision || 0) } });
    }
    return layoutView(await this.db.get('SELECT * FROM workflow_layout_revisions WHERE id=?', [layoutId]));
  }

  async confirmedBrief(projectId) {
    return this.db.get(`SELECT b.* FROM projects p JOIN brief_revisions b
      ON b.project_id=p.id AND b.revision=p.confirmed_brief_revision WHERE p.id=?`, [projectId]);
  }

  async repositorySnapshot(projectId) {
    const row = await this.db.get('SELECT revision,head_sha,source_hash,baseline_sha FROM repository_bindings WHERE project_id=?', [projectId]);
    return { revision: Number(row?.revision || 0), hash: row?.source_hash || row?.head_sha || '', sha: row?.head_sha || '', baseline_sha: row?.baseline_sha || '' };
  }

  providerSnapshot(input = {}) {
    return {
      provider: String(input.provider || 'fixture'),
      profile_id: input.profile_id || null,
      model: input.model || this.config.codexModel || 'fixture-model',
      config_hash: input.config_hash || '',
      runner_digest: this.config.runnerDigest || '',
      fixture_delay_ms: Math.max(0, Math.min(5_000, Number(input.fixture_delay_ms) || 0))
    };
  }

  async workflowSnapshot(projectId) {
    const head = await this.db.get('SELECT revision FROM workflow_heads WHERE project_id=?', [projectId]);
    const revision = Number(head?.revision || 0);
    const workflow = revision
      ? await this.db.get('SELECT revision,name,tasks_json,graph_hash,metadata_json FROM workflow_revisions WHERE project_id=? AND revision=?', [projectId, revision])
      : null;
    return {
      revision,
      hash: workflow?.graph_hash || '',
      name: workflow?.name || '',
      tasks: json(workflow, 'tasks_json', []),
      metadata: json(workflow, 'metadata_json', {})
    };
  }

  async completedNodeState(projectId, workflow) {
    if (!workflow.revision) return { ids: [], hashes: {} };
    const rows = await this.db.query(`SELECT DISTINCT ta.task_id FROM task_attempts ta
      JOIN executions e ON e.id=ta.execution_id
      WHERE e.project_id=? AND e.workflow_revision=? AND ta.status='completed'`, [projectId, workflow.revision]).catch(() => []);
    const ids = [...new Set(rows.map((row) => String(row.task_id)).filter(Boolean))].sort();
    const byId = new Map(workflow.tasks.map((task) => [String(task.id), task]));
    return {
      ids,
      hashes: Object.fromEntries(ids.filter((nodeId) => byId.has(nodeId)).map((nodeId) => [nodeId, taskDefinitionHash(byId.get(nodeId))]))
    };
  }

  async listGenerations(projectId) {
    await this.project(projectId);
    const rows = await this.db.query('SELECT * FROM workflow_generations WHERE project_id=? ORDER BY created_at DESC,id DESC', [projectId]);
    return Promise.all(rows.map(async (row) => {
      const view = generationView(row);
      if (row.critic_receipt_id) view.critic = criticView(await this.db.get('SELECT * FROM workflow_critic_receipts WHERE id=?', [row.critic_receipt_id]));
      if (row.proposal_id) view.proposal = proposalView(await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [row.proposal_id]));
      return view;
    }));
  }

  async getGeneration(generationId) {
    const row = await this.db.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
    if (!row) throw new AppError('not_found', 'workflow generation not found');
    const view = generationView(row);
    if (row.critic_receipt_id) view.critic = criticView(await this.db.get('SELECT * FROM workflow_critic_receipts WHERE id=?', [row.critic_receipt_id]));
    if (row.proposal_id) view.proposal = proposalView(await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [row.proposal_id]));
    return view;
  }

  async generationEvents(generationId, after = 0) {
    await this.getGeneration(generationId);
    const rows = await this.db.query(`SELECT cursor,generation_id,operation_id,type,data_json,created_at
      FROM workflow_generation_events WHERE generation_id=? AND cursor>? ORDER BY cursor LIMIT 500`, [generationId, Number(after) || 0]);
    return rows.map((row) => ({
      cursor: row.cursor,
      generation_id: row.generation_id,
      operation_id: row.operation_id || null,
      type: row.type,
      data: publicEventData(row),
      created_at: row.created_at
    }));
  }

  async generate(projectId, input = {}, ctx = {}) {
    const project = await this.project(projectId);
    const brief = await this.confirmedBrief(projectId);
    assert(brief, 'invalid_input', 'a confirmed brief is required before workflow generation', { status: 422 });
    let draft = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    if (!draft) {
      await this.getDraft(projectId);
      draft = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    }
    assert(draft, 'not_found', 'workflow draft not found');
    const repository = await this.repositorySnapshot(projectId);
    const layout = draft?.layout_revision ? await this.db.get('SELECT * FROM workflow_layout_revisions WHERE draft_id=? AND revision=?', [draft.id, draft.layout_revision]) : null;
    const workflow = await this.workflowSnapshot(projectId);
    const mode = input.mode === 'replan' ? 'replan' : 'initial';
    if (mode === 'replan' && input.base_workflow_revision != null && Number(input.base_workflow_revision) !== workflow.revision) {
      throw new AppError('workflow_proposal_stale', 'workflow head changed before replan generation', { status: 409, details: { current_workflow_revision: workflow.revision } });
    }
    const providerSnapshot = this.providerSnapshot(input);
    const suppliedCandidate = input.candidate == null ? null : boundedCandidate(input.candidate);
    const completed = mode === 'replan' ? await this.completedNodeState(projectId, workflow) : { ids: [], hashes: {} };
    const inputSnapshot = {
      project_revision: Number(project.revision || 0),
      brief_revision: Number(brief.revision),
      brief_hash: brief.content_hash,
      repository_revision: repository.revision,
      repository_hash: repository.hash,
      workflow_revision: workflow.revision,
      workflow_hash: workflow.hash,
      draft_id: draft?.id || null,
      draft_revision: Number(draft?.revision || 0),
      draft_hash: normalizedDraftHash(draft),
      layout_revision: Number(draft?.layout_revision || 0),
      layout_hash: layout?.layout_hash || '',
      provider: providerSnapshot,
      ...(suppliedCandidate ? { candidate: suppliedCandidate } : {}),
      ...(mode === 'replan' ? {
        completed_node_ids: completed.ids,
        completed_node_hashes: completed.hashes,
        base_workflow_revision: workflow.revision,
        base_workflow_hash: workflow.hash
      } : {})
    };
    const generationId = id('wgen');
    const operation = await this.operations.create({
      kind: 'workflow.generate', resourceType: 'workflow_generation', resourceId: generationId, actor: ctx.actor || 'local-user',
      executor: null
    });
    const timestamp = now();
    try {
      await this.db.transaction([
        { sql: `INSERT INTO workflow_generations(
          id,project_id,operation_id,mode,phase,brief_revision,brief_hash,source_revision,source_hash,
          repository_revision,repository_hash,draft_revision,layout_revision,attempt,retry_of_generation_id,provider_snapshot_json,input_snapshot_json,input_hash,
          candidate_json,candidate_hash,error_code,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [
          generationId, projectId, operation.operation_id, mode, 'queued', brief.revision, brief.content_hash,
          repository.revision ? String(repository.revision) : '', repository.hash, repository.revision, repository.hash,
          draft?.revision || 0, draft?.layout_revision || 0, Number(input.attempt || 1), input.retry_of_generation_id || null,
          asJson(providerSnapshot), asJson(inputSnapshot), hashJson(inputSnapshot), '{}', '', '', timestamp, timestamp
        ] },
        { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, operation.operation_id, 'workflow.generation.queued', asJson({ status: 'queued', input_hash: hashJson(inputSnapshot), revision: draft?.revision || 0 }), timestamp] },
        { sql: 'UPDATE workflow_drafts SET generation_status=?,critic_status=?,last_generation_id=?,updated_at=? WHERE id=? AND revision=?', params: ['queued', 'pending', generationId, timestamp, draft.id, draft.revision], expect_changes: 1 },
        { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('aud'), ctx.actor || 'local-user', 'workflow.generation.queued', 'workflow_generation', generationId, asJson({ project_id: projectId, operation_id: operation.operation_id }), timestamp] }
      ]);
    } catch (error) {
      await this.operations.reconcile(operation.operation_id, { status: 'failed', error_code: isTransactionConflict(error) ? 'workflow_generation_inputs_changed' : 'operation_interrupted' }).catch(() => undefined);
      if (isTransactionConflict(error)) throw new AppError('workflow_generation_inputs_changed', 'workflow generation inputs changed', { status: 409 });
      throw error;
    }
    queueMicrotask(() => this.operations.run(operation.operation_id, (operationContext) => this.executeGeneration(generationId, operationContext)).catch(() => undefined));
    return { ...operation, resource_id: generationId, generation_id: generationId, status: 'queued' };
  }

  async executeGeneration(generationId, operationContext) {
    const generation = await this.db.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
    if (!generation) throw new AppError('not_found', 'workflow generation not found');
    const projectId = generation.project_id;
    try {
      await this.transitionGeneration(generationId, 'running', { operation_id: operationContext.operationId });
      operationContext.ensureActive();
      const currentInput = await this.currentInputSnapshot(projectId, generation);
      if (currentInput.hash !== generation.input_hash) throw new AppError('workflow_generation_inputs_changed', 'workflow generation inputs changed', { status: 409 });
      const provider = json(generation, 'provider_snapshot_json', {});
      const fixture = provider.provider === 'fixture' || provider.provider === 'deterministic' || this.config.workflowGenerationFixture === true;
      if (!fixture) throw new AppError('workflow_generator_unavailable', 'workflow generator is unavailable', { status: 503, retryable: true });
      await fixtureDelay(provider.fixture_delay_ms, operationContext.signal);
      operationContext.ensureActive();
      const brief = await this.confirmedBrief(projectId);
      const inputSnapshot = json(generation, 'input_snapshot_json', {});
      const sourceCandidate = inputSnapshot.candidate || null;
      const candidateInput = sourceCandidate || this.fixtureCandidate(brief, generation.mode);
      const candidate = validateWorkflowCandidate(candidateInput, { brief: json(brief, 'content_json', {}) });
      return this.critiqueCandidate(generation, candidate, operationContext);
    } catch (error) {
      if (error?.code === 'operation_cancelled') throw error;
      const code = String(error?.code || 'workflow_contract_invalid').slice(0, 120);
      await this.failGeneration(generationId, code, { issue: workflowIssue(error) });
      throw new AppError(code, 'workflow generation failed', { status: Number(error?.status || 422), retryable: Boolean(error?.retryable) });
    }
  }

  async critiqueCandidate(generation, candidate, operationContext) {
    const generationId = generation.id;
    const projectId = generation.project_id;
    const candidateHash = hashJson(candidate);
    await this.transitionGeneration(generationId, 'critic_pending', { candidate_hash: candidateHash });
    operationContext.ensureActive();
    const issues = criticIssues(candidate);
    const receiptId = id('wcr');
    const status = issues.length ? 'rejected' : 'passed';
    const timestamp = now();
    await this.db.transaction([
      { sql: `INSERT INTO workflow_critic_receipts(
        id,generation_id,project_id,status,candidate_hash,input_hash,issues_json,node_ids_json,field_paths_json,provider_snapshot_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [receiptId, generationId, projectId, status, candidateHash, generation.input_hash, asJson(issues), asJson(issues.map((item) => item.node_id).filter(Boolean)), asJson(issues.map((item) => item.field_path).filter(Boolean)), generation.provider_snapshot_json, timestamp] },
      { sql: `UPDATE workflow_generations SET phase=?,candidate_json=?,candidate_hash=?,critic_receipt_id=?,error_code=?,updated_at=?,completed_at=? WHERE id=?`, params: [status === 'passed' ? 'completed' : 'rejected', asJson(candidate), candidateHash, receiptId, status === 'passed' ? '' : 'workflow_generation_critic_rejected', timestamp, timestamp, generationId] },
      { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, operationContext.operationId, `workflow.generation.${status}`, asJson({ status: status === 'passed' ? 'completed' : 'rejected', candidate_hash: candidateHash, critic_receipt_id: receiptId, issues }), timestamp] },
      { sql: 'UPDATE workflow_drafts SET generation_status=?,critic_status=?,updated_at=? WHERE project_id=? AND revision=? AND last_generation_id=?', params: [status === 'passed' ? 'completed' : 'rejected', status, timestamp, projectId, generation.draft_revision, generationId] }
    ]);
    if (status === 'passed') {
      const proposalId = id('wprop');
      const inputSnapshot = json(generation, 'input_snapshot_json', {});
      const baseWorkflowRevision = Number(inputSnapshot.workflow_revision || inputSnapshot.base_workflow_revision || 0);
      const proposalHash = proposalDigest({
        generationId,
        mode: generation.mode,
        workflowRevision: baseWorkflowRevision,
        draftRevision: generation.draft_revision,
        layoutRevision: generation.layout_revision,
        candidateHash,
        criticReceiptId: receiptId,
        inputHash: generation.input_hash
      });
      await this.db.transaction([
        { sql: `INSERT INTO workflow_generation_proposals(
          id,project_id,generation_id,mode,status,base_workflow_revision,base_draft_revision,base_layout_revision,candidate_json,candidate_hash,critic_receipt_id,proposal_hash,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [proposalId, projectId, generationId, generation.mode, 'pending', baseWorkflowRevision, generation.draft_revision, generation.layout_revision, asJson(candidate), candidateHash, receiptId, proposalHash, timestamp, timestamp] },
        { sql: 'UPDATE workflow_generations SET proposal_id=?,updated_at=? WHERE id=?', params: [proposalId, timestamp, generationId] },
        { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, operationContext.operationId, 'workflow.generation.proposal_created', asJson({ proposal_id: proposalId, proposal_hash: proposalHash }), timestamp] }
      ]);
    }
    return { generation_id: generationId, status: status === 'passed' ? 'completed' : 'rejected', critic_receipt_id: receiptId };
  }

  fixtureCandidate(briefRow, mode = 'initial') {
    const brief = json(briefRow, 'content_json', {});
    const objective = String(brief.objective || brief.feature || 'Deliver the confirmed brief').slice(0, 180);
    const acceptance = Array.isArray(brief.acceptance) ? brief.acceptance.map(String).filter(Boolean) : ['confirmed brief is covered'];
    return {
      name: mode === 'replan' ? 'Replanned workflow' : 'Generated workflow',
      workstreams: [
        { id: 'plan', title: 'Plan', goal: 'Inspect the confirmed brief and repository', acceptance: ['scope is recorded'], tasks: [{ id: 'inspect', title: objective, goal: objective, mode: 'read', outputs: ['artifacts/analysis.json'], output_slots: [{ name: 'analysis', type: 'json', selector: 'artifacts/analysis.json', acceptance: ['analysis is valid'] }], acceptance: ['scope is recorded'] }] },
        { id: 'deliver', title: 'Deliver', deps: ['plan'], goal: 'Implement and verify the requested change', acceptance, tasks: [{ id: 'deliver', title: 'Implement and verify', goal: objective, deps: ['inspect'], mode: 'write', inputs: ['artifacts/analysis.json'], outputs: ['artifacts/result.json'], input_slots: [{ name: 'analysis', type: 'json', selector: 'artifacts/analysis.json', target_output: 'analysis', acceptance: ['analysis is available'] }], output_slots: [{ name: 'result', type: 'json', selector: 'artifacts/result.json', acceptance }], allowed_tools: ['git', 'test'], acceptance }] }
      ]
    };
  }

  async currentInputSnapshot(projectId, generation) {
    const brief = await this.confirmedBrief(projectId);
    const repository = await this.repositorySnapshot(projectId);
    const workflow = await this.workflowSnapshot(projectId);
    const draft = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [projectId]);
    const layout = draft?.layout_revision ? await this.db.get('SELECT layout_hash FROM workflow_layout_revisions WHERE draft_id=? AND revision=?', [draft.id, draft.layout_revision]) : null;
    const provider = json(generation, 'provider_snapshot_json', {});
    const original = json(generation, 'input_snapshot_json', {});
    const completed = generation.mode === 'replan' ? await this.completedNodeState(projectId, workflow) : { ids: [], hashes: {} };
    const snapshot = {
      project_revision: Number((await this.project(projectId)).revision || 0),
      brief_revision: Number(brief?.revision || 0), brief_hash: brief?.content_hash || '',
      repository_revision: repository.revision, repository_hash: repository.hash,
      workflow_revision: workflow.revision, workflow_hash: workflow.hash,
      draft_id: draft?.id || null, draft_revision: Number(draft?.revision || 0),
      draft_hash: normalizedDraftHash(draft),
      layout_revision: Number(draft?.layout_revision || 0), layout_hash: layout?.layout_hash || '', provider,
      ...(original.candidate ? { candidate: original.candidate } : {}),
      ...(generation.mode === 'replan' ? {
        completed_node_ids: completed.ids,
        completed_node_hashes: completed.hashes,
        base_workflow_revision: workflow.revision,
        base_workflow_hash: workflow.hash
      } : {})
    };
    return { snapshot, hash: hashJson(snapshot) };
  }

  async transitionGeneration(generationId, phase, data = {}) {
    const timestamp = now();
    const generation = await this.db.get('SELECT operation_id FROM workflow_generations WHERE id=?', [generationId]);
    await this.db.transaction([
      { sql: 'UPDATE workflow_generations SET phase=?,updated_at=? WHERE id=?', params: [phase, timestamp, generationId] },
      { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, generation?.operation_id || null, `workflow.generation.${phase}`, asJson({ status: phase, ...data }), timestamp] }
    ]);
    this.emit({ type: `workflow.generation.${phase}`, generation_id: generationId, ...data });
  }

  async failGeneration(generationId, code, data = {}) {
    const timestamp = now();
    const generation = await this.db.get('SELECT operation_id FROM workflow_generations WHERE id=?', [generationId]);
    await this.db.transaction([
      { sql: 'UPDATE workflow_generations SET phase=\'failed\',error_code=?,updated_at=?,completed_at=? WHERE id=?', params: [code, timestamp, timestamp, generationId] },
      { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, generation?.operation_id || null, 'workflow.generation.failed', asJson({ status: 'failed', error_code: code, ...data }), timestamp] },
      { sql: 'UPDATE workflow_drafts SET generation_status=\'failed\',critic_status=\'not_run\',updated_at=? WHERE last_generation_id=?', params: [timestamp, generationId] }
    ]);
  }

  async cancelGeneration(generationId) {
    const row = await this.db.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
    if (!row || TERMINAL_GENERATIONS.has(row.phase)) return;
    const timestamp = now();
    await this.db.transaction([
      { sql: 'UPDATE workflow_generations SET phase=\'cancelled\',error_code=\'operation_cancelled\',cancelled_at=?,updated_at=? WHERE id=?', params: [timestamp, timestamp, generationId] },
      { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generationId, row.operation_id, 'workflow.generation.cancelled', asJson({ status: 'cancelled' }), timestamp] }
    ]);
  }

  generationOperationOutcome(generation) {
    const result = {
      generation_id: generation.id,
      resource_id: generation.id,
      status: generation.phase,
      ...(generation.critic_receipt_id ? { critic_receipt_id: generation.critic_receipt_id } : {})
    };
    if (generation.phase === 'failed') return { status: 'failed', error_code: generation.error_code || 'operation_interrupted' };
    if (generation.phase === 'cancelled') return { status: 'cancelled' };
    return { status: 'completed', result };
  }

  async retryGeneration(generationId, input = {}, ctx = {}) {
    const generation = await this.db.get('SELECT * FROM workflow_generations WHERE id=?', [generationId]);
    if (!generation) throw new AppError('not_found', 'workflow generation not found');
    if (!['failed', 'rejected', 'cancelled'].includes(generation.phase)) throw new AppError('workflow_generation_retry_invalid', 'generation is not retryable', { status: 409 });
    const original = json(generation, 'input_snapshot_json', {});
    const provider = json(generation, 'provider_snapshot_json', {});
    return this.generate(generation.project_id, {
      ...input,
      mode: generation.mode,
      provider: input.provider || provider.provider,
      profile_id: input.profile_id ?? provider.profile_id,
      model: input.model || provider.model,
      config_hash: input.config_hash || provider.config_hash,
      fixture_delay_ms: input.fixture_delay_ms ?? provider.fixture_delay_ms,
      attempt: Number(generation.attempt) + 1,
      retry_of_generation_id: generationId,
      ...(input.candidate ? {} : original.candidate ? { candidate: original.candidate } : {}),
      ...(generation.mode === 'replan' ? { base_workflow_revision: Number(original.base_workflow_revision || original.workflow_revision || 0) } : {})
    }, ctx);
  }

  async getProposal(proposalId) {
    const row = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
    if (!row) throw new AppError('not_found', 'workflow proposal not found');
    return proposalView(row);
  }

  async applyProposal(proposalId, input = {}, ctx = {}) {
    let proposal = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
    if (!proposal) throw new AppError('not_found', 'workflow proposal not found');
    if (proposal.status === 'applied') return this.proposalApplyReceipt(proposal);
    if (proposal.status !== 'pending') throw new AppError('workflow_proposal_stale', 'workflow proposal is no longer pending', { status: 409 });
    await this.assertProposalFresh(proposal);
    if (proposal.apply_operation_id) return this.proposalApplyReceipt(proposal);
    if (input.async === true) {
      const operation = await this.operations.create({
        kind: 'workflow.proposal.apply', resourceType: 'workflow_proposal', resourceId: proposalId,
        actor: ctx.actor || 'local-user', executor: null
      });
      try {
        await this.db.transaction([
          {
            sql: "UPDATE workflow_generation_proposals SET apply_operation_id=?,updated_at=? WHERE id=? AND status='pending' AND apply_operation_id IS NULL",
            params: [operation.operation_id, now(), proposalId],
            expect_changes: 1
          }
        ]);
      } catch (error) {
        // A concurrent caller may have reserved the proposal first.  The
        // newly-created operation is an observable row, so terminate it
        // explicitly before returning the winner's stable receipt.
        await this.operations.cancel(operation.operation_id, { expected_revision: operation.revision }).catch(() => undefined);
        proposal = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
        if (proposal?.apply_operation_id) return this.proposalApplyReceipt(proposal);
        throw error;
      }
      queueMicrotask(() => this.operations.run(operation.operation_id, (operationContext) => this.executeProposalApply(proposalId, operationContext, ctx)).catch(() => undefined));
      proposal = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
      return this.proposalApplyReceipt(proposal, operation);
    }
    return this.applyProposalNow(proposalId, input, ctx, null);
  }

  async proposalApplyReceipt(proposal, operation = null) {
    let operationReceipt = operation;
    if (!operationReceipt && proposal.apply_operation_id) {
      const row = await this.operations.get(proposal.apply_operation_id).catch(() => null);
      operationReceipt = row ? await this.operations.receipt(row) : null;
    } else if (operationReceipt?.id && !operationReceipt.operation_id) {
      operationReceipt = await this.operations.receipt(operationReceipt);
    }
    return {
      operation_id: operationReceipt?.operation_id || proposal.apply_operation_id || null,
      status: operationReceipt?.status || proposal.status,
      resource_id: proposal.id,
      cursor: Number(operationReceipt?.cursor || 0),
      revision: Number(operationReceipt?.revision || 0),
      proposal_id: proposal.id,
      proposal_status: proposal.status,
      generation_id: proposal.generation_id,
      workflow_revision: Number(proposal.applied_workflow_revision || 0)
    };
  }

  async executeProposalApply(proposalId, operationContext, ctx = {}) {
    operationContext.ensureActive();
    return this.applyProposalNow(proposalId, {}, ctx, operationContext);
  }

  async applyProposalNow(proposalId, input = {}, ctx = {}, operationContext = null) {
    const proposal = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
    if (!proposal) throw new AppError('not_found', 'workflow proposal not found');
    if (proposal.status === 'applied') return this.appliedWorkflowReceipt(proposal);
    if (proposal.status !== 'pending') throw new AppError('workflow_proposal_stale', 'workflow proposal is no longer pending', { status: 409 });
    const freshness = await this.assertProposalFresh(proposal);
    const { generation, critic, brief, draft, workflow, candidate } = freshness;
    assert(critic?.status === 'passed', 'workflow_generation_critic_rejected', 'critic receipt did not pass', { status: 409 });
    const tasks = candidateToLegacyTasks(candidate);
    if (proposal.mode === 'replan') {
      const inputSnapshot = json(generation, 'input_snapshot_json', {});
      const completedHashes = inputSnapshot.completed_node_hashes && typeof inputSnapshot.completed_node_hashes === 'object'
        ? inputSnapshot.completed_node_hashes
        : {};
      const candidateTasks = new Map(tasks.map((task) => [task.id, task]));
      for (const [nodeId, expectedHash] of Object.entries(completedHashes)) {
        const task = candidateTasks.get(nodeId);
        if (!task || taskDefinitionHash(task) !== expectedHash) {
          throw new AppError('workflow_proposal_stale', 'replan proposal changed a completed node', { status: 409, details: { node_id: nodeId } });
        }
      }
    }
    const revision = workflow.revision + 1;
    const timestamp = now();
    const graphHash = hashJson(tasks);
    const contractRows = tasks.map((task) => ({ task, contract: workflowContract(task) }));
    const headStatement = workflow.revision
      ? { sql: 'UPDATE workflow_heads SET revision=?,updated_at=? WHERE project_id=? AND revision=?', params: [revision, timestamp, proposal.project_id, workflow.revision], expect_changes: 1 }
      : { sql: 'INSERT INTO workflow_heads(project_id,revision,updated_at) VALUES(?,?,?)', params: [proposal.project_id, revision, timestamp] };
    const proposalOwnership = operationContext
      ? { sql: 'UPDATE workflow_generation_proposals SET status=\'applied\',applied_workflow_revision=?,updated_at=? WHERE id=? AND status=\'pending\' AND apply_operation_id=? AND proposal_hash=?', params: [revision, timestamp, proposalId, operationContext.operationId, proposal.proposal_hash], expect_changes: 1 }
      : { sql: 'UPDATE workflow_generation_proposals SET status=\'applied\',applied_workflow_revision=?,updated_at=? WHERE id=? AND status=\'pending\' AND apply_operation_id IS NULL AND proposal_hash=?', params: [revision, timestamp, proposalId, proposal.proposal_hash], expect_changes: 1 };
    const statements = [
      {
        sql: `UPDATE projects SET updated_at=updated_at WHERE id=? AND confirmed_brief_revision=? AND confirmed_brief_hash=?
          AND workflow_draft_id=? AND workflow_draft_revision=?`,
        params: [proposal.project_id, brief.revision, brief.content_hash, draft.id, draft.revision],
        expect_changes: 1
      },
      {
        sql: `UPDATE workflow_drafts SET updated_at=updated_at WHERE id=? AND project_id=? AND revision=?
          AND layout_revision=? AND draft_hash=? AND source_brief_revision=? AND source_brief_hash=?`,
        params: [draft.id, proposal.project_id, draft.revision, proposal.base_layout_revision, normalizedDraftHash(draft), brief.revision, brief.content_hash],
        expect_changes: 1
      },
      { sql: `INSERT INTO workflow_revisions(project_id,revision,name,tasks_json,graph_hash,created_at,hierarchy_mode,brief_revision,brief_hash,draft_revision,layout_revision,proposal_id,source_generation_id,metadata_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [proposal.project_id, revision, candidate.name, asJson(tasks), graphHash, timestamp, 'two_level', brief?.revision || 0, brief?.content_hash || '', proposal.base_draft_revision, proposal.base_layout_revision, proposalId, generation.id, asJson({ workstreams: candidate.workstreams, brief_coverage: candidate.brief_coverage })] },
      headStatement,
      ...contractRows.map(({ task, contract }) => ({ sql: 'INSERT INTO node_contracts(id,project_id,workflow_revision,node_id,contract_json,created_at) VALUES(?,?,?,?,?,?)', params: [id('nct'), proposal.project_id, revision, task.id, asJson(contract), timestamp] })),
      ...contractRows.map(({ task, contract }) => ({ sql: 'INSERT INTO node_contract_revisions(id,project_id,workflow_revision,node_id,revision,contract_json,contract_hash,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)', params: [id('ncr'), proposal.project_id, revision, task.id, 1, asJson(contract), hashJson(contract), 'workflow', timestamp] })),
      proposalOwnership,
      { sql: 'UPDATE workflow_generations SET phase=?,updated_at=? WHERE id=?', params: [proposal.mode === 'replan' ? 'proposal_created' : 'applied', timestamp, generation.id] },
      { sql: 'UPDATE workflow_drafts SET applied_workflow_revision=?,generation_status=\'applied\',updated_at=? WHERE project_id=? AND revision=?', params: [revision, timestamp, proposal.project_id, proposal.base_draft_revision] },
      { sql: 'INSERT INTO workflow_generation_events(generation_id,operation_id,type,data_json,created_at) VALUES(?,?,?,?,?)', params: [generation.id, operationContext?.operationId || proposal.apply_operation_id || null, proposal.mode === 'replan' ? 'workflow.generation.proposal_created' : 'workflow.generation.applied', asJson({ status: proposal.mode === 'replan' ? 'proposal_created' : 'applied', revision, proposal_hash: proposal.proposal_hash }), timestamp] },
      { sql: 'INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', params: [id('aud'), ctx.actor || 'local-user', 'workflow.proposal.applied', 'workflow_proposal', proposalId, asJson({ project_id: proposal.project_id, workflow_revision: revision }), timestamp] }
    ];
    try {
      await this.db.transaction(statements);
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      const current = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
      if (current?.status === 'applied') return this.appliedWorkflowReceipt(current);
      await this.db.run('UPDATE workflow_generation_proposals SET status=\'stale\',updated_at=? WHERE id=? AND status=\'pending\'', [now(), proposalId]);
      const head = await this.workflowSnapshot(proposal.project_id);
      const latestDraft = await this.db.get('SELECT revision,layout_revision FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [proposal.project_id]);
      throw new AppError('workflow_proposal_stale', 'workflow proposal source revision changed', { status: 409, details: { current_workflow_revision: head.revision, current_draft_revision: Number(latestDraft?.revision || 0), current_layout_revision: Number(latestDraft?.layout_revision || 0) } });
    }
    const applied = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
    return this.appliedWorkflowReceipt(applied, operationContext?.operationId || null);
  }

  appliedWorkflowReceipt(proposal, operationId = null) {
    return {
      proposal_id: proposal.id,
      workflow_revision: Number(proposal.applied_workflow_revision || 0),
      status: 'applied',
      generation_id: proposal.generation_id,
      operation_id: operationId || proposal.apply_operation_id || null,
      resource_id: proposal.id
    };
  }

  async assertProposalFresh(proposal) {
    const generation = await this.db.get('SELECT * FROM workflow_generations WHERE id=? AND project_id=?', [proposal.generation_id, proposal.project_id]);
    const critic = proposal.critic_receipt_id
      ? await this.db.get('SELECT * FROM workflow_critic_receipts WHERE id=? AND generation_id=?', [proposal.critic_receipt_id, proposal.generation_id])
      : null;
    const brief = await this.confirmedBrief(proposal.project_id);
    const draft = await this.db.get('SELECT * FROM workflow_drafts WHERE project_id=? ORDER BY revision DESC LIMIT 1', [proposal.project_id]);
    const workflow = await this.workflowSnapshot(proposal.project_id);
    const layout = Number(proposal.base_layout_revision || 0) > 0 && draft
      ? await this.db.get('SELECT * FROM workflow_layout_revisions WHERE draft_id=? AND revision=?', [draft.id, proposal.base_layout_revision])
      : null;
    const rawCandidate = json(proposal, 'candidate_json', {});
    const snapshot = json(generation, 'input_snapshot_json', {});
    let candidate = null;
    try { candidate = validateWorkflowCandidate(rawCandidate, { brief: json(brief, 'content_json', {}) }); }
    catch { /* a persisted proposal that no longer validates is stale */ }
    const expectedProposalHash = generation ? proposalDigest({
      generationId: generation.id,
      mode: generation.mode,
      workflowRevision: proposal.base_workflow_revision,
      draftRevision: proposal.base_draft_revision,
      layoutRevision: proposal.base_layout_revision,
      candidateHash: proposal.candidate_hash,
      criticReceiptId: proposal.critic_receipt_id,
      inputHash: generation.input_hash
    }) : '';
    const currentInput = generation ? await this.currentInputSnapshot(proposal.project_id, generation) : null;
    const stale = !generation
      || !brief
      || !draft
      || !candidate
      || generation.phase !== 'completed'
      || Number(proposal.base_workflow_revision) !== workflow.revision
      || snapshot.workflow_revision !== workflow.revision
      || snapshot.workflow_hash !== workflow.hash
      || Number(proposal.base_draft_revision) !== Number(draft.revision)
      || Number(generation.draft_revision) !== Number(draft.revision)
      || snapshot.draft_id !== draft.id
      || snapshot.draft_hash !== normalizedDraftHash(draft)
      || Number(proposal.base_layout_revision) !== Number(draft.layout_revision || 0)
      || Number(generation.layout_revision) !== Number(draft.layout_revision || 0)
      || (Number(draft.layout_revision || 0) > 0 && (!layout || snapshot.layout_hash !== layout.layout_hash))
      || Number(generation.brief_revision) !== Number(brief.revision)
      || generation.brief_hash !== brief.content_hash
      || Number(snapshot.brief_revision) !== Number(brief.revision)
      || snapshot.brief_hash !== brief.content_hash
      || Number(draft.source_brief_revision) !== Number(brief.revision)
      || draft.source_brief_hash !== brief.content_hash
      || generation.input_hash !== hashJson(snapshot)
      || currentInput?.hash !== generation.input_hash
      || hashJson(rawCandidate) !== proposal.candidate_hash
      || generation.candidate_hash !== proposal.candidate_hash
      || critic?.status !== 'passed'
      || critic.candidate_hash !== proposal.candidate_hash
      || critic.input_hash !== generation.input_hash
      || proposal.proposal_hash !== expectedProposalHash;
    if (stale) {
      await this.db.run('UPDATE workflow_generation_proposals SET status=\'stale\',updated_at=? WHERE id=? AND status=\'pending\'', [now(), proposal.id]);
      throw new AppError('workflow_proposal_stale', 'workflow proposal source revision changed', { status: 409, details: { current_workflow_revision: workflow.revision, current_draft_revision: Number(draft?.revision || 0), current_layout_revision: Number(draft?.layout_revision || 0) } });
    }
    return { generation, critic, brief, draft, workflow, layout, candidate };
  }

  async rejectProposal(proposalId, input = {}, ctx = {}) {
    const proposal = await this.db.get('SELECT * FROM workflow_generation_proposals WHERE id=?', [proposalId]);
    if (!proposal) throw new AppError('not_found', 'workflow proposal not found');
    if (proposal.status !== 'pending') return proposalView(proposal);
    await this.db.run('UPDATE workflow_generation_proposals SET status=\'rejected\',updated_at=? WHERE id=? AND status=\'pending\'', [now(), proposalId]);
    await this.db.run('INSERT INTO audit_events(id,actor,action,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', [id('aud'), ctx.actor || 'local-user', 'workflow.proposal.rejected', 'workflow_proposal', proposalId, asJson({ reason: String(input.reason || '').slice(0, 500) }), now()]);
    return this.getProposal(proposalId);
  }

  async replan(projectId, input = {}, ctx = {}) {
    const workflow = await this.workflowSnapshot(projectId);
    assert(workflow.revision > 0, 'workflow_proposal_stale', 'an applied workflow is required before replan', { status: 409 });
    const metadataWorkstreams = Array.isArray(workflow.metadata?.workstreams) ? workflow.metadata.workstreams : [];
    const compatibilityTasks = workflow.tasks.map((task) => ({
      ...task,
      goal: task.goal || task.title || task.id,
      outputs: task.outputs?.length ? task.outputs : [`artifacts/${task.id}.json`],
      acceptance: task.acceptance?.length ? task.acceptance : ['task output is accepted']
    }));
    const defaultCandidate = metadataWorkstreams.length
      ? { name: workflow.name || 'Replanned workflow', workstreams: metadataWorkstreams }
      : { name: workflow.name || 'Replanned workflow', tasks: compatibilityTasks };
    const generationInput = {
      ...input, mode: 'replan', provider: input.provider || 'fixture',
      base_workflow_revision: workflow.revision,
      candidate: input.candidate || defaultCandidate
    };
    return this.generate(projectId, generationInput, ctx);
  }
}
