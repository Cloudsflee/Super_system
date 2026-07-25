import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMeasurement,
  countPhysicalLines,
  evaluateFileLength,
  isDeclarationFile,
  shouldIgnorePath
} from '../../scripts/quality-policy.mjs';

test('file length thresholds use strict warning and blocking boundaries', () => {
  assert.equal(classifyMeasurement('file', 600), 'ok');
  assert.equal(classifyMeasurement('file', 601), 'warning');
  assert.equal(classifyMeasurement('file', 1000), 'warning');
  assert.equal(classifyMeasurement('file', 1001), 'blocking');
});

test('function length thresholds use strict warning and blocking boundaries', () => {
  assert.equal(classifyMeasurement('function', 100), 'ok');
  assert.equal(classifyMeasurement('function', 101), 'warning');
  assert.equal(classifyMeasurement('function', 200), 'warning');
  assert.equal(classifyMeasurement('function', 201), 'blocking');
});

test('complexity thresholds use strict warning and blocking boundaries', () => {
  assert.equal(classifyMeasurement('complexity', 15), 'ok');
  assert.equal(classifyMeasurement('complexity', 16), 'warning');
  assert.equal(classifyMeasurement('complexity', 40), 'warning');
  assert.equal(classifyMeasurement('complexity', 41), 'blocking');
});

test('declaration files are exempt from file and function length gates', () => {
  assert.equal(isDeclarationFile('packages/shared/index.d.ts'), true);
  assert.equal(isDeclarationFile('packages/shared/index.ts'), false);
  assert.equal(classifyMeasurement('file', 1001, { declaration: true }), 'ok');
  assert.equal(classifyMeasurement('function', 201, { declaration: true }), 'ok');
  assert.equal(evaluateFileLength('types/generated.d.ts', 'value\n'.repeat(1001)).level, 'ok');
});

test('physical line counting does not invent a line after the final newline', () => {
  assert.equal(countPhysicalLines(''), 0);
  assert.equal(countPhysicalLines('one'), 1);
  assert.equal(countPhysicalLines('one\n'), 1);
  assert.equal(countPhysicalLines('one\r\ntwo\r\n'), 2);
});

test('dependency, output, runtime, temporary and generated paths are ignored', () => {
  const activeWorkspaceDirectory = ['.ai', 'workspace'].join('-');
  for (const filePath of [
    'apps/web/node_modules/pkg/index.js',
    'apps/web/dist/index.js',
    'apps/web/build/index.js',
    'coverage/report.js',
    `${activeWorkspaceDirectory}/state.js`,
    `${activeWorkspaceDirectory}-test-integration/state.js`,
    'tests/.tmp-run/output.mjs',
    'temp/session/output.mjs',
    'packages/vendor/library.js',
    'apps/api/generated/client.ts',
    'apps/web/src/client.generated.ts',
    'apps/web/src/bundle.min.js'
  ]) {
    assert.equal(shouldIgnorePath(filePath), true, filePath);
  }
  assert.equal(shouldIgnorePath('tests/integration/workflow.test.mjs'), false);
});
