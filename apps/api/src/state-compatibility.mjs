import { now } from '../../../packages/shared/index.mjs';
import { legacyBriefToV2 } from './brief-workflow-domain.mjs';

export function normalizeState18Compatibility(state, collections) {
  for (const key of collections) if (!Array.isArray(state[key])) state[key] = [];
  for (const project of state.projects || []) {
    if (project.lifecycle_operation === undefined) project.lifecycle_operation = null;
    if (!Array.isArray(project.repository_connection_ids)) project.repository_connection_ids = [];
    if (project.workflow_migration_status === undefined) project.workflow_migration_status = 'not_required';
    if (project.default_repository_workspace_id === undefined) project.default_repository_workspace_id = null;
  }
  const nodesByWorkflow = new Map();
  for (const node of state.workflow_nodes || []) {
    const items = nodesByWorkflow.get(node.workflow_id) || [];
    items.push(node);
    nodesByWorkflow.set(node.workflow_id, items);
  }
  for (const workflow of state.workflows || []) {
    const nodes = nodesByWorkflow.get(workflow.id) || [],
      twoLevel = nodes.some((node) => node.role === 'workstream');
    if (!workflow.hierarchy_mode) workflow.hierarchy_mode = twoLevel || !nodes.length ? 'two_level' : 'legacy';
    if (!Number.isInteger(workflow.workflow_revision)) workflow.workflow_revision = Number(workflow.version || 1);
    if (workflow.legacy_read_only === undefined) workflow.legacy_read_only = workflow.hierarchy_mode === 'legacy';
    if (!workflow.semantic_migration_status)
      workflow.semantic_migration_status = workflow.hierarchy_mode === 'legacy' ? 'pending' : 'not_required';
    if (!workflow.planning_quality) workflow.planning_quality = 'legacy_unverified';
  }
  for (const node of state.workflow_nodes || []) {
    const legacy = state.workflows.find((item) => item.id === node.workflow_id)?.hierarchy_mode === 'legacy';
    if (!node.role) node.role = legacy ? 'task' : node.parent_node_id ? 'task' : 'workstream';
    if (node.parent_node_id === undefined) node.parent_node_id = null;
    if (node.outcome === undefined) node.outcome = node.role === 'workstream' ? node.goal || node.title : null;
    if (node.category === undefined) node.category = node.role === 'workstream' ? 'deliverable' : null;
    if (node.task_kind === undefined)
      node.task_kind =
        node.role === 'task'
          ? {
              research: 'research',
              analysis: 'analysis',
              retrospective: 'review',
              execution: 'code',
              goal_definition: 'analysis'
            }[node.type] || 'manual'
          : null;
    if (node.execution_mode === undefined)
      node.execution_mode =
        node.role === 'task'
          ? ['code', 'test', 'deploy'].includes(node.task_kind)
            ? 'codex'
            : node.task_kind === 'manual'
              ? 'manual'
              : 'assist'
          : null;
    if (node.boundary === undefined)
      node.boundary = node.role === 'workstream' ? { deliverable: node.outcome || node.title } : null;
    if (node.plan_revision === undefined) node.plan_revision = node.role === 'workstream' ? 1 : null;
    if (!Array.isArray(node.repository_target_ids)) node.repository_target_ids = [];
    if (node.required === undefined) node.required = true;
    if (node.legacy_read_only === undefined) node.legacy_read_only = legacy;
    if (node.role === 'task' && !Array.isArray(node.capability_tags)) node.capability_tags = [];
    if (node.role === 'task' && !Number.isInteger(node.execution_revision)) node.execution_revision = 1;
    if (node.role === 'task' && node.input_superseded === undefined) node.input_superseded = false;
  }
  for (const contract of state.node_contracts || []) normalizeNodeContractV2(contract);
  for (const submission of state.submissions || []) {
    if (!Array.isArray(submission.output_bindings)) submission.output_bindings = [];
    if (submission.input_snapshot_hash === undefined) submission.input_snapshot_hash = null;
  }
  for (const workspace of state.repository_workspaces || []) {
    if (!workspace.mode) workspace.mode = 'read_only';
    if (!workspace.sync_status) workspace.sync_status = 'unknown';
    if (workspace.stale === undefined) workspace.stale = workspace.sync_status === 'stale';
    if (!Number.isInteger(workspace.revision) || workspace.revision < 1) workspace.revision = 1;
  }
  for (const execution of [...(state.node_runs || []), ...(state.deliveries || [])]) {
    if (execution.task_execution_context === undefined) execution.task_execution_context = null;
    if (execution.input_snapshot_hash === undefined) execution.input_snapshot_hash = null;
    if (execution.repository_snapshot_hash === undefined) execution.repository_snapshot_hash = null;
    if (!Array.isArray(execution.output_bindings)) execution.output_bindings = [];
    if (execution.input_superseded === undefined) execution.input_superseded = false;
  }
  for (const intent of state.pull_request_intents || []) {
    if (!Number.isInteger(intent.revision) || intent.revision < 1) intent.revision = 1;
    if (!Array.isArray(intent.approvals)) intent.approvals = [];
    if (intent.reconciliation === undefined) intent.reconciliation = null;
  }
  for (const draft of state.workflow_drafts || []) {
    if (!draft.status) draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft';
    if (draft.user_modified_at === undefined)
      draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || now() : null;
    if (!draft.brief_coverage || typeof draft.brief_coverage !== 'object') draft.brief_coverage = {};
    if (draft.project_classification === undefined) draft.project_classification = null;
  }
  for (const session of state.assist_sessions || [])
    if (session.version === 3 && !['ask', 'auto_recommend'].includes(session.clarification_policy))
      session.clarification_policy = 'ask';
  for (const brief of state.project_briefs || []) {
    if (brief.content?.schema_version !== 2) {
      const project = state.projects?.find((item) => item.id === brief.project_id);
      brief.content = legacyBriefToV2(brief.content || {}, {
        briefId: brief.id,
        title: `${project?.title || '项目'}简报`
      });
    }
    if (!Number.isInteger(brief.revision) || brief.revision < 1)
      brief.revision = Math.max(1, Number(brief.version) || 1);
  }
}

function normalizeNodeContractV2(contract) {
  if (!contract || typeof contract !== 'object') return;
  contract.contract_schema_version = 2;
  contract.expected_inputs = (Array.isArray(contract.expected_inputs) ? contract.expected_inputs : []).map(
    (slot, index) => ({
      ...slot,
      key: text(slot?.key || `input_${index + 1}`),
      kind: text(slot?.kind || inferInputKind(slot)),
      required: slot?.required !== false,
      source: text(slot?.source || (slot?.value != null ? 'inline' : 'explicit')),
      selector: slot?.selector ?? null,
      ref_id: slot?.ref_id ?? null,
      version_id: slot?.version_id ?? null
    })
  );
  contract.expected_outputs = (Array.isArray(contract.expected_outputs) ? contract.expected_outputs : []).map(
    (slot, index) => ({
      ...slot,
      key: text(slot?.key || `output_${index + 1}`),
      kind: text(slot?.kind || 'asset'),
      required: slot?.required !== false,
      asset_type: text(slot?.asset_type || contract.asset_output_types?.[index] || 'ResultAsset'),
      acceptance_criteria: Array.isArray(slot?.acceptance_criteria)
        ? slot.acceptance_criteria
        : [...(contract.acceptance_criteria || [])],
      confirmation_policy: text(slot?.confirmation_policy || 'human')
    })
  );
}

function inferInputKind(slot) {
  if (slot?.version_id) return 'asset_version';
  if (slot?.key === 'repository_snapshot' || /repo|workspace/i.test(String(slot?.key || ''))) return 'repository';
  return 'context';
}
function text(value) {
  return String(value || '').trim();
}
