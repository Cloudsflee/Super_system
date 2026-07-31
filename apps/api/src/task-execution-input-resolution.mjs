import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { repositoryWorkspaceSnapshotHash } from './repository-workspace-service.mjs';
import { applicationPolicy } from './task-effects.mjs';
import { isContributionTask } from '../../../packages/shared/src/task-contributions.mjs';
import { verifyContributionRoutes } from './task-handoff.mjs';
import { normalizeTargetOutputKeys } from './task-execution-input-domain.mjs';
import {
  assetVersionSnapshot,
  briefSnapshot,
  byNewest,
  cleanExecutionText,
  confirmedNodeAssets,
  currentExecutionForTask,
  decisionSnapshot,
  dependencyIds,
  legacyAcceptedDependencySnapshot,
  missingExecutionInput,
  repositoryLineSnapshot,
  uniqueBindingCount,
  validExecutionBindings
} from './task-execution-context-snapshots.mjs';
import { inspectWorkstreamDependencyHandoff, selectTaskOutputBindings } from './task-execution-handoff.mjs';

export function resolveExecutionInputSlot(state, scope, slot, errors) {
  const base = executionInputBase(slot, scope.contract);
  if (slot.source === 'brief') return resolveBriefInput(state, scope, slot, base, errors);
  if (slot.source === 'dependency') return resolveDependencyInput(state, scope, slot, base, errors);
  if (slot.source === 'workstream_dependency')
    return resolveWorkstreamDependencyInput(state, scope, slot, base, errors);
  if (slot.source === 'repository_workspace') return resolveRepositoryInput(state, scope, slot, base, errors);
  if (['asset', 'asset_version'].includes(slot.source) || slot.kind === 'asset_version')
    return resolveAssetInput(state, scope, slot, base, errors);
  if (slot.source === 'decision') return resolveDecisionInput(state, scope, slot, base, errors);
  if (hasInlineInputValue(slot)) return { ...base, context: slot.value ?? null };
  return slot.required === false ? null : missingExecutionInput(errors, slot, 'input_source_unresolved');
}

function executionInputBase(slot, contract) {
  return {
    key: slot.key,
    kind: slot.kind,
    required: slot.required !== false,
    source: slot.source,
    selector: slot.selector ?? null,
    ref_id: slot.ref_id ?? null,
    version_id: slot.version_id ?? null,
    consumption_policy: normalizedConsumptionPolicy(slot.consumption_policy),
    application_policy: applicationPolicy(slot),
    purpose: cleanExecutionText(slot.purpose, 1000) || null,
    target_output_keys: normalizeTargetOutputKeys(slot.target_output_keys, contract),
    coverage_policy: slot.coverage_policy === 'any' ? 'any' : 'all',
    contribution: slot.contribution ? structuredClone(slot.contribution) : null
  };
}

function normalizedConsumptionPolicy(value) {
  return ['must_use', 'must_acknowledge', 'available'].includes(value) ? value : null;
}

function resolveBriefInput(state, scope, slot, base, errors) {
  const brief = (state.project_briefs || [])
    .filter((item) => item.project_id === scope.project.id && item.status !== 'superseded')
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  return brief
    ? { ...base, context: briefSnapshot(brief) }
    : missingExecutionInput(errors, slot, 'project_brief_missing');
}

function resolveDecisionInput(state, scope, slot, base, errors) {
  const decision = state.decisions.find(
    (item) => item.id === slot.ref_id && item.project_id === scope.project.id && item.status !== 'superseded'
  );
  return decision
    ? { ...base, context: decisionSnapshot(decision) }
    : missingExecutionInput(errors, slot, 'decision_input_missing');
}

function hasInlineInputValue(slot) {
  return slot.value != null || slot.source === 'inline' || (slot.source === 'explicit' && slot.kind === 'context');
}

function resolveDependencyInput(state, scope, slot, base, errors) {
  const dependencyId = scopedDependencyId(scope.task, slot.ref_id);
  if (!dependencyId) return missingExecutionInput(errors, slot, 'dependency_input_scope_invalid');
  const source = acceptedDependencySource(state, scope, dependencyId);
  if (!source.ready)
    return missingExecutionInput(errors, slot, 'dependency_output_not_accepted', { dependency_id: dependencyId });
  const selectedBindings = selectTaskOutputBindings(
    state,
    source.dependency,
    source.execution,
    slot.selector,
    source.bindings
  );
  let bindings = validExecutionBindings(state, scope.project.id, selectedBindings, Boolean(scope.taskExecution));
  if (!bindings.length && !scope.strict) bindings = confirmedNodeAssets(state, scope.project.id, dependencyId);
  if (scope.taskExecution && bindings.length !== uniqueBindingCount(selectedBindings))
    return missingExecutionInput(errors, slot, 'dependency_output_binding_invalid', { dependency_id: dependencyId });
  if (!bindings.length) return resolveLegacyDependencyInput(state, scope, slot, base, errors, dependencyId);
  return resolvedDependencyInput(scope, slot, base, errors, dependencyId, source, selectedBindings, bindings);
}

function scopedDependencyId(task, requestedId) {
  const dependencies = dependencyIds(task);
  const dependencyId = requestedId || dependencies[0];
  return dependencyId && dependencies.includes(dependencyId) ? dependencyId : null;
}

function acceptedDependencySource(state, scope, dependencyId) {
  const dependency = state.workflow_nodes.find(
    (item) => item.id === dependencyId && item.parent_node_id === scope.task.parent_node_id
  );
  const execution = scope.taskExecution
    ? currentExecutionForTask(state, scope.taskExecution.workflow_execution_id, dependencyId)
    : null;
  const completed = execution ? execution.status === 'completed' : dependency?.status === 'completed';
  if (!dependency || !completed || dependency.input_superseded) return { ready: false };
  const submission = state.submissions
    .filter((item) => item.node_id === dependencyId && item.status === 'accepted')
    .sort(byNewest)[0];
  const bindings = execution?.output_bindings?.length ? execution.output_bindings : submission?.output_bindings || [];
  return { ready: true, dependency, execution, submission, bindings };
}

function resolveLegacyDependencyInput(state, scope, slot, base, errors, dependencyId) {
  const canUseLegacy =
    scope.strict && !isContributionTask(scope.task) && (!slot.selector || slot.selector === 'required_outputs');
  const legacy = canUseLegacy ? legacyAcceptedDependencySnapshot(state, dependencyId) : null;
  if (!legacy)
    return missingExecutionInput(errors, slot, 'dependency_output_binding_missing', { dependency_id: dependencyId });
  return {
    ...base,
    ref_id: dependencyId,
    representation: 'legacy_accepted_dependency',
    legacy_compatibility: true,
    legacy_accepted_dependency: legacy
  };
}

function resolvedDependencyInput(scope, slot, base, errors, dependencyId, source, selectedBindings, bindings) {
  const routes = verifyContributionRoutes(scope.task, base, bindings);
  if (!routes.ok) {
    const { code, ...detail } = routes;
    return missingExecutionInput(errors, slot, code, detail);
  }
  return {
    ...base,
    ref_id: dependencyId,
    asset_versions: bindings,
    resolved_from: dependencyResolutionSnapshot(slot, source, selectedBindings, bindings, routes.routes)
  };
}

function dependencyResolutionSnapshot(slot, source, selectedBindings, bindings, routes) {
  return {
    kind: 'task_execution_outputs',
    workflow_execution_id: source.execution?.workflow_execution_id || null,
    task_id: source.dependency.id,
    task_title: source.dependency.title,
    task_execution_id: source.execution?.id || null,
    submission_id: source.execution ? null : source.submission?.id || null,
    contract_id: source.execution?.contract_id || source.dependency.current_contract_id || null,
    selector: slot.selector || 'required_outputs',
    selected_output_keys: bindings.map((item) => item.output_key).filter(Boolean),
    attestation_ids: selectedBindings.map((item) => item.attestation_id).filter(Boolean),
    contribution_routes: routes
  };
}

function resolveWorkstreamDependencyInput(state, scope, slot, base, errors) {
  const parentWorkstream = state.workflow_nodes.find(
    (item) =>
      item.id === scope.task.parent_node_id && item.role === 'workstream' && item.workflow_id === scope.workflow.id
  );
  if (!parentWorkstream || !dependencyIds(parentWorkstream).includes(slot.ref_id))
    return missingExecutionInput(errors, slot, 'workstream_dependency_input_scope_invalid', {
      dependency_workstream_id: slot.ref_id || null,
      workstream_id: parentWorkstream?.id || scope.task.parent_node_id || null
    });
  const handoff = inspectWorkstreamDependencyHandoff(state, {
    projectId: scope.project.id,
    workflowId: scope.workflow.id,
    workflowExecutionId: scope.taskExecution?.workflow_execution_id || null,
    workstreamId: slot.ref_id,
    selector: slot.selector || 'required_outputs',
    strict: Boolean(scope.taskExecution)
  });
  if (!handoff.ready) {
    const { code, ...detail } = handoff.reason;
    return missingExecutionInput(errors, slot, code, detail);
  }
  return resolvedWorkstreamDependencyInput(scope, slot, base, errors, handoff);
}

function resolvedWorkstreamDependencyInput(scope, slot, base, errors, handoff) {
  const routes = verifyContributionRoutes(scope.task, base, handoff.asset_versions);
  if (!routes.ok) {
    const { code, ...detail } = routes;
    return missingExecutionInput(errors, slot, code, detail);
  }
  return {
    ...base,
    ref_id: handoff.workstream.id,
    version_id: handoff.asset_versions.length === 1 ? handoff.asset_versions[0].version_id : null,
    asset_versions: handoff.asset_versions,
    resolved_from: { ...handoff.resolved_from, contribution_routes: routes.routes }
  };
}

function resolveAssetInput(state, scope, slot, base, errors) {
  const version = state.asset_versions.find(
    (item) =>
      item.id === slot.version_id ||
      (item.asset_id === slot.ref_id && (!slot.version_id || item.id === slot.version_id))
  );
  const asset = state.assets.find(
    (item) => item.id === (slot.ref_id || version?.asset_id) && item.project_id === scope.project.id
  );
  if (!assetInputIsReady(asset, version, scope.taskExecution))
    return missingExecutionInput(errors, slot, 'asset_version_not_confirmed');
  return { ...base, ref_id: asset.id, version_id: version.id, asset_versions: [assetVersionSnapshot(asset, version)] };
}

function assetInputIsReady(asset, version, taskExecution) {
  if (!asset || !version || version.asset_id !== asset.id) return false;
  if (asset.status !== 'confirmed' || asset.current_version_id !== version.id) return false;
  return !taskExecution || version.verification_status === 'verified';
}

function resolveRepositoryInput(state, scope, slot, base, errors) {
  if (scope.repositoryLine) return resolveRepositoryLineInput(scope, slot, base, errors);
  const workspaceId = slot.ref_id || scope.repositoryWorkspaceId || scope.project.default_repository_workspace_id;
  const workspace = state.repository_workspaces.find(
    (item) => item.id === workspaceId && item.project_id === scope.project.id && item.status === 'active'
  );
  if (!workspace) return scope.strict ? missingExecutionInput(errors, slot, 'repository_workspace_missing') : null;
  if (workspace.stale || workspace.sync_status !== 'ready')
    return missingExecutionInput(errors, slot, 'repository_workspace_stale', { repository_workspace_id: workspace.id });
  return { ...base, ref_id: workspace.id, repository_snapshot: repositoryWorkspaceSnapshot(workspace) };
}

function resolveRepositoryLineInput(scope, slot, base, errors) {
  const line = scope.repositoryLine;
  if (line.project_id !== scope.project.id || line.status !== 'active' || !line.head_sha)
    return missingExecutionInput(errors, slot, 'repository_line_not_ready', { repository_line_id: line.id });
  return { ...base, ref_id: line.id, repository_snapshot: repositoryLineSnapshot(line, scope.task) };
}

function repositoryWorkspaceSnapshot(workspace) {
  return {
    repository_workspace_id: workspace.id,
    connection_id: workspace.connection_id,
    ref: workspace.ref,
    fixed_sha: workspace.fixed_sha,
    current_sha: workspace.current_sha,
    mode: workspace.mode,
    scope: structuredClone(workspace.scope),
    managed_path: workspace.managed_path,
    snapshot_hash: repositoryWorkspaceSnapshotHash(workspace)
  };
}
