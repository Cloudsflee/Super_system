import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { now } from '../../../packages/shared/index.mjs';
import {
  finalizeClaimedContextProjectionsInState,
  prepareClaimedContextProjection,
  releaseContextProjectionLeasesInState
} from './context-projection.mjs';
import { mutate, readStateSnapshot } from './state.mjs';
import { hasRunnableContextProjectionJobs } from './state-store.mjs';
import { ensureContextSearchIndex } from './context-index-runtime.mjs';

let activeCoordinator = null;

export function startContextProjectorCoordinator({ intervalMs = 250, batchSize = 25, leaseMs = 30_000 } = {}) {
  if (activeCoordinator) return () => activeCoordinator.stop();
  const coordinator = new ContextProjectorCoordinator({ intervalMs, batchSize, leaseMs });
  activeCoordinator = coordinator;
  coordinator.start();
  return async () => {
    await coordinator.stop();
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
    this.claimedJobIds = new Set();
    this.sequence = 0;
    this.stopped = false;
    this.currentTick = null;
    this.stopPromise = null;
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

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  async stopInternal() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.status.state = 'draining';
    const worker = this.worker;
    this.worker = null;
    for (const operation of this.pending.values()) operation.reject(workerError('context_projection_worker_stopped'));
    this.pending.clear();
    await worker?.terminate().catch(() => undefined);
    await this.currentTick?.catch(() => undefined);
    const claimed = [...this.claimedJobIds];
    let released = 0;
    if (claimed.length)
      released = await mutate((state) =>
        releaseContextProjectionLeasesInState(state, { holder: this.holder, jobIds: claimed, timestamp: now() })
      ).catch(() => 0);
    this.claimedJobIds.clear();
    this.status.state = 'stopped';
    this.status.heartbeat_at = now();
    this.status.last_batch = { stopped: true, released, completed_at: this.status.heartbeat_at };
  }

  publicStatus() {
    return { ...this.status };
  }

  tick() {
    if (this.currentTick || this.stopped) return this.currentTick;
    this.currentTick = this.runTick().finally(() => {
      this.currentTick = null;
    });
    return this.currentTick;
  }

  async runTick() {
    const scheduledAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.status.event_loop_lag_ms = Math.max(0, Date.now() - scheduledAt);
    this.status.heartbeat_at = now();
    this.status.state = 'running';
    try {
      if (!(await hasRunnableContextProjectionJobs(this.status.heartbeat_at))) {
        this.status.state = 'idle';
        return;
      }
      const claimed = await mutate((state) =>
        claimContextProjectionJobsInState(state, {
          holder: this.holder,
          batchSize: this.batchSize,
          leaseMs: this.leaseMs,
          timestamp: now()
        })
      );
      for (const job of claimed.jobs) this.claimedJobIds.add(job.job_id);
      if (!claimed.jobs.length) {
        if (claimed.recovered || claimed.superseded)
          await this.persistStatus({
            claimed: 0,
            attempted: 0,
            materialized: 0,
            failed: 0,
            recovered: claimed.recovered,
            superseded: claimed.superseded
          });
        return;
      }

      const snapshot = await readStateSnapshot(),
        prepared = await Promise.all(
          claimed.jobs.map(async (claim) => {
            try {
              const artifact = await prepareClaimedContextProjection(snapshot, claim, {
                renderer: (payload) => this.request('render', payload)
              });
              return { artifact };
            } catch (error) {
              return { failure: { job_id: claim.job_id, node_id: claim.node_id, error } };
            }
          })
        );
      if (this.stopped) return;
      const artifacts = prepared.map((item) => item.artifact).filter(Boolean),
        failures = prepared.map((item) => item.failure).filter(Boolean),
        result = await mutate((state) =>
          finalizeClaimedContextProjectionsInState(state, {
            holder: this.holder,
            artifacts,
            failures,
            timestamp: now()
          })
        );
      for (const job of claimed.jobs) this.claimedJobIds.delete(job.job_id);
      let index = null;
      if (result.materialized || result.reused) index = await this.rebuildIndex();
      await this.persistStatus({
        claimed: claimed.jobs.length,
        recovered: claimed.recovered,
        ...result,
        index
      });
      this.status.last_error_code = failures[0] ? safeCode(failures[0].error) : null;
      if (failures.some((item) => /worker_(?:exited|failed|stopped)/.test(safeCode(item.error)))) this.restartWorker();
    } catch (error) {
      if (this.stopped) return;
      this.status.last_error_code = safeCode(error);
      this.status.state = 'failed';
      await this.persistStatus({ error_code: this.status.last_error_code }).catch(() => undefined);
      this.restartWorker();
    } finally {
      this.status.heartbeat_at = now();
      if (!this.stopped && this.status.state === 'running') this.status.state = 'idle';
    }
  }

  async rebuildIndex() {
    const built = await ensureContextSearchIndex(await readStateSnapshot());
    return { ...built.status, changed: !built.reused };
  }

  async persistStatus(batch) {
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
        index_generation: Number(previous.index_generation || 0) + (batch.index?.changed ? 1 : 0),
        index: batch.index || previous.index || null,
        automatic_rebuild: batch.index ? 'completed' : batch.error_code ? 'failed' : 'idle',
        last_error_code: batch.error_code || this.status.last_error_code || null,
        last_batch: this.status.last_batch
      };
      return state.context_projector_status;
    });
  }

  ensureWorker() {
    if (this.worker || this.stopped) return;
    const worker = new Worker(new URL('./context-projection-worker.mjs', import.meta.url));
    worker.unref?.();
    this.worker = worker;
    this.status.worker_thread_id = worker.threadId;
    worker.on('message', (message) => {
      const operation = this.pending.get(message.id);
      if (!operation) return;
      this.pending.delete(message.id);
      if (message.ok) operation.resolve(message.value);
      else operation.reject(workerError(message.error?.code, message.error?.message));
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
    if (!this.worker) return Promise.reject(workerError('context_projection_worker_stopped'));
    const id = `${process.pid}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  rejectWorker(error) {
    for (const operation of this.pending.values()) operation.reject(error);
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
  const instant = Date.parse(timestamp);
  let recovered = 0,
    superseded = 0;
  for (const job of state.context_projection_jobs.filter((item) => item.status === 'running')) {
    if (Date.parse(job.lease?.expires_at || '') > instant) continue;
    Object.assign(job, {
      status: 'pending',
      lease: null,
      error_code: 'context_projection_lease_expired',
      next_retry_at: null,
      updated_at: timestamp
    });
    recovered += 1;
  }
  const candidates = state.context_projection_jobs
    .filter((item) => {
      const retryAt = Date.parse(item.next_retry_at || '');
      return (
        item.status === 'pending' ||
        (item.status === 'failed' &&
          Number(item.attempts || 0) < 3 &&
          (!Number.isFinite(retryAt) || retryAt <= instant))
      );
    })
    .sort(
      (left, right) =>
        String(left.created_at).localeCompare(String(right.created_at)) ||
        String(left.id).localeCompare(String(right.id))
    );
  const claimed = [],
    legacyJobOnlyState = state.context_nodes.length === 0;
  for (const job of candidates) {
    if (claimed.length >= batchSize) break;
    const node = state.context_nodes.find((item) => item.id === job.node_id),
      nodeGeneration = Number(node?.source_generation || 0),
      expectedGeneration = Number.isInteger(job.expected_source_generation)
        ? Number(job.expected_source_generation)
        : nodeGeneration;
    if (!Number.isInteger(job.expected_source_generation)) job.expected_source_generation = expectedGeneration;
    if (
      (!node && !legacyJobOnlyState) ||
      (node && (node.source_hash !== job.expected_source_hash || nodeGeneration !== expectedGeneration))
    ) {
      Object.assign(job, {
        status: 'superseded',
        error_code: 'context_projection_job_superseded',
        lease: null,
        updated_at: timestamp,
        completed_at: timestamp
      });
      superseded += 1;
      continue;
    }
    job.status = 'running';
    job.attempts = Number(job.attempts || 0) + 1;
    job.lease = {
      holder,
      acquired_at: timestamp,
      expires_at: new Date(instant + leaseMs).toISOString()
    };
    job.updated_at = timestamp;
    claimed.push({
      job_id: job.id,
      node_id: job.node_id,
      expected_source_hash: job.expected_source_hash,
      expected_source_generation: expectedGeneration
    });
  }
  return { jobs: claimed, node_ids: claimed.map((item) => item.node_id), recovered, superseded };
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
