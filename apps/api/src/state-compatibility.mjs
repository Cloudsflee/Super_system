import { now } from '../../../packages/shared/index.mjs';
import { legacyBriefToV2 } from './brief-workflow-domain.mjs';

export function normalizeState18Compatibility(state, collections) {
  for (const key of collections) if (!Array.isArray(state[key])) state[key] = [];
  for (const project of state.projects || []) {
    if (project.lifecycle_operation === undefined) project.lifecycle_operation = null;
    if (!Array.isArray(project.repository_connection_ids)) project.repository_connection_ids = [];
    if (project.workflow_migration_status === undefined) project.workflow_migration_status = 'not_required';
  }
  const nodesByWorkflow = new Map();
  for (const node of state.workflow_nodes || []) {
    const items = nodesByWorkflow.get(node.workflow_id) || []; items.push(node); nodesByWorkflow.set(node.workflow_id, items);
  }
  for (const workflow of state.workflows || []) {
    const nodes = nodesByWorkflow.get(workflow.id) || [], twoLevel = nodes.some((node) => node.role === 'workstream');
    if (!workflow.hierarchy_mode) workflow.hierarchy_mode = twoLevel || !nodes.length ? 'two_level' : 'legacy';
    if (!Number.isInteger(workflow.workflow_revision)) workflow.workflow_revision = Number(workflow.version || 1);
    if (workflow.legacy_read_only === undefined) workflow.legacy_read_only = workflow.hierarchy_mode === 'legacy';
    if (!workflow.semantic_migration_status) workflow.semantic_migration_status = workflow.hierarchy_mode === 'legacy' ? 'pending' : 'not_required';
  }
  for (const node of state.workflow_nodes || []) {
    const legacy = state.workflows.find((item) => item.id === node.workflow_id)?.hierarchy_mode === 'legacy';
    if (!node.role) node.role = legacy ? 'task' : node.parent_node_id ? 'task' : 'workstream';
    if (node.parent_node_id === undefined) node.parent_node_id = null;
    if (node.outcome === undefined) node.outcome = node.role === 'workstream' ? node.goal || node.title : null;
    if (node.category === undefined) node.category = node.role === 'workstream' ? 'deliverable' : null;
    if (node.task_kind === undefined) node.task_kind = node.role === 'task' ? ({ research: 'research', analysis: 'analysis', retrospective: 'review', execution: 'code', goal_definition: 'analysis' })[node.type] || 'manual' : null;
    if (node.execution_mode === undefined) node.execution_mode = node.role === 'task' ? (['code', 'test', 'deploy'].includes(node.task_kind) ? 'codex' : node.task_kind === 'manual' ? 'manual' : 'assist') : null;
    if (node.boundary === undefined) node.boundary = node.role === 'workstream' ? { deliverable: node.outcome || node.title } : null;
    if (node.plan_revision === undefined) node.plan_revision = node.role === 'workstream' ? 1 : null;
    if (!Array.isArray(node.repository_target_ids)) node.repository_target_ids = [];
    if (node.required === undefined) node.required = true;
    if (node.legacy_read_only === undefined) node.legacy_read_only = legacy;
  }
  for (const draft of state.workflow_drafts || []) {
    if (!draft.status) draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft';
    if (draft.user_modified_at === undefined) draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || now() : null;
  }
  for (const session of state.assist_sessions || []) if (session.version === 3 && !['ask', 'auto_recommend'].includes(session.clarification_policy)) session.clarification_policy = 'ask';
  for (const brief of state.project_briefs || []) {
    if (brief.content?.schema_version !== 2) {
      const project = state.projects?.find((item) => item.id === brief.project_id);
      brief.content = legacyBriefToV2(brief.content || {}, { briefId: brief.id, title: `${project?.title || '项目'}简报` });
    }
    if (!Number.isInteger(brief.revision) || brief.revision < 1) brief.revision = Math.max(1, Number(brief.version) || 1);
  }
}
