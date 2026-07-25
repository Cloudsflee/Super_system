import fsp from 'node:fs/promises';
import path from 'node:path';

import { EXECUTION_DIR } from './config.mjs';
import { commandAsync } from './http.mjs';
import { assertDeliveryPath } from './repository-delivery-domain.mjs';
import { updateRepositoryLineHeadInState, verifyRepositoryLineHead } from './repository-line-service.mjs';
import { redactKnownSecretsSync } from './vault.mjs';

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/,
  /(?:password|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i
];

export async function finalizeRepositoryChangeInState(state, execution, line) {
  if (!line?.checkout_path) throw verifierError('repository_line_checkout_missing');
  const previousSha = line.head_sha;
  await verifyRepositoryLineHead(line, previousSha);
  const policy = approvedPolicy(state, execution, line);
  if (!policy.automation_permissions?.includes('commit')) throw verifierError('repository_commit_permission_required');
  const changedFiles = await changedRepositoryFiles(line.checkout_path);
  if (!changedFiles.length) throw verifierError('repository_change_required');
  for (const file of changedFiles) assertDeliveryPath(policy, file.path);
  const secretFiles = await scanChangedFiles(line.checkout_path, changedFiles);
  if (secretFiles.length) throw verifierError('repository_secret_scan_failed', { files: secretFiles });
  await git(line.checkout_path, ['add', '-A', '--', ...changedFiles.map((item) => item.path)], 60_000);
  const staged = splitZero(await git(line.checkout_path, ['diff', '--cached', '--name-only', '-z', '--']));
  if (!staged.length) throw verifierError('repository_no_staged_changes');
  if (staged.some((item) => !changedFiles.some((file) => file.path === item)))
    throw verifierError('repository_staged_path_mismatch');
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id);
  await git(
    line.checkout_path,
    [
      '-c',
      'user.name=AI Workspace',
      '-c',
      'user.email=aiws@local.invalid',
      'commit',
      '-m',
      `feat(aiws): ${clean(task?.title || execution.task_id, 100)}`
    ],
    120_000
  );
  const commitSha = await updateRepositoryLineHeadInState(state, line, previousSha);
  const verified = await verifyRepositoryLineHead(line, commitSha, { requireClean: true });
  const payload = await repositoryPayload(line, execution, previousSha, commitSha, changedFiles);
  return {
    repository_sha: commitSha,
    commit_sha: commitSha,
    checkout_head: verified.repository_sha,
    previous_sha: previousSha,
    changed_files: changedFiles,
    repository_payload: payload,
    evidence_refs: [`commit:${commitSha}`]
  };
}

async function changedRepositoryFiles(root) {
  const tracked = splitZero(await git(root, ['diff', '--name-only', '-z', 'HEAD', '--']));
  const untracked = splitZero(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']));
  const paths = [...new Set([...tracked, ...untracked])];
  if (paths.length > 2_000) throw verifierError('repository_changed_file_limit_exceeded');
  return Promise.all(
    paths.map(async (file) => {
      if (!file || /[\0\r\n]/.test(file) || path.isAbsolute(file))
        throw verifierError('repository_changed_path_invalid', { path: file });
      const stat = await fsp.stat(path.resolve(root, file)).catch(() => null);
      return {
        path: file.replaceAll('\\', '/'),
        status: untracked.includes(file) ? 'added' : stat ? 'modified' : 'deleted'
      };
    })
  );
}

async function scanChangedFiles(root, files) {
  const findings = [];
  for (const file of files.filter((item) => item.status !== 'deleted')) {
    const target = path.resolve(root, file.path),
      stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const content = await fsp.readFile(target, 'utf8').catch(() => '');
    if (redactKnownSecretsSync(content) !== content || SECRET_PATTERNS.some((pattern) => pattern.test(content)))
      findings.push(file.path);
  }
  return findings;
}

async function repositoryPayload(line, execution, previousSha, commitSha, changedFiles) {
  const outputRoot = path.resolve(EXECUTION_DIR, execution.workflow_execution_id, execution.id, 'outputs');
  await fsp.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(outputRoot, `${commitSha}.bundle`);
  await git(line.checkout_path, ['bundle', 'create', bundlePath, 'HEAD', `^${previousSha}`], 120_000);
  const [bundle, diff] = await Promise.all([
    fsp.readFile(bundlePath),
    git(line.checkout_path, ['diff', '--binary', '--full-index', previousSha, commitSha, '--'], 120_000)
  ]);
  await fsp.rm(bundlePath, { force: true });
  if (bundle.length > 64 * 1024 * 1024) throw verifierError('repository_bundle_too_large');
  const manifest = {
    schema_version: 'aiws.repository_version.v1',
    repository_sha: commitSha,
    previous_sha: previousSha,
    branch: line.branch,
    changed_files: changedFiles
  };
  return {
    payload_kind: 'git_bundle_diff',
    media_type: 'application/vnd.aiws.repository-version+json',
    files: [
      {
        path: 'repository-version.json',
        role: 'metadata',
        media_type: 'application/json',
        content: JSON.stringify(manifest)
      },
      { path: 'changes.diff', role: 'diff', media_type: 'text/x-diff; charset=utf-8', content: diff },
      { path: 'repository.bundle', role: 'git_bundle', media_type: 'application/x-git-bundle', content: bundle }
    ],
    metadata: manifest
  };
}

function approvedPolicy(state, execution, line) {
  const policy = state.delivery_policies
    .filter(
      (item) =>
        item.workstream_id === execution.workstream_id &&
        item.connection_id === line.connection_id &&
        item.status === 'approved' &&
        (!item.expires_at || Date.parse(item.expires_at) > Date.now())
    )
    .sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at)))[0];
  if (!policy) throw verifierError('delivery_policy_approval_required');
  return policy;
}

async function git(root, args, timeout = 30_000) {
  const result = await commandAsync('git', args, root, timeout);
  if (!result.ok)
    throw verifierError('repository_git_command_failed', {
      args,
      detail: String(result.stderr || result.error || '').slice(-4000)
    });
  return String(result.stdout || '');
}

function splitZero(value) {
  return String(value || '')
    .split('\0')
    .filter(Boolean);
}
function clean(value, max) {
  return String(value || '')
    .replace(/[\0\r\n]/g, ' ')
    .trim()
    .slice(0, max);
}
function verifierError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
