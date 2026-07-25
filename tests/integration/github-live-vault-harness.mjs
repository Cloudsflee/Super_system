import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repository, runId] = process.argv.slice(2);
assert.match(repository || '', /^[^/\s]+\/[^/\s]+$/, 'repository must be owner/repo');
assert.match(runId || '', /^[a-z0-9-]{1,48}$/, 'run id must be a safe Git ref suffix');

const moduleUrl = (relative) => pathToFileURL(path.join(process.cwd(), relative)).href;
const { readState } = await import(moduleUrl('apps/api/src/state.mjs'));
const { createInstallationToken, githubJson, resolveGithubAppConfig } = await import(
  moduleUrl('apps/api/src/github-service.mjs')
);

const state = await readState();
const config = resolveGithubAppConfig(state);
assert.ok(config, 'Docker service GitHub App configuration is required');
const installation = state.github_installations.find(
  (item) =>
    item.status === 'active' &&
    (item.repositories || []).some(
      (repo) => repo.selected !== false && repo.full_name?.toLowerCase() === repository.toLowerCase()
    )
);
assert.ok(installation, `dedicated repository ${repository} must be selected in an active GitHub App installation`);

const issued = await createInstallationToken(config, installation.installation_id);
assert.ok(issued.token, 'GitHub App installation token was not issued');
assert.equal(issued.permissions?.contents, 'write', 'GitHub App must have contents:write');
assert.equal(issued.permissions?.pull_requests, 'write', 'GitHub App must have pull_requests:write');

const github = async (method, route, body) =>
  githubJson(`https://api.github.com${route}`, {
    method,
    headers: {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
      'user-agent': 'aiws-v175-live-test'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

const result = await verifyLifecycle({ repository, runId, github });
console.log(JSON.stringify({ mode: 'docker-service-vault', ...result }));

async function verifyLifecycle({ repository: fullName, runId: id, github: request }) {
  const branch = `aiws-v175-${id}`,
    filePath = `.aiws-v175/${id}.txt`;
  let pullNumber = null,
    branchCreated = false,
    primaryError = null,
    prClosed = false,
    branchDeleted = false;
  try {
    const repo = await request('GET', `/repos/${fullName}`);
    assert.equal(repo.full_name.toLowerCase(), fullName.toLowerCase());
    assert.equal(repo.archived, false, 'dedicated repository must not be archived');
    assert.equal(repo.disabled, false, 'dedicated repository must not be disabled');
    const base = repo.default_branch;
    const baseRef = await request('GET', `/repos/${fullName}/git/ref/heads/${encodeURIComponent(base)}`);
    await request('POST', `/repos/${fullName}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseRef.object.sha });
    branchCreated = true;
    const baseCommit = await request('GET', `/repos/${fullName}/git/commits/${baseRef.object.sha}`);
    const blob = await request('POST', `/repos/${fullName}/git/blobs`, {
      content: `AIWS V1.75 controlled live test ${id}\n`,
      encoding: 'utf-8'
    });
    const tree = await request('POST', `/repos/${fullName}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }]
    });
    const commit = await request('POST', `/repos/${fullName}/git/commits`, {
      message: `test(v1.75): ${id}`,
      tree: tree.sha,
      parents: [baseRef.object.sha]
    });
    await request('PATCH', `/repos/${fullName}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    const pull = await request('POST', `/repos/${fullName}/pulls`, {
      title: `AIWS V1.75 controlled test ${id}`,
      head: branch,
      base,
      body: 'Automated V1.75 dedicated-resource lifecycle test.'
    });
    pullNumber = pull.number;
    const verified = await request('GET', `/repos/${fullName}/pulls/${pullNumber}`);
    assert.equal(verified.state, 'open');
    assert.equal(verified.head.ref, branch);
    assert.equal(verified.base.ref, base);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (pullNumber)
    try {
      await request('PATCH', `/repos/${fullName}/pulls/${pullNumber}`, { state: 'closed' });
      prClosed = true;
    } catch (error) {
      cleanupErrors.push(`close PR: ${error.message}`);
    }
  if (branchCreated)
    try {
      await request('DELETE', `/repos/${fullName}/git/refs/heads/${branch}`);
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
