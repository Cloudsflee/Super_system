import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../apps/api/src/config.mjs';
import { BrokerClient, signedHeaders } from '../../apps/api/src/broker-client.mjs';
import { stageExecutionInputs, removeExecutionInputs } from '../../apps/api/src/input-staging.mjs';
import { GitHubIntegration, GitHubIntegrationError, repositoryGitArgs } from '../../apps/api/src/github-integration.mjs';
import { captureDiff, createWorktree, ensureExecutionExcludes, gitHead, gitStatus, initializeFixture, removeWorktree } from '../../apps/api/src/git-fixture.mjs';
import { normalizeRelativePath, assertReviewablePath, resolveWorkspacePath } from '../../apps/api/src/path-policy.mjs';
import { buildDockerArgs, redactJobSpec, validateJobSpec, validateTaskBundle } from '../../apps/runner-broker/src/job-spec.mjs';
import { normalizeJsonl, normalizeRunnerErrorCode } from '../../apps/runner-broker/src/runner-result.mjs';
import { brokerConfig, createBroker, start as startBroker } from '../../apps/runner-broker/server.mjs';
import { start as startApi } from '../../apps/api/server-legacy.mjs';
import { eventually, fixture, request, mutate, onboardProject } from './helpers.mjs';

const digest = `sha256:${'d'.repeat(64)}`;

test('strict configuration, path policy, and runner contracts reject unsafe values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-config-regression-'));
  const codexFile = path.join(root, 'codex.json');
  const githubFile = path.join(root, 'github.token');
  try {
    const base = { AIWS_RUNNER_DIGEST: digest, AIWS_BROKER_HMAC_SECRET: 's'.repeat(32), AIWS_CODEX_MODEL: 'fixture-model' };
    assert.equal(loadConfig(base).codexCredential, null);
    assert.throws(() => loadConfig({ ...base, AIWS_DOCKER_DATA_VOLUME: 'aiws-data-v23' }), /legacy_data_volume_forbidden/);
    assert.throws(() => loadConfig({ ...base, AIWS_DOCKER_DATA_VOLUME: 'bad volume' }), /data_volume_name_invalid/);
    assert.equal(loadConfig({ ...base, AIWS_BROKER_HMAC_SECRET_FILE: path.join(root, 'missing-secret') }).brokerSecret.length, 32);
    fs.writeFileSync(codexFile, JSON.stringify({ provider: 'openai', profile: 'default', model: 'fixture-model', api_key: 'fixture-key-123' }), { mode: 0o600 });
    fs.writeFileSync(githubFile, 'github-token-12345678', { mode: 0o600 });
    const configured = loadConfig({ ...base, AIWS_CODEX_SECRET_FILE: codexFile, AIWS_GITHUB_SECRET_FILE: githubFile, AIWS_GITHUB_REPOSITORY: 'OWNER/REPO', AIWS_GITHUB_FIXTURE_SHA: 'a'.repeat(40) });
    assert.equal(configured.codexCredential.auth, 'fixture-key-123');
    assert.equal(configured.githubCredential.token, 'github-token-12345678');
    fs.writeFileSync(codexFile, JSON.stringify({ provider: 'openai', model: 'other-model', api_key: 'fixture-key-123' }));
    assert.throws(() => loadConfig({ ...base, AIWS_CODEX_SECRET_FILE: codexFile }), /codex_model_mismatch/);
    fs.writeFileSync(codexFile, JSON.stringify({ provider: 'unsupported', api_key: 'fixture-key-123' }));
    assert.throws(() => loadConfig({ ...base, AIWS_CODEX_SECRET_FILE: codexFile }), /codex_secret_invalid/);
    assert.throws(() => loadConfig({ ...base, AIWS_CODEX_SECRET_FILE: path.join(root, 'missing') }), /codex_secret_unreadable/);
    fs.writeFileSync(codexFile, 'raw-token-12345678');
    assert.equal(loadConfig({ ...base, AIWS_CODEX_SECRET_FILE: codexFile }).codexCredential.auth, 'raw-token-12345678');
    fs.writeFileSync(codexFile, 'x');
    assert.throws(() => loadConfig({ ...base, AIWS_GITHUB_SECRET_FILE: codexFile }), /github_secret_invalid/);
    assert.throws(() => loadConfig({ ...base, AIWS_GITHUB_REPOSITORY: 'bad/repo/extra' }), /github_repository_invalid/);
    assert.throws(() => loadConfig({ ...base, AIWS_GITHUB_FIXTURE_SHA: 'x' }), /github_fixture_sha_invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  assert.equal(normalizeRelativePath('a\\b.txt'), 'a/b.txt');
  assert.throws(() => normalizeRelativePath('../escape'), /escapes/);
  assert.throws(() => normalizeRelativePath('/absolute'), /absolute/);
  assert.equal(assertReviewablePath('notes.md'), 'notes.md');
  assert.throws(() => assertReviewablePath('archive.zip'), /attachment/);
  assert.throws(() => resolveWorkspacePath('/tmp/root', '../outside'), /escapes/);

  const bundle = validateTaskBundle({
    objective: ' inspect ', acceptance: ['ok'], context_pack: { note: 'fixture' }, context_pack_id: 'pack_12345678',
    input_assets: [{ id: 'asset_12345678', cas_hash: 'a'.repeat(64), name: 'input.bin', relative_path: 'input.bin' }],
    input_paths: ['input.bin'], output_paths: ['out.txt'], checks: ['node_test', 'git_diff_check'],
    retry_context: { prior_error_code: 'runner_failed', failed_checks: [{ id: 'git_diff_check', exit_code: 1 }], security_summary: 'redacted', instruction: 'retry' }
  });
  assert.equal(bundle.objective, 'inspect');
  assert.equal(bundle.prior_outputs_root, '/outputs');
  assert.equal(bundle.retry_context.instruction, 'retry');
  const spec = validateJobSpec({
    task_id: 'inspect', execution_id: 'exe_contract1234', project_id: 'prj_contract1234',
    workspace_subpath: 'projects/prj_contract1234/worktrees/exe_contract1234', image_digest: digest,
    execution_mode: 'read', resource_profile: 'light', network_profile: 'none', input_paths: ['input.bin'], output_paths: ['out.txt'],
    input_subpath: 'inputs/prj_contract1234/exe_contract1234', output_subpath: 'projects/prj_contract1234/outputs/exe_contract1234',
    baseline_sha: 'b'.repeat(40), deadline_at: new Date(Date.now() + 60_000).toISOString(),
    bundle: { ...bundle }
  }, { runnerDigest: digest, model: 'codex-mini-latest' });
  assert.equal(spec.input_subpath, 'inputs/prj_contract1234/exe_contract1234');
  assert.equal(redactJobSpec({ credential_ref: 'cred_secret1234' }).credential_ref, '[ephemeral]');
  const args = buildDockerArgs(spec, { dataVolume: 'aiws-data-v3', runnerImage: `runner@${digest}` });
  assert.ok(args.includes('--network') && args.includes('none'));
  assert.throws(() => buildDockerArgs({ ...spec, network_profile: 'host' }, { dataVolume: 'aiws-data-v3', runnerImage: `runner@${digest}` }), /network/);
  assert.throws(() => buildDockerArgs({ ...spec, input_subpath: 'inputs/prj_other1234/exe_contract1234' }, { dataVolume: 'aiws-data-v3', runnerImage: `runner@${digest}` }), /bound/);
  assert.throws(() => buildDockerArgs({ ...spec, output_subpath: 'projects/prj_other1234/outputs/exe_contract1234' }, { dataVolume: 'aiws-data-v3', runnerImage: `runner@${digest}` }), /bound/);
  assert.throws(() => validateJobSpec({ ...spec, input_subpath: 'inputs/other/exe_contract1234' }, { runnerDigest: digest }), /bound/);
  assert.throws(() => validateTaskBundle({ objective: 'x', acceptance: [], checks: ['node_test'] }), /fixed profile/);
  assert.equal(normalizeRunnerErrorCode('runner_digest_mismatch'), 'runner_digest_mismatch');
  assert.equal(normalizeRunnerErrorCode('private_error'), 'runner_failed');
  const normalized = normalizeJsonl(Buffer.from('{"type":"thread.started","message":"Bearer sk-secret-value"}\n{"type":"turn.completed","usage":{"input_tokens":3,"bad":"x"}}'));
  assert.equal(normalized.events.length, 2);
  assert.doesNotMatch(normalized.summary, /sk-secret/);
  assert.equal(normalized.usage.input_tokens, 3);
  assert.throws(() => normalizeJsonl('x'.repeat(20), { maxBytes: 4 }), /too_large/);
});

test('execution input staging is isolated and uses hard-link or copy fallback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-staging-regression-'));
  const config = { home, casRoot: path.join(home, 'cas', 'sha256') };
  const content = Buffer.from([0, 1, 2, 255, 10]);
  const hash = createHash('sha256').update(content).digest('hex');
  const source = path.join(config.casRoot, hash.slice(0, 2), hash);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, content);
  try {
    const empty = stageExecutionInputs({ home, casRoot: path.join(home, 'missing-cas') }, 'prj_empty1234', 'exe_empty1234', []);
    assert.deepEqual(empty.assets, []);
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', null), /input_assets_invalid/);
    const first = stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ id: 'asset_stage1234', name: 'nested/input.bin', cas_hash: hash, byte_size: content.length, media_type: 'application/octet-stream' }]);
    const target = path.join(first.root, 'nested', 'input.bin');
    assert.deepEqual(fs.readFileSync(target), content);
    assert.equal(fs.statSync(target).ino, fs.statSync(source).ino);
    removeExecutionInputs(config, 'prj_stage1234', 'exe_stage1234');
    const originalLink = fs.linkSync;
    fs.linkSync = () => { throw new Error('links unsupported'); };
    try {
      const second = stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ id: 'asset_stage1234', name: 'copy.bin', cas_hash: hash }]);
      assert.deepEqual(fs.readFileSync(path.join(second.root, 'copy.bin')), content);
    } finally { fs.linkSync = originalLink; }
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ name: 'bad', cas_hash: 'x' }]), /hash_invalid/);
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ name: 'missing', cas_hash: 'e'.repeat(64) }]), /asset_missing/);
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ name: 'wrong-size.bin', cas_hash: hash, byte_size: content.length + 1 }]), /size_mismatch/);
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [
      { name: 'duplicate.bin', cas_hash: hash }, { name: 'duplicate.bin', cas_hash: hash }
    ]), /path_conflict/);
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [
      { name: 'parent', cas_hash: hash }, { name: 'parent/child.bin', cas_hash: hash }
    ]), /path_conflict/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('execution input staging rejects symlinked CAS objects and staging roots', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-staging-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-staging-outside-'));
  const config = { home, casRoot: path.join(home, 'cas', 'sha256') };
  const hash = 'f'.repeat(64);
  const source = path.join(config.casRoot, hash.slice(0, 2), hash);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const outsideFile = path.join(outside, 'outside.bin');
  fs.writeFileSync(outsideFile, 'outside');
  try {
    try { fs.symlinkSync(outsideFile, source, 'file'); }
    catch (error) {
      if (error?.code === 'EPERM') { t.skip('host does not permit file symlinks'); return; }
      throw error;
    }
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ name: 'input.bin', cas_hash: hash }]), /symlink/);
    fs.rmSync(source, { force: true });
    fs.writeFileSync(source, 'inside');
    const stagingParent = path.join(home, 'inputs', 'prj_stage1234');
    fs.mkdirSync(stagingParent, { recursive: true });
    fs.symlinkSync(outside, path.join(stagingParent, 'exe_stage1234'), 'junction');
    assert.throws(() => stageExecutionInputs(config, 'prj_stage1234', 'exe_stage1234', [{ name: 'input.bin', cas_hash: hash, byte_size: 6 }]), /symlink/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('Git capture handles excludes, rename/unicode/binary files, and cleanup guards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-git-regression-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-git-regression-second-'));
  try {
    const baseline = await initializeFixture(root);
    await ensureExecutionExcludes(root);
    assert.equal(await gitStatus(root), '');
    const worktree = path.join(root, 'worktrees', 'exe_git1234');
    await createWorktree(root, worktree, baseline);
    fs.renameSync(path.join(worktree, 'README.md'), path.join(worktree, '文档 file.md'));
    fs.writeFileSync(path.join(worktree, 'binary.bin'), Buffer.from([0, 255, 1, 2]));
    fs.writeFileSync(path.join(worktree, 'space name.txt'), 'line\n');
    const captured = await captureDiff(worktree, baseline);
    assert.ok(captured.files.some((item) => item.includes('文档')));
    assert.ok(captured.files.includes('binary.bin'));
    assert.match(captured.diff, /GIT binary patch|binary/);
    assert.match(captured.sha256, /^[a-f0-9]{64}$/);
    await removeWorktree(root, worktree);
    assert.equal(await gitHead(root), baseline);
    await assert.rejects(() => createWorktree(root, path.join(second, 'outside'), baseline), /outside/);
    await assert.rejects(() => removeWorktree(root, second), /outside/);
    await assert.rejects(() => initializeFixture(path.join(root, 'nonexistent'), 'unknown'), /unknown_fixture/);
    fs.writeFileSync(path.join(root, 'extra.txt'), 'extra');
    await assert.rejects(() => initializeFixture(root), /fixture_directory_not_empty|fixture_contents_mismatch|fixture_baseline_dirty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(second, { recursive: true, force: true }); }
});

test('broker retention, close, and client error paths stay bounded', async () => {
  assert.throws(() => brokerConfig({ AIWS_BROKER_EXECUTOR: 'docker', AIWS_RUNNER_DIGEST: digest, AIWS_RUNNER_IMAGE: 'runner:latest', AIWS_BROKER_HMAC_SECRET: 'short' }), /pinned|secret/);
  const broker = createBroker({ config: { secret: 'broker-regression-secret', dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-broker-regression-')), dataVolume: 'aiws-data-v3', runnerDigest: digest, runnerImage: `runner@${digest}`, executor: 'mock', model: 'codex-mini-latest' }, retentionMs: 10, maxTerminalJobs: 1 });
  try {
    broker.jobs.set('old', { status: 'completed', finished_at: new Date(1).toISOString(), created_at: new Date(1).toISOString() });
    broker.jobs.set('new', { status: 'completed', finished_at: new Date(1995).toISOString(), created_at: new Date(1995).toISOString() });
    broker.jobs.set('active', { status: 'running', created_at: new Date(1995).toISOString() });
    broker.pruneJobs(2000);
    assert.equal(broker.jobs.has('old'), false);
    assert.equal(broker.jobs.has('new'), true);
    assert.equal(broker.jobs.has('active'), true);
    broker.jobs.set('unknown', { status: 'unknown', finished_at: new Date(1995).toISOString(), created_at: new Date(1995).toISOString() });
    await broker.close();
    assert.equal(broker.jobs.has('active'), true);
    assert.equal(broker.jobs.get('unknown').status, 'unknown');
  } finally { await broker.close(); }

  const mock = new BrokerClient({ brokerMode: 'mock', runnerDigest: digest });
  assert.equal((await mock.probe()).executor, 'mock');
  const submitted = await mock.submit({ task_id: 't', execution_id: 'exe_mock1234', project_id: 'prj_mock1234', workspace_subpath: 'projects/prj_mock1234', image_digest: digest, execution_mode: 'read', output_paths: [], deadline_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await mock.status(submitted.job_id)).status, 'queued');
  await mock.cancel(submitted.job_id);
  assert.equal((await mock.status(submitted.job_id)).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal((await mock.status('job_missing')).status, 'unknown');
  const completedJob = await mock.submit({ task_id: 'complete', execution_id: 'exe_mock1234', project_id: 'prj_mock1234', workspace_subpath: 'projects/prj_mock1234', image_digest: digest, execution_mode: 'read', output_paths: ['out.txt'], deadline_at: new Date(Date.now() + 60_000).toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal((await mock.status(completedJob.job_id)).result.outcome, 'completed');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/fail')) return new Response(JSON.stringify({ error: { code: 'provider_failed', message: 'failed', details: { phase: 'probe' } } }), { status: 502, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, method: options.method }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const httpClient = new BrokerClient({ brokerMode: 'http', brokerUrl: 'http://broker.invalid', brokerSecret: 'x'.repeat(32), runnerDigest: digest, codexModel: 'fixture-model', codexCredential: { ref: 'cred_codex_default', profile: 'default', auth: 'fixture-key-12345678' } });
    assert.equal((await httpClient.request('GET', '/ok')).ok, true);
    await assert.rejects(() => httpClient.request('GET', '/fail'), (error) => error.code === 'provider_failed' && error.retryable === true);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(() => httpClient.request('GET', '/offline'), (error) => error.code === 'broker_unavailable' && error.retryable === true);
    globalThis.fetch = async (url, options) => new Response(JSON.stringify({ ok: true, route: String(url), method: options.method }), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal((await httpClient.codexProbe()).ok, true);
    assert.equal((await httpClient.submit({ task_id: 'task' })).ok, true);
    assert.equal((await httpClient.status('job id')).ok, true);
    assert.equal((await httpClient.cancel('job id')).ok, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('GitHub probe and delivery metadata are deterministic with injected API responses', async () => {
  assert.deepEqual(repositoryGitArgs('/var/lib/aiws/projects/prj_test1234', 'rev-parse', 'HEAD'), [
    '-c', 'safe.directory=/var/lib/aiws/projects/prj_test1234',
    '-C', '/var/lib/aiws/projects/prj_test1234',
    'rev-parse', 'HEAD'
  ]);
  const calls = [];
  const responses = new Map([
    ['/repos/OWNER/REPO', { full_name: 'OWNER/REPO', permissions: { pull: true, push: true } }],
    ['/repos/OWNER/REPO/git/ref/tags/aiws/fixture-baseline', { object: { sha: 'a'.repeat(40) } }],
    ['/repos/OWNER/REPO/git/ref/heads/aiws/projects/prj_test1234', { object: { sha: 'a'.repeat(40) } }],
    ['/repos/OWNER/REPO/pulls?state=all&head=OWNER%3Aaiws%2Fdeliveries%2Fdel_test1234&per_page=10', []],
    ['/repos/OWNER/REPO/git/ref/heads/aiws/deliveries/del_test1234', null]
  ]);
  const integration = new GitHubIntegration({ githubRepository: 'OWNER/REPO', githubCredential: { token: 'github-token-12345678' } }, {
    apiRoot: 'https://github.test',
    fetch: async (url, options) => {
      const requestPath = new URL(url).pathname + (new URL(url).search || '');
      calls.push({ method: options.method, requestPath, body: options.body ? JSON.parse(options.body) : null });
      if (requestPath === '/repos/OWNER/REPO/git/ref/heads/aiws/deliveries/del_test1234') return new Response('', { status: 404 });
      const value = responses.get(requestPath);
      if (value === undefined) return new Response(JSON.stringify({ html_url: 'https://github.test/pr/1', number: 1, state: 'open', draft: true, head: { sha: 'b'.repeat(40), ref: 'aiws/deliveries/del_test1234' } }), { status: 201, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const probe = await integration.probe('a'.repeat(40));
  assert.equal(probe.status, 'available');
  assert.equal((await integration.ensureProjectBranch('prj_test1234', 'a'.repeat(40))).sha, 'a'.repeat(40));
  const existing = await integration.findPullRequest('aiws/deliveries/del_test1234');
  assert.equal(existing, null);
  integration.ensureProjectBranch = async () => ({ branch: 'aiws/projects/prj_test1234', sha: 'a'.repeat(40) });
  integration.getRef = async (ref, options = {}) => ref === 'heads/aiws/deliveries/del_test1234' ? { object: { sha: 'b'.repeat(40) } } : options.missing ? null : { object: { sha: 'a'.repeat(40) } };
  integration.findPullRequest = async () => null;
  const submitted = await integration.submitDraft({ projectId: 'prj_test1234', deliveryId: 'del_test1234', baselineSha: 'a'.repeat(40), diff: '', title: 'Empty delivery', body: '' });
  assert.equal(submitted.draft, true);
  const mergeCalls = [];
  let pullReads = 0;
  integration.request = async (method, requestPath, body) => {
    mergeCalls.push({ method, requestPath, body });
    if (method === 'GET' && requestPath.endsWith('/pulls/1')) {
      pullReads += 1;
      return { number: 1, draft: pullReads === 1, merged: false, node_id: 'PR_node_1', head: { sha: 'b'.repeat(40) }, base: { ref: 'aiws/projects/prj_test1234' }, html_url: 'https://github.test/pr/1' };
    }
    if (method === 'POST' && requestPath === '/graphql') return { data: { markPullRequestReadyForReview: { pullRequest: { id: 'PR_node_1', isDraft: false } } } };
    if (method === 'PUT' && requestPath.endsWith('/pulls/1/merge')) return { merged: true, sha: 'c'.repeat(40) };
    if (method === 'DELETE') return {};
    if (method === 'GET' && requestPath.includes('/git/ref/heads/')) return { object: { sha: 'c'.repeat(40) } };
    throw new Error(`unexpected request: ${method} ${requestPath}`);
  };
  const merged = await integration.merge({ pullNumber: 1, expectedHeadSha: 'b'.repeat(40), branch: 'aiws/deliveries/del_test1234' });
  assert.equal(merged.merge_sha, 'c'.repeat(40));
  assert.ok(mergeCalls.some((call) => call.method === 'POST' && call.requestPath === '/graphql'));
  await assert.rejects(() => integration.merge({ pullNumber: 1, expectedHeadSha: 'd'.repeat(40), branch: 'aiws/deliveries/del_test1234' }), /head changed/);
  integration.request = async (method, requestPath) => {
    if (method === 'GET' && requestPath.endsWith('/pulls/2')) return { draft: true, merged: false, head: { sha: 'b'.repeat(40) }, base: { ref: 'aiws/projects/prj_test1234' } };
    throw new Error('unexpected request');
  };
  await assert.rejects(() => integration.merge({ pullNumber: 2, expectedHeadSha: 'b'.repeat(40) }), /identity is missing/);
  integration.request = async (method, requestPath) => {
    if (method === 'GET' && requestPath.endsWith('/pulls/3')) return { draft: false, merged: true, merge_commit_sha: 'c'.repeat(40), head: { sha: 'b'.repeat(40) }, base: { ref: 'aiws/projects/prj_test1234' }, html_url: 'https://github.test/pr/3' };
    if (method === 'GET' && requestPath.includes('/git/ref/heads/')) return { object: { sha: 'c'.repeat(40) } };
    throw new Error('unexpected request');
  };
  integration.getRef = async () => ({ object: { sha: 'c'.repeat(40) } });
  assert.equal((await integration.merge({ pullNumber: 3, expectedHeadSha: 'b'.repeat(40) })).base_sha, 'c'.repeat(40));
  integration.request = async (method, requestPath) => {
    if (method === 'GET' && requestPath.endsWith('/pulls/4')) return { draft: true, merged: false, node_id: 'PR_node_4', head: { sha: 'b'.repeat(40) }, base: { ref: 'aiws/projects/prj_test1234' } };
    if (method === 'POST' && requestPath === '/graphql') return { errors: [{ message: 'blocked' }] };
    throw new Error('unexpected request');
  };
  await assert.rejects(() => integration.merge({ pullNumber: 4, expectedHeadSha: 'b'.repeat(40) }), /did not mark/);
  const missingConfig = new GitHubIntegration({ githubRepository: '', githubCredential: null }, { fetch: integration.fetch });
  assert.equal((await missingConfig.probe()).error_code, 'credential_missing');
  await assert.rejects(() => missingConfig.request('GET', '/repos/x'), (error) => error instanceof GitHubIntegrationError && error.code === 'github_credential_missing');
  const missingRepository = new GitHubIntegration({ githubRepository: '', githubCredential: { token: 'github-token-12345678' } });
  assert.equal((await missingRepository.probe()).error_code, 'repository_missing');
  const offline = new GitHubIntegration({ githubRepository: 'OWNER/REPO', githubCredential: { token: 'github-token-12345678' } }, { fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(() => offline.request('GET', '/repos/OWNER/REPO'), (error) => error.code === 'github_api_unavailable');
  assert.ok(calls.length > 0);
});

test('GitHub integration maps repository, permission, fixture, and merge failures to fixed states', async () => {
  const config = { githubRepository: 'OWNER/REPO', githubCredential: { token: 'github-token-12345678' } };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const probeWith = (repository, fixture = { object: { sha: 'a'.repeat(40) } }) => new GitHubIntegration(config, {
    fetch: async (url) => String(url).includes('/git/ref/') ? response(fixture) : response(repository)
  });
  assert.equal((await probeWith({ full_name: 'OTHER/REPO', permissions: { pull: true, push: true } }).probe('a'.repeat(40))).error_code, 'github_repository_mismatch');
  assert.equal((await probeWith({ full_name: 'OWNER/REPO', permissions: { pull: false, push: true } }).probe('a'.repeat(40))).error_code, 'github_permission_missing');
  assert.equal((await probeWith({ full_name: 'OWNER/REPO', permissions: { pull: true, push: true } }, { object: { sha: 'b'.repeat(40) } }).probe('a'.repeat(40))).error_code, 'github_fixture_mismatch');

  const apiFailure = new GitHubIntegration(config, { fetch: async () => response({ message: 'failure' }, 500) });
  await assert.rejects(() => apiFailure.request('GET', '/repos/OWNER/REPO'), (error) => error.code === 'github_api_failed' && error.details.status === 500);

  const existing = new GitHubIntegration(config);
  existing.ensureProjectBranch = async () => ({ branch: 'aiws/projects/prj_test1234', sha: 'a'.repeat(40) });
  existing.findPullRequest = async () => ({ html_url: 'https://github.test/pr/9', number: 9, state: 'open', draft: true, head: { sha: 'b'.repeat(40) } });
  const reused = await existing.submitDraft({ projectId: 'prj_test1234', deliveryId: 'del_existing1234', baselineSha: 'a'.repeat(40), diff: '', title: 'Existing', body: '' });
  assert.equal(reused.number, 9);

  const declined = new GitHubIntegration(config);
  declined.request = async (method, requestPath) => {
    if (method === 'GET' && requestPath.endsWith('/pulls/5')) return { draft: false, merged: false, head: { sha: 'b'.repeat(40) }, base: { ref: 'aiws/projects/prj_test1234' } };
    if (method === 'PUT') return { merged: false };
    throw new Error('unexpected request');
  };
  await assert.rejects(() => declined.merge({ pullNumber: 5, expectedHeadSha: 'b'.repeat(40) }), /declined the merge/);
});

test('broker HTTP routes enforce the fixed envelope and lifecycle states', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-broker-http-regression-'));
  const secret = 'broker-http-regression-secret';
  const running = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, runnerImage: `runner@${digest}`, executor: 'mock', model: 'codex-mini-latest' } });
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const call = async (method, route, value, signed = true) => {
    const raw = value === undefined ? '' : JSON.stringify(value);
    const headers = signed ? signedHeaders(secret, method, route, raw) : {};
    const response = await fetch(`${base}${route}`, { method, headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
    return { response, json: await response.json().catch(() => ({})) };
  };
  const spec = {
    task_id: 'inspect', execution_id: 'exe_broker1234', project_id: 'prj_broker1234', workspace_subpath: 'projects/prj_broker1234',
    image_digest: digest, execution_mode: 'read', resource_profile: 'standard', network_profile: 'none', input_paths: [], output_paths: ['out.txt'],
    output_subpath: 'projects/prj_broker1234/outputs/exe_broker1234', deadline_at: new Date(Date.now() + 60_000).toISOString(),
    bundle: { objective: 'broker route', acceptance: [], input_assets: [], input_paths: [], output_paths: ['out.txt'], checks: ['node_test', 'git_diff_check'] }
  };
  try {
    assert.equal((await call('GET', '/health', undefined, false)).json.status, 'alive');
    assert.equal((await call('GET', '/internal/v1/probe')).json.ready, true);
    const badProbe = await call('POST', '/internal/v1/integrations/codex/probe', { model: 'codex-mini-latest', credential: null });
    assert.equal(badProbe.response.status, 400);
    const goodProbe = await call('POST', '/internal/v1/integrations/codex/probe', { model: 'codex-mini-latest', credential: { ref: 'cred_codex_default', profile: 'default', auth: 'fixture-key-12345678' } });
    assert.equal(goodProbe.json.error_code, 'deterministic_adapter');
    const modelWithoutCredential = await call('POST', '/internal/v1/jobs', { spec: { ...spec, network_profile: 'model', credential_ref: 'cred_codex_default' } });
    assert.equal(modelWithoutCredential.response.status, 400);
    const created = await call('POST', '/internal/v1/jobs', spec);
    assert.equal(created.response.status, 201);
    const completed = await eventually(async () => (await call('GET', `/internal/v1/jobs/${created.json.job_id}`)).json, (value) => value.status === 'completed');
    assert.equal(completed.result.outcome, 'completed');
    assert.equal((await call('POST', `/internal/v1/jobs/${created.json.job_id}/cancel`, {})).json.status, 'completed');
    assert.equal((await call('GET', '/internal/v1/jobs/job_missing')).response.status, 404);
    const malformed = await fetch(`${base}/internal/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    await running.close();
  } finally {
    await running.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('evidence failure can be discarded or retried with retained worktree', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-evidence-regression-'));
  const app = await startApi({ config: {
    version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0, home,
    databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas', 'sha256'),
    dataVolume: 'aiws-data-v3', brokerMode: 'mock', brokerSecret: 'evidence-regression-secret', runnerDigest: digest,
    codexAvailable: false, githubAvailable: false, testOnlyBypassSetupGate: true
  } });
  const env = { app, base: `http://127.0.0.1:${app.server.address().port}`, home, async close() { await app.close(); fs.rmSync(home, { recursive: true, force: true }); } };
  try {
    const draftProject = (await mutate(env.base, '/api/v1/projects', { name: 'Evidence recovery', repository: { source: { kind: 'fixture', id: 'designsignal-v1' } } }, 'ev-project')).json;
    const { project } = await onboardProject(env.base, draftProject, { content: { objective: 'evidence', acceptance: [] }, keyPrefix: 'evidence-onboarding' });
    await mutate(env.base, `/api/v1/projects/${project.id}/workflows`, { tasks: [{ id: 'writer', level: 1, mode: 'write', outputs: ['declared.txt'] }] }, 'ev-workflow');
    const first = (await mutate(env.base, `/api/v1/projects/${project.id}/executions`, {}, 'ev-exe-1')).json;
    await mutate(env.base, `/api/v1/executions/${first.id}/start`, { expected_revision: first.revision }, 'ev-start-1');
    const failed = await eventually(async () => (await request(env.base, `/api/v1/executions/${first.id}`)).json, (value) => value.status === 'failed' && value.runner?.evidence_status === 'failed');
    assert.equal(failed.runner.evidence_error_code, 'evidence_output_missing');
    const discarded = await mutate(env.base, `/api/v1/executions/${first.id}/evidence/resolve`, { action: 'discard_worktree', expected_revision: failed.revision }, 'ev-discard');
    assert.equal(discarded.json.status, 'failed');
    assert.ok(discarded.json.evidence.some((item) => item.name.includes('capture-error')));

    const second = (await mutate(env.base, `/api/v1/projects/${project.id}/executions`, {}, 'ev-exe-2')).json;
    await mutate(env.base, `/api/v1/executions/${second.id}/start`, { expected_revision: second.revision }, 'ev-start-2');
    const failedAgain = await eventually(async () => (await request(env.base, `/api/v1/executions/${second.id}`)).json, (value) => value.status === 'failed' && value.runner?.evidence_status === 'failed');
    const worktree = await env.app.database.get('SELECT worktree_path FROM repository_worktrees WHERE execution_id=?', [second.id]);
    fs.writeFileSync(path.join(env.home, worktree.worktree_path, 'declared.txt'), 'recovered\n');
    const retried = await mutate(env.base, `/api/v1/executions/${second.id}/evidence/resolve`, { action: 'retry_capture', expected_revision: failedAgain.revision }, 'ev-retry');
    assert.equal(retried.json.status, 'completed');
    assert.equal(retried.json.runner.evidence_status, 'captured');
    assert.ok(retried.json.evidence.some((item) => item.name.endsWith('declared.txt')));
  } finally { await env.close(); }
});
