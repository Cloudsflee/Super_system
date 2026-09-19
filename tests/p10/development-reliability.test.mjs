import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import {
  GATE_ERROR_CODES,
  pnpmInvocation,
  runGateCommand
} from '../../scripts/lib/gate-process.mjs';
import { gateBudget, gateRecordFailure, GATE_BUDGETS_MS } from '../../scripts/lib/gate-process.mjs';
import { formalInputFailure } from '../../scripts/verify.mjs';
import {
  classifyFailure,
  generateDevelopmentReceipt,
  parseArguments as parseReceiptArguments,
  validateReceiptHash
} from '../../scripts/development-receipt.mjs';
import { selectDevCommands } from '../../scripts/verify-dev.mjs';
import { main as devMain, repositoryState } from '../../scripts/verify-dev.mjs';
import { parseArguments as parseDevArguments } from '../../scripts/verify-dev.mjs';
import { createFormalVerificationPlan } from '../../scripts/verify.mjs';
import { commandFor } from '../../scripts/layered-gate.mjs';
import { open as openP10 } from './helpers.mjs';
import { prepare, waitOperation } from '../p6/helpers.mjs';

const root = process.cwd();

test('hard gate limits are fixed and over-budget success is rejected', () => {
  assert.deepEqual(GATE_BUDGETS_MS, { development: 120000, formal: 360000 });
  for (const channel of ['development', 'formal']) {
    const limit = GATE_BUDGETS_MS[channel];
    assert.equal(gateBudget(channel, limit).exceeded, false);
    assert.equal(gateBudget(channel, limit + 1).exceeded, true);
    assert.equal(gateBudget(channel, limit + 1).remaining_ms, 0);
  }
  assert.throws(() => gateBudget('formal', NaN), /gate_budget_invalid/);
  assert.throws(() => gateBudget('formal', -1), /gate_budget_invalid/);
  assert.throws(() => gateBudget('override', 1), /gate_budget_invalid/);
});

test('a self-reported ok flag never masks nonzero exit, signal, truncation or redaction failure', () => {
  const valid = { ok: true, exit_status: 0, signal: null, error_code: null, duration_ms: 1,
    output: { stdout: '', stderr: '' }, capture: { stdout_truncated: false, stderr_truncated: false }, redaction: { passed: true } };
  assert.equal(gateRecordFailure(valid), null);
  assert.equal(gateRecordFailure({ ...valid, exit_status: 7 }), 'gate_command_failed');
  assert.equal(gateRecordFailure({ ...valid, signal: 'SIGTERM' }), 'gate_command_failed');
  assert.equal(gateRecordFailure({ ...valid, capture: { stdout_truncated: true, stderr_truncated: false } }), 'gate_output_truncated');
  assert.equal(gateRecordFailure({ ...valid, capture: null }), 'gate_record_incomplete');
  assert.equal(gateRecordFailure({ ...valid, duration_ms: undefined }), 'gate_record_incomplete');
  assert.equal(gateRecordFailure({ ...valid, redaction: { passed: false } }), 'gate_redaction_failed');
  assert.equal(gateRecordFailure({ ...valid, redaction: null }), 'gate_redaction_failed');
});

test('real process output truncation fails while retaining the literal zero process exit', async () => {
  const record = await runGateCommand({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(4096))"] },
    { cwd: root, stdout: false, stderr: false, maxCaptureBytes: 128, timeoutMs: 5000 });
  assert.equal(record.exit_status, 0);
  assert.equal(record.capture.stdout_truncated, true);
  assert.equal(record.ok, false);
  assert.equal(record.error_code, 'gate_output_truncated');
});

test('pre-push verification rejects evidence-skip inputs and unknown bypass arguments', () => {
  assert.equal(formalInputFailure(['--pre-push'], {}), null);
  assert.equal(formalInputFailure(['--pre-push', '--skip-p1-evidence'], {}), 'pre_push_evidence_skip_forbidden');
  assert.equal(formalInputFailure(['--pre-push'], { AIWS_P1_EVIDENCE_GENERATING: '1' }), 'pre_push_evidence_skip_forbidden');
  assert.equal(formalInputFailure(['--no-verify'], {}), 'verify_argument_invalid');
});

test('development orchestration freezes successful commands after the fixed time limit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-budget-regression-'));
  let now = 1000, calls = 0, output = '';
  t.mock.method(Date, 'now', () => now);
  t.mock.method(process.stdout, 'write', chunk => { output += String(chunk); return true; });
  try {
    const result = await devMain([], directory, {
      repositoryState: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), base_source: 'fixture', changed_paths: [] }),
      loadCatalog: () => ({ features: [] }),
      runGateCommand: async (invocation, options) => {
        calls++; assert.equal(options.timeoutMs, 120000); now += 120001;
        return { command: '<NODE>', args: [], ok: true, exit_status: 0, error_code: null, duration_ms: 120001,
          capture: { stdout_truncated: false, stderr_truncated: false },
          output: { stdout: '', stderr: '' }, redaction: { passed: true } };
      }
    });
    assert.equal(result, 1);
    assert.equal(calls, 1);
    assert.match(output, /development_time_budget_exceeded/);
    const receipts = fs.readdirSync(path.join(directory, '.ai-workspace/gate-receipts'));
    assert.equal(receipts.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Gate process preserves Windows-sensitive arguments without shell parsing', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws 参数 space '));
  try {
    const expected = ['space value', '中文路径', '&', '|', '<', '>', '^', '%', '!', '(', ')'];
    const result = await runGateCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...expected],
      command_role: 'node'
    }, { cwd, workspaceRoot: cwd, stdout: false, stderr: false, timeoutMs: 5_000 });
    assert.equal(result.ok, true, result.output.stderr);
    assert.deepEqual(JSON.parse(result.output.stdout), expected);
    assert.equal(result.command, '<NODE>');
    assert.equal(result.error_code, null);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('Gate process exposes bounded redacted capture and stable failure codes', async () => {
  const failed = await runGateCommand({
    command: process.execPath,
    args: ['-e', "process.stdout.write('Bearer process-fixture-token path=' + process.cwd()); process.exit(7)"],
    command_role: 'node'
  }, { cwd: root, workspaceRoot: root, stdout: false, stderr: false, timeoutMs: 5_000, maxCaptureBytes: 256 });
  assert.equal(failed.exit_status, 7);
  assert.equal(failed.error_code, GATE_ERROR_CODES.failed);
  assert.equal(failed.output.stdout.includes('process-fixture-token'), false);
  assert.match(failed.output.stdout, /Bearer <TOKEN>/);
  assert.match(failed.output.stdout, /<WORKSPACE>/);
  assert.equal(failed.redaction.passed, true);

  const missing = await runGateCommand({ command: `missing-aiws-gate-${Date.now()}`, args: [], command_role: 'fixture' }, {
    cwd: root, workspaceRoot: root, stdout: false, stderr: false, timeoutMs: 2_000
  });
  assert.equal(missing.error_code, GATE_ERROR_CODES.notFound);

  const timedOut = await runGateCommand({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], command_role: 'node' }, {
    cwd: root, workspaceRoot: root, stdout: false, stderr: false, timeoutMs: 100
  });
  assert.equal(timedOut.error_code, GATE_ERROR_CODES.timeout);
  assert.equal(timedOut.timed_out, true);
});

test('Pnpm resolves through Corepack JavaScript and active Gate files contain no shell:true', () => {
  const invocation = pnpmInvocation(['--version']);
  if (invocation.command === process.execPath) {
    assert.match(invocation.args[0].replaceAll('\\', '/'), /node_modules\/corepack\/dist\/corepack\.js$/);
    assert.deepEqual(invocation.args.slice(1), ['pnpm', '--version']);
  } else {
    assert.equal(invocation.command, 'corepack');
    assert.deepEqual(invocation.args, ['pnpm', '--version']);
  }
  for (const file of ['scripts/check.mjs', 'scripts/layered-gate.mjs', 'scripts/verify.mjs', 'scripts/verify-dev.mjs', 'scripts/e2e.mjs']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /shell\s*:\s*true/, file);
  }
});

test('formal verification uses immutable P5-P9 Evidence and only current P10 probes', () => {
  const plan = createFormalVerificationPlan();
  const text = plan.flatMap((entry) => entry.invocation.args).join('\n');
  for (const phase of [5, 6, 7, 8, 9]) assert.ok(plan.some((entry) => entry.id === `evidence-p${phase}`));
  assert.doesNotMatch(text, /v3-clean-p[5-9].*probe\.mjs/);
  assert.deepEqual(plan.filter((entry) => entry.id.startsWith('p10-') && entry.id.endsWith('-probe')).map((entry) => entry.id), [
    'p10-parser-probe', 'p10-github-deletion-probe', 'p10-release-probe'
  ]);
  assert.match(fs.readFileSync('scripts/verify.mjs', 'utf8'), /specification\.id === 'web-test'.*releasePromise/s);
  assert.equal(plan.filter((entry) => entry.id === 'web-test').length, 1);
  assert.equal(plan.filter((entry) => entry.id === 'test-p31').length, 1);
  assert.equal(plan.find((entry) => entry.id === 'check').env.AIWS_CHECK_SKIP_WEB_TYPECHECK, '1');
  assert.equal(plan.find((entry) => entry.id === 'unit-test').env.AIWS_TEST_UNIT_ONLY, '1');
  assert.deepEqual(plan.filter((entry) => entry.parallel_group === 'local-validation').map((entry) => entry.id), ['web-test', 'unit-test', 'integration', 'security', 'build']);
  assert.equal(plan.find((entry) => entry.id === 'security').env.AIWS_SECURITY_DEFER_DOCKER, '1');
  assert.equal(new Set(plan.map((entry) => entry.id)).size, plan.length);
});

test('Historical security excludes Clean duplicates while formal release owns the deferred image boundary', () => {
  const [, historical] = commandFor('historical', 'security');
  assert.equal(historical.includes('tests/security/boundary.test.mjs'), false);
  assert.equal(historical.includes('tests/security/v3-clean-p1.test.mjs'), false);
  for (const file of ['broker-http.test.mjs', 'context-mcp-r5.test.mjs', 'credentials.test.mjs', 'project-repository.test.mjs', 'workflow-r4.test.mjs']) {
    assert.ok(historical.includes(`tests/security/${file}`), file);
  }
  const release = fs.readFileSync('scripts/v3-clean-p10-release-probe.mjs', 'utf8');
  for (const marker of ['production_image_boundary', 'command -v docker', '/var/run/docker.sock', "import('node-pty')", 'aiws.component']) assert.ok(release.includes(marker), marker);
});

test('incremental selector covers Web, Golden, shared core, governance, and unclassified paths without external probes', () => {
  const catalog = { features: [
    feature('REC-GOV', 'governance', ['platform'], ['AGENTS.md']),
    feature('REC-GOLDEN', 'mcp', ['mcp'], ['scripts/mcp-stdio.mjs']),
    feature('REC-CORE', 'operations', ['operations'], ['apps/api/src/clean/operations.mjs']),
    feature('REC-WEB', 'frontend', ['frontend'], ['apps/web/src/features/project/Page.tsx']),
    feature('REC-WEB-DEEP', 'frontend', ['frontend'], ['apps/web/src/App.tsx'])
  ] };
  const web = selectDevCommands({ changedPaths: ['apps/web/src/features/project/Page.tsx'], catalog });
  assert.deepEqual(ids(web).filter((id) => id.startsWith('web-')), ['web-test']);
  assert.ok(web.commands.find((entry) => entry.id === 'check').satisfies.includes('pnpm --filter @aiws/web typecheck'));
  assert.equal(ids(web).includes('e2e'), false);

  const deepWeb = selectDevCommands({ changedPaths: ['apps/web/src/App.tsx'], catalog });
  assert.ok(ids(deepWeb).includes('build'));
  assert.ok(ids(deepWeb).includes('e2e'));
  assert.ok(deepWeb.commands.find((entry) => entry.id === 'build').satisfies.includes('pnpm --filter @aiws/web typecheck'));

  const golden = selectDevCommands({ changedPaths: ['scripts/mcp-stdio.mjs'], catalog });
  for (const id of ['test-p4', 'test-p31', 'integration-historical']) assert.ok(ids(golden).includes(id), id);

  const core = selectDevCommands({ changedPaths: ['apps/api/src/clean/operations.mjs'], catalog });
  for (const id of ['test-p1', 'test-p2', 'test-p3', 'test-p31', 'test-p4', 'test-p5', 'test-p6', 'test-p7', 'test-p8', 'test-p9', 'test-p10', 'integration-clean', 'security-clean']) assert.ok(ids(core).includes(id), id);

  const governance = selectDevCommands({ changedPaths: ['AGENTS.md'], catalog });
  for (const id of ['audit-p1', 'audit-parity', 'recovery-plan', 'recovery-catalog', 'recovery-coverage', 'recovery-impact', 'test-p1', 'test-p31', 'test-p10']) assert.ok(ids(governance).includes(id), id);

  const unknown = selectDevCommands({ changedPaths: ['new/governance-file.json'], catalog });
  assert.deepEqual(unknown.unclassified_paths, ['new/governance-file.json']);
  for (const selection of [web, deepWeb, golden, core, governance]) {
    assert.equal(new Set(ids(selection)).size, selection.commands.length);
    assert.doesNotMatch(selection.commands.flatMap((entry) => entry.satisfies).join('\n'), /github|deletion|release|assist-probe|docker-runner|bridge-runner|host-runner|parser-probe/i);
  }
});

test('standalone test retains Web while formal verify switches its nested run to Unit-only', () => {
  const source = fs.readFileSync('scripts/test.mjs', 'utf8');
  assert.match(source, /AIWS_TEST_UNIT_ONLY/);
  assert.match(source, /!unitOnly/);
  assert.match(source, /'@aiws\/web', 'test'/);
  const verify = createFormalVerificationPlan();
  assert.equal(verify.filter((entry) => entry.id === 'web-test').length, 1);
  assert.equal(verify.find((entry) => entry.id === 'unit-test').env.AIWS_TEST_UNIT_ONLY, '1');
});

test('Pnpm script separators are accepted by development commands', () => {
  assert.deepEqual(parseDevArguments(['--', '--base', 'main', '--all', '--explain']), { base: 'main', all: true, explain: true });
  const receipt = parseReceiptArguments(['--', '--project-id', 'project_fixture'], root, {});
  assert.equal(receipt.projectId, 'project_fixture');
});

test('development receipt reports persisted execution metrics and leaves SQLite, CAS, and Vault byte-exact', async () => {
  const state = await openP10();
  let runtimeOpen = true;
  try {
    const fixture = await prepare(state, 'development-receipt');
    const started = await state.runtime.execution.start(fixture.execution.id, {
      expected_revision: fixture.execution.revision,
      idempotency_key: 'development-receipt-start'
    }, state.principal);
    await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
    let completed = state.runtime.execution.get(fixture.execution.id, state.principal);
    const checkpoint = state.runtime.execution.checkpointsFor(completed.id, {}, state.principal).checkpoints.find((item) => item.stage === 'deliver');
    const replayed = await state.runtime.execution.replayStage(completed.id, 'deliver', {
      generation: completed.generation,
      checkpoint_token: checkpoint.checkpoint_token,
      workspace_hash: checkpoint.workspace_sha256,
      pins_hash: checkpoint.pins_sha256,
      expected_revision: completed.revision,
      idempotency_key: 'development-receipt-replay'
    }, state.principal);
    await waitOperation(state.runtime, replayed.operation.operation_id, state.principal.actorId);
    completed = state.runtime.execution.get(completed.id, state.principal);
    const replanned = await state.runtime.execution.replan(completed.id, {
      expected_revision: completed.revision,
      tasks: completed.plan.tasks,
      idempotency_key: 'development-receipt-replan'
    }, state.principal);
    assert.equal(replanned.execution.parent_execution_id, completed.id);
    const projectRow = state.runtime.db.get('SELECT * FROM projects WHERE id=?', [fixture.project.id]);
    const rerun = await state.runtime.execution.create(fixture.project.id, {
      repository_workspace_id: fixture.workspace.id,
      context_pack_id: fixture.pack.id,
      runner_profile_id: fixture.profile.id,
      tasks: completed.plan.tasks,
      expected_revision: projectRow.revision,
      idempotency_key: 'development-receipt-full-rerun'
    }, state.principal);
    const rerunStarted = await state.runtime.execution.start(rerun.execution.id, { expected_revision: rerun.execution.revision, idempotency_key: 'development-receipt-full-rerun-start' }, state.principal);
    await waitOperation(state.runtime, rerunStarted.operation.operation_id, state.principal.actorId);

    const approval = await state.runtime.assist.createApproval({
      project_id: fixture.project.id,
      action: 'terminal.open',
      request: { workspace_id: fixture.workspace.id, runtime: process.platform === 'win32' ? 'windows_native' : 'linux_native', cwd: '', cols: 120, rows: 32, assist_session_id: null },
      expected_revision: 0,
      idempotency_key: 'development-receipt-approval'
    }, state.principal);
    await state.runtime.assist.decideApproval(approval.approval.id, {
      decision: 'approved', expected_revision: approval.approval.revision,
      idempotency_key: 'development-receipt-approval-decision'
    }, state.principal);
    const input = await state.runtime.assist.createInput({
      project_id: fixture.project.id,
      prompt_summary: 'Persisted summary excluded from receipt',
      input_schema: { type: 'string' }, expected_revision: 0,
      idempotency_key: 'development-receipt-input'
    }, state.principal);
    await state.runtime.assist.answerInput(input.input.id, {
      response: { value: 'private response excluded' }, expected_revision: input.input.revision,
      idempotency_key: 'development-receipt-input-answer'
    }, state.principal);
    const currentProject = state.runtime.db.get('SELECT * FROM projects WHERE id=?', [fixture.project.id]);
    const proposal = await state.runtime.assist.createProposal({
      project_id: fixture.project.id,
      proposal_type: 'metadata', target_type: 'project', target_id: fixture.project.id,
      target_revision: currentProject.revision, payload: { receipt: 'verified' }, expected_revision: 0,
      idempotency_key: 'development-receipt-proposal'
    }, state.principal);
    await state.runtime.assist.mutateProposal(proposal.proposal.id, 'apply', {
      expected_revision: proposal.proposal.revision,
      idempotency_key: 'development-receipt-proposal-apply'
    }, state.principal);

    const failed = await state.runtime.operations.create({
      actorId: state.principal.actorId,
      commandId: 'profile.probe', kind: 'profile.probe', resourceType: 'profile', resourceId: 'fixture_profile',
      projectId: fixture.project.id, requestHash: sha256Hex(canonicalJson({ fixture: true })),
      idempotencyKey: 'development-receipt-failed-operation', status: 'running'
    });
    await state.runtime.operations.fail(failed.operation_id, {
      actorId: state.principal.actorId, projectId: fixture.project.id,
      expectedRevision: failed.revision, errorCode: 'credential_missing'
    });

    await state.runtime.close();
    runtimeOpen = false;
    const receipt = generateDevelopmentReceipt({ home: state.root, projectId: fixture.project.id });
    assert.equal(validateReceiptHash(receipt), true);
    assert.equal(receipt.schema.user_version, 9);
    assert.deepEqual(receipt.schema.migration_ledger, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(receipt.executions.root_runs >= 2, true);
    assert.equal(receipt.executions.full_reruns >= 1, true);
    assert.equal(receipt.executions.replans >= 1, true);
    assert.equal(receipt.task_attempts.total >= 1, true);
    assert.equal(receipt.stage_checkpoints.total >= 8, true);
    assert.equal(receipt.stage_checkpoints.replays, 1);
    assert.deepEqual(receipt.stage_checkpoints.stages.map((item) => item.stage), ['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver']);
    assert.equal(receipt.context.selections >= 1, true);
    assert.equal(receipt.context.packs >= 1, true);
    assert.equal(receipt.context.pack_convergence_rate, 1);
    assert.equal(receipt.human_intervention.approvals.decisions, 1);
    assert.equal(receipt.human_intervention.user_inputs.answered, 1);
    assert.equal(receipt.human_intervention.total_decisions >= 3, true);
    assert.equal(receipt.measurable_durations.runner.sample_count >= 1, true);
    assert.equal(receipt.measurable_durations.delivery.duration_ms, null);
    assert.equal(receipt.measurable_durations.gate.sample_count >= 1, true);
    assert.equal(receipt.measurable_durations.gate.duration_ms >= 0, true);
    assert.deepEqual(receipt.failures_by_class, [{ failure_class: 'external_dependency', count: 1 }]);
    assert.equal(receipt.manual_workarounds.value, null);
    assert.equal(receipt.manual_workarounds.reason, 'not_persisted');
    assert.equal(receipt.model_tokens.value, null);
    assert.equal(receipt.state_integrity.byte_exact, true);
    assert.deepEqual(receipt.state_integrity.byte_exact_mismatches, []);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(state.root), false);
    assert.equal(serialized.includes('Persisted summary excluded from receipt'), false);
    assert.equal(serialized.includes('private response excluded'), false);

    const output = path.join(os.tmpdir(), `aiws-development-receipt-${process.pid}-${Date.now()}.json`);
    try {
      const cli = spawnSync(process.execPath, [
        'scripts/development-receipt.mjs', '--', '--project-id', fixture.project.id,
        '--home', state.root, '--from', receipt.project.window.from, '--to', receipt.project.window.to,
        '--output', output
      ], { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout, '');
      const written = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.equal(validateReceiptHash(written), true);
      assert.equal(written.receipt_sha256, receipt.receipt_sha256);
    } finally { fs.rmSync(output, { force: true }); }
  } finally {
    if (runtimeOpen) await state.runtime.close().catch(() => undefined);
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('development receipt failure classes are fixed and unknown operation owners block generation', async () => {
  assert.equal(classifyFailure('github_rate_limit', 'Delivery'), 'external_dependency');
  assert.equal(classifyFailure('revision_conflict', 'Project'), 'platform');
  assert.equal(classifyFailure('unit_test_failed', 'Execution'), 'project_execution');
  const state = await openP10();
  let runtimeOpen = true;
  try {
    const project = await state.runtime.project.createProject({ name: 'Owner missing', idempotency_key: 'owner-missing-project' }, state.principal);
    await state.runtime.operations.create({
      actorId: state.principal.actorId, commandId: 'execution.unknown.command', kind: 'execution.unknown.command',
      resourceType: 'fixture', resourceId: 'fixture', projectId: project.id,
      requestHash: sha256Hex(canonicalJson({ fixture: true })), idempotencyKey: 'owner-missing-operation', status: 'succeeded'
    });
    await state.runtime.close(); runtimeOpen = false;
    assert.throws(() => generateDevelopmentReceipt({ home: state.root, projectId: project.id }), (error) => error.code === 'development_receipt_owner_missing');
  } finally {
    if (runtimeOpen) await state.runtime.close().catch(() => undefined);
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

function feature(id, domain, ownerModules, files) {
  return { id, domain, owner_modules: ownerModules, source_files: files, target_modules: [], behavior_tests: [], ui_tests: [], tests: [] };
}
function ids(selection) { return selection.commands.map((command) => command.id); }

test('generation attempts count rows once and time windows exclude later retries', async () => {
  let calls = 0;
  const state = await openP10({ runtime: { generator: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('provider_timeout'), { code: 'provider_timeout' });
    return { nodes: [{ id: 'ready', kind: 'workstream', title: 'Ready' }] };
  } } });
  let closed = false;
  try {
    const flow = await prepare(state, 'generation-count');
    const current = state.runtime.project.getProject(flow.project.id, state.principal);
    const first = await state.runtime.project.startGeneration(flow.project.id, { expected_revision: current.revision, idempotency_key: 'receipt-generation-first' }, state.principal);
    await waitOperation(state.runtime, first.operation.operation_id, state.principal.actorId);
    const failed = state.runtime.project.getGeneration(first.generation.id, state.principal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retry = await state.runtime.project.retryGeneration(failed.id, { expected_revision: failed.revision, idempotency_key: 'receipt-generation-retry' }, state.principal);
    await waitOperation(state.runtime, retry.operation.operation_id, state.principal.actorId);
    await state.runtime.close(); closed = true;
    const full = generateDevelopmentReceipt({ home: state.root, projectId: flow.project.id });
    assert.equal(full.workflow.generations.total, 2);
    assert.equal(full.workflow.generations.attempts, 2);
    assert.equal(full.workflow.generations.retries, 1);
    assert.equal(full.executions.full_reruns, 0);
    const window = generateDevelopmentReceipt({ home: state.root, projectId: flow.project.id, from: failed.created_at, to: failed.created_at });
    assert.equal(window.workflow.generations.attempts, 1);
    assert.equal(window.workflow.generations.retries, 0);
    assert.equal(full.failure_records.filter((row) => row.error_code === 'provider_timeout').length, 1);
  } finally {
    if (!closed) await state.runtime.close();
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('combined development layers preserve advisory status and receipts omit raw invocations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-dev-advisory-'));
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    const exit = await devMain(['--all'], directory, {
      repositoryState: () => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), base_source: 'fixture', changed_paths: [] }),
      loadCatalog: () => ({ features: [] }),
      runGateCommand: async (invocation) => {
        const layered = invocation.args.find((arg) => ['test:integration', 'test:security'].includes(arg));
        return { command: '<NODE>', args: ['fixture'], exit_status: 0, signal: null, duration_ms: 1, ok: true, error_code: null, capture: { stdout_truncated: false, stderr_truncated: false }, output: { stdout: layered ? JSON.stringify({ schema_version: 'aiws.v3-clean.layered-gate-result.v2', status: 'advisory', receipt: null }) : '', stderr: '' }, redaction: { passed: true, removed: 0 } };
      }
    });
    assert.equal(exit, 0);
    assert.match(output, /"status": "advisory"/);
    const receiptDirectory = path.join(directory, '.ai-workspace', 'gate-receipts');
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory)[0]), 'utf8'));
    assert.equal(receipt.schema_version, 'aiws.v3-clean.dev-verification-receipt.v1');
    assert.equal(receipt.status, 'advisory');
    assert.equal(receipt.historical_advisory.length, 2);
    assert.ok(receipt.commands.every((command) => !Object.hasOwn(command, 'invocation') && !Object.hasOwn(command, 'env')));
    assert.equal(JSON.stringify(receipt).includes(process.execPath), false);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('changed Git paths preserve Chinese names and include both sides of a rename', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-dev-paths-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(directory, 'old.txt'), 'baseline');
    git('add', '.');
    git('-c', 'core.hooksPath=', 'commit', '-m', 'baseline');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'old.txt', 'new.txt');
    fs.writeFileSync(path.join(directory, '\u4e2d\u6587 space &.mjs'), 'export const value = 1;');
    const state = repositoryState(directory, base);
    assert.deepEqual(state.changed_paths, ['new.txt', 'old.txt', '\u4e2d\u6587 space &.mjs']);
    assert.throws(() => repositoryState(directory, '--output=bad'), /./);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('development baseline prefers upstream and records staged, worktree, and untracked paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-dev-upstream-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-dev-remote-'));
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(directory, 'init', '-b', 'main');
    git(directory, 'config', 'user.name', 'Fixture');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(directory, 'baseline.txt'), 'base');
    git(directory, 'add', '.');
    git(directory, '-c', 'core.hooksPath=', 'commit', '-m', 'baseline');
    git(remote, 'init', '--bare');
    git(directory, 'remote', 'add', 'origin', remote);
    git(directory, 'push', '-u', 'origin', 'main');
    git(directory, 'switch', '-c', 'feature');
    fs.writeFileSync(path.join(directory, 'committed.txt'), 'committed');
    git(directory, 'add', '.');
    git(directory, '-c', 'core.hooksPath=', 'commit', '-m', 'feature');
    const upstreamCommit = git(directory, 'rev-parse', 'HEAD');
    git(directory, 'update-ref', 'refs/remotes/origin/feature', upstreamCommit);
    git(directory, 'branch', '--set-upstream-to=origin/feature', 'feature');
    fs.writeFileSync(path.join(directory, 'worktree.txt'), 'baseline-worktree');
    git(directory, 'add', 'worktree.txt');
    git(directory, '-c', 'core.hooksPath=', 'commit', '-m', 'tracked worktree');
    fs.writeFileSync(path.join(directory, 'staged.txt'), 'staged');
    git(directory, 'add', 'staged.txt');
    fs.writeFileSync(path.join(directory, 'worktree.txt'), 'worktree');
    fs.writeFileSync(path.join(directory, 'untracked.txt'), 'untracked');
    const state = repositoryState(directory);
    assert.equal(state.base_source, 'merge-base HEAD @{upstream}');
    assert.equal(state.base, upstreamCommit);
    assert.deepEqual(state.base_paths, ['worktree.txt']);
    assert.deepEqual(state.staged_paths, ['staged.txt']);
    assert.deepEqual(state.worktree_paths, ['worktree.txt']);
    assert.deepEqual(state.untracked_paths, ['untracked.txt']);
    assert.ok(state.changed_paths.includes('staged.txt'));
    const explicit = repositoryState(directory, 'main');
    assert.equal(explicit.base_source, 'requested:main');
    assert.ok(explicit.base_paths.includes('committed.txt'));
    assert.deepEqual(selectDevCommands({ changedPaths: state.changed_paths, catalog: { features: [] } }).unclassified_paths, state.changed_paths);
    git(directory, 'update-ref', '-d', 'refs/remotes/origin/feature');
    assert.throws(() => repositoryState(directory), error => error.code === 'git_base_unverifiable');
    assert.equal(repositoryState(directory, 'main').base, explicit.base);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('development baseline falls back deterministically and fails with git_base_unverifiable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-dev-fallback-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(directory, 'baseline.txt'), 'base');
    git('add', '.');
    git('-c', 'core.hooksPath=', 'commit', '-m', 'baseline');
    assert.equal(repositoryState(directory).base_source, 'merge-base HEAD main');
    git('switch', '-c', 'orphan');
    assert.equal(repositoryState(directory).base_source, 'merge-base HEAD main');
    fs.writeFileSync(path.join(directory, 'second.txt'), 'second');
    git('add', '.');
    git('-c', 'core.hooksPath=', 'commit', '-m', 'second');
    const second = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', second);
    assert.equal(repositoryState(directory).base_source, 'merge-base HEAD origin/main');
    assert.equal(repositoryState(directory).base, second);
    git('update-ref', '-d', 'refs/remotes/origin/main');
    assert.equal(repositoryState(directory).base_source, 'merge-base HEAD main');
    git('branch', '-D', 'main');
    assert.equal(repositoryState(directory).base_source, 'HEAD^');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-dev-empty-'));
    try {
      const init = spawnSync('git', ['init', '-b', 'solo'], { cwd: empty, encoding: 'utf8', windowsHide: true });
      assert.equal(init.status, 0, init.stderr);
      spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: empty, encoding: 'utf8', windowsHide: true });
      spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: empty, encoding: 'utf8', windowsHide: true });
      fs.writeFileSync(path.join(empty, 'only.txt'), 'only');
      spawnSync('git', ['add', '.'], { cwd: empty, encoding: 'utf8', windowsHide: true });
      spawnSync('git', ['-c', 'core.hooksPath=', 'commit', '-m', 'only'], { cwd: empty, encoding: 'utf8', windowsHide: true });
      assert.throws(() => repositoryState(empty), (error) => error.code === 'git_base_unverifiable');
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
