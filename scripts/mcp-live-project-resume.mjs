#!/usr/bin/env node
import assert from 'node:assert/strict';
import { adminJson, connectMcp, dataOf, normalizeBaseUrl, publicError } from './mcp-live-smoke-support.mjs';

assert.equal(
  process.env.AIWS_MCP_LIVE_SMOKE_CONFIRM,
  'retry-live-delivery',
  'set AIWS_MCP_LIVE_SMOKE_CONFIRM=retry-live-delivery'
);
const baseUrl = normalizeBaseUrl(process.env.AIWS_BASE_URL || 'http://127.0.0.1:4317');
const projectId = required(process.env.AIWS_MCP_LIVE_PROJECT_ID, 'AIWS_MCP_LIVE_PROJECT_ID');
const sourceDeliveryId = required(process.env.AIWS_MCP_LIVE_DELIVERY_ID, 'AIWS_MCP_LIVE_DELIVERY_ID');
const evidence = {
  status: 'running',
  business_transport: 'mcp-only',
  project_id: projectId,
  source_delivery_id: sourceDeliveryId,
  retry_delivery_id: null,
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
  assert.equal(owner?.role, 'owner');
  const created = await adminJson(baseUrl, '/api/mcp/clients', {
    method: 'POST',
    ownerId: owner.id,
    body: {
      name: `Live Delivery retry ${sourceDeliveryId}`,
      subject_user_id: owner.id,
      project_allowlist: [projectId],
      ttl_seconds: 1800,
      concurrent_limit: 4,
      rate_limit_per_minute: 600,
      scopes: [
        'system:read',
        'project:read',
        'project:write',
        'workflow:read',
        'workflow:write',
        'runs:read',
        'github:read',
        'github:write',
        'approval:read',
        'approval:decide'
      ]
    }
  });
  clientRecord = { id: created.client.id, ownerId: owner.id, token: created.token };
  mcp = await connectMcp(baseUrl, clientRecord.token);

  stage = 'source-delivery';
  const source = dataOf(
    await mcp.mustOperation('aiws.github.get.deliveries.by-id', { params: { id: sourceDeliveryId } })
  );
  assert.equal(source.project_id, projectId);
  let delivery = source;
  if (source.status !== 'completed') {
    assert.equal(source.status, 'failed');
    assert.equal(source.retryable, true);
    stage = 'delivery-retry';
    const started = await mcp.mustOperation('aiws.github.post.deliveries.by-id.retry', {
      params: { id: sourceDeliveryId },
      body: {}
    });
    const retryId = started.handle?.id || dataOf(started)?.delivery?.id;
    assert.ok(retryId, 'retry Delivery id is missing');
    evidence.retry_delivery_id = retryId;
    console.log(`[mcp-resume] delivery=${retryId} running`);
    const operation = await mcp.waitForOperation(retryId, 20 * 60_000);
    delivery = dataOf(await mcp.mustOperation('aiws.github.get.deliveries.by-id', { params: { id: retryId } }));
    if (operation.status !== 'completed') throw deliveryFailure(delivery);
  } else evidence.retry_delivery_id = source.id;
  assert.equal(delivery.pr_state, 'draft');
  assert.ok(delivery.pr_url);
  assert.ok(delivery.test_results?.length && delivery.test_results.every((item) => item.status === 'passed'));
  evidence.draft_pr_url = delivery.pr_url;

  stage = 'workflow-review';
  let task = await workflowNode(mcp, delivery.workflow_id, delivery.workstream_id, delivery.task_id);
  if (task.status !== 'completed') {
    if (task.status !== 'needs_review')
      await mcp.mustOperation('aiws.workflow.post.tasks.by-id.submissions', {
        params: { id: delivery.task_id },
        body: {
          title: 'Live MCP delivery',
          summary: 'Source, tests, commit, push, and Draft PR completed.',
          evidence_refs: [`delivery:${delivery.id}`]
        }
      });
    await mcp.mustOperation('aiws.workflow.post.tasks.by-id.review', {
      params: { id: delivery.task_id },
      body: { decision: 'approve', summary: 'Automated tests and Draft PR evidence accepted.' }
    });
    task = await workflowNode(mcp, delivery.workflow_id, delivery.workstream_id, delivery.task_id);
  }
  assert.equal(task.status, 'completed');
  let workstream = await workflowNode(mcp, delivery.workflow_id, null, delivery.workstream_id);
  if (workstream.status !== 'completed') {
    if (workstream.status !== 'needs_review')
      await mcp.mustOperation('aiws.workflow.post.workstreams.by-id.submissions', {
        params: { id: delivery.workstream_id },
        body: {
          summary: 'The verified Node utility is available as a tested Draft PR.',
          evidence_refs: [`delivery:${delivery.id}`]
        }
      });
    const reviewed = dataOf(
      await mcp.mustOperation('aiws.workflow.post.workstreams.by-id.review', {
        params: { id: delivery.workstream_id },
        body: { decision: 'approve', summary: 'Live MCP project outcome accepted.' }
      })
    );
    workstream = reviewed.workstream;
  }
  assert.equal(workstream.status, 'completed');
  evidence.completed_workstream = true;

  stage = 'resource-verification';
  const project = await mcp.readResource(`aiws://projects/${projectId}`);
  const workflow = await mcp.readResource(`aiws://workflows/${delivery.workflow_id}`);
  assert.equal(project.data.project.id, projectId);
  assert.equal(workflow.data.workflow.id, delivery.workflow_id);
  const repositories = dataOf(
    await mcp.mustOperation('aiws.github.get.projects.by-id.github.repositories', { params: { id: projectId } })
  );
  assert.equal(repositories.repositories.length, 1);
  evidence.repository = repositories.repositories[0].full_name;
  evidence.status = 'passed';
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

function required(value, name) {
  const result = String(value || '').trim();
  assert.ok(result, `${name} is required`);
  return result;
}
function deliveryFailure(delivery) {
  const error = new Error(`delivery failed: ${delivery.error_code || delivery.status}`);
  error.details = { status: delivery.status, error_code: delivery.error_code, error_detail: delivery.error_detail };
  return error;
}
async function workflowNode(mcpClient, workflowId, parentNodeId, nodeId) {
  const graph = dataOf(
    await mcpClient.mustOperation('aiws.workflow.get.workflows.by-id.graph', {
      params: { id: workflowId },
      query: parentNodeId ? { parent_node_id: parentNodeId } : {}
    })
  );
  const node = graph.nodes.find((item) => item.id === nodeId);
  assert.ok(node, `workflow node not found: ${nodeId}`);
  return node;
}
