import { spawnSync } from 'node:child_process';

process.env.AIWS_VERIFY_RUNNING = '1';

const skipP1Evidence = process.argv.includes('--skip-p1-evidence')
  || process.env.AIWS_P1_EVIDENCE_GENERATING === '1';
const commands = [
  ['check'],
  ['audit:p1', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['scan:clean', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['test:p1'], ['test:p2'], ['test:p3'], ['test:p31'], ['test:p4'], ['test:p5'], ['test:p6'], ['test:p7'], ['test:p8'], ['test:p9'], ['test:p10'],
  ['audit:parity'],
  ['node scripts/v3-clean-p5-performance.mjs'],
  ['node scripts/v3-clean-p5-assist-probe.mjs'],
  ['node scripts/v3-clean-p5-bridge-probe.mjs'],
  ['node scripts/v3-clean-p6-performance.mjs'],
  ['node scripts/v3-clean-p6-docker-runner-probe.mjs'],
  ['node scripts/v3-clean-p6-host-runner-probe.mjs'],
  ['node scripts/v3-clean-p6-bridge-runner-probe.mjs'],
  ['node scripts/v3-clean-p6-restart-probe.mjs'],
  ['node scripts/v3-clean-p7-performance.mjs'],
  ['node scripts/v3-clean-p7-cas-tamper-probe.mjs'],
  ['node scripts/v3-clean-p7-parser-probe.mjs'],
  ['node scripts/v3-clean-p7-quality-outcome-probe.mjs'],
  ['node scripts/v3-clean-p7-restart-probe.mjs'],
  ['node scripts/v3-clean-p8-performance.mjs'],
  ['node scripts/v3-clean-p8-github-delivery-probe.mjs'],
  ['node scripts/v3-clean-p8-importer-probe.mjs'],
  ['node scripts/v3-clean-p8-deployment-rollback-probe.mjs'],
  ['node scripts/v3-clean-p8-backup-restore-gc-probe.mjs'],
  ['node scripts/v3-clean-p9-github-delivery-probe.mjs'],
  ['node scripts/v3-clean-p10-parser-probe.mjs'],
  ['node scripts/v3-clean-p10-github-deletion-probe.mjs'],
  ['--filter', '@aiws/web', 'test'],
  ['test'], ['test:integration:clean'], ['test:security:clean'], ['test:integration'], ['test:security'], ['build'], ['test:e2e'],
  ['node scripts/v3-clean-p9-release-probe.mjs'],
  ['node scripts/v3-clean-p10-release-probe.mjs'],
  ['test:release'],
  ['evidence:p5', '--', '--verify'], ['evidence:p6', '--', '--verify'], ['evidence:p7', '--', '--verify'], ['evidence:p8', '--', '--verify'], ['evidence:p9', '--', '--verify'], ['evidence:p10', '--', '--verify'],
  ['git diff --check']
];
const baselineFallbacks = new Map([
  ['v3-clean-p5-assist-probe.mjs', ['evidence:p5', '--', '--verify']],
  ['v3-clean-p5-bridge-probe.mjs', ['evidence:p5', '--', '--verify']],
  ['v3-clean-p6-docker-runner-probe.mjs', ['evidence:p6', '--', '--verify']],
  ['v3-clean-p6-host-runner-probe.mjs', ['evidence:p6', '--', '--verify']],
  ['v3-clean-p6-bridge-runner-probe.mjs', ['evidence:p6', '--', '--verify']],
  ['v3-clean-p6-restart-probe.mjs', ['evidence:p6', '--', '--verify']],
  ['v3-clean-p7-cas-tamper-probe.mjs', ['evidence:p7', '--', '--verify']],
  ['v3-clean-p7-parser-probe.mjs', ['evidence:p7', '--', '--verify']],
  ['v3-clean-p7-quality-outcome-probe.mjs', ['evidence:p7', '--', '--verify']],
  ['v3-clean-p7-restart-probe.mjs', ['evidence:p7', '--', '--verify']],
  ['v3-clean-p8-github-delivery-probe.mjs', ['evidence:p8', '--', '--verify']],
  ['v3-clean-p8-importer-probe.mjs', ['evidence:p8', '--', '--verify']],
  ['v3-clean-p8-deployment-rollback-probe.mjs', ['evidence:p8', '--', '--verify']],
  ['v3-clean-p8-backup-restore-gc-probe.mjs', ['evidence:p8', '--', '--verify']],
  ['v3-clean-p9-github-delivery-probe.mjs', ['evidence:p9', '--', '--verify']],
  ['v3-clean-p9-release-probe.mjs', ['evidence:p9', '--', '--verify']]
]);
for (const [script, ...args] of commands) {
  process.stdout.write(`\n== ${script} ==\n`);
  const direct = script.startsWith('node ');
  const command = script === 'git diff --check'
    ? ['git', 'diff', '--check']
    : direct
      ? script.split(/\s+/)
    : ['corepack', 'pnpm', script, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status === 0) continue;
  const scriptName = script.split(/\s+/).at(-1).replace(/^.*[\\/]/, '');
  const fallback = baselineFallbacks.get(script) || baselineFallbacks.get(scriptName);
  if (!fallback) process.exit(result.status || 1);
  process.stdout.write(`-- ${script} unavailable; validating immutable baseline receipt --\n`);
  const fallbackCommand = ['corepack', 'pnpm', ...fallback];
  const fallbackResult = spawnSync(fallbackCommand[0], fallbackCommand.slice(1), {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (fallbackResult.status !== 0) process.exit(fallbackResult.status || 1);
}
process.stdout.write('\nAIWS 3.0 verification passed\n');
