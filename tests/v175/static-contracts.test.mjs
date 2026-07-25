import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const routeDir = 'apps/api/src/routes',
  routeFiles = fs.readdirSync(routeDir).filter((file) => file.endsWith('.mjs'));
const writes = [];
for (const file of routeFiles) {
  const source = fs.readFileSync(path.join(routeDir, file), 'utf8');
  for (const match of source.matchAll(/makeRoute\(\s*['"](POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]([^'"]+)['"]/g))
    writes.push({ file, method: match[1], route: match[2] });
}
assert.ok(writes.length >= 80, `expected a substantial write-route surface, found ${writes.length}`);
assert.equal(
  new Set(writes.map((item) => `${item.method} ${item.route}`)).size,
  writes.length,
  'write routes are unique by method and path'
);

const server = fs.readFileSync('apps/api/server.mjs', 'utf8');
for (const header of ['x-aiws-request-id', 'last-event-id', 'x-aiws-browser-id'])
  assert.ok(server.includes(header), `server exposes ${header}`);
assert.ok(server.includes('redactKnownSecretsSync'), 'server errors are redacted');

const web = walk('apps/web/src')
  .filter((file) => /\.(?:ts|tsx)$/.test(file) && !file.includes('/test/'))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
  assert.ok(web.includes(`json('${method}'`), `web describes ${method} writes`);
assert.doesNotMatch(
  web,
  /sessionStorage\.setItem\([^,]+,\s*(?:apiKey|token|secret|authorization)\b/i,
  'raw credentials must not enter sessionStorage'
);

const operationStore = fs.readFileSync('apps/web/src/operations/operation-store.ts', 'utf8');
assert.match(operationStore, /slice\(0, 100\)/, 'diagnostics are capped at 100');
const build = fs.readFileSync('apps/api/src/codex-build-service.mjs', 'utf8');
assert.match(build, /maxLogLines\s*=.*200/);
assert.match(build, /maxLogBytes\s*=.*64 \* 1024/);
console.log(`V1.75 static contracts passed (${writes.length} write routes)`);

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name).replaceAll('\\', '/');
    return entry.isDirectory() ? walk(full) : [full];
  });
}
