import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifyWorkspacePath } from '../../scripts/lib/v3-clean-p1-scope.mjs';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('P9 Web foundation, dependencies and retired files are synchronized', () => {
  const web = JSON.parse(read('apps/web/package.json'));
  assert.equal(web.scripts.dev, 'vite --host 127.0.0.1 --port 5174 --strictPort');
  assert.match(web.dependencies['react-router-dom'], /^\^7\./);
  assert.match(web.dependencies['@tanstack/react-query'], /^\^5\./);
  assert.match(web.dependencies.idb, /^\^8\./);
  assert.match(web.devDependencies['vite-plugin-pwa'], /^\^1\./);
  const lock = read('pnpm-lock.yaml');
  for (const marker of ['react-router-dom@7.', '@tanstack/react-query@5.', 'idb@8.', 'vite-plugin-pwa@1.']) assert.ok(lock.includes(marker), marker);
  for (const file of [
    'apps/web/src/pages.tsx',
    'apps/web/src/features/setup/SetupPage.tsx',
    'apps/web/src/features/project/ProjectOnboarding.tsx',
    'apps/web/src/features/workflow/WorkflowPage.tsx',
    'apps/web/src/features/repository/RepositoryPanel.tsx'
  ]) assert.equal(fs.existsSync(path.join(root, file)), false, file);
});

test('P9 active Web has a hash router, scoped Query cache and no v1 request helper', () => {
  const app = read('apps/web/src/App.tsx');
  const query = read('apps/web/src/query.ts');
  const api = read('apps/web/src/api.ts');
  assert.match(app, /createHashRouter/);
  assert.match(app, /RouterProvider/);
  assert.match(app, /QueryClientProvider/);
  assert.match(query, /\['v2', scope\.actorId, scope\.teamId, scope\.projectId, resource, params\]/);
  assert.match(query, /failureCount < 2/);
  assert.match(query, /mutations:[\s\S]*retry: 0/);
  assert.doesNotMatch(api, /export (?:async )?function (?:api|mutate)</);
  assert.doesNotMatch(api, /`\/api\/v1\//);
});

test('P9 Service Worker precaches only shell and keeps protected routes NetworkOnly', () => {
  const vite = read('apps/web/vite.config.ts');
  const worker = read('apps/web/src/sw.ts');
  assert.match(vite, /strategies: 'injectManifest'/);
  assert.match(worker, /precacheAndRoute\(self\.__WB_MANIFEST/);
  assert.match(worker, /new NetworkOnly\(\)/);
  for (const route of ['/api/v2/', '/livez', '/readyz', '/cas/', '/downloads/']) assert.ok(worker.includes(`'${route}'`), route);
  assert.doesNotMatch(worker, /CacheFirst|NetworkFirst|StaleWhileRevalidate|cache\.put/);
});

test('P9 governance files declare Clean phase ownership', () => {
  for (const file of [
    'apps/web/src/events.ts', 'apps/web/src/query.ts', 'apps/web/src/sw.ts',
    'apps/web/src/offline/canonical.ts', 'apps/web/src/offline/db.ts',
    'apps/web/src/offline/outbox.ts', 'apps/web/src/offline/OutboxStatus.tsx',
    'tests/p9/web-governance.test.mjs', 'scripts/v3-clean-p9-evidence.mjs'
  ]) assert.deepEqual(classifyWorkspacePath(file), { kind: 'clean', phase: 'P9', rows: [] }, file);
});
