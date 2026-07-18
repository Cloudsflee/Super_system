import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AIWS_HOME } from './config.mjs';
import { AIWS_RUNNER_IMAGE } from '../../../packages/shared/index.mjs';

export const DEFAULT_RUNNER_IMAGE = AIWS_RUNNER_IMAGE;

export function isContainerized(env = process.env) { return env.AIWS_CONTAINERIZED === '1'; }

export function validateDockerVolumeName(value) {
  const name = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('invalid_docker_data_volume');
  return name;
}

export function validateDockerNetworkName(value) {
  const name = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('invalid_docker_network');
  return name;
}

export function runnerLimits(env = process.env) {
  const cpus = String(env.AIWS_RUNNER_CPUS || '2');
  const memory = String(env.AIWS_RUNNER_MEMORY || '4g').toLowerCase();
  const pids = String(env.AIWS_RUNNER_PIDS || '512');
  if (!/^\d+(?:\.\d{1,3})?$/.test(cpus) || Number(cpus) < 0.1 || Number(cpus) > 64) throw new Error('invalid_runner_cpus');
  const bytes = parseMemoryBytes(memory);
  if (bytes < 4n * 1024n ** 2n || bytes > 1024n ** 4n) throw new Error('invalid_runner_memory');
  if (!/^\d+$/.test(pids) || Number(pids) < 32 || Number(pids) > 4096) throw new Error('invalid_runner_pids');
  return { cpus, memory, pids };
}

export function managedInstance(env = process.env) { return safeToken(env.AIWS_DOCKER_INSTANCE || 'aiws-host', 40); }

export function managedContainerIdentity({ kind, sessionId, profileId, env = process.env, nonce } = {}) {
  const instance = managedInstance(env);
  const scenario = safeToken(kind || 'runner', 24);
  const session = safeToken(sessionId || 'session', 36);
  const unique = safeToken(nonce || crypto.randomBytes(5).toString('hex'), 12);
  return {
    name: safeToken(`aiws-${instance}-${scenario}-${session}-${unique}`, 120),
    labels: {
      'aiws.managed': 'true', 'aiws.instance': instance, 'aiws.kind': scenario,
      'aiws.session': session, ...(profileId ? { 'aiws.profile': safeToken(profileId, 64) } : {})
    }
  };
}

export function runnerMount(source, target, mode = 'ro', options = {}) {
  const containerized = options.containerized ?? isContainerized(options.env);
  const root = path.resolve(options.aiwsHome || AIWS_HOME), resolved = path.resolve(String(source || ''));
  if (!/^\/[^/]+(?:\/[^/]+)*$/.test(target) || /[\0\r\n,]/.test(target) || target.split('/').some((item) => item === '.' || item === '..')) throw new Error('invalid_runner_mount_target');
  if (!['ro', 'rw'].includes(mode)) throw new Error('invalid_runner_mount_mode');
  if (!containerized) return ['-v', `${resolved}:${target}:${mode}`];
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('runner_mount_outside_data_volume');
  assertNoSymlinkSegments(root, relative);
  const subpath = relative.split(path.sep).join('/');
  if (!safeSubpath(subpath)) throw new Error('invalid_runner_volume_subpath');
  const volume = validateDockerVolumeName(options.env?.AIWS_DOCKER_DATA_VOLUME || process.env.AIWS_DOCKER_DATA_VOLUME);
  return ['--mount', `type=volume,src=${volume},dst=${target},volume-subpath=${subpath}${mode === 'ro' ? ',readonly' : ''}`];
}

export function toRunnerPath(file, workspace, mounted = '/workspace') {
  const relative = path.relative(path.resolve(workspace), path.resolve(file)).split(path.sep).join('/');
  if (!relative || relative.split('/').some((item) => !item || item === '.' || item === '..' || /[\0\r\n]/.test(item)) || path.posix.isAbsolute(relative)) throw new Error('runner_file_outside_workspace');
  return `${mounted}/${relative}`;
}

export function buildCodexContainerInvocation(options) {
  const env = options.env || process.env;
  const identity = managedContainerIdentity({ ...options, env });
  const limits = runnerLimits(env), args = ['run', '--rm', '--pull', 'never', '--name', identity.name, '--init'];
  for (const [key, value] of Object.entries(identity.labels)) args.push('--label', `${key}=${value}`);
  args.push('--cpus', limits.cpus, '--memory', limits.memory, '--pids-limit', limits.pids, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (options.stdin || options.interactive) args.push('-i');
  if (options.interactive) args.push('-t');
  if (options.hostGateway !== false) args.push('--add-host', 'host.docker.internal:host-gateway');
  if (env.AIWS_RUNNER_NETWORK) args.push('--network', validateDockerNetworkName(env.AIWS_RUNNER_NETWORK));
  for (const [key, value] of Object.entries(options.containerEnv || {})) appendEnvironment(args, key, value);
  if (options.codexHome) args.push(...runnerMount(options.codexHome, '/codex-home', options.codexHomeMode || 'rw', options));
  if (options.workspace) args.push(...runnerMount(options.workspace, '/workspace', options.workspaceMode || 'ro', options), '-w', '/workspace');
  for (const [index, mount] of (options.extraMounts || []).entries()) args.push(...runnerMount(mount, `/aiws-mounts/${index}`, 'ro', options));
  const image = String(options.image || env.AIWS_CODEX_DOCKER_IMAGE || DEFAULT_RUNNER_IMAGE);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) throw new Error('invalid_runner_image');
  args.push(image, ...(options.commandArgs || []));
  return { command: 'docker', args, containerName: identity.name, runtime: 'docker', cwd: options.workspace ? '/workspace' : null };
}

export function assertProfileAllowed(profile, env = process.env) {
  if (isContainerized(env) && profile?.kind !== 'docker') throw new Error('host_profile_disabled_in_container');
  return profile;
}

function appendEnvironment(args, key, value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('invalid_runner_environment_key');
  const sensitive = /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/.test(key);
  if (value === null || value === undefined || sensitive) args.push('--env', key);
  else {
    const text = String(value);
    if (/\0|\r|\n/.test(text)) throw new Error('invalid_runner_environment_value');
    args.push('--env', `${key}=${text}`);
  }
}

function assertNoSymlinkSegments(root, relative) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { throw new Error('runner_mount_missing'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('runner_mount_symlink');
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch { throw new Error('runner_mount_missing'); }
    if (stat.isSymbolicLink()) throw new Error('runner_mount_symlink');
  }
}

function parseMemoryBytes(value) {
  const match = String(value).match(/^([1-9]\d{0,8})(b|[kmgt](?:i?b)?)$/i);
  if (!match) throw new Error('invalid_runner_memory');
  const unit = match[2].toLowerCase(), prefix = unit === 'b' ? 'b' : unit[0];
  const multiplier = { b: 1n, k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n, t: 1024n ** 4n }[prefix];
  return BigInt(match[1]) * multiplier;
}

function safeSubpath(value) { return value.length <= 1024 && !value.split('/').some((item) => !item || item === '.' || item === '..' || /[\0\r\n,]/.test(item)); }
function safeToken(value, max) { return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, max) || 'unknown'; }
