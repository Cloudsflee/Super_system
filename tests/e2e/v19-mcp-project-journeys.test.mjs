import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { callOperation, callTool, createMcpTestFixture, resultData } from '../v18/mcp-test-helpers.mjs';
import {
  assertLegacyDeliveryRejected,
  assertLegacyTaskRunRejected,
  codingHierarchy,
  createRepositoryWorkspace
} from './v19-mcp-project-journey-helpers.mjs';

let repositories;
const fixture = await createMcpTestFixture('aiws-v19-mcp-journeys-', {
  approver: {
    name: 'V1.9 delivery orchestrator',
    scopes: [
      'system:read',
      'project:read',
      'project:write',
      'workflow:read',
      'workflow:write',
      'github:read',
      'github:write',
      'approval:read',
      'approval:decide'
    ],
    concurrent_limit: 8,
    rate_limit_per_minute: 1200
  },
  seed: async ({ root }) => {
    repositories = { alpha: path.join(root, 'repo-alpha'), beta: path.join(root, 'repo-beta') };
    initializeRepository(repositories.alpha, 'alpha');
    initializeRepository(repositories.beta, 'beta');
  }
});
let operator, orchestrator;

try {
  operator = await fixture.connect(fixture.operator, 'v19-project-operator');
  orchestrator = await fixture.connect(fixture.approver, 'v19-delivery-orchestrator');
  assert.equal(
    fixture.operator.client.scopes.includes('github:write'),
    false,
    'the ordinary project operator cannot perform GitHub side effects'
  );
  assert.equal(fixture.approver.client.scopes.includes('approval:decide'), true);

  const manual = await completeNonCodingJourney(operator.client, orchestrator.client);
  const coding = await completeMultiRepositoryJourney(operator.client, orchestrator.client);

  fixture.assertMcpOnlyHttp();
  await operator.close();
  operator = null;
  await orchestrator.close();
  orchestrator = null;
  await fixture.stopServer();

  const state = await fixture.stateApi.readState();
  assert.equal(state.projects.find((item) => item.id === manual.projectId)?.status, 'active');
  assert.equal(
    state.workflow_nodes
      .filter((item) => item.workflow_id === manual.workflowId && item.role === 'workstream')
      .every((item) => item.status !== 'completed'),
    true
  );
  assert.equal(state.repository_connections.filter((item) => item.project_id === coding.projectId).length, 2);
  assert.equal(
    state.node_runs.filter((item) => [manual.projectId, coding.projectId].includes(item.project_id)).length,
    0
  );
  assert.equal(state.deliveries.filter((item) => item.project_id === coding.projectId).length, 0);
  assert.equal(state.pull_request_intents.filter((item) => item.project_id === coding.projectId).length, 0);

  console.log(
    `V1.10 MCP legacy orchestration bypass rejection journeys passed (${manual.projectId}, ${coding.projectId})`
  );
} finally {
  await operator?.close();
  await orchestrator?.close();
  await fixture.close();
}

async function completeNonCodingJourney(operatorClient, approverClient) {
  const created = resultData(
    await callOperation(operatorClient, 'aiws.projects.post.projects', {
      body: {
        title: 'Community research program',
        goal: 'Deliver an accepted community evidence brief',
        operation_key: 'v19-manual-project'
      }
    })
  );
  const projectId = created.project.id;
  const intake = resultData(
    await callOperation(operatorClient, 'aiws.projects.put.projects.by-id.intake', {
      params: { id: projectId },
      body: {
        mode: 'brainstorm',
        adapter: 'test',
        answers: {
          goal: 'Deliver an accepted community evidence brief',
          users: ['Program owner', 'Community reviewers'],
          scope_in: ['Interview evidence', 'Decision record'],
          scope_out: ['Software implementation'],
          features: ['Traceable findings', 'Manual review'],
          constraints: ['No source repository'],
          milestones: ['Evidence accepted'],
          acceptance_criteria: ['Reviewers accept the evidence brief'],
          risks: ['Incomplete evidence'],
          open_questions: ['None']
        }
      }
    })
  );
  const generationId = intake.workflow_generation.id;
  const generationWait = await callTool(operatorClient, 'aiws_operations', {
    action: 'wait',
    operation_id: generationId,
    timeout_ms: 10_000,
    poll_ms: 50
  });
  assert.equal(generationWait.data.operation.status, 'completed');
  const generationEvents = await callTool(operatorClient, 'aiws_operations', {
    action: 'read_events',
    operation_id: generationId,
    limit: 100
  });
  assert.equal(
    generationEvents.data.items.some(
      (item) => item.source === 'workflow_generation_event' && item.type === 'completed'
    ),
    true
  );
  const generated = resultData(
    await callOperation(
      operatorClient,
      'aiws.workflow.get.projects.by-id.workflow-draft.generations.by-generation-id',
      {
        params: { id: projectId, generationId }
      }
    )
  );
  assert.equal(generated.candidate.project_classification, 'knowledge_or_manual_delivery');
  assert.equal(
    generated.candidate.nodes.some((item) => item.role === 'workstream' && /coding|testing|design/i.test(item.title)),
    false
  );

  const onboarding = resultData(
    await callOperation(operatorClient, 'aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } })
  );
  assert.equal(onboarding.workflow_draft.nodes.filter((item) => item.role === 'workstream').length, 1);
  const draftTasks = onboarding.workflow_draft.nodes.filter((item) => item.role === 'task');
  assert.deepEqual(
    draftTasks.map((item) => item.task_kind),
    ['research', 'content', 'review']
  );
  const confirmed = resultData(
    await callOperation(operatorClient, 'aiws.projects.post.projects.by-id.onboarding.confirm', {
      params: { id: projectId },
      body: {
        expected_brief_revision: onboarding.brief.revision,
        expected_workflow_revision: onboarding.workflow_draft.revision
      }
    })
  );
  const workflowId = confirmed.workflow.id;
  const workstream = confirmed.nodes.find((item) => item.role === 'workstream');
  const tasks = confirmed.nodes
    .filter((item) => item.role === 'task')
    .sort((left, right) => left.order_index - right.order_index);
  const topGraph = resultData(
    await callOperation(operatorClient, 'aiws.workflow.get.workflows.by-id.graph', {
      params: { id: workflowId },
      query: {}
    })
  );
  const taskGraph = resultData(
    await callOperation(operatorClient, 'aiws.workflow.get.workflows.by-id.graph', {
      params: { id: workflowId },
      query: { parent_node_id: workstream.id }
    })
  );
  assert.deepEqual(
    topGraph.nodes.map((item) => item.id),
    [workstream.id]
  );
  assert.deepEqual(
    taskGraph.nodes.map((item) => item.id),
    tasks.map((item) => item.id)
  );
  await assertLegacyTaskRunRejected(operatorClient, approverClient, { projectId, task: tasks[0] });
  return { projectId, workflowId };
}

async function completeMultiRepositoryJourney(operatorClient, approverClient) {
  const created = resultData(
    await callOperation(operatorClient, 'aiws.projects.post.projects', {
      body: {
        title: 'Multi repository release',
        goal: 'Deliver verified changes to two repositories',
        operation_key: 'v19-multi-repo-project'
      }
    })
  );
  const projectId = created.project.id;
  const intake = resultData(
    await callOperation(operatorClient, 'aiws.projects.put.projects.by-id.intake', {
      params: { id: projectId },
      body: {
        mode: 'existing',
        adapter: 'test',
        code_source: { type: 'local_git', path: repositories.alpha },
        answers: {
          goal: 'Deliver verified changes to two repositories',
          features: ['Alpha service change', 'Beta service change'],
          acceptance_criteria: ['Both Draft PRs pass policy tests']
        }
      }
    })
  );
  assert.equal(intake.workflow_generation, null, 'generation waits until the existing code source is imported');
  const imported = resultData(
    await callOperation(operatorClient, 'aiws.projects.post.projects.by-id.imports', {
      params: { id: projectId },
      body: { operation_key: 'v19-multi-repo-import', adapter: 'test' }
    })
  );
  const generationId = imported.workflow_generation.id;
  assert.equal(
    (
      await callTool(operatorClient, 'aiws_operations', {
        action: 'wait',
        operation_id: generationId,
        timeout_ms: 10_000,
        poll_ms: 50
      })
    ).data.operation.status,
    'completed'
  );

  let onboarding = resultData(
    await callOperation(operatorClient, 'aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } })
  );
  const reviewedDraft = resultData(
    await callOperation(operatorClient, 'aiws.workflow.patch.projects.by-id.workflow-draft', {
      params: { id: projectId },
      body: {
        expected_revision: onboarding.workflow_draft.revision,
        nodes: codingHierarchy(),
        brief_coverage: {
          features: ['task-alpha-repository', 'task-beta-repository'],
          acceptance_criteria: ['task-beta-repository'],
          milestones: ['task-beta-repository']
        }
      }
    })
  );
  onboarding = resultData(
    await callOperation(operatorClient, 'aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } })
  );
  assert.equal(
    reviewedDraft.user_modified_at != null,
    true,
    'the generated candidate is explicitly reviewed and edited before confirmation'
  );
  const confirmed = resultData(
    await callOperation(operatorClient, 'aiws.projects.post.projects.by-id.onboarding.confirm', {
      params: { id: projectId },
      body: { expected_brief_revision: onboarding.brief.revision, expected_workflow_revision: reviewedDraft.revision }
    })
  );
  const workstream = confirmed.nodes.find((item) => item.id === 'ws-multi-repo-release');
  const evidenceTask = confirmed.nodes.find((item) => item.id === 'task-release-evidence');
  const alphaTask = confirmed.nodes.find((item) => item.id === 'task-alpha-repository');
  const betaTask = confirmed.nodes.find((item) => item.id === 'task-beta-repository');

  const [alphaConnection, betaConnection] = await Promise.all([
    callOperation(approverClient, 'aiws.github.post.projects.by-id.repository-connections', {
      params: { id: projectId },
      body: {
        adapter: 'test',
        installation_id: 'installation-v19',
        repository_id: 'repo-alpha',
        full_name: 'acme/service-alpha',
        default_branch: 'main',
        local_path: repositories.alpha,
        permissions: { read: true, push: true, pull_requests: true }
      }
    }).then(resultData),
    callOperation(approverClient, 'aiws.github.post.projects.by-id.repository-connections', {
      params: { id: projectId },
      body: {
        adapter: 'test',
        installation_id: 'installation-v19',
        repository_id: 'repo-beta',
        full_name: 'acme/service-beta',
        default_branch: 'main',
        local_path: repositories.beta,
        permissions: { read: true, push: true, pull_requests: true }
      }
    }).then(resultData)
  ]);
  const alphaConnectionId = alphaConnection.connection.id,
    betaConnectionId = betaConnection.connection.id;
  const [alphaWorkspace, betaWorkspace] = await Promise.all([
    createRepositoryWorkspace(approverClient, {
      projectId,
      connectionId: alphaConnectionId,
      operationKey: 'v19-alpha-workspace',
      makeDefault: true
    }),
    createRepositoryWorkspace(approverClient, {
      projectId,
      connectionId: betaConnectionId,
      operationKey: 'v19-beta-workspace'
    })
  ]);
  await callOperation(approverClient, 'aiws.github.put.workstreams.by-id.repository-targets', {
    params: { id: workstream.id },
    body: { connection_ids: [alphaConnectionId, betaConnectionId] }
  });
  await Promise.all([
    callOperation(approverClient, 'aiws.github.put.tasks.by-id.repository-targets', {
      params: { id: alphaTask.id },
      body: { write_connection_id: alphaConnectionId, read_connection_ids: [betaConnectionId] }
    }),
    callOperation(approverClient, 'aiws.github.put.tasks.by-id.repository-targets', {
      params: { id: betaTask.id },
      body: { write_connection_id: betaConnectionId, read_connection_ids: [alphaConnectionId] }
    })
  ]);
  const [alphaPolicy, betaPolicy] = await Promise.all([
    callOperation(approverClient, 'aiws.github.post.workstreams.by-id.delivery-policies', {
      params: { id: workstream.id },
      body: {
        connection_id: alphaConnectionId,
        base_ref: 'main',
        path_prefixes: ['src/alpha'],
        test_commands: ['node -e "process.exit(0)"'],
        automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr']
      }
    }).then(resultData),
    callOperation(approverClient, 'aiws.github.post.workstreams.by-id.delivery-policies', {
      params: { id: workstream.id },
      body: {
        connection_id: betaConnectionId,
        base_ref: 'main',
        path_prefixes: ['src/beta'],
        test_commands: ['node -e "process.exit(0)"'],
        automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr']
      }
    }).then(resultData)
  ]);
  await assertLegacyTaskRunRejected(operatorClient, approverClient, { projectId, task: evidenceTask });
  await assertLegacyDeliveryRejected(approverClient, {
    task: alphaTask,
    policyId: alphaPolicy.id,
    repositoryWorkspaceId: alphaWorkspace.id,
    change: { path: 'src/alpha/change.txt', content: 'must not be written\n' }
  });
  assert.ok(betaPolicy.id && betaWorkspace.id && betaTask.id);
  return { projectId, workflowId: confirmed.workflow.id };
}

function initializeRepository(target, name) {
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(target, 'src', '.gitkeep'), '', 'utf8');
  fs.writeFileSync(path.join(target, 'README.md'), `# ${name}\n`, 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: target, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=AIWS MCP Test', '-c', 'user.email=aiws-mcp@local.invalid', 'commit', '-m', 'initial'],
    { cwd: target, stdio: 'ignore' }
  );
}
