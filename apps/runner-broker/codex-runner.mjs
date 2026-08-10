import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeJsonl } from './src/runner-result.mjs';
import { renderCodexConfig, CODEX_DEFAULT_MODEL } from './src/codex-config.mjs';

const execFileAsync = promisify(execFile);
const home = path.resolve(process.env.AIWS_RUNNER_CODEX_HOME || '/tmp/codex-home');
const workspaceRoot = path.resolve(process.env.AIWS_RUNNER_WORKSPACE_ROOT || '/workspace');
const inputsRoot = path.resolve(process.env.AIWS_RUNNER_INPUTS_ROOT || '/inputs');
const outputsRoot = path.resolve(process.env.AIWS_RUNNER_OUTPUTS_ROOT || '/outputs');
const codexBinary = String(process.env.AIWS_CODEX_BINARY || 'codex');
const sandboxMode = String(process.env.AIWS_RUNNER_SANDBOX || 'danger-full-access');
const schemaPath = path.join(home, 'result-schema.json');
const lastMessagePath = path.join(home, 'last-message.json');

function cleanup() {
  try { fs.rmSync(lastMessagePath, { force: true }); } catch {}
  try { fs.rmSync(schemaPath, { force: true }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

async function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) reject(new Error('runner_input_too_large'));
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function check(id, command, args, options = {}) {
  try {
    const { stdout = '' } = await execFileAsync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...options });
    return { id, passed: true, exit_code: 0, stdout_sha256: createHash('sha256').update(stdout).digest('hex') };
  } catch (error) {
    return { id, passed: false, exit_code: Number.isInteger(error.code) ? error.code : 1, stdout_sha256: createHash('sha256').update(String(error.stdout || '')).digest('hex') };
  }
}

function measureGitDiff(baseline, env, { cached = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', `safe.directory=${process.cwd()}`, 'diff', ...(cached ? ['--cached'] : []), '--no-ext-diff', '--binary', '--full-index', baseline || 'HEAD'], {
      env, stdio: ['ignore', 'pipe', 'pipe']
    });
    const digest = createHash('sha256');
    let bytes = 0;
    let exceeded = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (!exceeded) digest.update(chunk);
      if (bytes > 20 * 1024 * 1024 && !exceeded) {
        exceeded = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.resume();
    child.once('error', () => finish({ id: 'git_diff_check', passed: false, exit_code: 1, stdout_sha256: null, error_code: 'diff_size_check_failed' }));
    child.once('close', (code) => {
      if (exceeded) return finish({ id: 'git_diff_check', passed: false, exit_code: 413, stdout_sha256: null, error_code: 'evidence_diff_too_large' });
      if (code !== 0) return finish({ id: 'git_diff_check', passed: false, exit_code: code ?? 1, stdout_sha256: null, error_code: 'diff_size_check_failed' });
      finish({ id: 'git_diff_check', passed: true, exit_code: 0, stdout_sha256: digest.digest('hex') });
    });
  });
}

async function checkGitDiff(baseline, writable = true) {
  const gitPrefix = ['-c', `safe.directory=${process.cwd()}`];
  if (!writable) {
    const whitespace = await check('git_diff_whitespace', 'git', [...gitPrefix, 'diff', '--check', baseline || 'HEAD']);
    if (!whitespace.passed) return { id: 'git_diff_check', passed: false, exit_code: whitespace.exit_code, stdout_sha256: whitespace.stdout_sha256, error_code: 'diff_whitespace_error' };
    return measureGitDiff(baseline || 'HEAD', undefined, { cached: false });
  }
  const indexFile = path.join(home, `diff-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileAsync('git', [...gitPrefix, 'read-tree', baseline || 'HEAD'], { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
    await execFileAsync('git', [...gitPrefix, 'add', '--all', '--', '.'], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024, windowsHide: true });
    const [whitespace, size] = await Promise.all([
      check('git_diff_whitespace', 'git', [...gitPrefix, 'diff', '--cached', '--check', baseline || 'HEAD'], { env }),
      measureGitDiff(baseline || 'HEAD', env)
    ]);
    if (!size.passed) return size;
    if (!whitespace.passed) return { id: 'git_diff_check', passed: false, exit_code: whitespace.exit_code, stdout_sha256: whitespace.stdout_sha256, error_code: 'diff_whitespace_error' };
    return size;
  } catch (error) {
    return { id: 'git_diff_check', passed: false, exit_code: Number.isInteger(error.code) ? error.code : 1, stdout_sha256: null, error_code: 'diff_size_check_failed' };
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch {}
    try { fs.rmSync(`${indexFile}.lock`, { force: true }); } catch {}
  }
}

async function run() {
  const input = await readInput();
  const job = JSON.parse(input || '{}');
  if (!['read', 'write', 'assist', 'test', 'review', 'probe'].includes(job.mode)) throw new Error('runner_mode_invalid');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandboxMode)) throw new Error('runner_sandbox_invalid');
  if (!job.bundle || typeof job.bundle !== 'object') throw new Error('runner_bundle_missing');

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(schemaPath, JSON.stringify({
    type: 'object',
    properties: { summary: { type: 'string', maxLength: 500 } },
    required: ['summary'],
    additionalProperties: false
  }), { mode: 0o600 });
  fs.writeFileSync(`${home}/config.toml`, renderCodexConfig({
    model: job.profile?.model || job.model || CODEX_DEFAULT_MODEL,
    provider: job.profile?.provider || 'openai',
    baseUrl: job.profile?.base_url || '',
    wireApi: job.profile?.wire_api || 'responses',
    reasoning: job.profile?.reasoning || 'medium'
  }), { mode: 0o600 });
  if (job.credential?.auth) {
    const auth = job.credential.kind === 'codex_oauth_bundle'
      ? JSON.parse(String(job.credential.auth))
      : { OPENAI_API_KEY: String(job.credential.auth) };
    fs.writeFileSync(`${home}/auth.json`, JSON.stringify(auth), { mode: 0o600 });
  }

  const prompt = JSON.stringify({
    task_id: job.task_id,
    objective: job.mode === 'probe' ? 'Reply with ok.' : job.bundle.objective,
    acceptance: job.bundle.acceptance,
    context_pack: job.bundle.context_pack,
    input_assets: (job.bundle.input_assets || []).map((asset) => ({ ...asset, relative_path: asset.relative_path || asset.name })),
    input_paths: job.input_paths || job.bundle.input_paths || [],
    prior_outputs_root: job.bundle.prior_outputs_root || '/outputs',
    output_paths: job.bundle.output_paths,
    checks: job.bundle.checks,
    workspace: workspaceRoot,
    inputs_root: inputsRoot,
    outputs_root: outputsRoot,
    output_policy: job.mode === 'write' ? 'Modify only declared output_paths in the workspace.' : 'Return the requested analysis in the final summary; the runner persists it in the output directory.',
    retry_context: job.bundle.retry_context || null,
    mode: job.mode
  });
  const args = [
    'exec', '--skip-git-repo-check',
    // Docker is the enforced sandbox; nested bwrap namespaces are unavailable on
    // the production kernel, so Codex runs without a second user-namespace layer.
    '--sandbox', sandboxMode,
    '--ephemeral', '--json',
    '--output-schema', schemaPath,
    '--output-last-message', lastMessagePath,
    ...(job.model ? ['--model', String(job.model)] : []),
    '-'
  ];
  const runnerEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, CODEX_HOME: home };
  if (job.credential?.auth && job.credential.kind !== 'codex_oauth_bundle') runnerEnv.OPENAI_API_KEY = String(job.credential.auth);
  const child = spawn(codexBinary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: runnerEnv
  });
  child.stdin.end(prompt);
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let outputTooLarge = false;
  let stderrPresent = false;
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes <= 2 * 1024 * 1024) stdoutChunks.push(chunk);
    else if (!outputTooLarge) {
      outputTooLarge = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', () => { stderrPresent = true; });
  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => { if (!settled) { settled = true; resolve(code); } };
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
  });
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  if (job.mode !== 'write' && job.mode !== 'probe' && Array.isArray(job.output_paths) && fs.existsSync(lastMessagePath)) {
    let declaration = fs.readFileSync(lastMessagePath, 'utf8');
    try { declaration = String(JSON.parse(declaration)?.summary || declaration); } catch {}
    for (const relative of job.output_paths) {
      const target = path.resolve(outputsRoot, String(relative));
      if (!target.startsWith(`${outputsRoot}${path.sep}`)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o770 });
      fs.writeFileSync(target, `${declaration.trim()}\n`, { encoding: 'utf8', mode: 0o660 });
    }
  }
  const checks = job.mode === 'probe' ? [] : [await check('node_test', 'node', ['--test']), await checkGitDiff(job.baseline_sha || 'HEAD', job.mode === 'write')];
  let changedFiles = [];
  try {
    const { stdout: status } = await execFileAsync('git', ['-c', `safe.directory=${process.cwd()}`, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    changedFiles = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replaceAll('\\', '/')).slice(0, 100);
  } catch {}
  const passed = exitCode === 0 && !outputTooLarge && checks.every((item) => item.passed);
  const normalized = outputTooLarge
    ? { summary: 'Runner output exceeded the size limit', events: [], usage: {} }
    : normalizeJsonl(stdout, { secrets: [job.credential?.auth] });
  if (!normalized.summary && fs.existsSync(lastMessagePath)) {
    try {
      const secret = String(job.credential?.auth || '');
      normalized.summary = String(JSON.parse(fs.readFileSync(lastMessagePath, 'utf8'))?.summary || '').replaceAll(secret, secret ? '[redacted]' : '').replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 500);
    } catch {}
  }
  const failedCheckCode = checks.find((item) => !item.passed && item.error_code)?.error_code || null;
  return {
    outcome: passed ? 'completed' : 'failed',
    summary: normalized.summary || (passed ? 'Codex runner completed' : `Codex runner failed with code ${exitCode}`),
    changed_files: changedFiles,
    checks,
    events: normalized.events,
    output_paths: Array.isArray(job.output_paths) ? job.output_paths : [],
    usage: normalized.usage,
    exit_code: exitCode,
    stdout_sha256: createHash('sha256').update(stdout).digest('hex'),
    stderr_present: stderrPresent,
    error_code: passed ? null : outputTooLarge ? 'runner_output_too_large' : job.mode === 'probe' ? 'provider_failed' : failedCheckCode || 'runner_failed'
  };
}

let result;
try {
  result = await run();
} catch (error) {
  const detail = String(error?.message || 'runner_setup_failed')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
  result = { outcome: 'failed', summary: `Runner setup failed: ${detail}`, changed_files: [], checks: [], events: [], output_paths: [], usage: {}, exit_code: 1, error_code: 'runner_setup_failed' };
} finally {
  cleanup();
}
process.stdout.write(JSON.stringify(result));
if (result.outcome !== 'completed') process.exitCode = 1;
