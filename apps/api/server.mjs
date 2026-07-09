import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { PORT, WEB_DIR } from './src/config.mjs';
import { dispatch, HttpError, notFound, safeReadStream, send } from './src/http.mjs';
import { ensureRuntime } from './src/state.mjs';
import { systemRoutes } from './src/routes/system.mjs';
import { projectRoutes } from './src/routes/projects.mjs';
import { assistRoutes } from './src/routes/assist.mjs';
import { runRoutes } from './src/routes/runs.mjs';
import { assetRoutes } from './src/routes/assets.mjs';
import { gitRoutes } from './src/routes/git.mjs';
import { githubRoutes } from './src/routes/github.mjs';
import { toolRoutes } from './src/routes/tools.mjs';
import { demoRoutes } from './src/routes/demo.mjs';
import { maskSecret } from '../../packages/shared/index.mjs';

await ensureRuntime();

const routes = [
  ...systemRoutes,
  ...projectRoutes,
  ...assistRoutes,
  ...runRoutes,
  ...assetRoutes,
  ...gitRoutes,
  ...githubRoutes,
  ...toolRoutes,
  ...demoRoutes
];

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET') return false;
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext = path.extname(full);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
  safeReadStream(res, full, type);
  return true;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || '/');
  try {
    if (await serveStatic(req, res, pathname)) return;
    const handled = await dispatch(routes, { req, res, pathname, query: parsed.query });
    if (!handled) notFound(res);
  } catch (error) {
    if (error instanceof HttpError) {
      return send(res, error.status, typeof error.payload === 'string' ? { error: error.payload } : error.payload);
    }
    console.error(error);
    return send(res, 500, {
      error: 'internal_error',
      message: maskSecret(error.message),
      stack: process.env.NODE_ENV === 'test' ? error.stack : undefined
    });
  }
});

server.listen(PORT, () => {
  console.log(`AI Workspace System V1 running at http://localhost:${PORT}`);
});
