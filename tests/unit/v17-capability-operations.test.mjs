import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v17-capabilities-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const operations = await import('../../apps/api/src/assist-operations.mjs');
  const briefDomain = await import('../../apps/api/src/brief-workflow-domain.mjs');
  const briefService = await import('../../apps/api/src/project-brief-service.mjs');
  const capabilities = await import('../../apps/api/src/assist-capabilities-service.mjs');
  const shared = await import('../../packages/shared/index.mjs');
  await stateApi.ensureRuntime();

  const projectId = 'project-v17-tools',
    briefId = 'brief-v17-tools',
    draftId = 'draft-v17-tools';
  const sessionId = 'session-v17-tools',
    turnId = 'turn-v17-tools';
  const viewContext = {
    route: `/projects/${projectId}/onboarding`,
    browser_instance_id: 'browser-v17-tools',
    surface: {
      id: 'project-onboarding-v17-tools',
      revision: 'surface-v17-r1',
      browser_instance_id: 'browser-v17-tools',
      fields: [{ id: 'brief.goal', label: '核心目标' }]
    }
  };
  const content = briefDomain.legacyBriefToV2(
    {
      goal: '原始目标',
      users: ['Owner'],
      scope: { in: ['Brief'], out: [] },
      acceptance_criteria: ['可验证']
    },
    { briefId, title: 'V1.7 能力简报' }
  );
  const workflow = briefDomain.createWorkflowDraft({
    project: { id: projectId },
    brief: { id: briefId, revision: 1, content },
    deterministic: true,
    timestamp: '2026-07-14T00:00:00.000Z'
  });
  workflow.id = draftId;

  await stateApi.mutate((state) => {
    state.projects = [
      { id: projectId, title: 'V1.7 Tools', status: 'draft', managed_workspace_state: 'empty', settings: {} }
    ];
    state.project_briefs = [
      {
        id: briefId,
        project_id: projectId,
        version: 1,
        revision: 1,
        status: 'draft',
        content,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString()
      }
    ];
    state.workflow_drafts = [workflow];
    state.assist_sessions = [
      {
        id: sessionId,
        version: 3,
        project_id: projectId,
        scope_type: 'project',
        scope_id: projectId,
        archived_at: null,
        view_context: viewContext
      }
    ];
    state.assist_turns = [
      {
        id: turnId,
        session_id: sessionId,
        project_id: projectId,
        status: 'running',
        mode: 'default',
        collaboration_mode: 'default',
        view_context: viewContext,
        operation_reference_id: null
      }
    ];
    state.assist_operations = [];
  });

  const initialState = await stateApi.readState();
  const specs = operations.dynamicPageToolSpec(viewContext, 'default', { state: initialState, projectId });
  const projectSpec = specs.find((item) => item.name === 'aiws_project');
  assert.ok(projectSpec, 'the current onboarding surface exposes project tools');
  assert.match(
    projectSpec.tools.find((item) => item.name === 'workflow_draft_node_add').description,
    /at most 12 Workstreams/
  );
  const projectDescriptors = shared.ASSIST_CAPABILITY_MANIFEST.filter(
    (item) => item.id.startsWith('project.') && item.route === '/projects/:projectId/onboarding'
  );
  assert.deepEqual(
    new Set(projectSpec.tools.map((item) => item.name)),
    new Set(projectDescriptors.map(shared.assistCapabilityToolName))
  );
  for (const tool of projectSpec.tools) {
    for (const key of ['project_id', 'route', 'surface_id', 'surface_revision', 'browser_instance_id'])
      assert.equal(tool.inputSchema.properties[key].enum.length, 1, `${tool.name}.${key}`);
  }
  assert.deepEqual(operations.dynamicPageToolSpec(viewContext, 'plan', { state: initialState, projectId }), []);

  const unavailable = await capabilities.listAssistCapabilities({
    project_id: projectId,
    route: viewContext.route,
    surface_id: viewContext.surface.id
  });
  assert.equal(
    unavailable.current.find((item) => item.capability_id === 'project.brief.section.update').reason,
    'surface_revision_required'
  );
  const available = await capabilities.listAssistCapabilities({
    project_id: projectId,
    route: viewContext.route,
    surface_id: viewContext.surface.id,
    surface_revision: viewContext.surface.revision
  });
  assert.equal(available.current.find((item) => item.capability_id === 'project.brief.section.update').available, true);
  assert.equal(available.current.find((item) => item.capability_id === 'surface.field.set').reason, 'session_required');
  const surfaceCatalog = await capabilities.listAssistCapabilities({ session_id: sessionId });
  assert.equal(surfaceCatalog.current.find((item) => item.capability_id === 'surface.field.set').available, true);
  assert.equal(
    surfaceCatalog.current.find((item) => item.capability_id === 'surface.filter.set').reason,
    'surface_controls_unavailable'
  );
  assert.equal(
    surfaceCatalog.current.find((item) => item.capability_id === 'surface.tab.select').reason,
    'surface_controls_unavailable'
  );
  const mismatchedSurface = await capabilities.listAssistCapabilities({
    session_id: sessionId,
    surface_revision: 'forged-revision'
  });
  assert.equal(
    mismatchedSurface.current.find((item) => item.capability_id === 'surface.field.set').reason,
    'session_surface_mismatch'
  );
  assert.equal(
    mismatchedSurface.current.find((item) => item.capability_id === 'project.brief.section.update').available,
    true
  );

  const goalId = content.sections.find((item) => item.semantic_key === 'goal').id;
  await operations.handleDynamicPageTool(
    sessionId,
    turnId,
    call('brief_section_update', 'brief-update', 1, {
      type: 'update_section',
      section_id: goalId,
      patch: { markdown: 'Assist 更新目标' }
    })
  );
  let state = await stateApi.readState();
  let brief = state.project_briefs[0],
    updateOperation = state.assist_operations.find((item) => item.tool_call_id === 'brief-update');
  assert.equal(brief.revision, 2);
  assert.equal(brief.content.goal, 'Assist 更新目标');
  assert.equal(updateOperation.status, 'committed');
  assert.equal(updateOperation.execution_layer, 'server');
  assert.equal(updateOperation.capability_id, 'project.brief.section.update');
  assert.equal(updateOperation.target_label, '核心目标');

  const locator = locatorInput();
  const undone = await operations.undoAssistOperation(updateOperation.id, locator);
  assert.equal(undone.status, 'committed');
  state = await stateApi.readState();
  brief = state.project_briefs[0];
  assert.equal(brief.revision, 3);
  assert.equal(brief.content.goal, '原始目标');

  const directRevision = await operations.reviseAssistOperation(updateOperation.id, {
    ...locator,
    session_id: sessionId,
    value: { type: 'markdown', title: '核心目标', semantic_key: 'goal', markdown: '直接定点修订' }
  });
  assert.equal(directRevision.status, 'committed');
  assert.equal(directRevision.action, 'revise');
  state = await stateApi.readState();
  assert.equal(state.project_briefs[0].content.goal, '直接定点修订');

  const usersId = state.project_briefs[0].content.sections.find((item) => item.semantic_key === 'users').id;
  await stateApi.mutate((current) => {
    current.assist_turns[0].operation_reference_id = updateOperation.id;
  });
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool(
        sessionId,
        turnId,
        call('brief_section_update', 'reference-forged-target', state.project_briefs[0].revision, {
          type: 'update_section',
          section_id: usersId,
          patch: { items: ['Forged'] }
        })
      ),
    (error) => error.payload?.error === 'assist_operation_reference_target_mismatch'
  );
  await stateApi.mutate((current) => {
    current.assist_turns[0].operation_reference_id = null;
  });

  await assert.rejects(
    () =>
      operations.handleDynamicPageTool(
        sessionId,
        turnId,
        call('brief_section_update', 'brief-stale', 1, {
          type: 'update_section',
          section_id: goalId,
          patch: { markdown: '不得写入' }
        })
      ),
    (error) => error.payload?.error === 'project_brief_revision_conflict'
  );
  state = await stateApi.readState();
  assert.equal(state.project_briefs[0].content.goal, '直接定点修订');
  const staleOperation = state.assist_operations.find((item) => item.tool_call_id === 'brief-stale');
  assert.equal(staleOperation.status, 'conflicted');
  assert.equal(staleOperation.conflict.before, null);
  assert.equal(staleOperation.conflict.after.markdown, '不得写入');
  assert.equal(staleOperation.conflict.current.markdown, '直接定点修订');
  assert.equal(staleOperation.after_value.markdown, '不得写入');
  assert.equal(staleOperation.current_value.markdown, '直接定点修订');

  for (const [field, value, code] of [
    ['project_id', 'project-forged', 'assist_capability_project_scope_mismatch'],
    ['route', '/projects/project-forged/onboarding', 'assist_capability_route_mismatch'],
    ['surface_id', 'surface-forged', 'assist_capability_surface_mismatch'],
    ['surface_revision', 'surface-forged', 'assist_capability_surface_revision_mismatch'],
    ['browser_instance_id', 'browser-forged', 'assist_capability_browser_mismatch']
  ]) {
    const request = call('brief_section_update', `forged-${field}`, state.project_briefs[0].revision, {
      type: 'update_section',
      section_id: goalId,
      patch: { markdown: 'forged' }
    });
    request.arguments[field] = value;
    await assert.rejects(
      () => operations.handleDynamicPageTool(sessionId, turnId, request),
      (error) => error.payload?.error === code,
      field
    );
  }

  let revision = (await stateApi.readState()).project_briefs[0].revision;
  await operations.handleDynamicPageTool(
    sessionId,
    turnId,
    call('brief_section_update', 'brief-conflict-source', revision, {
      type: 'update_section',
      section_id: goalId,
      patch: { markdown: '准备撤销' }
    })
  );
  state = await stateApi.readState();
  const conflictSource = state.assist_operations.find((item) => item.tool_call_id === 'brief-conflict-source');
  await stateApi.mutate((current) => {
    const actor = current.users[0];
    briefService.patchBriefInState(
      current,
      projectId,
      briefId,
      {
        expected_revision: current.project_briefs[0].revision,
        operations: [{ type: 'update_section', section_id: goalId, patch: { markdown: '并发修改' } }]
      },
      actor.id
    );
  });
  const conflict = await operations.undoAssistOperation(conflictSource.id, locator);
  assert.equal(conflict.status, 'conflicted');
  assert.equal(conflict.conflict.current.markdown, '并发修改');
  const forced = await operations.undoAssistOperation(conflictSource.id, { ...locator, force: true });
  assert.equal(forced.status, 'committed');
  assert.equal(forced.forced, true);
  assert.equal((await stateApi.readState()).project_briefs[0].content.goal, '直接定点修订');

  state = await stateApi.readState();
  const draft = state.workflow_drafts[0];
  await operations.handleDynamicPageTool(
    sessionId,
    turnId,
    call(
      'workflow_draft_node_add',
      'workflow-add',
      draft.revision,
      {
        type: 'add_node',
        node: {
          id: 'node-v17-base',
          role: 'workstream',
          title: '能力验证成果',
          goal: '验证领域工具',
          outcome: '形成能力验证成果',
          category: 'deliverable',
          acceptance_criteria: ['领域工具验证通过'],
          boundary: { deliverable: '能力验证报告' },
          dependency_ids: []
        }
      },
      { resource: 'workflow' }
    )
  );
  state = await stateApi.readState();
  assert.equal(state.workflow_drafts[0].revision, draft.revision + 1);
  const firstNode = state.workflow_drafts[0].nodes.find((item) => item.id === 'node-v17-base');
  assert.equal(firstNode.role, 'workstream');

  await operations.handleDynamicPageTool(
    sessionId,
    turnId,
    call(
      'workflow_draft_node_add',
      'workflow-add-second',
      state.workflow_drafts[0].revision,
      {
        type: 'add_node',
        node: {
          id: 'node-v17-extra',
          role: 'workstream',
          title: '独立调研成果',
          goal: '独立交付调研证据',
          outcome: '形成可引用调研证据',
          category: 'deliverable',
          acceptance_criteria: ['证据来源可追溯'],
          boundary: { owner: 'research-owner' },
          dependency_ids: [firstNode.id]
        }
      },
      { resource: 'workflow' }
    )
  );
  state = await stateApi.readState();
  assert.equal(state.workflow_drafts[0].nodes.length, 2);
  await operations.handleDynamicPageTool(
    sessionId,
    turnId,
    call(
      'workflow_draft_node_add',
      'workflow-add-task',
      state.workflow_drafts[0].revision,
      {
        type: 'add_node',
        node: {
          id: 'task-v17-one',
          role: 'task',
          parent_node_id: firstNode.id,
          title: '执行能力验证',
          task_kind: 'analysis',
          execution_mode: 'assist',
          dependency_ids: []
        }
      },
      { resource: 'workflow' }
    )
  );
  state = await stateApi.readState();
  assert.equal(state.workflow_drafts[0].nodes.find((item) => item.id === 'task-v17-one').parent_node_id, firstNode.id);
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool(
        sessionId,
        turnId,
        call(
          'workflow_draft_node_add',
          'workflow-add-review',
          state.workflow_drafts[0].revision,
          {
            type: 'add_node',
            node: {
              id: 'node-v17-review',
              role: 'workstream',
              title: '复盘阶段',
              outcome: '不得成为顶层流程阶段',
              category: 'operation',
              acceptance_criteria: ['不适用'],
              boundary: { owner: 'owner' },
              dependency_ids: []
            }
          },
          { resource: 'workflow' }
        )
      ),
    (error) => error.payload?.error === 'workflow_workstream_process_stage_forbidden'
  );

  await assert.rejects(
    () =>
      operations.handleDynamicPageTool(
        sessionId,
        turnId,
        call(
          'workflow_draft_node_connect',
          'workflow-cycle',
          state.workflow_drafts[0].revision,
          {
            type: 'connect',
            node_id: firstNode.id,
            dependency_id: 'node-v17-extra'
          },
          { resource: 'workflow' }
        )
      ),
    (error) => error.payload?.error === 'workflow_top_level_cycle'
  );
  state = await stateApi.readState();
  assert.equal(
    state.workflow_drafts[0].nodes.find((item) => item.id === firstNode.id).dependency_ids.includes('node-v17-extra'),
    false
  );

  const deletePromise = operations.handleDynamicPageTool(
    sessionId,
    turnId,
    call(
      'workflow_draft_node_delete',
      'workflow-delete',
      state.workflow_drafts[0].revision,
      {
        type: 'delete_node',
        node_id: 'node-v17-extra'
      },
      { resource: 'workflow' }
    )
  );
  const pendingDelete = await findOperation(stateApi, 'workflow-delete');
  assert.equal(pendingDelete.status, 'pending_confirmation');
  await operations.confirmAssistOperation(pendingDelete.id, { approved: true });
  await deletePromise;
  state = await stateApi.readState();
  assert.equal(
    state.workflow_drafts[0].nodes.some((item) => item.id === 'node-v17-extra'),
    false
  );
  const restoredNode = await operations.undoAssistOperation(pendingDelete.id, locator);
  assert.equal(restoredNode.status, 'committed');
  assert.ok((await stateApi.readState()).workflow_drafts[0].nodes.some((item) => item.id === 'node-v17-extra'));
  const nestedArgumentRevision = (await stateApi.readState()).project_briefs[0].revision;
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool(
        sessionId,
        turnId,
        call('brief_section_update', 'nested-dangerous-key', nestedArgumentRevision, {
          type: 'update_section',
          section_id: goalId,
          patch: { rows: [[{ script: 'forbidden' }]] }
        })
      ),
    (error) => error.payload?.error === 'assist_dynamic_tool_unsafe_argument'
  );

  await stateApi.mutate((current) => {
    current.assist_turns[0].mode = 'plan';
    current.assist_turns[0].collaboration_mode = 'plan';
  });
  const planRevision = (await stateApi.readState()).project_briefs[0].revision;
  await assert.rejects(
    () =>
      operations.handleDynamicPageTool(
        sessionId,
        turnId,
        call('brief_section_update', 'plan-forbidden', planRevision, {
          type: 'update_section',
          section_id: goalId,
          patch: { markdown: 'Plan 不得写入' }
        })
      ),
    (error) => error.payload?.error === 'assist_plan_capability_write_forbidden'
  );
  assert.equal((await stateApi.readState()).project_briefs[0].content.goal, '直接定点修订');

  console.log('V1.7 manifest capability operations unit tests passed');

  function call(tool, callId, expectedRevision, operation, options = {}) {
    return {
      namespace: 'aiws_project',
      tool,
      callId,
      arguments: {
        project_id: projectId,
        ...(options.resource === 'workflow' ? { workflow_draft_id: draftId } : { brief_id: briefId }),
        route: viewContext.route,
        surface_id: viewContext.surface.id,
        surface_revision: viewContext.surface.revision,
        browser_instance_id: viewContext.browser_instance_id,
        expected_revision: expectedRevision,
        operation
      }
    };
  }
  function locatorInput() {
    return {
      route: viewContext.route,
      surface_id: viewContext.surface.id,
      surface_revision: viewContext.surface.revision,
      browser_instance_id: viewContext.browser_instance_id
    };
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function findOperation(stateApi, callId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const item = (await stateApi.readState()).assist_operations.find((entry) => entry.tool_call_id === callId);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`operation_timeout:${callId}`);
}
