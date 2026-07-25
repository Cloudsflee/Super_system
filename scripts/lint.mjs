import { spawnSync } from 'node:child_process';

const steps = [
  ['format', 'scripts/format.mjs', '--check'],
  ['quality', 'scripts/quality-gate.mjs'],
  ['ui-quality', 'scripts/ui-quality-gate.mjs']
];

for (const [name, ...args] of steps) {
  console.log(`[lint] ${name}`);
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('[lint] passed');
