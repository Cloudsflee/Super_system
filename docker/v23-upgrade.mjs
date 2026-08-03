#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForV23PortDisposition, waitForV23Readiness } from './v23-readiness.mjs';

export const V23_VERSION = '2.3.0';
export const V23_SCHEMA = 23;
export const V23_PROJECT = 'aiws-v23';
export const V22_PROJECT = 'aiws-v22';
export const V23_SOURCE_VOLUME = 'aiws-data-v22';
export const V23_TARGET_VOLUME = 'aiws-data-v23';
export const V23_APP_IMAGE = 'aiws-app:2.3.0';
export const V23_RUNNER_IMAGE = 'aiws-codex-runner:2.3.0-codex-0.144.0';
export const V23_READY_WAIT_MS = 600_000;
export const V23_READY_REQUEST_TIMEOUT_MS = 10_000;
export const V23_READY_POLL_MS = 2000;
const V23_TARGET_VOLUME_LABELS = Object.freeze({
  'aiws.owner': 'aiws-v23',
  'aiws.role': 'production-data',
  'aiws.schema': '23'
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024,
  TRANSCRIPT_PATH = path.join(ROOT, '.ai-workspace', 'release', 'v23-cutover-latest.json'),
  V23_NODE_OPTIONS = '--max-old-space-size=4096';

export async function runV23Upgrade(options = {}) {
  const config = upgradeConfig(options);
  assertFormalConfig(config);
  assertRollbackImage(config.rollbackImage);
  const sourceExists = volumeExists(config.sourceVolume),
    targetExists = volumeExists(config.targetVolume),
    sourceEmpty = !sourceExists || volumeEmpty(config.sourceVolume, config.appImage),
    targetEmpty = !targetExists || volumeEmpty(config.targetVolume, config.appImage),
    decision = targetDisposition(config, { sourceExists, sourceEmpty, targetExists, targetEmpty }),
    { disposition } = decision;
  if (disposition === 'unavailable')
    throw upgradeError('v23_schema22_source_required', {
      source_volume: config.sourceVolume,
      source_exists: sourceExists,
      source_empty: sourceEmpty,
      target_volume: config.targetVolume,
      target_exists: targetExists,
      target_empty: targetEmpty
    });

  const context = {
    version: V23_VERSION,
    schema: V23_SCHEMA,
    project: config.projectName,
    port: config.port,
    source_volume: config.sourceVolume,
    target_volume: config.targetVolume,
    disposition,
    source_mount_mode: 'readonly',
    source_preserved: true,
    rollback_image: config.rollbackImage,
    migration_volume: null,
    archive_sha256: null,
    recovery: decision.recovery || null,
    stopped_v22_containers: [],
    stopped_v23_containers: [],
    started_at: new Date().toISOString(),
    status: 'preparing'
  };
  await writeTranscript(context);

  try {
    if (disposition === 'reuse') {
      context.acceptance = decision.acceptance;
      context.activity = await waitForQuiescence(config, config.targetVolume, 23);
      context.stopped_v23_containers = stopProjectApps(V23_PROJECT);
    } else context.activity = await waitForQuiescence(config, config.sourceVolume, 22);
    context.stopped_v22_containers = stopProjectApps(V22_PROJECT);
    await waitForV23PortDisposition(config, { sleep, upgradeError });

    if (disposition === 'clone' || disposition === 'reclone') {
      if (disposition === 'reclone') {
        context.status = 'resetting_incomplete_target';
        await writeTranscript(context);
        resetIncompleteTarget(config, decision.recovery);
      }
      Object.assign(context, initializeFromV22(config), { status: 'migrating' });
      await writeTranscript(context);
      context.migration = migrateAndBuildContext(config);
      context.acceptance = acceptMigratedTarget(config, context);
    } else {
      context.status = 'validating_reused_v23';
      await writeTranscript(context);
      context.acceptance = checkAcceptedTarget(config);
    }

    context.status = 'starting_v23';
    await writeTranscript(context);
    compose(config, ['up', '-d', '--remove-orphans']);
    context.readiness = await waitForV23Readiness(config, {
      compose,
      inspectContainer,
      assertVolumeMount,
      isUpgradeError: isV23UpgradeError,
      upgradeError,
      sleep,
      readyWaitMs: V23_READY_WAIT_MS,
      requestTimeoutMs: V23_READY_REQUEST_TIMEOUT_MS,
      pollMs: V23_READY_POLL_MS,
      version: V23_VERSION,
      schema: V23_SCHEMA
    });
    context.acceptance = checkAcceptedTarget(config);
    removeStoppedContainers(context.stopped_v22_containers);
    Object.assign(context, {
      status: 'accepted',
      source_preserved: true,
      completed_at: new Date().toISOString()
    });
    await writeTranscript(context);
    process.stdout.write(`AIWS V2.3 accepted at http://127.0.0.1:${config.port}; ${config.sourceVolume} retained.\n`);
    return context;
  } catch (error) {
    let restoredV23 = restartContainers(context.stopped_v23_containers);
    if (!restoredV23.length) {
      compose(config, ['down', '--remove-orphans'], { allowFailure: true });
      restoredV23 = restartContainers(context.stopped_v23_containers);
    }
    const restoredV22 = restoredV23.length ? [] : restartContainers(context.stopped_v22_containers);
    Object.assign(context, {
      status: restoredV23.length
        ? 'failed_previous_v23_restored'
        : restoredV22.length
          ? 'failed_v23_stopped_v22_restored'
          : 'failed_source_preserved',
      source_preserved: true,
      restored_v23_containers: restoredV23,
      restored_v22_containers: restoredV22,
      failure: { code: error.code || 'v23_upgrade_failed', message: String(error.message || error) },
      failed_at: new Date().toISOString()
    });
    await writeTranscript(context);
    throw error;
  }
}

async function waitForQuiescence(config, volume, schema) {
  const deadline = Date.now() + config.waitMs;
  while (true) {
    const args = [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--env',
      'NODE_ENV=production',
      '--env',
      'AIWS_HOME=/volume',
      '--env',
      `NODE_OPTIONS=${V23_NODE_OPTIONS}`,
      '--mount',
      `type=volume,src=${volume},dst=/volume${schema === 22 ? ',readonly' : ''}`,
      config.appImage
    ];
    if (schema === 22) args.push('-e', v23AsyncEvalScript(v22SqliteActivityProbeScript()));
    else args.push('-e', v23AsyncEvalScript(sqliteActivityProbeScript()));
    const output = docker(args, { capture: true });
    let activity;
    try {
      activity = JSON.parse(output);
      if (typeof activity?.active !== 'boolean' || !Array.isArray(activity.records)) throw new Error();
    } catch {
      throw upgradeError(schema === 22 ? 'v23_source_state_invalid' : 'v23_target_state_invalid');
    }
    if (!activity.active) return { records: [], checked_at: new Date().toISOString() };
    if (Date.now() >= deadline) throw upgradeError('v23_active_executions_timeout', { records: activity.records });
    await sleep(config.pollMs);
  }
}

function sqliteActivityProbeScript() {
  return [
    "const api=await import('/app/apps/api/src/state.mjs')",
    'await api.ensureRuntime()',
    'const state=await api.readStateSnapshot()',
    "const activeTask=new Set(['queued','running','verifying','awaiting_human'])",
    "const activeRun=new Set(['queued','running','verifying'])",
    "const activeDelivery=new Set(['queued','running','awaiting_confirmation'])",
    "const activeReview=new Set(['queued','preparing','checking','reviewing','awaiting_human'])",
    'const records=[]',
    "for(const item of state.workflow_executions||[])if(['queued','running','verifying','awaiting_human'].includes(item.status))records.push({collection:'workflow_executions',id:item.id,status:item.status})",
    "for(const item of state.task_executions||[])if(activeTask.has(item.status))records.push({collection:'task_executions',id:item.id,status:item.status})",
    "for(const item of state.node_runs||[])if(activeRun.has(item.status))records.push({collection:'node_runs',id:item.id,status:item.status})",
    "for(const item of state.deliveries||[])if(activeDelivery.has(item.status))records.push({collection:'deliveries',id:item.id,status:item.status})",
    "for(const item of state.quality_review_runs||[])if(activeReview.has(item.status))records.push({collection:'quality_review_runs',id:item.id,status:item.status})",
    'await api.checkpointAndCloseState()',
    'process.stdout.write(JSON.stringify({active:records.length>0,records}))'
  ].join(';');
}

function v22SqliteActivityProbeScript() {
  return [
    "const {readLegacySqliteState}=await import('/app/apps/api/src/state-runtime-v23.mjs')",
    "const state=readLegacySqliteState('/volume/data/state-v22.sqlite')",
    "const activeTask=new Set(['queued','running','verifying','awaiting_human'])",
    "const activeRun=new Set(['queued','running','verifying'])",
    "const activeDelivery=new Set(['queued','running','awaiting_confirmation'])",
    "const activeReview=new Set(['queued','preparing','checking','reviewing','awaiting_human'])",
    'const records=[]',
    "for(const item of state.workflow_executions||[])if(['queued','running','verifying','awaiting_human'].includes(item.status))records.push({collection:'workflow_executions',id:item.id,status:item.status})",
    "for(const item of state.task_executions||[])if(activeTask.has(item.status))records.push({collection:'task_executions',id:item.id,status:item.status})",
    "for(const item of state.node_runs||[])if(activeRun.has(item.status))records.push({collection:'node_runs',id:item.id,status:item.status})",
    "for(const item of state.deliveries||[])if(activeDelivery.has(item.status))records.push({collection:'deliveries',id:item.id,status:item.status})",
    "for(const item of state.quality_review_runs||[])if(activeReview.has(item.status))records.push({collection:'quality_review_runs',id:item.id,status:item.status})",
    'process.stdout.write(JSON.stringify({active:records.length>0,records}))'
  ].join(';');
}

function initializeFromV22(config) {
  createTargetVolume(config.targetVolume);
  const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 17),
    migrationVolume = `aiws-v23-migration-${stamp}-${process.pid}`.toLowerCase();
  docker([
    'volume',
    'create',
    '--label',
    'aiws.owner=aiws-v23-release',
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
      '--env',
      `NODE_OPTIONS=${V23_NODE_OPTIONS}`,
      '--mount',
      `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target,readonly`,
      '--mount',
      `type=volume,src=${migrationVolume},dst=/migration`,
      config.appImage,
      '/app/docker/release_volume.mjs',
      'clone-verify-v23',
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
    'let state=await stateApi.readStateSnapshot()',
    "if(state.schema_version!==23)throw Object.assign(new Error('schema_not_23'),{code:'schema_not_23'})",
    "const owner=state.users.find((item)=>item.id===state.instance_owner_user_id)||state.users.find((item)=>item.role==='owner')",
    "if(!owner)throw Object.assign(new Error('instance_owner_missing'),{code:'instance_owner_missing'})",
    "const context=await import('/app/apps/api/src/context-service.mjs')",
    "const req={headers:{'x-aiws-user-id':owner.id},auth:{scopes:['context:admin']}}",
    'const rebuild=await context.rebuildContext({req})',
    'const status=await context.contextStatus({req})',
    "if(status.jobs.pending||status.jobs.running||status.jobs.failed)throw Object.assign(new Error('projection_jobs_incomplete'),{code:'projection_jobs_incomplete'})",
    "if(status.index?.state!=='ready')throw Object.assign(new Error('context_index_not_ready'),{code:'context_index_not_ready'})",
    'const persistence=await stateApi.statePersistenceStatus()',
    'await stateApi.checkpointAndCloseState()',
    'process.stdout.write(JSON.stringify({schema_version:state.schema_version,state_migration:stateApi.lastStateMigration(),rebuild,status,persistence}))'
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
      '--env',
      `NODE_OPTIONS=${V23_NODE_OPTIONS}`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/var/lib/aiws`,
      config.appImage,
      '-e',
      v23AsyncEvalScript(script)
    ],
    { capture: true }
  );
  const result = parseJson(output, 'v23_migration_projection_output_invalid');
  if (
    result.schema_version !== V23_SCHEMA ||
    result.status?.schema_version !== V23_SCHEMA ||
    result.status?.protocol_version !== 'aiws.system-context.v1' ||
    result.status?.index?.state !== 'ready' ||
    result.persistence?.healthy !== true ||
    result.persistence?.writable !== true
  )
    throw upgradeError('v23_migration_projection_invalid');
  return result;
}

function acceptMigratedTarget(config, context) {
  const output = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--env',
      `NODE_OPTIONS=${V23_NODE_OPTIONS}`,
      '--mount',
      `type=volume,src=${config.sourceVolume},dst=/source,readonly`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target`,
      '--mount',
      `type=volume,src=${context.migration_volume},dst=/migration,readonly`,
      config.appImage,
      '/app/docker/release_volume.mjs',
      'accept-v23',
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
  return parseJson(output, 'v23_acceptance_output_invalid');
}

function checkAcceptedTarget(config) {
  const output = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--env',
      `NODE_OPTIONS=${V23_NODE_OPTIONS}`,
      '--mount',
      `type=volume,src=${config.targetVolume},dst=/target`,
      config.appImage,
      '/app/docker/release_volume.mjs',
      'check-v23',
      '/target',
      config.targetVolume
    ],
    { capture: true }
  );
  return parseJson(output, 'v23_acceptance_check_invalid');
}

export function isV23UpgradeError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('v23_');
}

export function v23RollbackAccepted(containerIds, health) {
  return Boolean(
    containerIds?.length && health?.status === 'ok' && health.version === '2.2.0' && health.schema_version === 22
  );
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

function removeStoppedContainers(containers) {
  for (const item of containers || []) docker(['container', 'rm', item.id], { allowFailure: true });
}

function createTargetVolume(volume) {
  if (volumeExists(volume)) {
    if (!volumeEmpty(volume, V23_APP_IMAGE)) throw upgradeError('v23_target_volume_not_empty');
    assertTargetVolumeLabels(volume, 'v23_target_volume_unattributed');
    return;
  }
  docker([
    'volume',
    'create',
    '--label',
    'aiws.owner=aiws-v23',
    '--label',
    'aiws.role=production-data',
    '--label',
    'aiws.schema=23',
    volume
  ]);
}

function targetDisposition(config, facts) {
  if (facts.targetExists && !facts.targetEmpty) {
    try {
      return { disposition: 'reuse', acceptance: checkAcceptedTarget(config), recovery: null };
    } catch (error) {
      const recovery = readManagedFailedRecovery(config);
      if (!recovery)
        throw upgradeError('v23_incomplete_target_unattributed', {
          target_volume: config.targetVolume,
          acceptance_error: error.code || 'v23_acceptance_check_failed'
        });
      if (!facts.sourceExists || facts.sourceEmpty)
        throw upgradeError('v23_recovery_source_required', { source_volume: config.sourceVolume });
      assertRecoveryTarget(config.targetVolume);
      return { disposition: 'reclone', acceptance: null, recovery };
    }
  }
  return {
    disposition: facts.sourceExists && !facts.sourceEmpty ? 'clone' : 'unavailable',
    acceptance: null,
    recovery: null
  };
}

function readManagedFailedRecovery(config) {
  if (!fs.existsSync(TRANSCRIPT_PATH)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(TRANSCRIPT_PATH, 'utf8'));
  } catch {
    throw upgradeError('v23_recovery_transcript_invalid');
  }
  if (!isRecoverableV23Transcript(value, config)) return null;
  return {
    previous_status: value.status,
    previous_started_at: value.started_at || null,
    previous_failed_at: value.failed_at || null,
    previous_migration_volume: value.migration_volume || null
  };
}

export function isRecoverableV23Transcript(value, config = {}) {
  return Boolean(
    value &&
    value.version === V23_VERSION &&
    value.schema === V23_SCHEMA &&
    value.project === (config.projectName || V23_PROJECT) &&
    value.port === Number(config.port || 4317) &&
    value.source_volume === (config.sourceVolume || V23_SOURCE_VOLUME) &&
    value.target_volume === (config.targetVolume || V23_TARGET_VOLUME) &&
    ['clone', 'reclone'].includes(value.disposition) &&
    typeof value.status === 'string' &&
    value.status.startsWith('failed_') &&
    value.source_preserved === true &&
    value.acceptance?.accepted !== true &&
    !value.completed_at
  );
}

function assertRecoveryTarget(volume) {
  assertTargetVolumeLabels(volume, 'v23_recovery_target_unattributed');
  const consumers = docker(['ps', '-aq', '--filter', `volume=${volume}`], { capture: true, allowFailure: true })
    .split(/\r?\n/)
    .filter(Boolean);
  if (consumers.length) throw upgradeError('v23_recovery_target_in_use', { volume, containers: consumers });
}

function assertTargetVolumeLabels(volume, code) {
  const detail = inspectVolume(volume),
    mismatches = Object.entries(V23_TARGET_VOLUME_LABELS)
      .filter(([key, expectedValue]) => detail.Labels?.[key] !== expectedValue)
      .map(([key]) => key);
  if (mismatches.length) throw upgradeError(code, { volume, mismatches });
}

function resetIncompleteTarget(config, recovery) {
  assertRecoveryTarget(config.targetVolume);
  const migrationVolume = recovery?.previous_migration_volume;
  if (migrationVolume && volumeExists(migrationVolume)) {
    const detail = inspectVolume(migrationVolume),
      labels = detail.Labels || {};
    if (
      labels['aiws.owner'] !== 'aiws-v23-release' ||
      labels['aiws.role'] !== 'migration' ||
      labels['aiws.source'] !== config.sourceVolume ||
      labels['aiws.target'] !== config.targetVolume
    )
      throw upgradeError('v23_recovery_migration_volume_unattributed', { volume: migrationVolume });
    docker(['volume', 'rm', migrationVolume]);
  }
  docker(['volume', 'rm', config.targetVolume]);
  createTargetVolume(config.targetVolume);
}

function inspectVolume(volume) {
  const values = JSON.parse(docker(['volume', 'inspect', volume], { capture: true }) || '[]');
  if (values.length !== 1) throw upgradeError('v23_volume_inspect_invalid', { volume });
  return values[0];
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
  throw upgradeError('v23_volume_empty_check_failed', { volume });
}

function assertVolumeMount(containerId, volume) {
  const mounts = JSON.parse(
    docker(['inspect', '--format', '{{json .Mounts}}', containerId], { capture: true }) || '[]'
  );
  if (!mounts.some((item) => item.Type === 'volume' && item.Name === volume && item.Destination === '/var/lib/aiws'))
    throw upgradeError('v23_data_volume_mount_invalid');
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
    { ...options, env: composeEnvironment(config) }
  );
}

function composeEnvironment(config) {
  return {
    ...process.env,
    AIWS_DOCKER_DATA_VOLUME: config.targetVolume,
    AIWS_DOCKER_INSTANCE: config.projectName,
    AIWS_APP_IMAGE: config.appImage,
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
    throw upgradeError('v23_command_failed', {
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
  if (!fs.existsSync(composeFile)) throw upgradeError('v23_compose_file_missing');
  if (override && !fs.existsSync(override)) throw upgradeError('v23_compose_override_missing');
  return {
    composeFile,
    override,
    sourceVolume: options.sourceVolume || V23_SOURCE_VOLUME,
    targetVolume: options.targetVolume || V23_TARGET_VOLUME,
    projectName: options.projectName || V23_PROJECT,
    appImage: options.appImage || process.env.AIWS_APP_IMAGE || V23_APP_IMAGE,
    runnerImage: options.runnerImage || process.env.AIWS_RUNNER_IMAGE || V23_RUNNER_IMAGE,
    rollbackImage: options.rollbackImage || process.env.AIWS_ROLLBACK_IMAGE || null,
    port: Number(options.port || process.env.AIWS_PORT || 4317),
    waitMs: Math.max(0, Number(options.waitMs ?? 300_000)),
    pollMs: Math.max(250, Number(options.pollMs || 2000))
  };
}

function assertFormalConfig(config) {
  const expected = {
    sourceVolume: V23_SOURCE_VOLUME,
    targetVolume: V23_TARGET_VOLUME,
    projectName: V23_PROJECT,
    appImage: V23_APP_IMAGE,
    runnerImage: V23_RUNNER_IMAGE,
    port: 4317
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => config[key] !== value)
    .map(([key]) => key);
  if (mismatches.length) throw upgradeError('v23_formal_resources_required', { mismatches, expected });
}

function assertRollbackImage(image) {
  if (!image) return;
  if (!/^aiws-app:v22-rollback-[a-z0-9._-]+$/i.test(image)) throw upgradeError('v23_rollback_image_invalid', { image });
  if (run('docker', ['image', 'inspect', image], { capture: true, allowFailure: true }).status !== 0)
    throw upgradeError('v23_rollback_image_missing', { image });
}

async function writeTranscript(value) {
  const directory = path.dirname(TRANSCRIPT_PATH);
  await fsp.mkdir(directory, { recursive: true });
  const temporary = `${TRANSCRIPT_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, TRANSCRIPT_PATH);
}

export function v23AsyncEvalScript(script) {
  return `(async()=>{${script}})().catch((error)=>{console.error(error?.stack||error);process.exitCode=1})`;
}

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    throw upgradeError(code);
  }
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

export function runV23UpgradeCli(argv) {
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
    if (!field || value == null) throw upgradeError('v23_cli_argument_invalid', { flag });
    options[field] = value;
    index += 1;
  }
  return runV23Upgrade(options);
}
