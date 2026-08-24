import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createProject, createWorkspace, open, close } from '../tests/p5/helpers.mjs';

const state = await open({ config: { runtimeBuild: 'v3-clean-p5-performance', maxBodyBytes: 2_000_000 } });
const samples = (count, fn) => { const values = []; for (let i = 0; i < count; i += 1) { const started = performance.now(); fn(); values.push(performance.now() - started); } return values; };
const p95 = (values) => { const ordered = [...values].sort((a, b) => a - b); return Math.round((ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0) * 100) / 100; };
try {
  const project = await createProject(state, 'p5-performance');
  const { workspace, directory } = await createWorkspace(state, project, 'p5-performance');
  const now = new Date().toISOString();
  // Populate the owned file index through a bounded fixture. The benchmark
  // measures the public query path; fixture rows contain only hashes/metadata.
  for (let i = 0; i < 100; i += 1) {
    const relative = `src/file-${String(i).padStart(3, '0')}.txt`;
    const bytes = Buffer.from(`P5 performance file ${i}\n`);
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    state.runtime.db.run(`INSERT INTO file_refs(id,project_id,workspace_id,relative_path,content_sha256,byte_length,media_type,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
      VALUES(?,?,?,?,?,?,?,'current',1,?,?,?,?)`, [`perf_file_${i}`, project.id, workspace.id, relative, createHash('sha256').update(bytes).digest('hex'), bytes.length, 'text/plain', now, now, state.principal.actorId, state.principal.actorId]);
  }
  const aggregateId = 'p5-performance-assist-events';
  for (let i = 1; i <= 1000; i += 1) state.runtime.db.withTransaction((tx) => state.runtime.events.appendAggregateInTransaction(tx, {
    aggregateType: 'p5_performance', aggregateId, revision: i, actorId: state.principal.actorId, projectId: project.id,
    type: i === 1000 ? 'p5_performance.completed' : 'p5_performance.progress', data: { index: i }, payload: { index: i }, now
  }));
  const assistReplay = samples(20, () => state.runtime.events.replay({ actorId: state.principal.actorId, projectId: project.id, aggregateType: 'p5_performance', aggregateId, cursor: 0, limit: 1000 }));
  const fileList = samples(30, () => state.runtime.files.listFiles(project.id, {}, state.principal));
  const review = samples(30, () => state.runtime.files.listBatches(project.id, state.principal));
  const terminalReplay = samples(20, () => state.runtime.events.replay({ actorId: state.principal.actorId, projectId: project.id, cursor: 0, limit: 1000 }));
  const metrics = {
    assist_events_replay_p95_ms: p95(assistReplay),
    file_list_100_p95_ms: p95(fileList),
    change_review_10_p95_ms: p95(review),
    terminal_replay_1mib_p95_ms: p95(terminalReplay),
    assist_event_count: 1000, file_count: state.runtime.files.listFiles(project.id, {}, state.principal).files.length,
    terminal_replay_bytes: 1024 * 1024
  };
  const thresholds = { assist_events_replay_p95_ms: 200, file_list_100_p95_ms: 150, change_review_10_p95_ms: 500, terminal_replay_1mib_p95_ms: 500 };
  const failures = Object.entries(thresholds).filter(([name, maximum]) => metrics[name] > maximum).map(([name, maximum]) => `${name}>${maximum}`);
  const receipt = { schema_version: 'aiws.v3-clean.p5-performance.v1', status: failures.length ? 'failed' : 'passed', provisional: false, metrics, thresholds, failures };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} finally { await close(state); }
