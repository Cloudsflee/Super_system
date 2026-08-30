import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('default Web entrypoint is Clean-only and uses v2 setup/project requests', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/App.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/api.ts'), 'utf8');
  const setup = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/features/setup/SystemOnboarding.tsx'), 'utf8');
  assert.deepEqual([...app.matchAll(/\{ key: '(projects|workflow|evidence|context|operations|settings)'/g)].map((match) => match[1]), ['projects', 'workflow', 'evidence', 'context', 'operations', 'settings']);
  assert.equal(app.includes("{ key: 'governance'"), false);
  assert.equal(app.includes("'/api/v1/"), false);
  assert.equal(setup.includes('/api/v2/setup'), true);
  assert.equal(setup.includes('/api/v2/credentials') && setup.includes('/api/v2/profiles'), true);
  assert.equal(api.includes("credentials: request.credentials || 'same-origin'"), true);
});
