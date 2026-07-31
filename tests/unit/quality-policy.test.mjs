import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABSOLUTE_FILE_LIMIT,
  QUALITY_PROFILES,
  classifyMeasurement,
  countPhysicalLines,
  evaluateFileLength,
  isDeclarationFile,
  qualityProfileForPath,
  shouldIgnorePath
} from '../../scripts/quality-policy.mjs';
import {
  QUALITY_BASELINE_SCHEMA,
  buildQualityBaseline,
  compareQualityBaselines,
  qualityBaselinesEqual,
  validateQualityBaseline
} from '../../scripts/quality-baseline.mjs';

test('production thresholds use the stricter code-health target', () => {
  assert.deepEqual(QUALITY_PROFILES.production.file, { warning: 400, blocking: 800 });
  assert.deepEqual(QUALITY_PROFILES.production.function, { warning: 80, blocking: 150 });
  assert.deepEqual(QUALITY_PROFILES.production.complexity, { warning: 15, blocking: 30 });
  assert.equal(classifyMeasurement('file', 400), 'ok');
  assert.equal(classifyMeasurement('file', 401), 'warning');
  assert.equal(classifyMeasurement('file', 801), 'blocking');
  assert.equal(classifyMeasurement('function', 81), 'warning');
  assert.equal(classifyMeasurement('function', 151), 'blocking');
  assert.equal(classifyMeasurement('complexity', 16), 'warning');
  assert.equal(classifyMeasurement('complexity', 31), 'blocking');
});

test('path profiles separate production, tests, migrations, tooling, static maps and stylesheets', () => {
  const paths = {
    'apps/api/src/context-service.mjs': 'production',
    'packages/shared/src/domain.mjs': 'production',
    'bridge/main.go': 'production',
    'tests/unit/domain.test.mjs': 'test',
    'apps/web/src/test/ui.test.tsx': 'test',
    'apps/api/src/state-migration-v22.mjs': 'migration',
    'docker/release_volume.mjs': 'migration',
    'scripts/verify.mjs': 'tooling',
    'apps/web/src/api/types.ts': 'static',
    'apps/web/src/styles/workspace.css': 'stylesheet'
  };
  for (const [filePath, expected] of Object.entries(paths)) {
    assert.equal(qualityProfileForPath(filePath), expected, filePath);
  }
});

test('test and migration profiles are wider without bypassing the absolute file redline', () => {
  assert.equal(classifyMeasurement('file', 800, { filePath: 'tests/unit/large.test.mjs' }), 'ok');
  assert.equal(classifyMeasurement('file', 801, { filePath: 'tests/unit/large.test.mjs' }), 'warning');
  assert.equal(classifyMeasurement('function', 121, { filePath: 'apps/api/src/state-migration-v22.mjs' }), 'warning');
  assert.equal(classifyMeasurement('file', ABSOLUTE_FILE_LIMIT + 1, { filePath: 'tests/fixture.mjs' }), 'blocking');
  assert.equal(
    classifyMeasurement('file', ABSOLUTE_FILE_LIMIT + 1, { filePath: 'apps/web/src/styles/large.css' }),
    'blocking'
  );
});

test('declaration files are exempt from file and function length gates', () => {
  assert.equal(isDeclarationFile('packages/shared/index.d.ts'), true);
  assert.equal(isDeclarationFile('packages/shared/index.ts'), false);
  assert.equal(classifyMeasurement('file', 1001, { declaration: true }), 'ok');
  assert.equal(classifyMeasurement('function', 251, { declaration: true }), 'ok');
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

test('quality baseline is deterministic and aggregates measurements by file and rule', () => {
  const findings = [
    finding('b.mjs', 'complexity', 18),
    finding('a.mjs', 'max-lines-per-function', 90),
    finding('a.mjs', 'max-lines-per-function', 120)
  ];
  const baseline = buildQualityBaseline(findings.reverse());
  assert.equal(baseline.schema_version, QUALITY_BASELINE_SCHEMA);
  assert.deepEqual(
    baseline.entries.map((entry) => entry.path),
    ['a.mjs', 'b.mjs']
  );
  assert.deepEqual(baseline.entries[0].metrics['max-lines-per-function'], [120, 90]);
  assert.equal(qualityBaselinesEqual(baseline, buildQualityBaseline(findings.reverse())), true);
  assert.equal(validateQualityBaseline(baseline), baseline);
});

test('quality baseline comparison rejects new and worsened debt while allowing reductions', () => {
  const previous = buildQualityBaseline([
      finding('service.mjs', 'complexity', 20),
      finding('service.mjs', 'complexity', 17),
      finding('service.mjs', 'max-lines', 500)
    ]),
    improved = buildQualityBaseline([
      finding('service.mjs', 'complexity', 19),
      finding('service.mjs', 'max-lines', 450)
    ]),
    worsened = buildQualityBaseline([
      finding('service.mjs', 'complexity', 21),
      finding('service.mjs', 'complexity', 17),
      finding('service.mjs', 'complexity', 16),
      finding('service.mjs', 'max-lines', 501)
    ]);
  assert.deepEqual(compareQualityBaselines(improved, previous), []);
  assert.deepEqual(
    compareQualityBaselines(worsened, previous).map((item) => item.reason),
    ['worsened', 'new', 'worsened']
  );
});

function finding(filePath, ruleId, value) {
  return { filePath, ruleId, value, profile: 'production' };
}
