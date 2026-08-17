import { hashJson, now, id } from '../../crypto.mjs';
import { AppError } from '../../errors.mjs';

/* Small recoverable worker.  The service owns adapters/indexing; this class
 * owns durable phase transitions and cursor events so a restart can resume the
 * same input snapshot. */
export class ContextProjectionWorker {
  constructor({ repository, adapters, project, indexer, cas }) {
    this.repository = repository;
    this.adapters = adapters;
    this.project = project;
    this.indexer = indexer;
    this.cas = cas;
  }

  async run(jobId, projectId, { actor = 'local-user', expectedInputHash = null, signal } = {}) {
    let job = await this.repository.job(jobId, projectId);
    if (!job) throw new AppError('not_found', 'context projection job not found');
    if (job.status === 'completed') return this.project.result(jobId, projectId);
    if (job.status === 'cancelled') throw new AppError('operation_cancelled', 'context projection was cancelled', { status: 409 });
    const records = await this.adapters.collect(projectId);
    const inputHash = hashJson(records.map((record) => [record.source_type, record.source_id, record.source_revision, record.source_hash]));
    if (expectedInputHash && expectedInputHash !== inputHash) throw new AppError('context_projection_inputs_changed', 'projection inputs changed', { status: 409, details: { expected_input_hash: expectedInputHash, input_hash: inputHash } });
    if (job.input_hash && job.input_hash !== inputHash) throw new AppError('context_projection_inputs_changed', 'projection inputs changed', { status: 409 });
    job = await this.transition(job, 'running', { inputHash, actor });
    try {
      if (signal?.aborted) throw new AppError('operation_cancelled', 'context projection was cancelled', { status: 409 });
      const projection = await this.project.projectRecords(projectId, records, { job, actor, signal });
      job = await this.transition(job, 'indexing', { inputHash, stats: projection.stats, actor });
      if (signal?.aborted) throw new AppError('operation_cancelled', 'context projection was cancelled', { status: 409 });
      const indexed = await this.indexer.rebuild(projectId, projection.nodes, projection.versions, projection.edges);
      const timestamp = now();
      const stats = { ...projection.stats, index_document_count: indexed.documents.length };
      await this.repository.completeProjection({ jobId, projectId, revision: job.revision, cursor: records.length, inputHash, snapshotHash: indexed.snapshotHash, indexHash: indexed.indexHash, stats, timestamp, actor, auditId: id('aud'), nodeCount: projection.nodes.length });
      return this.project.result(jobId, projectId);
    } catch (error) {
      const code = String(error?.code || 'context_projection_failed');
      const status = code === 'operation_cancelled' ? 'cancelled' : 'failed';
      const timestamp = now();
      await this.repository.failProjection({ jobId, projectId, status, code, timestamp });
      throw error;
    }
  }

  async transition(job, status, { inputHash = job.input_hash || '', stats = null } = {}) {
    const timestamp = now();
    const phase = status;
    await this.repository.transitionProjection({ jobId: job.id, projectId: job.project_id, revision: job.revision, status, inputHash, stats, timestamp });
    return { ...job, status: status === 'running' ? 'running' : status, phase, input_hash: inputHash || job.input_hash || '', stats_json: stats ? JSON.stringify(stats) : job.stats_json, revision: Number(job.revision || 1) + 1 };
  }
}
