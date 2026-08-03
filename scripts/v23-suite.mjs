#!/usr/bin/env node
import { runCommand } from './v175-lib.mjs';

const suite = process.argv[2];
const suites = {
  unit: [
    ['node', '--disable-warning=ExperimentalWarning', 'tests/unit/v23-quality-review.test.mjs'],
    ['node', '--disable-warning=ExperimentalWarning', 'tests/unit/v23-quality-review-state.test.mjs'],
    ['node', '--disable-warning=ExperimentalWarning', 'tests/unit/v23-quality-review-parser.test.mjs']
  ],
  integration: [
    ['node', '--disable-warning=ExperimentalWarning', 'tests/integration/v23-quality-review-flow.test.mjs'],
    ['node', '--disable-warning=ExperimentalWarning', 'tests/release/v23-volume-flow.test.mjs']
  ],
  security: [['node', '--disable-warning=ExperimentalWarning', 'tests/security/v23-quality-review-security.test.mjs']],
  performance: [
    ['node', '--disable-warning=ExperimentalWarning', 'tests/performance/v23-quality-review-performance.test.mjs']
  ],
  quality: [
    ['node', 'scripts/format.mjs', '--check'],
    ['node', 'scripts/lint.mjs'],
    ['node', 'scripts/typecheck.mjs'],
    ['node', 'scripts/migrate-check.mjs']
  ],
  release: [
    ['node', '--disable-warning=ExperimentalWarning', 'tests/release/v23-release-contract.test.mjs'],
    ['node', '--disable-warning=ExperimentalWarning', 'tests/release/v23-volume-flow.test.mjs']
  ]
};
if (!suites[suite]) {
  console.error('usage: node scripts/v23-suite.mjs <unit|integration|security|performance|quality|release>');
  process.exit(2);
}
for (const command of suites[suite]) {
  console.log(`[v23:${suite}] ${command.join(' ')}`);
  const result = await runCommand(command, { timeout: 900_000, inherit: true });
  if (result.status !== 0 || result.timedOut) process.exit(result.status || 1);
}
console.log(`V2.3 ${suite} suite passed`);
