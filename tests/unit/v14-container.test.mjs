import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v14-container-'));
const home = path.join(root, 'data-volume');
const profile = path.join(home, 'codex-homes', 'profile-one');
const workspace = path.join(home, 'workspaces', 'project-one', 'repo');
const imports = path.join(root, 'imports');
for (const directory of [profile, workspace, imports, path.join(imports, 'team', 'repo')]) fs.mkdirSync(directory, { recursive: true });
process.env.AIWS_HOME = home;

try {
  const config = await import('../../apps/api/src/container-runtime-config.mjs');
  const lifecycle = await import('../../apps/api/src/container-runtime.mjs');
  const { deploymentStatus } = await import('../../apps/api/src/deployment-status.mjs');
  const { resolveHostImportPath, validateHostImportRelative } = await import('../../apps/api/src/host-import-root.mjs');
  const { computeSetupStatus } = await import('../../apps/api/src/setup-status.mjs');
  const env = {
    AIWS_CONTAINERIZED: '1', AIWS_DOCKER_DATA_VOLUME: 'aiws-data-v14-test', AIWS_DOCKER_INSTANCE: 'unit-one',
    AIWS_RUNNER_CPUS: '1.5', AIWS_RUNNER_MEMORY: '768m', AIWS_RUNNER_PIDS: '256'
  };
  const secret = 'sk-v14-unit-secret';
  const invocation = config.buildCodexContainerInvocation({
    env, kind: 'node-run', sessionId: 'run-one', profileId: 'profile-one', nonce: 'fixed',
    codexHome: profile, workspace, workspaceMode: 'rw', stdin: true,
    containerEnv: { CODEX_HOME: '/codex-home', OPENAI_API_KEY: secret }, commandArgs: ['exec', '--json', '-']
  });
  assert.equal(invocation.command, 'docker');
  assert.ok(invocation.args.includes('aiws.managed=true'));
  assert.ok(invocation.args.includes('aiws.instance=unit-one'));
  assert.ok(invocation.args.includes('1.5'));
  assert.ok(invocation.args.includes('768m'));
  assert.ok(invocation.args.includes('256'));
  assert.ok(invocation.args.includes('ALL'));
  assert.ok(invocation.args.includes('no-new-privileges'));
  assert.ok(invocation.args.some((value) => value.includes('volume-subpath=codex-homes/profile-one')));
  assert.ok(invocation.args.some((value) => value.includes('volume-subpath=workspaces/project-one/repo')));
  assert.ok(invocation.args.includes('OPENAI_API_KEY'));
  assert.equal(invocation.args.some((value) => value.includes(secret)), false);
  assert.notEqual(invocation.containerName, config.buildCodexContainerInvocation({ env, kind: 'node-run', sessionId: 'run-one', codexHome: profile, workspace, commandArgs: [] }).containerName);

  assert.deepEqual(config.runnerLimits({}), { cpus: '2', memory: '4g', pids: '512' });
  assert.throws(() => config.runnerLimits({ AIWS_RUNNER_CPUS: '-1' }), /invalid_runner_cpus/);
  assert.throws(() => config.runnerLimits({ AIWS_RUNNER_MEMORY: '--privileged' }), /invalid_runner_memory/);
  assert.throws(() => config.runnerLimits({ AIWS_RUNNER_MEMORY: '99999t' }), /invalid_runner_memory/);
  assert.throws(() => config.runnerLimits({ AIWS_RUNNER_PIDS: '99999' }), /invalid_runner_pids/);
  assert.throws(() => config.validateDockerVolumeName('--mount'), /invalid_docker_data_volume/);
  assert.throws(() => config.runnerMount(root, '/workspace', 'rw', { env, aiwsHome: home }), /outside_data_volume/);
  assert.throws(() => config.runnerMount(workspace, '/', 'rw', { env, aiwsHome: home }), /invalid_runner_mount_target/);
  assert.deepEqual(config.runnerMount(workspace, '/workspace', 'ro', { containerized: false }), ['-v', `${workspace}:/workspace:ro`]);
  assert.throws(() => config.toRunnerPath(home, workspace), /outside_workspace/);
  assert.throws(() => config.assertProfileAllowed({ kind: 'host' }, env), /host_profile_disabled_in_container/);
  assert.equal(config.assertProfileAllowed({ kind: 'host' }, {}).kind, 'host');
  assert.equal(config.managedInstance({ AIWS_DOCKER_INSTANCE: '---UNIT one---' }), 'unit-one');

  let childEnvironment;
  lifecycle.spawnContainerProcess({ command: 'docker', args: [] }, {
    env: { AIWS_ENV_MERGE_TEST: 'ready', OPENAI_API_KEY: undefined },
    spawnProcess(_command, _args, options) { childEnvironment = options.env; return {}; }
  });
  assert.equal(childEnvironment.AIWS_ENV_MERGE_TEST, 'ready');
  assert.equal(Object.hasOwn(childEnvironment, 'OPENAI_API_KEY'), false);

  assert.equal(validateHostImportRelative('team/repo'), 'team/repo');
  for (const invalid of ['/etc', '../repo', 'team/../repo', 'C:\\repo', '//server/share', 'team\\repo']) assert.throws(() => validateHostImportRelative(invalid));
  const resolved = await resolveHostImportPath('team/repo', { root: imports });
  assert.equal(path.basename(resolved.absolute), 'repo');
  assert.equal(fs.statSync(resolved.absolute).isDirectory(), true);
  const symlink = path.join(imports, 'linked');
  try { fs.symlinkSync(path.join(imports, 'team'), symlink, 'junction'); await assert.rejects(() => resolveHostImportPath('linked/repo', { root: imports }), /host_import_symlink_rejected/); } catch (error) { if (fs.existsSync(symlink)) throw error; }

  const deployment = deploymentStatus({ env: { ...env, AIWS_HOST_PROJECTS_ROOT: imports, AIWS_DOCKER_DATA_VOLUME: 'volume-private' }, dockerReady: true, storageReady: true });
  assert.deepEqual(deployment, { mode: 'container', local_only: true, storage: { type: 'docker_volume', ready: true }, docker: { strategy: 'socket', ready: true }, imports: { codex_home: false, cc_switch: false, projects_root: true, project_path_mode: 'relative' } });
  const serialized = JSON.stringify(deployment);
  assert.equal(serialized.includes(imports), false);
  assert.equal(serialized.includes('volume-private'), false);

  const setupState = {
    setup_states: [{ mode: 'byo', completed_at: '2026-01-01T00:00:00.000Z' }],
    connected_accounts: [], github_app_configs: [], github_installations: [],
    codex_profiles: [{ id: 'profile-one', name: 'Unit profile', is_active: true, status: 'validated', provider: 'unit', base_url: 'https://unit.example/v1' }],
    integration_statuses: [
      { key: 'codex_auth', status: 'authenticated', provider: 'unit', base_url: 'https://unit.example/v1' },
      { key: 'codex_probe', profile_id: 'profile-one', status: 'ready', updated_at: '2026-01-01T00:00:00.000Z' }
    ]
  };
  const probeBackedStatus = computeSetupStatus(setupState);
  assert.equal(probeBackedStatus.steps.codex.checks.docker_ready, true);
  assert.equal(probeBackedStatus.steps.codex.ready, true);

  setupState.integration_statuses.push({ key: 'codex_probe', profile_id: 'profile-one', status: 'failed', updated_at: '2026-01-02T00:00:00.000Z' });
  const latestFailedStatus = computeSetupStatus(setupState);
  assert.equal(latestFailedStatus.steps.codex.checks.docker_ready, false);
  assert.equal(latestFailedStatus.steps.codex.ready, false);

  const calls = [];
  const removed = lifecycle.cleanupStaleContainers({ env, commandRunner(command, args) { calls.push([command, args]); return calls.length === 1 ? { status: 0, stdout: 'abcdef123456\ninvalid\n' } : { status: 0, stdout: '' }; } });
  assert.deepEqual(removed, ['abcdef123456']);
  assert.ok(calls[0][1].includes('label=aiws.instance=unit-one'));
  assert.deepEqual(calls[1][1].slice(0, 3), ['container', 'rm', '-f']);
  const normalizedCalls = [];
  lifecycle.cleanupStaleContainers({ env: { ...env, AIWS_DOCKER_INSTANCE: '---UNIT one---' }, commandRunner(command, args) { normalizedCalls.push([command, args]); return { status: 0, stdout: '' }; } });
  assert.ok(normalizedCalls[0][1].includes('label=aiws.instance=unit-one'));
  console.log('V1.4 container runtime unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
