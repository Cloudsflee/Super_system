#!/usr/bin/env node
import { runCommand } from './v175-lib.mjs';

const suite = process.argv[2];
const suites = {
  unit: [
    ['node', '--disable-warning=ExperimentalWarning', 'tests/unit/v22-state-store.test.mjs'],
    ['node', 'tests/unit/v22-projector-index.test.mjs']
  ],
  integration: [['node', 'tests/unit/v22-health-shutdown.test.mjs']],
  security: [['node', 'tests/unit/v22-impact.test.mjs']],
  performance: [['node', '--disable-warning=ExperimentalWarning', 'tests/unit/v22-performance.test.mjs']],
  quality: [
    ['node', 'scripts/format.mjs', '--check'],
    ['node', 'scripts/lint.mjs'],
    ['node', 'scripts/typecheck.mjs'],
    ['node', 'scripts/migrate-check.mjs']
  ],
  release: [['node', '--disable-warning=ExperimentalWarning', 'tests/release/v22-volume-flow.test.mjs']]
};
if (!suites[suite]) {
  console.error('usage: node scripts/v22-suite.mjs <unit|integration|security|performance|quality|release>');
  process.exit(2);
}
for (const command of suites[suite]) {
  console.log(`[v22:${suite}] ${command.join(' ')}`);
  const result = await runCommand(command, { timeout: 900_000, inherit: true });
  if (result.status !== 0 || result.timedOut) process.exit(result.status || 1);
}
console.log(`V2.2 ${suite} suite passed`);
