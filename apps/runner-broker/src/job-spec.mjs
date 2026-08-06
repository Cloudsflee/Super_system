import path from 'node:path';
import { AppError, assert } from '../../api/src/errors.mjs';
import { normalizeRelativePath } from '../../api/src/path-policy.mjs';

export const RESOURCE_PROFILES = Object.freeze({
  standard: { cpus: 2, memory: '4g', pids: 512, tmpfs: '1g' },
  light: { cpus: 1, memory: '1g', pids: 256, tmpfs: '256m' }
});

const BUNDLE_KEYS = new Set(['objective', 'acceptance', 'context_pack', 'context_pack_id', 'input_assets', 'output_paths', 'checks', 'retry_context', 'input_paths', 'prior_outputs_root']);
const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const KEYS = new Set([
  'task_id', 'execution_id', 'project_id', 'workspace_subpath', 'image_digest',
  'execution_mode', 'resource_profile', 'network_profile', 'input_paths',
  'output_paths', 'deadline_at', 'credential_ref', 'worktree_subpath',
  'baseline_sha', 'bundle', 'output_subpath', 'input_subpath', 'model'
]);

export function validateJobSpec(value, options = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid_job_spec', 'job spec must be an object');
  for (const key of Object.keys(value)) assert(KEYS.has(key), 'invalid_job_spec', `job spec field is not allowed: ${key}`);
  const runnerDigest = options.runnerDigest || process.env.AIWS_RUNNER_DIGEST;
  const registeredModel = String(options.model || process.env.AIWS_CODEX_MODEL || 'gpt-5.5');
  const dataRoot = options.dataRoot || '/var/lib/aiws';
  const taskId = String(value.task_id || '');
  const executionId = String(value.execution_id || '');
  const projectId = String(value.project_id || '');
  assert(/^[A-Za-z0-9_-]{1,100}$/.test(taskId), 'invalid_job_spec', 'task_id is invalid');
  assert(/^exe_[A-Za-z0-9]{8,}$/.test(executionId), 'invalid_job_spec', 'execution_id is invalid');
  assert(/^prj_[A-Za-z0-9]{8,}$/.test(projectId), 'invalid_job_spec', 'project_id is invalid');
  const workspaceSubpath = normalizeJobPath(value.workspace_subpath, 'workspace_subpath');
  const resolved = path.posix.resolve(dataRoot.replaceAll('\\', '/'), workspaceSubpath);
  const root = path.posix.resolve(dataRoot.replaceAll('\\', '/'));
  assert(resolved === root || resolved.startsWith(`${root}/`), 'invalid_job_spec', 'workspace path escapes registered data root');
  const projectRoot = `projects/${projectId}`;
  const executionWorktree = `${projectRoot}/worktrees/${executionId}`;
  assert(workspaceSubpath === projectRoot || workspaceSubpath === executionWorktree, 'invalid_job_spec', 'workspace is invalid or not bound to the execution');
  assert(typeof value.image_digest === 'string' && DIGEST.test(value.image_digest), 'invalid_job_spec', 'runner image must be pinned by digest');
  assert(!runnerDigest || value.image_digest === runnerDigest, 'invalid_job_spec', 'runner image digest is not registered');
  assert(['read', 'write', 'assist', 'test', 'review'].includes(value.execution_mode), 'invalid_job_spec', 'execution mode is invalid');
  const resourceProfile = String(value.resource_profile || 'standard');
  assert(Object.hasOwn(RESOURCE_PROFILES, resourceProfile), 'invalid_job_spec', 'resource profile is not allowed');
  const networkProfile = String(value.network_profile || 'none');
  assert(['none', 'model'].includes(networkProfile), 'invalid_job_spec', 'network profile is not allowed');
  if (networkProfile === 'model') assert(value.credential_ref != null, 'invalid_job_spec', 'model network requires a credential reference');
  const inputPaths = normalizePathList(value.input_paths, 'input_paths');
  const outputPaths = normalizePathList(value.output_paths, 'output_paths');
  const defaultInputSubpath = `inputs/${projectId}/${executionId}`;
  const inputSubpath = value.input_subpath == null ? defaultInputSubpath : normalizeJobPath(value.input_subpath, 'input_subpath');
  assert(inputSubpath === defaultInputSubpath, 'invalid_job_spec', 'input_subpath is not bound to the execution');
  if (value.model != null) assert(typeof value.model === 'string' && SAFE_MODEL.test(value.model) && value.model === registeredModel, 'invalid_job_spec', 'model is not registered');
  const deadline = Date.parse(value.deadline_at || '');
  assert(Number.isFinite(deadline) && deadline > Date.now() && deadline <= Date.now() + 15 * 60 * 1000, 'invalid_job_spec', 'deadline must be within 15 minutes');
  if (value.credential_ref != null) assert(/^cred_[A-Za-z0-9_-]{8,}$/.test(String(value.credential_ref)), 'invalid_job_spec', 'credential_ref is invalid');
  if (value.worktree_subpath != null) {
    const worktree = normalizeJobPath(value.worktree_subpath, 'worktree_subpath');
    assert(worktree === workspaceSubpath, 'invalid_job_spec', 'worktree must match workspace subpath');
  }
  const executionOutputRoot = `${projectRoot}/outputs/${executionId}`;
  const outputSubpath = value.output_subpath == null ? executionOutputRoot : normalizeJobPath(value.output_subpath, 'output_subpath');
  const outputResolved = path.posix.resolve(dataRoot.replaceAll('\\', '/'), outputSubpath);
  assert(outputResolved.startsWith(`${root}/`) && outputSubpath !== workspaceSubpath, 'invalid_job_spec', 'output path is invalid');
  const isolatedWorktree = workspaceSubpath.includes('/worktrees/');
  if (isolatedWorktree) assert(!(outputResolved === resolved || outputResolved.startsWith(`${resolved}/`) || resolved.startsWith(`${outputResolved}/`)), 'invalid_job_spec', 'output must be isolated from the workspace');
  if (value.output_subpath != null) {
    assert(outputSubpath === executionOutputRoot || outputSubpath.startsWith(`${executionOutputRoot}/`), 'invalid_job_spec', 'output is not bound to the execution');
  }
  if (value.baseline_sha != null) assert(/^[a-f0-9]{40}$/.test(String(value.baseline_sha)), 'invalid_job_spec', 'baseline_sha is invalid');
  const bundle = value.bundle == null ? null : validateTaskBundle(value.bundle);
  if (bundle) assert(JSON.stringify(bundle.output_paths) === JSON.stringify(outputPaths), 'invalid_job_spec', 'bundle output paths must match the job output paths');
  if (bundle?.input_paths?.length) assert(JSON.stringify(bundle.input_paths) === JSON.stringify(inputPaths), 'invalid_job_spec', 'bundle input paths must match the job input paths');
  return Object.freeze({
    task_id: taskId,
    execution_id: executionId,
    project_id: projectId,
    workspace_subpath: workspaceSubpath,
    image_digest: value.image_digest,
    execution_mode: value.execution_mode,
    resource_profile: resourceProfile,
    network_profile: networkProfile,
    input_paths: inputPaths,
    output_paths: outputPaths,
    deadline_at: new Date(deadline).toISOString(),
    credential_ref: value.credential_ref == null ? null : String(value.credential_ref),
    worktree_subpath: value.worktree_subpath == null ? workspaceSubpath : normalizeJobPath(value.worktree_subpath, 'worktree_subpath'),
    baseline_sha: value.baseline_sha == null ? null : String(value.baseline_sha),
    output_subpath: outputSubpath,
    input_subpath: inputSubpath,
    model: value.model == null ? registeredModel : value.model,
    bundle
  });
}

export function validateTaskBundle(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid_job_spec', 'bundle must be an object');
  for (const key of Object.keys(value)) assert(BUNDLE_KEYS.has(key), 'invalid_job_spec', `bundle field is not allowed: ${key}`);
  assert(typeof value.objective === 'string' && value.objective.trim().length > 0 && value.objective.length <= 20_000, 'invalid_job_spec', 'bundle objective is invalid');
  assert(Array.isArray(value.acceptance) && value.acceptance.length <= 32, 'invalid_job_spec', 'bundle acceptance is invalid');
  const checks = Array.isArray(value.checks) ? value.checks.map(String) : [];
  assert(checks.length === 2 && checks[0] === 'node_test' && checks[1] === 'git_diff_check', 'invalid_job_spec', 'bundle checks must use the fixed profile');
  const contextPack = value.context_pack == null ? null : JSON.parse(JSON.stringify(value.context_pack));
  assert(contextPack == null || JSON.stringify(contextPack).length <= 512_000, 'invalid_job_spec', 'bundle context pack is too large');
  const inputAssets = Array.isArray(value.input_assets) ? value.input_assets.slice(0, 64).map((asset) => ({
    id: String(asset?.id || ''), cas_hash: String(asset?.cas_hash || ''),
    name: normalizeJobPath(asset?.name || asset?.relative_path, 'bundle.input_assets.name'),
    relative_path: normalizeJobPath(asset?.relative_path || asset?.name, 'bundle.input_assets.relative_path')
  })) : [];
  assert(inputAssets.every((asset) => /^asset_[A-Za-z0-9]{8,}$/.test(asset.id) && /^[a-f0-9]{64}$/.test(asset.cas_hash) && asset.name === asset.relative_path), 'invalid_job_spec', 'bundle input asset is invalid');
  assertNoPathConflicts(inputAssets.map((asset) => asset.name), 'bundle.input_assets');
  const outputPaths = normalizePathList(value.output_paths, 'bundle.output_paths');
  const inputPaths = normalizePathList(value.input_paths, 'bundle.input_paths');
  const retryContext = value.retry_context == null ? null : {
    prior_error_code: String(value.retry_context.prior_error_code || '').slice(0, 120),
    failed_checks: Array.isArray(value.retry_context.failed_checks) ? value.retry_context.failed_checks.slice(0, 32).map((check) => ({ id: String(check?.id || '').slice(0, 80), exit_code: Number.isInteger(check?.exit_code) ? check.exit_code : null })) : [],
    security_summary: String(value.retry_context.security_summary || '').slice(0, 500),
    instruction: String(value.retry_context.instruction || '').slice(0, 2000)
  };
  return Object.freeze({
    objective: value.objective.trim(), acceptance: value.acceptance.map((item) => String(item).slice(0, 500)),
    context_pack: contextPack, context_pack_id: value.context_pack_id == null ? null : String(value.context_pack_id),
    input_assets: inputAssets, output_paths: outputPaths, checks, input_paths: inputPaths,
    retry_context: retryContext, prior_outputs_root: '/outputs'
  });
}

function normalizePathList(value, field) {
  assert(value == null || Array.isArray(value), 'invalid_job_spec', `${field} must be an array`);
  const paths = (value || []).slice(0, 64).map((item) => normalizeJobPath(item, field));
  assertNoPathConflicts(paths, field);
  return paths;
}

function assertNoPathConflicts(paths, field) {
  const sorted = [...new Set(paths)].sort();
  assert(sorted.length === paths.length, 'invalid_job_spec', `${field} contains a duplicate path`);
  for (let index = 1; index < sorted.length; index += 1) {
    assert(!sorted[index].startsWith(`${sorted[index - 1]}/`), 'invalid_job_spec', `${field} contains conflicting paths`);
  }
}

function normalizeJobPath(value, field) {
  try {
    const raw = String(value || '').replaceAll('\\', '/');
    assert(!raw.split('/').some((segment) => segment === '.' || segment === '..'), 'invalid_input', `${field} escapes the registered workspace`);
    const normalized = normalizeRelativePath(String(value || ''));
    assert(normalized.length <= 512 && !/[\0\r\n]/.test(normalized), 'invalid_input', `${field} contains unsupported characters`);
    assert(!normalized.split('/').some((segment) => segment === '.' || segment === '..'), 'invalid_input', `${field} escapes the registered workspace`);
    return normalized;
  } catch (error) {
    if (error?.code === 'invalid_job_spec') throw error;
    throw new AppError('invalid_job_spec', `${field} is invalid: ${error?.message || 'invalid path'}`, { status: 400 });
  }
}

export function redactJobSpec(spec) {
  const copy = JSON.parse(JSON.stringify(spec || {}));
  if (copy.credential_ref) copy.credential_ref = '[ephemeral]';
  return copy;
}

export function buildDockerArgs(spec, options = {}) {
  assert(spec && typeof spec === 'object', 'invalid_job_spec', 'job spec is required');
  const bound = validateJobSpec(spec, {
    dataRoot: options.dataRoot || '/var/lib/aiws',
    runnerDigest: options.runnerDigest || process.env.AIWS_RUNNER_DIGEST || spec.image_digest,
    model: options.model || process.env.AIWS_CODEX_MODEL || spec.model || 'gpt-5.5'
  });
  const profile = RESOURCE_PROFILES[bound.resource_profile];
  assert(profile, 'invalid_job_spec', 'resource profile is invalid');
  const dataVolume = options.dataVolume || 'aiws-data-v3';
  const runnerImage = options.runnerImage || bound.image_digest;
  assert(SAFE_VOLUME_NAME.test(dataVolume), 'invalid_job_spec', 'data volume is not a registered volume');
  assert(!/v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(dataVolume), 'invalid_job_spec', 'legacy data volume is forbidden');
  assert(DIGEST.test(String(bound.image_digest || '')), 'invalid_job_spec', 'runner image digest is invalid');
  assert(!runnerImage || runnerImage === bound.image_digest || /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:[a-f0-9]{64}$/i.test(String(runnerImage)), 'invalid_job_spec', 'runner image reference is not digest pinned');
  assert(SAFE_MODEL.test(String(bound.model || 'gpt-5.5')), 'invalid_job_spec', 'model is invalid');
  const workspaceSubpath = bound.workspace_subpath;
  const outputSubpath = bound.output_subpath;
  if (workspaceSubpath.includes('/worktrees/')) assert(outputSubpath !== workspaceSubpath && !outputSubpath.startsWith(`${workspaceSubpath}/`) && !workspaceSubpath.startsWith(`${outputSubpath}/`), 'invalid_job_spec', 'output must be isolated from the workspace');
  return [
    'run', '--rm', '--interactive', '--init', '--name', `aiws-runner-${bound.execution_id}-${bound.task_id}`,
    '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=codex-runner',
    '--label', `aiws.execution=${bound.execution_id}`, '--label', `aiws.task=${bound.task_id}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only',
    '--network', bound.network_profile === 'none' ? 'none' : 'aiws-runner-model',
    '--cpus', String(profile.cpus), '--memory', profile.memory, '--pids-limit', String(profile.pids),
    '--tmpfs', `/tmp:size=${profile.tmpfs},mode=1777`,
    '--mount', `type=volume,src=${dataVolume},dst=/workspace,volume-subpath=${workspaceSubpath}${bound.execution_mode === 'write' ? '' : ',readonly'}`,
    '--mount', `type=volume,src=${dataVolume},dst=/inputs,volume-subpath=${bound.input_subpath},readonly`,
    '--mount', `type=volume,src=${dataVolume},dst=/outputs,volume-subpath=${outputSubpath}`,
    '--tmpfs', '/tmp/codex-home:rw,size=64m,mode=700,uid=10001,gid=10001',
    '--workdir', '/workspace', runnerImage
  ];
}
