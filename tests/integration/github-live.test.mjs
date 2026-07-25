import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

if (process.env.RUN_GITHUB_LIVE_TESTS !== '1') {
  console.log('github live tests skipped; set RUN_GITHUB_LIVE_TESTS=1 to run');
  process.exit(0);
}

const repository = process.env.AIWS_TEST_GITHUB_REPO;
const token = process.env.AIWS_TEST_GITHUB_TOKEN;
const serviceBaseUrl = normalizeBaseUrl(process.env.AIWS_TEST_LIVE_BASE_URL);
assert.match(repository || '', /^[^/\s]+\/[^/\s]+$/, 'AIWS_TEST_GITHUB_REPO must be owner/repo');
assert.equal(
  process.env.AIWS_TEST_GITHUB_CONFIRM,
  'dedicated-write-test',
  'dedicated GitHub write-test confirmation is required'
);

const runId = safeRunId(
  `${process.env.AIWS_TEST_RUN_ID || Date.now()}-${process.env.AIWS_TEST_REQUEST_ID || process.pid}`
);
if (serviceBaseUrl) await runServiceVaultMode();
else {
  assert.ok(token, 'AIWS_TEST_GITHUB_TOKEN or AIWS_TEST_LIVE_BASE_URL is required');
  const result = await verifyLifecycle({ repository, runId, github: directGithub(token) });
  console.log(
    `GitHub token-backed live lifecycle verified: ${repository} branch=${result.branch} pr=${result.pull_number}`
  );
}

async function runServiceVaultMode() {
  const container = process.env.AIWS_TEST_LIVE_CONTAINER;
  assert.match(
    container || '',
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,
    'AIWS_TEST_LIVE_CONTAINER is required for Docker service Vault mode'
  );
  const status = await serviceJson(serviceBaseUrl, '/api/github/status');
  assert.equal(status.connected, true, 'Docker service GitHub account must be connected');
  const installations = await serviceJson(serviceBaseUrl, '/api/github/installations');
  const selected = installations
    .flatMap((item) => item.repositories || [])
    .some((item) => item.selected !== false && item.full_name?.toLowerCase() === repository.toLowerCase());
  assert.equal(selected, true, `dedicated repository ${repository} must be selected in the Docker service`);

  const source = fs.readFileSync(new URL('./github-live-vault-harness.mjs', import.meta.url), 'utf8');
  const result = await runDockerHarness(container, source, repository, runId);
  assert.equal(result.mode, 'docker-service-vault');
  assert.equal(result.repository.toLowerCase(), repository.toLowerCase());
  assert.equal(result.cleanup?.pr_closed, true, 'temporary PR must be closed');
  assert.equal(result.cleanup?.branch_deleted, true, 'temporary branch must be deleted');
  console.log(
    `GitHub service-backed live lifecycle verified: ${repository} branch=${result.branch} pr=${result.pull_number}; cleanup=complete`
  );
}

async function verifyLifecycle({ repository: fullName, runId: id, github }) {
  const branch = `aiws-v175-${id}`,
    filePath = `.aiws-v175/${id}.txt`;
  let pullNumber = null,
    branchCreated = false,
    primaryError = null,
    prClosed = false,
    branchDeleted = false;
  try {
    const repo = await github('GET', `/repos/${fullName}`);
    assert.equal(repo.full_name.toLowerCase(), fullName.toLowerCase());
    assert.equal(repo.permissions?.pull !== false, true, 'repository must be readable');
    assert.equal(repo.permissions?.push, true, 'dedicated token must be able to push');
    const base = repo.default_branch;
    const baseRef = await github('GET', `/repos/${fullName}/git/ref/heads/${encodeURIComponent(base)}`);
    await github('POST', `/repos/${fullName}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseRef.object.sha });
    branchCreated = true;
    const baseCommit = await github('GET', `/repos/${fullName}/git/commits/${baseRef.object.sha}`);
    const blob = await github('POST', `/repos/${fullName}/git/blobs`, {
      content: `AIWS V1.75 controlled live test ${id}\n`,
      encoding: 'utf-8'
    });
    const tree = await github('POST', `/repos/${fullName}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }]
    });
    const commit = await github('POST', `/repos/${fullName}/git/commits`, {
      message: `test(v1.75): ${id}`,
      tree: tree.sha,
      parents: [baseRef.object.sha]
    });
    await github('PATCH', `/repos/${fullName}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    const pull = await github('POST', `/repos/${fullName}/pulls`, {
      title: `AIWS V1.75 controlled test ${id}`,
      head: branch,
      base,
      body: 'Automated V1.75 dedicated-resource lifecycle test.'
    });
    pullNumber = pull.number;
    const verified = await github('GET', `/repos/${fullName}/pulls/${pullNumber}`);
    assert.equal(verified.state, 'open');
    assert.equal(verified.head.ref, branch);
    assert.equal(verified.base.ref, base);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (pullNumber)
    try {
      await github('PATCH', `/repos/${fullName}/pulls/${pullNumber}`, { state: 'closed' });
      prClosed = true;
    } catch (error) {
      cleanupErrors.push(`close PR: ${error.message}`);
    }
  if (branchCreated)
    try {
      await github('DELETE', `/repos/${fullName}/git/refs/heads/${branch}`);
      branchDeleted = true;
    } catch (error) {
      cleanupErrors.push(`delete branch: ${error.message}`);
    }
  if (primaryError || cleanupErrors.length)
    throw new Error([primaryError?.message, ...cleanupErrors].filter(Boolean).join('; '));
  return {
    repository: fullName,
    branch,
    pull_number: pullNumber,
    cleanup: { pr_closed: prClosed, branch_deleted: branchDeleted }
  };
}

function directGithub(secret) {
  return async (method, route, body) => {
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'user-agent': 'aiws-v175-live-test',
        'x-github-api-version': '2022-11-28'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `GitHub ${method} ${route.split('?')[0]} failed (${response.status}): ${data.message || 'unknown_error'}`
      );
    return data;
  };
}

function runDockerHarness(container, source, dedicatedRepository, id) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', container, 'node', '--input-type=module', '-', dedicatedRepository, id],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let stdout = '',
      stderr = '',
      settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('Docker service Vault harness timed out'));
    }, 210000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0)
        return finish(
          reject,
          new Error(
            `Docker service Vault harness failed (${code}): ${stderr.trim().split(/\r?\n/).slice(-4).join(' | ') || 'unknown_error'}`
          )
        );
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        finish(resolve, JSON.parse(line));
      } catch {
        finish(reject, new Error('Docker service Vault harness returned invalid JSON'));
      }
    });
    child.stdin.end(source);
  });
}

async function serviceJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `GitHub service GET ${route} failed (${response.status}): ${data.error || data.message || 'unknown_error'}`
    );
  return data;
}

function normalizeBaseUrl(value) {
  if (!String(value || '').trim()) return null;
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol), 'AIWS_TEST_LIVE_BASE_URL must use HTTP(S)');
  assert.equal(url.username || url.password, '', 'AIWS_TEST_LIVE_BASE_URL must not contain credentials');
  return url.href.replace(/\/$/, '');
}

function safeRunId(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 39)}-${normalized.slice(-8)}`;
}
