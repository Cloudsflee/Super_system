import fs from 'node:fs';
import path from 'node:path';
import { asJson, hashJson, id, now, parseJson, sha256 } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { normalizeRelativePath, assertReviewablePath } from '../../path-policy.mjs';
import { ContextAdapterRegistry } from './adapters.mjs';
import { ContextRepository, jsonField, viewJob, viewNode, viewPack, viewSelection } from './repository.mjs';
import { buildIndex, deterministicIndexSnapshot, indexFile, loadIndex, readIndexPayload, searchIndex, serializeIndex, writeIndexAtomic } from './index-runtime.mjs';
import { createSelection, normalizePolicy } from './selection.mjs';
import { buildContextPack } from './pack.mjs';
import { ContextProjectionWorker } from './projection-worker.mjs';

const SENSITIVITY = new Set(['normal', 'sensitive', 'restricted']);

export class ContextService {
  constructor({ db, config, operations = null, projectWorkspace = null } = {}) {
    this.db = db;
    this.config = config;
    this.operations = operations;
    this.repository = new ContextRepository(db);
    this.adapters = new ContextAdapterRegistry({ repository: this.repository, projectWorkspace });
    this.indexes = new Map();
    this.worker = new ContextProjectionWorker({
      repository: this.repository,
      adapters: this.adapters,
      project: this,
      indexer: { rebuild: (projectId, nodes, versions, edges) => this.rebuildIndex(projectId, nodes, versions, edges) },
      cas: config?.casRoot
    });
    // Projection operations are durable independently of the HTTP process. On
    // restart the operation service asks this handler for a resumable executor.
    this.operations?.registerHandler?.('context.projection', {
      recover: async (operation, operationService) => {
        const job = await this.repository.job(operation.resource_id);
        if (!job) return false;
        if (job.status === 'completed') {
          await operationService.reconcile(operation, { status: 'completed', result: { resource_id: job.id, status: job.status } });
          return true;
        }
        if (['failed', 'cancelled'].includes(job.status)) {
          await operationService.reconcile(operation, { status: job.status, error_code: job.error_code || 'operation_interrupted' });
          return true;
        }
        return ({ signal }) => this.worker.run(job.id, job.project_id, { actor: 'system-recovery', signal });
      },
      cancel: async (operation) => {
        const job = await this.repository.job(operation.resource_id);
        if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
        await this.cancel(job.project_id, job.id, job.revision, 'system-operation-cancel', { skipOperation: true }).catch(() => undefined);
      }
    });
  }

  async requireProject(projectId) {
    const project = await this.repository.project(projectId);
    if (!project) throw new AppError('not_found', 'project not found');
    return project;
  }

  async listSources(projectId, query = '') {
    await this.requireProject(projectId);
    return this.repository.searchSources(projectId, query);
  }

  async createSource(projectId, input = {}, actor = 'local-user') {
    await this.requireProject(projectId);
    const kind = ['brief', 'repository', 'file', 'diff', 'test_report', 'image', 'note'].includes(input.kind) ? input.kind : 'note';
    const sourcePath = input.path ? normalizeRelativePath(String(input.path)) : '';
    if (['file', 'diff', 'test_report'].includes(kind)) assertReviewablePath(sourcePath);
    const content = String(input.content || '');
    assert(content.length <= 2_000_000, 'invalid_input', 'context source is too large', { status: 422 });
    const sourceId = id('src');
    const timestamp = now();
    const contentHash = sha256(content);
    await this.repository.createSource({ sourceId, projectId, kind, sourcePath, title: String(input.title || sourcePath || kind).slice(0, 200), content, contentHash, timestamp, actor, auditId: id('aud') });
    return this.repository.source(sourceId);
  }

  async map(projectId) {
    await this.requireProject(projectId);
    const rows = (await this.repository.nodes(projectId)).map(viewNode);
    const edges = await this.repository.edges(projectId);
    const index = await this.indexStatus(projectId);
    return { schema_version: 'aiws.context_map.v2', project_id: String(projectId), root_uri: `aiws://context/${projectId}`, nodes: rows, edges, index };
  }

  async search(projectId, query = '', options = {}) {
    await this.requireProject(projectId);
    const text = String(query || '').trim();
    if (!text) return [];
    let loaded = await this.loadIndex(projectId);
    if (!loaded) {
      // A missing or checksum-invalid index is rebuilt from the immutable
      // projection snapshot. CAS failures remain visible as a stable 503.
      try { loaded = await this.rebuildIndexFromStorage(projectId); } catch (error) {
        if (error?.code === 'context_projection_unavailable') throw error;
      }
    }
    if (loaded) return searchIndex(loaded, text).slice(0, Math.min(Number(options.limit) || 100, 500));
    // A degraded index still offers deterministic source search while a rebuild
    // is pending; no raw rows or absolute paths are exposed here.
    return (await this.repository.searchSources(projectId, text)).map((source, rank) => ({ node_id: null, source_id: source.id, title: source.title, kind: source.kind, uri: `aiws://context/${projectId}/${encodeURIComponent(source.kind)}/${encodeURIComponent(source.id)}`, score: 1 / (rank + 1), degraded: true }));
  }

  async read(projectId, uri, { versionId = null } = {}) {
    await this.requireProject(projectId);
    const node = await this.repository.nodeByUri(projectId, uri);
    if (!node) throw new AppError('not_found', 'context node not found');
    const version = versionId
      ? await this.repository.version(versionId)
      : node.current_document_version_id
        ? await this.repository.version(node.current_document_version_id)
        : await this.repository.latestVersion(node.id);
    if (!version || version.node_id !== node.id) return { ...viewNode(node), document: null };
    const content = await this.documentContent(version);
    return { ...viewNode(node), document: { ...version, content } };
  }

  async readById(projectId, nodeId, options = {}) {
    await this.requireProject(projectId);
    const node = await this.repository.node(nodeId, projectId);
    if (!node) throw new AppError('not_found', 'context node not found');
    return this.read(projectId, node.uri, options);
  }

  async versions(projectId, nodeId) {
    await this.requireProject(projectId);
    const node = await this.repository.node(nodeId, projectId);
    if (!node) throw new AppError('not_found', 'context node not found');
    return this.repository.versions(node.id);
  }

  async policy(projectId) {
    await this.requireProject(projectId);
    const head = await this.repository.policyHead(projectId);
    const revision = head ? await this.repository.policyRevision(projectId, head.revision) : null;
    const legacy = revision ? null : await this.repository.legacyPolicy(projectId);
    return { project_id: String(projectId), revision: Number(head?.revision || legacy?.revision || 0), policy: revision ? jsonField(revision, 'policy_json', {}) : jsonField(legacy, 'policy_json', {}), hash: revision?.policy_hash || (legacy ? hashJson(jsonField(legacy, 'policy_json', {})) : hashJson({})) };
  }

  async updatePolicy(projectId, input = {}, { expectedRevision = null, actor = 'local-user' } = {}) {
    await this.requireProject(projectId);
    const current = await this.policy(projectId);
    assert(expectedRevision != null && expectedRevision !== '' && Number.isInteger(Number(expectedRevision)) && Number(expectedRevision) >= 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (Number(expectedRevision) !== Number(current.revision)) throw new AppError('revision_conflict', 'context policy revision changed', { status: 409, details: { current_revision: current.revision } });
    const policy = normalizePolicy(input.policy || input);
    const revision = Number(current.revision || 0) + 1;
    const timestamp = now();
    const policyHash = hashJson(policy);
    await this.repository.updatePolicy({ projectId, revision, policyId: id('cpol'), policyJson: asJson(policy), policyHash, actor, timestamp, auditId: id('aud') });
    return this.policy(projectId);
  }

  async selections(projectId) {
    await this.requireProject(projectId);
    return (await this.repository.selections(projectId)).map(viewSelection);
  }

  async createSelection(projectId, input = {}, actor = 'local-user') {
    await this.requireProject(projectId);
    const nodeIds = Array.isArray(input.node_ids) ? [...new Set(input.node_ids.map(String))] : [];
    const nodeRows = nodeIds.length ? await this.repository.nodesByIds(projectId, nodeIds) : await this.repository.nodes(projectId);
    if (nodeIds.length !== nodeRows.length) throw new AppError('invalid_input', 'context node does not belong to project', { status: 422 });
    assert(nodeRows.length > 0, 'invalid_input', 'context selection needs at least one node', { status: 422 });
    const nodes = nodeRows.map(viewNode);
    const currentVersions = await this.repository.versionsByIds(nodes.map((node) => node.current_document_version_id));
    const versions = currentVersions.map((version) => ({ ...version, content: '' }));
    const present = new Set(versions.map((version) => String(version.node_id)));
    for (const node of nodes) {
      if (present.has(String(node.id))) continue;
      const version = await this.repository.latestVersion(node.id);
      if (version) versions.push({ ...version, content: Number(version.token_estimate || 0) > 0 ? '' : await this.documentContent(version) });
    }
    const currentPolicy = await this.policy(projectId);
    const selection = createSelection({ id: id('csel'), projectId, actor, nodes, versions, policy: currentPolicy.policy, policyRevision: currentPolicy.revision, query: input.query || '', explicitNodeIds: nodeIds, anchorNodeId: input.anchor_node_id || null, tokenBudget: Number(input.retrieval_plan?.token_budget || input.token_budget || 12000), retrievalPlan: input.retrieval_plan || {}, mandatoryNodeIds: input.mandatory_node_ids || [], timestamp: now() });
    await this.repository.createSelectionRecord({ selection, projectId, sessionId: input.session_id, actor, auditId: id('aud') });
    return selection;
  }

  async packs(projectId) {
    await this.requireProject(projectId);
    return (await this.repository.packs(projectId)).map(viewPack);
  }

  async pack(projectId, packId) {
    await this.requireProject(projectId);
    const row = await this.repository.pack(packId, projectId);
    if (!row) throw new AppError('not_found', 'context pack not found');
    return viewPack(row);
  }

  async createPack(projectId, input = {}, actor = 'local-user') {
    await this.requireProject(projectId);
    let selection = input.selection_id ? viewSelection(await this.repository.selection(input.selection_id, projectId)) : null;
    const sourceIds = Array.isArray(input.source_ids) ? [...new Set(input.source_ids.map(String))] : [];
    if (!selection) {
      const sourceRows = sourceIds.length ? await this.repository.sourcesByIds(projectId, sourceIds) : await this.repository.sources(projectId);
      if (sourceIds.length !== sourceRows.length) throw new AppError('invalid_input', 'context source does not belong to project', { status: 422 });
      let map = await this.map(projectId);
      let sourceNodeIds = map.nodes.filter((node) => sourceRows.some((source) => node.source_id === source.id)).map((node) => node.id);
      // R4 callers can seal a legacy source_ids pack immediately after adding
      // a source. Materialize the explicit Selection through the same
      // projection path when the source has not reached the v5 map yet.
      if (sourceRows.length && sourceNodeIds.length !== sourceRows.length) {
        await this.rebuild(projectId, { mode: 'incremental' }, actor);
        map = await this.map(projectId);
        sourceNodeIds = map.nodes.filter((node) => sourceRows.some((source) => node.source_id === source.id)).map((node) => node.id);
      }
      selection = await this.createSelection(projectId, { node_ids: sourceNodeIds, retrieval_plan: input.retrieval_plan || { strategy: 'explicit', token_budget: 12000 } }, actor);
    }
    if (!selection || !selection.included?.length) throw new AppError('invalid_input', 'context pack needs at least one selected document', { status: 422 });
    const documents = [];
    for (const item of selection.included) {
      const version = await this.repository.version(item.document_version_id);
      if (!version) continue;
      documents.push({ node_id: item.node_id, document_version_id: item.document_version_id, content_hash: version.content_hash, token_estimate: version.token_estimate, content: await this.documentContent(version) });
    }
    const snapshots = await this.repository.packInputs(projectId, sourceIds);
    const { brief, workflow } = snapshots;
    // The source_ids form is the R4 compatibility shape. Explicit v5 sealing
    // requires the authoritative Brief and applied Workflow snapshots.
    if ((input.selection_id || input.seal === true || input.schema_version === 'aiws.context_pack.v5') && (!brief || !workflow)) {
      throw new AppError('context_pack_not_ready', 'confirmed brief and applied workflow are required before sealing a Context Pack', { status: 409, details: { brief_ready: Boolean(brief), workflow_ready: Boolean(workflow) } });
    }
    const { repository, contracts: contractRows, legacySources } = snapshots;
    const contracts = workflow ? contractRows.map((row) => ({ node_id: row.node_id, contract: parseJson(row.contract_json, {}) })) : [];
    const pack = buildContextPack({ id: id('pack'), projectId, selection, documents, brief: brief ? { ...brief, content: parseJson(brief.content_json, {}) } : null, workflow: workflow ? { ...workflow, tasks: parseJson(workflow.tasks_json, []) } : null, repository, contracts, timestamp: now(), legacySources });
    await this.repository.createPackRecord({ pack, projectId, legacySourceIds: legacySources.map((source) => source.id), selection, actor, auditId: id('aud') });
    return viewPack(await this.repository.pack(pack.id));
  }

  async rebuild(projectId, input = {}, actor = 'local-user') {
    await this.requireProject(projectId);
    const timestamp = now();
    const jobId = id('cpj');
    const mode = input.mode === 'index_rebuild' ? 'index_rebuild' : input.mode === 'incremental' ? 'incremental' : 'full';
    const attempt = Math.max(1, Number(input.attempt || 1));
    await this.repository.createProjectionJob({ jobId, projectId, mode, attempt, retryOfJobId: input.retry_of_job_id, timestamp, actor, auditId: id('aud') });
    if (input.async === true) {
      const operation = this.operations ? await this.operations.create({ kind: 'context.projection', resourceType: 'context_projection_job', resourceId: jobId, actor, executor: ({ signal }) => this.worker.run(jobId, projectId, { actor, signal }) }) : { operation_id: null, status: 'queued', resource_id: jobId, cursor: 0, revision: 1 };
      await this.repository.setProjectionOperation(jobId, operation.operation_id);
      return { operation_id: operation.operation_id, status: 'queued', resource_id: jobId, job_id: jobId, cursor: 0, revision: 1 };
    }
    return this.worker.run(jobId, projectId, { actor });
  }

  async result(jobId, projectId) {
    return { job: viewJob(await this.repository.job(jobId, projectId)), map: await this.map(projectId) };
  }

  async status(projectId) {
    await this.requireProject(projectId);
    const jobs = await this.repository.jobs(projectId);
    const latest = jobs[0] || null;
    return { ...(viewJob(latest) || { project_id: projectId, status: 'queued', phase: 'queued', revision: 0 }), index: await this.indexStatus(projectId), jobs: jobs.map(viewJob) };
  }

  async job(projectId, jobId) {
    await this.requireProject(projectId);
    const row = await this.repository.job(jobId, projectId);
    if (!row) throw new AppError('not_found', 'context projection job not found');
    return viewJob(row);
  }

  async policyHistory(projectId) {
    await this.requireProject(projectId);
    return (await this.repository.policies(projectId)).map((row) => ({ ...row, policy: jsonField(row, 'policy_json', {}) }));
  }

  async events(projectId, jobId, after = 0) {
    await this.requireProject(projectId);
    if (!(await this.repository.job(jobId, projectId))) throw new AppError('not_found', 'context projection job not found');
    return (await this.repository.events(jobId, after)).map((event) => ({ cursor: event.cursor, job_id: event.job_id, project_id: event.project_id, type: event.type, data: parseJson(event.data_json, {}), created_at: event.created_at }));
  }

  async cancel(projectId, jobId, expectedRevision, actor = 'local-user', { skipOperation = false } = {}) {
    const job = await this.repository.job(jobId, projectId);
    if (!job) throw new AppError('not_found', 'context projection job not found');
    assert(Number.isInteger(Number(expectedRevision)) && Number(expectedRevision) > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (Number(expectedRevision) !== Number(job.revision)) throw new AppError('revision_conflict', 'context projection revision changed', { status: 409, details: { current_revision: job.revision } });
    // A projection started through the operation service has two durable
    // records. Cancel the operation first so its AbortSignal reaches the
    // worker; the registered handler re-enters this method with the guard.
    if (!skipOperation && job.operation_id && this.operations) {
      const operation = await this.operations.get(job.operation_id).catch(() => null);
      if (operation && !['completed', 'failed', 'cancelled'].includes(operation.status)) {
        await this.operations.cancel(job.operation_id, { expected_revision: operation.revision });
        return viewJob(await this.repository.job(jobId, projectId));
      }
    }
    const timestamp = now();
    await this.repository.cancelProjection({ jobId, projectId, expectedRevision, timestamp, actor, auditId: id('aud') });
    return viewJob(await this.repository.job(jobId, projectId));
  }

  async retry(projectId, jobId, expectedRevision, actor = 'local-user') {
    const prior = await this.repository.job(jobId, projectId);
    if (!prior) throw new AppError('not_found', 'context projection job not found');
    assert(Number.isInteger(Number(expectedRevision)) && Number(expectedRevision) > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (Number(expectedRevision) !== Number(prior.revision)) throw new AppError('revision_conflict', 'context projection revision changed', { status: 409, details: { current_revision: prior.revision } });
    if (!['failed', 'cancelled'].includes(prior.status)) throw new AppError('invalid_state', 'only failed or cancelled projections can be retried', { status: 409, details: { status: prior.status } });
    return this.rebuild(projectId, { mode: prior.mode, retry_of_job_id: jobId, attempt: Number(prior.attempt || 1) + 1, async: true }, actor);
  }

  async recover() {
    const jobs = await this.repository.recoveryJobs();
    for (const job of jobs) await this.worker.run(job.id, job.project_id, { actor: 'system-recovery' }).catch(async (error) => {
      if (error?.code === 'context_projection_inputs_changed') await this.repository.markProjectionInputsChanged(job.id, now());
    });
    return jobs.length;
  }

  async projectRecords(projectId, records, { job, actor = 'local-user', signal } = {}) {
    const timestamp = now();
    const rootUri = `aiws://context/${projectId}`;
    const rootId = `ctx_${sha256(`root:${projectId}`).slice(0, 32)}`;
    const desired = new Map();
    desired.set(rootId, { id: rootId, project_id: String(projectId), parent_id: null, uri: rootUri, stable_uri: rootUri, title: 'Context', kind: 'root', source_type: 'root', source_id: String(projectId), source_revision: '1', source_hash: sha256(rootUri), path: '', authority: 'authoritative', sensitivity: 'normal', required_scopes: ['context:read'], freshness: { status: 'current', checked_at: timestamp }, sort: { type_order: 0, order_index: 0, stable_id: rootId }, resource: { schema_version: 'aiws.context_resource.v1' }, content: JSON.stringify({ project_id: projectId }), record: true });
    for (const record of records) {
      const nodeId = `ctx_${sha256(`${projectId}:${record.source_type}:${record.source_id}`).slice(0, 32)}`;
      const uri = `${rootUri}/${encodeURIComponent(record.source_type)}/${encodeURIComponent(record.source_id)}`;
      desired.set(nodeId, { ...record, id: nodeId, project_id: String(projectId), parent_id: rootId, uri, stable_uri: uri, path: record.path || '', freshness: { status: 'current', source_revision: record.source_revision, checked_at: timestamp }, sort: { type_order: typeOrder(record.kind), order_index: 0, stable_id: nodeId }, status: 'active' });
    }
    const existing = await this.repository.nodes(projectId);
    const versionRows = [];
    const nodeRows = [];
    const resolvedIds = new Map();
    let createdVersions = 0;
    let reusedVersions = 0;
    let index = 0;
    for (const value of desired.values()) {
      if (signal?.aborted) throw new AppError('operation_cancelled', 'context projection was cancelled', { status: 409 });
      const previous = existing.find((node) => node.uri === value.uri);
      const resolvedId = previous?.id || value.id;
      resolvedIds.set(String(value.id), resolvedId);
      const normalizedSensitivity = SENSITIVITY.has(value.sensitivity) ? value.sensitivity : value.sensitivity === 'secret' ? 'restricted' : 'sensitive';
      const content = String(value.content || '');
      const sourceHash = /^[a-f0-9]{64}$/.test(String(value.source_hash || '')) ? String(value.source_hash) : sha256(content);
      let version = previous ? await this.repository.versionByHash(resolvedId, sourceHash) : null;
      if (!version) {
        const versionNo = Number((await this.repository.latestVersion(resolvedId))?.version || 0) + 1;
        const versionId = id('cdv');
        const cas = this.writeCas(content, sourceHash);
        version = { id: versionId, node_id: resolvedId, version: versionNo, content_hash: sourceHash, source_hash: sourceHash, token_estimate: Math.ceil(content.length / 4), renderer_version: 'context-renderer-v5', cas_hash: sourceHash, cas_path: cas.relative, storage_kind: 'cas', content: '' };
        versionRows.push({ ...version, created_at: timestamp, source_type: value.source_type, source_id: value.source_id, source_revision: value.source_revision });
        createdVersions += 1;
      } else reusedVersions += 1;
      const freshness = value.freshness || { status: 'current', checked_at: timestamp };
      nodeRows.push({ node_id: resolvedId, params: [resolvedId, projectId, value.parent_id, value.uri, value.title, value.kind, normalizedSensitivity, previous?.created_at || timestamp, timestamp, value.stable_uri, value.source_type, value.source_id, value.source_revision, sourceHash, value.path || '', version.id, value.authority || 'observed', asJson(freshness), asJson(value.required_scopes || ['context:read']), asJson(value.sort || { type_order: 100, order_index: index }), asJson(value.resource || {}), 'active', Number(previous?.revision || 1), null] });
      index += 1;
    }
    const desiredUris = new Set([...desired.values()].map((item) => item.uri));
    const tombstoneIds = existing.filter((old) => !desiredUris.has(old.uri) && old.status !== 'tombstone').map((old) => old.id);
    const edgeRows = [];
    for (const value of desired.values()) if (value.parent_id) {
      const parentId = resolvedIds.get(String(value.parent_id)) || value.parent_id;
      const childId = resolvedIds.get(String(value.id)) || value.id;
      edgeRows.push({ parent_id: parentId, child_id: childId, created_at: timestamp, edge_id: `edge_${sha256(`${parentId}:${childId}:contains`).slice(0, 24)}`, order_index: Number(value.sort?.order_index || 0) });
    }
    await this.repository.persistProjection({ versionRows, nodeRows, tombstoneIds, edgeRows, timestamp });
    const nodes = (await this.repository.nodes(projectId)).map(viewNode);
    const versions = [];
    for (const node of nodes) {
      const version = node.current_document_version_id ? await this.repository.version(node.current_document_version_id) : null;
      if (version) versions.push({ ...version, content: await this.documentContent(version) });
    }
    return { nodes, versions, edges: await this.repository.edges(projectId), stats: { source_count: records.length, node_count: nodes.length, document_versions_created: createdVersions, document_versions_reused: reusedVersions, tombstones: nodes.filter((node) => node.status === 'tombstone').length } };
  }

  async rebuildIndex(projectId, nodes, versions, edges) {
    const indexed = buildIndex({ nodes, versions, edges });
    const payload = serializeIndex(indexed.index, { snapshotHash: indexed.snapshotHash, indexHash: indexed.indexHash });
    const file = indexFile(this.config.home, projectId);
    writeIndexAtomic(file, payload);
    this.indexes.set(String(projectId), { index: indexed.index, payload, file });
    const timestamp = now();
    const snapshotId = id('cidx');
    await this.repository.persistIndexSnapshot({ snapshotId, projectId, payload, documentCount: indexed.documents.length, timestamp });
    return { ...indexed, file };
  }

  async rebuildIndexFromStorage(projectId) {
    const nodes = (await this.repository.nodes(projectId)).map(viewNode);
    if (!nodes.length) return null;
    const versions = [];
    for (const node of nodes) {
      if (!node.current_document_version_id) continue;
      const version = await this.repository.version(node.current_document_version_id);
      if (version) versions.push({ ...version, content: await this.documentContent(version) });
    }
    const edges = await this.repository.edges(projectId);
    return (await this.rebuildIndex(projectId, nodes, versions, edges)).index;
  }

  async loadIndex(projectId) {
    const file = indexFile(this.config.home, projectId);
    const cached = this.indexes.get(String(projectId));
    // Do not let an in-memory index mask a deleted or replaced durable
    // snapshot. This keeps corruption/missing-file recovery observable after
    // a long-running API process has already served a search.
    if (!fs.existsSync(file)) {
      this.indexes.delete(String(projectId));
      return null;
    }
    const payload = readIndexPayload(file);
    if (!payload) return null;
    try {
      const index = loadIndex(payload);
      if (cached?.payload?.index_hash === payload.index_hash) return cached.index;
      const latest = await this.repository.latestIndex(projectId);
      if (latest && latest.index_hash !== payload.index_hash) return null;
      this.indexes.set(String(projectId), { index, payload, file });
      return index;
    } catch {
      return null;
    }
  }

  async indexStatus(projectId) {
    const latest = await this.repository.latestIndex(projectId);
    const file = indexFile(this.config.home, projectId);
    const exists = fs.existsSync(file);
    let valid = Boolean(latest && exists);
    if (valid) {
      const payload = readIndexPayload(file);
      try { loadIndex(payload); } catch { valid = false; }
      if (payload && latest.index_hash && payload.index_hash !== latest.index_hash) valid = false;
    }
    return { status: latest && valid ? 'ready' : latest ? 'degraded' : 'unavailable', schema_version: latest?.schema_version || 'aiws.context_index.v2', snapshot_hash: latest?.snapshot_hash || null, index_hash: latest?.index_hash || null, document_count: Number(latest?.document_count || 0) };
  }

  writeCas(content, contentHash) {
    const root = path.resolve(this.config.casRoot || path.join(this.config.home, 'cas', 'sha256'));
    const file = path.join(root, contentHash.slice(0, 2), contentHash);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) {
      const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    return { absolute: file, relative: path.posix.join('sha256', contentHash.slice(0, 2), contentHash) };
  }

  async documentContent(version) {
    if (version.storage_kind === 'cas' && version.cas_path) {
      const hash = String(version.cas_hash || version.content_hash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new AppError('context_projection_unavailable', 'context document CAS reference is invalid', { status: 503, details: { reason: 'cas_invalid' } });
      const configuredRoot = path.resolve(this.config.casRoot || path.join(this.config.home, 'cas', 'sha256'));
      const file = path.resolve(configuredRoot, hash.slice(0, 2), hash);
      if (!file.startsWith(`${configuredRoot}${path.sep}`)) throw new AppError('context_projection_unavailable', 'context document CAS reference is outside the CAS root', { status: 503, details: { reason: 'cas_invalid' } });
      try { return fs.readFileSync(file, 'utf8'); } catch { throw new AppError('context_projection_unavailable', 'context document CAS content is unavailable', { status: 503, details: { reason: 'cas_missing' } }); }
    }
    return String(version.content || '');
  }
}

function typeOrder(kind) {
  return ({ project: 10, brief: 20, repository: 30, workflow: 40, node_contract: 50, note: 60, file: 70, diff: 80, test_report: 90 }[kind] || 100);
}
