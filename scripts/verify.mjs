import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGitCommit } from './lib/git-blob.mjs';
import {
  executableInvocation,
  nodeInvocation,
  pnpmInvocation,
  gateBudget,
  gateRecordFailure,
  redactGateText,
  runGateCommand
} from './lib/gate-process.mjs';

export const VERIFY_RESULT_SCHEMA = 'aiws.v3-clean.verify-result.v3';
export const VERIFY_RECEIPT_SCHEMA = 'aiws.v3-clean.verify-receipt.v3';
export const LOCAL_RECEIPT_DIRECTORY = '.ai-workspace/gate-receipts';

export function formalInputFailure(argv, env = process.env) {
  if (argv.some(arg => !['--', '--pre-push', '--skip-p1-evidence'].includes(arg))) return 'verify_argument_invalid';
  if (argv.includes('--pre-push') && (argv.includes('--skip-p1-evidence') || env.AIWS_P1_EVIDENCE_GENERATING === '1')) return 'pre_push_evidence_skip_forbidden';
  return null;
}

process.env.AIWS_VERIFY_RUNNING = '1';

export function createFormalVerificationPlan({ skipP1Evidence = false } = {}) {
  const pnpm = (id, args, satisfies, options = {}) => ({
    id,
    invocation: pnpmInvocation(args),
    satisfies,
    timeoutMs: options.timeoutMs || 900_000,
    env: options.env || {},
    layered: Boolean(options.layered),
    parallel_group: options.parallelGroup || null,
    owner: options.owner || 'platform'
  });
  const node = (id, script, satisfies, options = {}) => ({
    id,
    invocation: nodeInvocation(script, options.args || []),
    satisfies,
    timeoutMs: options.timeoutMs || 1_800_000,
    env: options.env || {},
    layered: false,
    parallel_group: options.parallelGroup || null,
    owner: options.owner || 'platform'
  });
  return [
    pnpm('check', ['check'], ['pnpm check'], { env: { AIWS_CHECK_SKIP_WEB_TYPECHECK: '1', AIWS_CHECK_CHANGED_PATHS: '' } }),
    pnpm('audit-p1', ['audit:p1', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])], ['pnpm audit:p1']),
    pnpm('scan-clean', ['scan:clean', ...(skipP1Evidence ? ['--', '--skip-evidence'] : [])], ['pnpm scan:clean']),
    pnpm('audit-parity', ['audit:parity'], ['pnpm audit:parity']),
    pnpm('recovery-plan', ['recovery:plan'], ['pnpm recovery:plan']),
    pnpm('recovery-catalog', ['recovery:catalog'], ['pnpm recovery:catalog']),
    pnpm('recovery-coverage', ['recovery:coverage'], ['pnpm recovery:coverage']),
    pnpm('recovery-impact', ['recovery:impact', '--', '--audit'], ['pnpm recovery:impact -- --audit']),
    ...[1, 2, 3, 31, 4, 5, 6, 7, 8, 9, 10].map((phase) => {
      return pnpm(`test-p${phase}`, [`test:p${phase}`], [`pnpm test:p${phase}`], { owner: 'testing' });
    }),
    ...[5, 6, 7, 8, 9].map((phase) => pnpm(
      `evidence-p${phase}`,
      [`evidence:p${phase}`, '--', '--verify'],
      [`pnpm evidence:p${phase} -- --verify`],
      { owner: 'evidence' }
    )),
    node('p10-parser-probe', 'scripts/v3-clean-p10-parser-probe.mjs', ['node scripts/v3-clean-p10-parser-probe.mjs'], { owner: 'parser' }),
    node('p10-github-deletion-probe', 'scripts/v3-clean-p10-github-deletion-probe.mjs', ['node scripts/v3-clean-p10-github-deletion-probe.mjs'], { owner: 'repository' }),
    pnpm('integration', ['test:integration'], ['pnpm test:integration:clean', 'pnpm fixture:legacy:integration', 'pnpm test:integration'], { layered: true, owner: 'testing', parallelGroup: 'integration-security' }),
    pnpm('security', ['test:security'], ['pnpm test:security:clean', 'pnpm fixture:legacy:security', 'pnpm test:security'], { layered: true, owner: 'testing', parallelGroup: 'integration-security', env: { AIWS_SECURITY_DEFER_DOCKER: '1' } }),
    pnpm('web-test', ['--filter', '@aiws/web', 'test'], ['pnpm --filter @aiws/web test'], { owner: 'frontend', parallelGroup: 'local-validation' }),
    pnpm('unit-test', ['test'], ['pnpm test'], { env: { AIWS_TEST_UNIT_ONLY: '1' }, owner: 'testing', parallelGroup: 'local-validation' }),
    pnpm('build', ['build'], ['pnpm build', 'pnpm --filter @aiws/web typecheck'], { owner: 'frontend', parallelGroup: 'local-validation' }),
    pnpm('e2e', ['test:e2e'], ['pnpm test:e2e'], { timeoutMs: 1_800_000, owner: 'frontend' }),
    node('p10-release-probe', 'scripts/v3-clean-p10-release-probe.mjs', ['node scripts/v3-clean-p10-release-probe.mjs'], { timeoutMs: 1_800_000, owner: 'deployment' }),
    pnpm('release-test', ['test:release'], ['pnpm test:release'], { timeoutMs: 1_800_000, owner: 'deployment' }),
    pnpm('evidence-p10', ['evidence:p10', '--', '--verify'], ['pnpm evidence:p10 -- --verify'], { owner: 'evidence' }),
    {
      id: 'git-diff-check',
      invocation: executableInvocation('git', ['diff', '--check'], 'git'),
      satisfies: ['git diff --check'],
      timeoutMs: 120_000,
      env: {},
      layered: false,
      owner: 'platform'
    }
  ];
}

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const started = Date.now();
  const prePush = argv.includes('--pre-push');
  const prePushHead = prePush ? resolveGitCommit(root, 'HEAD') : null;
  delete process.env.AIWS_PRE_PUSH_HEAD;
  const skipP1Evidence = argv.includes('--skip-p1-evidence') || process.env.AIWS_P1_EVIDENCE_GENERATING === '1';
  const records = [];
  const advisoryFailures = [];
  let blockingFailure = formalInputFailure(argv);
  const plan = createFormalVerificationPlan({ skipP1Evidence });
  if (prePushHead) plan.find((entry) => entry.id === 'evidence-p10').env.AIWS_PRE_PUSH_HEAD = prePushHead;
  // Start the independent release probe once at process start so cold Docker
  // work overlaps deterministic gates; its receipt remains at plan position.
  const releaseSpec = plan.find((entry) => entry.id === 'p10-release-probe');
  let releasePromise = null;
  let releaseRecorded = false;
  for (let index = 0; !blockingFailure && index < plan.length;) {
    const budget = gateBudget('formal', Date.now() - started);
    if (budget.remaining_ms <= 0) { blockingFailure = 'formal_time_budget_exceeded'; break; }
    const specification = plan[index];
    if (specification.id === 'web-test' && !releasePromise && !blockingFailure && releaseSpec) {
      releasePromise = executeSpecification(releaseSpec, root, true, gateBudget('formal', Date.now() - started).remaining_ms);
    }
    const group = specification.parallel_group
      ? plan.slice(index).filter((entry) => entry.parallel_group === specification.parallel_group)
      : [specification];
    for (const entry of group) process.stdout.write(`\n== ${entry.id} ==\n`);
    const executed = specification.id === 'p10-release-probe' && releasePromise
      ? [await releasePromise]
      : specification.parallel_group
      ? await Promise.all(group.map((entry) => executeSpecification(entry, root, true, budget.remaining_ms)))
      : [await executeSpecification(specification, root, false, budget.remaining_ms)];
    for (const record of executed) {
      records.push(record);
      if (record.id === 'p10-release-probe') releaseRecorded = true;
      if (record.advisory) advisoryFailures.push(record.id);
      if (!record.ok || record.layered_status === 'failed') blockingFailure ||= record.id;
    }
    index += group.length;
    if (blockingFailure) break;
  }
  if (releasePromise && !releaseRecorded) {
    const record = await releasePromise;
    records.push(record);
    if (record.advisory) advisoryFailures.push(record.id);
    if (!record.ok || record.layered_status === 'failed') blockingFailure ||= record.id;
  }

  const budget = gateBudget('formal', Date.now() - started);
  if (budget.exceeded) blockingFailure ||= 'formal_time_budget_exceeded';

  const status = blockingFailure ? 'failed' : advisoryFailures.length ? 'advisory' : 'passed';
  const receipt = {
    schema_version: VERIFY_RECEIPT_SCHEMA,
    status,
    blocking_command: blockingFailure,
    advisory_failures: advisoryFailures,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    budget,
    policy: {
      publication_check: prePush ? 'pending-push-local-head' : 'pushed-upstream-head',
      current_phase: 'P10',
      prior_phase_validation: 'immutable-evidence-only',
      current_probe_failure_blocks: true,
      historical_failure_advisory: true,
      successful_receipt: 'stdout-only',
      p10_catalog_status: '27/0/27'
    },
    commands: records
  };
  const receiptPath = status === 'passed' ? null : writeLocalReceipt(root, receipt);
  const result = {
    schema_version: VERIFY_RESULT_SCHEMA,
    status,
    blocking_command: blockingFailure,
    advisory_failures: advisoryFailures,
    duration_ms: receipt.duration_ms,
    budget,
    commands: records.map(publicRecord),
    receipt: receiptPath
  };
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
  return blockingFailure ? 1 : 0;
}

async function executeSpecification(specification, root, parallel, remainingMs) {
  const result = await runGateCommand(specification.invocation, {
    cwd: root,
    workspaceRoot: root,
    cwdRole: 'repository-root',
    timeoutMs: Math.min(specification.timeoutMs, remainingMs),
    maxCaptureBytes: 16 * 1024 * 1024,
    env: { AIWS_VERIFY_RUNNING: '1', ...specification.env },
    ...(parallel ? { stdoutPrefix: `[${specification.id}] `, stderrPrefix: `[${specification.id}] ` } : {})
  });
  const layered = specification.layered ? layeredResult(result.output.stdout) : null;
  const policyFailure = gateRecordFailure(result);
  if (policyFailure) { result.ok = false; result.error_code = policyFailure; }
  if (specification.layered && result.ok && !layered) {
    result.ok = false;
    result.error_code = 'gate_command_failed';
    result.exit_status = 1;
    result.output.stderr = `${result.output.stderr}\nlayered_gate_result_missing`.trim();
  }
  const advisory = result.ok && layered?.status === 'advisory';
  return {
    id: specification.id,
    owner: specification.owner,
    satisfies: specification.satisfies,
    ...result,
    ...(layered ? { layered_status: layered.status, layered_receipt: layered.receipt } : {}),
    advisory
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    owner: record.owner,
    satisfies: record.satisfies,
    command: record.command,
    args: record.args,
    exit_status: record.exit_status,
    signal: record.signal,
    duration_ms: record.duration_ms,
    error_code: record.error_code,
    ok: record.ok,
    advisory: record.advisory,
    ...(record.layered_status ? { layered_status: record.layered_status } : {}),
    summary: summarize(record.output.stdout, record.output.stderr),
    redaction: record.redaction
  };
}

function layeredResult(stdout) {
  const text = String(stdout || '').trim();
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) {
    try {
      const candidate = JSON.parse(text.slice(index));
      if (candidate?.schema_version === 'aiws.v3-clean.layered-gate-result.v2') return candidate;
    } catch { /* package manager prelude or nested JSON */ }
  }
  return null;
}

function writeLocalReceipt(root, receipt) {
  const directory = path.join(root, LOCAL_RECEIPT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = `verify-${Date.now()}-${process.pid}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filename = `${prefix}${attempt ? `-${attempt}` : ''}.json`;
    const target = path.join(directory, filename);
    const relative = path.relative(root, target).replaceAll('\\', '/');
    const payload = `${JSON.stringify({ ...receipt, receipt: relative }, null, 2)}\n`;
    try {
      fs.writeFileSync(target, payload, { flag: 'wx', mode: 0o600 });
      return relative;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('verify_receipt_name_exhausted');
}

function summarize(stdout, stderr) {
  return redactGateText(`${stdout || ''}\n${stderr || ''}`)
    .value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-10).join('\n').slice(0, 4000);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) {
  const exitCode = await main();
  if (exitCode) process.exitCode = exitCode;
}
