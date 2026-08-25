import fs from 'node:fs';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { DeterministicAppServerAdapter } from '../../apps/api/src/clean/app-server-adapter.mjs';
import { DeterministicRunnerAdapter } from '../../apps/api/src/clean/runner-adapters.mjs';
import { fixture as p6Fixture, prepare as p6Prepare, listen, closeServer, waitOperation } from '../p6/helpers.mjs';

export function fixture(overrides = {}) {
  return p6Fixture({
    parserPollIntervalMs: 1,
    parserImageDigest: 'sha256:bc69569bc471a27833b7f1174ac1634b5760614c6742237c443641ac5da808e4',
    runtimeBuild: 'p7-test',
    ...overrides
  });
}

export async function open(options = {}) {
  const { config: configOverrides = {}, runnerAdapter = new DeterministicRunnerAdapter(), ...runtimeOptions } = options;
  const state = fixture(configOverrides);
  const runtime = createCleanRuntime({
    config: state.config,
    targetVersion: 7,
    providerAdapter: new DeterministicAppServerAdapter(),
    runnerAdapters: { host: runnerAdapter, docker: runnerAdapter, windows_bridge: runnerAdapter },
    runnerRetryDelays: [0, 0],
    parserRetryDelays: [0, 0],
    ...runtimeOptions
  });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P7 Owner', team_name: 'P7 Team', idempotency_key: 'p7-setup-key' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal, proof: setup.session.proof, adapter: runnerAdapter };
}

export async function createProject(state, suffix = 'fixture') {
  return state.runtime.project.createProject({ name: `P7 ${suffix}`, idempotency_key: `p7-${suffix}-project-key` }, state.principal);
}

export async function prepare(state, suffix = 'flow', tasks = null) {
  return p6Prepare(state, suffix, tasks);
}

export async function close(state) {
  try { await state.runtime?.close?.(); } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
}

export { closeServer, listen, waitOperation };
