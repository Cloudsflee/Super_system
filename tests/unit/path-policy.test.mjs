import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertReviewablePath, normalizeRelativePath, resolveWorkspacePath } from '../../apps/api/src/path-policy.mjs';

test('path policy keeps assets inside workspace and limits review formats', () => {
  assert.equal(normalizeRelativePath('src/index.ts'), 'src/index.ts');
  assert.equal(resolveWorkspacePath('/var/lib/aiws', 'projects/demo'), path.resolve('/var/lib/aiws', 'projects/demo'));
  assert.throws(() => normalizeRelativePath('../outside'), /escapes/);
  assert.throws(() => normalizeRelativePath('C:/outside'), /absolute/);
  assert.equal(assertReviewablePath('reports/result.json'), 'reports/result.json');
  assert.throws(() => assertReviewablePath('archive.zip'), /downloadable/);
});
