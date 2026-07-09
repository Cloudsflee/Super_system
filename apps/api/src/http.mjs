import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { maskSecret, maskSecretsDeep } from '../../../packages/shared/index.mjs';

export class HttpError extends Error {
  constructor(status, payload) {
    super(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this.status = status;
    this.payload = payload;
  }
}

export function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(maskSecretsDeep(body), null, 2);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
  return true;
}

export function notFound(res) { return send(res, 404, { error: 'not_found' }); }

export async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

export function route(pathname, pattern) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  })}$`);
  const match = pathname.match(regex);
  return match ? Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) : null;
}

export function makeRoute(method, pattern, handler) { return { method, pattern, handler }; }

export async function dispatch(routes, ctx) {
  for (const item of routes) {
    if (item.method !== '*' && item.method !== ctx.req.method) continue;
    const params = route(ctx.pathname, item.pattern);
    if (!params) continue;
    ctx.params = params;
    ctx.body = ['POST', 'PUT', 'PATCH'].includes(ctx.req.method) ? await parseBody(ctx.req) : {};
    await item.handler(ctx);
    return true;
  }
  return false;
}

export function command(cmd, args = [], cwd = process.cwd(), timeout = 8000) {
  try {
    const r = spawnSync(cmd, args, { cwd, timeout, encoding: 'utf8', shell: false });
    return { ok: r.status === 0, status: r.status, stdout: maskSecret(r.stdout || ''), stderr: maskSecret(r.stderr || ''), error: r.error?.message || null };
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error: error.message };
  }
}

export function safeReadStream(res, full, type) {
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(full).pipe(res);
  return true;
}
