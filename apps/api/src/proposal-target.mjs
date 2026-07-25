import { hashString } from '../../../packages/shared/index.mjs';
import { workflowGraphSnapshot } from './workflow-graph-service.mjs';

export function proposalTargetHash(state, proposal) {
  const action = proposal.apply_action || {};
  let snapshot = proposal.before_json ?? null;
  if (action.type === 'workflow_graph_patch') {
    snapshot = workflowGraphSnapshot(state, action.workflow_id, action.parent_node_id || null);
  } else if (
    ['workflow_nodes_create', 'workflow_node_remove', 'workflow_node_update', 'workflow_nodes_connect'].includes(
      action.type
    )
  ) {
    const workflow = state.workflows.find((item) => item.id === action.workflow_id);
    if (workflow) snapshot = graphSnapshot(state.workflow_nodes.filter((item) => item.workflow_id === workflow.id));
  } else if (action.type === 'node_contract_patch' && proposal.node_id) {
    const node = state.workflow_nodes.find((item) => item.id === proposal.node_id);
    snapshot = state.node_contracts.find((item) => item.id === node?.current_contract_id) || null;
  } else if (action.type === 'codex_profile_apply')
    snapshot = state.codex_profiles.find((item) => item.is_active) || null;
  else if (action.type === 'config_revision_apply') {
    const revision = state.config_revisions.find((item) => item.id === action.config_revision_id);
    const profile = state.codex_profiles.find((item) => item.id === revision?.profile_id);
    snapshot = profile ? profileSnapshot(profile) : null;
  }
  return hashString(JSON.stringify(snapshot));
}
function graphSnapshot(nodes) {
  return {
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, label: node.title, position: node.position })),
    edges: nodes.flatMap((node) =>
      (node.dependencies || [])
        .map((dependency, index) => ({
          id: `${dependency.node_id}-${node.id}-${index}`,
          source: dependency.node_id,
          target: node.id
        }))
        .filter((edge) => edge.source)
    )
  };
}
function profileSnapshot(item) {
  return {
    id: item.id,
    name: item.name,
    provider: item.provider,
    provider_name: item.provider_name,
    base_url: item.base_url,
    model: item.model,
    reasoning: item.reasoning,
    web_search: item.web_search,
    status: item.status,
    is_active: item.is_active
  };
}
