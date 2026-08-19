import { spawnSync } from 'node:child_process';

const skipP1Evidence = process.argv.includes('--skip-p1-evidence')
  || process.env.AIWS_P1_EVIDENCE_GENERATING === '1';
const commands = [
  ['check'],
  ['audit:p1', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['scan:clean', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['test:p1'], ['test'], ['test:integration'], ['test:security'], ['build'], ['test:e2e'], ['test:release']
];
for (const [script, ...args] of commands) {
  process.stdout.write(`\n== ${script} ==\n`);
  const result = spawnSync('corepack', ['pnpm', script, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write('\nAIWS 3.0 verification passed\n');
