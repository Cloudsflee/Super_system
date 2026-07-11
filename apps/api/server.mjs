import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { PORT, WEB_DIR } from './src/config.mjs';
import { dispatch, HttpError, notFound, safeReadStream, send } from './src/http.mjs';
import { ensureRuntime } from './src/state.mjs';
import { systemRoutes } from './src/routes/system.mjs';
import { projectRoutes } from './src/routes/projects.mjs';
import { runRoutes } from './src/routes/runs.mjs';
import { assetRoutes } from './src/routes/assets.mjs';
import { gitRoutes } from './src/routes/git.mjs';
import { githubRoutes } from './src/routes/github.mjs';
import { toolRoutes } from './src/routes/tools.mjs';
import { setupV12Routes } from './src/routes/setup-v12.mjs';
import { agentSessionRoutes } from './src/routes/agent-sessions.mjs';
import { changeProposalRoutes } from './src/routes/change-proposals.mjs';
import { githubConfigV12Routes } from './src/routes/github-config-v12.mjs';
import { githubInstallationsV12Routes } from './src/routes/github-installations-v12.mjs';
import { githubWebhookV12Routes } from './src/routes/github-webhook-v12.mjs';
import { codexV12Routes } from './src/routes/codex-v12.mjs';
import { codexDiscoveryV12Routes } from './src/routes/codex-discovery-v12.mjs';
import { workflowV12Routes } from './src/routes/workflow-v12.mjs';
import { fileV12Routes } from './src/routes/files-v12.mjs';
import { assistV12Routes } from './src/routes/assist-v12.mjs';
import { projectOnboardingV13Routes } from './src/routes/project-onboarding-v13.mjs';
import { approvalV13Routes } from './src/routes/approvals-v13.mjs';
import { terminalV13Routes } from './src/routes/terminal-v13.mjs';
import { attachTerminalWebSocket } from './src/terminal-service.mjs';
import { codexCapabilitiesV13Routes } from './src/routes/codex-capabilities-v13.mjs';
import { githubRepositoriesV13Routes } from './src/routes/github-repositories-v13.mjs';
import { configGovernanceV13Routes } from './src/routes/config-governance-v13.mjs';
import { assistV3Routes } from './src/routes/assist-v3.mjs';
import { recoverAssistV3Runtime } from './src/assist-v3-service.mjs';
import { maskSecret } from '../../packages/shared/index.mjs';
import { computeSetupStatus, isSetupExempt } from './src/setup-status.mjs';
import { readState } from './src/state.mjs';
import { redactKnownSecretsSync } from './src/vault.mjs';

await ensureRuntime();
await recoverAssistV3Runtime();

const routes = [
  ...systemRoutes,
  ...setupV12Routes,
  ...projectRoutes,
  ...projectOnboardingV13Routes,
  ...assistV12Routes,
  ...assistV3Routes,
  ...runRoutes,
  ...assetRoutes,
  ...gitRoutes,
  ...githubRoutes,
  ...toolRoutes,
  ...githubConfigV12Routes,
  ...githubInstallationsV12Routes,
  ...githubWebhookV12Routes,
  ...codexV12Routes,
  ...codexDiscoveryV12Routes,
  ...workflowV12Routes,
  ...fileV12Routes,
  ...agentSessionRoutes,
  ...changeProposalRoutes
  ,...approvalV13Routes
  ,...terminalV13Routes
  ,...codexCapabilitiesV13Routes
  ,...githubRepositoriesV13Routes
  ,...configGovernanceV13Routes
];

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET') return false;
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, file);
  const relative = path.relative(WEB_DIR, full);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext = path.extname(full);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.svg' ? 'image/svg+xml'
          : ext === '.json' ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
  safeReadStream(res, full, type);
  return true;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || '/');
  const routePath = pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '86400'
      });
      res.end();
      return;
    }
    if (await serveStatic(req, res, pathname)) return;
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html') && isSpaPath(pathname)) return serveStatic(req, res, '/');
    if (process.env.AIWS_BYPASS_SETUP !== '1' && !isSetupExempt(routePath) && isApiRequest(pathname, routePath)) {
      const status = computeSetupStatus(await readState());
      if (!status.complete) return send(res, 403, { error: 'setup_required', setup: status });
    }
    const handled = await dispatch(routes, { req, res, pathname: routePath, query: parsed.query });
    if (!handled && req.method === 'GET' && isSpaPath(pathname)) return serveStatic(req, res, '/');
    if (!handled) notFound(res);
  } catch (error) {
    if (error instanceof HttpError) {
      return send(res, error.status, typeof error.payload === 'string' ? { error: error.payload } : error.payload);
    }
    console.error(redactKnownSecretsSync(error.stack || error.message || String(error)));
    return send(res, 500, {
      error: 'internal_error',
      message: maskSecret(error.message),
      stack: process.env.NODE_ENV === 'test' ? error.stack : undefined
    });
  }
});
attachTerminalWebSocket(server);

function isApiRequest(pathname, routePath) {
  if (pathname.startsWith('/api/')) return true;
  return routes.some((item) => routePath.match(new RegExp(`^${item.pattern.replace(/:[^/]+/g, '[^/]+')}$`)));
}

function isSpaPath(pathname) {
  return pathname === '/setup' || pathname === '/integrations/github/install/setup' || pathname === '/projects' || pathname === '/assets' || pathname === '/audit' || pathname === '/settings'
    || /^\/projects\/[^/]+\/(workflow|onboarding|ide|nodes\/[^/]+)$/.test(pathname);
}

server.listen(PORT, () => {
  console.log(`AI Workspace System V1.3 running at http://localhost:${PORT}`);
});
