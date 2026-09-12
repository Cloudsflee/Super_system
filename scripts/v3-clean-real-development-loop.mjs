#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCleanRuntime } from '../apps/api/src/clean/runtime.mjs';
import { HostRunnerAdapter } from '../apps/api/src/clean/runner-adapters.mjs';
import { LocalGitRepositoryAdapter, compileWorkflowToExecutionPlan } from '../apps/api/src/clean/workflow-adapters.mjs';
import { canonicalJson, sha256Hex } from '../apps/api/src/clean/canonical.mjs';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';

// Owner: Workflow/Repository/Runner/Evidence. Phase: post-P10.
// This command intentionally uses the process Codex adapter. A deterministic
// provider is never selected by this entry point.

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replaceAll('-', '_');
    result[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  if (!result.source || !result.project_name) throw new Error('usage: node scripts/v3-clean-real-development-loop.mjs --source <SOURCE_PATH> --project-name <PROJECT_NAME>');
  return result;
}

function git(source, command) {
  return execFileSync('git', ['-C', source, ...command], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function assertSource(source) {
  const candidate = path.resolve(String(source));
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('repository_source_invalid');
  const real = fs.realpathSync(candidate);
  // `--show-prefix` is empty only when the requested directory is the worktree
  // root; this avoids Windows 8.3 versus long-path spelling differences.
  // An empty prefix is Git's canonical root test and remains stable across
  // Windows short/long path spellings.
  if (git(real, ['rev-parse', '--show-prefix'])) throw new Error('repository_source_invalid');
  if (git(real, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('source_worktree_dirty');
  const entries = git(real, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d{6}) (\w+) [a-f0-9]{40}\t(.+)$/.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw new Error('repository_source_invalid');
    const target = path.resolve(real, match[3]);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('repository_source_invalid');
  }
  return real;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRunRoot(inputRoot, source, runId) {
  const requested = path.resolve(String(inputRoot || path.join(process.cwd(), '.ai-workspace', 'real-development-loop', runId)));
  const sourceReal = fs.realpathSync(source);
  let comparison = requested;
  try { comparison = fs.realpathSync(requested); } catch { comparison = path.resolve(requested); }
  if (isWithin(sourceReal, comparison)) {
    if (inputRoot) throw new Error('run_root_inside_source');
    return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-real-loop-')), requested, redirected: true };
  }
  return { root: requested, requested, redirected: false };
}

function fileManifest(root) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.join(prefix, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) rows.push({ path: relative, sha256: sha256Hex(fs.readFileSync(absolute)), byte_length: fs.statSync(absolute).size });
    }
  };
  walk(root); return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else if (entry.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}

function rollbackVerification(root, runId) {
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-rollback-baseline-`));
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-rollback-isolated-`));
  const dbFile = path.join(baseline, 'sqlite', 'state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openCleanDatabase(dbFile, { targetVersion: 8, receiptRoot: path.join(baseline, 'receipts') });
  db.close();
  for (const component of ['cas', 'vault', 'workspace', 'broker', 'bridge', 'parser', 'web']) fs.mkdirSync(path.join(baseline, component), { recursive: true });
  const expected = fileManifest(baseline);
  const dryRun = { status: expected.length > 0 ? 0 : 1, writes: 0 };
  copyTree(baseline, isolated);
  const actual = fileManifest(isolated);
  const expectedByPath = new Map(expected.map((row) => [row.path, row]));
  const actualByPath = new Map(actual.map((row) => [row.path, row]));
  const mismatches = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].filter((key) => JSON.stringify(expectedByPath.get(key) || null) !== JSON.stringify(actualByPath.get(key) || null));
  const verifyDb = openCleanDatabase(path.join(isolated, 'sqlite', 'state.sqlite'), { targetVersion: 8, receiptRoot: path.join(isolated, 'receipts') });
  const integrity = verifyDb.integrity();
  const ledger = verifyDb.query('SELECT version FROM schema_migrations ORDER BY version').map((row) => Number(row.version));
  const p10Names = ['brief_templates', 'brief_template_revisions', 'workflow_quality_policies', 'quality_review_asset_selections', 'quality_review_advices', 'assist_review_comments', 'project_deletion_intents', 'repository_deletion_intents'];
  const existingNames = new Set(verifyDb.query("SELECT name FROM sqlite_schema WHERE type='table'").map((row) => row.name));
  const p10TablesAbsent = p10Names.filter((name) => existingNames.has(name));
  verifyDb.close();
  const result = { status: dryRun.status === 0 && !mismatches.length && integrity.user_version === 8 && JSON.stringify(ledger) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]) && !p10TablesAbsent.length ? 'passed' : 'failed', dry_run: { status: dryRun.status, writes: dryRun.writes }, apply: { status: mismatches.length || p10TablesAbsent.length ? 1 : 0 }, restored_user_version: integrity.user_version, ledger, p10_tables_absent: p10TablesAbsent, byte_exact_mismatches: mismatches, baseline_manifest_sha256: sha256Hex(canonicalJson(expected)), isolated_manifest_sha256: sha256Hex(canonicalJson(actual)) };
  fs.rmSync(baseline, { recursive: true, force: true }); fs.rmSync(isolated, { recursive: true, force: true });
  return result;
}

function waitOperation(runtime, id, actorId, timeout = 15 * 60 * 1000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const operation = runtime.operations.get(id, { actorId });
        if (TERMINAL.has(operation.status)) return resolve(operation);
      } catch (error) { return reject(error); }
      if (Date.now() - start >= timeout) return reject(Object.assign(new Error('operation_timeout'), { code: 'provider_timeout' }));
      // Keep the standalone CLI alive while the operation worker reaches a
      // terminal state; an unref'ed poll lets Node exit before the receipt is
      // written on an otherwise idle process.
      setTimeout(poll, 25);
    };
    poll();
  });
}

function redacted(value, root) {
  if (Array.isArray(value)) return value.map((item) => redacted(item, root));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (value.includes(root) || path.isAbsolute(value)) return '<redacted-path>';
    return value.replace(/(?:sk|gh[opurs])_[A-Za-z0-9_-]{8,}/g, '<redacted-token>');
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|credential|proof|prompt|response|stdout|stderr|absolute_path/i.test(key)) output[key] = '<redacted>';
    else output[key] = redacted(item, root);
  }
  return output;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function run(input) {
  const source = assertSource(input.source);
  const runId = `run-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const runRoot = resolveRunRoot(input.root, source, runId);
  const root = runRoot.root;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const config = {
    runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0,
    home: root, databaseFile: path.join(root, 'data', 'state.sqlite'),
    casRoot: path.join(root, 'cas'), receiptRoot: path.join(root, 'receipts'),
    vaultRoot: path.join(root, 'vault'), workspaceRoot: path.join(root, 'workspaces'),
    providerHomeRoot: path.join(root, 'provider-homes'), runnerHomeRoot: path.join(root, 'runner-homes'),
    cursorSecret: randomBytes(32).toString('hex'), sessionSecret: randomBytes(32).toString('hex'),
    mcpPepper: randomBytes(32).toString('hex'), gatewaySecret: randomBytes(32).toString('hex'),
    vaultMasterKey: randomBytes(32).toString('hex'), runtimeBuild: 'post-p10-real-development-loop',
    providerMode: 'process', providerCommand: String(process.env.AIWS_CLEAN_PROVIDER_COMMAND || 'codex'),
    providerTimeoutMs: Number(process.env.AIWS_CLEAN_PROVIDER_TIMEOUT_MS || 120000),
    providerDiscoverySecret: randomBytes(32).toString('hex'),
    codexDiscoveryRoots: [{ hint: '~/.codex', path: path.join(os.homedir(), '.codex'), priority: 1 }],
    runnerPollIntervalMs: 10, parserPollIntervalMs: 10, maxBodyBytes: 16 * 1024 * 1024
  };
  const repositoryAdapter = new LocalGitRepositoryAdapter();
  const runnerAdapter = new HostRunnerAdapter({ homeRoot: config.runnerHomeRoot });
  let runtime;
  let receipt = { schema_version: 'aiws.post-p10.real-development-loop.v1', status: 'failed', run_id: runId, model: 'gpt-5.6-sol', reasoning_effort: 'high' };
  try {
    runtime = createCleanRuntime({ config, targetVersion: 9, runtimePhase: 10, repositoryAdapter, hostRunnerAdapter: runnerAdapter });
    await runtime.recovery;
    repositoryAdapter.vault = runtime.vault;
    const setup = await runtime.identity.setupComplete({ display_name: 'Local owner', team_name: 'Local team', idempotency_key: `${runId}-setup` });
    const principal = runtime.identity.authenticateProof(setup.session.proof);

    const discovery = runtime.localSetup.discoverCodex({}, principal);
    const sourceRecord = discovery.sources.find((item) => item.status === 'available' && item.records?.some((record) => record.credential_available));
    const record = sourceRecord?.records?.find((item) => item.credential_available);
    if (!sourceRecord || !record) throw Object.assign(new Error('provider_rebind_required'), { code: 'provider_rebind_required' });
    const imported = await runtime.localSetup.importCodex({
      source_id: sourceRecord.id, source_revision: sourceRecord.source_revision, record_id: record.id,
      confirmed: true, model: 'gpt-5.6-sol', profile_label: 'Real local development loop',
      idempotency_key: `${runId}-codex-import`, expected_revision: 0
    }, principal);
    let profile = runtime.identity.profiles(principal).find((item) => item.id === imported.profile.id);
    const fixedConfig = { ...(profile.config || {}), model: 'gpt-5.6-sol', model_reasoning_effort: 'high' };
    const updated = await runtime.identity.updateProfile(profile.id, { config: fixedConfig, expected_revision: profile.revision, idempotency_key: `${runId}-profile-fixed` }, principal);
    profile = updated.profile;
    const probe = await runtime.identity.probeProfile(profile.id, { expected_revision: profile.revision, idempotency_key: `${runId}-profile-probe` }, principal);
    const probeResult = await waitOperation(runtime, probe.operation_id || probe.id, principal.actorId);
    if (probeResult.status !== 'succeeded') throw Object.assign(new Error(probeResult.error_code || 'provider_unavailable'), { code: probeResult.error_code || 'provider_unavailable' });
    profile = runtime.identity.profiles(principal).find((item) => item.id === profile.id);
    if (profile.provider !== 'codex' || profile.config?.model !== 'gpt-5.6-sol' || profile.config?.model_reasoning_effort !== 'high' || profile.status !== 'available') throw Object.assign(new Error('provider_profile_invalid'), { code: 'provider_profile_invalid' });
    const providerPin = runtime.identity.providerProfileSnapshot(profile.id, principal);

    const project = await runtime.project.createProject({ name: String(input.project_name), idempotency_key: `${runId}-project` }, principal);
    const intake = await runtime.project.submitIntake(project.id, { mode: 'brainstorm', content: { objective: 'Implement the requested change in the local repository and prove it with tests.' }, expected_revision: 1, idempotency_key: `${runId}-intake` }, principal);
    await waitOperation(runtime, intake.operation.operation_id, principal.actorId);
    await runtime.project.createBrief(project.id, { objective: 'Implement the requested change in the local repository.', acceptance: ['node_test', 'git_diff_check'], expected_revision: 1, idempotency_key: `${runId}-brief` }, principal);
    await runtime.project.confirmBrief(project.id, { brief_revision: 1, expected_revision: 2, idempotency_key: `${runId}-brief-confirm` }, principal);
    await runtime.project.createRepositoryConnection(project.id, { provider: 'local', source_kind: 'local', source_locator: source, read_only: true, idempotency_key: `${runId}-repository` }, principal);
    const line = runtime.project.listRepositoryLines(project.id, principal)[0];
    const workspaceResult = await runtime.project.createRepositoryWorkspace(project.id, { line_id: line.id, expected_revision: 0, idempotency_key: `${runId}-workspace` }, principal);
    const workspace = workspaceResult.workspace;
    await runtime.context.createSource(project.id, { kind: 'note', title: 'Local repository context', uri: `notes/${runId}`, content: 'Use the pinned repository snapshot. Keep changes in the candidate workspace and satisfy every acceptance check.', idempotency_key: `${runId}-context-source` }, principal);
    await runtime.context.rebuild(project.id, { idempotency_key: `${runId}-context-rebuild` }, principal);
    const selection = await runtime.context.createSelection(project.id, { query: 'repository implementation acceptance', token_budget: 512, idempotency_key: `${runId}-context-selection` }, principal);
    const pack = await runtime.context.createPack(project.id, { selection_id: selection.selection.id, require_authoritative: false, idempotency_key: `${runId}-context-pack` }, principal);
    const seed = { nodes: [{ id: 'implementation', kind: 'task', title: 'Implement change', config: { execution: { mode: 'write', argv: ['node', '-e', "process.exit(0)"], cwd_role: 'task', input_paths: [], output_paths: [], runner_profile_ref: '', resource_profile: 'light', deadline_seconds: 900, check_ids: ['node_test', 'git_diff_check'], capabilities: ['network:none'] } }, contract: { acceptance: ['node_test', 'git_diff_check'] } }] };
    await runtime.project.reviseWorkflow(project.id, { graph: seed, expected_revision: 1, idempotency_key: `${runId}-workflow-seed` }, principal);
    const currentProject = runtime.project.getProject(project.id, principal);
    const generation = await runtime.project.startGeneration(project.id, { provider_profile_id: profile.id, expected_revision: currentProject.revision, idempotency_key: `${runId}-generation` }, principal);
    const generationOperation = await waitOperation(runtime, generation.operation.operation_id, principal.actorId);
    if (generationOperation.status !== 'succeeded') throw Object.assign(new Error(generationOperation.error_code || 'provider_turn_incomplete'), { code: generationOperation.error_code || 'provider_turn_incomplete' });
    const generated = runtime.project.getGeneration(generation.generation.id, principal);
    const critic = await runtime.project.evaluateCritic(generated.id, { status: 'passed', expected_revision: generated.revision, idempotency_key: `${runId}-critic` }, principal);
    if (critic.critic?.status !== 'passed') throw Object.assign(new Error('critic_failed'), { code: 'critic_failed' });
    const criticManifest = runtime.db.get('SELECT payload_json FROM receipt_manifests WHERE id=?', [critic.critic.id]);
    const criticCoverageHash = criticManifest ? JSON.parse(criticManifest.payload_json).coverage_sha256 : null;
    const workflow = runtime.db.get('SELECT * FROM workflows WHERE project_id=?', [project.id]);
    await runtime.project.applyProposal(critic.proposal.id, { expected_revision: workflow.revision, idempotency_key: `${runId}-proposal-apply` }, principal);
    const runnerProfile = await runtime.runner.createProfile({ runner_type: 'host', label: 'Real local Host', expected_revision: 0, idempotency_key: `${runId}-runner-profile` }, principal);
    const runnerProbe = await runtime.runner.probeProfile(runnerProfile.profile.id, { expected_revision: runnerProfile.profile.revision, idempotency_key: `${runId}-runner-probe` }, principal);
    const runnerProbeResult = await waitOperation(runtime, runnerProbe.operation.operation_id, principal.actorId);
    if (runnerProbeResult.status !== 'succeeded') throw Object.assign(new Error(runnerProbeResult.error_code || 'runner_unavailable'), { code: runnerProbeResult.error_code || 'runner_unavailable' });
    const execution = await runtime.execution.create(project.id, { repository_workspace_id: workspace.id, context_pack_id: pack.pack.id, runner_profile_id: runnerProfile.profile.id, expected_revision: runtime.project.getProject(project.id, principal).revision, idempotency_key: `${runId}-execution` }, principal);
    const started = await runtime.execution.start(execution.execution.id, { expected_revision: execution.execution.revision, idempotency_key: `${runId}-execution-start` }, principal);
    const executionResult = await waitOperation(runtime, started.operation.operation_id, principal.actorId);
    if (executionResult.status !== 'succeeded') throw Object.assign(new Error(executionResult.error_code || 'execution_failed'), { code: executionResult.error_code || 'execution_failed' });
    const cursorBefore = Number(runtime.db.get("SELECT cursor_sequence FROM event_cursors WHERE actor_id=? AND consumer_id='p7-evidence-capture' AND stream='events'", [runtime.metadata.bootstrap_actor_id])?.cursor_sequence || 0);
    await runtime.evidence?.recoverPending?.();
    const cursorAfter = Number(runtime.db.get("SELECT cursor_sequence FROM event_cursors WHERE actor_id=? AND consumer_id='p7-evidence-capture' AND stream='events'", [runtime.metadata.bootstrap_actor_id])?.cursor_sequence || 0);
    const executionRow = runtime.db.get('SELECT * FROM executions WHERE id=?', [execution.execution.id]);
    const generationRow = runtime.db.get('SELECT input_sha256,candidate_sha256 FROM workflow_generations WHERE id=?', [generated.id]);
    const plan = JSON.parse(executionRow.plan_json || '{}');
    const attempts = runtime.db.query('SELECT * FROM task_attempts WHERE execution_id=? ORDER BY generation,task_ordinal,attempt_no,id', [execution.execution.id]);
    const contracts = attempts.map((attempt) => { const spec = runtime.db.get('SELECT spec_json FROM job_specs WHERE id=?', [attempt.job_spec_id]); const value = spec ? JSON.parse(spec.spec_json) : {}; return value.input_refs?.find((ref) => ref.type === 'task_contract')?.hash || null; }).filter(Boolean);
    const rollback = rollbackVerification(root, runId);
    if (rollback.status !== 'passed') throw Object.assign(new Error('rollback_verification_failed'), { code: 'rollback_verification_failed' });
    receipt = { ...receipt, status: 'passed', project_id: project.id, execution_id: execution.execution.id, generation_id: generated.id, provider_profile_id: profile.id, provider_profile_revision: providerPin.profile_revision, provider_profile_hash: providerPin.profile_hash, model: 'gpt-5.6-sol', reasoning_effort: 'high', generation_input_hash: generationRow?.input_sha256 || null, generation_output_hash: generationRow?.candidate_sha256 || null, critic_coverage_hash: criticCoverageHash, workflow_hash: executionRow.workflow_hash, brief_hash: executionRow.brief_hash, context_pack_hash: executionRow.context_pack_hash, repository: { commit_sha: line.source_revision, source_manifest_sha256: line.source_hash, workspace_hash: executionRow.repository_hash }, task_contract_hashes: contracts, actual_argv: plan.tasks?.map((task) => ({ task_id: task.id, command: task.argv?.[0] || null, argument_count: Math.max(0, (task.argv || []).length - 1) })) || [], runner_profile_id: executionRow.runner_profile_id, runner_profile_revision: executionRow.runner_profile_revision, runner_receipt_hashes: attempts.map((item) => item.runner_receipt_id).filter(Boolean), output_manifest_hashes: attempts.map((item) => item.output_sha256).filter(Boolean), check_results: runtime.db.query('SELECT check_id,status,exit_status,command_sha256,input_sha256,output_sha256 FROM test_results WHERE execution_id=? ORDER BY id', [execution.execution.id]), evidence_capture_count: Number(runtime.db.get('SELECT count(*) AS count FROM assets WHERE execution_id=?', [execution.execution.id])?.count || 0), cursor_before: cursorBefore, cursor_after: cursorAfter, root_redirected: runRoot.redirected, rollback };
    receipt.receipt_sha256 = sha256Hex(canonicalJson(receipt));
    writeJson(path.join(root, 'receipts', 'final.json'), redacted(receipt, root));
    return { ...redacted(receipt, root), run_root: root };
  } catch (error) {
    receipt = { ...receipt, error_code: String(error?.code || error?.message || 'real_development_loop_failed') };
    receipt.receipt_sha256 = sha256Hex(canonicalJson(receipt));
    writeJson(path.join(root, 'receipts', 'final.json'), redacted(receipt, root));
    throw Object.assign(new Error(receipt.error_code), { code: receipt.error_code, receipt });
  } finally { await runtime?.close?.(); }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isMain = invokedPath && (process.platform === 'win32'
  ? invokedPath.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath) || /[\\/]scripts[\\/]v3-clean-real-development-loop\.mjs$/i.test(process.argv[1] || '');
if (isMain) {
  run(args(process.argv.slice(2))).then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); }).catch((error) => { process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: error.code || error.message, receipt: error.receipt || null })}\n`); process.exitCode = 1; });
}

export { run, assertSource, resolveRunRoot, rollbackVerification };
