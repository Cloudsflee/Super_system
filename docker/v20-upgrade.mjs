#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { executionActivityProbeScript } from './v110-upgrade.mjs';
import { V20_SOURCE_VOLUME, V20_TARGET_VOLUME } from './release_volume.mjs';

export const V20_VERSION = '2.0.0';
export const V20_SCHEMA = 20;
export const V20_PROJECT = 'aiws-v20';
export const V110_PROJECT = 'aiws-v19';
export const V20_APP_IMAGE = 'aiws-app:2.0.0';
export const V20_RUNNER_IMAGE = 'aiws-codex-runner:2.0.0-codex-0.144.0';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export async function runV20Upgrade(options = {}) {
  const config = upgradeConfig(options);
  assertFormalConfig(config);
  assertRollbackImage(config.rollbackImage);
  const sourceExists = volumeExists(config.sourceVolume),
    targetExists = volumeExists(config.targetVolume),
    sourceEmpty = !sourceExists || volumeEmpty(config.sourceVolume, config.appImage),
    targetEmpty = !targetExists || volumeEmpty(config.targetVolume, config.appImage),
    disposition = targetExists && !targetEmpty ? 'reuse' : sourceExists && !sourceEmpty ? 'clone' : 'unavailable';
  if (disposition === 'unavailable')
    throw upgradeError('v20_schema19_source_required', {
      source_volume: config.sourceVolume,
      source_exists: sourceExists,
      source_empty: sourceEmpty,
      target_volume: config.targetVolume,
      target_exists: targetExists,
      target_empty: targetEmpty
    });

  const context = {
    version: V20_VERSION,
    schema: V20_SCHEMA,
    project: config.projectName,
    port: config.port,
    source_volume: config.sourceVolume,
    target_volume: config.targetVolume,
    source_exists: sourceExists,
    source_empty: sourceEmpty,
    target_existed: targetExists,
    target_empty: targetEmpty,
    disposition,
    source_mount_mode: 'readonly',
    source_preserved: true,
    started_at: new Date().toISOString(),
    stopped_v110_containers: [],
    stopped_v20_containers: [],
    rollback_image: config.rollbackImage,
    rollback: null,
    migration_volume: null,
    archive_sha256: null,
    migration: null,
    refresh: null,
    health: null,
    acceptance: null,
    v20_start_attempted: false,
    status: 'preparing'
  };
  await writeTranscript(context);

  try {
    if (disposition === 'reuse') {
      context.acceptance = checkAcceptedTarget(config, { deferProjection: true });
      context.activity = await waitForQuiescence(config, config.targetVolume);
      context.stopped_v20_containers = stopProjectApps(config.projectName);
      context.rollback_image ||= preserveRollbackImage(context.stopped_v20_containers);
    } else context.activity = await waitForQuiescence(config);
    context.stopped_v110_containers = stopProjectApps(V110_PROJECT);
    await waitForPortDisposition(config);

    if (disposition === 'clone') {
      const cloned = initializeFromV19(config);
      Object.assign(context, cloned, { status: 'migrating' });
      await writeTranscript(context);
      context.migration = migrateAndBuildContext(config);
    } else {
      context.status = 'refreshing_v20_context';
      await writeTranscript(context);
      context.refresh = migrateAndBuildContext(config);
      context.acceptance = checkAcceptedTarget(config);
    }

    context.status = 'starting_v20';
    context.v20_start_attempted = true;
    await writeTranscript(context);
    compose(config, ['up', '-d', '--remove-orphans']);
    context.health = await waitForHealth(config);
    context.acceptance = disposition === 'clone' ? acceptMigratedTarget(config, context) : checkAcceptedTarget(config);
    Object.assign(context, {
      status: 'accepted',
      source_preserved: true,
      completed_at: new Date().toISOString()
    });
    if (context.rollback_image) {
      removeRollbackImage(context.rollback_image);
      context.rollback_image_removed = true;
    }
    await writeTranscript(context);
    process.stdout.write(`AIWS V2.0 accepted at http://127.0.0.1:${config.port}; ${config.sourceVolume} retained.\n`);
    return context;
  } catch (error) {
    if (context.v20_start_attempted) compose(config, ['down', '--remove-orphans'], { allowFailure: true });
    if (disposition === 'reuse' && context.stopped_v20_containers.length) {
      try {
        context.rollback = await restorePreviousV20(config, context);
      } catch (rollbackError) {
        context.rollback = {
          restored: false,
          error_code: rollbackError.code || 'v20_rollback_failed',
          error: String(rollbackError.message || rollbackError)
        };
      }
    }
    const restored = context.rollback?.restored ? [] : restartContainers(context.stopped_v110_containers);
    const previousV20Unchanged =
      disposition === 'reuse' && context.status === 'preparing' && !context.stopped_v20_containers.length;
    Object.assign(context, {
      status: context.rollback?.restored
        ? 'failed_previous_v20_restored'
        : previousV20Unchanged
          ? 'failed_previous_v20_unchanged'
          : 'failed_v20_stopped_v110_restored',
      source_preserved: true,
      restored_v20_containers: context.rollback?.container_ids || [],
      restored_v110_containers: restored,
      failure: { code: error.code || 'v20_upgrade_failed', message: String(error.message || error) },
      failed_at: new Date().toISOString()
    });
    await writeTranscript(context);
    throw error;
  }
}

async function waitForQuiescence(config, volume = config.sourceVolume) {
  const deadline = Date.now() + config.waitMs;
  while (true) {
    const output = docker(
      [
        'run',
        '--rm',
        '--entrypoint',
        'node',
        '--mount',
        `type=volume,src=${volume},dst=/volume,readonly`,
        config.appImage,
        '-e',
        executionActivityProbeScript()
      ],
      { capture: true }
    );
    let activity;
    try {
      activity = JSON.parse(output);
      if (typeof activity?.active !== 'boolean' || !Array.isArray(activity.records)) throw new Error();
    } catch {
      throw upgradeError(volume === config.targetVolume ? 'v20_target_state_invalid' : 'v20_source_state_invalid');
    }
    if (!activity.active) return { records: [], checked_at: new Date().toISOString() };
    if (Date.now() >= deadline) throw upgradeError('v20_active_executions_timeout', { records: activity.records });
    await sleep(config.pollMs);
  }
}

function initializeFromV19(config) {
  createTargetVolume(config.targetVolume);
  const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 17),
    migrationVolume = `aiws-v20-migration-${stamp}-${process.pid}`.toLowerCase();
  docker([
    'volume',
    'create',
    '--label',
    'aiws.owner=aiws-v20-release',
    '--label',
    'aiws.role=migration',
    '--label',
    `aiws.source=${config.sourceVolume}`,
    '--label',
    `aiws.target=${config.targetVolume}`,
    migrationVolume
  ]);
  try {
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'python3',
      '--mount',
      `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount',
      `type=volume,src=${migrationVolume},dst=/migration`,
      config.appImage,
      '/opt/aiws/backup_archive.py',
      'create',
      '/source',
      '/migration/source.tar.gz'
    ]);
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'python3',
      '--mount',
      `type=volume,src=${migrationVolume},dst=/migration,readonly`,
      config.appImage,
      '/opt/aiws/backup_archive.py',
      'validate',
      '/migration/source.tar.gz'
    ]);
    const archiveSha256 = docker(
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '--mount',
        `type=volume,src=${migrationVolume},dst=/migration,readonly`,
        config.appImage,
        '-c',
        'sha256sum /migration/source.tar.gz | cut -d" " -f1'
      ],
      { capture: true }
    );
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'python3',
      '--mount',
      `type=volume,src=${migrationVolume},dst=/migration,readonly`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target`,
      config.appImage,
      '/opt/aiws/backup_archive.py',
      'extract',
      '/migration/source.tar.gz',
      '/target'
    ]);
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--mount',
      `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target,readonly`,
      '--mount',
      `type=volume,src=${migrationVolume},dst=/migration`,
      config.appImage,
      '/app/docker/release_volume.mjs',
      'clone-verify-v20',
      '/source',
      '/target',
      '/migration/clone.manifest.json',
      archiveSha256,
      config.sourceVolume,
      config.targetVolume
    ]);
    return { migration_volume: migrationVolume, archive_sha256: archiveSha256 };
  } catch (error) {
    error.migrationVolume = migrationVolume;
    throw error;
  }
}

function migrateAndBuildContext(config) {
  const script = [
    "const stateApi=await import('/app/apps/api/src/state.mjs')",
    'await stateApi.ensureRuntime()',
    'let state=await stateApi.readState()',
    "if(state.schema_version!==20)throw Object.assign(new Error('schema_not_20'),{code:'schema_not_20'})",
    "const owner=state.users.find((item)=>item.id===state.instance_owner_user_id)||state.users.find((item)=>item.role==='owner')",
    "if(!owner)throw Object.assign(new Error('instance_owner_missing'),{code:'instance_owner_missing'})",
    "const context=await import('/app/apps/api/src/context-service.mjs')",
    "const req={headers:{'x-aiws-user-id':owner.id},auth:{scopes:['context:admin']}}",
    'const rebuild=await context.rebuildContext({req})',
    'const status=await context.contextStatus({req})',
    "if(status.jobs.pending||status.jobs.running||status.jobs.failed)throw Object.assign(new Error('projection_jobs_incomplete'),{code:'projection_jobs_incomplete'})",
    "if(status.coverage?.warnings?.length)throw Object.assign(new Error('projection_coverage_warning'),{code:'projection_coverage_warning'})",
    "if(status.index?.state!=='ready')throw Object.assign(new Error('context_index_not_ready'),{code:'context_index_not_ready'})",
    'process.stdout.write(JSON.stringify({schema_version:state.schema_version,state_migration:stateApi.lastStateMigration(),rebuild,status}))'
  ].join(';');
  const output = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--env',
      'NODE_ENV=production',
      '--env',
      'AIWS_HOME=/var/lib/aiws',
      '--env',
      'AIWS_CONTAINERIZED=1',
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/var/lib/aiws`,
      config.appImage,
      '--input-type=module',
      '-e',
      script
    ],
    { capture: true }
  );
  try {
    const result = JSON.parse(output);
    if (
      result.schema_version !== V20_SCHEMA ||
      result.status?.schema_version !== V20_SCHEMA ||
      result.status?.protocol_version !== 'aiws.system-context.v1' ||
      result.status?.index?.state !== 'ready'
    )
      throw new Error();
    return result;
  } catch {
    throw upgradeError('v20_migration_projection_invalid');
  }
}

function acceptMigratedTarget(config, context) {
  const output = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--mount',
      `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target`,
      '--mount',
      `type=volume,src=${context.migration_volume},dst=/migration,readonly`,
      config.appImage,
      '/app/docker/release_volume.mjs',
      'accept-v20',
      '/target',
      '/source',
      '/migration/clone.manifest.json',
      context.archive_sha256,
      context.migration_volume,
      config.sourceVolume,
      config.targetVolume
    ],
    { capture: true }
  );
  return parseJson(output, 'v20_acceptance_output_invalid');
}

function checkAcceptedTarget(config, { deferProjection = false } = {}) {
  const output = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target,readonly`,
      config.appImage,
      '/app/docker/release_volume.mjs',
      'check-v20',
      '/target',
      config.targetVolume,
      ...(deferProjection ? ['defer-projection'] : [])
    ],
    { capture: true }
  );
  return parseJson(output, 'v20_acceptance_check_invalid');
}

async function waitForHealth(config, expectedImage = config.appImage) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const id = compose(config, ['ps', '-q', 'app'], { capture: true, allowFailure: true }).trim();
      if (id) {
        const detail = inspectContainer(id);
        if (detail.image !== expectedImage)
          throw upgradeError('v20_app_image_mismatch', { expected: expectedImage, actual: detail.image });
        if (detail.project !== config.projectName)
          throw upgradeError('v20_compose_project_mismatch', { expected: config.projectName, actual: detail.project });
        assertVolumeMount(id, config.targetVolume);
        const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
            signal: AbortSignal.timeout(5000)
          }),
          health = await response.json();
        last = health;
        if (
          response.ok &&
          health.status === 'ok' &&
          health.version === V20_VERSION &&
          health.schema_version === V20_SCHEMA &&
          health.api?.healthy === true &&
          health.db?.healthy === true
        )
          return { ...health, container_id: id, compose_project: detail.project, data_volume: config.targetVolume };
      }
    } catch (error) {
      if (error.code?.startsWith('v20_')) throw error;
      last = { error: error.message };
    }
    await sleep(2000);
  }
  throw upgradeError('v20_health_check_failed', { last });
}

function stopProjectApps(project) {
  const ids = docker(
      [
        'ps',
        '-q',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.service=app'
      ],
      { capture: true, allowFailure: true }
    )
      .split(/\r?\n/)
      .filter(Boolean),
    stopped = [];
  for (const id of ids) {
    const detail = inspectContainer(id);
    docker(['stop', '--timeout', '30', id]);
    stopped.push(detail);
  }
  return stopped;
}

function restartContainers(containers) {
  const restored = [];
  for (const item of containers || []) {
    if (run('docker', ['container', 'inspect', item.id], { capture: true, allowFailure: true }).status !== 0) continue;
    if (run('docker', ['start', item.id], { capture: true, allowFailure: true }).status !== 0) continue;
    restored.push(item.id);
  }
  return restored;
}

function preserveRollbackImage(containers) {
  const container = containers?.[0];
  if (!container?.image_id) return null;
  const tag = `aiws-app:v20-rollback-${Date.now()}-${process.pid}`.toLowerCase();
  const tagged = run('docker', ['image', 'tag', container.image_id, tag], { capture: true, allowFailure: true });
  if (tagged.status !== 0) docker(['container', 'commit', container.id, tag]);
  return tag;
}

function removeRollbackImage(tag) {
  if (tag) docker(['image', 'rm', tag], { allowFailure: true });
}

async function restorePreviousV20(config, context) {
  const restarted = restartContainers(context.stopped_v20_containers);
  if (restarted.length) {
    const health = await rollbackHealth(config, context.stopped_v20_containers[0]?.image || config.appImage),
      restored = v20RollbackAccepted(restarted, health);
    if (!restored) compose(config, ['down', '--remove-orphans'], { allowFailure: true });
    return {
      restored,
      mode: 'container_restart',
      container_ids: restarted,
      health
    };
  }
  if (!context.rollback_image) return { restored: false, mode: 'unavailable', container_ids: [] };
  compose(config, ['up', '-d', '--remove-orphans'], { appImage: context.rollback_image });
  const containerId = compose(config, ['ps', '-q', 'app'], {
      capture: true,
      appImage: context.rollback_image
    }).trim(),
    containerIds = containerId ? [containerId] : [],
    health = await rollbackHealth(config, context.rollback_image),
    restored = v20RollbackAccepted(containerIds, health);
  if (!restored)
    compose(config, ['down', '--remove-orphans'], { allowFailure: true, appImage: context.rollback_image });
  return {
    restored,
    mode: 'rollback_image',
    container_ids: containerIds,
    health
  };
}

export function v20RollbackAccepted(containerIds, health) {
  return Boolean(
    containerIds?.length &&
    health?.status === 'ok' &&
    health.version === V20_VERSION &&
    health.schema_version === V20_SCHEMA
  );
}

async function rollbackHealth(config, expectedImage) {
  try {
    return await waitForHealth(config, expectedImage);
  } catch (error) {
    return { error_code: error.code || 'v20_rollback_health_failed', error: String(error.message || error) };
  }
}

async function waitForPortDisposition(config) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await portListening(config.port))) return;
    const formal = docker(
      [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${config.projectName}`,
        '--filter',
        'label=com.docker.compose.service=app'
      ],
      { capture: true, allowFailure: true }
    );
    if (formal) return;
    await sleep(200);
  }
  throw upgradeError(`port_${config.port}_in_use`);
}

function createTargetVolume(volume) {
  if (volumeExists(volume)) {
    if (!volumeEmpty(volume, V20_APP_IMAGE)) throw upgradeError('v20_target_volume_not_empty');
    return;
  }
  docker([
    'volume',
    'create',
    '--label',
    'aiws.owner=aiws-v20',
    '--label',
    'aiws.role=production-data',
    '--label',
    'aiws.schema=20',
    volume
  ]);
}

function volumeExists(volume) {
  return run('docker', ['volume', 'inspect', volume], { capture: true, allowFailure: true }).status === 0;
}

function volumeEmpty(volume, appImage) {
  const result = run(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '--mount',
      `type=volume,src=${volume},dst=/data,readonly`,
      appImage,
      '-c',
      'test -z "$(ls -A /data)"'
    ],
    { capture: true, allowFailure: true }
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw upgradeError('v20_volume_empty_check_failed', { volume });
}

function assertVolumeMount(containerId, volume) {
  const mounts = JSON.parse(
    docker(['inspect', '--format', '{{json .Mounts}}', containerId], { capture: true }) || '[]'
  );
  if (!mounts.some((item) => item.Type === 'volume' && item.Name === volume && item.Destination === '/var/lib/aiws'))
    throw upgradeError('v20_data_volume_mount_invalid');
}

function inspectContainer(id) {
  const value = JSON.parse(docker(['inspect', '--format', '{{json .}}', id], { capture: true }));
  return {
    id: value.Id,
    name: String(value.Name || '').replace(/^\//, ''),
    image: value.Config?.Image || null,
    image_id: value.Image || null,
    project: value.Config?.Labels?.['com.docker.compose.project'] || null,
    status: value.State?.Status || null
  };
}

function compose(config, args, options = {}) {
  const { appImage = config.appImage, ...runOptions } = options;
  return docker(
    [
      'compose',
      '-f',
      config.composeFile,
      ...(config.override ? ['-f', config.override] : []),
      '-p',
      config.projectName,
      ...args
    ],
    { ...runOptions, env: composeEnvironment(config, { appImage }) }
  );
}

function composeEnvironment(config, { appImage = config.appImage } = {}) {
  return {
    ...process.env,
    AIWS_DOCKER_DATA_VOLUME: config.targetVolume,
    AIWS_DOCKER_INSTANCE: config.projectName,
    AIWS_APP_IMAGE: appImage,
    AIWS_RUNNER_IMAGE: config.runnerImage,
    AIWS_PORT: String(config.port)
  };
}

function docker(args, options = {}) {
  const result = run('docker', args, options);
  return options.capture ? result.stdout.trim() : '';
}

function run(command, args, { capture = false, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    env,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw upgradeError('v20_command_failed', {
      command,
      args,
      status: result.status,
      stderr: String(result.stderr || '').slice(-4000)
    });
  return { ...result, stdout: String(result.stdout || '') };
}

function upgradeConfig(options) {
  const composeFile = path.resolve(options.composeFile || path.join(ROOT, 'compose.yml')),
    override = options.override ? path.resolve(options.override) : null;
  if (!fs.existsSync(composeFile)) throw upgradeError('v20_compose_file_missing');
  if (override && !fs.existsSync(override)) throw upgradeError('v20_compose_override_missing');
  return {
    composeFile,
    override,
    sourceVolume: options.sourceVolume || V20_SOURCE_VOLUME,
    targetVolume: options.targetVolume || V20_TARGET_VOLUME,
    projectName: options.projectName || V20_PROJECT,
    appImage: options.appImage || process.env.AIWS_APP_IMAGE || V20_APP_IMAGE,
    runnerImage: options.runnerImage || process.env.AIWS_RUNNER_IMAGE || V20_RUNNER_IMAGE,
    rollbackImage: options.rollbackImage || process.env.AIWS_ROLLBACK_IMAGE || null,
    port: Number(options.port || process.env.AIWS_PORT || 4317),
    waitMs: Math.max(0, Number(options.waitMs ?? 300_000)),
    pollMs: Math.max(250, Number(options.pollMs || 2000))
  };
}

function assertFormalConfig(config) {
  const expected = {
    sourceVolume: V20_SOURCE_VOLUME,
    targetVolume: V20_TARGET_VOLUME,
    projectName: V20_PROJECT,
    appImage: V20_APP_IMAGE,
    runnerImage: V20_RUNNER_IMAGE,
    port: 4317
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => config[key] !== value)
    .map(([key]) => key);
  if (mismatches.length) throw upgradeError('v20_formal_resources_required', { mismatches, expected });
}

function assertRollbackImage(image) {
  if (!image) return;
  if (!/^aiws-app:v20-rollback-[a-z0-9._-]+$/i.test(image)) throw upgradeError('v20_rollback_image_invalid', { image });
  if (run('docker', ['image', 'inspect', image], { capture: true, allowFailure: true }).status !== 0)
    throw upgradeError('v20_rollback_image_missing', { image });
}

async function writeTranscript(value) {
  const directory = path.join(ROOT, '.ai-workspace', 'release');
  await fsp.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'v20-cutover-latest.json'),
    temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, target);
}

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    throw upgradeError(code);
  }
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upgradeError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

export function runV20UpgradeCli(argv) {
  const options = {},
    fields = {
      '--compose-file': 'composeFile',
      '--override': 'override',
      '--source-volume': 'sourceVolume',
      '--target-volume': 'targetVolume',
      '--project-name': 'projectName',
      '--app-image': 'appImage',
      '--runner-image': 'runnerImage',
      '--rollback-image': 'rollbackImage',
      '--port': 'port',
      '--wait-ms': 'waitMs',
      '--poll-ms': 'pollMs'
    };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index],
      field = fields[flag],
      value = argv[index + 1];
    if (!field || value == null) throw upgradeError('v20_cli_argument_invalid', { flag });
    options[field] = value;
    index += 1;
  }
  return runV20Upgrade(options);
}
