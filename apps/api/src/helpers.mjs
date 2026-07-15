import { id, now } from '../../../packages/shared/index.mjs';
import { git, isGitRepo } from './git-utils.mjs';

export function nodeBundle(state, nodeId) {
  const node = state.workflow_nodes.find((n) => n.id === nodeId);
  const workflow = node ? state.workflows.find((w) => w.id === node.workflow_id) : null;
  const project = workflow ? state.projects.find((p) => p.id === workflow.project_id && !p.deleted_at) : null;
  const workspace = node ? (state.workspaces.find((w) => w.workflow_node_id === node.id) || state.workspaces.find((w) => w.id === node.workspace_id)) : null;
  const contract = node ? (state.node_contracts.find((c) => c.id === node.current_contract_id) || state.node_contracts.filter((c) => c.node_id === node.id).sort((a, b) => b.version - a.version)[0]) : null;
  return { node, workflow, project, workspace, contract };
}

export function projectBundle(state, projectId) {
  const project = state.projects.find((p) => p.id === projectId && !p.deleted_at);
  if (!project) return null;
  const workflows = state.workflows.filter((w) => w.project_id === project.id);
  const workflowIds = new Set(workflows.map((w) => w.id));
  const nodes = state.workflow_nodes.filter((n) => workflowIds.has(n.workflow_id)).sort((a, b) => a.order_index - b.order_index);
  return {
    project,
    workspace: state.workspaces.find((w) => w.id === project.current_workspace_id),
    workflows,
    nodes,
    contracts: state.node_contracts.filter((c) => nodes.some((n) => n.id === c.node_id)),
    assets: state.assets.filter((a) => a.project_id === project.id),
    digests: state.digests.filter((d) => d.project_id === project.id),
    runs: state.node_runs.filter((r) => r.project_id === project.id),
    traces: state.traces.filter((t) => t.project_id === project.id)
  };
}

export function ensureCodeChange(state, run, project, node, actorId) {
  let change = state.code_changes.find((c) => c.run_id === run.id);
  if (change) return change;
  change = {
    id: id('chg'), project_id: project.id, workspace_id: run.workspace_id, node_id: run.node_id, run_id: run.id,
    repo_path: project.repo_path || project.workspace_root || '', base_branch: '', work_branch: '', base_commit: '', head_commit: '',
    status: 'draft', changed_files: [], diff_file_ref_id: null, test_results: [], commit_message: '', pr_body_file_ref_id: null, pr_url: '',
    committed_by_user_id: null, pr_created_by_connected_account_id: null, created_by_user_id: actorId, created_at: now(), updated_at: now()
  };
  if (change.repo_path && isGitRepo(change.repo_path)) {
    change.base_branch = git(change.repo_path, ['branch', '--show-current'], 5000).stdout.trim();
    change.base_commit = git(change.repo_path, ['rev-parse', 'HEAD'], 5000).stdout.trim();
  }
  state.code_changes.push(change);
  return change;
}

export function resolveToken(tokenOrRef) {
  if (!tokenOrRef) return process.env.GITHUB_TOKEN || '';
  if (String(tokenOrRef).startsWith('env:')) return process.env[String(tokenOrRef).slice(4)] || '';
  return tokenOrRef;
}
