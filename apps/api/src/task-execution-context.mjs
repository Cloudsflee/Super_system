import { hashString, now } from '../../../packages/shared/index.mjs';
import { buildContextPack } from '../../../packages/shared/src/context-run.mjs';
import { HttpError } from './http.mjs';
import { repositoryWorkspaceSnapshotHash } from './repository-workspace-service.mjs';

export function prepareTaskExecutionContext(state, input) {
  const { project, workspace, task, contract } = input, workflow = input.workflow || state.workflows.find((item) => item.id === task?.workflow_id);
  if (!project || !task || !contract || !workflow) throw new HttpError(404, { error: 'task_execution_scope_not_found' });
  if (task.role === 'workstream') throw new HttpError(409, { error: 'workstream_is_aggregate_not_executable', node_id: task.id });
  if (task.status === 'completed') throw notReady([{ code: 'task_completed_immutable', task_id: task.id, action: 'create_follow_up_task_or_reopen_revision' }]);
  const strict = workflow.planning_quality === 'verified', errors = [], resolved = [];
  const slots = Array.isArray(contract.expected_inputs) ? contract.expected_inputs : [];
  for (const slot of slots) {
    const value = resolveInputSlot(state, { ...input, project, task, workflow, strict }, slot, errors);
    if (value) resolved.push(value);
    else if (slot.required !== false && !errors.some((item) => item.slot_key === slot.key)) errors.push({ code: 'required_input_missing', slot_key: slot.key });
  }
  const repositorySnapshot = resolved.find((item) => item.kind === 'repository')?.repository_snapshot || legacyRepositorySnapshot(project, strict, errors);
  validateRepositoryVersionBinding(resolved, repositorySnapshot, errors);
  if (errors.length && strict) throw notReady(errors);
  const assets = uniqueAssets(resolved.flatMap((item) => item.asset_versions || []));
  const parent = state.workflow_nodes.find((item) => item.id === task.parent_node_id), parentWorkspace = state.workspaces.find((item) => item.id === parent?.workspace_id || item.workflow_node_id === parent?.id);
  const digest = state.digests.filter((item) => item.workspace_id === parentWorkspace?.id && item.status === 'confirmed').sort(byNewest)[0] || null;
  const brief = (state.project_briefs || []).filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
  const dependencyGraph = dependencySnapshot(state, task), decisions = state.decisions.filter((item) => item.project_id === project.id && item.status !== 'superseded');
  const snapshot = {
    schema_version: 'aiws.task_execution_context.v2', project_id: project.id, workflow_id: workflow.id,
    workstream_id: task.parent_node_id || null, task: taskSnapshot(task), contract: structuredClone(contract),
    dependency_graph: dependencyGraph, inputs: resolved, repository_snapshot: repositorySnapshot,
    workstream_digest: digest ? digestSnapshot(digest) : null, project_brief: brief ? briefSnapshot(brief) : null,
    project_decisions: decisions.map(decisionSnapshot), planning_quality: workflow.planning_quality || 'legacy_unverified',
    legacy_compatibility: !strict
  };
  snapshot.input_snapshot_hash = executionInputHash(snapshot);
  const contextPack = buildContextPack({ state, project, workspace, node: task, contract, purpose: input.purpose || 'node_run', receiver_name: input.receiverName || 'CodexRunner', executionContext: snapshot });
  snapshot.context_pack_id = contextPack.id; snapshot.prepared_at = now();
  Object.assign(contextPack, { task_execution_context: structuredClone(snapshot), input_snapshot_hash: snapshot.input_snapshot_hash, repository_snapshot_hash: repositorySnapshot?.snapshot_hash || null });
  state.context_packs.push(contextPack); state.context_sufficiency_checks.push(contextPack._sufficiency_check);
  return { context: snapshot, context_pack: contextPack };
}

export function evaluateTaskExecutionContextFreshness(state, context) {
  const reasons = [];
  for (const input of context?.inputs || []) {
    for (const binding of input.asset_versions || []) {
      const asset = state.assets.find((item) => item.id === binding.asset_id), version = state.asset_versions.find((item) => item.id === binding.version_id && item.asset_id === binding.asset_id);
      if (!asset || !version || ['stale', 'disputed', 'superseded', 'rejected'].includes(asset.status)) reasons.push({ code: 'input_asset_version_invalid', asset_id: binding.asset_id, version_id: binding.version_id });
      if (input.source === 'dependency' && asset?.current_version_id !== binding.version_id) reasons.push({ code: 'input_asset_version_superseded', asset_id: binding.asset_id, version_id: binding.version_id, current_version_id: asset.current_version_id });
    }
    if (input.legacy_accepted_dependency) {
      const current = legacyAcceptedDependencySnapshot(state, input.ref_id);
      if (!current || current.snapshot_hash !== input.legacy_accepted_dependency.snapshot_hash) reasons.push({ code: 'legacy_dependency_acceptance_changed', dependency_id: input.ref_id });
    }
  }
  const repository = context?.repository_snapshot;
  if (repository?.repository_workspace_id) {
    const current = state.repository_workspaces.find((item) => item.id === repository.repository_workspace_id && item.status === 'active');
    if (!current || current.stale || repository.snapshot_hash !== repositoryWorkspaceSnapshotHash(current)) reasons.push({ code: 'repository_snapshot_stale', repository_workspace_id: repository.repository_workspace_id });
  }
  return { current: reasons.length === 0, reasons };
}

export function executionInputHash(context) {
  return hashString(JSON.stringify({ task: context.task, contract: context.contract, dependency_graph: context.dependency_graph, inputs: context.inputs, repository_snapshot: context.repository_snapshot, workstream_digest: context.workstream_digest, project_brief: context.project_brief, project_decisions: context.project_decisions }));
}

function resolveInputSlot(state, scope, slot, errors) {
  const base = { key: slot.key, kind: slot.kind, required: slot.required !== false, source: slot.source, selector: slot.selector ?? null, ref_id: slot.ref_id ?? null, version_id: slot.version_id ?? null };
  if (slot.source === 'brief') {
    const brief = (state.project_briefs || []).filter((item) => item.project_id === scope.project.id && item.status !== 'superseded').sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
    return brief ? { ...base, context: briefSnapshot(brief) } : missing(errors, slot, 'project_brief_missing');
  }
  if (slot.source === 'dependency') return resolveDependencyInput(state, scope, slot, base, errors);
  if (slot.source === 'repository_workspace') return resolveRepositoryInput(state, scope, slot, base, errors);
  if (['asset', 'asset_version'].includes(slot.source) || slot.kind === 'asset_version') return resolveAssetInput(state, scope, slot, base, errors);
  if (slot.source === 'decision') {
    const decision = state.decisions.find((item) => item.id === slot.ref_id && item.project_id === scope.project.id && item.status !== 'superseded');
    return decision ? { ...base, context: decisionSnapshot(decision) } : missing(errors, slot, 'decision_input_missing');
  }
  if (slot.value != null || slot.source === 'inline' || slot.source === 'explicit' && slot.kind === 'context') return { ...base, context: slot.value ?? null };
  return slot.required === false ? null : missing(errors, slot, 'input_source_unresolved');
}

function resolveDependencyInput(state, scope, slot, base, errors) {
  const dependencies = dependencyIds(scope.task), dependencyId = slot.ref_id || dependencies[0];
  if (!dependencyId || !dependencies.includes(dependencyId)) return missing(errors, slot, 'dependency_input_scope_invalid');
  const dependency = state.workflow_nodes.find((item) => item.id === dependencyId && item.parent_node_id === scope.task.parent_node_id);
  if (!dependency || dependency.status !== 'completed' || dependency.input_superseded) return missing(errors, slot, 'dependency_output_not_accepted', { dependency_id: dependencyId });
  const submission = state.submissions.filter((item) => item.node_id === dependencyId && item.status === 'accepted').sort(byNewest)[0];
  let bindings = validBindings(state, scope.project.id, submission?.output_bindings || []);
  if (!bindings.length && !scope.strict) bindings = confirmedNodeAssets(state, scope.project.id, dependencyId);
  if (slot.selector && slot.selector !== 'required_outputs') bindings = bindings.filter((item) => item.output_key === slot.selector);
  if (!bindings.length) {
    const legacy = scope.strict && (!slot.selector || slot.selector === 'required_outputs') ? legacyAcceptedDependencySnapshot(state, dependencyId) : null;
    if (legacy) return { ...base, ref_id: dependencyId, representation: 'legacy_accepted_dependency', legacy_compatibility: true, legacy_accepted_dependency: legacy };
    return missing(errors, slot, 'dependency_output_binding_missing', { dependency_id: dependencyId });
  }
  return { ...base, ref_id: dependencyId, asset_versions: bindings };
}

function legacyAcceptedDependencySnapshot(state, dependencyId) {
  const dependency = state.workflow_nodes.find((item) => item.id === dependencyId && item.role === 'task' && item.status === 'completed' && item.review?.decision === 'approve');
  if (!dependency) return null;
  const submission = state.submissions.filter((item) => item.node_id === dependency.id && item.status === 'accepted' && !(item.output_bindings || []).length).sort(byNewest)[0];
  const delivery = state.deliveries.filter((item) => item.task_id === dependency.id && item.status === 'completed' && (item.commit_sha || item.result_json?.commit_sha)).sort(byNewest)[0];
  if (!submission || !delivery) return null;
  const snapshot = {
    schema_version: 'aiws.legacy_accepted_dependency.v1', dependency_id: dependency.id,
    execution_revision: Number(dependency.execution_revision || 1), reviewed_at: dependency.reviewed_at || submission.reviewed_at || null,
    submission: {
      id: submission.id, title: submission.title || '', summary: submission.summary || '',
      evidence_refs: [...(submission.evidence_refs || [])], reviewed_at: submission.reviewed_at || null
    },
    delivery: {
      id: delivery.id, commit_sha: delivery.commit_sha || delivery.result_json?.commit_sha || null,
      pr_url: delivery.pr_url || delivery.result_json?.pr_url || null, pr_state: delivery.pr_state || delivery.result_json?.pr_state || null,
      completed_at: delivery.completed_at || null,
      test_results: (delivery.test_results || delivery.result_json?.test_results || []).map((item) => ({ command: item.command || item.name || '', status: item.status || '', exit_code: item.exit_code ?? null }))
    }
  };
  snapshot.snapshot_hash = hashString(JSON.stringify(snapshot));
  return snapshot;
}

function resolveAssetInput(state, scope, slot, base, errors) {
  const version = state.asset_versions.find((item) => item.id === slot.version_id || item.asset_id === slot.ref_id && (!slot.version_id || item.id === slot.version_id));
  const asset = state.assets.find((item) => item.id === (slot.ref_id || version?.asset_id) && item.project_id === scope.project.id);
  if (!asset || !version || version.asset_id !== asset.id || asset.status !== 'confirmed' || asset.current_version_id !== version.id) return missing(errors, slot, 'asset_version_not_confirmed');
  return { ...base, ref_id: asset.id, version_id: version.id, asset_versions: [assetVersionSnapshot(asset, version)] };
}

function resolveRepositoryInput(state, scope, slot, base, errors) {
  const workspaceId = slot.ref_id || scope.repositoryWorkspaceId || scope.project.default_repository_workspace_id;
  const workspace = state.repository_workspaces.find((item) => item.id === workspaceId && item.project_id === scope.project.id && item.status === 'active');
  if (!workspace) return scope.strict ? missing(errors, slot, 'repository_workspace_missing') : null;
  if (workspace.stale || workspace.sync_status !== 'ready') return missing(errors, slot, 'repository_workspace_stale', { repository_workspace_id: workspace.id });
  return { ...base, ref_id: workspace.id, repository_snapshot: { repository_workspace_id: workspace.id, connection_id: workspace.connection_id, ref: workspace.ref, fixed_sha: workspace.fixed_sha, current_sha: workspace.current_sha, mode: workspace.mode, scope: structuredClone(workspace.scope), managed_path: workspace.managed_path, snapshot_hash: repositoryWorkspaceSnapshotHash(workspace) } };
}

function validBindings(state, projectId, bindings) { return uniqueAssets((bindings || []).map((item) => { const asset = state.assets.find((entry) => entry.id === item.asset_id && entry.project_id === projectId && entry.status === 'confirmed' && entry.current_version_id === item.version_id), version = state.asset_versions.find((entry) => entry.id === item.version_id && entry.asset_id === asset?.id); return asset && version ? assetVersionSnapshot(asset, version, item.key) : null; }).filter(Boolean)); }
function confirmedNodeAssets(state, projectId, nodeId) { return state.assets.filter((item) => item.project_id === projectId && item.node_id === nodeId && item.status === 'confirmed').map((asset) => { const version = state.asset_versions.find((item) => item.id === asset.current_version_id); return version ? assetVersionSnapshot(asset, version, asset.output_key || version.output_key || null) : null; }).filter(Boolean); }
function assetVersionSnapshot(asset, version, outputKey = null) { return { output_key: outputKey, asset_id: asset.id, version_id: version.id, asset_type: asset.asset_type, repository_sha: version.repository_sha || asset.repository_sha || null, title: version.title, summary: version.summary, body: version.body, evidence_refs: version.evidence_refs || [] }; }
function validateRepositoryVersionBinding(inputs, repository, errors) { const versions = inputs.flatMap((item) => item.asset_versions || []).filter((item) => /RepositoryVersionAsset/i.test(item.asset_type)); const hashes = [...new Set(versions.map((item) => item.repository_sha).filter(Boolean))]; if (!versions.length) return; if (versions.some((item) => !item.repository_sha) || hashes.length !== 1) errors.push({ code: 'repository_version_sha_invalid', version_ids: versions.map((item) => item.version_id) }); else if (!repository || repository.fixed_sha !== hashes[0]) errors.push({ code: 'repository_snapshot_version_mismatch', expected_sha: hashes[0], actual_sha: repository?.fixed_sha || null }); }
function legacyRepositorySnapshot(project, strict, errors) { if (strict || !project.repo_path) return null; return { repository_workspace_id: null, legacy: true, managed_path: project.repo_path, ref: null, fixed_sha: project.source_hash || null, snapshot_hash: hashString(JSON.stringify({ project_id: project.id, repo_path: project.repo_path, source_hash: project.source_hash || null })) }; }
function dependencySnapshot(state, task) { return dependencyIds(task).map((id) => { const node = state.workflow_nodes.find((item) => item.id === id); return { id, status: node?.status || 'missing', execution_revision: Number(node?.execution_revision || 1), latest_submission_id: node?.latest_submission_id || null }; }); }
function dependencyIds(task) { return [...new Set((task.dependencies || []).map((item) => typeof item === 'string' ? item : item.node_id).filter(Boolean))]; }
function taskSnapshot(task) { return { id: task.id, workflow_id: task.workflow_id, parent_node_id: task.parent_node_id || null, title: task.title, goal: task.goal, task_kind: task.task_kind, execution_mode: task.execution_mode, capability_tags: task.capability_tags || [], acceptance_criteria: task.acceptance_criteria || [], execution_revision: Number(task.execution_revision || 1) }; }
function briefSnapshot(brief) { return { id: brief.id, version: brief.version, revision: brief.revision, content: structuredClone(brief.content) }; }
function digestSnapshot(digest) { return { id: digest.id, version: digest.version, summary: digest.summary, body: digest.body, evidence_refs: digest.evidence_refs || [] }; }
function decisionSnapshot(item) { return { id: item.id, title: item.title, summary: item.summary, rationale: item.rationale, evidence_refs: item.evidence_refs || [] }; }
function uniqueAssets(items) { const seen = new Set(); return items.filter((item) => { const key = `${item.asset_id}:${item.version_id}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function missing(errors, slot, code, detail = {}) { errors.push({ code, slot_key: slot.key, ...detail }); return null; }
function notReady(reasons) { return new HttpError(409, { error: 'task_context_not_ready', reasons }); }
function byNewest(a, b) { return String(b.reviewed_at || b.created_at || '').localeCompare(String(a.reviewed_at || a.created_at || '')); }
