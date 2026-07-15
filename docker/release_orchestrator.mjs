#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireConfirmation, selectTargetVolume, V17_SOURCE_VOLUME as SOURCE_VOLUME, V17_TARGET_VOLUME as TARGET_VOLUME } from './release_volume.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, '.ai-workspace', 'release');
const BACKUP_DIR = path.join(ROOT, '.ai-workspace', 'backups');
const DEFAULT_APP_IMAGE = 'aiws-app:1.7.0';
const DEFAULT_RUNNER_IMAGE = 'aiws-codex-runner:1.7.0-codex-0.144.0';
const FORMAL_PROJECT = 'aiws-v17';
const LEGACY_PROJECTS = Object.freeze(['aiws-v16', 'aiws-v17-preview']);
const PURGE_PROJECTS = Object.freeze(['aiws-v14', 'aiws-v15', 'aiws-v16', 'aiws-v17-preview']);
const LEGACY_IMAGES = Object.freeze([
  'aiws-app:1.4.0',
  'aiws-verify:1.4.0',
  'aiws-codex-runner:1.4.0-codex-0.144.0',
  'aiws-app:1.5.0',
  'aiws-verify:1.5.0',
  'aiws-codex-runner:1.5.0-codex-0.144.0',
  'aiws-app:1.6.0',
  'aiws-verify:1.6.0',
  'aiws-codex-runner:1.6.0-codex-0.144.0',
  'aiws-codex-runner:local'
]);
const LEGACY_RUNNER_CONTAINER_PATTERN = /^aiws-codex-runner:(?:1\.[0-6]\.0-codex-\d+\.\d+\.\d+|local)$/;

export async function runReleaseUp(options = {}) {
  const config = releaseConfig(options);
  setComposeEnvironment(config);
  const targetExists = volumeExists(config.targetVolume);
  const sourceExists = volumeExists(config.sourceVolume);
  const targetEmpty = !targetExists || volumeEmpty(config.targetVolume, config.appImage);
  const sourceEmpty = !sourceExists || volumeEmpty(config.sourceVolume, config.appImage);
  const disposition = selectTargetVolume({ targetExists, targetEmpty, sourceExists, sourceEmpty });
  const context = {
    version: '1.7.0',
    started_at: new Date().toISOString(),
    source_volume: config.sourceVolume,
    target_volume: config.targetVolume,
    source_exists: sourceExists,
    source_empty: sourceEmpty,
    target_existed: targetExists,
    target_empty: targetEmpty,
    disposition,
    discard_unmigratable: config.discardUnmigratable,
    stopped_containers: [],
    migration_volume: null,
    archive_sha256: null,
    acceptance: null,
    probe: null,
    status: 'preparing'
  };
  await writeTranscript('v17-cutover-latest.json', context);

  try {
    context.stopped_containers = stopLegacyApps();
    await waitForPortDisposition(config.port, config.projectName);
    if (disposition === 'clone') {
      const cloned = initializeFromSource(config);
      Object.assign(context, cloned);
    } else if (disposition === 'fresh') {
      createTargetVolume(config.targetVolume);
    }
    compose(config, ['up', '-d', '--remove-orphans']);
    const health = await waitForHealthy(config);
    context.health = health;
    context.acceptance = disposition === 'clone'
      ? acceptTarget(config, 'migrated', context)
      : disposition === 'fresh'
        ? acceptTarget(config, 'fresh', context)
        : checkAcceptedTarget(config);
    context.probe = await reprobeActiveProfile(config.port);
    context.status = 'accepted';
    context.completed_at = new Date().toISOString();
    await writeTranscript('v17-cutover-latest.json', context);
    process.stdout.write(`AIWS V1.7 accepted at http://127.0.0.1:${config.port}\n`);
    return context;
  } catch (error) {
    context.failure = { code: error.code || 'v17_release_failed', message: String(error.message || error) };
    context.failed_at = new Date().toISOString();
    compose(config, ['down', '--remove-orphans'], { allowFailure: true });
    restartContainers(context.stopped_containers);
    context.status = 'failed_source_preserved';
    await writeTranscript('v17-cutover-latest.json', context);
    throw error;
  }
}

export async function purgeLegacy(options = {}) {
  requireConfirmation(options.confirm === true);
  const config = releaseConfig(options);
  if (config.targetVolume !== TARGET_VOLUME || config.port !== 4317 || config.projectName !== FORMAL_PROJECT) throw releaseError('purge_legacy_formal_target_required');
  setComposeEnvironment(config);
  const beforeHealth = await waitForHealthy(config, { attempts: 2, delayMs: 1000 });
  const acceptance = checkAcceptedTarget(config);
  assertNoLegacyRunnerContainers();

  const transcript = {
    version: '1.7.0',
    started_at: new Date().toISOString(),
    pre_cleanup_health: beforeHealth,
    acceptance,
    removed: { containers: [], networks: [], volumes: [], images: [], host_backups: [], schema_backups: [] },
    status: 'cleaning'
  };
  await writeTranscript('v17-purge-latest.json', transcript);

  transcript.removed.containers = removeProjectContainers(PURGE_PROJECTS);
  transcript.removed.networks = removeProjectNetworks(PURGE_PROJECTS);
  transcript.removed.volumes = removeLegacyVolumes(config.targetVolume);
  transcript.removed.images = removeLegacyImages();
  transcript.removed.host_backups = await clearHostBackups();
  transcript.removed.schema_backups = purgeTargetSchemaBackups(config);

  if (await portListening(4318)) throw releaseError('preview_port_4318_still_listening');
  assertLegacyResourcesAbsent();
  compose(config, ['restart', 'app']);
  transcript.post_restart_health = await waitForHealthy(config);
  transcript.post_restart_acceptance = checkAcceptedTarget(config);
  transcript.status = 'complete';
  transcript.completed_at = new Date().toISOString();
  await writeTranscript('v17-purge-latest.json', transcript);
  process.stdout.write('Legacy AIWS resources and historical backups purged; V1.7 restart verified.\n');
  return transcript;
}

function releaseConfig(options) {
  const composeFile = path.resolve(options.composeFile || path.join(ROOT, 'compose.yml'));
  const override = options.override ? path.resolve(options.override) : null;
  if (!fs.existsSync(composeFile)) throw releaseError('compose_file_missing');
  if (override && !fs.existsSync(override)) throw releaseError('compose_override_missing');
  const port = Number(options.port ?? process.env.AIWS_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw releaseError('release_port_invalid');
  return {
    composeFile,
    override,
    projectName: options.projectName || FORMAL_PROJECT,
    sourceVolume: options.sourceVolume || SOURCE_VOLUME,
    targetVolume: options.targetVolume || TARGET_VOLUME,
    appImage: options.appImage || process.env.AIWS_APP_IMAGE || DEFAULT_APP_IMAGE,
    runnerImage: options.runnerImage || process.env.AIWS_RUNNER_IMAGE || DEFAULT_RUNNER_IMAGE,
    port,
    discardUnmigratable: options.discardUnmigratable === true
  };
}

function setComposeEnvironment(config) {
  process.env.AIWS_DOCKER_DATA_VOLUME = config.targetVolume;
  process.env.AIWS_APP_IMAGE = config.appImage;
  process.env.AIWS_RUNNER_IMAGE = config.runnerImage;
  process.env.AIWS_PORT = String(config.port);
}

function initializeFromSource(config) {
  createTargetVolume(config.targetVolume);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const migrationVolume = `aiws-v17-migration-${stamp}-${process.pid}`.toLowerCase();
  docker(['volume', 'create', '--label', 'aiws.owner=aiws-v17-release', '--label', 'aiws.role=migration', '--label', `aiws.source=${config.sourceVolume}`, '--label', `aiws.target=${config.targetVolume}`, migrationVolume]);
  try {
    docker([
      'run', '--rm', '--entrypoint', 'python3',
      '--mount', `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount', `type=volume,src=${migrationVolume},dst=/migration`,
      config.appImage, '/opt/aiws/backup_archive.py', 'create', '/source', '/migration/source.tar.gz'
    ]);
    docker(['run', '--rm', '--entrypoint', 'python3', '--mount', `type=volume,src=${migrationVolume},dst=/migration,readonly`, config.appImage, '/opt/aiws/backup_archive.py', 'validate', '/migration/source.tar.gz']);
    const archiveSha256 = docker(['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${migrationVolume},dst=/migration,readonly`, config.appImage, '-c', 'sha256sum /migration/source.tar.gz | cut -d" " -f1'], { capture: true });
    docker([
      'run', '--rm', '--entrypoint', 'python3',
      '--mount', `type=volume,src=${migrationVolume},dst=/migration,readonly`,
      '--mount', `type=volume,src=${config.targetVolume},dst=/target`,
      config.appImage, '/opt/aiws/backup_archive.py', 'extract', '/migration/source.tar.gz', '/target'
    ]);
    docker([
      'run', '--rm', '--entrypoint', 'node',
      '--mount', `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount', `type=volume,src=${config.targetVolume},dst=/target,readonly`,
      '--mount', `type=volume,src=${migrationVolume},dst=/migration`,
      config.appImage, '/app/docker/release_volume.mjs', 'clone-verify-v17', '/source', '/target', '/migration/clone.manifest.json', archiveSha256, config.sourceVolume, config.targetVolume
    ]);
    return { migration_volume: migrationVolume, archive_sha256: archiveSha256 };
  } catch (error) {
    error.migrationVolume = migrationVolume;
    throw error;
  }
}

function acceptTarget(config, mode, context) {
  const args = [
    'run', '--rm', '--entrypoint', 'node',
    '--mount', `type=volume,src=${config.targetVolume},dst=/target`,
    ...(context.migration_volume ? ['--mount', `type=volume,src=${context.migration_volume},dst=/migration,readonly`] : []),
    ...(volumeExists(config.sourceVolume) ? ['--mount', `type=volume,src=${config.sourceVolume},dst=/source,readonly`] : []),
    config.appImage,
    '/app/docker/release_volume.mjs', 'accept-v17', mode, '/target',
    volumeExists(config.sourceVolume) ? '/source' : '-',
    context.migration_volume ? '/migration/clone.manifest.json' : '-',
    context.archive_sha256 || '-', context.migration_volume || '-', config.sourceVolume, config.targetVolume
  ];
  const output = docker(args, { capture: true });
  return parseJsonOutput(output, 'release_acceptance_output_invalid');
}

function checkAcceptedTarget(config) {
  const output = docker([
    'run', '--rm', '--entrypoint', 'node',
    '--mount', `type=volume,src=${config.targetVolume},dst=/target,readonly`,
    config.appImage, '/app/docker/release_volume.mjs', 'check-v17', '/target', config.targetVolume
  ], { capture: true });
  return parseJsonOutput(output, 'release_acceptance_check_invalid');
}

function purgeTargetSchemaBackups(config) {
  const output = docker([
    'run', '--rm', '--entrypoint', 'node',
    '--mount', `type=volume,src=${config.targetVolume},dst=/target`,
    config.appImage, '/app/docker/release_volume.mjs', 'purge-schema-backups', '/target'
  ], { capture: true });
  return parseJsonOutput(output, 'schema_backup_purge_output_invalid').removed || [];
}

function stopLegacyApps() {
  const stopped = [];
  for (const project of LEGACY_PROJECTS) {
    for (const id of containerIds(project, { running: true })) {
      const detail = inspectContainer(id);
      docker(['stop', '--time', '30', id]);
      stopped.push({ id, project, name: detail.name, image: detail.image });
    }
  }
  return stopped;
}

function restartContainers(containers) {
  for (const item of containers || []) {
    if (!containerExists(item.id)) continue;
    docker(['start', item.id], { allowFailure: true });
  }
}

async function waitForPortDisposition(port, projectName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await portListening(port))) return;
    const formal = containerIds(projectName, { running: true });
    if (formal.length) return;
    await sleep(200);
  }
  throw releaseError(`port_${port}_in_use`);
}

async function waitForHealthy(config, { attempts = 60, delayMs = 2000 } = {}) {
  let lastHealth = 'missing';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ids = compose(config, ['ps', '-q', 'app'], { capture: true, allowFailure: true }).split(/\r?\n/).filter(Boolean);
    if (ids.length === 1) {
      const detail = inspectContainer(ids[0]);
      lastHealth = detail.health;
      if (detail.image !== config.appImage) throw releaseError('formal_app_image_mismatch', { expected: config.appImage, actual: detail.image });
      if (detail.project !== config.projectName) throw releaseError('formal_compose_project_mismatch', { expected: config.projectName, actual: detail.project });
      if (detail.health === 'healthy') {
        const published = docker(['port', ids[0], '4317/tcp'], { capture: true });
        if (!published.split(/\r?\n/).includes(`127.0.0.1:${config.port}`)) throw releaseError('formal_loopback_port_mismatch', { published });
        const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        if (!response.ok || health.status !== 'ok' || health.api?.healthy !== true || health.db?.healthy !== true || health.version !== '1.7.0' || health.schema_version !== 16) throw releaseError('formal_health_api_invalid', { version: health.version, schema_version: health.schema_version });
        return { container_id: ids[0], image: detail.image, project: detail.project, health: detail.health, http_status: response.status, api_status: health.status, version: health.version, schema_version: health.schema_version };
      }
      if (detail.health === 'unhealthy' || detail.status === 'exited') throw releaseError(`app_${detail.health === 'unhealthy' ? 'unhealthy' : 'exited'}`);
    }
    await sleep(delayMs);
  }
  throw releaseError('app_health_timeout', { last_health: lastHealth });
}

async function reprobeActiveProfile(port) {
  try {
    const profilesResponse = await fetch(`http://127.0.0.1:${port}/api/codex/profiles`, { signal: AbortSignal.timeout(5000) });
    const profiles = await profilesResponse.json();
    const active = Array.isArray(profiles) ? profiles.find((item) => item.is_active && item.status === 'validated') : null;
    if (!active) return { attempted: false, status: 'skipped', reason: 'active_validated_profile_missing' };
    const response = await fetch(`http://127.0.0.1:${port}/api/codex/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: active.id }),
      signal: AbortSignal.timeout(180000)
    });
    const body = await response.json().catch(() => ({}));
    return { attempted: true, profile_id: active.id, status: response.ok ? 'ready' : 'failed', http_status: response.status, error: response.ok ? null : body.error || 'probe_failed' };
  } catch (error) {
    return { attempted: true, status: 'failed', error: error.name === 'TimeoutError' ? 'probe_timeout' : 'probe_request_failed' };
  }
}

function createTargetVolume(volume) {
  if (volumeExists(volume)) {
    if (!volumeEmpty(volume, process.env.AIWS_APP_IMAGE || DEFAULT_APP_IMAGE)) throw releaseError('target_volume_not_empty');
    return;
  }
  docker(['volume', 'create', '--label', 'aiws.owner=aiws-v17', '--label', 'aiws.role=production-data', '--label', 'aiws.schema=16', volume]);
}

function volumeExists(volume) {
  return raw('docker', ['volume', 'inspect', volume], { capture: true }).status === 0;
}

function volumeEmpty(volume, appImage) {
  const result = raw('docker', ['run', '--rm', '--entrypoint', 'sh', '--mount', `type=volume,src=${volume},dst=/data,readonly`, appImage, '-c', 'test -z "$(ls -A /data)"'], { capture: true });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw commandError('volume_empty_check_failed', result);
}

function removeProjectContainers(projects) {
  const removed = [];
  for (const project of projects) for (const id of containerIds(project)) {
    const detail = inspectContainer(id);
    docker(['container', 'rm', '-f', id]);
    removed.push(detail.name);
  }
  return removed.sort();
}

function removeProjectNetworks(projects) {
  const removed = [];
  for (const project of projects) {
    const ids = docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { capture: true, allowFailure: true }).split(/\r?\n/).filter(Boolean);
    for (const id of ids) {
      const name = docker(['network', 'inspect', id, '--format', '{{.Name}}'], { capture: true });
      docker(['network', 'rm', id]);
      removed.push(name);
    }
  }
  return [...new Set(removed)].sort();
}

function removeLegacyVolumes(targetVolume) {
  const candidates = new Set([SOURCE_VOLUME, 'aiws-v17-preview-data']);
  for (const project of PURGE_PROJECTS) {
    const names = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { capture: true, allowFailure: true }).split(/\r?\n/).filter(Boolean);
    names.forEach((name) => candidates.add(name));
  }
  const migrations = docker(['volume', 'ls', '-q', '--filter', 'label=aiws.owner=aiws-v17-release', '--filter', 'label=aiws.role=migration'], { capture: true, allowFailure: true }).split(/\r?\n/).filter(Boolean);
  migrations.forEach((name) => candidates.add(name));
  candidates.delete(targetVolume);
  const removed = [];
  for (const volume of candidates) {
    if (!volumeExists(volume)) continue;
    docker(['volume', 'rm', volume]);
    removed.push(volume);
  }
  return removed.sort();
}

function removeLegacyImages() {
  const removed = [];
  for (const image of LEGACY_IMAGES) {
    if (raw('docker', ['image', 'inspect', image], { capture: true }).status !== 0) continue;
    docker(['image', 'rm', image]);
    removed.push(image);
  }
  return removed;
}

async function clearHostBackups() {
  const workspace = path.resolve(ROOT);
  const resolved = path.resolve(BACKUP_DIR);
  const relative = path.relative(workspace, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.replaceAll('\\', '/') !== '.ai-workspace/backups') throw releaseError('backup_cleanup_path_invalid');
  await fsp.mkdir(resolved, { recursive: true });
  const entries = await fsp.readdir(resolved);
  for (const entry of entries) await fsp.rm(path.join(resolved, entry), { recursive: true, force: true });
  return entries.sort();
}

function assertNoLegacyRunnerContainers() {
  const lines = docker(['ps', '-a', '--format', '{{.ID}}\t{{.Image}}\t{{.Names}}'], { capture: true }).split(/\r?\n/).filter(Boolean);
  const found = lines.map((line) => line.split('\t')).filter(([, image]) => LEGACY_RUNNER_CONTAINER_PATTERN.test(image || ''));
  if (found.length) throw releaseError('legacy_runner_container_references_remain', { containers: found.map(([id, image, name]) => ({ id, image, name })) });
}

function assertLegacyResourcesAbsent() {
  for (const project of PURGE_PROJECTS) if (containerIds(project).length) throw releaseError('legacy_container_cleanup_incomplete', { project });
  for (const volume of [SOURCE_VOLUME, 'aiws-v17-preview-data']) if (volumeExists(volume)) throw releaseError('legacy_volume_cleanup_incomplete', { volume });
  for (const image of LEGACY_IMAGES) if (raw('docker', ['image', 'inspect', image], { capture: true }).status === 0) throw releaseError('legacy_image_cleanup_incomplete', { image });
  const backupEntries = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
  if (backupEntries.length) throw releaseError('host_backup_cleanup_incomplete');
}

function containerIds(project, { running = false } = {}) {
  const args = ['ps', ...(running ? [] : ['-a']), '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=app'];
  return docker(args, { capture: true, allowFailure: true }).split(/\r?\n/).filter(Boolean);
}

function containerExists(id) {
  return raw('docker', ['container', 'inspect', id], { capture: true }).status === 0;
}

function inspectContainer(id) {
  const output = docker(['inspect', id, '--format', '{{json .}}'], { capture: true });
  const value = JSON.parse(output);
  return {
    id: value.Id,
    name: String(value.Name || '').replace(/^\//, ''),
    image: value.Config?.Image || null,
    project: value.Config?.Labels?.['com.docker.compose.project'] || null,
    status: value.State?.Status || null,
    health: value.State?.Health?.Status || value.State?.Status || null
  };
}

function compose(config, args, options = {}) {
  const base = ['compose', '-f', config.composeFile, ...(config.override ? ['-f', config.override] : []), ...(config.projectName ? ['-p', config.projectName] : [])];
  return docker([...base, ...args], options);
}

function docker(args, options = {}) {
  const result = raw('docker', args, { capture: options.capture === true });
  if (result.status !== 0 && !options.allowFailure) throw commandError('docker_command_failed', result, args);
  return options.capture ? String(result.stdout || '').trim() : '';
}

function raw(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
  if (result.error) return { status: -1, stdout: result.stdout || '', stderr: result.error.message };
  return result;
}

function commandError(code, result, args = []) {
  return releaseError(code, { command: ['docker', ...args].join(' '), status: result.status, stderr: String(result.stderr || '').trim().slice(-2000) });
}

function parseJsonOutput(output, code) {
  try { return JSON.parse(output); }
  catch { throw releaseError(code); }
}

async function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function writeTranscript(name, value) {
  await fsp.mkdir(RELEASE_DIR, { recursive: true });
  const file = path.join(RELEASE_DIR, name);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function parseCli(argv) {
  const [command = 'status', ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--confirm') options.confirm = true;
    else if (token === '--discard-unmigratable') options.discardUnmigratable = true;
    else if (['--compose-file', '--override', '--source-volume', '--target-volume', '--app-image', '--runner-image', '--port', '--project-name'].includes(token)) {
      const value = tokens[++index];
      if (!value) throw releaseError('release_option_value_missing', { option: token });
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = token === '--port' ? Number(value) : value;
    } else throw releaseError('release_option_unknown', { option: token });
  }
  return { command, options };
}

export async function runReleaseCli(argv) {
  const { command, options } = parseCli(argv);
  if (command === 'up') await runReleaseUp(options);
  else if (command === 'purge-legacy') await purgeLegacy(options);
  else throw releaseError('v17_release_usage');
}
