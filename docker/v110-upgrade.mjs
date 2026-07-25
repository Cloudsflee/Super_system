#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const V110_VERSION = '1.10.0';
export const V110_SCHEMA = 19;
export const V110_VOLUME = 'aiws-data-v19';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE_TASK = new Set(['pending', 'ready', 'queued', 'running', 'verifying', 'awaiting_human']);

export function inspectExecutionActivity(state = {}) {
  const activeWorkflowIds = new Set(
    (state.workflow_executions || [])
      .filter((item) => ['running', 'paused'].includes(item.status))
      .map((item) => item.id)
  );
  const records = [
    ...(state.node_runs || [])
      .filter((item) => ['queued', 'running', 'verifying'].includes(item.status))
      .map((item) => ({ type: 'node_run', id: item.id, status: item.status })),
    ...(state.deliveries || [])
      .filter((item) => ['queued', 'running', 'verifying'].includes(item.status))
      .map((item) => ({ type: 'delivery', id: item.id, status: item.status })),
    ...(state.workflow_executions || [])
      .filter((item) => activeWorkflowIds.has(item.id))
      .map((item) => ({ type: 'workflow_execution', id: item.id, status: item.status })),
    ...(state.task_executions || [])
      .filter((item) => activeWorkflowIds.has(item.workflow_execution_id) && ACTIVE_TASK.has(item.status))
      .map((item) => ({ type: 'task_execution', id: item.id, status: item.status }))
  ];
  return { active: records.length > 0, records };
}

export function executionActivityProbeScript(statePath = '/volume/data/state.json') {
  const activeTaskStatuses = JSON.stringify([...ACTIVE_TASK]);
  return `const fs=require('node:fs');const p=${JSON.stringify(statePath)};const ACTIVE_TASK=new Set(${activeTaskStatuses});const inspectExecutionActivity=${inspectExecutionActivity.toString()};const state=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};process.stdout.write(JSON.stringify(inspectExecutionActivity(state)));`;
}

export function assertOnlyAppReplaced({ beforeRunning = [], afterRunning = [], oldAppId = null, newAppId = null }) {
  if (!newAppId || (oldAppId && sameContainerId(newAppId, oldAppId)))
    throw upgradeError('v110_app_container_not_replaced');
  const expected = beforeRunning.filter((id) => !sameContainerId(id, oldAppId));
  const actual = afterRunning.filter((id) => !sameContainerId(id, newAppId));
  const missing = expected.filter((id) => !actual.some((candidate) => sameContainerId(id, candidate)));
  if (missing.length) throw upgradeError('v110_unrelated_container_changed', { container_ids: missing });
  return true;
}

function sameContainerId(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export async function runV110Upgrade(options = {}) {
  const config = upgradeConfig(options),
    context = {
      version: V110_VERSION,
      schema: V110_SCHEMA,
      volume: config.volume,
      port: config.port,
      started_at: new Date().toISOString(),
      status: 'preparing',
      backup_path: null
    };
  if (config.port !== 4317) throw upgradeError('v110_formal_port_required', { port: config.port });
  await writeTranscript(context);
  const volumeExisted = volumeExists(config.volume);
  if (!volumeExisted) createVolume(config.volume);
  const beforeRunning = runningContainerIds(),
    oldAppId = composeOutput(config, ['ps', '-q', 'app']);
  context.previous_container_id = oldAppId || null;
  context.previous_image = oldAppId ? inspectValue(oldAppId, '{{.Config.Image}}') : null;
  if (oldAppId) assertFormalAppContainer(oldAppId, config.port);
  try {
    if (volumeExisted) context.activity = await waitForQuiescence(config);
    if (oldAppId) compose(config, ['stop', '--timeout', '30', 'app']);
    if (volumeExisted) context.backup_path = await backupVolume(config);
    context.status = 'migrating';
    await writeTranscript(context);
    context.migration = migrateAndValidate(config);
    context.status = 'replacing_app';
    await writeTranscript(context);
    compose(config, ['up', '-d', '--no-deps', '--force-recreate', 'app']);
    const health = await waitForHealth(config),
      newAppId = composeOutput(config, ['ps', '-q', 'app']);
    assertFormalAppContainer(newAppId, config.port);
    assertVolumeMount(newAppId, config.volume);
    assertOnlyAppReplaced({ beforeRunning, afterRunning: runningContainerIds(), oldAppId, newAppId });
    Object.assign(context, {
      status: 'accepted',
      container_id: newAppId,
      health,
      completed_at: new Date().toISOString()
    });
    await writeTranscript(context);
    process.stdout.write(`AIWS V1.10 accepted at http://127.0.0.1:${config.port}\n`);
    return context;
  } catch (error) {
    compose(config, ['stop', '--timeout', '10', 'app'], { allowFailure: true });
    Object.assign(context, {
      status: 'failed_backup_preserved',
      failure: { code: error.code || 'v110_upgrade_failed', message: String(error.message || error) },
      failed_at: new Date().toISOString()
    });
    await writeTranscript(context);
    throw error;
  }
}

async function waitForQuiescence(config) {
  const deadline = Date.now() + config.waitMs;
  while (true) {
    const activity = readVolumeExecutionActivity(config);
    if (!activity.active) return { waited_until: new Date().toISOString(), records: [] };
    if (Date.now() >= deadline) throw upgradeError('v110_active_executions_timeout', { records: activity.records });
    await sleep(config.pollMs);
  }
}

function readVolumeExecutionActivity(config) {
  const script = executionActivityProbeScript();
  const output = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--mount',
      `type=volume,src=${config.volume},dst=/volume,readonly`,
      config.appImage,
      '-e',
      script
    ],
    { capture: true }
  );
  try {
    const activity = JSON.parse(output || 'null');
    if (typeof activity?.active !== 'boolean' || !Array.isArray(activity.records)) throw new Error('invalid_activity');
    return activity;
  } catch {
    throw upgradeError('v110_volume_state_invalid');
  }
}

async function backupVolume(config) {
  await fsp.mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'),
    name = `${config.volume}-pre-v110-${stamp}.tar.gz`,
    temporary = `.${name}.tmp`;
  docker([
    'run',
    '--rm',
    '--entrypoint',
    'python3',
    '--mount',
    `type=volume,src=${config.volume},dst=/data,readonly`,
    '--mount',
    `type=bind,src=${config.backupDir},dst=/backup`,
    config.appImage,
    '/opt/aiws/backup_archive.py',
    'create',
    '/data',
    `/backup/${temporary}`
  ]);
  docker([
    'run',
    '--rm',
    '--entrypoint',
    'python3',
    '--mount',
    `type=bind,src=${config.backupDir},dst=/backup,readonly`,
    config.appImage,
    '/opt/aiws/backup_archive.py',
    'validate',
    `/backup/${temporary}`
  ]);
  await fsp.rename(path.join(config.backupDir, temporary), path.join(config.backupDir, name));
  return path.join(config.backupDir, name);
}

function migrateAndValidate(config) {
  const script =
    "const s=await import('/app/apps/api/src/state.mjs');await s.ensureRuntime();const v=await s.readState();if(v.schema_version!==19)throw new Error('schema_not_19');process.stdout.write(JSON.stringify({schema_version:v.schema_version,state_migration:s.lastStateMigration()}))";
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
      '--mount',
      `type=volume,src=${config.volume},dst=/var/lib/aiws`,
      config.appImage,
      '--input-type=module',
      '-e',
      script
    ],
    { capture: true }
  );
  try {
    const value = JSON.parse(output);
    if (value.schema_version !== V110_SCHEMA) throw new Error();
    return value;
  } catch {
    throw upgradeError('v110_schema_migration_invalid');
  }
}

async function waitForHealth(config) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/api/health`),
        value = await response.json();
      last = value;
      if (
        response.ok &&
        value.status === 'ok' &&
        value.version === V110_VERSION &&
        value.schema_version === V110_SCHEMA &&
        value.api?.healthy === true &&
        value.db?.healthy === true
      )
        return value;
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(2_000);
  }
  throw upgradeError('v110_health_check_failed', { last });
}

function assertFormalAppContainer(containerId, port) {
  if (!containerId) throw upgradeError('v110_app_container_missing');
  const service = inspectValue(containerId, '{{ index .Config.Labels "com.docker.compose.service" }}');
  if (service !== 'app') throw upgradeError('v110_container_service_invalid', { service });
  const ports = JSON.parse(inspectValue(containerId, '{{json .NetworkSettings.Ports}}') || '{}');
  if (
    !Object.values(ports)
      .flatMap((item) => item || [])
      .some((item) => Number(item.HostPort) === Number(port) && ['127.0.0.1', '0.0.0.0', '::'].includes(item.HostIp))
  )
    throw upgradeError('v110_container_port_invalid');
}
function assertVolumeMount(containerId, volume) {
  const mounts = JSON.parse(inspectValue(containerId, '{{json .Mounts}}') || '[]');
  if (!mounts.some((item) => item.Type === 'volume' && item.Name === volume && item.Destination === '/var/lib/aiws'))
    throw upgradeError('v110_data_volume_mount_invalid');
}
function inspectValue(id, format) {
  return docker(['inspect', '--format', format, id], { capture: true });
}
function runningContainerIds() {
  const output = docker(['ps', '--no-trunc', '-q'], { capture: true });
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}
function volumeExists(volume) {
  return run('docker', ['volume', 'inspect', volume], { allowFailure: true }).status === 0;
}
function createVolume(volume) {
  docker([
    'volume',
    'create',
    '--label',
    'aiws.owner=aiws-v110',
    '--label',
    'aiws.role=production-data',
    '--label',
    'aiws.schema=19',
    volume
  ]);
}
function compose(config, args, options = {}) {
  return run('docker', composeArgs(config, args), { ...options, env: composeEnvironment(config) }).stdout;
}
function composeOutput(config, args) {
  return compose(config, args, { capture: true }).trim();
}
function composeArgs(config, args) {
  return ['compose', '-f', config.composeFile, ...(config.override ? ['-f', config.override] : []), ...args];
}
function composeEnvironment(config) {
  return {
    ...process.env,
    AIWS_DOCKER_DATA_VOLUME: config.volume,
    AIWS_APP_IMAGE: config.appImage,
    AIWS_RUNNER_IMAGE: config.runnerImage,
    AIWS_PORT: String(config.port)
  };
}
function docker(args, options = {}) {
  return run('docker', args, options).stdout.trim();
}
function run(command, args, { capture = false, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw upgradeError('v110_command_failed', {
      command,
      args,
      status: result.status,
      stderr: String(result.stderr || '').slice(-4000)
    });
  return { ...result, stdout: String(result.stdout || '') };
}
function upgradeConfig(options) {
  return {
    composeFile: path.resolve(options.composeFile || path.join(ROOT, 'compose.yml')),
    override: options.override ? path.resolve(options.override) : null,
    volume: options.volume || V110_VOLUME,
    appImage: options.appImage || process.env.AIWS_APP_IMAGE || `aiws-app:${V110_VERSION}`,
    runnerImage:
      options.runnerImage || process.env.AIWS_RUNNER_IMAGE || `aiws-codex-runner:${V110_VERSION}-codex-0.144.0`,
    port: Number(options.port || process.env.AIWS_PORT || 4317),
    waitMs: Math.max(0, Number(options.waitMs ?? 300_000)),
    pollMs: Math.max(250, Number(options.pollMs || 2_000)),
    backupDir: path.resolve(options.backupDir || path.join(ROOT, '.ai-workspace', 'backups'))
  };
}
async function writeTranscript(value) {
  const directory = path.join(ROOT, '.ai-workspace', 'release');
  await fsp.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'v110-cutover-latest.json'),
    temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, target);
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

export async function runV110UpgradeCli(argv) {
  const options = {},
    fields = {
      '--compose-file': 'composeFile',
      '--override': 'override',
      '--volume': 'volume',
      '--app-image': 'appImage',
      '--runner-image': 'runnerImage',
      '--port': 'port',
      '--wait-ms': 'waitMs',
      '--backup-dir': 'backupDir'
    };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index],
      value = argv[index + 1],
      field = fields[flag];
    if (!field || value == null) throw upgradeError('v110_cli_argument_invalid', { flag });
    options[field] = value;
    index += 1;
  }
  return runV110Upgrade(options);
}
