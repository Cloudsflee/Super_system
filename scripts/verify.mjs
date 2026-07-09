import { spawnSync } from 'node:child_process';

const steps = [
  ['lint', ['scripts/lint.mjs']],
  ['typecheck', ['scripts/typecheck.mjs']],
  ['unit:shared', ['tests/unit/shared.test.mjs']],
  ['unit:packages', ['tests/unit/packages.test.mjs']],
  ['integration:api', ['tests/integration/api-flow.test.mjs']],
  ['integration:git', ['tests/integration/git-flow.test.mjs']],
  ['integration:tools', ['tests/integration/tools-flow.test.mjs']],
  ['integration:github', ['tests/integration/github-flow.test.mjs']],
  ['integration:demo', ['tests/integration/demo-flow.test.mjs']],
  ['prisma:migrate:check', ['scripts/migrate-check.mjs']],
  ['e2e:smoke', ['tests/e2e/smoke.test.mjs']],
  ['acceptance:audit', ['scripts/acceptance-audit.mjs']]
];

for (const [name, args] of steps) {
  console.log(`\n[verify] ${name}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nverify passed');
