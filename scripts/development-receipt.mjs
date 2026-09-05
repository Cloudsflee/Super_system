import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../apps/api/src/clean/canonical.mjs';
import { CLEAN_COMMAND_REGISTRY } from '../apps/api/src/clean/registry.mjs';

export const DEVELOPMENT_RECEIPT_SCHEMA = 'aiws.development-receipt.v1';
export const DEVELOPMENT_RECEIPT_ERROR = 'development_receipt_error';
export const STAGES = Object.freeze(['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver']);

const EXTERNAL_FAILURE = /provider|github|docker|network|credential|external(?:_|-)?result|remote|upstream|rate_limit|timeout_external/i;
const PLATFORM_FAILURE = /registry|cas|vault|broker|bridge|parser|permission|forbidden|unauthorized|revision|conflict|integrity|migration|database|sqlite|cursor|redaction|checkpoint|not_ready|tamper/i;
const INTERNAL_COMMAND_PARENTS = Object.freeze(Object.fromEntries([
  ...STAGES.map((stage) => [`execution.stage.${stage}`, 'execution.start']),
  ['execution.task.run', 'execution.start']
]));

export async function main(argv = process.argv.slice(2), cwd = process.cwd(), env = process.env) {
  try {
    const input = parseArguments(argv, cwd, env);
    const receipt = generateDevelopmentReceipt(input);
    const payload = `${JSON.stringify(receipt, null, 2)}\n`;
    if (input.output) atomicWrite(input.output, payload);
    else process.stdout.write(payload);
    return 0;
  } catch (error) {
    const code = error?.code || DEVELOPMENT_RECEIPT_ERROR;
    process.stderr.write(`${JSON.stringify({ schema_version: 'aiws.development-receipt-error.v1', status: 'failed', error_code: code, details: publicErrorDetails(error?.details) })}\n`);
    return 1;
  }
}

export function parseArguments(argv, cwd = process.cwd(), env = process.env) {
  const values = [...argv];
  const parsed = { projectId: '', home: env.AIWS_CLEAN_HOME || env.AIWS_HOME || path.join(cwd, '.ai-workspace', 'v3-clean'), from: null, to: null, output: null };
  while (values.length) {
    const key = values.shift();
    if (key === '--') continue;
    if (!['--project-id', '--home', '--from', '--to', '--output'].includes(key)) throw receiptError('development_receipt_unknown_option', { option: key });
    if (!values.length) throw receiptError('development_receipt_option_value_required', { option: key });
    const value = values.shift();
    if (key === '--project-id') parsed.projectId = value;
    else if (key === '--home') parsed.home = value;
    else if (key === '--from') parsed.from = iso(value, 'from');
    else if (key === '--to') parsed.to = iso(value, 'to');
    else parsed.output = path.resolve(cwd, value);
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(parsed.projectId)) throw receiptError('development_receipt_project_id_required');
  parsed.home = path.resolve(cwd, parsed.home);
  parsed.databaseFile = path.join(parsed.home, 'data', 'state.sqlite');
  if (parsed.from && parsed.to && Date.parse(parsed.from) > Date.parse(parsed.to)) throw receiptError('development_receipt_window_invalid');
  if (parsed.output && inside(parsed.home, parsed.output)) throw receiptError('development_receipt_output_inside_home');
  return parsed;
}

export function generateDevelopmentReceipt({ home, databaseFile = path.join(home, 'data', 'state.sqlite'), projectId, from = null, to = null }) {
  from = from == null ? null : iso(from, 'from');
  to = to == null ? null : iso(to, 'to');
  const root = path.resolve(home);
  const file = path.resolve(databaseFile);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw receiptError('development_receipt_database_missing');
  const before = stateSnapshot(root, file);
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-development-receipt-'));
  const snapshotFile = path.join(snapshotRoot, 'state.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${file}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${snapshotFile}${suffix}`);
  }
  let db;
  let body;
  try {
    db = new DatabaseSync(snapshotFile, { readOnly: true });
    validateDatabase(db);
    const project = db.prepare('SELECT id,created_at,updated_at FROM projects WHERE id=?').get(projectId);
    if (!project) throw receiptError('development_receipt_project_missing', { project_id: projectId });
    const window = resolveWindow(db, project, from, to);
    body = buildReceiptBody(db, project, window);
  } finally {
    db?.close();
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
  const after = stateSnapshot(root, file);
  const mismatches = ['sqlite', 'cas', 'vault'].filter((role) => before[role].sha256 !== after[role].sha256 || before[role].file_count !== after[role].file_count);
  if (mismatches.length) throw receiptError('development_receipt_state_changed', { byte_exact_mismatches: mismatches });
  const unsigned = {
    schema_version: DEVELOPMENT_RECEIPT_SCHEMA,
    generated_at: body.project.window.to,
    snapshot_time_basis: 'latest-persisted-project-record',
    ...body,
    state_integrity: {
      sqlite: { before_sha256: before.sqlite.sha256, after_sha256: after.sqlite.sha256, file_count: after.sqlite.file_count },
      cas: { before_sha256: before.cas.sha256, after_sha256: after.cas.sha256, file_count: after.cas.file_count },
      vault: { before_sha256: before.vault.sha256, after_sha256: after.vault.sha256, file_count: after.vault.file_count },
      byte_exact: true,
      byte_exact_mismatches: []
    }
  };
  assertPublicReceipt(unsigned);
  return { ...unsigned, receipt_sha256: sha256(canonicalJson(unsigned)) };
}

function buildReceiptBody(db, project, window) {
  const params = [project.id, window.from, window.to];
  const operations = db.prepare('SELECT id,command_id,status,error_code,created_at,started_at,updated_at,completed_at FROM operations WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const ownerRegistry = commandOwnerRegistry();
  const operationRecords = operations.map((row) => {
    const owner = resolveCommandOwner(row.command_id, ownerRegistry);
    if (!owner) throw receiptError('development_receipt_owner_missing', { command_id: row.command_id });
    return {
      operation_id: row.id,
      command: row.command_id,
      owner,
      status: row.status,
      error_code: row.error_code || null,
      failure_class: row.status === 'failed' ? classifyFailure(row.error_code, owner) : null,
      duration_ms: duration(row.started_at || row.created_at, row.completed_at || (terminalOperation(row.status) ? row.updated_at : null))
    };
  });

  const executions = db.prepare('SELECT * FROM executions WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const executionRecords = executions.map((row) => ({
    execution_id: row.id,
    started: row.started_at != null,
    status: row.status,
    generation: Number(row.generation),
    parent_execution_id: row.parent_execution_id || null,
    replanned_from_stage: row.replanned_from_stage || null,
    input_fingerprint: executionFingerprint(row),
    error_code: row.error_code || null,
    duration_ms: duration(row.started_at || row.created_at, row.completed_at || (terminalExecution(row.status) ? row.updated_at : null))
  }));
  const rootGroups = groupCount(executionRecords.filter((row) => row.parent_execution_id == null && row.started), (row) => row.input_fingerprint);
  const fullReruns = [...rootGroups.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  const attempts = db.prepare(`SELECT a.* FROM task_attempts a JOIN executions e ON e.id=a.execution_id
    WHERE e.project_id=? AND a.created_at>=? AND a.created_at<=? ORDER BY a.created_at,a.id`).all(...params);
  const checkpoints = db.prepare(`SELECT c.*,o.started_at AS operation_started_at,o.completed_at AS operation_completed_at,o.updated_at AS operation_updated_at,o.status AS operation_status
    FROM execution_stage_checkpoints c JOIN executions e ON e.id=c.execution_id JOIN operations o ON o.id=c.operation_id
    WHERE e.project_id=? AND c.created_at>=? AND c.created_at<=? ORDER BY c.created_at,c.id`).all(...params);

  const generations = db.prepare('SELECT id,phase,attempt,retry_of_generation_id,error_code,created_at,completed_at,updated_at FROM workflow_generations WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const critics = db.prepare('SELECT id,status,created_at FROM workflow_critic_receipts WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const workflowProposals = db.prepare('SELECT id,status,created_at,updated_at FROM workflow_generation_proposals WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const semanticProposals = db.prepare('SELECT id,status,created_at,updated_at,decided_at FROM semantic_proposals WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const selections = db.prepare('SELECT id,token_budget,token_used,created_at FROM context_selections WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const packs = db.prepare('SELECT id,selection_id,status,created_at FROM context_packs WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const approvals = db.prepare('SELECT id,status,decided_at,decision_actor_id,created_at FROM runtime_approvals WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const userInputs = db.prepare('SELECT id,status,answered_at,answered_by_actor_id,created_at FROM runtime_user_inputs WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const humanReviews = db.prepare('SELECT id,decision,created_at FROM human_reviews WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const deliveries = db.prepare('SELECT id,status,created_at,updated_at,completed_at,operation_id FROM deliveries WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);
  const runnerReceipts = db.prepare(`SELECT r.started_at,r.finished_at,r.status,a.error_code FROM runner_receipts r
    JOIN task_attempts a ON a.id=r.task_attempt_id JOIN executions e ON e.id=a.execution_id
    WHERE e.project_id=? AND r.created_at>=? AND r.created_at<=? ORDER BY r.created_at,r.id`).all(...params);
  const testResults = db.prepare('SELECT status,duration_ms,created_at FROM test_results WHERE project_id=? AND created_at>=? AND created_at<=? ORDER BY created_at,id').all(...params);

  const failures = operationRecords.filter((row) => ['failed', 'expired'].includes(row.status))
    .map((row) => ({ source: 'operation', operation_id: row.operation_id, ...failure('operation', row.owner, row.error_code || `operation_${row.status}`) }));
  const packedSelections = new Set(packs.map((row) => row.selection_id));
  return {
    project: { id: project.id, window },
    schema: { user_version: 9, migration_ledger: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    operations: {
      total: operationRecords.length,
      statuses: counts(operationRecords, (row) => row.status, 'status'),
      commands: counts(operationRecords, (row) => `${row.command}\0${row.owner}`, 'command', ([command, owner]) => ({ command, owner })),
      owners: counts(operationRecords, (row) => row.owner, 'owner'),
      records: operationRecords
    },
    executions: {
      total: executionRecords.length,
      root_runs: executionRecords.filter((row) => row.parent_execution_id == null).length,
      full_reruns: fullReruns,
      replans: executionRecords.filter((row) => row.parent_execution_id != null || row.replanned_from_stage != null).length,
      statuses: counts(executionRecords, (row) => row.status, 'status'),
      input_fingerprints: [...rootGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([fingerprint, count]) => ({ fingerprint, root_runs: count, full_reruns: Math.max(0, count - 1) })),
      records: executionRecords
    },
    task_attempts: {
      total: attempts.length,
      retries: attempts.filter((row) => Number(row.attempt_no) > 1).length,
      statuses: counts(attempts, (row) => row.status, 'status')
    },
    stage_checkpoints: {
      total: checkpoints.length,
      replays: operationRecords.filter((row) => row.command === 'execution.stage.replay').length,
      stages: STAGES.map((stage) => stageMetric(stage, checkpoints.filter((row) => row.stage === stage)))
    },
    workflow: {
      generations: { total: generations.length, retries: generations.filter((row) => Number(row.attempt) > 1 || row.retry_of_generation_id).length, attempts: generations.length, phases: counts(generations, (row) => row.phase, 'phase') },
      critics: { total: critics.length, statuses: counts(critics, (row) => row.status, 'status') },
      proposals: {
        workflow_total: workflowProposals.length,
        workflow_statuses: counts(workflowProposals, (row) => row.status, 'status'),
        semantic_total: semanticProposals.length,
        semantic_statuses: counts(semanticProposals, (row) => row.status, 'status')
      }
    },
    context: {
      selections: selections.length,
      packs: packs.length,
      token_budget: sum(selections, (row) => Number(row.token_budget)),
      token_used: sum(selections, (row) => Number(row.token_used)),
      pack_convergence_rate: selections.length ? round(selections.filter((row) => packedSelections.has(row.id)).length / selections.length) : null,
      pack_convergence_reason: selections.length ? null : 'no_persisted_context_selections'
    },
    human_intervention: {
      approvals: { total: approvals.length, decisions: approvals.filter((row) => row.decided_at && row.decision_actor_id).length, statuses: counts(approvals, (row) => row.status, 'status') },
      user_inputs: { total: userInputs.length, answered: userInputs.filter((row) => row.answered_at && row.answered_by_actor_id && row.status === 'approved').length, statuses: counts(userInputs, (row) => row.status, 'status') },
      human_reviews: { total: humanReviews.length, decisions: counts(humanReviews, (row) => row.decision, 'decision') },
      total_decisions: operationRecords.filter((row) => row.status === 'succeeded' && ['approval.decide', 'user.input.answer', 'user.input.cancel', 'quality.decision', 'brief.confirm', 'workflow.proposal.apply', 'proposal.apply', 'proposal.reject', 'proposal.undo'].includes(row.command)).length
    },
    measurable_durations: {
      delivery: durationMetric(operationRecords.filter((row) => row.command.startsWith('delivery.')).map((row) => row.duration_ms)),
      gate: durationMetric(testResults.map((row) => Number(row.duration_ms))),
      runner: durationMetric(runnerReceipts.map((row) => duration(row.started_at, row.finished_at)))
    },
    deliveries: { total: deliveries.length, statuses: counts(deliveries, (row) => row.status, 'status') },
    failures_by_owner: counts(failures, (row) => row.owner, 'owner'),
    failures_by_error_code: counts(failures, (row) => row.error_code, 'error_code'),
    failures_by_class: counts(failures, (row) => row.failure_class, 'failure_class'),
    failure_records: failures,
    failure_counting_basis: 'one-record-per-terminal-failed-generic-operation',
    manual_workarounds: { value: null, reason: 'not_persisted' },
    model_tokens: { value: null, reason: 'not_persisted' }
  };
}

export function classifyFailure(errorCode, owner = '') {
  const value = `${errorCode || 'unspecified'} ${owner || ''}`;
  if (EXTERNAL_FAILURE.test(value)) return 'external_dependency';
  if (PLATFORM_FAILURE.test(value)) return 'platform';
  return 'project_execution';
}

export function validateReceiptHash(receipt) {
  const { receipt_sha256: recorded, ...unsigned } = receipt || {};
  return /^[a-f0-9]{64}$/.test(String(recorded || '')) && sha256(canonicalJson(unsigned)) === recorded;
}

function validateDatabase(db) {
  if (db.prepare('SELECT family FROM schema_meta').get()?.family !== 'v3-clean') throw receiptError('development_receipt_schema_invalid');
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  const ledger = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version));
  if (version !== 9 || JSON.stringify(ledger) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9])) throw receiptError('development_receipt_schema_invalid', { user_version: version, migration_ledger: ledger });
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw receiptError('development_receipt_integrity_invalid');
}

function resolveWindow(db, project, requestedFrom, requestedTo) {
  const from = requestedFrom || iso(project.created_at, 'project.created_at');
  const candidates = [project.updated_at, from];
  for (const [table, column, timestamp] of [
    ['operations', 'project_id', 'COALESCE(completed_at,updated_at,created_at)'],
    ['executions', 'project_id', 'COALESCE(completed_at,updated_at,created_at)'],
    ['workflow_generations', 'project_id', 'COALESCE(completed_at,updated_at,created_at)'],
    ['context_selections', 'project_id', 'created_at'],
    ['context_packs', 'project_id', 'created_at'],
    ['runtime_approvals', 'project_id', 'COALESCE(decided_at,updated_at,created_at)'],
    ['runtime_user_inputs', 'project_id', 'COALESCE(answered_at,updated_at,created_at)'],
    ['deliveries', 'project_id', 'COALESCE(completed_at,updated_at,created_at)'],
    ['test_results', 'project_id', 'created_at']
  ]) {
    const row = db.prepare(`SELECT MAX(${timestamp}) AS value FROM ${table} WHERE ${column}=?`).get(project.id);
    if (row?.value) candidates.push(row.value);
  }
  const to = requestedTo || iso(candidates.sort().at(-1), 'window.to');
  if (Date.parse(from) > Date.parse(to)) throw receiptError('development_receipt_window_invalid');
  return { from, to, wall_clock_ms: Math.max(0, Date.parse(to) - Date.parse(from)) };
}

function commandOwnerRegistry() {
  const exact = new Map();
  for (const entry of CLEAN_COMMAND_REGISTRY) {
    if (!exact.has(entry.command_id)) exact.set(entry.command_id, new Set());
    exact.get(entry.command_id).add(entry.owner);
  }
  return { exact };
}

function resolveCommandOwner(commandId, registry) {
  const exact = registry.exact.get(commandId) || registry.exact.get(INTERNAL_COMMAND_PARENTS[commandId]);
  if (exact?.size === 1) return [...exact][0];
  return null;
}

function failure(source, owner, errorCode) { return { source, owner, error_code: errorCode, failure_class: classifyFailure(errorCode, owner) }; }
function terminalOperation(status) { return ['succeeded', 'failed', 'cancelled', 'expired'].includes(status); }
function terminalExecution(status) { return ['completed', 'failed', 'cancelled'].includes(status); }
function executionFingerprint(row) { return sha256(canonicalJson({ workflow: [row.workflow_id, row.workflow_revision, row.workflow_hash], brief: [row.brief_revision, row.brief_hash], repository: [row.repository_workspace_id, row.repository_revision, row.repository_hash], context: [row.context_pack_id, row.context_pack_hash], runner: [row.runner_profile_id, row.runner_profile_revision, row.runner_profile_hash], plan_sha256: row.plan_sha256 })); }
function groupCount(rows, key) { const result = new Map(); for (const row of rows) result.set(key(row), (result.get(key(row)) || 0) + 1); return result; }
function stageMetric(stage, rows) { const values = rows.map((row) => duration(row.operation_started_at, row.operation_completed_at || (terminalOperation(row.operation_status) ? row.operation_updated_at : null))).filter((value) => value != null); return { stage, checkpoints: rows.length, measured: values.length, duration_ms: values.length ? sum(values, (value) => value) : null, reason: values.length ? null : 'not_persisted_for_window' }; }
function durationMetric(values) { const measured = values.filter((value) => Number.isFinite(value)); return { duration_ms: measured.length ? sum(measured, (value) => value) : null, sample_count: measured.length, reason: measured.length ? null : 'not_persisted_for_window' }; }
function duration(start, end) { if (!start || !end) return null; const value = Date.parse(end) - Date.parse(start); return Number.isFinite(value) && value >= 0 ? value : null; }
function sum(rows, read) { return rows.reduce((total, row) => total + (Number(read(row)) || 0), 0); }
function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }

function counts(rows, key, label, enrich = null) {
  const values = new Map();
  for (const row of rows) {
    const value = String(key(row) ?? '');
    values.set(value, (values.get(value) || 0) + 1);
  }
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => {
    if (enrich) return { ...enrich(value.split('\0')), count };
    return { [label]: value, count };
  });
}

function stateSnapshot(home, databaseFile) {
  return {
    sqlite: hashFiles([databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`], path.dirname(databaseFile)),
    cas: hashDirectory(path.join(home, 'cas')),
    vault: hashDirectory(path.join(home, 'vault'))
  };
}

function hashDirectory(directory) {
  if (!fs.existsSync(directory)) return digestEntries([]);
  const files = [];
  walk(directory, directory, files);
  return digestEntries(files);
}

function hashFiles(files, relativeRoot) {
  return digestEntries(files.filter((file) => fs.existsSync(file)).map((file) => ({ path: path.relative(relativeRoot, file).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(file)), byte_length: fs.statSync(file).size })));
}

function walk(root, directory, output) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw receiptError('development_receipt_state_symlink');
    if (entry.isDirectory()) walk(root, file, output);
    else if (entry.isFile()) output.push({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(file)), byte_length: fs.statSync(file).size });
  }
}

function digestEntries(files) { const sorted = files.sort((left, right) => left.path.localeCompare(right.path)); return { sha256: sha256(canonicalJson(sorted)), file_count: sorted.length }; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function assertPublicReceipt(value) {
  const text = JSON.stringify(value);
  if (/(?:Bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|private[_-]?key|full[_-]?prompt|response[_-]?body|cas[_-]?content)/i.test(text)) throw receiptError('development_receipt_redaction_failed');
  if (/(?:[A-Za-z]:[\\/]|file:\/\/\/|\/(?:Users|home|tmp|private|var|workspace|mnt)\/)/.test(text)) throw receiptError('development_receipt_absolute_path_exposed');
}

function atomicWrite(target, payload) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(handle, payload, 'utf8'); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  try { fs.renameSync(temporary, target); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function iso(value, field) { const time = Date.parse(String(value || '')); if (!Number.isFinite(time)) throw receiptError('development_receipt_timestamp_invalid', { field }); return new Date(time).toISOString(); }
function inside(parent, child) { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function receiptError(code, details = null) { const error = new Error(code); error.code = code; error.details = details; return error; }
function publicErrorDetails(details) { if (!details || typeof details !== 'object') return null; return Object.fromEntries(Object.entries(details).filter(([key]) => !/path|home|file/i.test(key)).map(([key, value]) => [key, value])); }

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) {
  const exitCode = await main();
  if (exitCode) process.exitCode = exitCode;
}
