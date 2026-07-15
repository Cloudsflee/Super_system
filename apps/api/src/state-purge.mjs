function ids(items, predicate) {
  return new Set(items.filter(predicate).map((item) => item.id).filter(Boolean));
}

function includes(values, value) { return value != null && values.has(value); }
function filter(state, key, keep) { state[key] = state[key].filter(keep); }

export function purgeAssistSessionsInState(state, sessionIds) {
  return purgeAssistGraph(state, new Set(sessionIds));
}

function purgeAssistGraph(state, sessionIds, extraTurnIds = new Set(), extraTerminalIds = new Set()) {
  const turnIds = ids(state.assist_turns, (item) => includes(sessionIds, item.session_id));
  for (const turnId of extraTurnIds) turnIds.add(turnId);
  const turns = state.assist_turns.filter((item) => includes(turnIds, item.id));
  const terminalIds = ids(state.terminal_sessions, (item) => includes(sessionIds, item.assist_session_id) || includes(turnIds, item.turn_id));
  for (const terminalId of extraTerminalIds) terminalIds.add(terminalId);
  const terminals = state.terminal_sessions.filter((item) => includes(terminalIds, item.id));
  const batchIds = ids(state.assist_change_batches, (item) => includes(sessionIds, item.session_id));
  for (const item of [...turns, ...terminals]) if (item.change_batch_id) batchIds.add(item.change_batch_id);
  const batches = state.assist_change_batches.filter((item) => includes(batchIds, item.id));
  const worktreeIds = new Set([...turns, ...terminals, ...batches].map((item) => item.worktree_id).filter(Boolean));
  const contextPackIds = new Set(turns.map((item) => item.context_pack_id).filter(Boolean));
  const packs = state.context_packs.filter((item) => includes(contextPackIds, item.id));
  const checkIds = new Set(packs.map((item) => item.sufficiency_check_id).filter(Boolean));
  const fileRefIds = referencedFileIds([...packs, ...terminals]);

  filter(state, 'assist_messages', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'assist_events', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'ui_action_intents', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'assist_operations', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'runtime_user_inputs', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'runtime_approvals', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'attachments', (item) => !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id));
  filter(state, 'context_sufficiency_checks', (item) => !includes(checkIds, item.id) && !(item.target_type === 'assist_turn' && includes(turnIds, item.target_id)));
  filter(state, 'context_packs', (item) => !includes(contextPackIds, item.id));
  filter(state, 'human_reviews', (item) => !(item.target_type === 'assist_turn' && includes(turnIds, item.target_id)) && !(item.target_type === 'terminal_session' && includes(terminalIds, item.target_id)));
  filter(state, 'file_refs', (item) => !includes(fileRefIds, item.id) && !includes(contextPackIds, item.meta?.context_pack_id) && !includes(terminalIds, item.meta?.terminal_session_id) && !includes(sessionIds, item.meta?.assist_session_id) && !includes(turnIds, item.meta?.turn_id));
  filter(state, 'assist_checkpoints', (item) => !includes(batchIds, item.batch_id) && !includes(sessionIds, item.session_id) && !includes(turnIds, item.turn_id) && !includes(terminalIds, item.terminal_id));
  filter(state, 'assist_change_batches', (item) => !includes(batchIds, item.id));
  filter(state, 'terminal_sessions', (item) => !includes(terminalIds, item.id));
  filter(state, 'worktrees', (item) => !includes(worktreeIds, item.id));
  filter(state, 'assist_turns', (item) => !includes(turnIds, item.id));
  filter(state, 'assist_sessions', (item) => !includes(sessionIds, item.id));
  return { turnIds, terminalIds, batchIds, worktreeIds, contextPackIds };
}

export function purgeProjectInState(state, projectId) {
  const graph = projectPurgeGraph(state, projectId);
  const { workspaceIds, workflowIds, nodeIds, runIds, assetIds, assetVersionIds, sessionIds, turnIds, terminalIds, proposalIds, contextPackIds, checkIds, fileRefIds, targetIds } = graph;
  purgeAssistGraph(state, sessionIds, turnIds, terminalIds);
  for (const [key, values] of Object.entries(state)) if (Array.isArray(values)) state[key] = values.filter((item) => item?.project_id !== projectId);
  filter(state, 'projects', (item) => item.id !== projectId);
  filter(state, 'workflow_nodes', (item) => !includes(workflowIds, item.workflow_id) && !includes(nodeIds, item.id));
  filter(state, 'node_contracts', (item) => !includes(nodeIds, item.node_id));
  filter(state, 'context_packs', (item) => !includes(contextPackIds, item.id));
  filter(state, 'context_sufficiency_checks', (item) => !includes(checkIds, item.id));
  filter(state, 'asset_versions', (item) => !includes(assetIds, item.asset_id) && !includes(assetVersionIds, item.id));
  filter(state, 'asset_relations', (item) => !assetRelationMatches(item, assetIds, assetVersionIds));
  filter(state, 'human_reviews', (item) => !includes(targetIds, item.target_id));
  filter(state, 'file_refs', (item) => !includes(fileRefIds, item.id) && !fileRefMatches(item, projectId, workspaceIds, runIds, terminalIds, contextPackIds));
  filter(state, 'test_results', (item) => !includes(runIds, item.run_id));
  filter(state, 'config_revisions', (item) => !includes(proposalIds, item.proposal_id));
}

export function projectManagedPathsInState(state, projectId) {
  const graph = projectPurgeGraph(state, projectId);
  const attachments = state.attachments.filter((item) => item.project_id === projectId || includes(graph.sessionIds, item.session_id) || includes(graph.turnIds, item.turn_id));
  const fileRefs = state.file_refs.filter((item) => includes(graph.fileRefIds, item.id) || fileRefMatches(item, projectId, graph.workspaceIds, graph.runIds, graph.terminalIds, graph.contextPackIds));
  return {
    attachment_paths: [...new Set(attachments.map((item) => item.managed_path).filter(Boolean))],
    artifact_paths: [...new Set(fileRefs.map((item) => item.absolute_path).filter(Boolean))]
  };
}

function projectPurgeGraph(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  const workspaceIds = ids(state.workspaces, (item) => item.project_id === projectId);
  if (project?.current_workspace_id) workspaceIds.add(project.current_workspace_id);
  const workflowIds = ids(state.workflows, (item) => item.project_id === projectId || includes(workspaceIds, item.workspace_id));
  const nodeIds = ids(state.workflow_nodes, (item) => includes(workflowIds, item.workflow_id) || includes(workspaceIds, item.workspace_id));
  const runIds = ids(state.node_runs, (item) => item.project_id === projectId || includes(workspaceIds, item.workspace_id) || includes(nodeIds, item.node_id));
  const assetIds = ids(state.assets, (item) => item.project_id === projectId || includes(workspaceIds, item.workspace_id) || includes(nodeIds, item.node_id) || includes(runIds, item.run_id));
  const assetVersionIds = ids(state.asset_versions, (item) => includes(assetIds, item.asset_id));
  const sessionIds = ids(state.assist_sessions, (item) => item.project_id === projectId || includes(workspaceIds, item.workspace_id) || includes(nodeIds, item.node_id));
  const turnIds = ids(state.assist_turns, (item) => item.project_id === projectId || includes(sessionIds, item.session_id));
  const terminalIds = ids(state.terminal_sessions, (item) => item.project_id === projectId || includes(sessionIds, item.assist_session_id) || includes(turnIds, item.turn_id));
  const proposalIds = ids(state.change_proposals, (item) => item.project_id === projectId || includes(workspaceIds, item.workspace_id) || includes(nodeIds, item.node_id));
  const contextPackIds = ids(state.context_packs, (item) => includes(workspaceIds, item.source_workspace_id) || item.content_json?.project?.id === projectId || state.node_runs.some((run) => includes(runIds, run.id) && run.context_pack_id === item.id) || state.assist_turns.some((turn) => includes(turnIds, turn.id) && turn.context_pack_id === item.id));
  const checkIds = ids(state.context_sufficiency_checks, (item) => item.project_id === projectId || includes(workspaceIds, item.workspace_id) || includes(nodeIds, item.node_id) || (item.target_type === 'assist_turn' && includes(turnIds, item.target_id)));
  const projectRecords = [...state.context_packs.filter((item) => includes(contextPackIds, item.id)), ...state.node_runs.filter((item) => includes(runIds, item.id)), ...state.code_changes.filter((item) => item.project_id === projectId || includes(runIds, item.run_id)), ...state.terminal_sessions.filter((item) => includes(terminalIds, item.id)), ...state.attachments.filter((item) => item.project_id === projectId || includes(sessionIds, item.session_id) || includes(turnIds, item.turn_id)), ...state.traces.filter((item) => item.project_id === projectId || includes(runIds, item.run_id))];
  const fileRefIds = referencedFileIds(projectRecords);
  const targetIds = new Set([projectId, ...workspaceIds, ...workflowIds, ...nodeIds, ...runIds, ...assetIds, ...assetVersionIds, ...sessionIds, ...turnIds, ...terminalIds, ...proposalIds, ...contextPackIds, ...checkIds]);
  return { workspaceIds, workflowIds, nodeIds, runIds, assetIds, assetVersionIds, sessionIds, turnIds, terminalIds, proposalIds, contextPackIds, checkIds, fileRefIds, targetIds };
}

function referencedFileIds(records) {
  const result = new Set();
  for (const item of records) for (const [key, value] of Object.entries(item || {})) if ((key === 'file_ref_id' || key.endsWith('_file_ref_id')) && typeof value === 'string') result.add(value);
  return result;
}

function fileRefMatches(item, projectId, workspaceIds, runIds, terminalIds, contextPackIds) {
  const meta = item.meta || {};
  return item.project_id === projectId || meta.project_id === projectId || includes(workspaceIds, item.workspace_id) || includes(workspaceIds, meta.workspace_id) || includes(runIds, meta.run_id) || includes(terminalIds, meta.terminal_session_id) || includes(contextPackIds, meta.context_pack_id);
}

function assetRelationMatches(item, assetIds, versionIds) {
  return ['asset_id', 'source_asset_id', 'target_asset_id', 'from_asset_id', 'to_asset_id'].some((key) => includes(assetIds, item[key]))
    || ['asset_version_id', 'source_version_id', 'target_version_id', 'from_version_id', 'to_version_id'].some((key) => includes(versionIds, item[key]));
}
