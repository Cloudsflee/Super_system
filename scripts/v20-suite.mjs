#!/usr/bin/env node
import { runCommand } from './v175-lib.mjs';

const suite = process.argv[2];
const suites = {
  unit: [
    ['node', 'tests/unit/v20-system-context.test.mjs'],
    ['node', 'tests/unit/v20-context-pack.test.mjs'],
    ['node', 'tests/unit/v20-mcp-context.test.mjs'],
    ['node', 'tests/unit/v20-migration.test.mjs']
  ],
  integration: [['node', 'tests/integration/v20-context-flow.test.mjs']],
  web: [['pnpm', '--filter', '@aiws/web', 'exec', 'vitest', 'run', 'src/test/context-map-v20.test.tsx']],
  performance: [['node', 'tests/unit/v20-context-performance.test.mjs']],
  quality: [
    ['node', 'scripts/format.mjs', '--check'],
    ['node', 'scripts/lint.mjs'],
    ['node', 'scripts/typecheck.mjs'],
    ['node', 'scripts/migrate-check.mjs']
  ],
  release: [['node', 'tests/release/v20-volume-flow.test.mjs']]
};
if (!suites[suite]) {
  console.error('usage: node scripts/v20-suite.mjs <unit|integration|web|performance|quality|release>');
  process.exit(2);
}
for (const command of suites[suite]) {
  console.log(`[v20:${suite}] ${command.join(' ')}`);
  const result = await runCommand(command, { timeout: 600_000, inherit: true });
  if (result.status !== 0 || result.timedOut) process.exit(result.status || 1);
}
console.log(`V2.0 ${suite} suite passed`);
