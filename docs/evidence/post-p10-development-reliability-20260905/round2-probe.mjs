// Owner: Operations. Phase: D-040 post-P10 maintenance. No product writes.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { start } from '../../../apps/api/server.mjs';
import { loadCleanConfig } from '../../../apps/api/src/clean/config.mjs';
import { readGitBlob, resolveGitCommit } from '../../../scripts/lib/git-blob.mjs';
import { generateDevelopmentReceipt } from '../../../scripts/development-receipt.mjs';
import { runGateCommand, executableInvocation } from '../../../scripts/lib/gate-process.mjs';

const root = process.cwd();
const productRoot = path.join(root, 'temp', 'designsignal-v5-replay');
const sourceCommit = '9f1ea086d5ab101fb453701df4199d6a2ca9f793';
const baseCommit = '5833494e6fdc16201cc10ec8776578892e8d85b4';
const runId = `round2-${Date.now()}`;
const runRoot = path.join(root, '.ai-workspace', 'post-p10-maintenance', runId);
const home = path.join(runRoot, 'home');
const records = [];
const expected = JSON.parse(readGitBlob(productRoot, sourceCommit, 'docs/aiws-v3/workflow.json').bytes);
const brief = JSON.parse(readGitBlob(productRoot, sourceCommit, 'docs/aiws-v3/brief.json').bytes);
const materials = JSON.parse(readGitBlob(productRoot, sourceCommit, 'docs/aiws-v3/context-materials.json').bytes);
let app;
let cookie = '';
let projectId;
let generationId;
let sourceBefore;
let sourceAfter;
let generatedWorkstreams = [];
const started = Date.now();
const outcome = { status: 'blocked', provisional: true, blockers: [], steps: [] };
fs.mkdirSync(runRoot, { recursive: true });
const localKey = randomBytes(32).toString('hex');
fs.writeFileSync(path.join(runRoot, 'local-vault-key'), localKey, { flag: 'wx', mode: 0o600 });
try {
  sourceBefore = resolveGitCommit(productRoot, 'HEAD');
  if (sourceBefore !== sourceCommit) throw new Error('round2_product_head_changed');
  const materialize = await command('git', ['clone', '--shared', '--no-checkout', productRoot, path.join(runRoot, 'repository')]);
  if (!materialize.ok) throw new Error('round2_clone_failed');
  if (!(await command('git', ['-C', path.join(runRoot, 'repository'), 'checkout', '--detach', baseCommit])).ok) throw new Error('round2_baseline_checkout_failed');
  app = await start({ config: { ...loadCleanConfig({ AIWS_CLEAN_HOME: home, AIWS_CLEAN_VAULT_KEY: localKey, AIWS_CLEAN_BUILD: 'post-p10-round2', AIWS_CLEAN_PROVIDER_MODE: 'process' }), port: 0 }, targetVersion: 9, runtimePhase: 10 });
  await app.recovery;
  await api('POST', '/api/v2/setup', { display_name: 'Round 2 owner', team_name: 'Reliability replay', expected_revision: 0 });
  const created = await api('POST', '/api/v2/projects', { name: 'DesignSignal V6 Reliability Replay - AIWS Platform Fix', description: 'Fixed V5 baseline and V6 reliability packet', expected_revision: 0 });
  projectId = created.project?.id || created.id;
  if (!projectId) throw new Error('round2_project_id_missing');
  outcome.steps.push({ step: 'project.create', status: 'passed', project_id: projectId });
  await api('POST', `/api/v2/projects/${projectId}/repository-connections`, { provider: 'git', source_kind: 'git', source_locator: 'https://github.com/Cloudsflee/designsignal-v5-replay.git', metadata: { source_commit: baseCommit }, expected_revision: 0 });
  const intake = await api('POST', `/api/v2/projects/${projectId}/intake`, { mode: 'brainstorm', content: { objective: brief.goal }, expected_revision: 1 });
  await waitOperation(intake.operation.operation_id);
  const sourceRecords = [];
  for (const item of materials.materials) {
    const blob = readGitBlob(productRoot, sourceCommit, item.path);
    await api('POST', `/api/v2/projects/${projectId}/context/sources`, { project_id: projectId, kind: 'note', title: item.id, uri: `packet/${item.id}`, content: blob.bytes.toString('utf8'), metadata: { label: item.label, source_commit: sourceCommit, source_path: item.path, source_blob: blob.object_id }, expected_revision: 0 });
    sourceRecords.push({ id: item.id, label: item.label, path: item.path, blob: blob.object_id, sha256: hash(blob.bytes) });
  }
  outcome.steps.push({ step: 'context.import', status: 'passed', sources: sourceRecords });
  const project = await api('GET', `/api/v2/projects/${projectId}`);
  const current = project.project || project;
  await api('POST', `/api/v2/projects/${projectId}/briefs`, { content: { objective: brief.goal, constraints: brief.nonGoals, acceptance: brief.liveAcceptance, workstreams: expected.workstreams }, expected_revision: current.revision });
  const projected = await api('POST', `/api/v2/projects/${projectId}/context/rebuild`, { project_id: projectId, expected_revision: 0 });
  if (projected.operation?.operation_id) await waitOperation(projected.operation.operation_id);
  const selection = await api('POST', `/api/v2/projects/${projectId}/context/selections`, { project_id: projectId, query: 'DesignSignal reliability workstreams', token_budget: 32000, expected_revision: 0 });
  await api('POST', `/api/v2/projects/${projectId}/context/packs`, { project_id: projectId, selection_id: selection.selection.id, require_authoritative: false, expected_revision: 0 });
  const refreshed = await api('GET', `/api/v2/projects/${projectId}`);
  const generation = await api('POST', `/api/v2/projects/${projectId}/workflow-generations`, { mode: 'initial', expected_revision: (refreshed.project || refreshed).revision });
  generationId = generation.generation?.id;
  await waitOperation(generation.operation.operation_id);
  const generations = await api('GET', `/api/v2/projects/${projectId}/workflow-generations`);
  const pending = (generations.generations || generations)[0];
  generationId ||= pending.id;
  const stored = app.db.get('SELECT candidate_json FROM workflow_generations WHERE id=?', [generationId]);
  generatedWorkstreams = JSON.parse(stored.candidate_json).nodes.filter((node) => node.kind === 'workstream').map((node) => node.id);
  outcome.steps.push({ step: 'generation.start', status: 'executed', generation_id: generationId, workstreams: generatedWorkstreams });
  if (JSON.stringify([...generatedWorkstreams].sort()) !== JSON.stringify(expected.workstreams.map((item) => item.id).sort())) {
    outcome.blockers.push({ code: 'round2_generation_workstreams_mismatch', owner: 'Workflow', expected: expected.workstreams.map((item) => item.id), actual: generatedWorkstreams, source: 'apps/api/src/clean/project-workflow.mjs#deterministicGenerator' });
  }
  outcome.blockers.push({ code: 'round2_host_runner_task_execution_not_implemented', owner: 'Runner', source: 'apps/api/src/clean/runner-adapters.mjs#HostRunnerAdapter.runJob', observation: 'The default Host runner spawns a fixed status-output script; it does not execute the product test command.' });
} catch (error) {
  outcome.blockers.push({ code: /^[a-zA-Z0-9_.:-]+$/.test(error.message) ? error.message : 'round2_step_failed', owner: 'Platform' });
} finally {
  await app?.close();
  sourceAfter = resolveGitCommit(productRoot, 'HEAD');
  if (projectId) {
    const metrics = generateDevelopmentReceipt({ home, projectId });
    fs.writeFileSync(path.join(runRoot, 'development-receipt.json'), `${JSON.stringify(metrics, null, 2)}\n`, { flag: 'wx' });
    outcome.development_receipt = path.relative(root, path.join(runRoot, 'development-receipt.json')).replaceAll('\\', '/');
  }
  outcome.schema_version = 'aiws.designsignal-round2-attempt.v1';
  outcome.project_id = projectId || null;
  outcome.generation_id = generationId || null;
  outcome.runtime_home = path.relative(root, home).replaceAll('\\', '/');
  outcome.elapsed_ms = Date.now() - started;
  outcome.product = { baseline_commit: baseCommit, packet_commit: sourceCommit, head_before: sourceBefore, head_after: sourceAfter, untouched: sourceBefore === sourceAfter };
  outcome.commands = records;
  outcome.not_executed = ['critic', 'proposal.apply', 'human.workflow.confirm', 'six-workstream.execution', 'host.unit-tests', 'docker.browser-isolation-release-rollback', 'draft.delivery'];
  const resultFile = path.join(runRoot, 'round2.json');
  fs.writeFileSync(resultFile, `${JSON.stringify(outcome, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...outcome, receipt: path.relative(root, resultFile).replaceAll('\\', '/') }, null, 2));
  process.exitCode = 2;
}

async function api(method, route, body = null) {
  const commandId = app.registry.match(method, route)?.command_id;
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(body ? { 'idempotency-key': `round2-${records.length}-${Date.now()}`, 'x-expected-revision': String(body.expected_revision ?? 0) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const value = await response.json();
  records.push({ method, route, command_id: commandId, input_sha256: hash(JSON.stringify(body)), http_status: response.status, error_code: value.error?.code || null });
  if (!response.ok) throw new Error(`round2_api_${commandId}_${value.error?.code || response.status}`);
  return value.data;
}
async function waitOperation(id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const operation = await api('GET', `/api/v2/operations/${id}`);
    if (operation.status === 'succeeded') return operation;
    if (['failed', 'cancelled', 'expired'].includes(operation.status)) throw new Error(`round2_operation_${operation.error_code || operation.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('round2_operation_timeout');
}
async function command(executable, args) {
  const result = await runGateCommand(executableInvocation(executable, args), { cwd: root, workspaceRoot: root, stdout: false, stderr: false });
  records.push(result);
  return result;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
