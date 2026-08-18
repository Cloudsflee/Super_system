import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const output = path.join(root, 'docs', 'evidence', 'v6-r6-assist-20260817', 'golden.json');
const screenshotDir = path.join(root, 'docs', 'evidence', 'v6-r6-assist-20260817', 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
const commands = [
  ['node', ['--test', 'tests/integration/assist-r6.test.mjs']],
  ['corepack', ['pnpm', '--filter', '@aiws/web', 'exec', 'vitest', 'run', 'src/test/assist.test.tsx']],
  ['node', ['scripts/e2e.mjs']]
];
const results = commands.map(([command, args]) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, R6_ASSIST_SCREENSHOT_DIR: screenshotDir } });
  return { command: [command, ...args].join(' '), exit_status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
});
const receipt = { schema_version: 'aiws.v3.r6_assist_golden.v1', status: results.every((item) => item.exit_status === 0) ? 'passed' : 'failed', created_at: new Date().toISOString(), viewports: ['1440x900', '1024x768', '390x844'], tests: results };
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status: receipt.status, output: path.relative(root, output), exit_statuses: results.map((item) => item.exit_status) }, null, 2));
if (receipt.status !== 'passed') process.exitCode = 1;
