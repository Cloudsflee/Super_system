import { spawnSync } from 'node:child_process';

const skipP1Evidence = process.argv.includes('--skip-p1-evidence')
  || process.env.AIWS_P1_EVIDENCE_GENERATING === '1';
const commands = [
  ['check'],
  ['audit:p1', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['scan:clean', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['test:p1'], ['test:p2'], ['test:p3'], ['test:p31'], ['test'],
  ['test:integration'], ['test:security'], ['build'], ['test:e2e'], ['git diff --check']
];
for (const [script, ...args] of commands) {
  process.stdout.write(`\n== ${script} ==\n`);
  const command = script === 'git diff --check'
    ? ['git', 'diff', '--check']
    : ['corepack', 'pnpm', script, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write('\nAIWS 3.0 verification passed\n');
