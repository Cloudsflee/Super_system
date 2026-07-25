import { spawnSync } from 'node:child_process';
import path from 'node:path';

const steps = [
  nodeStep('v2.0:plan', 'scripts/v20-plan.mjs'),
  nodeStep('v2.0:catalog', 'scripts/v20-catalog.mjs'),
  nodeStep('v2.0:coverage', 'scripts/v20-coverage.mjs'),
  nodeStep('v2.0:impact-audit', 'scripts/v20-impact.mjs', '--audit'),
  nodeStep('v1.75:plan', 'scripts/v175-plan.mjs'),
  nodeStep('v1.75:governance', 'tests/v175/governance.test.mjs'),
  nodeStep('v1.8:plan', 'scripts/v18-plan.mjs'),
  nodeStep('v1.8:impact-audit', 'scripts/v18-impact.mjs', '--audit'),
  nodeStep('v1.8:mcp-contract', 'scripts/v18-contract.mjs'),
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
