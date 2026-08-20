import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('default Web entrypoint is Clean-only and uses v2 setup/project requests', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/App.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/api.ts'), 'utf8');
  const setup = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/features/setup/CleanSetupPage.tsx'), 'utf8');
  assert.equal((app.match(/key: 'setup'|key: 'identity'|key: 'projects'|key: 'workflow'/g) || []).length >= 4, true);
  assert.equal(app.includes("'/api/v1/"), false);
  assert.equal(setup.includes('/api/v2/setup'), true);
  assert.equal(api.includes("credentials: request.credentials || 'same-origin'"), true);
});
