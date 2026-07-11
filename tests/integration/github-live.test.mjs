import assert from 'node:assert/strict';

if (process.env.RUN_GITHUB_LIVE_TESTS !== '1') {
  console.log('github live tests skipped; set RUN_GITHUB_LIVE_TESTS=1 to run');
  process.exit(0);
}

const repository = process.env.AIWS_TEST_GITHUB_REPO;
const token = process.env.AIWS_TEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
assert.match(repository || '', /^[^/\s]+\/[^/\s]+$/, 'AIWS_TEST_GITHUB_REPO must be owner/repo');
assert.ok(token, 'AIWS_TEST_GITHUB_TOKEN or GITHUB_TOKEN is required');

const response = await fetch(`https://api.github.com/repos/${repository}`, {
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'ai-workspace-v1.2-live-test',
    'x-github-api-version': '2022-11-28'
  }
});
const data = await response.json();
assert.equal(response.status, 200, `GitHub repository probe failed: ${data.message || response.status}`);
assert.equal(data.full_name.toLowerCase(), repository.toLowerCase());
assert.equal(data.permissions?.pull !== false, true, 'repository must be readable');
console.log(`GitHub live read-only probe passed: ${data.full_name}`);
