export const ASSIST_CAPABILITY_MANIFEST = Object.freeze([
  descriptor('surface.field.set', 'set', '更新页面字段', 'field', '/**', fieldSchema(), 'low', true, '当前页面字段'),
  descriptor('surface.filter.set', 'set', '更新页面筛选', 'filter', '/**', fieldSchema(), 'low', true, '当前页面筛选器'),
  descriptor('surface.tab.select', 'select', '切换页面视图', 'tab', '/**', targetSchema(), 'low', true, '当前页面标签'),
  descriptor('project.brief.section.add', 'add', '添加简报区块', 'brief_section', '/projects/:projectId/onboarding', briefOperationSchema('add_section'), 'low', true, '项目简报'),
  descriptor('project.brief.section.update', 'update', '修改简报区块', 'brief_section', '/projects/:projectId/onboarding', briefOperationSchema('update_section'), 'low', true, '项目简报'),
  descriptor('project.brief.section.rename', 'rename', '重命名简报区块', 'brief_section', '/projects/:projectId/onboarding', briefOperationSchema('rename_section'), 'low', true, '项目简报大纲'),
  descriptor('project.brief.section.duplicate', 'duplicate', '复制简报区块', 'brief_section', '/projects/:projectId/onboarding', briefOperationSchema('duplicate_section'), 'low', true, '项目简报大纲'),
  descriptor('project.brief.section.move', 'move', '排序简报区块', 'brief_section', '/projects/:projectId/onboarding', briefOperationSchema('move_section'), 'low', true, '项目简报大纲'),
  descriptor('project.brief.section.delete', 'delete', '删除简报区块', 'brief_section', '/projects/:projectId/onboarding', briefOperationSchema('delete_section'), 'destructive', true, '项目简报大纲'),
  descriptor('project.workflow_draft.node.add', 'add', '添加工作流节点', 'workflow_node', '/projects/:projectId/onboarding', workflowOperationSchema('add_node'), 'low', true, '初始工作流'),
  descriptor('project.workflow_draft.node.update', 'update', '修改工作流节点', 'workflow_node', '/projects/:projectId/onboarding', workflowOperationSchema('update_node'), 'low', true, '初始工作流'),
  descriptor('project.workflow_draft.node.delete', 'delete', '删除工作流节点', 'workflow_node', '/projects/:projectId/onboarding', workflowOperationSchema('delete_node'), 'destructive', true, '初始工作流'),
  descriptor('project.workflow_draft.node.reorder', 'reorder', '排序工作流节点', 'workflow_node', '/projects/:projectId/onboarding', workflowOperationSchema('reorder_nodes'), 'low', true, '初始工作流'),
  descriptor('project.workflow_draft.node.connect', 'connect', '连接工作流节点', 'workflow_edge', '/projects/:projectId/onboarding', workflowOperationSchema('connect'), 'low', true, '初始工作流'),
  descriptor('project.workflow_draft.node.disconnect', 'disconnect', '断开工作流节点', 'workflow_edge', '/projects/:projectId/onboarding', workflowOperationSchema('disconnect'), 'low', true, '初始工作流')
]);

export function assistCapability(id) { return ASSIST_CAPABILITY_MANIFEST.find((item) => item.id === id) || null; }
export function assistCapabilityToolName(value) { return String(value?.id || value || '').replace(/^project\./, '').replaceAll('.', '_'); }
export function assistCapabilityForToolName(name) {
  return ASSIST_CAPABILITY_MANIFEST.find((item) => item.id.startsWith('project.') && assistCapabilityToolName(item) === name) || null;
}

export function validateAssistCapabilityManifest(values = ASSIST_CAPABILITY_MANIFEST) {
  const ids = new Set();
  for (const item of values) {
    if (!item?.id || ids.has(item.id)) throw new Error(`assist_capability_id_invalid:${item?.id || ''}`);
    ids.add(item.id);
    if (!item.action || !item.label_zh || !item.target || !item.route || !item.input_schema || !item.risk || typeof item.reversible !== 'boolean' || !item.locator_label) throw new Error(`assist_capability_descriptor_invalid:${item.id}`);
  }
  return values;
}

function descriptor(id, action, label, target, route, inputSchema, risk, reversible, locatorLabel) {
  return Object.freeze({ id, action, label_zh: label, target, route, input_schema: inputSchema, risk, reversible, locator_label: locatorLabel, mutation: action !== 'read' && action !== 'navigate' });
}
function targetSchema() { return { type: 'object', additionalProperties: false, required: ['target_id'], properties: { target_id: { type: 'string' } } }; }
function fieldSchema() { return { type: 'object', additionalProperties: false, required: ['target_id', 'value'], properties: { target_id: { type: 'string' }, value: {} } }; }
function briefOperationSchema(type) { return domainOperationSchema(type, 'brief_id'); }
function workflowOperationSchema(type) { return domainOperationSchema(type, 'workflow_draft_id'); }
function domainOperationSchema(type, resourceId) {
  return {
    type: 'object', additionalProperties: false,
    required: ['project_id', resourceId, 'route', 'surface_id', 'surface_revision', 'browser_instance_id', 'expected_revision', 'operation'],
    properties: {
      project_id: { type: 'string', minLength: 1 }, [resourceId]: { type: 'string', minLength: 1 },
      route: { type: 'string', minLength: 1 }, surface_id: { type: 'string', minLength: 1 },
      surface_revision: { type: 'string', minLength: 1 }, browser_instance_id: { type: 'string', minLength: 1 },
      expected_revision: { type: 'integer', minimum: 1 },
      operation: { type: 'object', additionalProperties: true, properties: { type: { const: type } }, required: ['type'] }
    }
  };
}
