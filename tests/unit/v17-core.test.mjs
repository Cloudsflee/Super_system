import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v17-core-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const migration = await import('../../apps/api/src/state-migration-v16.mjs');
  const domain = await import('../../apps/api/src/brief-workflow-domain.mjs');
  const assistDomain = await import('../../apps/api/src/assist-v3-domain.mjs');
  const briefService = await import('../../apps/api/src/project-brief-service.mjs');
  const workflowService = await import('../../apps/api/src/workflow-draft-service.mjs');
  const projectLifecycle = await import('../../apps/api/src/project-lifecycle.mjs');
  const lifecycleOperations = await import('../../apps/api/src/project-lifecycle-operations.mjs');
  const userInput = await import('../../apps/api/src/assist-user-input.mjs');
  const operations = await import('../../apps/api/src/assist-operations.mjs');
  const shared = await import('../../packages/shared/index.mjs');

  const legacy = legacyState();
  const migrated = migration.migrateState15To16(legacy, { timestamp: '2026-07-14T00:00:00.000Z' });
  assert.equal(migrated.state.schema_version, 16);
  assert.equal(migrated.migrated_briefs, 1);
  assert.equal(migrated.created_workflow_drafts, 1);
  assert.equal(migrated.state.assist_sessions[0].clarification_policy, 'ask');
  assert.equal(migrated.state.projects[0].lifecycle_operation, null);
  assert.deepEqual(migrated.state.brief_templates, []);
  const brief = migrated.state.project_briefs[0];
  assert.equal(brief.content.schema_version, 2);
  assert.equal(brief.content.sections.length, 9);
  assert.equal(new Set(brief.content.sections.map((section) => section.id)).size, 9);
  assert.equal(brief.content.goal, '交付 V1.7');
  assert.deepEqual(brief.content.features, ['Brief V2', 'WorkflowDraft']);
  assert.deepEqual(brief.content.acceptance_criteria, ['全部测试通过']);
  assert.deepEqual(brief.content.scope.out, ['远端发布']);
  assert.equal(brief.content.material_references[0].url, 'https://example.com/spec');
  const draft = migrated.state.workflow_drafts[0], originalNodeIds = draft.nodes.map((node) => node.id);
  assert.equal(draft.revision, 1); assert.equal(draft.status, 'draft'); assert.equal(draft.user_modified_at, null); assert.equal(new Set(originalNodeIds).size, 3);
  domain.assertWorkflowAcyclic(draft.nodes);
  const missingDefaults = structuredClone(migrated.state);
  delete missingDefaults.projects[0].lifecycle_operation; delete missingDefaults.workflow_drafts[0].status; delete missingDefaults.workflow_drafts[0].user_modified_at;
  Object.assign(missingDefaults.workflow_drafts[0], { revision: 2, updated_at: '2026-07-13T00:00:00.000Z' });
  const repairedCurrent = migration.migrateState15To16(missingDefaults, { timestamp: '2026-07-14T00:00:00.000Z' });
  assert.equal(repairedCurrent.migrated, false); assert.equal(repairedCurrent.state.projects[0].lifecycle_operation, null);
  assert.equal(repairedCurrent.state.workflow_drafts[0].status, 'draft'); assert.equal(repairedCurrent.state.workflow_drafts[0].user_modified_at, '2026-07-13T00:00:00.000Z');
  const invalidStatus = structuredClone(migrated.state); invalidStatus.workflow_drafts[0].status = 'unknown';
  assert.throws(() => migration.validateState16(invalidStatus), /workflow_draft_status_invalid/);
  const invalidLifecycle = structuredClone(migrated.state); invalidLifecycle.projects[0].lifecycle_operation = { id: 'bad', type: 'overwrite' };
  assert.throws(() => migration.validateState16(invalidLifecycle), /project_lifecycle_operation_invalid/);
  const detailState = structuredClone(migrated.state);
  for (const collection of ['attachments', 'ui_action_intents', 'runtime_user_inputs', 'human_reviews', 'assist_events']) detailState[collection] ||= [];
  detailState.ui_action_intents.push({ id: 'legacy-machine-action', turn_id: detailState.assist_turns[0].id, name: 'set_field', args: { field_id: 'goal' } });
  Object.assign(detailState.assist_turns[0], { attachment_manifest: [{ id: 'internal' }], test_adapter: true, test_response: { message: 'internal fixture' } });
  detailState.assist_sessions[0].runtime_affinity_key = 'internal-affinity-hash';
  const publicTurn = assistDomain.turnDetail(detailState, detailState.assist_turns[0], null);
  assert.deepEqual(publicTurn.actions, []);
  assert.equal(Object.hasOwn(publicTurn, 'attachment_manifest'), false); assert.equal(Object.hasOwn(publicTurn, 'test_response'), false);
  assert.equal(Object.hasOwn(assistDomain.sessionSummary(detailState, detailState.assist_sessions[0]), 'runtime_affinity_key'), false);
  assert.equal(Object.hasOwn(publicTurn.operations[0], 'tool'), false);
  assert.equal(Object.hasOwn(publicTurn.operations[0], 'browser_instance_id'), false);
  assert.equal(Object.hasOwn(publicTurn.operations[0], 'requested_value'), false);
  assert.equal(Object.hasOwn(publicTurn.operations[0], 'domain_request'), false);
  const idempotent = migration.migrateState15To16(migrated.state);
  assert.equal(idempotent.migrated, false);
  assert.deepEqual(idempotent.state.project_briefs[0].content.sections.map((section) => section.id), brief.content.sections.map((section) => section.id));
  assert.deepEqual(idempotent.state.workflow_drafts[0].nodes.map((node) => node.id), originalNodeIds);

  const migrationDir = path.join(root, 'migration'), stateFile = path.join(migrationDir, 'state.json');
  fs.mkdirSync(migrationDir, { recursive: true });
  const originalBytes = `${JSON.stringify(legacy, null, 2)}\n`; fs.writeFileSync(stateFile, originalBytes);
  await assert.rejects(() => migration.migrateStateFileToV16(stateFile, {
    backupDirectory: path.join(migrationDir, 'backups'), clock: () => new Date('2026-07-14T01:02:03.000Z'),
    afterReplace: () => { const error = new Error('rollback injection'); error.code = 'injected_v17_failure'; throw error; }
  }), /rollback injection/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), originalBytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(migrationDir, 'backups', 'state-schema15-2026-07-14T01-02-03-000Z.manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'rolled_back'); assert.equal(manifest.to_schema, 16);

  const editable = structuredClone(migrated.state), actorId = 'owner-1';
  let nestedLockCalls = 0;
  await lifecycleOperations.withProjectLifecycleLock('project-1', () => lifecycleOperations.withProjectLifecycleLock('project-1', () => { nestedLockCalls += 1; }));
  assert.equal(nestedLockCalls, 1, 'project lifecycle locks are reentrant within one async operation');
  const lifecycleLocked = structuredClone(migrated.state);
  lifecycleLocked.projects[0].lifecycle_operation = { id: 'plop-test', type: 'trash', started_at: '2026-07-14T00:00:00.000Z' };
  assert.throws(() => briefService.patchBriefInState(lifecycleLocked, 'project-1', 'brief-1', { expected_revision: 1, operations: [{ type: 'set_title', title: 'blocked' }] }, actorId), (error) => error.status === 423 && error.payload.error === 'project_lifecycle_operation_in_progress');
  assert.throws(() => workflowService.patchWorkflowDraftInState(lifecycleLocked, 'project-1', { expected_revision: 1, operations: [{ type: 'update_node', node_id: lifecycleLocked.workflow_drafts[0].nodes[0].id, patch: { title: 'blocked' } }] }, actorId), (error) => error.status === 423 && error.payload.error === 'project_lifecycle_operation_in_progress');
  const updated = briefService.patchBriefInState(editable, 'project-1', 'brief-1', { expected_revision: 1, operations: [
    { type: 'add_section', section: { type: 'key_value', title: '负责人', entries: [{ key: 'Owner', value: 'Local Owner' }] } },
    { type: 'add_section', section: { type: 'table', title: '验收矩阵', columns: ['检查', '结果'], rows: [['迁移', '通过']] } },
    { type: 'duplicate_section', section_id: brief.content.sections[0].id },
    { type: 'move_section', section_id: brief.content.sections[1].id, to_index: 0 }
  ] }, actorId);
  assert.equal(updated.revision, 2); assert.equal(updated.content.sections.at(-2).type, 'key_value'); assert.equal(updated.content.sections.at(-1).type, 'table');
  assert.throws(() => briefService.patchBriefInState(editable, 'project-1', 'brief-1', { expected_revision: 1, operations: [{ type: 'set_title', title: 'stale' }] }, actorId), (error) => error.status === 409 && error.payload.error === 'project_brief_revision_conflict');

  assert.throws(() => briefService.createBriefTemplateInState(editable, { title: '未确认模板', sections: [] }, actorId), (error) => error.payload.error === 'brief_template_adoption_confirmation_required');
  for (const source of ['http://example.com/template', 'https://user:pass@example.com/template', 'https://example.com/template?token=secret', 'https://127.0.0.1/template']) {
    assert.throws(() => briefService.createBriefTemplateInState(editable, { confirmed: true, title: '不安全来源', sources: [source], sections: [] }, actorId), (error) => error.payload.error === 'unsafe_brief_template_source_url');
  }
  assert.throws(() => briefService.createBriefTemplateInState(editable, { confirmed: true, title: '缺失附件', sources: [{ attachment_id: 'missing' }], sections: [] }, actorId), (error) => error.payload.error === 'brief_template_source_attachment_not_found');
  editable.attachments.push(
    { id: 'attachment-content-deleted', title: '已清理内容', status: 'ready', storage_status: 'stored', content_deleted_at: '2026-07-14T00:00:00.000Z' },
    { id: 'attachment-storage-deleted', title: '已删除存储', status: 'ready', storage_status: 'deleted', content_deleted_at: null },
    { id: 'attachment-template-source', title: '权威模板附件', status: 'ready', storage_status: 'stored', content_deleted_at: null }
  );
  for (const attachmentId of ['attachment-content-deleted', 'attachment-storage-deleted']) assert.throws(() => briefService.createBriefTemplateInState(editable, { confirmed: true, title: '不可用附件', sources: [{ attachment_id: attachmentId }], sections: [] }, actorId), (error) => error.payload.error === 'brief_template_source_attachment_not_found');
  const attachmentTemplate = briefService.createBriefTemplateInState(editable, { confirmed: true, title: '附件模板', sources: [{ attachment_id: 'attachment-template-source' }], sections: [] }, actorId);
  assert.equal(attachmentTemplate.sources[0].label, '权威模板附件', 'template keeps provenance label if the project attachment is purged later');
  editable.attachments = editable.attachments.filter((item) => item.id !== 'attachment-template-source');
  assert.equal(attachmentTemplate.sources[0].attachment_id, 'attachment-template-source');
  const template = briefService.createBriefTemplateInState(editable, { confirmed: true, title: '产品简报模板', domain: 'product', publisher: 'Example Standards', retrieved_at: '2026-07-01T00:00:00.000Z', applicability: '本地应用', limitations: '不含上线审批', sources: ['https://example.com/template'], sections: [{ semantic_key: 'goal', title: '核心目标', type: 'markdown', markdown: '模板目标' }, { title: '发布约束', type: 'list', items: ['保留旧内容'] }] }, actorId);
  assert.equal(template.version, 1); assert.equal(template.publisher, 'Example Standards');
  const applied = briefService.applyBriefTemplateInState(editable, 'project-1', 'brief-1', template.id, { expected_revision: 2 }, actorId);
  assert.equal(applied.content.goal, '交付 V1.7', 'non-empty existing goal wins');
  assert.equal(applied.content.template_ref.template_id, template.id);
  assert.ok(applied.content.sections.some((section) => section.title === '发布约束'));
  assert.ok(applied.content.sections.some((section) => section.title === '附录'));
  const appliedSectionCount = applied.content.sections.length;
  const reapplied = briefService.applyBriefTemplateInState(editable, 'project-1', 'brief-1', template.id, { expected_revision: 3 }, actorId);
  assert.equal(reapplied.content.sections.length, appliedSectionCount, 'reapplying a template does not accumulate appendix sections');
  assert.equal(reapplied.content.sections.filter((section) => section.title === '附录').length, 1);

  const beforeWorkflowIds = editable.workflow_drafts[0].nodes.map((node) => node.id);
  const workflow = workflowService.patchWorkflowDraftInState(editable, 'project-1', { expected_revision: 1, operations: [{ type: 'add_node', node: { id: 'node-extra', type: 'analysis', title: '方案评审', goal: '确认方案', dependency_ids: [beforeWorkflowIds[0]] } }] }, actorId);
  assert.equal(workflow.revision, 2); assert.deepEqual(workflow.nodes.slice(0, 3).map((node) => node.id), beforeWorkflowIds);
  assert.throws(() => workflowService.patchWorkflowDraftInState(editable, 'project-1', { expected_revision: 2, operations: [{ type: 'connect', node_id: beforeWorkflowIds[0], dependency_id: 'node-extra' }] }, actorId), (error) => error.status === 409 && error.payload.error === 'workflow_draft_cycle');
  assert.throws(() => workflowService.patchWorkflowDraftInState(editable, 'project-1', { expected_revision: 1, operations: [{ type: 'delete_node', node_id: 'node-extra' }] }, actorId), (error) => error.payload.error === 'workflow_draft_revision_conflict');
  assert.throws(() => workflowService.patchWorkflowDraftInState(editable, 'project-1', { expected_revision: 2, nodes: [] }, actorId), (error) => error.payload.error === 'workflow_draft_requires_node');
  assert.throws(() => workflowService.patchWorkflowDraftInState(editable, 'project-1', { expected_revision: 2, nodes: Array.from({ length: 51 }, (_, index) => ({ id: `too-many-${index}`, title: `节点 ${index}`, dependency_ids: [] })) }, actorId), (error) => error.payload.error === 'workflow_draft_node_limit');

  const activationProject = { id: 'activation-project', title: 'Activation', goal: '保留全部节点', status: 'draft', onboarding_state: 'brief_review', current_workspace_id: 'activation-root' };
  const activationBrief = { id: 'activation-brief', version: 1, status: 'draft', content: domain.createBriefContentV2({ briefId: 'activation-brief', title: 'Activation Brief', projectGoal: activationProject.goal }) };
  const legacyNodes = Array.from({ length: 21 }, (_, index) => ({ type: index ? 'execution' : 'goal_definition', title: `Legacy ${index}`, dependency_indexes: index ? [index - 1] : [] }));
  const activationState = { workflows: [], workflow_nodes: [], workspaces: [], node_contracts: [] };
  const activated = projectLifecycle.activateDraftInState(activationState, activationProject, activationBrief, legacyNodes, actorId);
  assert.equal(activated.nodes.length, 21, 'activation does not truncate a valid 21-node draft');
  assert.equal(activated.nodes.at(-1).dependencies[0].node_id, activated.nodes.at(-2).id, 'legacy dependency indexes map to stable node ids');
  assert.throws(() => projectLifecycle.activateDraftInState({ workflows: [], workflow_nodes: [], workspaces: [], node_contracts: [] }, { ...activationProject, id: 'empty-project', status: 'draft', onboarding_state: 'brief_review' }, { ...activationBrief, id: 'empty-brief', status: 'draft' }, [], actorId), (error) => error.payload.error === 'workflow_draft_requires_node');

  assert.equal(shared.validateAssistCapabilityManifest().length, shared.ASSIST_CAPABILITY_MANIFEST.length);
  assert.equal(new Set(shared.ASSIST_CAPABILITY_MANIFEST.map((item) => item.id)).size, shared.ASSIST_CAPABILITY_MANIFEST.length);
  assert.deepEqual(operations.dynamicPageToolSpec({ route: '/projects/project-1/onboarding', surface: { id: 'brief', revision: 'r1', fields: [{ id: 'brief.goal', label: '核心目标' }] } }, 'plan'), []);
  assert.deepEqual(userInput.autoRecommendedAnswers([{ id: 'scope', header: '范围', question: '采用哪个范围？', options: [{ label: '安全范围', recommended: true }, { label: '扩展范围', recommended: false }] }]), { scope: { answers: ['安全范围'] } });
  assert.equal(userInput.autoRecommendedAnswers([{ id: 'delete', header: '删除', question: '删除节点？', options: [{ label: '删除', recommended: true }] }]), null);
  assert.equal(userInput.autoRecommendedAnswers([{ id: 'secret', header: '凭据', question: 'API Key', isSecret: true, options: [{ label: '使用', recommended: true }] }]), null);
  assert.equal(userInput.autoRecommendedAnswers([{ id: 'purge', header: '清理', question: '永久清空数据？', options: [{ label: '继续', recommended: true }] }]), null);
  assert.equal(userInput.autoRecommendedAnswers([{ id: 'none', header: '范围', question: '选择', options: [{ label: 'A' }] }]), null);

  console.log('V1.7 core unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function legacyState() {
  return {
    schema_version: 15,
    users: [{ id: 'owner-1', role: 'owner' }],
    projects: [{ id: 'project-1', title: 'V1.7 Project', goal: '交付 V1.7', status: 'draft' }],
    project_intakes: [{ id: 'intake-1', project_id: 'project-1', mode: 'brainstorm', context_sources: [{ type: 'url', label: '需求', url: 'https://example.com/spec' }], answers: {}, revision: 1 }],
    project_briefs: [{ id: 'brief-1', project_id: 'project-1', version: 1, status: 'draft', content: { goal: '交付 V1.7', users: ['Owner'], scope: { in: ['Brief V2', 'WorkflowDraft'], out: ['远端发布'] }, features: ['Brief V2', 'WorkflowDraft'], constraints: ['Codex 0.144.0'], milestones: ['V1.7'], acceptance_criteria: ['全部测试通过'], risks: ['迁移失败'], open_questions: ['模板来源'] } }],
    assist_sessions: [{ id: 'session-1', version: 3, project_id: 'project-1', scope_type: 'project', scope_id: 'project-1', parent_session_id: null, forked_from_session_id: null, codex_thread_id: null }],
    assist_turns: [{ id: 'turn-1', session_id: 'session-1', project_id: 'project-1', status: 'completed' }],
    attachments: [], assist_operations: [{ id: 'operation-1', session_id: 'session-1', turn_id: 'turn-1', tool: 'aiws_page.set_field', target_id: 'brief.goal', route: '/projects/project-1/onboarding', surface_revision: 'r1' }],
    runtime_user_inputs: [{ id: 'input-1', session_id: 'session-1', turn_id: 'turn-1', questions: [{ id: 'scope', options: [{ label: '安全范围', description: '' }] }] }],
    assist_configurations: [], assist_change_batches: [], assist_checkpoints: [], host_bridge_devices: [],
    codex_profiles: [], integration_statuses: [], workflow_drafts: undefined, brief_templates: undefined
  };
}
