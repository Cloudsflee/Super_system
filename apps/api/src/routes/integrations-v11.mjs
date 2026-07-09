import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { command, makeRoute, send } from '../http.mjs';
import { AIWS_HOME, ROOT } from '../config.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { codexProfileFromCcSwitch, maskSecretsDeep, now } from '../../../../packages/shared/index.mjs';

const ccSources = [
  { name: 'cc-switch-desktop', repo: 'https://github.com/farion1231/cc-switch.git' },
  { name: 'cc-switch-cli', repo: 'https://github.com/SaladDay/cc-switch-cli.git' }
];

export const integrationV11Routes = [
  makeRoute('GET', '/integrations/codex/status', codexStatus),
  makeRoute('POST', '/integrations/codex/docker/build', codexDockerBuild),
  makeRoute('GET', '/integrations/cc-switch/status', ccSwitchStatus),
  makeRoute('POST', '/integrations/cc-switch/sync', ccSwitchSync),
  makeRoute('GET', '/codex/profiles', codexProfiles),
  makeRoute('POST', '/codex/profiles/:id/apply', applyCodexProfile)
];

async function codexStatus({ res }) {
  const state = await readState();
  const docker = command('docker', ['--version'], ROOT, 5000);
  const image = command('docker', ['image', 'inspect', 'aiws-codex-runner:local'], ROOT, 5000);
  return send(res, 200, {
    docker: { healthy: docker.ok, version: docker.stdout.trim() || docker.error },
    image: { name: 'aiws-codex-runner:local', built: image.ok },
    active_profile: state.codex_profiles.find((p) => p.is_active) || null,
    mode: 'docker-per-run',
    degraded_ok: true
  });
}

async function codexDockerBuild({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const dockerfile = path.join(ROOT, 'docker', 'codex-runner.Dockerfile');
    const dryRun = body.mock !== false || body.dry_run !== false;
    const status = dryRun ? { ok: true, stdout: 'mock docker build ok', stderr: '' }
      : command('docker', ['build', '-f', dockerfile, '-t', 'aiws-codex-runner:local', '.'], ROOT, 120000);
    upsertIntegration(state, 'codex_docker', { status: status.ok ? 'ready' : 'degraded', detail: maskSecretsDeep(status), updated_at: now() });
    for (const profile of state.codex_profiles.filter((p) => p.kind === 'docker')) Object.assign(profile, { status: status.ok ? 'ready' : 'degraded', updated_at: now() });
    addTrace(state, status.ok ? 'integration.checked' : 'integration.degraded', { summary: `Codex Docker build/status：${status.ok ? 'ready' : 'degraded'}`, data: status }, actor.id);
    return { ok: status.ok, dry_run: dryRun, dockerfile: 'docker/codex-runner.Dockerfile', image: 'aiws-codex-runner:local', status };
  });
  return send(res, 200, result);
}

async function ccSwitchStatus({ res }) {
  const state = await readState();
  const status = state.integration_statuses.find((item) => item.key === 'cc_switch') || defaultCcStatus();
  return send(res, 200, status);
}

async function ccSwitchSync({ res, body }) {
  const result = await mutate(async (state) => {
    const actor = owner(state);
    const baseDir = path.join(AIWS_HOME, 'external', 'cc-switch');
    await fsp.mkdir(baseDir, { recursive: true });
    const dryRun = body.mock === true || body.dry_run === true;
    const sources = [];
    for (const source of ccSources) sources.push(await syncSource(baseDir, source, dryRun));
    const degraded = sources.some((item) => item.status !== 'synced');
    upsertIntegration(state, 'cc_switch', { key: 'cc_switch', status: degraded ? 'degraded' : 'synced', local_path: baseDir, sources, updated_at: now() });
    mergeCcProfiles(state, sources, actor.id);
    addTrace(state, degraded ? 'integration.degraded' : 'integration.synced', { summary: `cc-switch 同步：${degraded ? 'degraded' : 'synced'}`, data: { sources } }, actor.id);
    return { status: degraded ? 'degraded' : 'synced', local_path: baseDir, sources };
  });
  return send(res, 200, result);
}

async function syncSource(baseDir, source, dryRun) {
  const target = path.join(baseDir, source.name);
  if (dryRun) return { ...source, status: 'synced', local_path: target, commit: 'dry-run' };
  if (!fs.existsSync(target)) {
    const cloned = command('git', ['clone', '--depth', '1', source.repo, target], ROOT, 60000);
    if (!cloned.ok) return { ...source, status: 'degraded', local_path: target, error: cloned.stderr || cloned.error };
  } else {
    const pulled = command('git', ['pull', '--ff-only'], target, 60000);
    if (!pulled.ok) return { ...source, status: 'degraded', local_path: target, error: pulled.stderr || pulled.error };
  }
  const commit = command('git', ['rev-parse', 'HEAD'], target, 10000);
  return { ...source, status: commit.ok ? 'synced' : 'degraded', local_path: target, commit: commit.stdout.trim(), error: commit.error };
}

function mergeCcProfiles(state, sources, actorId) {
  const keep = state.codex_profiles.filter((profile) => profile.kind !== 'cc_switch');
  state.codex_profiles = [...keep, ...sources.map((source) => codexProfileFromCcSwitch(source, actorId))];
}

async function codexProfiles({ res }) {
  return send(res, 200, (await readState()).codex_profiles);
}

async function applyCodexProfile({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const profile = state.codex_profiles.find((item) => item.id === params.id);
    if (!profile) return { error: 'profile_not_found' };
    for (const item of state.codex_profiles) item.is_active = item.id === profile.id;
    profile.updated_at = now();
    addTrace(state, 'human.reviewed', { target_type: 'codex_profile', target_id: profile.id, summary: `应用 Codex Profile：${profile.name}` }, actor.id);
    return profile;
  });
  return result?.error ? send(res, 404, result) : send(res, 200, result);
}

function defaultCcStatus() {
  return { key: 'cc_switch', status: 'not_synced', local_path: path.join(AIWS_HOME, 'external', 'cc-switch'), sources: ccSources, updated_at: null };
}

function upsertIntegration(state, key, patch) {
  let item = state.integration_statuses.find((entry) => entry.key === key);
  if (!item) { item = { key, created_at: now() }; state.integration_statuses.push(item); }
  Object.assign(item, patch, { key, updated_at: now() });
  return item;
}
