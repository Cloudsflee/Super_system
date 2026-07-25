import { createHash } from 'node:crypto';
import { callOperation, callTool } from '../v18/mcp-test-helpers.mjs';

export async function decide(client, proposal) {
  return callOperation(client, 'aiws.governance.post.approvals.by-type.by-id.decision', {
    params: { type: 'proposal', id: proposal.id },
    body: { decision: 'approve_apply', revision: proposal.revision, target_hash: proposal.target_hash }
  });
}

export async function readResource(client, uri) {
  const response = await client.readResource({ uri });
  return JSON.parse(response.contents[0].text);
}

export function journeyWorkflowHierarchy() {
  return [
    {
      id: 'v18-delivery',
      role: 'workstream',
      title: 'Verified Node project',
      goal: 'Deliver a complete Node project through MCP',
      outcome: 'A tested and reviewable Node project',
      category: 'deliverable',
      boundary: { deliverable: 'node-project' },
      acceptance_criteria: ['Node tests pass', 'Git commit is recorded'],
      dependency_ids: [],
      tasks: [
        {
          id: 'v18-execution',
          role: 'task',
          title: 'Implement Node project',
          goal: 'Create the deterministic implementation',
          task_kind: 'code',
          execution_mode: 'codex',
          dependency_ids: []
        },
        {
          id: 'v18-research',
          role: 'task',
          title: 'Research constraints',
          goal: 'Validate MCP constraints',
          task_kind: 'research',
          execution_mode: 'assist',
          dependency_ids: ['v18-execution']
        },
        {
          id: 'v18-analysis',
          role: 'task',
          title: 'Analyze evidence',
          goal: 'Review deterministic evidence',
          task_kind: 'analysis',
          execution_mode: 'assist',
          dependency_ids: ['v18-research']
        }
      ]
    }
  ];
}

export async function writeJourneyProject(client, { projectId, nodeId }) {
  const packageJson = `${JSON.stringify({ name: 'v18-mcp-journey', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`;
  const source = 'function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n';
  const test =
    "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('./index.js');\ntest('sum', () => assert.equal(sum(20, 22), 42));\n";
  for (const [file, content] of [
    ['package.json', packageJson],
    ['index.js', source],
    ['index.test.js', test]
  ]) {
    await callOperation(client, 'aiws.files.put.projects.by-id.files.content', {
      params: { id: projectId },
      body: { path: file, content, node_id: nodeId }
    });
  }
  const readme = Buffer.from('# V1.8 MCP Journey\n\nA deterministic Node project built through MCP.\n', 'utf8');
  const upload = await callTool(client, 'aiws_files', {
    action: 'aiws.files.upload.begin',
    arguments: {
      project_id: projectId,
      node_id: nodeId,
      path: 'README.md',
      size_bytes: readme.length,
      sha256: createHash('sha256').update(readme).digest('hex')
    }
  });
  await callTool(client, 'aiws_files', {
    action: 'aiws.files.upload.chunk',
    arguments: { upload_id: upload.data.id, sequence: 0, data_base64: readme.toString('base64') }
  });
  await callTool(client, 'aiws_files', {
    action: 'aiws.files.upload.commit',
    arguments: { upload_id: upload.data.id }
  });
}
