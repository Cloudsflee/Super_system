import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const releaseRoot = path.join(root, '.ai-workspace', 'release', 'v3-transition');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const commands = [];
let commandEnv = process.env;
let oldStopped = false;
let switched = false;
let promoted = false;
let rollbackScript = '';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function exact(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function run(label, command, args, allowed = [0], env = commandEnv) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const record = {
    label, command: exact(command, args), cwd: root, exit_status: result.status ?? 1,
    signal: result.signal || null, duration_ms: Math.round(performance.now() - started),
    stdout: result.stdout || '', stderr: result.stderr || ''
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
  const receipt = { ...unsigned, receipt_sha256: sha256(JSON.stringify(unsigned)) };
  const target = path.join(releaseRoot, name);
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(target, 0o444);
  return target;
}

function latest(prefix) {
  const names = fs.readdirSync(releaseRoot).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort();
  if (!names.length) throw new Error(`missing_receipt:${prefix}`);
  return path.join(releaseRoot, names.at(-1));
}

function assertFormalCapabilities(capabilities, source) {
  const required = ['codex', 'github'];
  const unavailable = required.filter((name) => capabilities?.[name]?.status !== 'available');
  if (unavailable.length) throw new Error(`formal_capability_gate_failed:${source}:${unavailable.join(',')}`);
}

function inspect(name) {
  return JSON.parse(run(`inspect-${name.replaceAll(/[^A-Za-z0-9]/g, '-')}`, 'docker', ['inspect', name]).stdout)[0];
}

function manifest(directory) {
  const result = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.push({ path: path.relative(directory, full).replaceAll('\\', '/'), size: fs.statSync(full).size, sha256: sha256File(full) });
    }
  };
  walk(directory);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function sqliteEvidence(directory) {
  const file = path.join(directory, 'data', 'state.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      file: 'data/state.sqlite',
      integrity: db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check),
      user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
      foreign_key_violations: db.prepare('PRAGMA foreign_key_check').all()
    };
  } finally { db.close(); }
}

function archiveVolume(volume, image, target) {
  const helper = `aiws-v3-production-backup-${stamp}`;
  run('backup-helper-create', 'docker', ['create', '--name', helper, '--label', 'aiws.owner=aiws-v3-release', '--mount', `type=volume,src=${volume},dst=/source,readonly`, image, 'sh', '-c', 'tar -C /source -czf /tmp/data.tar.gz .']);
  try {
    run('backup-helper-run', 'docker', ['start', '--attach', helper]);
    run('backup-helper-copy', 'docker', ['cp', `${helper}:/tmp/data.tar.gz`, target]);
  } finally {
    run('backup-helper-remove', 'docker', ['rm', '-f', helper], [0, 1]);
  }
}

async function waitReady(timeoutMs = 60_000) {
  const started = performance.now();
  let last = '';
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch('http://127.0.0.1:4317/readyz', { signal: AbortSignal.timeout(2_000) });
      last = await response.text();
      if (response.ok) return { elapsed_ms: Math.round(performance.now() - started), body: JSON.parse(last) };
    } catch (error) { last = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`production_ready_timeout:${last}`);
}

async function post(route, body, key) {
  const response = await fetch(`http://127.0.0.1:4317${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key || randomUUID() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`production_api_failure:${route}:${response.status}:${JSON.stringify(value)}`);
  return value;
}

async function productionJourney() {
  const suffix = stamp;
  const project = await post('/api/v1/projects', { name: `AIWS 3.0 final ${suffix}` }, `final-${suffix}-project`);
  await post(`/api/v1/projects/${project.id}/briefs`, { content: { objective: 'Verify final digest deployment', acceptance: ['completed'] } }, `final-${suffix}-brief`);
  await post(`/api/v1/projects/${project.id}/workflows`, { tasks: [
    { id: 'inspect', level: 1, mode: 'read' },
    { id: 'change', level: 2, mode: 'write', deps: ['inspect'] }
  ] }, `final-${suffix}-workflow`);
  const execution = await post(`/api/v1/projects/${project.id}/executions`, {}, `final-${suffix}-execution`);
  await post(`/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, `final-${suffix}-start`);
  let final = execution;
  for (let index = 0; index < 200; index += 1) {
    final = await (await fetch(`http://127.0.0.1:4317/api/v1/executions/${execution.id}`)).json();
    if (final.status === 'completed') break;
    if (['failed', 'awaiting_human', 'cancelled'].includes(final.status)) throw new Error(`production_execution_${final.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (final.status !== 'completed') throw new Error('production_execution_timeout');
  return { project_id: project.id, execution_id: execution.id, status: final.status, tasks: final.tasks };
}

function standaloneCompose({ app, broker, runner, volume, secretFile }) {
  const secret = secretFile.replaceAll('\\', '/');
  return `services:
  app:
    image: ${app}
    init: true
    read_only: true
    labels: { aiws.owner: aiws-v3, aiws.role: app }
    ports: ["127.0.0.1:4317:4317"]
    environment:
      NODE_ENV: production
      AIWS_HOME: /var/lib/aiws
      AIWS_DOCKER_DATA_VOLUME: ${volume}
      AIWS_BROKER_URL: http://runner-broker:4321
      AIWS_BROKER_MODE: http
      AIWS_RUNNER_DIGEST: ${runner}
    secrets: [broker_hmac]
    volumes: [data:/var/lib/aiws]
    tmpfs: [/tmp:size=256m,mode=1777]
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    networks: [internal, edge]
  runner-broker:
    image: ${broker}
    init: true
    read_only: true
    labels: { aiws.owner: aiws-v3, aiws.role: runner-broker }
    environment:
      NODE_ENV: production
      AIWS_BROKER_EXECUTOR: docker
      AIWS_BROKER_DATA_ROOT: /var/lib/aiws
      AIWS_DOCKER_DATA_VOLUME: ${volume}
      AIWS_RUNNER_DIGEST: ${runner}
      AIWS_RUNNER_IMAGE: ${runner}
    secrets: [broker_hmac]
    volumes: [/var/run/docker.sock:/var/run/docker.sock, data:/var/lib/aiws]
    tmpfs: [/tmp:size=256m,mode=1777]
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    networks: [internal]
networks:
  internal: { internal: true }
  edge: {}
volumes:
  data: { external: true, name: ${volume} }
secrets:
  broker_hmac: { file: "${secret}" }
`;
}

function writeRollback({ previous, helperImage, archive, archiveSha256, secretFile }) {
  const rollbackCompose = path.join(releaseRoot, `compose-production-rollback-${stamp}.yml`);
  fs.writeFileSync(rollbackCompose, standaloneCompose({ app: previous.app, broker: previous.broker, runner: previous.runner, volume: 'aiws-data-v3', secretFile }), { flag: 'wx', mode: 0o444 });
  const script = path.join(releaseRoot, `rollback-production-${stamp}.ps1`);
  const Helper = '$($Helper)';
  const content = `param([switch]$ValidateOnly)\n$ErrorActionPreference = 'Stop'\n$BackupArchive = '${archive.replaceAll("'", "''")}'\n$ExpectedHash = '${archiveSha256}'\n$ComposeFile = '${rollbackCompose.replaceAll("'", "''")}'\n$DataVolume = 'aiws-data-v3'\n$FailedVolume = 'aiws-data-v3-failed-${stamp}'\n$HelperImage = '${helperImage}'\n$Images = @('${previous.app}','${previous.broker}','${previous.runner}')\nforeach ($Image in $Images) { & docker image inspect $Image *> $null; if ($LASTEXITCODE -ne 0) { throw "rollback_image_missing:$Image" } }\n& docker volume inspect $DataVolume *> $null\nif ($LASTEXITCODE -ne 0) { throw 'rollback_volume_missing' }\nif (-not (Test-Path -LiteralPath $BackupArchive)) { throw 'rollback_archive_missing' }\nif ((Get-FileHash -LiteralPath $BackupArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) { throw 'rollback_archive_hash_mismatch' }\nif (-not (Test-Path -LiteralPath $ComposeFile)) { throw 'rollback_compose_missing' }\nif ($ValidateOnly) { Write-Output 'rollback validation passed'; exit 0 }\n& docker rm -f aiws-v3-app-1 aiws-v3-runner-broker-1 2>$null\n& docker volume create --label aiws.owner=aiws-v3 --label aiws.role=failed-preservation $FailedVolume *> $null\nif ($LASTEXITCODE -ne 0) { throw 'rollback_failed_volume_create' }\n& docker run --rm --label aiws.owner=aiws-v3 --mount "type=volume,src=$DataVolume,dst=/source,readonly" --mount "type=volume,src=$FailedVolume,dst=/target" $HelperImage sh -c 'tar -C /source -cf - . | tar -C /target -xf -'\nif ($LASTEXITCODE -ne 0) { throw 'rollback_failed_volume_copy' }\n$Helper = 'aiws-v3-rollback-restore-${stamp}'\n& docker create --name $Helper --label aiws.owner=aiws-v3 --mount "type=volume,src=$DataVolume,dst=/target" $HelperImage sh -c 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /target -xzf /tmp/data.tar.gz' *> $null\nif ($LASTEXITCODE -ne 0) { throw 'rollback_restore_helper_create' }\ntry {\n  & docker cp $BackupArchive "${Helper}:/tmp/data.tar.gz"\n  if ($LASTEXITCODE -ne 0) { throw 'rollback_archive_copy' }\n  & docker start --attach $Helper\n  if ($LASTEXITCODE -ne 0) { throw 'rollback_archive_restore' }\n} finally { & docker rm -f $Helper *> $null }\n& docker compose -p aiws-v3 -f $ComposeFile up -d\nif ($LASTEXITCODE -ne 0) { throw 'rollback_compose_up' }\n$Ready = $false\nfor ($Index = 0; $Index -lt 120; $Index++) { try { $Response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4317/readyz' -TimeoutSec 2; if ($Response.StatusCode -eq 200) { $Ready = $true; break } } catch {}; Start-Sleep -Milliseconds 250 }\nif (-not $Ready) { throw 'rollback_ready_timeout' }\nWrite-Output "rollback complete; failed volume preserved as $FailedVolume"\n`;
  fs.writeFileSync(script, `\uFEFF${content}`, { flag: 'wx', mode: 0o444 });
  fs.chmodSync(script, 0o444);
  return { script, compose: rollbackCompose };
}

fs.mkdirSync(releaseRoot, { recursive: true });
const commit = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('release_promotion_requires_clean_commit');
const imageReceiptPath = latest('v3-images-');
const acceptanceReceiptPath = latest('v3-acceptance-docker-');
const recoveryReceiptPath = latest('v3-recovery-');
const imageReceipt = JSON.parse(fs.readFileSync(imageReceiptPath, 'utf8'));
const acceptanceReceipt = JSON.parse(fs.readFileSync(acceptanceReceiptPath, 'utf8'));
const recoveryReceipt = JSON.parse(fs.readFileSync(recoveryReceiptPath, 'utf8'));
if (imageReceipt.source?.commit !== commit || acceptanceReceipt.source?.commit !== commit || recoveryReceipt.source?.commit !== commit) throw new Error('promotion_receipt_commit_mismatch');
if (imageReceipt.status !== 'candidate' || acceptanceReceipt.status !== 'passed' || recoveryReceipt.status !== 'passed') throw new Error('promotion_gate_not_passed');
assertFormalCapabilities(acceptanceReceipt.capabilities, 'acceptance_receipt');
const byRole = Object.fromEntries(imageReceipt.images.map((image) => [image.role, image]));
for (const role of ['app', 'broker', 'runner']) run(`verify-candidate-${role}`, 'docker', ['image', 'inspect', byRole[role].image_id]);
const secretFile = path.join(root, 'docker', 'secrets', 'broker_hmac');
if (!fs.existsSync(secretFile) || fs.readFileSync(secretFile, 'utf8').trim().length < 32) throw new Error('production_broker_secret_invalid');

const oldApp = inspect('aiws-v3-app-1');
const oldBroker = inspect('aiws-v3-runner-broker-1');
const oldRunner = JSON.parse(run('inspect-previous-runner', 'docker', ['image', 'inspect', 'aiws-codex-runner:3.0.0']).stdout)[0];
const previous = { app: oldApp.Image, broker: oldBroker.Image, runner: oldRunner.Id };
const productionVolume = inspect('aiws-data-v3');
if (productionVolume.Name !== 'aiws-data-v3' || productionVolume.Labels?.['aiws.owner'] !== 'aiws-v3') throw new Error('production_volume_identity_mismatch');

commandEnv = {
  ...process.env,
  AIWS_APP_IMAGE: byRole.app.image_id,
  AIWS_BROKER_IMAGE: byRole.broker.image_id,
  AIWS_RUNNER_IMAGE: byRole.runner.image_id,
  AIWS_RUNNER_DIGEST: byRole.runner.image_id,
  AIWS_COMMIT: commit,
  AIWS_PORT: '4317'
};

const productionArchive = path.join(releaseRoot, `v3-production-backup-${stamp}.tar.gz`);
const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-production-'));
try {
  run('stop-current-production', 'docker', ['compose', '-p', 'aiws-v3', '-f', path.join(root, 'compose.yml'), 'stop']);
  oldStopped = true;
  archiveVolume('aiws-data-v3', byRole.app.image_id, productionArchive);
  run('extract-production-backup', 'tar', ['-xzf', productionArchive, '-C', extractionRoot]);
  const productionManifest = manifest(extractionRoot);
  const productionSqlite = sqliteEvidence(extractionRoot);
  if (productionSqlite.integrity.join(',') !== 'ok' || productionSqlite.user_version !== 1 || productionSqlite.foreign_key_violations.length) throw new Error('production_backup_validation_failed');
  const backupReceipt = writeReceipt(`v3-production-backup-${stamp}.json`, {
    schema_version: 'aiws.v3.production_backup_receipt.v1', status: 'passed', source: imageReceipt.source,
    volume: { name: 'aiws-data-v3', labels: productionVolume.Labels },
    archive: { path: path.relative(root, productionArchive).replaceAll('\\', '/'), sha256: sha256File(productionArchive) },
    manifest: { file_count: productionManifest.length, sha256: sha256(JSON.stringify(productionManifest)) },
    sqlite: productionSqlite,
    previous_images: previous,
    commands
  });
  const rollback = writeRollback({ previous, helperImage: byRole.app.image_id, archive: productionArchive, archiveSha256: sha256File(productionArchive), secretFile });
  rollbackScript = rollback.script;
  const powershell = powershellExecutable();
  const rollbackValidation = run('validate-production-rollback', powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rollback.script, '-ValidateOnly']);

  run('remove-current-production', 'docker', ['compose', '-p', 'aiws-v3', '-f', path.join(root, 'compose.yml'), 'down', '--remove-orphans']);
  run('promote-runner-tag', 'docker', ['image', 'tag', byRole.runner.image_id, 'aiws-codex-runner:3.0.0']);
  run('promote-broker-tag', 'docker', ['image', 'tag', byRole.broker.image_id, 'aiws-runner-broker:3.0.0']);
  run('promote-app-tag', 'docker', ['image', 'tag', byRole.app.image_id, 'aiws-app:3.0.0']);
  run('start-final-production', 'docker', ['compose', '-p', 'aiws-v3', '-f', path.join(root, 'compose.yml'), 'up', '-d', '--no-build']);
  switched = true;
  oldStopped = false;
  const ready = await waitReady();
  const journey = await productionJourney();
  const capabilities = await (await fetch('http://127.0.0.1:4317/api/v1/system/capabilities')).json();
  assertFormalCapabilities(capabilities, 'production_probe');
  const appPerformance = await (await fetch('http://127.0.0.1:4317/api/v1/system/performance')).json();
  const finalApp = inspect('aiws-v3-app-1');
  const finalBroker = inspect('aiws-v3-runner-broker-1');
  if (finalApp.Image !== byRole.app.image_id || finalBroker.Image !== byRole.broker.image_id) throw new Error('final_container_digest_mismatch');
  if (finalApp.Config?.Labels?.['aiws.owner'] !== 'aiws-v3' || finalBroker.Config?.Labels?.['aiws.owner'] !== 'aiws-v3') throw new Error('final_container_owner_label_missing');
  run('verify-final-app-no-docker-cli', 'docker', ['exec', 'aiws-v3-app-1', 'sh', '-c', 'command -v docker'], [1, 127]);
  if (capabilities.broker?.runner_digest !== byRole.runner.image_id) throw new Error('final_runner_digest_mismatch');

  const promotionReceipt = writeReceipt(`v3-promotion-${stamp}.json`, {
    schema_version: 'aiws.v3.promotion_receipt.v1', status: 'passed', source: imageReceipt.source,
    gate_receipt: imageReceipt.gate_receipt,
    image_receipt: path.relative(root, imageReceiptPath).replaceAll('\\', '/'),
    acceptance_receipt: path.relative(root, acceptanceReceiptPath).replaceAll('\\', '/'),
    recovery_receipt: path.relative(root, recoveryReceiptPath).replaceAll('\\', '/'),
    production_backup_receipt: path.relative(root, backupReceipt).replaceAll('\\', '/'),
    images: { app: byRole.app.image_id, broker: byRole.broker.image_id, runner: byRole.runner.image_id },
    previous_images: previous,
    formal_tags: ['aiws-app:3.0.0', 'aiws-runner-broker:3.0.0', 'aiws-codex-runner:3.0.0'],
    ready, capabilities, performance: appPerformance, journey,
    rollback: {
      script: path.relative(root, rollback.script).replaceAll('\\', '/'), sha256: sha256File(rollback.script),
      compose: path.relative(root, rollback.compose).replaceAll('\\', '/'), validation_command: rollbackValidation.command,
      validation_output: rollbackValidation.stdout, validation_exit_status: rollbackValidation.exit_status
    },
    commands
  });
  promoted = true;

  const v22Containers = run('enumerate-v22-containers', 'docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project=aiws-v22', '--format', '{{.Names}}']).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (v22Containers.some((name) => name !== 'aiws-v22-app-1')) throw new Error(`unexpected_v22_container:${v22Containers.join(',')}`);
  const v22Volume = JSON.parse(run('inspect-v22-volume', 'docker', ['volume', 'inspect', 'aiws-data-v22']).stdout)[0];
  if (v22Volume.Labels?.['aiws.owner'] !== 'aiws-v22') throw new Error('v22_volume_owner_mismatch');
  const v22Image = JSON.parse(run('inspect-v22-image', 'docker', ['image', 'inspect', 'aiws-app:2.2.0']).stdout)[0];
  if (v22Containers.length) run('remove-v22-container', 'docker', ['rm', '-f', ...v22Containers]);
  run('remove-v22-volume', 'docker', ['volume', 'rm', 'aiws-data-v22']);
  run('remove-v22-image', 'docker', ['image', 'rm', 'aiws-app:2.2.0']);
  run('verify-v22-container-removed', 'docker', ['container', 'inspect', 'aiws-v22-app-1'], [1]);
  run('verify-v22-volume-removed', 'docker', ['volume', 'inspect', 'aiws-data-v22'], [1]);
  run('verify-v22-image-removed', 'docker', ['image', 'inspect', v22Image.Id], [1]);
  const cleanupReceipt = writeReceipt(`v22-cleanup-${stamp}.json`, {
    schema_version: 'aiws.v3.targeted_cleanup_receipt.v1', status: 'passed',
    scope: { containers: v22Containers, volume: v22Volume.Name, image_tag: 'aiws-app:2.2.0', image_id: v22Image.Id },
    preconditions: {
      v23_archive_receipt: path.relative(root, latest('v23-cold-archive-')).replaceAll('\\', '/'),
      v3_promotion_receipt: path.relative(root, promotionReceipt).replaceAll('\\', '/')
    },
    global_prune_used: false,
    commands: commands.filter((record) => record.label.includes('v22'))
  });
  const finalReceipt = writeReceipt(`v3-final-release-${stamp}.json`, {
    schema_version: 'aiws.v3.final_release_receipt.v1', status: 'passed', source: imageReceipt.source,
    promotion_receipt: path.relative(root, promotionReceipt).replaceAll('\\', '/'),
    cleanup_receipt: path.relative(root, cleanupReceipt).replaceAll('\\', '/'),
    url: 'http://127.0.0.1:4317',
    images: { app: byRole.app.image_id, broker: byRole.broker.image_id, runner: byRole.runner.image_id },
    volume: 'aiws-data-v3', journey
  });
  process.stdout.write(`${JSON.stringify({ status: 'passed', url: 'http://127.0.0.1:4317', final_receipt: finalReceipt, cleanup_receipt: cleanupReceipt, images: { app: byRole.app.image_id, broker: byRole.broker.image_id, runner: byRole.runner.image_id } }, null, 2)}\n`);
} catch (error) {
  let rollback = null;
  if (switched && !promoted && rollbackScript) {
    const powershell = powershellExecutable();
    rollback = run('automatic-production-rollback', powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rollbackScript], [0, 1]);
  } else if (oldStopped) {
    rollback = run('restart-previous-production', 'docker', ['start', 'aiws-v3-runner-broker-1', 'aiws-v3-app-1'], [0, 1]);
  }
  const failure = writeReceipt(`v3-promotion-failure-${stamp}.json`, {
    schema_version: 'aiws.v3.promotion_failure_receipt.v1', status: 'failed', error: error.message,
    rollback: rollback ? { command: rollback.command, exit_status: rollback.exit_status, stdout: rollback.stdout, stderr: rollback.stderr } : null,
    commands
  });
  process.stderr.write(`release promotion failed; receipt: ${failure}\n`);
  process.exitCode = 1;
}
