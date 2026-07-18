import fs from 'node:fs';
import path from 'node:path';
import { limitedLog, runCommand, utcRunId, writeFileEnsured } from './v175-lib.mjs';

const suite = process.argv[2];
const suites = {
  pr: [
    ['node', 'scripts/v18-plan.mjs'], ['node', 'scripts/v18-impact.mjs', '--audit'], ['node', 'scripts/v18-contract.mjs'],
    ['node', 'tests/e2e/v18-mcp-journey.test.mjs']
  ],
  full: [
    ['node', 'scripts/v18-plan.mjs'], ['node', 'scripts/v18-impact.mjs', '--audit'], ['node', 'scripts/v18-contract.mjs'],
    ['node', 'tests/v18/parity.test.mjs'], ['node', 'tests/integration/v18-mcp-terminal-flow.test.mjs'],
    ['node', 'tests/v18/fault.test.mjs'], ['node', 'tests/e2e/v18-mcp-journey.test.mjs'], ['node', 'tests/v18/compatibility.test.mjs'],
    ['pnpm', 'test'], ['pnpm', 'test:integration'], ['pnpm', 'build'], ['pnpm', 'test:e2e']
  ],
  live: [['node', 'tests/integration/v18-codex-mcp-live.test.mjs'], ['node', 'tests/integration/v18-github-mcp-live.test.mjs']],
  release: [
    ['node', 'scripts/v18-plan.mjs'], ['node', 'scripts/v18-contract.mjs'], ['node', 'tests/e2e/v18-mcp-journey.test.mjs'],
    ['node', 'tests/unit/v18-release.test.mjs'], ['node', 'tests/release/v18-volume-flow.test.mjs'], ['node', 'tests/v18/compatibility.test.mjs']
  ],
  soak: [['node', 'tests/v18/soak.test.mjs', '--minutes', '120']]
};
if (!suites[suite]) { console.error('usage: node scripts/v18-runner.mjs <pr|full|live|release|soak>'); process.exit(2); }

const budgets = { pr: 900_000, full: 5_400_000, live: 5_400_000, release: 5_400_000, soak: 7_200_000 };
const runId = utcRunId(`${suite}-`), directory = path.join(process.cwd(), '.ai-workspace', 'test-reports', 'v1.8', runId), results = [], started = Date.now();
let failed = false;
for (const command of suites[suite]) {
  const remaining = Math.max(1000, budgets[suite] - (Date.now() - started));
  const result = await runCommand(command, { timeout: remaining, inherit: true, env: { AIWS_TEST_REPORT_DIR: directory, AIWS_V18_RUN_ID: runId } });
  const status = result.status === 0 ? 'PASS' : result.status === 2 && suite === 'live' ? 'BLOCKED' : result.timedOut ? 'FAIL' : 'FAIL';
  results.push({ command: command.join(' '), status, duration_ms: result.durationMs, output: limitedLog(`${result.stdout}\n${result.stderr}`) });
  if (status !== 'PASS') { failed = true; break; }
}
const elapsed = Date.now() - started, report = [
  '# AIWS 测试结果 V1.8', '', `- Run ID：\`${runId}\``, `- Suite：\`${suite}\``, `- 产品版本：\`1.8.0\``, '- state schema：`17`',
  `- 结果：\`${failed ? 'FAIL' : 'PASS'}\``, `- 耗时：${elapsed} ms`, `- 预算：${budgets[suite]} ms`, '- 清理：runner 子进程已关闭；专项测试负责资源清理。', '',
  '| 命令 | 状态 | 耗时 |', '|---|---|---:|', ...results.map((item) => `| \`${item.command}\` | ${item.status} | ${item.duration_ms} ms |`), '',
  ...results.filter((item) => item.status !== 'PASS').flatMap((item) => ['## 失败证据', '', '```text', item.output, '```', '']), `生成时间：${new Date().toISOString()}`, ''
].join('\n');
writeFileEnsured(path.join(directory, '测试结果v1.8.md'), report);
writeFileEnsured(path.join(directory, 'results.json'), `${JSON.stringify({ run_id: runId, suite, status: failed ? 'FAIL' : 'PASS', elapsed_ms: elapsed, results: results.map(({ output, ...item }) => item) }, null, 2)}\n`);
console.log(`V1.8 ${suite} report: ${path.relative(process.cwd(), directory)}`);
if (failed || elapsed > budgets[suite]) process.exit(1);
