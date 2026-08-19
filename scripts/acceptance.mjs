import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { start as startApi } from '../apps/api/server-legacy.mjs';
import { start as startBroker } from '../apps/runner-broker/server.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-acceptance-'));
const secret = 'acceptance-secret';
const digest = `sha256:${'b'.repeat(64)}`;
const started = performance.now();
const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}` } });
const app = await startApi({ config: { version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0, home, databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas'), dataVolume: 'aiws-data-v3', brokerUrl: `http://127.0.0.1:${broker.server.address().port}`, brokerMode: 'http', brokerSecret: secret, runnerDigest: digest, codexAvailable: false, githubAvailable: false } });
const base = `http://127.0.0.1:${app.server.address().port}`;

async function call(route, body, key) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(json)}`);
  return json;
}

try {
  const project = await call('/api/v1/projects', { name: 'DesignSignal acceptance', repository: { local_path: 'projects/acceptance' } }, 'acceptance-project');
  await call(`/api/v1/projects/${project.id}/briefs`, { content: { objective: 'Acceptance fixture objective', acceptance: ['execution completes'] } }, 'acceptance-brief');
  await call(`/api/v1/projects/${project.id}/workflows`, { tasks: [{ id: 'inspect', level: 1, title: 'Inspect', mode: 'read' }, { id: 'deliver', level: 2, title: 'Deliver', mode: 'write', deps: ['inspect'] }] }, 'acceptance-workflow');
  const execution = await call(`/api/v1/projects/${project.id}/executions`, {}, 'acceptance-execution');
  await call(`/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, 'acceptance-start');
  let final;
  for (let index = 0; index < 80; index += 1) {
    final = await (await fetch(`${base}/api/v1/executions/${execution.id}`)).json();
    if (final.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (final.status !== 'completed') throw new Error('acceptance execution did not complete');
  const capabilities = await (await fetch(`${base}/api/v1/system/capabilities`)).json();
  const receipt = {
    schema_version: 'aiws.v3.acceptance_receipt.v1',
    status: 'passed',
    created_at: new Date().toISOString(),
    base_url: base,
    dynamic_port: app.server.address().port,
    startup_ms: Math.round(performance.now() - started),
    project_id: project.id,
    execution_id: execution.id,
    execution_status: final.status,
    capabilities,
    database: await app.database.integrity(),
    source: { commit: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), tree: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() }
  };
  const directory = path.join(process.cwd(), '.ai-workspace', 'release', 'v3-transition');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `v3-acceptance-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
  process.stdout.write(`${JSON.stringify({ receipt: target, base_url: base, execution: final.status }, null, 2)}\n`);
} finally {
  await app.close();
  await broker.close();
}
