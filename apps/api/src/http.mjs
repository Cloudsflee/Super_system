import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
  const requestId = String(res.getHeader('x-aiws-request-id') || '');
  const normalized = status >= 400 && body && typeof body === 'object' && !Array.isArray(body)
    ? normalizeErrorPayload(body, requestId)
    : body;
  const text = redactKnownSecretsSync(typeof normalized === 'string' ? normalized : JSON.stringify(maskSecretsDeep(normalized), null, 2));
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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
    'pragma': 'no-cache'
  });
  res.end(text);
  return true;
}

export function notFound(res) { return send(res, 404, { error: 'not_found' }); }

export function normalizeErrorPayload(payload = {}, requestId = '') {
  const error = String(payload.error || 'request_failed');
  return {
    ...payload,
    error,
    message: String(payload.message || payload.reason || error),
    action: typeof payload.action === 'string' ? payload.action : null,
    phase: typeof payload.phase === 'string' ? payload.phase : 'request',
    retryable: payload.retryable === true,
    request_id: String(payload.request_id || requestId || '') || null
  };
}

export function allowLocalBrowserOrigin(req, res) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  if (!isTrustedLocalOrigin(origin)) throw new HttpError(403, { error: 'local_origin_required' });
  res.setHeader('access-control-allow-origin', new URL(origin).origin);
  res.setHeader('access-control-expose-headers', 'x-aiws-request-id, mcp-session-id');
  res.setHeader('vary', 'Origin');
  return origin;
}

export function isTrustedLocalOrigin(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host));
  } catch { return false; }
}

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
  return match ? Object.fromEntries(names.map((name, i) => [name, decodeUrlPart(match[i + 1])])) : null;
}

export function decodeUrlPathname(value) { return decodeUrlPart(value); }

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

export function commandAsync(cmd, args = [], cwd = process.cwd(), timeout = 8000, env = {}, options = {}) {
  return new Promise((resolve) => {
    const baseEnv = options.inheritEnv === false ? minimalProcessEnv() : process.env;
    const invocation = prepareCodexInvocation(cmd, args);
    const maxOutputBytes = Number(options.maxOutputBytes || 2 * 1024 * 1024);
    let stdout = '', stderr = '', settled = false, timedOut = false;
    let child;
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: status === 0 && !error && !timedOut,
        status,
        stdout: redactKnownSecretsSync(stdout),
        stderr: redactKnownSecretsSync(stderr),
        error: redactKnownSecretsSync(error?.message || '') || null,
        timed_out: timedOut
      });
    };
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd, shell: false, windowsHide: true, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, status: null, stdout: '', stderr: '', error: redactKnownSecretsSync(error.message), timed_out: false });
      return;
    }
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-maxOutputBytes);
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      const force = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1000);
      force.unref?.();
    }, timeout);
    timer.unref?.();
  });
}

function minimalProcessEnv() { return Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])); }

function decodeUrlPart(value) {
  try { return decodeURIComponent(String(value)); }
  catch { throw new HttpError(400, { error: 'invalid_url_encoding' }); }
}

export function safeReadStream(res, full, type) {
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'pragma': 'no-cache',
    'expires': '0'
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
