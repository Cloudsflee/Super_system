import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callOperation, callTool, createMcpTestFixture, resultData, seedHostCodexProfile, waitFor } from '../v18/mcp-test-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-terminal-', {
  env: { AIWS_CODEX_BIN: process.execPath, NODE_REPL_HISTORY: '' },
  seed: seedHostCodexProfile
});
let connection;
let terminalId;
try {
  connection = await fixture.connect();
  const created = resultData(await callOperation(connection.client, 'aiws.projects.post.projects', { body: { title: 'MCP terminal', goal: 'Build through shared PTY runtime' } }));
  await callOperation(connection.client, 'aiws.projects.put.projects.by-id.intake', {
    params: { id: created.project.id },
    body: { mode: 'brainstorm', answers: { goal: 'Build through shared PTY runtime', users: ['Owner'], features: ['Terminal'], acceptance_criteria: ['The generated file is applied'] } }
  });
  const confirmed = resultData(await callOperation(connection.client, 'aiws.projects.post.projects.by-id.onboarding.confirm', { params: { id: created.project.id }, body: { workflow_nodes: [{
    id: 'mcp-terminal-workstream', role: 'workstream', title: 'Terminal 交付成果', outcome: '生成并应用 Terminal 文件', category: 'deliverable',
    acceptance_criteria: ['文件内容已应用'], boundary: { deliverable: 'mcp-terminal.txt' }, dependency_ids: [],
    tasks: [{ id: 'mcp-terminal-task', role: 'task', title: '生成 Terminal 文件', task_kind: 'code', execution_mode: 'codex', dependency_ids: [] }]
  }] } }));
  const terminal = resultData(await callOperation(connection.client, 'aiws.terminal.post.assist.v3.terminal-sessions', {
    body: { project_id: created.project.id, assist_session_id: created.assist_session.id, profile_id: 'cdx_v18_test_host', runtime: 'host_dev', cols: 100, rows: 24 }
  }));
  terminalId = terminal.id;
  await callTool(connection.client, 'aiws_terminal', { action: 'aiws.terminal.resize', arguments: { session_id: terminalId, cols: 88, rows: 20 } });
  const command = "require('node:fs').writeFileSync('mcp-terminal.txt','shared runtime ok\\n');console.log('AIWS:MCP:TERMINAL:OK')\r";
  await callTool(connection.client, 'aiws_terminal', { action: 'aiws.terminal.input', arguments: { session_id: terminalId, data: command } });
  await waitFor(async () => {
    const read = await callTool(connection.client, 'aiws_terminal', { action: 'aiws.terminal.read', arguments: { session_id: terminalId } });
    return read.data.output.includes('AIWS:MCP:TERMINAL:OK') && read;
  }, { message: `terminal output timed out: ${fixture.logs()}` });
  await callTool(connection.client, 'aiws_terminal', { action: 'aiws.terminal.input', arguments: { session_id: terminalId, data: 'process.exit(0)\r' } });
  const settled = await callTool(connection.client, 'aiws_operations', { action: 'wait', operation_id: terminalId, timeout_ms: 10_000, poll_ms: 100 });
  assert.equal(settled.data.operation.status, 'exited');

  const review = resultData(await callOperation(connection.client, 'aiws.terminal.get.assist.v3.terminal-sessions.by-id.review', { params: { id: terminalId } }));
  assert.equal(review.changed_files.some((item) => item.path === 'mcp-terminal.txt'), true);
  await callOperation(connection.client, 'aiws.terminal.post.assist.v3.terminal-sessions.by-id.review.apply', { params: { id: terminalId }, body: { target_hash: review.target_hash } });
  assert.equal(fs.readFileSync(path.join(confirmed.project.repo_path, 'mcp-terminal.txt'), 'utf8').replaceAll('\r\n', '\n'), 'shared runtime ok\n');
  terminalId = null;
  console.log('V1.8 MCP terminal runtime tests passed');
} finally {
  if (terminalId && connection) await callOperation(connection.client, 'aiws.terminal.post.assist.v3.terminal-sessions.by-id.stop', { params: { id: terminalId }, body: {} }).catch(() => undefined);
  await connection?.close();
  await fixture.close();
}
