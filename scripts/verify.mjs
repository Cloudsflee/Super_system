import { spawnSync } from 'node:child_process';

const skipP1Evidence = process.argv.includes('--skip-p1-evidence')
  || process.env.AIWS_P1_EVIDENCE_GENERATING === '1';
const commands = [
  ['check'],
  ['audit:p1', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['scan:clean', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])],
  ['test:p1'], ['test:p2'], ['test:p3'], ['test:p31'], ['test:p4'], ['test:p5'], ['test:p6'], ['test:p7'], ['test:p8'],
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
  ['test'], ['test:integration'], ['test:security'], ['test:release'], ['build'], ['test:e2e'],
  ['evidence:p5', '--', '--verify'], ['evidence:p6', '--', '--verify'], ['evidence:p7', '--', '--verify'], ['evidence:p8', '--', '--verify'],
  ['git diff --check']
];
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
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write('\nAIWS 3.0 verification passed\n');
