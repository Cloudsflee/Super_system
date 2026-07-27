import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-mcp-context-'));
process.env.AIWS_HOME = path.join(root, 'home');
process.env.NODE_ENV = 'test';

try {
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry, executeRegistryOperation } =
    await import('../../apps/api/src/api-route-registry.mjs');
  const { createAiwsMcpServer } = await import('../../apps/api/src/mcp-server-factory.mjs');
  const { ensureContextProjection, createSelectionForRuntimeInState } =
    await import('../../apps/api/src/context-service.mjs');
  const { issueCodexMcpAccess } = await import('../../apps/api/src/codex-mcp-runtime.mjs');
  const { authenticateMcpToken } = await import('../../apps/api/src/mcp-client-service.mjs');
  const stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  const state = await stateApi.readState();
  const registry = createApiRouteRegistry(apiRoutes);
  const operations = new Map(registry.map((item) => [item.operation_id, item]));
  const expected = [
    'aiws.context.get.context.v1.map',
    'aiws.context.post.context.v1.search',
    'aiws.context.get.context.v1.nodes.by-id',
    'aiws.context.post.context.v1.selections',
    'aiws.context.get.context.v1.selections.by-id',
    'aiws.context.get.context.v1.policy',
    'aiws.context.put.context.v1.policy',
    'aiws.context.get.context.v1.status',
    'aiws.context.post.context.v1.rebuild'
  ];
  for (const operationId of expected) assert.ok(operations.has(operationId), operationId);
  assert.deepEqual(operations.get('aiws.context.get.context.v1.map').required_scopes, ['context:read']);
  assert.deepEqual(operations.get('aiws.context.post.context.v1.rebuild').required_scopes, ['context:admin']);

  const client = {
    id: 'mcp-context-client',
    subject_user_id: state.instance_owner_user_id,
    scopes: ['context:read', 'context:admin'],
    project_allowlist: []
  };
  const built = createAiwsMcpServer({ registry, client });
  try {
    assert.ok(built.server._registeredTools.aiws_context);
    assert.deepEqual(
      Object.keys(built.server._registeredResourceTemplates)
        .filter((name) => name.startsWith('aiws-context-'))
        .sort(),
      ['aiws-context-map', 'aiws-context-node', 'aiws-context-selection']
    );

    const toolMap = payload(
      await built.server._registeredTools.aiws_context.handler({ action: 'map', depth: 2, limit: 100 })
    );
    assert.equal(toolMap.ok, true);
    assert.equal(toolMap.data.uri, 'aiws://context/map/global');
    const rootNode = toolMap.data.nodes.find((node) => node.id === 'ctx_root_system');

    const toolRead = payload(
      await built.server._registeredTools.aiws_context.handler({ action: 'read', node_id: rootNode.id })
    );
    assert.equal(toolRead.ok, true);
    assert.equal(toolRead.data.node.id, rootNode.id);

    const resource = await built.server._registeredResourceTemplates['aiws-context-map'].readCallback(
      new URL('aiws://context/map/global'),
      { scope: 'global' }
    );
    const resourceMap = JSON.parse(resource.contents[0].text);
    assert.equal(resourceMap.ok, true);
    assert.equal(resourceMap.data.snapshot_hash, toolMap.data.snapshot_hash);

    const selection = await executeRegistryOperation(
      registry,
      'aiws.context.post.context.v1.selections',
      { body: { candidate_node_ids: [rootNode.id], token_budget: 10_000 } },
      { client }
    );
    assert.equal(selection.ok, true);
    const explained = payload(
      await built.server._registeredTools.aiws_context.handler({
        action: 'explain_selection',
        selection_id: selection.data.id
      })
    );
    assert.equal(explained.ok, true);
    assert.equal(explained.data.id, selection.data.id);
  } finally {
    await built.dispose();
  }

  const ownerId = state.instance_owner_user_id;
  await stateApi.mutate((data) => {
    data.projects.push(
      {
        id: 'project-runtime-context',
        title: 'Runtime Context Project',
        status: 'active',
        owner_user_id: ownerId,
        settings: {}
      },
      {
        id: 'project-foreign-context',
        title: 'Foreign Context Project',
        status: 'active',
        owner_user_id: ownerId,
        settings: {}
      }
    );
    data.workflows.push({
      id: 'workflow-runtime-context',
      project_id: 'project-runtime-context',
      title: 'Runtime Context Workflow',
      status: 'active'
    });
    data.workflow_executions.push({
      id: 'wex-runtime-context',
      project_id: 'project-runtime-context',
      workflow_id: 'workflow-runtime-context',
      workflow_revision: 1,
      status: 'running'
    });
    data.workspaces.push({
      id: 'workspace-runtime-context',
      project_id: 'project-runtime-context',
      title: 'Runtime Context Task'
    });
    data.workflow_nodes.push({
      id: 'task-runtime-context',
      workflow_id: 'workflow-runtime-context',
      workspace_id: 'workspace-runtime-context',
      role: 'task',
      title: 'Use dynamic context',
      status: 'running'
    });
    data.decisions.push(
      {
        id: 'decision-runtime-context',
        project_id: 'project-runtime-context',
        title: 'Runtime Architecture Note',
        statement: 'Use the exact approved runtime context document.',
        status: 'confirmed'
      },
      {
        id: 'decision-foreign-context',
        project_id: 'project-foreign-context',
        title: 'Foreign Architecture Note',
        statement: 'This project must remain inaccessible to the bound run.',
        status: 'confirmed'
      }
    );
    data.context_packs.push({
      id: 'ctxpack-runtime-context',
      source_workspace_id: 'workspace-runtime-context',
      content_json: { project: { id: 'project-runtime-context' } }
    });
    data.task_executions.push({
      id: 'tex-runtime-context',
      workflow_execution_id: 'wex-runtime-context',
      project_id: 'project-runtime-context',
      workflow_id: 'workflow-runtime-context',
      workstream_id: null,
      task_id: 'task-runtime-context',
      task_revision: 1,
      contract_id: null,
      contract_version: 1,
      attempt: 1,
      executor: 'assist',
      status: 'running',
      readiness: { ready: true, reasons: [] },
      context_snapshot: null,
      output_bindings: [],
      consumed_inputs: [],
      acceptance_results: []
    });
    data.node_runs.push({
      id: 'run-runtime-context',
      project_id: 'project-runtime-context',
      node_id: 'task-runtime-context',
      task_execution_id: 'tex-runtime-context',
      context_pack_id: 'ctxpack-runtime-context',
      status: 'running'
    });
  });
  await ensureContextProjection({ projectId: 'project-runtime-context' });
  await ensureContextProjection({ projectId: 'project-foreign-context' });
  const runtimeSetup = await stateApi.mutate((data) => {
    const selection = createSelectionForRuntimeInState(data, {
      actorId: ownerId,
      projectId: 'project-runtime-context',
      anchorSourceCollection: 'workflow_nodes',
      anchorSourceId: 'task-runtime-context',
      candidateLimit: 0,
      tokenBudget: 50_000
    });
    const execution = data.task_executions.find((item) => item.id === 'tex-runtime-context');
    execution.context_snapshot = {
      system_context: {
        context_selection_id: selection.id,
        current_anchor: { node_id: selection.anchor_node_id },
        document_versions: selection.included.map((item) => ({
          node_id: item.node_id,
          document_version_id: item.document_version_id,
          content_sha256: item.content_sha256,
          required: false
        }))
      }
    };
    return { selectionId: selection.id, anchorNodeId: selection.anchor_node_id };
  });
  const access = await issueCodexMcpAccess(
    'project-runtime-context',
    { kind: 'host' },
    {
      ttlSeconds: 600,
      contextBinding: {
        run_id: 'run-runtime-context',
        task_execution_id: 'tex-runtime-context',
        context_selection_id: runtimeSetup.selectionId,
        context_pack_id: 'ctxpack-runtime-context',
        anchor_node_id: runtimeSetup.anchorNodeId
      }
    }
  );
  const runtimeClient = await authenticateMcpToken(access.env.AIWS_MCP_TOKEN),
    runtimeServer = createAiwsMcpServer({ registry, client: runtimeClient });
  try {
    const scopedMap = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({ action: 'map', depth: 4, limit: 1000 })
    );
    assert.equal(scopedMap.ok, true, JSON.stringify(scopedMap));
    assert.equal(scopedMap.data.project_id, 'project-runtime-context');
    assert.equal(
      scopedMap.data.nodes.every((node) => node.project_id === 'project-runtime-context'),
      true
    );

    const budgetedSearch = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({
        action: 'search',
        query: 'Runtime Architecture Note',
        token_budget: 1,
        limit: 10
      })
    );
    assert.equal(budgetedSearch.ok, true);
    const target = budgetedSearch.data.results.find((item) => item.source_id === 'decision-runtime-context');
    assert.ok(target);
    assert.equal(
      budgetedSearch.data.context_selection.excluded.some(
        (item) => item.node_id === target.id && item.reason === 'budget_exceeded'
      ),
      true
    );
    const unapprovedRead = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({
        action: 'read',
        node_id: target.id,
        selection_id: budgetedSearch.data.context_selection_id
      })
    );
    assert.equal(unapprovedRead.ok, false);
    assert.equal(unapprovedRead.error.error, 'context_runtime_selection_document_not_included');

    const approvedSearch = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({
        action: 'search',
        query: 'Runtime Architecture Note',
        limit: 10
      })
    );
    assert.equal(approvedSearch.ok, true);
    assert.equal(
      approvedSearch.data.approved_document_versions.some((item) => item.node_id === target.id),
      true
    );
    const approvedRead = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({
        action: 'read',
        node_id: target.id,
        selection_id: approvedSearch.data.context_selection_id
      })
    );
    assert.equal(approvedRead.ok, true);
    assert.equal(approvedRead.data.node.id, target.id);
    assert.equal(approvedRead.data.provenance_claim.document_version_id, approvedRead.data.version.id);
    const runtimeState = await stateApi.readState(),
      readReceipt = runtimeState.context_selections.find((item) => item.id === approvedRead.data.context_selection_id);
    assert.equal(readReceipt.runtime_context.purpose, 'mcp_read');
    assert.equal(readReceipt.runtime_context.run_id, 'run-runtime-context');
    assert.equal(readReceipt.runtime_context.read_document_version_id, approvedRead.data.version.id);

    const foreignSearch = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({
        action: 'search',
        project_id: 'project-foreign-context',
        query: 'Foreign Architecture Note',
        limit: 10
      })
    );
    assert.equal(foreignSearch.ok, false);
    assert.equal(
      ['mcp_project_access_denied', 'context_runtime_project_mismatch'].includes(foreignSearch.error.error),
      true
    );
    const foreignNode = runtimeState.context_nodes.find(
      (item) => item.source_collection === 'decisions' && item.source_id === 'decision-foreign-context'
    );
    const foreignRead = payload(
      await runtimeServer.server._registeredTools.aiws_context.handler({ action: 'read', node_id: foreignNode.id })
    );
    assert.equal(foreignRead.ok, false);
    assert.equal(foreignRead.error.error, 'mcp_project_access_denied');
  } finally {
    await runtimeServer.dispose();
    await access.release();
  }

  console.log('V2.0 MCP context tool and resource parity tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function payload(result) {
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}
