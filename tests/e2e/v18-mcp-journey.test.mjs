import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  callOperation,
  callTool,
  createMcpTestFixture,
  resultData,
  seedHostCodexProfile,
  waitFor
} from '../v18/mcp-test-helpers.mjs';
import { decide, journeyWorkflowHierarchy, readResource } from './v18-mcp-journey-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-journey-', {
  approver: {
    scopes: [
      'system:read',
      'project:read',
      'project:write',
      'workflow:read',
      'governance:read',
      'approval:read',
      'approval:decide',
      'destructive:execute'
    ]
  },
  env: { AIWS_CODEX_BIN: process.execPath, NODE_REPL_HISTORY: '', AIWS_TEST_TASK_TIMEOUT_MS: '30000' },
  seed: seedHostCodexProfile
});
let operator;
let approver;

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
  const secondPage = await callTool(operator.client, 'aiws_capabilities', {
    action: 'search',
    query: '',
    limit: 7,
    cursor: firstPage.data.next_cursor
  });
  assert.equal(
    secondPage.data.items.some((item) =>
      firstPage.data.items.some((first) => first.operation_id === item.operation_id)
    ),
    false
  );
  const described = await callTool(operator.client, 'aiws_capabilities', {
    action: 'describe',
    operation_id: 'aiws.system.get.health'
  });
  assert.equal(described.data.capability.mapping, 'resource');
  const setup = resultData(await callOperation(operator.client, 'aiws.admin.get.setup.status'));
  assert.equal(typeof setup.steps, 'object');
  const health = resultData(await callOperation(operator.client, 'aiws.system.get.health'));
  assert.ok(
    Number.isInteger(health.schema_version) && health.schema_version >= 17,
    `schema ${health.schema_version} must not predate the V1.8 baseline`
  );

  const draft = resultData(
    await callOperation(operator.client, 'aiws.projects.post.projects', {
      body: {
        title: 'V1.8 MCP Journey',
        goal: 'Deliver and verify a complete Node project through MCP',
        operation_key: 'v18-mcp-journey-project'
      }
    })
  );
  const projectId = draft.project.id;
  const sessionId = draft.assist_session.id;
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
  const intake = resultData(
    await callOperation(operator.client, 'aiws.projects.put.projects.by-id.intake', {
      params: { id: projectId },
      body: { mode: 'brainstorm', answers }
    })
  );
  assert.equal(Object.keys(answers).length, 10);
  assert.equal(intake.brief.content.schema_version, 2);
  assert.equal(intake.brief.content.sections.length, 9);

  const onboarding = resultData(
    await callOperation(operator.client, 'aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } })
  );
  const workflowDraft = resultData(
    await callOperation(operator.client, 'aiws.workflow.patch.projects.by-id.workflow-draft', {
      params: { id: projectId },
      body: {
        expected_revision: onboarding.workflow_draft.revision,
        nodes: journeyWorkflowHierarchy(),
        brief_coverage: {
          features: ['v18-execution'],
          acceptance_criteria: ['v18-analysis'],
          milestones: ['v18-analysis'],
          risks: ['v18-research']
        }
      }
    })
  );
  assert.equal(workflowDraft.nodes.length, 4);

  const confirmed = resultData(
    await callOperation(operator.client, 'aiws.projects.post.projects.by-id.onboarding.confirm', {
      params: { id: projectId },
      body: { expected_brief_revision: intake.brief.revision, expected_workflow_revision: workflowDraft.revision }
    })
  );
  assert.equal(confirmed.project.status, 'active');
  assert.equal(confirmed.nodes.length, 4);
  const workflowId = confirmed.workflow.id;
  const workstream = confirmed.nodes.find((item) => item.role === 'workstream');
  const executableTask = confirmed.nodes.find((item) => item.role === 'task' && item.task_kind === 'code');
  assert.ok(workstream && executableTask, 'confirmed workflow includes the V1.8 workstream and executable task');
  const nodeId = executableTask.id;
  const rejectedFileWrite = await callOperation(
    operator.client,
    'aiws.files.put.projects.by-id.files.content',
    {
      params: { id: projectId },
      body: { path: 'index.js', content: 'module.exports = {};\n', node_id: nodeId }
    },
    { ok: false }
  );
  assert.equal(rejectedFileWrite.error.error, 'workflow_execution_required');

  const assistSession = resultData(
    await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions', {
      body: { project_id: projectId, scope_type: 'project', scope_id: projectId, title: 'V1.8 MCP delivery' }
    })
  );
  const activeSessionId = assistSession.id;
  await callOperation(operator.client, 'aiws.assist.put.assist.v3.sessions.by-id.goal', {
    params: { id: activeSessionId },
    body: { adapter: 'test', objective: 'Complete the MCP journey', status: 'active', token_budget: 2000 }
  });
  const initialTurn = await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: activeSessionId },
    body: {
      adapter: 'test',
      collaboration_mode: 'default',
      content: 'Create review evidence',
      test_response: { message: 'review ready', files: [{ path: 'ASSIST.md', content: '# Assist evidence\n' }] }
    }
  });
  const initialDone = await callTool(operator.client, 'aiws_operations', {
    action: 'wait',
    operation_id: initialTurn.handle.id,
    timeout_ms: 5000,
    poll_ms: 50
  });
  assert.equal(initialDone.data.operation.status, 'completed');
  const eventHandle = await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id.events', {
    params: { id: initialTurn.handle.id }
  });
  assert.equal(eventHandle.handle.type, 'operation_events');
  const turnEvents = await callTool(operator.client, 'aiws_operations', {
    action: 'read_events',
    operation_id: initialTurn.handle.id,
    limit: 100
  });
  assert.equal(turnEvents.data.items.length > 0, true);
  const review = resultData(
    await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id.review', {
      params: { id: initialTurn.handle.id }
    })
  );
  assert.equal(
    review.changed_files.some((item) => item.path === 'ASSIST.md'),
    true
  );
  const rejectedApply = await callOperation(
    operator.client,
    'aiws.assist.post.assist.v3.turns.by-id.review.apply',
    { params: { id: initialTurn.handle.id }, body: { target_hash: review.target_hash } },
    { ok: false }
  );
  assert.equal(rejectedApply.error.error, 'workflow_execution_required');
  await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.review.rollback', {
    params: { id: initialTurn.handle.id },
    body: { target_hash: review.target_hash }
  });

  const steerTarget = await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: activeSessionId },
    body: { adapter: 'test', content: 'Long-running turn', test_response: { delay_ms: 1500, message: 'superseded' } }
  });
  await waitFor(
    async () => {
      const turn = resultData(
        await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id', {
          params: { id: steerTarget.handle.id }
        })
      );
      return ['preparing', 'running'].includes(turn.status);
    },
    { message: 'steer target did not start' }
  );
  const steered = await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.steer', {
    params: { id: steerTarget.handle.id },
    body: {
      adapter: 'test',
      content: 'Use the deterministic implementation',
      test_response: { message: 'steer complete' }
    }
  });
  assert.equal(
    (
      await callTool(operator.client, 'aiws_operations', {
        action: 'wait',
        operation_id: steered.handle.id,
        timeout_ms: 5000,
        poll_ms: 50
      })
    ).data.operation.status,
    'completed'
  );

  const stopTarget = await callOperation(operator.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: activeSessionId },
    body: { adapter: 'test', content: 'Stop and retry', test_response: { delay_ms: 1500, message: 'stopped too late' } }
  });
  await waitFor(
    async () => {
      const turn = resultData(
        await callOperation(operator.client, 'aiws.assist.get.assist.v3.turns.by-id', {
          params: { id: stopTarget.handle.id }
        })
      );
      return ['preparing', 'running'].includes(turn.status);
    },
    { message: 'stop target did not start' }
  );
  await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.stop', {
    params: { id: stopTarget.handle.id },
    body: { reason: 'journey_stop' }
  });
  const retried = await callOperation(operator.client, 'aiws.assist.post.assist.v3.turns.by-id.retry', {
    params: { id: stopTarget.handle.id },
    body: { adapter: 'test', test_response: { message: 'retry complete' } }
  });
  assert.equal(
    (
      await callTool(operator.client, 'aiws_operations', {
        action: 'wait',
        operation_id: retried.handle.id,
        timeout_ms: 5000,
        poll_ms: 50
      })
    ).data.operation.status,
    'completed'
  );

  const rejectedTerminal = await callOperation(
    operator.client,
    'aiws.terminal.post.assist.v3.terminal-sessions',
    {
      body: {
        project_id: projectId,
        assist_session_id: activeSessionId,
        profile_id: 'cdx_v18_test_host',
        runtime: 'host_dev',
        cols: 110,
        rows: 28
      }
    },
    { ok: false }
  );
  assert.equal(rejectedTerminal.error.error, 'workflow_execution_required');

  const workflowProposal = resultData(
    await callOperation(operator.client, 'aiws.workflow.post.workflows.by-id.graph-proposals', {
      params: { id: workflowId },
      body: {
        parent_node_id: workstream.id,
        expected_revision: workstream.plan_revision,
        target_id: nodeId,
        operations: [
          {
            type: 'update_node',
            node_id: nodeId,
            patch: { title: 'Implement verified Node project', goal: 'Ship tested source through MCP' }
          }
        ]
      }
    })
  );
  const denied = await operator.client.callTool({
    name: 'aiws_governance',
    arguments: {
      action: 'aiws.governance.post.approvals.by-type.by-id.decision',
      arguments: {
        params: { type: 'proposal', id: workflowProposal.id },
        body: {
          decision: 'approve_apply',
          revision: workflowProposal.revision,
          target_hash: workflowProposal.target_hash
        }
      }
    }
  });
  assert.equal(denied.isError, true, 'operator cannot expose approval:decide action');
  const workflowApplied = resultData(await decide(approver.client, workflowProposal));
  assert.equal(workflowApplied.item.status, 'applied');

  const contractProposal = resultData(
    await callOperation(operator.client, 'aiws.governance.post.change-proposals', {
      body: {
        project_id: projectId,
        node_id: nodeId,
        change_type: 'node_contract_patch',
        title: 'Allow deterministic Node verification',
        after: { allowed_tools: ['filesystem', 'git', 'node'] },
        apply_action: { type: 'node_contract_patch' }
      }
    })
  );
  assert.equal(resultData(await decide(approver.client, contractProposal)).item.status, 'applied');

  const runProposal = resultData(
    await callOperation(operator.client, 'aiws.governance.post.change-proposals', {
      body: {
        project_id: projectId,
        node_id: nodeId,
        change_type: 'node_run_write',
        title: 'Authorize deterministic NodeRun',
        after: { runner: 'codex_docker' },
        apply_action: { type: 'node_run_authorization', node_id: nodeId, runner: 'codex_docker' }
      }
    })
  );
  await decide(approver.client, runProposal);
  const rejectedRun = await callOperation(
    operator.client,
    'aiws.runs.post.nodes.by-id.run.start',
    {
      params: { id: nodeId },
      body: {
        adapter: 'test',
        runner: 'codex_docker',
        approval_id: runProposal.id,
        test_delay_ms: 100,
        test_summary: 'V1.8 MCP NodeRun passed'
      }
    },
    { ok: false }
  );
  assert.equal(rejectedRun.error.error, 'workflow_execution_required');
  const rejectedTest = await callOperation(
    operator.client,
    'aiws.projects.post.projects.by-id.test-tasks',
    { params: { id: projectId }, body: { node_id: nodeId, preset: 'test' } },
    { ok: false }
  );
  assert.equal(rejectedTest.error.error, 'workflow_execution_required');
  const fileDiff = resultData(
    await callOperation(operator.client, 'aiws.files.get.projects.by-id.files.diff', {
      params: { id: projectId },
      query: {}
    })
  );
  assert.equal(typeof fileDiff.diff, 'string');

  await operator.close();
  operator = null;
  await approver.close();
  approver = null;
  await fixture.restartServer();
  operator = await fixture.connect(fixture.operator, 'v18-journey-operator-restored');
  approver = await fixture.connect(fixture.approver, 'v18-journey-approver-restored');
  const projectResource = await readResource(operator.client, `aiws://projects/${projectId}`);
  assert.equal(projectResource.data.project.id, projectId);
  const workflowResource = await readResource(operator.client, `aiws://workflows/${workflowId}`);
  assert.equal(workflowResource.data.workflow.id, workflowId);

  const trashed = resultData(
    await callOperation(approver.client, 'aiws.projects.post.projects.by-id.trash', {
      params: { id: projectId },
      body: {}
    })
  );
  assert.ok(trashed.project.deleted_at);
  fixture.assertMcpOnlyHttp();

  await operator.close();
  operator = null;
  await approver.close();
  approver = null;
  await fixture.stopServer();
  const oracle = await fixture.stateApi.readState();
  assert.equal(oracle.projects.find((item) => item.id === projectId)?.deleted_at != null, true);
  assert.equal(
    oracle.node_runs.some((item) => item.project_id === projectId),
    false
  );
  assert.equal(
    oracle.code_changes.some((item) => item.project_id === projectId),
    false
  );
  assert.equal(
    oracle.mcp_clients.some((item) => Object.hasOwn(item, 'token')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(confirmed.project.repo_path, 'index.test.js')),
    false,
    'trash moves the managed workspace out of the active path'
  );
  console.log(`V1.8 MCP-only legacy execution rejection journey passed (${projectId}, ${workflowId})`);
} finally {
  await operator?.close();
  await approver?.close();
  await fixture.close();
}
