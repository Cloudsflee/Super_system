import path from 'node:path';
import { AppError, assert } from '../../api/src/errors.mjs';
import { normalizeRelativePath } from '../../api/src/path-policy.mjs';

export const RESOURCE_PROFILES = Object.freeze({
  standard: { cpus: 2, memory: '4g', pids: 512, tmpfs: '1g' },
  light: { cpus: 1, memory: '1g', pids: 256, tmpfs: '256m' }
});

const KEYS = new Set([
  'task_id', 'execution_id', 'project_id', 'workspace_subpath', 'image_digest',
  'execution_mode', 'resource_profile', 'network_profile', 'input_paths',
  'output_paths', 'deadline_at', 'credential_ref'
]);

export function validateJobSpec(value, options = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid_job_spec', 'job spec must be an object');
  for (const key of Object.keys(value)) assert(KEYS.has(key), 'invalid_job_spec', `job spec field is not allowed: ${key}`);
  const runnerDigest = options.runnerDigest || process.env.AIWS_RUNNER_DIGEST;
  const dataRoot = options.dataRoot || '/var/lib/aiws';
  const taskId = String(value.task_id || '');
  const executionId = String(value.execution_id || '');
  const projectId = String(value.project_id || '');
  assert(/^[A-Za-z0-9_-]{1,100}$/.test(taskId), 'invalid_job_spec', 'task_id is invalid');
  assert(/^exe_[A-Za-z0-9]{8,}$/.test(executionId), 'invalid_job_spec', 'execution_id is invalid');
  assert(/^prj_[A-Za-z0-9]{8,}$/.test(projectId), 'invalid_job_spec', 'project_id is invalid');
  const workspaceSubpath = normalizeRelativePath(String(value.workspace_subpath || ''));
  const resolved = path.posix.resolve(dataRoot.replaceAll('\\', '/'), workspaceSubpath);
  const root = path.posix.resolve(dataRoot.replaceAll('\\', '/'));
  assert(resolved === root || resolved.startsWith(`${root}/`), 'invalid_job_spec', 'workspace path escapes registered data root');
  assert(typeof value.image_digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.image_digest), 'invalid_job_spec', 'runner image must be pinned by digest');
  assert(!runnerDigest || value.image_digest === runnerDigest, 'invalid_job_spec', 'runner image digest is not registered');
  assert(['read', 'write', 'assist', 'test', 'review'].includes(value.execution_mode), 'invalid_job_spec', 'execution mode is invalid');
  const resourceProfile = String(value.resource_profile || 'standard');
  assert(Object.hasOwn(RESOURCE_PROFILES, resourceProfile), 'invalid_job_spec', 'resource profile is not allowed');
  const networkProfile = String(value.network_profile || 'none');
  assert(['none', 'github'].includes(networkProfile), 'invalid_job_spec', 'network profile is not allowed');
  const inputPaths = normalizePathList(value.input_paths, 'input_paths');
  const outputPaths = normalizePathList(value.output_paths, 'output_paths');
  const deadline = Date.parse(value.deadline_at || '');
  assert(Number.isFinite(deadline) && deadline > Date.now() && deadline <= Date.now() + 15 * 60 * 1000, 'invalid_job_spec', 'deadline must be within 15 minutes');
  if (value.credential_ref != null) assert(/^cred_[A-Za-z0-9_-]{8,}$/.test(String(value.credential_ref)), 'invalid_job_spec', 'credential_ref is invalid');
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
    credential_ref: value.credential_ref == null ? null : String(value.credential_ref)
  });
}

function normalizePathList(value, field) {
  assert(value == null || Array.isArray(value), 'invalid_job_spec', `${field} must be an array`);
  return (value || []).slice(0, 64).map((item) => normalizeRelativePath(String(item)));
}

export function redactJobSpec(spec) {
  const copy = { ...spec };
  if (copy.credential_ref) copy.credential_ref = '[ephemeral]';
  return copy;
}

export function buildDockerArgs(spec, options = {}) {
  const profile = RESOURCE_PROFILES[spec.resource_profile];
  const dataVolume = options.dataVolume || 'aiws-data-v3';
  const runnerImage = options.runnerImage || spec.image_digest;
  return [
    'run', '--rm', '--interactive', '--init', '--name', `aiws-runner-${spec.execution_id}-${spec.task_id}`,
    '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=codex-runner',
    '--label', `aiws.execution=${spec.execution_id}`, '--label', `aiws.task=${spec.task_id}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only',
    '--network', spec.network_profile === 'github' ? 'aiws-runner-egress' : 'none',
    '--cpus', String(profile.cpus), '--memory', profile.memory, '--pids-limit', String(profile.pids),
    '--tmpfs', `/tmp:size=${profile.tmpfs},mode=1777`,
    '--mount', `type=volume,src=${dataVolume},dst=/workspace,volume-subpath=${spec.workspace_subpath}`,
    '--workdir', '/workspace', runnerImage
  ];
}
