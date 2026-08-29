import fs from 'node:fs';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { DeterministicAppServerAdapter } from '../../apps/api/src/clean/app-server-adapter.mjs';
import { createFakeProviderAdapters } from '../../apps/api/src/clean/provider-adapters.mjs';
import { DeterministicRunnerAdapter } from '../../apps/api/src/clean/runner-adapters.mjs';
import { DeterministicGitHubAdapter } from '../../apps/api/src/clean/p8/github-adapter.mjs';
import { DeterministicQualityAdviceAdapter } from '../../apps/api/src/clean/quality-service.mjs';
import { DeterministicRepositoryDeletionAdapter } from '../../apps/api/src/clean/p10-service.mjs';
import { fixture as p8Fixture, listen, closeServer, waitOperation } from '../p8/helpers.mjs';

export function fixture(overrides = {}) {
  return p8Fixture({ runtimeBuild: 'p10-test', providerMode: 'deterministic', ...overrides });
}

export async function open(options = {}) {
  const state = fixture(options.config || {});
  const runner = options.runnerAdapter || new DeterministicRunnerAdapter();
  const github = options.githubAdapter || new DeterministicGitHubAdapter();
  const repositoryDeletionAdapter = options.repositoryDeletionAdapter || new DeterministicRepositoryDeletionAdapter();
  const qualityAdviceAdapter = options.qualityAdviceAdapter || new DeterministicQualityAdviceAdapter();
  const runtime = createCleanRuntime({
    config: state.config,
    targetVersion: 9,
    runtimePhase: 10,
    providerAdapters: createFakeProviderAdapters(),
    providerAdapter: new DeterministicAppServerAdapter(),
    runnerAdapters: { host: runner, docker: runner, windows_bridge: runner },
    runnerRetryDelays: [0, 0],
    parserRetryDelays: [0, 0],
    githubAdapter: github,
    repositoryDeletionAdapter,
    qualityAdviceAdapter,
    ...options.runtime
  });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'P10 Owner', team_name: 'P10 Team', idempotency_key: 'p10-setup-key' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  return { ...state, runtime, principal, proof: setup.session.proof, github, repositoryDeletionAdapter, qualityAdviceAdapter };
}

export async function secondPrincipal(state, suffix = 'second') {
  const created = await state.runtime.identity.createSession({
    subjectActorId: state.principal.actorId,
    effectiveActorId: state.principal.actorId,
    ttlSeconds: 3600,
    actorId: state.principal.actorId,
    idempotencyKey: `p10-${suffix}-session`,
    expectedRevision: state.runtime.db.get('SELECT revision FROM actors WHERE id=?', [state.principal.actorId]).revision
  });
  return state.runtime.identity.authenticateProof(created.proof);
}

export async function close(state) {
  try { await state.runtime?.close?.(); } finally { fs.rmSync(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

export { listen, closeServer, waitOperation };
