import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { GitHubAppAdapter } from '../../apps/api/src/clean/p8/github-adapter.mjs';

test('GitHub App ready transition falls back to the supported GraphQL mutation on REST 404', async () => {
  const calls = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ method: init.method || 'GET', path: `${parsed.pathname}${parsed.search}`, body: init.body || null });
    if (parsed.pathname === '/app/installations/1/access_tokens') return json({ token: 'fixture-installation-token' }, 201);
    if (parsed.pathname === '/repos/fixture/repo/pulls/7/ready_for_review') return json({ message: 'Not Found' }, 404);
    if (parsed.pathname === '/repos/fixture/repo/pulls/7') return json({
      node_id: 'PR_fixture_7', number: 7, state: 'open', draft: true, merged: false,
      base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) }, updated_at: '2026-08-28T00:00:00Z'
    });
    if (parsed.pathname === '/graphql') {
      const request = JSON.parse(init.body);
      assert.match(request.query, /markPullRequestReadyForReview/);
      assert.deepEqual(request.variables, { input: { pullRequestId: 'PR_fixture_7' } });
      return json({ data: { markPullRequestReadyForReview: { pullRequest: { number: 7, isDraft: false, state: 'OPEN' } } } });
    }
    return json({ message: 'unexpected route' }, 500);
  };
  const adapter = new GitHubAppAdapter({ fetchImpl, apiBaseUrl: 'https://github.fixture' });
  const receipt = await adapter.markReady(
    { appId: '1', installationId: '1', privateKey: privateKeyPem },
    { repository: 'fixture/repo', pullNumber: 7 }
  );
  assert.deepEqual(receipt, {
    number: 7, state: 'open', draft: false, merged: false,
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), merge_sha: null,
    updated_at: '2026-08-28T00:00:00Z'
  });
  assert.deepEqual(calls.map((call) => call.path), [
    '/app/installations/1/access_tokens',
    '/repos/fixture/repo/pulls/7/ready_for_review',
    '/repos/fixture/repo/pulls/7',
    '/graphql'
  ]);
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
