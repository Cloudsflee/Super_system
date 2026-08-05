import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../apps/api/src/database.mjs';
import { Domain } from '../../apps/api/src/domain.mjs';
import { eventually } from './helpers.mjs';

const digest = `sha256:${'c'.repeat(64)}`;

class ControlledBroker {
  constructor() {
    this.jobs = new Map();
    this.submissions = [];
  }

  async probe() {
    return { ready: true, executor: 'controlled', runner_digest: digest };
  }

  async submit(spec) {
    const activeBefore = [...this.jobs.values()].filter((job) => ['queued', 'running'].includes(job.status));
    const job = {
      job_id: `job_${randomUUID().replaceAll('-', '')}`,
      status: 'running',
      spec,
      active_before: activeBefore.map((entry) => entry.spec.execution_mode)
    };
    this.jobs.set(job.job_id, job);
    this.submissions.push(job);
    return { job_id: job.job_id, status: 'running' };
  }

  async status(jobId) {
    return this.jobs.get(jobId) || { job_id: jobId, status: 'unknown' };
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (job && !['completed', 'failed', 'cancelled'].includes(job.status)) job.status = 'cancelled';
    return job || { job_id: jobId, status: 'unknown' };
  }

  complete(job) {
    job.status = 'completed';
    job.result = { exit_code: 0, output_paths: job.spec.output_paths || [] };
  }

  fail(job) {
    job.status = 'failed';
    job.result = { exit_code: 1 };
  }
}

async function domainFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-scheduler-'));
  const databaseFile = path.join(home, 'data', 'state.sqlite');
  const db = await openDatabase(databaseFile);
  const broker = new ControlledBroker();
  const config = {
    version: '3.0.0', apiPrefix: '/api/v1', home, databaseFile,
    casRoot: path.join(home, 'cas', 'sha256'), dataVolume: 'aiws-data-v3',
    runnerDigest: digest, codexAvailable: false, githubAvailable: false
  };
  const domain = new Domain({ db, config, broker });
  const project = await domain.createProject({ name: 'Scheduler fixture', repository: { local_path: 'projects/shared' } });
  await domain.createBrief(project.id, { content: { objective: 'Verify repository scheduling' } });
  return { home, databaseFile, db, broker, config, domain, project };
}

async function executionFor(domain, projectId, workflowRevision) {
  return domain.createExecution(projectId, { workflow_revision: workflowRevision });
}

test('repository scheduler allows two reads and keeps a write exclusive across executions', async () => {
  const env = await domainFixture();
  try {
    const readWorkflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'inspect', level: 1, mode: 'read' }] });
    const reads = await Promise.all([1, 2, 3].map(() => executionFor(env.domain, env.project.id, readWorkflow.revision)));
    const writeWorkflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'change', level: 1, mode: 'write' }] });
    const writer = await executionFor(env.domain, env.project.id, writeWorkflow.revision);

    await env.domain.startExecution(reads[0].id, { expected_revision: reads[0].revision });
    let observed = await eventually(() => env.broker.submissions.length, (count) => count === 1);
    assert.equal(observed, 1);
    await Promise.all(reads.slice(1).map((execution) => env.domain.startExecution(execution.id, { expected_revision: execution.revision })));
    observed = await eventually(() => env.broker.submissions.length, (count) => count === 2);
    assert.equal(observed, 2);
    await env.domain.startExecution(writer.id, { expected_revision: writer.revision });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(env.broker.submissions.length, 2);
    assert.ok(env.broker.submissions.every((job) => job.spec.execution_mode === 'read'));

    env.broker.complete(env.broker.submissions[0]);
    observed = await eventually(() => env.broker.submissions.length, (count) => count === 3);
    assert.equal(observed, 3);
    assert.ok(env.broker.submissions.every((job) => job.spec.execution_mode === 'read'));
    for (const job of env.broker.submissions) env.broker.complete(job);

    const writeJob = await eventually(
      () => env.broker.submissions.find((job) => job.spec.execution_mode === 'write'),
      Boolean
    );
    assert.ok(writeJob);
    assert.deepEqual(writeJob.active_before, []);
    assert.ok(env.broker.submissions.filter((job) => job.spec.execution_mode === 'read').every((job) => job.active_before.length <= 1));
    env.broker.complete(writeJob);
    for (const execution of [...reads, writer]) {
      const final = await eventually(() => env.domain.getExecution(execution.id), (value) => value.status === 'completed');
      assert.equal(final.status, 'completed');
    }
  } finally {
    await env.db.close();
  }
});

test('stale cancellation has no side effects and a committed cancellation releases the repository', async () => {
  const env = await domainFixture();
  try {
    const readWorkflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'inspect', level: 1, mode: 'read' }] });
    const read = await executionFor(env.domain, env.project.id, readWorkflow.revision);
    const writeWorkflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'change', level: 1, mode: 'write' }] });
    const writer = await executionFor(env.domain, env.project.id, writeWorkflow.revision);
    const startedRead = await env.domain.startExecution(read.id, { expected_revision: read.revision });
    const readJob = await eventually(() => env.broker.submissions[0], Boolean);
    await env.domain.startExecution(writer.id, { expected_revision: writer.revision });

    await assert.rejects(
      env.domain.cancelExecution(read.id, { expected_revision: read.revision }),
      (error) => error.code === 'revision_conflict'
    );
    assert.equal(readJob.status, 'running');
    assert.equal((await env.db.get("SELECT count(*) AS count FROM audit_events WHERE action='execution.cancelled' AND entity_id=?", [read.id])).count, 0);

    const cancelled = await env.domain.cancelExecution(read.id, { expected_revision: startedRead.revision });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(readJob.status, 'cancelled');
    const writeJob = await eventually(
      () => env.broker.submissions.find((job) => job.spec.execution_mode === 'write'),
      Boolean
    );
    assert.ok(writeJob);
    assert.deepEqual(writeJob.active_before, []);
    env.broker.complete(writeJob);
    const final = await eventually(() => env.domain.getExecution(writer.id), (value) => value.status === 'completed');
    assert.equal(final.status, 'completed');
  } finally {
    await env.db.close();
  }
});

test('a second runner failure pauses for a human retry and creates a new immutable attempt', async () => {
  const env = await domainFixture();
  try {
    const workflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'inspect', level: 1, mode: 'read' }] });
    const execution = await executionFor(env.domain, env.project.id, workflow.revision);
    await env.domain.startExecution(execution.id, { expected_revision: execution.revision });
    const first = await eventually(() => env.broker.submissions[0], Boolean);
    env.broker.fail(first);
    const second = await eventually(() => env.broker.submissions[1], Boolean);
    assert.ok(second);
    env.broker.fail(second);
    const paused = await eventually(() => env.domain.getExecution(execution.id), (value) => value.status === 'awaiting_human');
    assert.equal(paused.tasks[0].attempt_no, 2);
    assert.equal(paused.tasks[0].status, 'awaiting_human');

    await env.domain.startExecution(execution.id, { expected_revision: paused.revision, mode: 'human_retry' });
    const third = await eventually(() => env.broker.submissions[2], Boolean);
    assert.ok(third);
    env.broker.complete(third);
    const completed = await eventually(() => env.domain.getExecution(execution.id), (value) => value.status === 'completed');
    assert.equal(completed.tasks[0].attempt_no, 3);
    assert.equal(completed.tasks[0].mode, 'human_retry');
  } finally {
    await env.db.close();
  }
});

test('restart recovery rebuilds repository reservations before dispatching pending work', async () => {
  const env = await domainFixture();
  let db = env.db;
  try {
    const readWorkflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'inspect', level: 1, mode: 'read' }] });
    const read = await executionFor(env.domain, env.project.id, readWorkflow.revision);
    const writeWorkflow = await env.domain.createWorkflow(env.project.id, { tasks: [{ id: 'change', level: 1, mode: 'write' }] });
    const writer = await executionFor(env.domain, env.project.id, writeWorkflow.revision);
    const recoveredJob = {
      job_id: 'job_recovered_read', status: 'running',
      spec: { execution_mode: 'read', output_paths: [] }
    };
    env.broker.jobs.set(recoveredJob.job_id, recoveredJob);
    await db.transaction([
      { sql: "UPDATE executions SET status='running',revision=revision+1 WHERE id=?", params: [read.id] },
      { sql: "UPDATE task_attempts SET status='running',broker_job_id=?,started_at=? WHERE execution_id=?", params: [recoveredJob.job_id, new Date().toISOString(), read.id] },
      { sql: "UPDATE executions SET status='running',revision=revision+1 WHERE id=?", params: [writer.id] }
    ]);
    await db.close();
    db = await openDatabase(env.databaseFile);
    const recovered = new Domain({ db, config: env.config, broker: env.broker });
    assert.equal(await recovered.recover(), 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(env.broker.submissions.length, 0);

    env.broker.complete(recoveredJob);
    const writeJob = await eventually(() => env.broker.submissions[0], Boolean);
    assert.ok(writeJob);
    assert.equal(writeJob.spec.execution_mode, 'write');
    assert.deepEqual(writeJob.active_before, []);
    env.broker.complete(writeJob);
    assert.equal((await eventually(() => recovered.getExecution(read.id), (value) => value.status === 'completed')).status, 'completed');
    assert.equal((await eventually(() => recovered.getExecution(writer.id), (value) => value.status === 'completed')).status, 'completed');
  } finally {
    await db.close();
  }
});
