import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { now } from '../../../../packages/shared/index.mjs';
import { inspectCodexRuntimeCached, invalidateCodexRuntimeCache } from '../codex-runtime-status.mjs';
import { CodexBuildManager } from '../codex-build-service.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { DEFAULT_CODEX_IMAGE } from '../codex-runtime-status.mjs';

const testDockerScript = process.env.NODE_ENV === 'test' ? process.env.AIWS_TEST_DOCKER_SCRIPT : null;
export const codexBuildManager = new CodexBuildManager({
  onTerminal: persistBuildOutcome,
  buildCommand: testDockerScript ? process.execPath : undefined,
  buildArgsPrefix: testDockerScript ? [testDockerScript] : undefined
});

export const codexRuntimeV12Routes = [
  makeRoute('GET', '/codex/status', codexStatus),
  makeRoute('POST', '/codex/docker/build', dockerBuild),
  makeRoute('GET', '/codex/docker/builds/active', activeDockerBuild),
  makeRoute('GET', '/codex/docker/builds/:id', dockerBuildStatus),
  makeRoute('GET', '/codex/docker/builds/:id/events', dockerBuildEvents),
  makeRoute('POST', '/codex/docker/builds/:id/cancel', cancelDockerBuild)
];

async function codexStatus({ res }) {
  const state = await readState();
  const activeProfile = state.codex_profiles.find((item) => item.is_active) || null;
  const runtime = await inspectCodexRuntimeCached({ image: activeProfile?.image || undefined });
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const authenticated = auth?.status === 'authenticated';
  return send(res, 200, {
    docker: runtime.docker,
    image: runtime.image,
    authenticated,
    auth: authenticated
      ? {
          provider: auth.provider,
          base_url: auth.base_url || null,
          wire_api: auth.wire_api || 'responses',
          auth_mode: auth.auth_mode || (auth.home ? 'device' : 'api_key')
        }
      : null,
    active_profile: activeProfile
  });
}

async function dockerBuild({ res, body, query }) {
  const state = await readState();
  const profile =
    state.codex_profiles.find((item) => item.is_active) ||
    state.codex_profiles.find((item) => item.status === 'validated');
  const image = profile?.image || DEFAULT_CODEX_IMAGE;
  if (testAdapter(body, query)) {
    const runtime = {
      ready: true,
      docker: { ok: true, available: true },
      image: { ready: true, ok: true, name: image, error_code: null }
    };
    const status = await persistBuildOutcome(
      { operation_id: 'test-adapter', image, status: 'completed', error_code: null },
      runtime
    );
    return send(res, 200, { ...status, runtime, output: 'test adapter: image ready' });
  }
  const result = await codexBuildManager.ensure({ image });
  if (result.immediate) {
    const status = await persistBuildOutcome(
      { operation_id: 'existing-image', image, status: 'completed', error_code: null },
      result.runtime
    );
    return send(res, 200, { ...status, runtime: result.runtime, output: 'image already ready' });
  }
  const operation = result.operation;
  return send(res, 202, {
    operation_id: operation.operation_id,
    status: operation.status,
    attached: result.attached,
    events_url: `/codex/docker/builds/${operation.operation_id}/events`,
    cancel_url: `/codex/docker/builds/${operation.operation_id}/cancel`,
    operation
  });
}

async function activeDockerBuild({ res, query }) {
  return send(res, 200, { operation: codexBuildManager.getActive(query.image) });
}

async function dockerBuildStatus({ res, params }) {
  const operation = codexBuildManager.get(params.id);
  if (!operation)
    throw new HttpError(404, {
      error: 'codex_build_not_found',
      message: '未找到该 Codex 构建任务',
      action: '重新开始镜像构建。',
      phase: 'build',
      retryable: true
    });
  return send(res, 200, operation);
}

async function cancelDockerBuild({ res, params }) {
  const operation = codexBuildManager.cancel(params.id);
  if (!operation)
    throw new HttpError(404, {
      error: 'codex_build_not_found',
      message: '未找到该 Codex 构建任务',
      action: '刷新构建状态后重试。',
      phase: 'build',
      retryable: true
    });
  return send(res, operation.status === 'running' ? 202 : 200, operation);
}

async function dockerBuildEvents({ req, res, params, query }) {
  const after = Math.max(0, Number(req.headers['last-event-id'] || query.after || 0) || 0);
  const replay = codexBuildManager.eventsSince(params.id, after);
  if (!replay)
    throw new HttpError(404, {
      error: 'codex_build_not_found',
      message: '未找到该 Codex 构建任务',
      action: '重新开始镜像构建。',
      phase: 'build',
      retryable: true
    });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let closed = false;
  let heartbeat = null;
  let unsubscribe = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    if (!res.writableEnded) res.end();
  };
  const write = (event) => {
    if (closed || res.writableEnded) return;
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    if (['completed', 'failed', 'cancelled'].includes(event.type)) setImmediate(close);
  };
  if (!after || replay.gap) write({ id: replay.snapshot.last_event_id, type: 'snapshot', data: replay.snapshot });
  else for (const event of replay.events) write(event);
  unsubscribe = codexBuildManager.subscribe(params.id, write);
  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();
  req.once('close', close);
  if (['completed', 'failed', 'cancelled'].includes(replay.snapshot.status)) setImmediate(close);
}

async function persistBuildOutcome(operation, runtime) {
  const ready = operation.status === 'completed';
  if (ready) invalidateCodexRuntimeCache(operation.image);
  return mutate((state) => {
    const actor = owner(state);
    const item = upsert(state, 'codex_docker', {
      status: ready ? 'ready' : operation.status === 'cancelled' ? 'cancelled' : 'failed',
      image: operation.image || DEFAULT_CODEX_IMAGE,
      error_code: operation.error_code || null,
      updated_at: now()
    });
    if (ready) {
      for (const probe of state.integration_statuses.filter((entry) => entry.key === 'codex_probe'))
        probe.status = 'stale';
      state.setup_states.forEach((entry) => {
        entry.completed_at = null;
        entry.updated_at = now();
      });
    }
    addTrace(
      state,
      ready ? 'integration.checked' : 'integration.degraded',
      {
        summary: `Codex Docker: ${item.status}`,
        data: { ok: ready, error_code: operation.error_code || null, operation_id: operation.operation_id }
      },
      actor.id
    );
    return { ...item, runtime };
  });
}

function upsert(state, key, patch) {
  let item = state.integration_statuses.find((entry) => entry.key === key);
  if (!item) {
    item = { key, created_at: now() };
    state.integration_statuses.push(item);
  }
  return Object.assign(item, patch, { key });
}
