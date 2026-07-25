#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  adminJson,
  connectMcp,
  createRepositoryWithVisibilityRetry,
  dataOf,
  normalizeBaseUrl,
  publicError
} from './mcp-live-smoke-support.mjs';

const baseUrl = normalizeBaseUrl(process.env.AIWS_BASE_URL || 'http://127.0.0.1:4317');
const confirmation = process.env.AIWS_MCP_LIVE_SMOKE_CONFIRM;
assert.equal(
  confirmation,
  'create-private-github-repository',
  'set AIWS_MCP_LIVE_SMOKE_CONFIRM=create-private-github-repository'
);

const suffix = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
const repositoryName = String(process.env.AIWS_MCP_LIVE_REPOSITORY_NAME || `aiws-mcp-smoke-${suffix}`);
const resumedProjectId = String(process.env.AIWS_MCP_LIVE_PROJECT_ID || '').trim();
assert.match(repositoryName, /^[A-Za-z0-9._-]{1,100}$/);

const evidence = {
  status: 'running',
  repository_name: repositoryName,
  business_transport: 'mcp-only',
  project_id: null,
  workflow_id: null,
  repository: null,
  canonical_repository_id: null,
  delivery_id: null,
  draft_pr_url: null,
  completed_workstream: false,
  mcp_client_revoked: false
};
let clientRecord = null;
let mcp = null;
let stage = 'bootstrap';

try {
  const account = await adminJson(baseUrl, '/api/account/me');
  const owner = account.user;
  assert.equal(owner?.role, 'owner', 'the local account must be the instance Owner');

  const created = await adminJson(baseUrl, '/api/mcp/clients', {
    method: 'POST',
    ownerId: owner.id,
    body: {
      name: `Live project smoke ${suffix}`,
      subject_user_id: owner.id,
      allow_all_projects: true,
      ttl_seconds: 7200,
      concurrent_limit: 8,
      rate_limit_per_minute: 1200,
      scopes: [
        'system:read',
        'project:create',
        'project:read',
        'project:write',
        'workflow:read',
        'workflow:write',
        'runs:read',
        'runs:write',
        'files:read',
        'files:write',
        'git:read',
        'git:write',
        'github:read',
        'github:write',
        'assets:read',
        'assets:write',
        'governance:read',
        'governance:write',
        'approval:read',
        'approval:decide',
        'setup:read',
        'setup:admin'
      ]
    }
  });
  clientRecord = { id: created.client.id, ownerId: owner.id, token: created.token };

  mcp = await connectMcp(baseUrl, clientRecord.token);
  const { callTool, mustOperation, waitForOperation, readResource } = mcp;
  console.log(`[mcp-smoke] connected server=${mcp.client.getServerVersion().name}`);

  stage = 'capability-discovery';
  for (const operationId of [
    'aiws.projects.post.projects',
    'aiws.github.post.projects.by-id.github.repository',
    'aiws.github.post.tasks.by-id.deliveries'
  ]) {
    const described = await callTool('aiws_capabilities', { action: 'describe', operation_id: operationId });
    assert.equal(described.ok, true, `missing MCP capability ${operationId}`);
  }

  stage = 'github-installation-sync';
  const synced = dataOf(await mustOperation('aiws.github.post.github.repositories.sync', { body: {} }));
  const installations = synced.installations || [];
  const installation = installations.find((item) => item.status === 'active');
  assert.ok(installation, 'an active GitHub App installation is required');
  console.log(
    `[mcp-smoke] github installation=${installation.installation_id} repositories=${installation.repositories?.length || 0}`
  );

  stage = 'project-create';
  let projectId = resumedProjectId;
  if (projectId) {
    const resource = await readResource(`aiws://projects/${projectId}`);
    assert.equal(resource.data.project.status, 'draft', 'resumed Project must still be a draft');
    console.log(`[mcp-smoke] resume project=${projectId}`);
  } else {
    const projectCreated = dataOf(
      await mustOperation('aiws.projects.post.projects', {
        body: {
          title: `MCP Live Smoke ${suffix}`,
          goal: 'Build and deliver a tested dependency-free Node.js health report utility through MCP.',
          operation_key: `mcp-live-project-${suffix}`
        }
      })
    );
    projectId = projectCreated.project.id;
  }
  evidence.project_id = projectId;
  console.log(`[mcp-smoke] project=${projectId}`);

  stage = 'github-repository-create';
  const repositoryCreated = await createRepositoryWithVisibilityRetry({
    mcp,
    repositoryName,
    projectId,
    installationId: installation.installation_id,
    operationKey: `mcp-live-repository-${suffix}`
  });
  const repositoryResult = dataOf(repositoryCreated);
  const repository = repositoryResult.repository;
  assert.ok(repository?.id && repository?.full_name, 'GitHub repository creation returned no repository identity');
  assert.equal(repositoryResult.binding?.status, 'ready');
  assert.equal(repositoryResult.checkout?.ready, true);
  evidence.repository = {
    id: repository.id,
    full_name: repository.full_name,
    html_url: repository.html_url,
    private: repository.private
  };
  evidence.canonical_repository_id = repositoryResult.canonical_repository?.id || null;
  console.log(`[mcp-smoke] repository=${repository.full_name} checkout=ready`);

  stage = 'project-intake';
  const intake = dataOf(
    await mustOperation('aiws.projects.put.projects.by-id.intake', {
      params: { id: projectId },
      body: {
        mode: 'brainstorm',
        adapter: 'test',
        answers: {
          goal: 'Deliver a dependency-free Node.js health report utility in a Draft PR.',
          users: ['Individual developer'],
          scope_in: ['Source', 'Tests', 'README'],
          scope_out: ['Deployment'],
          features: ['Deterministic health report', 'Node test coverage'],
          constraints: ['No runtime dependencies'],
          milestones: ['Implement', 'Test', 'Review'],
          acceptance_criteria: ['node --test passes', 'Draft PR is created'],
          risks: ['GitHub App permissions'],
          open_questions: ['None']
        }
      }
    })
  );
  if (intake.workflow_generation?.id) await waitForOperation(intake.workflow_generation.id, 120_000);

  stage = 'workflow-confirm';
  let onboarding = dataOf(
    await mustOperation('aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } })
  );
  const workstreamId = `ws-${suffix}`;
  const taskId = `task-${suffix}`;
  await mustOperation('aiws.workflow.patch.projects.by-id.workflow-draft', {
    params: { id: projectId },
    body: {
      expected_revision: onboarding.workflow_draft.revision,
      nodes: [
        {
          id: workstreamId,
          role: 'workstream',
          title: 'Deliver verified Node utility',
          goal: 'Produce a tested implementation and reviewable Draft PR.',
          outcome: 'A dependency-free health report utility with automated tests.',
          category: 'deliverable',
          boundary: { repository: repository.full_name, deliverable: 'draft-pr' },
          acceptance_criteria: ['node --test passes', 'Draft PR contains source, tests, and README'],
          dependency_ids: [],
          tasks: [
            {
              id: taskId,
              role: 'task',
              title: 'Implement health report utility',
              goal: 'Create package.json, src/index.js, test/index.test.js, and README.md. Export buildHealthReport(input), validate input, keep output deterministic, and make node --test pass.',
              task_kind: 'code',
              execution_mode: 'codex',
              dependency_ids: [],
              repository_intent: { mode: 'write', repository: repository.full_name }
            }
          ]
        }
      ]
    }
  });
  onboarding = dataOf(
    await mustOperation('aiws.projects.get.projects.by-id.onboarding', { params: { id: projectId } })
  );
  const confirmed = dataOf(
    await mustOperation('aiws.projects.post.projects.by-id.onboarding.confirm', {
      params: { id: projectId },
      body: {
        expected_brief_revision: onboarding.brief.revision,
        expected_workflow_revision: onboarding.workflow_draft.revision
      }
    })
  );
  evidence.workflow_id = confirmed.workflow.id;

  stage = 'delivery-policy';
  const connection = dataOf(
    await mustOperation('aiws.github.post.projects.by-id.repository-connections', {
      params: { id: projectId },
      body: {
        installation_id: installation.installation_id,
        repository_id: repository.id,
        full_name: repository.full_name,
        default_branch: 'main',
        permissions: { read: true, push: true, pull_requests: true }
      }
    })
  ).connection;
  await mustOperation('aiws.github.put.workstreams.by-id.repository-targets', {
    params: { id: workstreamId },
    body: { connection_ids: [connection.id] }
  });
  await mustOperation('aiws.github.put.tasks.by-id.repository-targets', {
    params: { id: taskId },
    body: { write_connection_id: connection.id, read_connection_ids: [] }
  });
  const policy = dataOf(
    await mustOperation('aiws.github.post.workstreams.by-id.delivery-policies', {
      params: { id: workstreamId },
      body: {
        connection_id: connection.id,
        base_ref: 'main',
        path_prefixes: ['.'],
        test_commands: ['node --test'],
        automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr']
      }
    })
  );

  stage = 'live-delivery';
  const deliveryStart = await mustOperation('aiws.github.post.tasks.by-id.deliveries', {
    params: { id: taskId },
    body: { policy_id: policy.id }
  });
  const deliveryId = deliveryStart.handle?.id || dataOf(deliveryStart)?.delivery?.id;
  assert.ok(deliveryId, 'delivery operation id is missing');
  evidence.delivery_id = deliveryId;
  console.log(`[mcp-smoke] delivery=${deliveryId} running`);
  const deliveryOperation = await waitForOperation(deliveryId, 20 * 60_000);
  assert.equal(
    deliveryOperation.status,
    'completed',
    `delivery failed: ${deliveryOperation.error_code || deliveryOperation.status}`
  );
  const delivery = dataOf(await mustOperation('aiws.github.get.deliveries.by-id', { params: { id: deliveryId } }));
  assert.equal(delivery.pr_state, 'draft');
  assert.ok(delivery.pr_url);
  assert.ok(delivery.test_results?.length && delivery.test_results.every((item) => item.status === 'passed'));
  evidence.draft_pr_url = delivery.pr_url;

  stage = 'workflow-review';
  await mustOperation('aiws.workflow.post.tasks.by-id.submissions', {
    params: { id: taskId },
    body: {
      title: 'Live MCP delivery',
      summary: 'Source, tests, commit, push, and Draft PR completed.',
      evidence_refs: [`delivery:${deliveryId}`]
    }
  });
  await mustOperation('aiws.workflow.post.tasks.by-id.review', {
    params: { id: taskId },
    body: { decision: 'approve', summary: 'Automated tests and Draft PR evidence accepted.' }
  });
  await mustOperation('aiws.workflow.post.workstreams.by-id.submissions', {
    params: { id: workstreamId },
    body: {
      summary: 'The verified Node utility is available as a tested Draft PR.',
      evidence_refs: [`delivery:${deliveryId}`]
    }
  });
  const reviewed = dataOf(
    await mustOperation('aiws.workflow.post.workstreams.by-id.review', {
      params: { id: workstreamId },
      body: { decision: 'approve', summary: 'Live MCP project outcome accepted.' }
    })
  );
  assert.equal(reviewed.workstream.status, 'completed');
  evidence.completed_workstream = true;

  stage = 'resource-verification';
  const projectResource = await readResource(`aiws://projects/${projectId}`);
  const workflowResource = await readResource(`aiws://workflows/${confirmed.workflow.id}`);
  assert.equal(projectResource.data.project.id, projectId);
  assert.equal(workflowResource.data.workflow.id, confirmed.workflow.id);
  const repositoryView = dataOf(
    await mustOperation('aiws.github.get.projects.by-id.github.repositories', { params: { id: projectId } })
  );
  assert.equal(
    repositoryView.repositories.some((item) => String(item.repository_id) === String(repository.id)),
    true
  );

  evidence.status = 'passed';
  console.log(`[mcp-smoke] draft-pr=${delivery.pr_url}`);
} catch (error) {
  evidence.status = 'failed';
  evidence.failed_stage = stage;
  evidence.error = publicError(error);
  process.exitCode = 1;
} finally {
  await mcp?.close();
  if (clientRecord) {
    try {
      await adminJson(baseUrl, `/api/mcp/clients/${encodeURIComponent(clientRecord.id)}`, {
        method: 'DELETE',
        ownerId: clientRecord.ownerId
      });
      evidence.mcp_client_revoked = true;
    } catch (error) {
      evidence.revoke_error = publicError(error);
      process.exitCode = 1;
    }
    clientRecord.token = null;
  }
  console.log(JSON.stringify(evidence, null, 2));
}
