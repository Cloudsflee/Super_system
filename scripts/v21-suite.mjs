#!/usr/bin/env node
import { runCommand } from './v175-lib.mjs';

const suite = process.argv[2];
const suites = {
  unit: [
    ['node', 'tests/unit/v21-execution-protocol.test.mjs'],
    ['node', 'tests/unit/v21-outcome.test.mjs'],
    ['node', 'tests/unit/v21-stage-replay.test.mjs'],
    ['node', 'tests/unit/v21-context.test.mjs'],
    ['node', 'tests/unit/v21-migration.test.mjs']
  ],
  integration: [['node', 'tests/integration/v21-stage-replay-flow.test.mjs']],
  web: [['pnpm', '--filter', '@aiws/web', 'exec', 'vitest', 'run', 'src/test/v21-outcome-stages-context.test.tsx']],
  security: [['node', 'tests/unit/v21-security.test.mjs']],
  performance: [['node', 'tests/unit/v21-performance.test.mjs']],
  soak: [['node', 'tests/v21/soak.test.mjs']],
  browser: [['node', 'tests/e2e/v21-outcomes-browser.test.mjs']],
  quality: [
    ['node', 'scripts/format.mjs', '--check'],
    ['node', 'scripts/lint.mjs'],
    ['node', 'scripts/typecheck.mjs'],
    ['node', 'scripts/migrate-check.mjs']
  ],
  release: [['node', 'tests/release/v21-volume-flow.test.mjs']]
};
if (!suites[suite]) {
  console.error(
    'usage: node scripts/v21-suite.mjs <unit|integration|web|security|performance|soak|browser|quality|release>'
  );
  process.exit(2);
}
for (const command of suites[suite]) {
  console.log(`[v21:${suite}] ${command.join(' ')}`);
  const result = await runCommand(command, { timeout: 900_000, inherit: true });
  if (result.status !== 0 || result.timedOut) process.exit(result.status || 1);
}
console.log(`V2.1 ${suite} suite passed`);
