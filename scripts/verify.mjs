import { spawnSync } from 'node:child_process';
import path from 'node:path';

const steps = [
  nodeStep('v2.3:plan', 'scripts/v23-plan.mjs'),
  nodeStep('v2.3:catalog', 'scripts/v23-catalog.mjs'),
  nodeStep('v2.3:coverage', 'scripts/v23-coverage.mjs'),
  nodeStep('v2.3:impact-audit', 'scripts/v23-impact.mjs', '--audit'),
  nodeStep('v2.3:full', 'scripts/v23-runner.mjs', 'full'),
  nodeStep('v2.2:plan', 'scripts/v22-plan.mjs'),
  nodeStep('v2.2:catalog', 'scripts/v22-catalog.mjs'),
  nodeStep('v2.2:coverage', 'scripts/v22-coverage.mjs'),
  nodeStep('v2.2:impact-audit', 'scripts/v22-impact.mjs', '--audit'),
  nodeStep('v2.2:full', 'scripts/v22-runner.mjs', 'full'),
  nodeStep('v2.1:plan', 'scripts/v21-plan.mjs'),
  nodeStep('v2.1:catalog', 'scripts/v21-catalog.mjs'),
  nodeStep('v2.1:coverage', 'scripts/v21-coverage.mjs'),
  nodeStep('v2.1:impact-audit', 'scripts/v21-impact.mjs', '--audit'),
  nodeStep('v2.1:full', 'scripts/v21-runner.mjs', 'full'),
  nodeStep('v2.0:plan', 'scripts/v20-plan.mjs'),
  nodeStep('v2.0:catalog', 'scripts/v20-catalog.mjs'),
  nodeStep('v2.0:coverage', 'scripts/v20-coverage.mjs'),
  nodeStep('v2.0:impact-audit', 'scripts/v20-impact.mjs', '--audit'),
  nodeStep('v1.75:plan', 'scripts/v175-plan.mjs'),
  nodeStep('v1.75:governance', 'tests/v175/governance.test.mjs'),
  nodeStep('v1.8:plan', 'scripts/v18-plan.mjs'),
  nodeStep('v1.8:impact-audit', 'scripts/v18-impact.mjs', '--audit'),
  nodeStep('v1.8:mcp-contract', 'scripts/v18-contract.mjs'),
  nodeStep('format:check', 'scripts/format.mjs', '--check'),
  nodeStep('lint', 'scripts/lint.mjs'),
  nodeStep('typecheck', 'scripts/typecheck.mjs'),
  pnpmStep('test', 'test'),
  pnpmStep('test:integration', 'test:integration'),
  pnpmStep('test:release', 'test:release'),
  nodeStep('prisma:migrate:check', 'scripts/migrate-check.mjs'),
  nodeStep('build:web', 'scripts/build-web.mjs'),
  nodeStep('e2e:smoke', 'tests/e2e/smoke.test.mjs'),
  nodeStep('e2e:playwright', 'tests/e2e/playwright.test.mjs'),
  nodeStep('acceptance:audit', 'scripts/acceptance-audit.mjs')
];

for (const { name, command, args } of steps) {
  console.log(`\n[verify] ${name}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nverify passed');

function nodeStep(name, ...args) {
  return { name, command: process.execPath, args };
}

function pnpmStep(name, script) {
  if (process.platform !== 'win32') return { name, command: 'corepack', args: ['pnpm', script] };
  const pnpm = path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  return { name, command: process.execPath, args: [pnpm, script] };
}
