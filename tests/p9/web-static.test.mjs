import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCleanWebHandler } from '../../apps/api/src/clean/web-static.mjs';

test('P9 static handler serves only app-shell files with bounded cache policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-web-static-'));
  fs.mkdirSync(path.join(root, 'assets')); fs.writeFileSync(path.join(root, 'index.html'), '<main>P9</main>'); fs.writeFileSync(path.join(root, 'sw.js'), 'self.skipWaiting()'); fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'export{}');
  const handler = createCleanWebHandler({ root });
  const server = http.createServer((request, response) => { if (!handler(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const index = await fetch(`http://127.0.0.1:${port}/`); assert.equal(index.status, 200); assert.equal(await index.text(), '<main>P9</main>'); assert.equal(index.headers.get('cache-control'), 'no-cache, no-store'); assert.match(index.headers.get('content-security-policy'), /object-src 'none'/);
    const route = await fetch(`http://127.0.0.1:${port}/outcome`); assert.equal(await route.text(), '<main>P9</main>');
    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`); assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v2/projects`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/..%2f..%2fsecret.txt`)).status, 200, 'unknown paths fall back to the shell without reading outside root');
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
