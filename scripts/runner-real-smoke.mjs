import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const digest = process.env.AIWS_RUNNER_DIGEST || '';
const runnerImage = process.env.AIWS_RUNNER_IMAGE || '';
const codexSecret = process.env.AIWS_CODEX_SECRET_FILE ? path.resolve(root, process.env.AIWS_CODEX_SECRET_FILE) : '';
const brokerSecret = path.resolve(root, process.env.AIWS_BROKER_SECRET_FILE || path.join('docker', 'secrets', 'broker_hmac'));
const missing = [];
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) missing.push('AIWS_RUNNER_DIGEST');
if (!runnerImage) missing.push('AIWS_RUNNER_IMAGE');
if (!codexSecret || !fs.existsSync(codexSecret)) missing.push('AIWS_CODEX_SECRET_FILE');
if (!brokerSecret || !fs.existsSync(brokerSecret)) missing.push('AIWS_BROKER_SECRET_FILE');
if (missing.length) {
  process.stdout.write(`${JSON.stringify({ status: 'candidate', reason: 'external_configuration_missing', missing })}\n`);
  process.exit(0);
}
try { await execFileAsync('docker', ['version'], { windowsHide: true, timeout: 5_000 }); } catch {
  process.stdout.write(`${JSON.stringify({ status: 'candidate', reason: 'docker_unavailable', missing: ['docker'] })}\n`);
  process.exit(0);
}

async function containerId(name) {
  try { return (await execFileAsync('docker', ['inspect', '--format', '{{.Id}}', name], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })).stdout.trim(); }
  catch { return null; }
}

const productionContainers = {
  app: await containerId('aiws-v3-app-1'),
  broker: await containerId('aiws-v3-runner-broker-1')
};

const stamp = `${process.pid}-${Date.now()}`;
const project = `aiws-real-${stamp}`;
const volume = `aiws-real-data-${stamp}`;
const port = await freePort();
const composeFile = path.join(os.tmpdir(), `aiws-real-${stamp}.yml`);
const tempSecret = path.join(os.tmpdir(), `aiws-real-broker-${stamp}`);
fs.copyFileSync(brokerSecret, tempSecret, fs.constants.COPYFILE_EXCL);
const appImage = `aiws-real-app:${stamp}`;
const brokerImage = `aiws-real-broker:${stamp}`;
let started = false;
const redactions = [codexSecret, brokerSecret]
  .filter((file) => file && fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8').trim())
  .filter(Boolean);

function redact(value) {
  return redactions.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value || ''))
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]');
}

function composeYaml() {
  return `name: ${project}\nservices:\n  app:\n    image: ${appImage}\n    init: true\n    read_only: true\n    ports: ["127.0.0.1:${port}:4317"]\n    environment:\n      NODE_ENV: production\n      AIWS_HOME: /var/lib/aiws\n      AIWS_DOCKER_DATA_VOLUME: ${volume}\n      AIWS_BROKER_URL: http://runner-broker:4321\n      AIWS_BROKER_MODE: http\n      AIWS_RUNNER_DIGEST: ${digest}\n      AIWS_CODEX_SECRET_FILE: /run/secrets/codex_api_key\n      AIWS_CODEX_MODEL: ${process.env.AIWS_CODEX_MODEL || 'gpt-5.5'}\n    secrets: [broker_hmac, codex_api_key]\n    volumes: [${volume}:/var/lib/aiws]\n    networks: [internal, edge]\n  runner-broker:\n    image: ${brokerImage}\n    init: true\n    read_only: true\n    environment:\n      NODE_ENV: production\n      AIWS_BROKER_EXECUTOR: docker\n      AIWS_BROKER_DATA_ROOT: /var/lib/aiws\n      AIWS_DOCKER_DATA_VOLUME: ${volume}\n      AIWS_RUNNER_DIGEST: ${digest}\n      AIWS_RUNNER_IMAGE: ${runnerImage}\n      AIWS_CODEX_MODEL: ${process.env.AIWS_CODEX_MODEL || 'gpt-5.5'}\n    secrets: [broker_hmac]\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - ${volume}:/var/lib/aiws\n    networks: [internal]\nnetworks:\n  internal: { internal: true }\n  edge: {}\nvolumes:\n  ${volume}: { name: ${volume}, labels: { aiws.owner: aiws-v3, aiws.role: real-smoke } }\nsecrets:\n  broker_hmac: { file: ${tempSecret.replaceAll('\\', '/')} }\n  codex_api_key: { file: ${codexSecret.replaceAll('\\', '/')} }\n`;
}

function composeYamlWithTmpfs() {
  const marker = `    volumes: [${volume}:/var/lib/aiws]\n    networks: [internal, edge]`;
  return composeYaml().replace(marker, `    volumes: [${volume}:/var/lib/aiws]\n    tmpfs:\n      - /tmp:size=256m,mode=1777\n    networks: [internal, edge]`);
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: options.timeout || 180_000, maxBuffer: 8 * 1024 * 1024 });
}

async function post(base, route, body, sequence) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': `real-${stamp}-${sequence}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}:${json.error?.code || response.status}:${json.error?.message || 'request_failed'}`);
  return json;
}

try {
  await run('docker', ['build', '--target', 'production', '--tag', appImage, '--build-arg', `AIWS_RUNNER_DIGEST=${digest}`, '.']);
  await run('docker', ['build', '--target', 'broker', '--tag', brokerImage, '--build-arg', `AIWS_RUNNER_DIGEST=${digest}`, '.']);
  const inspected = JSON.parse((await run('docker', ['image', 'inspect', runnerImage])).stdout)[0];
  if (inspected.Id !== digest && !(inspected.RepoDigests || []).some((item) => item.endsWith(`@${digest}`))) throw new Error('runner_digest_mismatch');
  fs.writeFileSync(composeFile, composeYamlWithTmpfs(), { mode: 0o600 });
  await run('docker', ['compose', '-p', project, '-f', composeFile, 'up', '-d']);
  started = true;
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base, digest);
  const projectRow = await post(base, '/api/v1/projects', { name: `real-${stamp}`, repository: { source: { kind: 'fixture', id: 'designsignal-v1' } } }, 1);
  await post(base, `/api/v1/projects/${projectRow.id}/briefs`, { content: { objective: 'real runner smoke', acceptance: ['node_test', 'git_diff_check'] } }, 2);
  await post(base, `/api/v1/projects/${projectRow.id}/workflows`, { tasks: [{ id: 'inspect', level: 1, mode: 'read', outputs: ['analysis.md'] }, { id: 'write', level: 2, deps: ['inspect'], mode: 'write', inputs: ['analysis.md'], outputs: ['src/signal.mjs'] }] }, 3);
  const execution = await post(base, `/api/v1/projects/${projectRow.id}/executions`, {}, 4);
  await post(base, `/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, 5);
  const completed = await waitExecution(base, execution.id);
  if (completed.status !== 'completed') {
    const attemptsByTask = new Map((completed.attempts || []).map((attempt) => [attempt.task_id, []]));
    for (const attempt of completed.attempts || []) attemptsByTask.get(attempt.task_id)?.push({ status: attempt.status, error_code: attempt.error_code, output: attempt.output });
    const tasks = (completed.tasks || []).map((task) => ({ id: task.task_id || task.id, status: task.status, attempts: attemptsByTask.get(task.task_id || task.id) || [] }));
    throw new Error(`real_runner_execution_${completed.status}:${JSON.stringify({ tasks, runner: completed.runner, evidence: completed.evidence })}`);
  }
  process.stdout.write(`${JSON.stringify({ status: 'passed', project_id: projectRow.id, execution_id: execution.id, runner_digest: digest }, null, 2)}\n`);
} catch (error) {
  const logs = started
    ? await run('docker', ['compose', '-p', project, '-f', composeFile, 'logs', '--no-color', '--tail', '200'], { timeout: 30_000 }).catch((failure) => ({ stdout: failure?.stdout || '', stderr: failure?.stderr || '' }))
    : { stdout: '', stderr: '' };
  process.stderr.write(`${JSON.stringify({ error: redact(error?.message), compose_logs: redact(`${logs.stdout || ''}${logs.stderr || ''}`) }, null, 2)}\n`);
  throw error;
} finally {
  if (started) await run('docker', ['compose', '-p', project, '-f', composeFile, 'down', '--volumes', '--remove-orphans'], { timeout: 60_000 }).catch(() => undefined);
  await run('docker', ['volume', 'rm', '--force', volume], { timeout: 30_000 }).catch(() => undefined);
  await run('docker', ['image', 'rm', '--force', appImage, brokerImage], { timeout: 60_000 }).catch(() => undefined);
  fs.rmSync(composeFile, { force: true });
  fs.rmSync(tempSecret, { force: true });
  const residualContainers = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { timeout: 30_000 }).catch(() => ({ stdout: '' }))).stdout.trim();
  if (residualContainers) throw new Error('real_runner_cleanup_left_containers');
  try { await run('docker', ['volume', 'inspect', volume], { timeout: 10_000 }); throw new Error('real_runner_cleanup_left_volume'); }
  catch (error) { if (error?.message === 'real_runner_cleanup_left_volume') throw error; }
  for (const image of [appImage, brokerImage]) {
    try { await run('docker', ['image', 'inspect', image], { timeout: 10_000 }); throw new Error('real_runner_cleanup_left_image'); }
    catch (error) { if (error?.message === 'real_runner_cleanup_left_image') throw error; }
  }
  if (fs.existsSync(composeFile) || fs.existsSync(tempSecret)) throw new Error('real_runner_cleanup_left_secret_or_compose');
  const currentProduction = {
    app: await containerId('aiws-v3-app-1'),
    broker: await containerId('aiws-v3-runner-broker-1')
  };
  for (const role of ['app', 'broker']) {
    if (productionContainers[role] && currentProduction[role] !== productionContainers[role]) throw new Error(`production_container_changed:${role}`);
  }
}

async function waitReady(base, expectedDigest) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json();
      if (response.ok && body.checks?.runner_digest === expectedDigest) return body;
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('real_runner_ready_timeout');
}

async function waitExecution(base, id) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const current = await (await fetch(`${base}/api/v1/executions/${id}`)).json();
    if (['completed', 'failed', 'awaiting_human', 'cancelled'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('real_runner_execution_timeout');
}

async function freePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
