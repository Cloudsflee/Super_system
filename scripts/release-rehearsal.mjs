import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const releaseRoot = path.join(root, '.ai-workspace', 'release', 'v3-transition');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const commands = [];
const createdProjects = [];
fs.mkdirSync(releaseRoot, { recursive: true });

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function exact(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function run(label, command, args, allowed = [0]) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024
  });
  const record = {
    label,
    command: exact(command, args),
    cwd: root,
    exit_status: result.status ?? 1,
    signal: result.signal || null,
    duration_ms: Math.round(performance.now() - started),
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
  commands.push(record);
  if (!allowed.includes(record.exit_status)) throw Object.assign(new Error(`${label} failed with exit status ${record.exit_status}: ${record.stderr.trim()}`), { record });
  return record;
}

function powershellExecutable() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
  return probe.status === 0 ? 'pwsh' : 'powershell.exe';
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function writeReceipt(name, body) {
  const unsigned = { ...body, created_at: new Date().toISOString() };
  const receipt = { ...unsigned, receipt_sha256: sha256Bytes(JSON.stringify(unsigned)) };
  const target = path.join(releaseRoot, name);
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(target, 0o444);
  return target;
}

function latestReceipt(prefix) {
  const explicit = process.env.AIWS_IMAGE_RECEIPT;
  if (explicit) return path.resolve(explicit);
  const files = fs.readdirSync(releaseRoot)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error(`missing_receipt:${prefix}`);
  return path.join(releaseRoot, files.at(-1));
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function composeYaml({ appImage, brokerImage, runnerImage, runnerDigest, volume, port, secretFile, codexSecretFile = process.env.AIWS_CODEX_SECRET_FILE || '', githubSecretFile = process.env.AIWS_GITHUB_SECRET_FILE || '', githubRepository = process.env.AIWS_GITHUB_REPOSITORY || '', githubFixtureSha = process.env.AIWS_GITHUB_FIXTURE_SHA || '' }) {
  const secret = secretFile.replaceAll('\\', '/');
  const codexPath = codexSecretFile ? path.resolve(root, codexSecretFile) : '';
  if (codexPath && !fs.existsSync(codexPath)) throw new Error('rehearsal_codex_secret_unreadable');
  const codexSecret = codexPath && fs.existsSync(codexPath) ? codexPath.replaceAll('\\', '/') : '';
  const codexEnvironment = codexSecret ? '\n      AIWS_CODEX_SECRET_FILE: /run/secrets/codex_api_key' : '';
  const codexServiceSecret = codexSecret ? '\n      - codex_api_key' : '';
  const codexSecretDefinition = codexSecret ? `\n  codex_api_key:\n    file: "${codexSecret}"` : '';
  const githubPath = githubSecretFile ? path.resolve(root, githubSecretFile) : '';
  if (githubPath && !fs.existsSync(githubPath)) throw new Error('rehearsal_github_secret_unreadable');
  const githubSecret = githubPath && fs.existsSync(githubPath) ? githubPath.replaceAll('\\', '/') : '';
  const githubEnvironment = githubSecret ? `\n      AIWS_GITHUB_SECRET_FILE: /run/secrets/github_token\n      AIWS_GITHUB_REPOSITORY: ${githubRepository}\n      AIWS_GITHUB_FIXTURE_SHA: ${githubFixtureSha}` : '';
  const githubServiceSecret = githubSecret ? '\n      - github_token' : '';
  const githubSecretDefinition = githubSecret ? `\n  github_token:\n    file: "${githubSecret}"` : '';
  return `services:
  app:
    image: ${appImage}
    init: true
    read_only: true
    labels:
      aiws.owner: aiws-v3-release
      aiws.role: acceptance-app
    ports:
      - "127.0.0.1:${port}:4317"
    environment:
      NODE_ENV: production
      AIWS_HOME: /var/lib/aiws
      AIWS_DOCKER_DATA_VOLUME: ${volume}
      AIWS_BROKER_URL: http://runner-broker:4321
      AIWS_BROKER_MODE: http
      AIWS_RUNNER_DIGEST: ${runnerDigest}
      AIWS_CODEX_MODEL: ${process.env.AIWS_CODEX_MODEL || 'gpt-5.5'}${codexEnvironment}${githubEnvironment}
    secrets:
      - broker_hmac${codexServiceSecret}${githubServiceSecret}
    volumes:
      - data:/var/lib/aiws
    tmpfs:
      - /tmp:size=256m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
    depends_on:
      - runner-broker
    networks:
      - internal
      - edge
  runner-broker:
    image: ${brokerImage}
    init: true
    read_only: true
    labels:
      aiws.owner: aiws-v3-release
      aiws.role: acceptance-broker
    environment:
      NODE_ENV: production
      AIWS_BROKER_EXECUTOR: ${codexSecret ? 'docker' : 'mock'}
      AIWS_BROKER_DATA_ROOT: /var/lib/aiws
      AIWS_DOCKER_DATA_VOLUME: ${volume}
      AIWS_CODEX_MODEL: ${process.env.AIWS_CODEX_MODEL || 'gpt-5.5'}
      AIWS_RUNNER_DIGEST: ${runnerDigest}
      AIWS_RUNNER_IMAGE: ${runnerImage}
    secrets:
      - broker_hmac
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - data:/var/lib/aiws
    tmpfs:
      - /tmp:size=256m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    networks:
      - internal
networks:
  internal:
    internal: true
  edge: {}
  model:
    name: aiws-runner-model
volumes:
  data:
    external: true
    name: ${volume}
secrets:
  broker_hmac:
    file: "${secret}"${codexSecretDefinition}${githubSecretDefinition}
`;
}

async function waitReady(base, timeoutMs = 60_000) {
  const started = performance.now();
  let last = '';
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2_000) });
      last = await response.text();
      if (response.ok) return { elapsed_ms: Math.round(performance.now() - started), body: JSON.parse(last) };
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ready_timeout:${last}`);
}

async function mutate(base, route, body, key = randomUUID(), timeoutMs = 10_000) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`api_failure:${route}:${response.status}:${JSON.stringify(value)}`);
  return value;
}

async function explicitCapabilities(base, suffix) {
  await mutate(base, '/api/v1/integrations/codex/probe', { force: true }, `${suffix}-codex-probe`, 120_000);
  await mutate(base, '/api/v1/integrations/github/probe', { force: true }, `${suffix}-github-probe`, 120_000);
  return (await fetch(`${base}/api/v1/system/capabilities`, { signal: AbortSignal.timeout(10_000) })).json();
}

function githubRef(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

async function githubRequest(method, requestPath, token, body = undefined, allowed = [200]) {
  const response = await fetch(`https://api.github.com${requestPath}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'aiws-v3-release'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  if (!allowed.includes(response.status)) throw new Error(`github_rehearsal_api_failed:${response.status}`);
  return { status: response.status, value };
}

async function githubDeliveryJourney(base, journeyResult, suffix, configuration) {
  const token = fs.readFileSync(configuration.secretFile, 'utf8').trim();
  const executionId = journeyResult.executions[0]?.id;
  if (!executionId) throw new Error('github_rehearsal_execution_missing');
  let delivery = null;
  let evidence = null;
  let projectBranchDeleted = false;
  let deliveryBranchDeleted = false;
  try {
    const createReview = await mutate(base, '/api/v1/reviews', {
      project_id: journeyResult.project_id, execution_id: executionId, kind: 'delivery_create',
      model_status: 'unavailable', suggestion: {}
    }, `${suffix}-delivery-create-review`);
    await mutate(base, `/api/v1/reviews/${createReview.id}/decisions`, { decision: 'approved', note: 'Release rehearsal delivery approval' }, `${suffix}-delivery-create-decision`);
    delivery = await mutate(base, '/api/v1/deliveries', {
      project_id: journeyResult.project_id, execution_id: executionId, review_id: createReview.id,
      title: `AIWS release rehearsal ${suffix}`, body: 'Automated release rehearsal Draft PR.'
    }, `${suffix}-delivery`, 180_000);
    if (delivery.status !== 'submitted' || !delivery.pull_number || !delivery.head_sha || !delivery.external_ref) throw new Error(`github_rehearsal_delivery_${delivery.status}`);
    const draft = (await githubRequest('GET', `/repos/${configuration.repository}/pulls/${delivery.pull_number}`, token)).value;
    if (!draft.draft || draft.head?.sha !== delivery.head_sha || draft.head?.ref !== delivery.branch) throw new Error('github_rehearsal_draft_evidence_invalid');

    const mergeReview = await mutate(base, '/api/v1/reviews', {
      project_id: journeyResult.project_id, execution_id: executionId, kind: 'delivery_merge',
      model_status: 'unavailable', suggestion: {}
    }, `${suffix}-delivery-merge-review`);
    await mutate(base, `/api/v1/reviews/${mergeReview.id}/decisions`, { decision: 'approved', note: 'Independent release rehearsal merge approval' }, `${suffix}-delivery-merge-decision`);
    const merged = await mutate(base, `/api/v1/deliveries/${delivery.id}/merge`, {
      review_id: mergeReview.id, expected_revision: delivery.revision
    }, `${suffix}-delivery-merge`, 180_000);
    if (merged.status !== 'merged' || !/^[a-f0-9]{40}$/.test(String(merged.merge_sha || ''))) throw new Error(`github_rehearsal_merge_${merged.status}`);
    const [projectResponse, mergedPull, remoteBase] = await Promise.all([
      fetch(`${base}/api/v1/projects/${journeyResult.project_id}`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.json()),
      githubRequest('GET', `/repos/${configuration.repository}/pulls/${delivery.pull_number}`, token).then((result) => result.value),
      githubRequest('GET', `/repos/${configuration.repository}/git/ref/heads/${githubRef(`aiws/projects/${journeyResult.project_id}`)}`, token).then((result) => result.value)
    ]);
    if (!mergedPull.merged || mergedPull.merge_commit_sha !== merged.merge_sha) throw new Error('github_rehearsal_remote_merge_invalid');
    const localHead = String(projectResponse.repository?.head_sha || '');
    const remoteHead = String(remoteBase.object?.sha || '');
    if (localHead !== remoteHead || localHead !== merged.merge_sha) throw new Error('github_rehearsal_baseline_sync_failed');
    evidence = {
      status: 'merged', project_id: journeyResult.project_id, execution_id: executionId,
      delivery_id: delivery.id, pull_number: delivery.pull_number, pull_url: delivery.external_ref,
      draft_created: true, head_sha: delivery.head_sha, merge_sha: merged.merge_sha,
      local_head_sha: localHead, remote_base_sha: remoteHead, merged_at: mergedPull.merged_at
    };
  } finally {
    if (delivery?.branch) {
      const deleted = await githubRequest('DELETE', `/repos/${configuration.repository}/git/refs/heads/${githubRef(delivery.branch)}`, token, undefined, [204, 404, 422]).catch(() => null);
      deliveryBranchDeleted = Boolean(deleted && [204, 404, 422].includes(deleted.status));
    }
    const projectBranch = `aiws/projects/${journeyResult.project_id}`;
    const deleted = await githubRequest('DELETE', `/repos/${configuration.repository}/git/refs/heads/${githubRef(projectBranch)}`, token, undefined, [204, 404, 422]).catch(() => null);
    projectBranchDeleted = Boolean(deleted && [204, 404, 422].includes(deleted.status));
  }
  if (!evidence || !projectBranchDeleted || !deliveryBranchDeleted) throw new Error('github_rehearsal_branch_cleanup_failed');
  return { ...evidence, project_branch_deleted: projectBranchDeleted, delivery_branch_deleted: deliveryBranchDeleted };
}

async function journey(base, suffix, repeats = 3) {
  const project = await mutate(base, '/api/v1/projects', { name: `Release ${suffix}`, repository: { source: { kind: 'fixture', id: 'designsignal-v1' } } }, `${suffix}-project`);
  createdProjects.push(project.id);
  await mutate(base, `/api/v1/projects/${project.id}/briefs`, { content: { objective: `Verify ${suffix}`, acceptance: ['execution completes'] } }, `${suffix}-brief`);
  await mutate(base, `/api/v1/projects/${project.id}/workflows`, { tasks: [
    { id: 'inspect', level: 1, title: 'Inspect', mode: 'read' },
    { id: 'change', level: 2, title: 'Write release rehearsal evidence', mode: 'write', deps: ['inspect'], outputs: [`release-${suffix}.txt`] }
  ] }, `${suffix}-workflow`);
  const executions = [];
  for (let index = 0; index < repeats; index += 1) {
    const execution = await mutate(base, `/api/v1/projects/${project.id}/executions`, {}, `${suffix}-execution-${index}`);
    await mutate(base, `/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, `${suffix}-start-${index}`);
    let current = execution;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/v1/executions/${execution.id}`, { signal: AbortSignal.timeout(2_000) });
      current = await response.json();
      if (current.status === 'completed') break;
      if (['failed', 'awaiting_human', 'cancelled'].includes(current.status)) throw new Error(`acceptance_execution_${current.status}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (current.status !== 'completed' || !current.tasks.every((task) => task.status === 'completed')) throw new Error('acceptance_execution_timeout');
    executions.push({ id: current.id, status: current.status, tasks: current.tasks.map((task) => ({ id: task.task_id, status: task.status, broker_job_id: task.broker_job_id })) });
  }
  return { project_id: project.id, executions };
}

function manifest(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(directory, full).replaceAll('\\', '/');
        const stat = fs.statSync(full);
        files.push({ path: relative, size: stat.size, sha256: sha256File(full) });
      }
    }
  };
  walk(directory);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function sqliteEvidence(directory) {
  const file = path.join(directory, 'data', 'state.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    const events = db.prepare("SELECT execution_id,task_id,type,created_at,cursor FROM events WHERE type IN ('task.ready','task.running') ORDER BY cursor").all();
    const ready = new Map();
    const submissionMs = [];
    for (const event of events) {
      const key = `${event.execution_id}:${event.task_id}`;
      if (event.type === 'task.ready') ready.set(key, Date.parse(event.created_at));
      if (event.type === 'task.running' && ready.has(key)) submissionMs.push(Math.max(0, Date.parse(event.created_at) - ready.get(key)));
    }
    submissionMs.sort((a, b) => a - b);
    const p95 = submissionMs.length ? submissionMs[Math.min(submissionMs.length - 1, Math.ceil(submissionMs.length * 0.95) - 1)] : null;
    return { file: 'data/state.sqlite', integrity, user_version: userVersion, foreign_key_violations: foreignKeyViolations, broker_submission_samples_ms: submissionMs, broker_submission_p95_ms: p95 };
  } finally {
    db.close();
  }
}

function archiveVolume(volume, image, target, label) {
  const helper = `aiws-v3-${label}-${stamp}`;
  run(`${label}-create-helper`, 'docker', ['create', '--name', helper, '--label', 'aiws.owner=aiws-v3-release', '--mount', `type=volume,src=${volume},dst=/source,readonly`, image, 'sh', '-c', 'tar -C /source -czf /tmp/data.tar.gz .']);
  try {
    run(`${label}-archive`, 'docker', ['start', '--attach', helper]);
    run(`${label}-copy`, 'docker', ['cp', `${helper}:/tmp/data.tar.gz`, target]);
  } finally {
    run(`${label}-remove-helper`, 'docker', ['rm', '-f', helper], [0, 1]);
  }
}

function restoreVolume(volume, image, archive, label) {
  const helper = `aiws-v3-${label}-${stamp}`;
  run(`${label}-create-helper`, 'docker', ['create', '--name', helper, '--label', 'aiws.owner=aiws-v3-release', '--mount', `type=volume,src=${volume},dst=/target`, image, 'sh', '-c', 'tar -C /target -xzf /tmp/data.tar.gz']);
  try {
    run(`${label}-copy`, 'docker', ['cp', archive, `${helper}:/tmp/data.tar.gz`]);
    run(`${label}-restore`, 'docker', ['start', '--attach', helper]);
  } finally {
    run(`${label}-remove-helper`, 'docker', ['rm', '-f', helper], [0, 1]);
  }
}

function writeRollback(composeFile, project) {
  const target = path.join(releaseRoot, `rollback-rehearsal-${stamp}.ps1`);
  const content = `param(\n  [string]$ProjectName = '${project}',\n  [string]$ComposeFile = '${composeFile.replaceAll("'", "''")}'\n)\n$ErrorActionPreference = 'Stop'\nif ($ProjectName -notmatch '^aiws-v3-rehearsal-[0-9]+-(source|restore)$') { throw 'invalid_rehearsal_project' }\n& docker compose -p $ProjectName -f $ComposeFile down --remove-orphans\nif ($LASTEXITCODE -ne 0) { throw "rollback_failed:$LASTEXITCODE" }\n& docker ps -a --filter "label=com.docker.compose.project=$ProjectName" --format '{{.Names}}'\nif ($LASTEXITCODE -ne 0) { throw "rollback_verify_failed:$LASTEXITCODE" }\n`;
  fs.writeFileSync(target, `\uFEFF${content}`, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(target, 0o444);
  return target;
}

const imageReceiptPath = latestReceipt('v3-images-');
const imageReceipt = JSON.parse(fs.readFileSync(imageReceiptPath, 'utf8'));
const commit = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('release_rehearsal_requires_clean_commit');
if (imageReceipt.status !== 'candidate' || imageReceipt.source?.commit !== commit) throw new Error('candidate_image_receipt_mismatch');
const byRole = Object.fromEntries(imageReceipt.images.map((image) => [image.role, image]));
for (const role of ['app', 'broker', 'runner']) if (!/^sha256:[a-f0-9]{64}$/.test(byRole[role]?.image_id || '')) throw new Error(`missing_candidate_image:${role}`);

const sourceProject = `aiws-v3-rehearsal-${stamp}-source`;
const restoreProject = `aiws-v3-rehearsal-${stamp}-restore`;
const sourceVolume = `aiws-v3-snapshot-${stamp}`;
const restoreVolumeName = `aiws-v3-restored-${stamp}`;
const codexSecretFile = process.env.AIWS_CODEX_SECRET_FILE || '';
const githubSecretFile = process.env.AIWS_GITHUB_SECRET_FILE || '';
const githubRepository = process.env.AIWS_GITHUB_REPOSITORY || '';
const githubFixtureSha = process.env.AIWS_GITHUB_FIXTURE_SHA || '';
const codexSecretConfigured = Boolean(codexSecretFile && fs.existsSync(codexSecretFile));
const secretFile = path.join(releaseRoot, `.rehearsal-secret-${stamp}`);
const sourceCompose = path.join(releaseRoot, `compose-rehearsal-source-${stamp}.yml`);
const restoreCompose = path.join(releaseRoot, `compose-rehearsal-restore-${stamp}.yml`);
const archive = path.join(releaseRoot, `v3-backup-${stamp}.tar.gz`);
const restoredArchive = path.join(releaseRoot, `v3-restored-validation-${stamp}.tar.gz`);
let sourceUp = false;
let restoreUp = false;

try {
  fs.writeFileSync(secretFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  run('create-source-volume', 'docker', ['volume', 'create', '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=snapshot', '--label', `aiws.source.commit=${commit}`, sourceVolume]);
  const sourcePort = await allocatePort();
  fs.writeFileSync(sourceCompose, composeYaml({ appImage: byRole.app.image_id, brokerImage: byRole.broker.image_id, runnerImage: byRole.runner.image_id, runnerDigest: byRole.runner.image_id, volume: sourceVolume, port: sourcePort, secretFile, codexSecretFile, githubSecretFile, githubRepository, githubFixtureSha }), { flag: 'wx', mode: 0o444 });
  const sourceStarted = performance.now();
  run('source-compose-up', 'docker', ['compose', '-p', sourceProject, '-f', sourceCompose, 'up', '-d']);
  sourceUp = true;
  const sourceReady = await waitReady(`http://127.0.0.1:${sourcePort}`);
  const startupMs = Math.round(performance.now() - sourceStarted);
  const sourceJourney = await journey(`http://127.0.0.1:${sourcePort}`, 'source', 3);
  const sourcePerformance = await (await fetch(`http://127.0.0.1:${sourcePort}/api/v1/system/performance`)).json();
  const sourceCapabilities = await explicitCapabilities(`http://127.0.0.1:${sourcePort}`, 'source');
  const githubDelivery = sourceCapabilities.github?.status === 'available' && /^[a-f0-9]{40}$/.test(githubFixtureSha)
    ? await githubDeliveryJourney(`http://127.0.0.1:${sourcePort}`, sourceJourney, 'source', { secretFile: githubSecretFile, repository: githubRepository })
    : null;
  const rootResponse = await fetch(`http://127.0.0.1:${sourcePort}/`);
  if (!rootResponse.ok || !(await rootResponse.text()).includes('AIWS')) throw new Error('production_web_bundle_unavailable');
  const appContainer = `${sourceProject}-app-1`;
  const brokerContainer = `${sourceProject}-runner-broker-1`;
  run('app-docker-cli-absence', 'docker', ['exec', appContainer, 'sh', '-c', 'command -v docker'], [1, 127]);
  const appInspect = JSON.parse(run('inspect-source-app', 'docker', ['inspect', appContainer]).stdout)[0];
  const brokerInspect = JSON.parse(run('inspect-source-broker', 'docker', ['inspect', brokerContainer]).stdout)[0];
  if (appInspect.Mounts.some((mount) => mount.Destination === '/var/run/docker.sock')) throw new Error('app_socket_boundary_failed');
  if (brokerInspect.HostConfig?.PortBindings && Object.keys(brokerInspect.HostConfig.PortBindings).length) throw new Error('broker_host_port_boundary_failed');
  if (startupMs >= 3_000) throw new Error(`startup_threshold_failed:${startupMs}`);
  if (sourcePerformance.rss_bytes >= 512 * 1024 * 1024) throw new Error(`rss_threshold_failed:${sourcePerformance.rss_bytes}`);
  if (sourcePerformance.event_loop_lag_p95_ms > 50) throw new Error(`event_loop_threshold_failed:${sourcePerformance.event_loop_lag_p95_ms}`);
  if (sourceCapabilities.broker?.runner_digest !== byRole.runner.image_id) throw new Error('ready_runner_digest_mismatch');

  run('source-compose-stop', 'docker', ['compose', '-p', sourceProject, '-f', sourceCompose, 'down', '--remove-orphans']);
  sourceUp = false;
  archiveVolume(sourceVolume, byRole.app.image_id, archive, 'source');
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-source-'));
  run('extract-source-archive', 'tar', ['-xzf', archive, '-C', extractionRoot]);
  const sourceManifest = manifest(extractionRoot);
  const sourceSqlite = sqliteEvidence(extractionRoot);
  if (sourceSqlite.integrity.join(',') !== 'ok' || sourceSqlite.user_version !== 1 || sourceSqlite.foreign_key_violations.length) throw new Error('source_sqlite_validation_failed');
  if (sourceSqlite.broker_submission_p95_ms == null || sourceSqlite.broker_submission_p95_ms >= 500) throw new Error(`broker_submission_threshold_failed:${sourceSqlite.broker_submission_p95_ms}`);

  const externalCapabilities = ['codex', 'github'];
  const unavailableCapabilities = externalCapabilities.filter((name) => sourceCapabilities[name]?.status !== 'available');
  if (sourceCapabilities.github?.status === 'available' && !githubDelivery) unavailableCapabilities.push('github_delivery');
  const acceptanceStatus = unavailableCapabilities.length ? 'candidate' : 'passed';
  const acceptanceReceipt = writeReceipt(`v3-acceptance-docker-${stamp}.json`, {
    schema_version: 'aiws.v3.docker_acceptance_receipt.v1', status: acceptanceStatus,
    source: imageReceipt.source,
    image_receipt: path.relative(root, imageReceiptPath).replaceAll('\\', '/'),
    images: { app: byRole.app.image_id, broker: byRole.broker.image_id, runner: byRole.runner.image_id },
    dynamic_port: sourcePort,
    startup_ms: startupMs,
    ready: sourceReady,
    performance: sourcePerformance,
    capabilities: sourceCapabilities,
    capability_gate: {
      required: [...externalCapabilities, 'github_delivery'],
      status: unavailableCapabilities.length ? 'candidate' : 'passed',
      unavailable: unavailableCapabilities
    },
    runner_adapter: codexSecretConfigured ? 'docker' : 'mock',
    journey: sourceJourney,
    github_delivery: githubDelivery,
    boundaries: { app_has_docker_cli: false, app_has_docker_socket: false, broker_has_host_port: false },
    volume: sourceVolume,
    archive: { path: path.relative(root, archive).replaceAll('\\', '/'), sha256: sha256File(archive) },
    manifest: { file_count: sourceManifest.length, sha256: sha256Bytes(JSON.stringify(sourceManifest)) },
    sqlite: sourceSqlite,
    commands
  });

  run('create-restore-volume', 'docker', ['volume', 'create', '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=recovery-snapshot', '--label', `aiws.source=${sourceVolume}`, restoreVolumeName]);
  restoreVolume(restoreVolumeName, byRole.app.image_id, archive, 'restore');
  archiveVolume(restoreVolumeName, byRole.app.image_id, restoredArchive, 'restored-validation');
  const restoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-restored-'));
  run('extract-restored-archive', 'tar', ['-xzf', restoredArchive, '-C', restoredRoot]);
  const restoredManifest = manifest(restoredRoot);
  const restoredSqlite = sqliteEvidence(restoredRoot);
  if (JSON.stringify(restoredManifest) !== JSON.stringify(sourceManifest)) throw new Error('restored_manifest_mismatch');
  if (restoredSqlite.integrity.join(',') !== 'ok' || restoredSqlite.user_version !== 1 || restoredSqlite.foreign_key_violations.length) throw new Error('restored_sqlite_validation_failed');

  const restorePort = await allocatePort();
  fs.writeFileSync(restoreCompose, composeYaml({ appImage: byRole.app.image_id, brokerImage: byRole.broker.image_id, runnerImage: byRole.runner.image_id, runnerDigest: byRole.runner.image_id, volume: restoreVolumeName, port: restorePort, secretFile, codexSecretFile, githubSecretFile, githubRepository, githubFixtureSha }), { flag: 'wx', mode: 0o444 });
  run('restore-compose-up', 'docker', ['compose', '-p', restoreProject, '-f', restoreCompose, 'up', '-d']);
  restoreUp = true;
  const restoreReady = await waitReady(`http://127.0.0.1:${restorePort}`);
  const restoredProjects = await (await fetch(`http://127.0.0.1:${restorePort}/api/v1/projects`)).json();
  if (!restoredProjects.some((project) => project.id === sourceJourney.project_id)) throw new Error('restored_project_missing');
  const restoreJourney = await journey(`http://127.0.0.1:${restorePort}`, 'restore', 1);
  const rollback = writeRollback(restoreCompose, restoreProject);
  const powershell = powershellExecutable();
  const rollbackExecution = run('execute-rehearsal-rollback', powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rollback]);
  restoreUp = false;
  const remaining = run('verify-rehearsal-rollback', 'docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${restoreProject}`, '--format', '{{.Names}}']);
  if (remaining.stdout.trim()) throw new Error('rollback_left_containers');

  const recoveryReceipt = writeReceipt(`v3-recovery-${stamp}.json`, {
    schema_version: 'aiws.v3.recovery_receipt.v1', status: 'passed',
    source: imageReceipt.source,
    acceptance_receipt: path.relative(root, acceptanceReceipt).replaceAll('\\', '/'),
    baseline: {
      volume: sourceVolume,
      archive: path.relative(root, archive).replaceAll('\\', '/'),
      archive_sha256: sha256File(archive),
      manifest_sha256: sha256Bytes(JSON.stringify(sourceManifest)),
      sqlite: sourceSqlite
    },
    restored: {
      volume: restoreVolumeName,
      validation_archive: path.relative(root, restoredArchive).replaceAll('\\', '/'),
      archive_sha256: sha256File(restoredArchive),
      manifest_sha256: sha256Bytes(JSON.stringify(restoredManifest)),
      sqlite: restoredSqlite,
      ready: restoreReady,
      original_project_found: true,
      journey: restoreJourney
    },
    rollback: {
      path: path.relative(root, rollback).replaceAll('\\', '/'),
      sha256: sha256File(rollback),
      command: rollbackExecution.command,
      output: rollbackExecution.stdout,
      exit_status: rollbackExecution.exit_status,
      verified_no_containers: true
    },
    commands
  });
  process.stdout.write(`${JSON.stringify({ status: acceptanceStatus, acceptance_receipt: acceptanceReceipt, recovery_receipt: recoveryReceipt, snapshots: [sourceVolume, restoreVolumeName] }, null, 2)}\n`);
} catch (error) {
  const failure = writeReceipt(`v3-rehearsal-failure-${stamp}.json`, {
    schema_version: 'aiws.v3.rehearsal_failure_receipt.v1', status: 'failed',
    image_receipt: path.relative(root, imageReceiptPath).replaceAll('\\', '/'),
    error: error.message,
    commands
  });
  process.stderr.write(`release rehearsal failed; receipt: ${failure}\n`);
  process.exitCode = 1;
} finally {
  if (restoreUp) run('cleanup-restore-compose', 'docker', ['compose', '-p', restoreProject, '-f', restoreCompose, 'down', '--remove-orphans'], [0, 1]);
  if (sourceUp) run('cleanup-source-compose', 'docker', ['compose', '-p', sourceProject, '-f', sourceCompose, 'down', '--remove-orphans'], [0, 1]);
  try { fs.chmodSync(secretFile, 0o600); fs.rmSync(secretFile, { force: true }); } catch { /* secret cleanup is best effort after containers stop */ }
}
