import { spawnSync } from 'node:child_process';

const commands = [
  ['check'], ['test'], ['test:integration'], ['test:security'], ['build'], ['test:e2e'], ['test:release']
];
for (const [script] of commands) {
  process.stdout.write(`\n== ${script} ==\n`);
  const result = spawnSync('corepack', ['pnpm', script], { cwd: process.cwd(), stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write('\nAIWS 3.0 verification passed\n');
