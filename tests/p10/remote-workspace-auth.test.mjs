import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { GithubRepositoryAdapter, RepositoryAdapterRouter } from '../../apps/api/src/clean/github-repository-adapter.mjs';
import { GitHubAppAdapter } from '../../apps/api/src/clean/p8/github-adapter.mjs';
import { PlatformError } from '../../apps/api/src/clean/platform-error.mjs';
import { open as openRuntime, close as closeRuntime } from './helpers.mjs';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const README_BLOB = 'db057b0981c86e56573a2fe1287146463418fcfe';
const README = Buffer.from('remote workspace\n');

test('GitHub repository transport mints an RS256 JWT and validates the complete API manifest', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const calls = [];
  const fetchImpl = repositoryFetch({ calls, token: 'TOKEN', tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: README_BLOB, size: README.length }] });
  const adapter = new GitHubAppAdapter({ fetchImpl, apiBaseUrl: 'https://api.fixture', clock: () => 1_700_000_000_000 });

  const result = await adapter.inspectRepository(
    { appId: '4255971', installationId: '17', privateKey: privateKeyPem },
    { repositoryId: 42, fullName: 'ORG/REPO', branch: 'main', expectedHeadSha: HEAD }
  );

  assert.equal(result.repository_id, '42');
  assert.equal(result.full_name, 'ORG/REPO');
  assert.equal(result.api_head_sha, HEAD);
  assert.equal(result.file_count, 1);
  assert.equal(result.total_bytes, README.length);
  assert.deepEqual(calls.map((call) => call.path), [
    '/app/installations/17/access_tokens',
    '/repos/ORG/REPO',
    `/repos/ORG/REPO/git/ref/heads/main`,
    `/repos/ORG/REPO/commits/${HEAD}`,
    `/repos/ORG/REPO/git/trees/${TREE}?recursive=1`,
    `/repos/ORG/REPO/git/blobs/${README_BLOB}`
  ]);

  const tokenCall = calls[0];
  const jwt = String(tokenCall.headers.authorization).slice('Bearer '.length);
  const [headerPart, payloadPart, signaturePart] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.equal(payload.iss, '4255971');
  assert.equal(payload.iat, 1_699_999_940);
  assert.equal(payload.exp, 1_700_000_540);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url')), true);
  assert.ok(calls.slice(1).every((call) => call.headers.authorization === 'Bearer TOKEN'));
  assert.ok(calls.every((call) => !call.url.includes('TOKEN')));
});

test('GitHub repository transport rejects identity, branch, tree, blob and source feature drift with stable codes', async (t) => {
  const cases = [
    ['repository id', { repository: { id: 99 } }, 'github_repository_id_mismatch'],
    ['full name', { repository: { full_name: 'ORG/OTHER' } }, 'github_repository_full_name_mismatch'],
    ['branch head', { ref: { object: { sha: 'd'.repeat(40) } } }, 'github_branch_head_mismatch'],
    ['tree truncated', { tree: { truncated: true, tree: [] } }, 'repository_source_too_large'],
    ['symlink', { tree: [{ path: 'link', mode: '120000', type: 'blob', sha: 'd'.repeat(40) }] }, 'repository_source_invalid'],
    ['submodule', { tree: [{ path: 'sub', mode: '160000', type: 'commit', sha: 'd'.repeat(40) }] }, 'repository_submodule_unsupported'],
    ['LFS pointer', { blobs: { [README_BLOB]: Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:x\nsize 1\n') } }, 'repository_lfs_unsupported'],
    ['malformed blob', { blobs: { [README_BLOB]: { encoding: 'base64', content: '%%%INVALID%%%' } } }, 'github_blob_invalid'],
    ['file quota', { tree: [{ path: 'one', mode: '100644', type: 'blob', sha: '56a6051ca2b02b04ef92d5150c9ef600403cb1de', size: 1 }, { path: 'two', mode: '100644', type: 'blob', sha: 'd8263ee9860594d2806b0dfd1bfd17528b0ba2a4', size: 1 }], blobs: { '56a6051ca2b02b04ef92d5150c9ef600403cb1de': Buffer.from('1'), 'd8263ee9860594d2806b0dfd1bfd17528b0ba2a4': Buffer.from('2') }, maxFiles: 1 }, 'repository_source_too_large'],
    ['byte quota', { maxBytes: 1 }, 'repository_source_too_large']
  ];
  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const fetchImpl = repositoryFetch({ ...overrides, token: 'TOKEN' });
      const adapter = new GitHubAppAdapter({ fetchImpl, apiBaseUrl: 'https://api.fixture', maxFiles: overrides.maxFiles || 10_000, maxBytes: overrides.maxBytes || 100 * 1024 * 1024 });
      await assert.rejects(
        () => adapter.inspectRepository({ appId: '1', installationId: '1', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) }, { repositoryId: 42, fullName: 'ORG/REPO', branch: 'main', expectedHeadSha: HEAD }),
        (error) => error?.code === (overrides.code || expected)
      );
    });
  }
});

test('materialization uses shell-free shallow clone, keeps token out of argv/config, removes .git, and clears key material', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyBuffer = Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const calls = [];
  const fetchImpl = repositoryFetch({ calls, token: 'TOKEN' });
  const execCalls = [];
  const execFileImpl = async (_file, args, options) => {
    execCalls.push({ args: [...args], options: { ...options, env: { ...options.env } } });
    if (args.includes('clone')) {
      const destination = args.at(-1);
      fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'README.md'), README);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    const commandIndex = args.indexOf('-C');
    const command = args[commandIndex + 2];
    if (command === 'rev-parse') return { stdout: Buffer.from(args.at(-1).includes('^{tree}') ? TREE : HEAD), stderr: Buffer.alloc(0) };
    if (command === 'ls-tree') return { stdout: Buffer.from(`100644 blob ${README_BLOB}\tREADME.md\0`), stderr: Buffer.alloc(0) };
    throw new Error(`unexpected_git_command:${command}`);
  };
  const adapter = new GitHubAppAdapter({ fetchImpl, execFileImpl, apiBaseUrl: 'https://api.fixture' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-remote-materialize-'));
  const destination = path.join(root, 'workspace');
  try {
    const result = await adapter.materializeRepository(
      { appId: '1', installationId: '1', privateKey: privateKeyBuffer },
      { repositoryId: 42, fullName: 'ORG/REPO', branch: 'main', expectedHeadSha: HEAD, destination }
    );
    assert.equal(result.commit_sha, HEAD);
    assert.equal(fs.existsSync(path.join(destination, '.git')), false);
    assert.equal(fs.readFileSync(path.join(destination, 'README.md'), 'utf8'), README.toString('utf8'));
    const clone = execCalls.find((call) => call.args.includes('clone'));
    assert.ok(clone);
    assert.equal(clone.options.shell, false);
    assert.equal(clone.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(clone.options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(clone.options.env.GIT_CONFIG_NOGLOBAL, '1');
    assert.equal(clone.options.env.GIT_CONFIG_VALUE_0, 'Authorization: Bearer TOKEN');
    assert.ok(!clone.args.includes('TOKEN'));
    assert.ok(!JSON.stringify(result).includes('TOKEN'));
    assert.ok(privateKeyBuffer.every((byte) => byte === 0));
    assert.equal(calls.filter((call) => call.path.includes('/access_tokens')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('materialization reports source_drift and removes a mismatching clone', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-remote-drift-'));
  const destination = path.join(root, 'workspace');
  const execFileImpl = async (_file, args) => {
    if (args.includes('clone')) {
      fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'README.md'), README);
      return { stdout: Buffer.from('TOKEN'), stderr: Buffer.from('TOKEN') };
    }
    const commandIndex = args.indexOf('-C');
    const command = args[commandIndex + 2];
    if (command === 'rev-parse') return { stdout: Buffer.from(HEAD.replace(/^a/, 'e')), stderr: Buffer.alloc(0) };
    if (command === 'ls-tree') return { stdout: Buffer.from(`100644 blob ${README_BLOB}\tREADME.md\0`), stderr: Buffer.alloc(0) };
    throw new Error(`unexpected_git_command:${command}`);
  };
  const adapter = new GitHubAppAdapter({ fetchImpl: repositoryFetch({ token: 'TOKEN' }), execFileImpl, apiBaseUrl: 'https://api.fixture' });
  try {
    await assert.rejects(() => adapter.materializeRepository({ appId: '1', installationId: '1', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) }, { repositoryId: 42, fullName: 'ORG/REPO', branch: 'main', expectedHeadSha: HEAD, destination }), (error) => error?.code === 'source_drift');
    assert.equal(fs.existsSync(destination), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Repository auth resolver enforces actor, provider, lifecycle, credential and Vault reference boundaries', async (t) => {
  const transport = {
    async inspectRepository() { return { revision: HEAD, hash: 'f'.repeat(64) }; },
    async materializeRepository() { return { revision: HEAD, hash: 'f'.repeat(64) }; }
  };
  const principal = { actorId: 'actor-current' };
  const cases = [
    ['other actor', { owner_actor_id: 'actor-other', provider: 'github', status: 'available', lifecycle_status: 'enabled', credential: { status: 'active', external_ref: 'vault:x' } }, 'permission_denied'],
    ['wrong provider', { owner_actor_id: 'actor-current', provider: 'git', status: 'available', lifecycle_status: 'enabled', credential: { status: 'active', external_ref: 'vault:x' } }, 'github_profile_unavailable'],
    ['disabled', { owner_actor_id: 'actor-current', provider: 'github', status: 'available', lifecycle_status: 'disabled', credential: { status: 'active', external_ref: 'vault:x' } }, 'github_profile_unavailable'],
    ['unavailable', { owner_actor_id: 'actor-current', provider: 'github', status: 'unavailable', lifecycle_status: 'enabled', credential: { status: 'active', external_ref: 'vault:x' } }, 'github_profile_unavailable'],
    ['revoked credential', { owner_actor_id: 'actor-current', provider: 'github', status: 'available', lifecycle_status: 'enabled', credential: { status: 'revoked', external_ref: 'vault:x' } }, 'credential_rebind_required'],
    ['non-Vault credential', { owner_actor_id: 'actor-current', provider: 'github', status: 'available', lifecycle_status: 'enabled', credential: { status: 'active', external_ref: 'inline:x' } }, 'credential_rebind_required']
  ];
  for (const [name, profile, expected] of cases) {
    await t.test(name, async () => {
      const adapter = new GithubRepositoryAdapter({ githubTransport: transport, authResolver: async () => ({ auth: { appId: '1' }, profile, credential: profile.credential }) });
      await assert.rejects(() => adapter.probe({ provider_profile_id: 'profile-1', full_name: 'ORG/REPO', branch: 'main' }, principal), (error) => error?.code === expected);
    });
  }
  const adapter = new GithubRepositoryAdapter({
    githubTransport: transport,
    authResolver: async () => ({ auth: { appId: '1' }, profile: { owner_actor_id: principal.actorId, provider: 'github', status: 'available', lifecycle_status: 'enabled' }, credential: { status: 'active', external_ref: 'vault:x' } })
  });
  const result = await adapter.probe({ provider_profile_id: 'profile-1', full_name: 'ORG/REPO', branch: 'main' }, principal);
  assert.equal(result.revision, HEAD);
});

test('Repository adapter router preserves fixture/local routing and selects GitHub only for explicit App sources', async () => {
  const calls = [];
  const local = { bindSource: (source) => source, probe: async () => { calls.push('local-probe'); return {}; }, materialize: async () => { calls.push('local-materialize'); return {}; } };
  const github = { bindSource: (source) => source, probe: async () => { calls.push('github-probe'); return {}; }, materialize: async () => { calls.push('github-materialize'); return {}; } };
  const router = new RepositoryAdapterRouter({ local, github });
  await router.probe({ provider: 'fixture', kind: 'git', locator: 'fixture/repo' }, {});
  await router.probe({ provider: 'git', kind: 'git', full_name: 'ORG/REPO', provider_profile_id: 'profile-1' }, {});
  assert.deepEqual(calls, ['local-probe', 'github-probe']);
});

test('remote Workspace create/refresh publishes atomically, preserves failed bytes, and links retries', async () => {
  const transport = new RemoteFixtureTransport();
  const state = await openRuntime({ config: { providerMode: 'process' }, githubAdapter: transport });
  try {
    const { runtime, principal } = state;
    const project = await runtime.project.createProject({ name: 'Remote workspace lifecycle', idempotency_key: 'remote-project-key' }, principal);
    const credential = await runtime.identity.createCredential({ provider: 'github', external_ref: 'remote-profile-credential', idempotency_key: 'remote-credential-key' }, principal);
    const proof = JSON.stringify({ app_id: '1', installation_id: '1', private_key: 'PRIVATE_KEY' });
    await runtime.identity.rebindCredential(credential.credential.id, { proof, expected_revision: credential.credential.revision, idempotency_key: 'remote-credential-bind' }, principal);
    const profile = await runtime.identity.createProfile({ provider: 'github', label: 'Remote App', credential_ref_id: credential.credential.id, config: { app_id: '1', installation_id: '1' }, idempotency_key: 'remote-profile-key' }, principal);
    runtime.db.run("UPDATE provider_profiles SET status='available' WHERE id=?", [profile.profile.id]);

    const connection = await runtime.project.createRepositoryConnection(project.id, {
      provider: 'git', source_kind: 'git', source_locator: 'ORG/REPO', full_name: 'ORG/REPO', repository_id: 42,
      branch: 'main', provider_profile_id: profile.profile.id, idempotency_key: 'remote-connection-key'
    }, principal);
    const storedConnection = runtime.db.get('SELECT * FROM repository_connections WHERE id=?', [connection.connection.id]);
    const metadata = JSON.parse(storedConnection.metadata_json);
    assert.equal(metadata.host, 'github.com');
    assert.equal(metadata.repository_id, '42');
    assert.equal(metadata.repository_full_name, 'ORG/REPO');
    assert.equal(metadata.api_head_sha, HEAD);
    assert.equal(metadata.manifest_hash, 'd'.repeat(64));
    assert.equal(Object.keys(metadata).some((key) => /token|private|secret|credential_bundle/i.test(key)), false);
    assert.equal(transport.inspectCalls, 1);

    const replayedConnection = await runtime.project.createRepositoryConnection(project.id, {
      provider: 'git', source_kind: 'git', source_locator: 'ORG/REPO', full_name: 'ORG/REPO', repository_id: 42,
      branch: 'main', provider_profile_id: profile.profile.id, idempotency_key: 'remote-connection-key'
    }, principal);
    assert.equal(replayedConnection.replayed, true);
    assert.equal(transport.inspectCalls, 1);

    const line = runtime.project.listRepositoryLines(project.id, principal)[0];
    const created = await runtime.project.createRepositoryWorkspace(project.id, { line_id: line.id, relative_path: 'projects/remote-workspace', expected_revision: 0, idempotency_key: 'remote-workspace-key' }, principal);
    assert.equal(created.workspace.status, 'ready');
    assert.equal(created.workspace.revision, 3);
    const workspaceDirectory = path.join(runtime.config.workspaceRoot, created.workspace.relative_path);
    assert.equal(fs.readFileSync(path.join(workspaceDirectory, 'README.md'), 'utf8'), README.toString('utf8'));
    assert.equal(runtime.db.get('SELECT status FROM operations WHERE id=?', [created.operation.operation_id]).status, 'succeeded');
    assert.ok(runtime.db.get("SELECT id FROM events WHERE operation_id=? AND type='workspace.refreshed'", [created.operation.operation_id]));

    fs.writeFileSync(path.join(workspaceDirectory, 'README.md'), 'old-successful-copy\n');
    transport.failMaterialize = true;
    await assert.rejects(() => runtime.project.refreshRepositoryWorkspace(created.workspace.id, { expected_revision: 3, idempotency_key: 'remote-refresh-failing' }, principal), (error) => error?.code === 'repository_materialization_failed');
    assert.equal(fs.readFileSync(path.join(workspaceDirectory, 'README.md'), 'utf8'), 'old-successful-copy\n');
    const failedOperation = runtime.db.get("SELECT * FROM operations WHERE command_id='repository.workspace.refresh' AND resource_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [created.workspace.id]);
    assert.equal(failedOperation.status, 'failed');
    assert.equal(runtime.db.get('SELECT revision,status FROM repository_workspaces WHERE id=?', [created.workspace.id]).revision, 3);

    transport.failMaterialize = false;
    const refreshed = await runtime.project.refreshRepositoryWorkspace(created.workspace.id, { expected_revision: 3, idempotency_key: 'remote-refresh-retry' }, principal);
    assert.equal(refreshed.workspace.status, 'ready');
    assert.equal(refreshed.workspace.revision, 4);
    assert.equal(runtime.db.get('SELECT relation FROM operation_links WHERE operation_id=? AND aggregate_id=? AND relation=\'retry_of\'', [refreshed.operation.operation_id, failedOperation.id]).relation, 'retry_of');

    const locked = await runtime.project.lockRepositoryWorkspace(created.workspace.id, { expected_revision: 4, idempotency_key: 'remote-lock-key' }, principal);
    await assert.rejects(() => runtime.project.refreshRepositoryWorkspace(created.workspace.id, { expected_revision: locked.workspace.revision, idempotency_key: 'remote-locked-refresh' }, principal), (error) => error?.code === 'state_conflict');

    const failedProject = await runtime.project.createProject({ name: 'Remote workspace failed create', idempotency_key: 'remote-failed-project-key' }, principal);
    const failedConnection = await runtime.project.createRepositoryConnection(failedProject.id, {
      provider: 'git', source_kind: 'git', source_locator: 'ORG/REPO', full_name: 'ORG/REPO', repository_id: 42,
      branch: 'main', provider_profile_id: profile.profile.id, idempotency_key: 'remote-failed-connection-key'
    }, principal);
    const failedLine = runtime.project.listRepositoryLines(failedProject.id, principal)[0];
    transport.failMaterialize = true;
    await assert.rejects(() => runtime.project.createRepositoryWorkspace(failedProject.id, { line_id: failedLine.id, relative_path: 'projects/remote-failed-workspace', expected_revision: 0, idempotency_key: 'remote-failed-workspace-key' }, principal), (error) => error?.code === 'repository_materialization_failed');
    const failedWorkspace = runtime.db.get('SELECT * FROM repository_workspaces WHERE project_id=?', [failedProject.id]);
    assert.equal(failedWorkspace.status, 'orphaned');
    assert.equal(runtime.db.get('SELECT status FROM operations WHERE id=?', [failedWorkspace.owner_operation_id]).status, 'failed');
    assert.equal(fs.existsSync(path.join(runtime.config.workspaceRoot, failedWorkspace.relative_path)), false);
    void failedConnection;
  } finally {
    await closeRuntime(state);
  }
});

class RemoteFixtureTransport {
  constructor() { this.inspectCalls = 0; this.materializeCalls = 0; this.failMaterialize = false; }
  async inspectRepository(_auth, input) {
    this.inspectCalls += 1;
    return {
      repository_id: '42', full_name: input.fullName, branch: input.branch, revision: HEAD, commit_sha: HEAD, tree_sha: TREE,
      api_head_sha: HEAD, hash: 'd'.repeat(64), manifest_hash: 'd'.repeat(64), file_count: 1, total_bytes: README.length,
      entries: [{ path: 'README.md', mode: '100644', blob_sha1: README_BLOB, sha256: sha256Hex(README), byte_length: README.length }]
    };
  }
  async materializeRepository(_auth, input) {
    this.materializeCalls += 1;
    if (this.failMaterialize) throw new PlatformError('repository_materialization_failed', 'fixture materialization failed', {}, 422);
    fs.mkdirSync(input.destination, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(input.destination, 'README.md'), README, { mode: 0o600 });
    const manifest = [{ path: 'README.md', sha256: sha256Hex(README), byte_length: README.length }];
    return { repository_id: '42', full_name: input.fullName, branch: input.branch, revision: HEAD, commit_sha: HEAD, tree_sha: TREE, api_head_sha: HEAD, hash: 'd'.repeat(64), manifest_hash: 'd'.repeat(64), file_count: 1, total_bytes: README.length, workspace_manifest: manifest, workspace_hash: sha256Hex(canonicalJson(manifest)) };
  }
}

function repositoryFetch({ calls = [], token = 'TOKEN', repository = {}, ref = {}, tree = null, blobs = {} } = {}) {
  const repositoryValue = { id: 42, full_name: 'ORG/REPO', ...repository };
  const refValue = { object: { sha: HEAD }, ...ref };
  const defaultBlob = blobs[README_BLOB];
  const defaultSize = Buffer.isBuffer(defaultBlob)
    ? defaultBlob.length
    : (typeof defaultBlob?.content === 'string' ? Buffer.from(defaultBlob.content.replace(/\s+/g, ''), 'base64').length : README.length);
  const treeValue = tree && !Array.isArray(tree) ? tree : { truncated: false, tree: tree || [{ path: 'README.md', mode: '100644', type: 'blob', sha: README_BLOB, size: defaultSize }] };
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const call = { url: String(url), path: `${parsed.pathname}${parsed.search}`, method: init.method || 'GET', headers: init.headers || {}, body: init.body || null };
    calls.push(call);
    if (parsed.pathname.startsWith('/app/installations/') && parsed.pathname.endsWith('/access_tokens')) return json({ token });
    if (parsed.pathname === '/repos/ORG/REPO') return json(repositoryValue);
    if (parsed.pathname.endsWith('/git/ref/heads/main')) return json(refValue);
    if (parsed.pathname.endsWith(`/commits/${HEAD}`)) return json({ commit: { tree: { sha: TREE } } });
    if (parsed.pathname.endsWith(`/git/trees/${TREE}`)) return json(treeValue);
    if (parsed.pathname.includes('/git/blobs/')) {
      const sha = parsed.pathname.split('/').at(-1);
      const value = blobs[sha] || { encoding: 'base64', content: README.toString('base64'), sha };
      if (Buffer.isBuffer(value)) return json({ encoding: 'base64', content: value.toString('base64'), sha });
      return json(value);
    }
    return json({ message: 'unexpected route' }, 500);
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'x-github-request-id': 'fixture-request' } });
}

// Keep these imports exercised in this focused test; they also document the
// manifest hash formula used by the production transport.
void canonicalJson;
void sha256Hex;
void PlatformError;
