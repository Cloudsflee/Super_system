import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { contextIndexableNodes, contextSearchIndexSnapshotHash } from '../../../packages/system-context/src/index.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { readCasBlob } from './asset-cas.mjs';
import { CONTEXT_INDEX_DIR } from './config.mjs';
import { materializeContextDocumentsInState } from './context-projection.mjs';
import { mutate, readStateSnapshot } from './state.mjs';

const INDEX_FILE = path.join(CONTEXT_INDEX_DIR, 'minisearch-v1.json');
let activeCoordinator = null;

export function startContextProjectorCoordinator({ intervalMs = 250, batchSize = 25, leaseMs = 30_000 } = {}) {
  if (activeCoordinator) return () => activeCoordinator.stop();
  const coordinator = new ContextProjectorCoordinator({ intervalMs, batchSize, leaseMs });
  activeCoordinator = coordinator;
  coordinator.start();
  return () => {
    coordinator.stop();
    if (activeCoordinator === coordinator) activeCoordinator = null;
  };
}

export function contextProjectorRuntimeStatus() {
  return (
    activeCoordinator?.publicStatus() || {
      state: 'stopped',
      holder: null,
      heartbeat_at: null,
      worker_thread_id: null,
      event_loop_lag_ms: null
    }
  );
}

export class ContextProjectorCoordinator {
  constructor({ intervalMs, batchSize, leaseMs }) {
    this.intervalMs = Math.max(50, Number(intervalMs) || 250);
    this.batchSize = Math.max(1, Math.min(100, Number(batchSize) || 25));
    this.leaseMs = Math.max(1_000, Number(leaseMs) || 30_000);
    this.holder = `context-projector:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.pending = new Map();
    this.sequence = 0;
    this.running = false;
    this.stopped = false;
    this.status = {
      state: 'starting',
      holder: this.holder,
      heartbeat_at: null,
      worker_thread_id: null,
      event_loop_lag_ms: 0,
      last_error_code: null,
      last_batch: null
    };
  }

  start() {
    this.ensureWorker();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.status.state = 'stopped';
    for (const pending of this.pending.values()) pending.reject(workerError('context_projection_worker_stopped'));
    this.pending.clear();
    await this.worker?.terminate().catch(() => undefined);
    this.worker = null;
  }

  publicStatus() {
    return { ...this.status };
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    const scheduledAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.status.event_loop_lag_ms = Math.max(0, Date.now() - scheduledAt);
    this.status.state = 'running';
    this.status.heartbeat_at = now();
    try {
      const claimed = await mutate((state) =>
        claimContextProjectionJobsInState(state, {
          holder: this.holder,
          batchSize: this.batchSize,
          leaseMs: this.leaseMs,
          timestamp: now()
        })
      );
      if (!claimed.node_ids.length) {
        if (!this.lastPersistedAt || Date.now() - this.lastPersistedAt >= 1_000)
          await this.persistStatus({ claimed: 0, attempted: 0, materialized: 0, failed: 0 });
        return;
      }
      const result = await mutate((state) =>
        materializeContextDocumentsInState(state, {
          nodeIds: claimed.node_ids,
          maxJobs: this.batchSize,
          leaseHolder: this.holder,
          leaseMs: this.leaseMs,
          renderer: (payload) => this.request('render', payload)
        })
      );
      let index = null;
      if (result.materialized || result.reused) index = await this.rebuildIndex();
      await this.persistStatus({ claimed: claimed.node_ids.length, ...result, index });
      this.status.last_error_code = null;
    } catch (error) {
      this.status.last_error_code = safeCode(error);
      await this.persistStatus({ error_code: this.status.last_error_code }).catch(() => undefined);
      this.restartWorker();
    } finally {
      this.status.heartbeat_at = now();
      this.running = false;
    }
  }

  async rebuildIndex() {
    const state = await readStateSnapshot(),
      nodes = contextIndexableNodes(state.context_nodes),
      snapshotHash = contextSearchIndexSnapshotHash(nodes),
      documentVersions = state.context_document_versions.filter((version) =>
        nodes.some((node) => node.current_version_id === version.id)
      ),
      documents = await Promise.all(
        documentVersions.map(async (version) => ({
          id: version.id,
          markdown: (await readCasBlob(version.cas_ref)).toString('utf8')
        }))
      ),
      rebuiltAt = now(),
      built = await this.request('index', {
        nodes: state.context_nodes,
        documentVersions,
        edges: state.context_edges,
        documents,
        snapshotHash,
        rebuiltAt
      });
    await fsp.mkdir(CONTEXT_INDEX_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(built.payload), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, INDEX_FILE);
    return { snapshot_hash: snapshotHash, rebuilt_at: rebuiltAt, node_count: built.node_count };
  }

  async persistStatus(batch) {
    this.lastPersistedAt = Date.now();
    this.status.last_batch = { ...batch, completed_at: now() };
    await mutate((state) => {
      const previous = state.context_projector_status || {},
        pending = state.context_projection_jobs.filter((item) => item.status === 'pending'),
        oldest = pending
          .map((item) => Date.parse(item.created_at || item.updated_at || ''))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)[0];
      state.context_projector_status = {
        schema_version: 'aiws.context_projector_status.v1',
        state: this.status.state,
        holder: this.holder,
        heartbeat_at: this.status.heartbeat_at,
        worker_thread_id: this.status.worker_thread_id,
        event_loop_lag_ms: this.status.event_loop_lag_ms,
        lease_ms: this.leaseMs,
        batch_size: this.batchSize,
        active_leases: state.context_projection_jobs.filter(
          (item) => item.status === 'running' && Date.parse(item.lease?.expires_at || '') > Date.now()
        ).length,
        oldest_pending_age_ms: oldest ? Math.max(0, Date.now() - oldest) : 0,
        failed_jobs: state.context_projection_jobs.filter((item) => item.status === 'failed').length,
        recovered_expired_leases: Number(previous.recovered_expired_leases || 0) + Number(batch.recovered || 0),
        index_generation: Number(previous.index_generation || 0) + (batch.index ? 1 : 0),
        index: batch.index || previous.index || null,
        automatic_rebuild: batch.index ? 'completed' : batch.error_code ? 'failed' : 'idle',
        last_error_code: batch.error_code || null,
        last_batch: this.status.last_batch
      };
      return state.context_projector_status;
    });
  }

  ensureWorker() {
    if (this.worker) return;
    const worker = new Worker(new URL('./context-projection-worker.mjs', import.meta.url));
    this.worker = worker;
    this.status.worker_thread_id = worker.threadId;
    worker.on('message', (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(workerError(message.error?.code, message.error?.message));
    });
    worker.on('error', (error) => this.rejectWorker(error));
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0 && !this.stopped) {
        this.rejectWorker(workerError('context_projection_worker_exited'));
        this.ensureWorker();
      }
    });
  }

  request(type, payload) {
    this.ensureWorker();
    const id = `${process.pid}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  rejectWorker(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.status.last_error_code = safeCode(error);
  }

  restartWorker() {
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate().catch(() => undefined);
    if (!this.stopped) this.ensureWorker();
  }
}

export function claimContextProjectionJobsInState(state, { holder, batchSize, leaseMs, timestamp }) {
  let recovered = 0;
  for (const job of state.context_projection_jobs.filter((item) => item.status === 'running')) {
    if (Date.parse(job.lease?.expires_at || '') > Date.parse(timestamp)) continue;
    Object.assign(job, {
      status: 'pending',
      lease: null,
      error_code: 'context_projection_lease_expired',
      updated_at: timestamp
    });
    recovered += 1;
  }
  const jobs = state.context_projection_jobs
    .filter((item) => {
      const retryAt = Date.parse(item.next_retry_at || '');
      return (
        item.status === 'pending' ||
        (item.status === 'failed' &&
          Number(item.attempts || 0) < 3 &&
          (!Number.isFinite(retryAt) || retryAt <= Date.now()))
      );
    })
    .sort(
      (left, right) =>
        String(left.created_at).localeCompare(String(right.created_at)) ||
        String(left.id).localeCompare(String(right.id))
    )
    .slice(0, batchSize);
  for (const job of jobs) {
    job.status = 'running';
    job.lease = {
      holder,
      acquired_at: timestamp,
      expires_at: new Date(Date.parse(timestamp) + leaseMs).toISOString()
    };
    job.updated_at = timestamp;
  }
  return { node_ids: jobs.map((item) => item.node_id), recovered };
}

function workerError(code, message = code) {
  const error = new Error(message || code);
  error.code = code || 'context_projection_worker_failed';
  return error;
}

function safeCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || ''))
    ? String(error.code)
    : 'context_projector_coordinator_failed';
}
