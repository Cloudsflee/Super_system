import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callOperation, callTool, resultData } from '../v18/mcp-test-helpers.mjs';

if (process.env.RUN_V18_MCP_LIVE_TESTS !== '1') {
  console.log('V1.8 GitHub MCP live test blocked; set RUN_V18_MCP_LIVE_TESTS=1');
  process.exit(2);
}

assert.equal(process.env.AIWS_TEST_GITHUB_CONFIRM, 'dedicated-write-test');
const repository = String(process.env.AIWS_TEST_GITHUB_REPO || 'Cloudsflee/---');
assert.equal(repository, 'Cloudsflee/---', 'V1.8 live GitHub fixture is pinned');
const baseUrl = new URL(String(process.env.AIWS_TEST_LIVE_BASE_URL || ''));
const runId = String(process.env.AIWS_TEST_MCP_RUN_ID || '');
assert.ok(runId);

const operator = await connect('operator', process.env.AIWS_TEST_MCP_GITHUB_TOKEN);
const approver = await connect('approver', process.env.AIWS_TEST_MCP_APPROVER_TOKEN);
try {
  const run = (await readResource(operator.client, `aiws://runs/${runId}`)).data;
  assert.equal(run.run.id, runId);
  const proposal = resultData(await callOperation(operator.client, 'aiws.governance.post.change-proposals', {
    body: { project_id: run.run.project_id, node_id: run.run.node_id, change_type: 'git_publish', title: 'Authorize V1.8 controlled GitHub PR', apply_action: { type: 'git_publish_authorization', run_id: runId } }
  }));
  await callOperation(approver.client, 'aiws.governance.post.approvals.by-type.by-id.decision', {
    params: { type: 'proposal', id: proposal.id }, body: { decision: 'approve_apply', revision: proposal.revision, target_hash: proposal.target_hash }
  });
  const created = resultData(await callOperation(operator.client, 'aiws.github.post.runs.by-id.github.pr', {
    params: { id: runId }, body: { approval_id: proposal.id, title: `AIWS V1.8 controlled MCP test ${Date.now()}`, draft: true }
  }));
  assert.equal(created.code_change.status, 'pr_created');
  assert.match(created.code_change.pr_url, /^https:\/\/github\.com\/Cloudsflee\/---\/pull\/(\d+)$/i);
  const pullNumber = Number(created.code_change.pr_url.match(/\/pull\/(\d+)$/)[1]);
  const closed = await callTool(operator.client, 'aiws_github', { action: 'aiws.github.pull_request.close', arguments: { run_id: runId, pull_number: pullNumber } });
  assert.equal(closed.data.state, 'closed');
  const removed = await callTool(operator.client, 'aiws_github', { action: 'aiws.github.branch.delete', arguments: { run_id: runId, branch: created.code_change.work_branch } });
  assert.equal(removed.data.deleted, true);
  console.log(`V1.8 GitHub MCP live lifecycle passed (${repository} #${pullNumber}; branch deleted)`);
} finally {
  await operator.close();
  await approver.close();
}

async function connect(name, rawToken) {
  const token = String(rawToken || '');
  assert.match(token, /^aiws_mcp_/);
  const client = new Client({ name: `v18-github-${name}`, version: '1.8.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, async close() { await transport.terminateSession().catch(() => undefined); await client.close().catch(() => undefined); } };
}
async function readResource(client, uri) { const response = await client.readResource({ uri }); return JSON.parse(response.contents[0].text); }
