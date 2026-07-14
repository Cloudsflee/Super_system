import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { maskSecret, maskSecretsDeep } from '../../../packages/shared/index.mjs';
import { prepareCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
import { redactKnownSecretsSync } from './vault.mjs';

export class HttpError extends Error {
  constructor(status, payload) {
    super(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this.status = status;
    this.payload = payload;
  }
}

export function send(res, status, body, headers = {}) {
  const text = redactKnownSecretsSync(typeof body === 'string' ? body : JSON.stringify(maskSecretsDeep(body), null, 2));
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...headers
  });
  res.end(text);
  return true;
}

export function sendOneTimeSecret(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'pragma': 'no-cache',
    'access-control-allow-origin': 'http://127.0.0.1'
  });
  res.end(text);
  return true;
}

export function notFound(res) { return send(res, 404, { error: 'not_found' }); }

export async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new HttpError(413, { error: 'request_body_too_large', max_bytes: 32 * 1024 * 1024 }); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks), contentType = String(req.headers['content-type'] || '');
  if (/^multipart\/form-data/i.test(contentType)) { req.rawBody = bytes; return parseMultipart(bytes, contentType); }
  const raw = bytes.toString('utf8'); req.rawBody = raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

export function parseMultipart(bytes, contentType) {
  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;\s]+))/i), boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) throw new HttpError(400, { error: 'multipart_boundary_invalid' });
  const marker = Buffer.from(`--${boundary}`), delimiter = Buffer.from('\r\n\r\n'), result = {}, files = [];
  let cursor = 0, parts = 0;
  while (cursor < bytes.length) {
    const start = bytes.indexOf(marker, cursor); if (start < 0) break;
    let headerStart = start + marker.length; if (bytes.subarray(headerStart, headerStart + 2).toString() === '--') break;
    if (bytes.subarray(headerStart, headerStart + 2).toString() === '\r\n') headerStart += 2;
    const headerEnd = bytes.indexOf(delimiter, headerStart); if (headerEnd < 0) throw new HttpError(400, { error: 'multipart_part_invalid' });
    const next = bytes.indexOf(marker, headerEnd + delimiter.length); if (next < 0) throw new HttpError(400, { error: 'multipart_terminator_missing' });
    const headers = bytes.subarray(headerStart, headerEnd).toString('utf8'), disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1], filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
    if (!name) throw new HttpError(400, { error: 'multipart_name_required' });
    let dataEnd = next; if (bytes.subarray(next - 2, next).toString() === '\r\n') dataEnd -= 2;
    const data = bytes.subarray(headerEnd + delimiter.length, dataEnd); parts += 1;
    if (parts > 2000) throw new HttpError(413, { error: 'multipart_part_count_exceeded' });
    if (filename !== undefined) files.push({ name, filename, content_type: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream', data: Buffer.from(data) });
    else { if (data.length > 1024 * 1024) throw new HttpError(413, { error: 'multipart_field_too_large' }); result[name] = data.toString('utf8'); }
    cursor = next;
  }
  return { ...result, _files: files };
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

export function makeRoute(method, pattern, handler, options = {}) { return { method, pattern, handler, ...options }; }

export async function dispatch(routes, ctx) {
  for (const item of routes) {
    if (item.method !== '*' && item.method !== ctx.req.method) continue;
    const params = route(ctx.pathname, item.pattern);
    if (!params) continue;
    ctx.params = params;
    ctx.body = item.body === 'stream' ? {} : ['POST', 'PUT', 'PATCH'].includes(ctx.req.method) ? await parseBody(ctx.req) : {};
    await item.handler(ctx);
    return true;
  }
  return false;
}

export function command(cmd, args = [], cwd = process.cwd(), timeout = 8000, env = {}, options = {}) {
  try {
    const baseEnv = options.inheritEnv === false ? minimalProcessEnv() : process.env;
    const invocation = prepareCodexInvocation(cmd, args);
    const r = spawnSync(invocation.command, invocation.args, { cwd, timeout, encoding: 'utf8', shell: false, env: { ...baseEnv, ...env } });
    return { ok: r.status === 0, status: r.status, stdout: redactKnownSecretsSync(r.stdout || ''), stderr: redactKnownSecretsSync(r.stderr || ''), error: redactKnownSecretsSync(r.error?.message || '') || null };
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error: error.message };
  }
}

function minimalProcessEnv() { return Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])); }

export function safeReadStream(res, full, type) {
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
    'access-control-allow-origin': '*'
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
