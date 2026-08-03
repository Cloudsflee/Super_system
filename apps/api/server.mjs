import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOST, PORT, WEB_DIR } from './src/config.mjs';
import {
  allowLocalBrowserOrigin,
  decodeUrlPathname,
  dispatch,
  HttpError,
  notFound,
  safeReadStream,
  send
} from './src/http.mjs';
import { checkpointAndCloseState, ensureRuntime, readStateSnapshot } from './src/state.mjs';
import { attachTerminalWebSocket, closeTerminalRuntimes } from './src/terminal-service.mjs';
import {
  attachDeletedSessionSweeper,
  purgeExpiredDeletedSessions,
  recoverAssistV3Runtime
} from './src/assist-v3-service.mjs';
import { AIWS_VERSION } from '../../packages/shared/index.mjs';
import { computeSetupStatus, isSetupExempt } from './src/setup-status.mjs';
import { redactKnownSecretsSync } from './src/vault.mjs';
import { cleanupStaleContainers, stopAllManagedContainers } from './src/container-runtime.mjs';
import { attachHostBridgeWebSocket, closeHostBridgeWebSockets } from './src/host-bridge-service.mjs';
import { attachBtwShutdown, closeAllAssistBtw } from './src/assist-btw.mjs';
import { codexBuildManager } from './src/routes/codex-runtime-v12.mjs';
import { apiRoutes } from './src/api-routes.mjs';
import { createApiRouteRegistry } from './src/api-route-registry.mjs';
import { resumeWorkflowMigrationOrchestrator } from './src/workflow-migration-service.mjs';
import { closeMcpHttpRuntime, configureMcpHttpRuntime } from './src/mcp-http-runtime.mjs';
import { closeGithubProxyDispatchers } from './src/outbound-proxy.mjs';
import { runAsActor } from './src/actor-context.mjs';
import { authorizeApiRoute, requestSubjectUserId } from './src/project-governance-v19.mjs';
import { recoverPersistentWorkflowExecutions } from './src/task-execution-service.mjs';
import { startWorkflowDispatcher } from './src/workflow-dispatcher.mjs';
import { startContextProjectorCoordinator } from './src/context-projector-coordinator.mjs';
import { ensureContextSearchIndex, initializeContextIndexRuntime } from './src/context-index-runtime.mjs';
import { createShutdownCoordinator, isRuntimeDraining } from './src/shutdown-coordinator.mjs';
import { livezSnapshot } from './src/runtime-health.mjs';
import { shutdownQualityReviews } from './src/quality-review-service.mjs';

cleanupStaleContainers();
await ensureRuntime();
await recoverPersistentWorkflowExecutions();
await resumeWorkflowMigrationOrchestrator();
await recoverAssistV3Runtime();
await purgeExpiredDeletedSessions();
try {
  await initializeContextIndexRuntime();
  await ensureContextSearchIndex(await readStateSnapshot());
} catch (error) {
  console.error(
    `context index startup failed: ${redactKnownSecretsSync(error?.code || error?.message || String(error))}`
  );
}
const stopWorkflowDispatcher = startWorkflowDispatcher();
const stopContextProjector =
  process.env.NODE_ENV === 'test' && process.env.AIWS_TEST_DISABLE_CONTEXT_PROJECTOR === '1'
    ? () => undefined
    : startContextProjectorCoordinator();

const routes = createApiRouteRegistry(apiRoutes);
configureMcpHttpRuntime(routes);

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET') return false;
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, file);
  const relative = path.relative(WEB_DIR, full);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(full) || fs.statSync(full).isDirectory())
    return false;
  const ext = path.extname(full);
  const type =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.json'
              ? 'application/json; charset=utf-8'
              : 'application/octet-stream';
  safeReadStream(res, full, type);
  return true;
}

const server = http.createServer(async (req, res) => {
  const requestId = requestIdFor(req.headers['x-aiws-request-id']);
  res.setHeader('x-aiws-request-id', requestId);
  try {
    const parsed = new URL(req.url || '/', 'http://aiws.local');
    const encodedPathname = parsed.pathname || '/',
      pathname = decodeUrlPathname(encodedPathname);
    const routePath = encodedPathname.startsWith('/api/') ? encodedPathname.slice(4) : encodedPathname;
    allowLocalBrowserOrigin(req, res);
    if (req.method === 'GET' && routePath === '/livez') return send(res, 200, livezSnapshot());
    if (isRuntimeDraining() && routePath !== '/readyz')
      return send(res, 503, { error: 'service_draining', retryable: true });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers':
          'content-type, authorization, range, if-none-match, last-event-id, mcp-session-id, mcp-protocol-version, x-aiws-request-id, x-aiws-browser-id, x-aiws-btw-token, x-idempotency-key, x-aiws-user-id, x-aiws-subject-user-id, x-aiws-scopes',
        'access-control-max-age': '86400'
      });
      res.end();
      return;
    }
    if (await serveStatic(req, res, pathname)) return;
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html') && isSpaPath(pathname))
      return serveStatic(req, res, '/');
    const requestState = isApiRequest(pathname, routePath) ? await readStateSnapshot({ refresh: true }) : null;
    if (process.env.AIWS_BYPASS_SETUP !== '1' && !isSetupExempt(routePath) && isApiRequest(pathname, routePath)) {
      const status = computeSetupStatus(requestState);
      if (!status.complete) return send(res, 403, { error: 'setup_required', setup: status });
    }
    const subjectUserId = requestSubjectUserId(req);
    const handled = await runAsActor(subjectUserId, () =>
      dispatch(routes, {
        req,
        res,
        pathname: routePath,
        query: searchParamsObject(parsed.searchParams),
        authorize: (route, context) => authorizeApiRoute(route, context, { strict: false, state: requestState })
      })
    );
    if (!handled && req.method === 'GET' && isSpaPath(pathname)) return serveStatic(req, res, '/');
    if (!handled) notFound(res);
  } catch (error) {
    if (error instanceof HttpError) {
      return send(res, error.status, typeof error.payload === 'string' ? { error: error.payload } : error.payload);
    }
    console.error(`[request ${requestId}] ${redactKnownSecretsSync(error.stack || error.message || String(error))}`);
    return send(res, 500, {
      error: 'internal_error',
      message: '服务端处理请求时发生内部错误',
      action: '使用请求 ID 查看服务端日志；确认服务状态后重试。',
      phase: 'server',
      retryable: false
    });
  }
});
const terminalSockets = attachTerminalWebSocket(server);
const hostBridgeSockets = attachHostBridgeWebSocket(server);
attachBtwShutdown(server);
attachDeletedSessionSweeper(server);
const shutdownCoordinator = createShutdownCoordinator({
  server,
  stopDispatcher: stopWorkflowDispatcher,
  stopProjector: stopContextProjector,
  stopRuntimeWork: async () => {
    await shutdownQualityReviews();
    codexBuildManager.shutdown();
    await closeTerminalRuntimes();
    if (process.env.AIWS_CONTAINERIZED === '1') stopAllManagedContainers();
  },
  closeTransports: async () => {
    await Promise.allSettled([
      closeAllAssistBtw('service_stopped'),
      closeHostBridgeWebSockets(),
      closeMcpHttpRuntime(),
      closeGithubProxyDispatchers()
    ]);
    await Promise.allSettled([closeWebSocketServer(terminalSockets), closeWebSocketServer(hostBridgeSockets)]);
  },
  closePersistence: checkpointAndCloseState,
  timeoutMs: 30_000,
  exit: (code) => process.exit(code)
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void shutdownCoordinator.shutdown(signal).catch((error) => {
      console.error(`shutdown failed: ${redactKnownSecretsSync(error?.code || error?.message || String(error))}`);
    });
  });

function searchParamsObject(params) {
  const result = Object.create(null);
  for (const [key, value] of params) {
    if (!Object.hasOwn(result, key)) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

function requestIdFor(value) {
  const candidate = Array.isArray(value) ? value[0] : String(value || '');
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(candidate) ? candidate : `req_${randomUUID().replaceAll('-', '')}`;
}

function isApiRequest(pathname, routePath) {
  if (pathname.startsWith('/api/')) return true;
  return routes.some((item) => routePath.match(new RegExp(`^${item.pattern.replace(/:[^/]+/g, '[^/]+')}$`)));
}

function isSpaPath(pathname) {
  return (
    /^\/(?:setup|projects|assets|context|audit|settings)\/?$/.test(pathname) ||
    /^\/integrations\/github\/install\/setup\/?$/.test(pathname) ||
    /^\/projects\/[^/]+\/(?:workflow(?:\/[^/]+)?|onboarding|context|nodes\/[^/]+)\/?$/.test(pathname)
  );
}

function closeWebSocketServer(sockets) {
  return new Promise((resolve) => sockets.close(() => resolve()));
}

server.listen(PORT, HOST, () => {
  console.log(`AI Workspace System V${AIWS_VERSION} running at http://${HOST}:${PORT}`);
});
