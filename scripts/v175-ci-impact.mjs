import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const event =
  process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
const pull = event.pull_request,
  base = pull?.base?.sha || event.before || process.env.AIWS_TEST_BASE_SHA;
if (!base || /^0+$/.test(base)) throw new Error('CI impact base SHA is unavailable');

let decision = 'tests-updated',
  reason = 'Push gate executes the affected V1.75 assertions and deterministic suites.';
if (pull) {
  const body = String(pull.body || ''),
    decisionMatch = body.match(/^\s*V1\.75-Decision:\s*(\S+)\s*$/im),
    reasonMatch = body.match(/^\s*V1\.75-Reason:\s*(.+?)\s*$/im);
  if (!decisionMatch || !reasonMatch) throw new Error('PR body must include V1.75-Decision and V1.75-Reason');
  decision = decisionMatch?.[1] || '';
  reason = reasonMatch?.[1] || '';
  if (/choose-one|explain|填写|TODO/i.test(`${decision} ${reason}`))
    throw new Error('replace the V1.75 decision and reason placeholders in the PR body');
}
const result = spawnSync(
  process.execPath,
  ['scripts/v175-impact.mjs', '--base', base, '--decision', decision, '--reason', reason],
  { stdio: 'inherit', env: { ...process.env, AIWS_TEST_BASE_SHA: base } }
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
