import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { now } from '../../../../packages/shared/index.mjs';
import { inspectCodexRuntimeLive } from '../codex-runtime-status.mjs';
import { buildCodexDockerImage } from '../codex-docker-service.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { DEFAULT_CODEX_IMAGE } from '../codex-runtime-status.mjs';

export const codexRuntimeV12Routes = [
  makeRoute('GET', '/codex/status', codexStatus),
  makeRoute('POST', '/codex/docker/build', dockerBuild)
];

async function codexStatus({ res }) {
  const state = await readState();
  const activeProfile = state.codex_profiles.find((item) => item.is_active) || null;
  const runtime = inspectCodexRuntimeLive({ image: activeProfile?.image || undefined });
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const authenticated = auth?.status === 'authenticated';
  return send(res, 200, { docker: runtime.docker, image: runtime.image, authenticated, auth: authenticated ? { provider: auth.provider, base_url: auth.base_url || null, wire_api: auth.wire_api || 'responses', auth_mode: auth.auth_mode || (auth.home ? 'device' : 'api_key') } : null, active_profile: activeProfile });
}

async function dockerBuild({ res, body, query }) {
  const outcome = buildCodexDockerImage({ adapted: testAdapter(body, query) });
  const status = await mutate((state) => {
    const actor = owner(state), item = upsert(state, 'codex_docker', { status: outcome.ready ? 'ready' : 'failed', image: DEFAULT_CODEX_IMAGE, updated_at: now() });
    if (outcome.ready) {
      for (const probe of state.integration_statuses.filter((entry) => entry.key === 'codex_probe')) probe.status = 'stale';
      state.setup_states.forEach((entry) => { entry.completed_at = null; entry.updated_at = now(); });
    }
    addTrace(state, outcome.ready ? 'integration.checked' : 'integration.degraded', { summary: `Codex Docker: ${item.status}`, data: { ok: outcome.ready, error_code: outcome.error_code || null } }, actor.id);
    return item;
  });
  if (!outcome.ready) throw new HttpError(409, { error: outcome.error_code, message: outcome.message, action: outcome.action, phase: 'runtime', retryable: true });
  return send(res, 200, { ...status, runtime: outcome.runtime, output: outcome.output });
}

function upsert(state, key, patch) {
  let item = state.integration_statuses.find((entry) => entry.key === key);
  if (!item) { item = { key, created_at: now() }; state.integration_statuses.push(item); }
  return Object.assign(item, patch, { key });
}
