import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  callOperation, callTool, createMcpTestFixture, resultData, seedHostCodexProfile, waitFor
} from '../v18/mcp-test-helpers.mjs';
import { decide, journeyWorkflowHierarchy, readResource, writeJourneyProject } from './v18-mcp-journey-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-journey-', {
  approver: {},
  env: { AIWS_CODEX_BIN: process.execPath, NODE_REPL_HISTORY: '', AIWS_TEST_TASK_TIMEOUT_MS: '30000' },
  seed: seedHostCodexProfile
});
let operator;
let approver;
let terminalId = null;
const evidence = {};

try {
  operator = await fixture.connect(fixture.operator, 'v18-journey-operator');
  approver = await fixture.connect(fixture.approver, 'v18-journey-approver');
  assert.equal(operator.client.getServerVersion().name, 'aiws-built-in');
  assert.ok((await operator.client.listTools()).tools.length >= 15);
  assert.equal(fixture.operator.client.scopes.includes('approval:decide'), false);
  assert.equal(fixture.operator.client.scopes.includes('setup:admin'), false);
  assert.equal(fixture.operator.client.scopes.includes('mcp:admin'), false);
  assert.equal(fixture.operator.client.scopes.includes('destructive:execute'), false);
  assert.equal(fixture.operator.client.scopes.includes('github:write'), false);

  const firstPage = await callTool(operator.client, 'aiws_capabilities', { action: 'search', query: '', limit: 7 });
  assert.equal(firstPage.data.items.length, 7);
  assert.ok(firstPage.data.next_cursor);
  const secondPage = await callTool(operator.client, 'aiws_capabilities', { action: 'search', query: '', limit: 7, cursor: firstPage.data.next_cursor });
  assert.equal(secondPage.data.items.some((item) => firstPage.data.items.some((first) => first.operation_id === item.operation_id)), false);
  const described = await callTool(operator.client, 'aiws_capabilities', { action: 'describe', operation_id: 'aiws.system.get.health' });
  assert.equal(described.data.capability.mapping, 'resource');
  const setup = resultData(await callOperation(operator.client, 'aiws.admin.get.setup.status'));
  assert.equal(typeof setup.steps, 'object');
  const health = resultData(await callOperation(operator.client, 'aiws.system.get.health')); assert.ok(Number.isInteger(health.schema_version) && health.schema_version >= 17, `schema ${health.schema_version} must not predate the V1.8 baseline`);

  const draft = resultData(await callOperation(operator.client, 'aiws.projects.post.projects', {
    body: { title: 'V1.8 MCP Journey', goal: 'Deliver and verify a complete Node project through MCP', operation_key: 'v18-mcp-journey-project' }
  }));
  const projectId = draft.project.id;
  const sessionId = draft.assist_session.id;
  evidence.project_id = projectId;
  assert.equal(draft.project.status, 'draft');

  const answers = {
    goal: 'Deliver and verify a complete Node project through MCP',
    users: ['Local Owner', 'Reviewer'],
    scope_in: ['Source', 'Tests', 'README'],
    scope_out: ['Remote deployment'],
    features: ['Deterministic sum function', 'MCP execution evidence'],
    constraints: ['No direct business HTTP requests'],
    milestones: ['Implement', 'Test', 'Review'],
    acceptance_criteria: ['node --test succeeds', 'Git commit is recorded'],
    risks: ['Runtime interruption'],
    open_questions: ['None']
  };
  const intake = resultData(await callOperation(operator.client, 'aiws.projects.put.projects.by-id.intake', {
    params: { id: projectId }, body: { mode: 'brainstorm', answers }
  }));
  assert.equal(Object.keys(answers).length, 10);
  assert.equal(intake.brief.content.schema_version, 2);
  assert.equal(intake.brief.content.sections.length, 9);

  const onboarding = resultData(await callOperation(operator.client, 'aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } }));
  const workflowDraft = resultData(await callOperation(operator.client, 'aiws.workflow.patch.projects.by-id.workflow-draft', {
    params: { id: projectId },
    body: {
      expected_revision: onboarding.workflow_draft.revision,
      nodes: journeyWorkflowHierarchy()
    }
  }));
  assert.equal(workflowDraft.nodes.length, 4);
  const confirmed = resultData(await callOperation(operator.client, 'aiws.projects.post.projects.by-id.onboarding.confirm', {
    params: { id: projectId },
    body: { expected_brief_revision: intake.brief.revision, expected_workflow_revision: workflowDraft.revision }
  }));
  assert.equal(confirmed.project.status, 'active');
  assert.equal(confirmed.nodes.length, 4);
  const workflowId = confirmed.workflow.id;
  const workstream = confirmed.nodes.find((item) => item.role === 'workstream');
  const executableTask = confirmed.nodes.find((item) => item.role === 'task' && item.task_kind === 'code');
  assert.ok(workstream && executableTask, 'confirmed workflow includes the V1.8 workstream and executable task');
  const nodeId = executableTask.id;
  evidence.workflow_id = workflowId;
  evidence.node_id = nodeId;

  const assistSession = resultData(await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions', {
    body: { project_id: projectId, scope_type: 'project', scope_id: projectId, title: 'V1.8 MCP delivery' }
  }));
  const activeSessionId = assistSession.id;
  await callOperation(operator.client, 'aiws.assist.put.assist.v3.sessions.by-id.goal', {
    params: { id: activeSessionId }, body: { adapter: 'test', objective: 'Complete the MCP journey', status: 'active', token_budget: 2000 }
  });
  const initialTurn = await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: activeSessionId },
    body: { adapter: 'test', collaboration_mode: 'default', content: 'Create review evidence', test_response: { message: 'review ready', files: [{ path: 'ASSIST.md', content: '# Assist evidence\n' }] } }
  });
  const initialDone = await callTool(operator.client, 'aiws_operations', { action: 'wait', operation_id: initialTurn.handle.id, timeout_ms: 5000, poll_ms: 50 });
  assert.equal(initialDone.data.operation.status, 'completed');
  const eventHandle = await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id.events', { params: { id: initialTurn.handle.id } });
  assert.equal(eventHandle.handle.type, 'operation_events');
  const turnEvents = await callTool(operator.client, 'aiws_operations', { action: 'read_events', operation_id: initialTurn.handle.id, limit: 100 });
  assert.equal(turnEvents.data.items.length > 0, true);
  const review = resultData(await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id.review', { params: { id: initialTurn.handle.id } }));
  assert.equal(review.changed_files.some((item) => item.path === 'ASSIST.md'), true);
  await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.review.apply', { params: { id: initialTurn.handle.id }, body: { target_hash: review.target_hash } });

  const steerTarget = await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: activeSessionId }, body: { adapter: 'test', content: 'Long-running turn', test_response: { delay_ms: 1500, message: 'superseded' } }
  });
  await waitFor(async () => {
    const turn = resultData(await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id', { params: { id: steerTarget.handle.id } }));
    return ['preparing', 'running'].includes(turn.status);
  }, { message: 'steer target did not start' });
  const steered = await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.steer', {
    params: { id: steerTarget.handle.id }, body: { adapter: 'test', content: 'Use the deterministic implementation', test_response: { message: 'steer complete' } }
  });
  assert.equal((await callTool(operator.client, 'aiws_operations', { action: 'wait', operation_id: steered.handle.id, timeout_ms: 5000, poll_ms: 50 })).data.operation.status, 'completed');

  const stopTarget = await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: activeSessionId }, body: { adapter: 'test', content: 'Stop and retry', test_response: { delay_ms: 1500, message: 'stopped too late' } }
  });
  await waitFor(async () => {
    const turn = resultData(await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id', { params: { id: stopTarget.handle.id } }));
    return ['preparing', 'running'].includes(turn.status);
  }, { message: 'stop target did not start' });
  await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.stop', { params: { id: stopTarget.handle.id }, body: { reason: 'journey_stop' } });
  const retried = await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.retry', {
    params: { id: stopTarget.handle.id }, body: { adapter: 'test', test_response: { message: 'retry complete' } }
  });
  assert.equal((await callTool(operator.client, 'aiws_operations', { action: 'wait', operation_id: retried.handle.id, timeout_ms: 5000, poll_ms: 50 })).data.operation.status, 'completed');

  await writeJourneyProject(operator.client, { projectId, nodeId });

  const terminal = resultData(await callOperation(operator.client, 'aiws.terminal.post.assist.v3.terminal-sessions', {
    body: { project_id: projectId, assist_session_id: activeSessionId, profile_id: 'cdx_v18_test_host', runtime: 'host_dev', cols: 110, rows: 28 }
  }));
  terminalId = terminal.id;
  const terminalCommand = `const cp=require('node:child_process');const root=${JSON.stringify(confirmed.project.repo_path)};cp.execSync('git config user.email mcp-journey@example.test',{cwd:root});cp.execSync('git config user.name MCP-Journey',{cwd:root});console.log(cp.execSync('node --test',{cwd:root,encoding:'utf8'}));console.log('AIWS:MCP:TESTS:PASS')\r`;
  await callTool(operator.client, 'aiws_terminal', { action: 'aiws.terminal.input', arguments: { session_id: terminalId, data: terminalCommand } });
  let terminalOutput = '';
  await waitFor(async () => {
    const output = await callTool(operator.client, 'aiws_terminal', { action: 'aiws.terminal.read', arguments: { session_id: terminalId } });
    terminalOutput = output.data.output;
    return (terminalOutput.match(/AIWS:MCP:TESTS:PASS/g) || []).length >= 2 && /pass 1/.test(terminalOutput);
  }, { timeout: 20_000, message: () => `Node tests did not finish:\n${terminalOutput}\nAPI:\n${fixture.logs()}` });
  await callTool(operator.client, 'aiws_terminal', { action: 'aiws.terminal.input', arguments: { session_id: terminalId, data: 'process.exit(0)\r' } });
  assert.equal((await callTool(operator.client, 'aiws_operations', { action: 'wait', operation_id: terminalId, timeout_ms: 10_000, poll_ms: 100 })).data.operation.status, 'exited');
  await callOperation(operator.client, 'aiws.terminal.post.assist.v3.terminal-sessions.by-id.review.rollback', { params: { id: terminalId }, body: {} });
  terminalId = null;

  const workflowProposal = resultData(await callOperation(operator.client, 'aiws.workflow.post.workflows.by-id.graph-proposals', {
    params: { id: workflowId }, body: {
      parent_node_id: workstream.id,
      expected_revision: workstream.plan_revision,
      target_id: nodeId,
      operations: [{ type: 'update_node', node_id: nodeId, patch: { title: 'Implement verified Node project', goal: 'Ship tested source through MCP' } }]
    }
  }));
  const denied = await operator.client.callTool({
    name: 'aiws_governance',
    arguments: { action: 'aiws.governance.post.approvals.by-type.by-id.decision', arguments: { params: { type: 'proposal', id: workflowProposal.id }, body: { decision: 'approve_apply', revision: workflowProposal.revision, target_hash: workflowProposal.target_hash } } }
  });
  assert.equal(denied.isError, true, 'operator cannot expose approval:decide action');
  const workflowApplied = resultData(await decide(approver.client, workflowProposal));
  assert.equal(workflowApplied.item.status, 'applied');

  const contractProposal = resultData(await callOperation(operator.client, 'aiws.governance.post.change-proposals', {
    body: { project_id: projectId, node_id: nodeId, change_type: 'node_contract_patch', title: 'Allow deterministic Node verification', after: { allowed_tools: ['filesystem', 'git', 'node'] }, apply_action: { type: 'node_contract_patch' } }
  }));
  assert.equal(resultData(await decide(approver.client, contractProposal)).item.status, 'applied');

  const context = resultData(await callOperation(operator.client, 'aiws.workflow.post.nodes.by-id.context-pack.preview', { params: { id: nodeId }, body: {} }));
  await callOperation(operator.client, 'aiws.runs.post.context-packs.by-id.confirm', { params: { id: context.id }, body: {} });
  const runProposal = resultData(await callOperation(operator.client, 'aiws.governance.post.change-proposals', {
    body: { project_id: projectId, node_id: nodeId, change_type: 'node_run_write', title: 'Authorize deterministic NodeRun', after: { runner: 'codex_docker' }, apply_action: { type: 'node_run_authorization', node_id: nodeId, runner: 'codex_docker' } }
  }));
  await decide(approver.client, runProposal);
  const runStarted = await callOperation(operator.client, 'aiws.runs.post.nodes.by-id.run.start', {
    params: { id: nodeId }, body: { adapter: 'test', runner: 'codex_docker', approval_id: runProposal.id, context_pack_id: context.id, test_delay_ms: 100, test_summary: 'V1.8 MCP NodeRun passed' }
  });
  const runId = runStarted.handle.id;
  evidence.run_id = runId;
  const runWait = await callTool(operator.client, 'aiws_operations', { action: 'wait', operation_id: runId, timeout_ms: 5000, poll_ms: 50 });
  assert.equal(runWait.data.operation.status, 'succeeded');
  const runDetail = resultData(await callOperation(operator.client, 'aiws.runs.get.runs.by-id', { params: { id: runId } }));
  assert.equal(runDetail.run.status, 'succeeded');

  const testTask = resultData(await callOperation(operator.client, 'aiws.projects.post.projects.by-id.test-tasks', { params: { id: projectId }, body: { node_id: nodeId, preset: 'test' } }));
  assert.equal(testTask.task.status, 'succeeded', testTask.task.stderr);
  const fileDiff = resultData(await callOperation(operator.client, 'aiws.files.get.projects.by-id.files.diff', { params: { id: projectId }, query: {} }));
  assert.equal(typeof fileDiff.diff, 'string');
  const digest = resultData(await callOperation(operator.client, 'aiws.assets.post.workspaces.by-id.digests', { params: { id: confirmed.project.current_workspace_id }, body: { summary: 'V1.8 MCP journey complete' } }));
  assert.equal(digest.version, 1);
  const submission = resultData(await callOperation(operator.client, 'aiws.workflow.post.nodes.by-id.submissions', {
    params: { id: nodeId }, body: { title: 'MCP delivery', summary: 'Source, tests, review, and NodeRun completed', changes: ['package.json', 'index.js', 'index.test.js', 'README.md'], evidence_refs: [`node_run:${runId}`, `digest:${digest.id}`] }
  }));
  assert.equal(submission.node_id, nodeId);

  const branch = resultData(await callOperation(operator.client, 'aiws.git.post.runs.by-id.git.branch', { params: { id: runId }, body: {} }));
  assert.equal(branch.command_result.ok, true);
  const captured = resultData(await callOperation(operator.client, 'aiws.git.post.runs.by-id.git.diff', { params: { id: runId }, body: {} }));
  assert.equal(captured.changed_files.length >= 4, true);
  const commitProposal = resultData(await callOperation(operator.client, 'aiws.governance.post.change-proposals', {
    body: { project_id: projectId, node_id: nodeId, change_type: 'git_commit', title: 'Authorize local journey commit', apply_action: { type: 'git_commit_authorization', run_id: runId } }
  }));
  await decide(approver.client, commitProposal);
  const committed = resultData(await callOperation(operator.client, 'aiws.git.post.runs.by-id.git.commit', {
    params: { id: runId }, body: { approval_id: commitProposal.id, message: 'feat: complete V1.8 MCP journey' }
  }));
  assert.equal(committed.command_result.ok, true, committed.command_result.stderr);
  evidence.commit = committed.code_change.head_commit;
  assert.match(evidence.commit, /^[a-f0-9]{40}$/);

  const assets = resultData(await callOperation(operator.client, 'aiws.assets.get.assets', { query: { project_id: projectId } }));
  const candidate = assets.find((item) => item.status === 'candidate' && item.run_id === runId);
  assert.ok(candidate, 'Git commit creates a CodeChangeAsset candidate');
  const confirmedAsset = resultData(await callOperation(operator.client, 'aiws.assets.post.asset-candidates.by-id.confirm', { params: { id: candidate.id }, body: { tags: ['v1.8', 'mcp-journey'] } }));
  assert.equal(confirmedAsset.asset.status, 'confirmed');

  await operator.close(); operator = null;
  await approver.close(); approver = null;
  await fixture.restartServer();
  operator = await fixture.connect(fixture.operator, 'v18-journey-operator-restored');
  approver = await fixture.connect(fixture.approver, 'v18-journey-approver-restored');
  const projectResource = await readResource(operator.client, `aiws://projects/${projectId}`);
  assert.equal(projectResource.data.project.id, projectId);
  const workflowResource = await readResource(operator.client, `aiws://workflows/${workflowId}`);
  assert.equal(workflowResource.data.workflow.id, workflowId);
  const runResource = await readResource(operator.client, `aiws://runs/${runId}`);
  assert.equal(runResource.data.run.id, runId);
  assert.equal(runResource.data.code_change.head_commit, evidence.commit);
  const restoredEvents = await readResource(operator.client, `aiws://operations/${runId}/events`);
  assert.equal(restoredEvents.ok, true);
  assert.equal(restoredEvents.data.operation.status, 'succeeded');

  const trashed = resultData(await callOperation(operator.client, 'aiws.projects.post.projects.by-id.trash', { params: { id: projectId }, body: {} }));
  assert.ok(trashed.project.deleted_at);
  fixture.assertMcpOnlyHttp();

  await operator.close(); operator = null;
  await approver.close(); approver = null;
  await fixture.stopServer();
  const oracle = await fixture.stateApi.readState();
  assert.equal(oracle.projects.find((item) => item.id === projectId)?.deleted_at != null, true);
  assert.equal(oracle.code_changes.some((item) => item.run_id === runId && item.head_commit === evidence.commit), true);
  assert.equal(oracle.mcp_clients.some((item) => Object.hasOwn(item, 'token')), false);
  assert.equal(fs.existsSync(path.join(confirmed.project.repo_path, 'index.test.js')), false, 'trash moves the managed workspace out of the active path');
  console.log(`V1.8 MCP-only journey passed (${projectId}, ${runId}, ${evidence.commit.slice(0, 12)})`);
} finally {
  if (terminalId && operator) await callOperation(operator.client, 'aiws.terminal.post.assist.v3.terminal-sessions.by-id.stop', { params: { id: terminalId }, body: {} }).catch(() => undefined);
  await operator?.close();
  await approver?.close();
  await fixture.close();
}
