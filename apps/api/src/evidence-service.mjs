import fs from 'node:fs';
import path from 'node:path';
import { asJson, id, now, parseJson, sha256 } from './crypto.mjs';
import { AppError } from './errors.mjs';
import { DIFF_MAX_BYTES, DiffCaptureError, captureDiff } from './git-fixture.mjs';
import { normalizeRelativePath, resolveWorkspacePath } from './path-policy.mjs';

function rowJson(row, field, fallback) {
  return row?.[field] == null ? fallback : parseJson(row[field], fallback);
}

function eventStatement(type, executionId, taskId, data) {
  return {
    sql: 'INSERT INTO events(type, execution_id, task_id, data_json, created_at) VALUES(?,?,?,?,?)',
    params: [type, executionId ?? null, taskId ?? null, asJson(data), now()]
  };
}

function mediaTypeForPath(relative) {
  const ext = path.extname(relative).toLowerCase();
  return { '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.diff': 'text/x-diff', '.patch': 'text/x-patch', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.css': 'text/css' }[ext] || 'application/octet-stream';
}

function regularFileWithoutSymlinks(root, relative) {
  const base = path.resolve(root);
  const target = resolveWorkspacePath(base, relative);
  const segments = path.relative(base, target).split(path.sep).filter(Boolean);
  let current = base;
  try {
    if (fs.lstatSync(current).isSymbolicLink()) return null;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return null;
    }
    return fs.lstatSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

function captureError(error) {
  if (error instanceof DiffCaptureError) return error;
  return new DiffCaptureError('evidence_capture_failed', 'evidence capture failed', { cause: String(error?.message || 'storage failure').slice(0, 240) });
}

export class EvidenceService {
  constructor({ db, config, prepareAsset, assetInsertStatements, cleanupPreparedAssets, sanitizeRunnerResult }) {
    this.db = db;
    this.config = config;
    this.prepareAsset = prepareAsset;
    this.assetInsertStatements = assetInsertStatements;
    this.cleanupPreparedAssets = cleanupPreparedAssets;
    this.sanitizeRunnerResult = sanitizeRunnerResult;
  }

  async prepareCapture(executionId, { terminalStatus = null } = {}) {
    const execution = await this.db.get('SELECT * FROM executions WHERE id=?', [executionId]);
    if (!execution) return { kind: 'missing', statements: [], prepared: [] };
    const repository = await this.db.get('SELECT * FROM repository_bindings WHERE project_id=?', [execution.project_id]);
    const worktree = await this.db.get('SELECT * FROM repository_worktrees WHERE execution_id=?', [executionId]);
    const existing = await this.db.get('SELECT * FROM execution_diffs WHERE execution_id=?', [executionId]);
    if (existing) {
      const statements = terminalStatus && execution.status !== terminalStatus
        ? [
            { sql: 'UPDATE executions SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', params: [terminalStatus, now(), executionId, execution.revision], expect_changes: 1 },
            eventStatement(`execution.${terminalStatus}`, executionId, null, {})
          ]
        : [];
      return { kind: 'existing', existing, execution, statements, prepared: [] };
    }

    const root = worktree?.worktree_path
      ? resolveWorkspacePath(this.config.home, worktree.worktree_path)
      : repository ? resolveWorkspacePath(this.config.home, repository.local_path) : null;
    const outputRoot = resolveWorkspacePath(this.config.home, `projects/${execution.project_id}/outputs/${executionId}`);
    const prepared = [];
    try {
      let captured = { diff: '', files: [], sha256: sha256(''), bytes: 0 };
      if (root && fs.existsSync(path.join(root, '.git'))) captured = await captureDiff(root, worktree?.baseline_sha || repository?.head_sha || 'HEAD');
      const secrets = [this.config.codexCredential?.auth, this.config.githubCredential?.token].filter(Boolean);
      if (secrets.length) {
        const diff = secrets.reduce((text, secret) => text.replaceAll(String(secret), '[redacted]'), captured.diff);
        captured = { ...captured, diff, bytes: Buffer.byteLength(diff), sha256: sha256(diff) };
      }
      if (captured.bytes > DIFF_MAX_BYTES) throw new DiffCaptureError('evidence_diff_too_large', 'captured diff exceeds 20 MiB', { bytes: captured.bytes, limit: DIFF_MAX_BYTES });

      const attemptsWithResults = await this.db.query("SELECT task_id,attempt_no,status,error_code,output_json FROM task_attempts WHERE execution_id=? ORDER BY task_id,attempt_no", [executionId]);
      const checkRecords = attemptsWithResults.flatMap((attempt) => {
        const output = this.sanitizeRunnerResult(rowJson(attempt, 'output_json', {}), secrets);
        return output.checks.map((check) => ({ task_id: attempt.task_id, attempt_no: attempt.attempt_no, status: attempt.status, ...check }));
      });
      const attemptRecords = attemptsWithResults.map((attempt) => {
        const output = this.sanitizeRunnerResult(rowJson(attempt, 'output_json', {}), secrets);
        return { task_id: attempt.task_id, attempt_no: attempt.attempt_no, status: attempt.status, error_code: attempt.error_code || null, outcome: output.outcome, summary: output.summary };
      });
      const baselineSha = /^[a-f0-9]{40}$/.test(String(worktree?.baseline_sha || repository?.head_sha || ''))
        ? String(worktree?.baseline_sha || repository?.head_sha) : '';
      const rollbackRef = baselineSha || 'HEAD';

      const diffAsset = await this.prepareAsset(execution.project_id, { name: `evidence/${executionId}.diff`, media_type: 'text/x-diff', content: captured.diff });
      prepared.push(diffAsset);
      const rollbackScript = `#!/bin/sh\nset -eu\nWORKTREE="${'${1:?worktree path required}'}"\ngit -C "$WORKTREE" reset --hard "${rollbackRef}"\ngit -C "$WORKTREE" clean -fd\n`;
      const rollbackAsset = await this.prepareAsset(execution.project_id, { name: `evidence/${executionId}-rollback.sh`, media_type: 'text/x-shellscript', content: rollbackScript });
      prepared.push(rollbackAsset);
      const reportAsset = await this.prepareAsset(execution.project_id, { name: `evidence/${executionId}-checks.json`, media_type: 'application/json', content: JSON.stringify({ execution_id: executionId, attempts: attemptRecords, checks: checkRecords, required_checks: ['node_test', 'git_diff_check'], files: captured.files, diff_sha256: captured.sha256, diff_bytes: captured.bytes }) });
      prepared.push(reportAsset);

      const workflow = await this.db.get('SELECT tasks_json FROM workflow_revisions WHERE project_id=? AND revision=?', [execution.project_id, execution.workflow_revision]);
      const workflowTasks = rowJson(workflow, 'tasks_json', []);
      const completedAttempts = await this.db.query("SELECT * FROM task_attempts WHERE execution_id=? AND status='completed'", [executionId]);
      const latestAttempts = new Map();
      for (const attempt of completedAttempts) {
        if (!latestAttempts.has(attempt.task_id) || latestAttempts.get(attempt.task_id).attempt_no < attempt.attempt_no) latestAttempts.set(attempt.task_id, attempt);
      }
      const seenOutputs = new Map();
      const taskOutputAssets = new Map();
      for (const task of workflowTasks) {
        if (!latestAttempts.has(task.id)) continue;
        const declaredAssets = [];
        for (const output of Array.isArray(task.outputs) ? task.outputs : []) {
          const relative = normalizeRelativePath(String(output));
          const candidate = (root ? regularFileWithoutSymlinks(root, relative) : null) || regularFileWithoutSymlinks(outputRoot, relative);
          if (!candidate) throw new DiffCaptureError('evidence_output_missing', `declared output is missing: ${relative}`, { path: relative, task_id: task.id });
          const outputSize = fs.statSync(candidate).size;
          if (outputSize > DIFF_MAX_BYTES) throw new DiffCaptureError('evidence_output_too_large', `declared output exceeds 20 MiB: ${relative}`, { path: relative, bytes: outputSize, limit: DIFF_MAX_BYTES });
          const bytes = fs.readFileSync(candidate);
          if (bytes.byteLength > DIFF_MAX_BYTES) throw new DiffCaptureError('evidence_output_too_large', `declared output exceeds 20 MiB: ${relative}`, { path: relative, bytes: bytes.byteLength, limit: DIFF_MAX_BYTES });
          if (secrets.some((secret) => bytes.includes(Buffer.from(String(secret), 'utf8')))) throw new DiffCaptureError('evidence_output_contains_secret', `declared output contains a credential: ${relative}`, { path: relative });
          let asset = seenOutputs.get(relative);
          if (!asset) {
            asset = await this.prepareAsset(execution.project_id, { name: `evidence/${executionId}/${relative}`, media_type: mediaTypeForPath(relative), content: bytes });
            prepared.push(asset);
            seenOutputs.set(relative, asset);
          }
          declaredAssets.push(asset);
        }
        taskOutputAssets.set(task.id, declaredAssets);
      }

      const statements = [
        ...prepared.flatMap((asset) => this.assetInsertStatements(asset, 'runner')),
        { sql: 'INSERT INTO execution_diffs(execution_id,project_id,baseline_sha,diff,files_json,diff_sha256,asset_version_id,created_at) VALUES(?,?,?,?,?,?,?,?)', params: [executionId, execution.project_id, baselineSha, captured.diff, asJson(captured.files), captured.sha256, diffAsset.id, now()] },
        { sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, diffAsset.id, 'execution', executionId, now()] },
        { sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, rollbackAsset.id, 'execution', executionId, now()] },
        { sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, reportAsset.id, 'execution', executionId, now()] }
      ];
      for (const taskId of latestAttempts.keys()) {
        statements.push({ sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, reportAsset.id, 'task', `${executionId}:${taskId}`, now()] });
        for (const asset of taskOutputAssets.get(taskId) || []) {
          statements.push({ sql: 'INSERT INTO evidence_links(id,project_id,asset_version_id,target_type,target_id,created_at) VALUES(?,?,?,?,?,?)', params: [id('evl'), execution.project_id, asset.id, 'task', `${executionId}:${taskId}`, now()] });
        }
      }
      for (const attempt of completedAttempts) {
        const task = workflowTasks.find((item) => item.id === attempt.task_id);
        const assets = (task?.outputs || []).map((output) => seenOutputs.get(normalizeRelativePath(String(output)))).filter(Boolean).map((asset) => ({ id: asset.id, cas_hash: asset.cas_hash }));
        const output = this.sanitizeRunnerResult(rowJson(attempt, 'output_json', {}), secrets);
        output.evidence_assets = assets;
        statements.push({ sql: 'UPDATE task_attempts SET output_json=? WHERE id=?', params: [asJson(output), attempt.id] });
      }
      if (terminalStatus) {
        statements.push(
          { sql: 'UPDATE executions SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status=?', params: [terminalStatus, now(), executionId, execution.status], expect_changes: 1 },
          eventStatement(`execution.${terminalStatus}`, executionId, null, {})
        );
      }
      return { kind: 'prepared', execution, prepared, statements };
    } catch (error) {
      await this.cleanupPreparedAssets(prepared);
      throw captureError(error);
    }
  }

  normalizeCommitError(error) {
    return captureError(error);
  }

  async executionDiff(executionId) {
    const execution = await this.db.get('SELECT id FROM executions WHERE id=?', [executionId]);
    if (!execution) throw new AppError('not_found', 'execution not found');
    const diff = await this.db.get('SELECT * FROM execution_diffs WHERE execution_id=?', [executionId]);
    if (!diff) return { execution_id: executionId, baseline_sha: '', files: [], diff: '', diff_sha256: sha256(''), diff_bytes: 0, captured: false, asset_url: null };
    return {
      execution_id: executionId,
      project_id: diff.project_id,
      baseline_sha: diff.baseline_sha,
      files: rowJson(diff, 'files_json', []),
      diff: diff.diff,
      diff_sha256: diff.diff_sha256,
      diff_bytes: Buffer.byteLength(String(diff.diff || '')),
      captured: true,
      asset_version_id: diff.asset_version_id,
      asset_url: diff.asset_version_id ? `/api/v1/assets/${diff.asset_version_id}/content` : null
    };
  }

  async executionEvidence(executionId) {
    return this.db.query("SELECT e.*, a.name, a.media_type, a.byte_size, a.cas_hash FROM evidence_links e JOIN asset_versions a ON a.id=e.asset_version_id WHERE (e.target_type='execution' AND e.target_id=?) OR (e.target_type='task' AND e.target_id LIKE ?) ORDER BY e.created_at", [executionId, `${executionId}:%`]);
  }
}
