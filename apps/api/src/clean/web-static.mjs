import fs from 'node:fs';
import path from 'node:path';

const MIME = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2'
});

export function createCleanWebHandler({ root = path.resolve('apps/web/dist') } = {}) {
  const webRoot = path.resolve(root);
  const indexFile = path.join(webRoot, 'index.html');
  return function cleanWebHandler(req, res) {
    if (!['GET', 'HEAD'].includes(String(req.method || 'GET'))) return false;
    const url = new URL(req.url || '/', 'http://v3-clean.local');
    if (url.pathname === '/livez' || url.pathname === '/readyz' || url.pathname.startsWith('/api/')) return false;
    if (!fs.existsSync(indexFile)) return false;
    const requested = url.pathname === '/' ? indexFile : safeFile(webRoot, url.pathname);
    const file = requested && fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : indexFile;
    const relative = path.relative(webRoot, file).replaceAll('\\', '/');
    const immutable = relative.startsWith('assets/');
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache, no-store',
      'content-security-policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'cross-origin-opener-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    };
    const stat = fs.statSync(file);
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  };
}

function safeFile(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const candidate = path.resolve(root, `.${decoded}`);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}
