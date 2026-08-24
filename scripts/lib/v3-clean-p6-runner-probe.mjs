import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { signRunnerJobSpec, verifyRunnerReceipt } from '../../apps/api/src/clean/runner-protocol.mjs';

const execFileAsync = promisify(execFile);
export const TERMINAL_RUNNER_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'external_result_unknown']);

export function createServiceIdentity() { return generateKeyPairSync('ed25519'); }

export function signedSpec({
  identity, suffix, runnerType = 'host', imageDigest = '', executionMode = 'read',
  deadlineMs = 120_000, outputPaths = []
} = {}) {
  const now = Date.now();
  return signRunnerJobSpec({
    schema_version: 'runner.job-spec.v2', job_spec_id: `job_${suffix}`, execution_ref: `execution_${suffix}`,
    generation: 1, task_ref: `task_${suffix}`, attempt: 1, runner_profile_ref: `profile_${runnerType}_${suffix}`,
    runner_profile_revision: 1, runner_profile_hash: 'a'.repeat(64), image_digest: imageDigest,
    deadline_at: new Date(now + deadlineMs).toISOString(),
    capabilities: executionMode === 'write' ? ['network:none', 'workspace:read', 'workspace:write'] : ['network:none', 'workspace:read'],
    resource_profile: 'light', execution_mode: executionMode, input_refs: [], input_paths: ['README.md'],
    output_paths: outputPaths, check_ids: [], workspace_ref: `workspace_${suffix}`, workspace_hash: 'b'.repeat(64),
    context_pack_ref: `context_${suffix}`, context_pack_hash: 'c'.repeat(64),
    service_key_id: `runner_key_${suffix}`, created_at: new Date(now).toISOString()
  }, identity.privateKey, { now, expectedImageDigest: imageDigest || null });
}

export async function waitForRunner(adapter, jobId, context = {}, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await adapter.status(jobId, context);
    if (TERMINAL_RUNNER_STATES.has(String(value.status || ''))) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const error = new Error('runner_probe_timeout'); error.code = 'runner_probe_timeout'; throw error;
}

export function verifyTerminal(value, signed, expectedStatus = 'succeeded') {
  if (value?.status !== expectedStatus || !value?.receipt || !value?.signature || !value?.signer_public_key) {
    const error = new Error('runner_probe_terminal_receipt_missing'); error.code = 'runner_probe_terminal_receipt_missing'; throw error;
  }
  return verifyRunnerReceipt(value.receipt, value.signature, value.signer_public_key, {
    expectedJobSpecId: signed.spec.job_spec_id, expectedJobSpecHash: signed.spec_sha256
  });
}

export async function createDockerVolumeFixture(suffix) {
  const image = String(process.env.AIWS_P6_DOCKER_IMAGE || 'node:22-bookworm-slim');
  const inspected = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], dockerOptions());
  const digest = String(inspected.stdout || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) { const error = new Error('docker_digest_unavailable'); error.code = 'docker_digest_unavailable'; throw error; }
  const volume = `aiws-p6-${process.pid}-${randomBytes(5).toString('hex')}`;
  await execFileAsync('docker', ['volume', 'create', volume], dockerOptions());
  const paths = [
    `executions/execution_${suffix}/tasks/task_${suffix}`,
    `executions/execution_${suffix}/inputs`,
    `executions/execution_${suffix}/outputs/task_${suffix}`,
    `executions/execution_${suffix}_cancel/tasks/task_${suffix}_cancel`,
    `executions/execution_${suffix}_cancel/inputs`,
    `executions/execution_${suffix}_cancel/outputs/task_${suffix}_cancel`
  ];
  const script = "const fs=require('node:fs');for(const p of JSON.parse(process.env.AIWS_PATHS))fs.mkdirSync('/data/'+p,{recursive:true})";
  await execFileAsync('docker', ['run', '--rm', '--network', 'none', '-e', `AIWS_PATHS=${JSON.stringify(paths)}`, '--mount', `type=volume,src=${volume},dst=/data`, digest, 'node', '-e', script], dockerOptions(120_000));
  return { digest, volume, cleanup: () => execFileAsync('docker', ['volume', 'rm', '--force', volume], dockerOptions()).catch(() => undefined) };
}

export function publicReceipt(value) {
  return {
    status: value.receipt.status, receipt_id: value.receipt.receipt_id,
    job_spec_hash: value.receipt.job_spec_hash, stdout_sha256: value.receipt.stdout_sha256,
    stderr_sha256: value.receipt.stderr_sha256, output_sha256: value.receipt.output_sha256,
    exit_code: value.receipt.exit_code, output_paths: value.receipt.output_paths
  };
}

export function emitProbe(schemaVersion, callback) {
  return Promise.resolve().then(callback).then((receipt) => {
    process.stdout.write(`${JSON.stringify({ schema_version: schemaVersion, status: 'passed', provisional: false, ...receipt }, null, 2)}\n`);
  }).catch((error) => {
    const errorCode = String(error?.code || error?.name || 'probe_failed').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
    process.stdout.write(`${JSON.stringify({ schema_version: schemaVersion, status: 'provisional', provisional: true, error_code: errorCode }, null, 2)}\n`);
    process.exitCode = 2;
  });
}

function dockerOptions(timeout = 30_000) { return { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 }; }
