import { estimateTokens, hashString, now } from '../../../packages/shared/index.mjs';
import { buildContextPack, buildRunnerInstruction } from '../../../packages/shared/src/context-run.mjs';
import { HttpError } from './http.mjs';
import { repositoryWorkspaceSnapshotHash } from './repository-workspace-service.mjs';
import { CONTEXT_PACK_SCHEMA } from '../../../packages/system-context/src/index.mjs';
import { compactRuntimeMap, createSelectionForRuntimeInState } from './context-service.mjs';
import { applicationPolicy } from './task-effects.mjs';

export const EXECUTION_INPUT_HASH_VERSION = 3;

export function prepareTaskExecutionContext(state, input) {
  const { project, workspace, task, contract } = input,
    workflow = input.workflow || state.workflows.find((item) => item.id === task?.workflow_id);
  if (!project || !task || !contract || !workflow)
    throw new HttpError(404, { error: 'task_execution_scope_not_found' });
  if (task.role === 'workstream')
    throw new HttpError(409, { error: 'workstream_is_aggregate_not_executable', node_id: task.id });
  if (task.status === 'completed' && input.allowCompletedTask !== true)
    throw notReady([
      { code: 'task_completed_immutable', task_id: task.id, action: 'create_follow_up_task_or_reopen_revision' }
    ]);
  const strict = workflow.planning_quality === 'verified',
    { errors, resolved } = resolveExecutionInputs(state, input, { project, task, contract, workflow, strict });
  const repositorySnapshot = selectRepositorySnapshot(input, project, task, strict, resolved, errors);
  validateRepositoryVersionBinding(resolved, repositorySnapshot, errors);
  if (errors.length && strict) throw notReady(errors);
  const snapshot = createExecutionSnapshot(state, input, {
    project,
    task,
    contract,
    workflow,
    strict,
    resolved,
    repositorySnapshot
  });
  snapshot.input_snapshot_hash_version = EXECUTION_INPUT_HASH_VERSION;
  snapshot.input_snapshot_hash = executionInputHash(snapshot);
  const contextPack = persistExecutionContext(state, input, { project, workspace, task, contract, snapshot });
  return { context: snapshot, context_pack: contextPack };
}

function resolveExecutionInputs(state, input, scope) {
  const errors = [],
    resolved = [];
  const slots = Array.isArray(scope.contract?.expected_inputs) ? scope.contract.expected_inputs : [];
  for (const slot of slots) {
    const value = resolveInputSlot(state, { ...input, ...scope }, slot, errors);
    if (value) resolved.push(value);
    else if (slot.required !== false && !errors.some((item) => item.slot_key === slot.key))
      errors.push({ code: 'required_input_missing', slot_key: slot.key });
  }
  return { errors, resolved };
}

function selectRepositorySnapshot(input, project, task, strict, resolved, errors) {
  const resolvedRepository = resolved.find((item) => item.kind === 'repository')?.repository_snapshot;
  if (resolvedRepository) return resolvedRepository;
  return input.repositoryLine
    ? repositoryLineSnapshot(input.repositoryLine, task)
    : legacyRepositorySnapshot(project, strict, errors);
}

function createExecutionSnapshot(state, input, scope) {
  const { project, task, contract, workflow, strict, resolved, repositorySnapshot } = scope;
  const digest = requiresContext(contract, 'latest_digest') ? currentWorkstreamDigest(state, task) : null,
    brief = resolved.find((item) => item.source === 'brief')?.context || null,
    dependencyGraph = dependencySnapshot(state, task, input.taskExecution?.workflow_execution_id),
    decisions = resolved.filter((item) => item.source === 'decision' && item.context).map((item) => item.context);
  return {
    schema_version: input.taskExecution ? 'aiws.task_execution_context.v4' : 'aiws.task_execution_context.v2',
    project_id: project.id,
    workflow_id: workflow.id,
    workflow_execution_id: input.workflowExecution?.id || input.taskExecution?.workflow_execution_id || null,
    workflow_revision:
      input.workflowExecution?.workflow_revision || Number(workflow.workflow_revision || workflow.version || 1),
    task_execution_id: input.taskExecution?.id || null,
    task_revision: input.taskExecution?.task_revision || Number(task.execution_revision || 1),
    workstream_id: task.parent_node_id || null,
    task: taskSnapshot(task),
    contract: structuredClone(contract),
    dependency_graph: dependencyGraph,
    inputs: resolved,
    input_effect_obligations: inputEffectObligations(resolved, contract),
    repository_snapshot: repositorySnapshot,
    workstream_digest: digest ? digestSnapshot(digest) : null,
    project_brief: brief ? structuredClone(brief) : null,
    project_decisions: decisions.map((item) => structuredClone(item)),
    planning_quality: workflow.planning_quality || 'legacy_unverified',
    legacy_compatibility: !strict
  };
}

function currentWorkstreamDigest(state, task) {
  const parent = state.workflow_nodes.find((item) => item.id === task.parent_node_id);
  const workspace = state.workspaces.find(
    (item) => item.id === parent?.workspace_id || item.workflow_node_id === parent?.id
  );
  return (
    state.digests
      .filter((item) => item.workspace_id === workspace?.id && item.status === 'confirmed')
      .sort(byNewest)[0] || null
  );
}

function requiresContext(contract, type) {
  return (contract?.required_context || []).some((item) => item?.type === type && item.required === true);
}

function persistExecutionContext(state, input, scope) {
  const { project, workspace, task, contract, snapshot } = scope;
  const contextPack = buildContextPack({
    state,
    project,
    workspace,
    node: task,
    contract,
    purpose: input.purpose || 'node_run',
    receiver_name: input.receiverName || 'CodexRunner',
    executionContext: snapshot
  });
  const actorId = input.actorId || project.owner_user_id || project.created_by_user_id || state.instance_owner_user_id,
    selection = createSelectionForRuntimeInState(state, {
      actorId,
      projectId: project.id,
      anchorSourceCollection: 'workflow_nodes',
      anchorSourceId: task.id,
      explicitSourceRefs: runtimeContextSourceRefs(snapshot),
      candidateLimit: 0,
      tokenBudget: Number(project.settings?.token_budget || 12_000)
    }),
    compactMap = compactRuntimeMap(state, project.id, task.id),
    requiredContextRefs = requiredContextSourceRefs(snapshot),
    documentVersions = selection.included.map((item) => {
      const node = state.context_nodes.find((entry) => entry.id === item.node_id),
        sourceKey = `${node?.source_collection || ''}:${node?.source_id || ''}`;
      return {
        node_id: item.node_id,
        document_version_id: item.document_version_id,
        content_sha256: item.content_sha256,
        source_collection: node?.source_collection || null,
        source_id: node?.source_id || null,
        title: node?.title || null,
        reason: item.reason,
        required: requiredContextRefs.has(sourceKey),
        consumption_policy: 'available',
        delivery_mode: 'metadata_only'
      };
    }),
    retrievalProtocol = {
      tool: 'aiws_context',
      order: ['map', 'search', 'read'],
      instruction: '按任务锚点读取必要上下文；不得绕过项目 ACL、资源 scope、新鲜度或 Exchange Grant。'
    };
  snapshot.system_context = {
    current_anchor: { node_id: compactMap.anchor_node_id, source_collection: 'workflow_nodes', source_id: task.id },
    context_map: compactMap,
    context_selection_id: selection.id,
    document_versions: documentVersions,
    retrieval_protocol: retrievalProtocol
  };
  Object.assign(contextPack, {
    schema_version: CONTEXT_PACK_SCHEMA,
    version: 4,
    context_selection_id: selection.id,
    context_document_versions: selection.included.map((item) => item.document_version_id)
  });
  Object.assign(contextPack.content_json, {
    schema_version: CONTEXT_PACK_SCHEMA,
    context_map: compactMap,
    context_selection_id: selection.id,
    document_versions: documentVersions,
    retrieval_protocol: retrievalProtocol
  });
  contextPack.content_json.runner_instruction = buildRunnerInstruction({
    project,
    node: task,
    contract,
    executionContext: snapshot
  });
  contextPack.token_estimate = estimateTokens(JSON.stringify(contextPack.content_json));
  snapshot.context_pack_id = contextPack.id;
  snapshot.prepared_at = now();
  Object.assign(contextPack, {
    task_execution_context: structuredClone(snapshot),
    input_snapshot_hash: snapshot.input_snapshot_hash,
    input_snapshot_hash_version: snapshot.input_snapshot_hash_version,
    repository_snapshot_hash: snapshot.repository_snapshot?.snapshot_hash || null
  });
  state.context_packs.push(contextPack);
  state.context_sufficiency_checks.push(contextPack._sufficiency_check);
  return contextPack;
}

export function evaluateTaskExecutionContextFreshness(state, context) {
  const reasons = [];
  for (const input of context?.inputs || []) {
    reasons.push(...inputAssetFreshnessReasons(state, context, input));
    reasons.push(...legacyDependencyFreshnessReasons(state, input));
    reasons.push(...workstreamHandoffFreshnessReasons(state, context, input));
  }
  reasons.push(...contextDocumentFreshnessReasons(state, context));
  reasons.push(...repositoryFreshnessReasons(state, context));
  return { current: reasons.length === 0, reasons };
}

function inputAssetFreshnessReasons(state, context, input) {
  const reasons = [];
  for (const binding of input.asset_versions || []) {
    const asset = state.assets.find((item) => item.id === binding.asset_id),
      version = state.asset_versions.find(
        (item) => item.id === binding.version_id && item.asset_id === binding.asset_id
      );
    if (!asset || !version || ['stale', 'disputed', 'superseded', 'rejected'].includes(asset.status))
      reasons.push({
        code: 'input_asset_version_invalid',
        asset_id: binding.asset_id,
        version_id: binding.version_id
      });
    if (
      ['aiws.task_execution_context.v3', 'aiws.task_execution_context.v4'].includes(context.schema_version) &&
      (version?.verification_status !== 'verified' ||
        version?.immutable !== true ||
        version?.content_sha256 !== binding.content_sha256)
    )
      reasons.push({
        code: 'input_asset_integrity_invalid',
        asset_id: binding.asset_id,
        version_id: binding.version_id
      });
    if (
      ['dependency', 'workstream_dependency'].includes(input.source) &&
      asset?.current_version_id !== binding.version_id
    )
      reasons.push({
        code: 'input_asset_version_superseded',
        asset_id: binding.asset_id,
        version_id: binding.version_id,
        current_version_id: asset.current_version_id
      });
  }
  return reasons;
}

function legacyDependencyFreshnessReasons(state, input) {
  if (!input.legacy_accepted_dependency) return [];
  const current = legacyAcceptedDependencySnapshot(state, input.ref_id);
  return !current || current.snapshot_hash !== input.legacy_accepted_dependency.snapshot_hash
    ? [{ code: 'legacy_dependency_acceptance_changed', dependency_id: input.ref_id }]
    : [];
}

function workstreamHandoffFreshnessReasons(state, context, input) {
  if (input.resolved_from?.kind !== 'workstream_outcome') return [];
  const current = inspectWorkstreamDependencyHandoff(state, {
      projectId: context.project_id,
      workflowId: context.workflow_id,
      workflowExecutionId: context.workflow_execution_id,
      workstreamId: input.resolved_from.workstream_id,
      selector: input.resolved_from.selector,
      strict: true
    }),
    expectedVersions = (input.asset_versions || []).map((item) => item.version_id).sort(),
    currentVersions = current.ready ? current.asset_versions.map((item) => item.version_id).sort() : [];
  const changed =
    !current.ready ||
    current.version.id !== input.resolved_from.outcome_version_id ||
    current.attestation?.id !== input.resolved_from.outcome_attestation_id ||
    JSON.stringify(currentVersions) !== JSON.stringify(expectedVersions);
  return changed
    ? [
        {
          code: 'workstream_handoff_changed',
          dependency_workstream_id: input.resolved_from.workstream_id,
          detail_code: current.ready ? 'handoff_version_changed' : current.reason.code
        }
      ]
    : [];
}

function contextDocumentFreshnessReasons(state, context) {
  const reasons = [],
    selection = state.context_selections.find((item) => item.id === context?.system_context?.context_selection_id);
  for (const document of context?.system_context?.document_versions || []) {
    const node = state.context_nodes.find((item) => item.id === document.node_id),
      version = state.context_document_versions.find(
        (item) => item.id === document.document_version_id && item.node_id === document.node_id
      ),
      included = selection?.included?.find(
        (item) => item.node_id === document.node_id && item.document_version_id === document.document_version_id
      );
    if (
      !selection ||
      !node ||
      !version ||
      !included ||
      version.content_sha256 !== document.content_sha256 ||
      included.content_sha256 !== document.content_sha256
    ) {
      reasons.push({
        code: 'context_document_version_invalid',
        node_id: document.node_id,
        document_version_id: document.document_version_id
      });
      continue;
    }
    if (
      document.required === true &&
      (node.current_version_id !== version.id || node.source_hash !== version.source_hash)
    )
      reasons.push({
        code: 'required_context_document_superseded',
        node_id: document.node_id,
        document_version_id: document.document_version_id,
        current_document_version_id: node.current_version_id || null
      });
  }
  return reasons;
}

function repositoryFreshnessReasons(state, context) {
  const repository = context?.repository_snapshot;
  if (!repository?.repository_workspace_id) return [];
  const current = state.repository_workspaces.find(
    (item) => item.id === repository.repository_workspace_id && item.status === 'active'
  );
  return !current || current.stale || repository.snapshot_hash !== repositoryWorkspaceSnapshotHash(current)
    ? [{ code: 'repository_snapshot_stale', repository_workspace_id: repository.repository_workspace_id }]
    : [];
}

export function executionInputHash(context) {
  return hashString(
    JSON.stringify({
      task: context.task,
      contract: context.contract,
      dependency_graph: context.dependency_graph,
      inputs: hashableInputs(context.inputs),
      repository_snapshot: hashableRepositorySnapshot(context.repository_snapshot),
      workstream_digest: context.workstream_digest,
      project_brief: context.project_brief,
      project_decisions: context.project_decisions
    })
  );
}

function hashableInputs(inputs) {
  return (inputs || []).map((input) =>
    input?.repository_snapshot
      ? { ...input, repository_snapshot: hashableRepositorySnapshot(input.repository_snapshot) }
      : input
  );
}

function hashableRepositorySnapshot(repository) {
  if (!repository) return repository;
  const snapshot = { ...repository };
  delete snapshot.managed_path;
  return snapshot;
}

function resolveInputSlot(state, scope, slot, errors) {
  const base = {
    key: slot.key,
    kind: slot.kind,
    required: slot.required !== false,
    source: slot.source,
    selector: slot.selector ?? null,
    ref_id: slot.ref_id ?? null,
    version_id: slot.version_id ?? null,
    consumption_policy: ['must_use', 'must_acknowledge', 'available'].includes(slot.consumption_policy)
      ? slot.consumption_policy
      : null,
    application_policy: applicationPolicy(slot),
    purpose: clean(slot.purpose, 1000) || null,
    target_output_keys: normalizeTargetOutputKeys(slot.target_output_keys, scope.contract),
    coverage_policy: slot.coverage_policy === 'any' ? 'any' : 'all'
  };
  if (slot.source === 'brief') {
    const brief = (state.project_briefs || [])
      .filter((item) => item.project_id === scope.project.id && item.status !== 'superseded')
      .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
    return brief ? { ...base, context: briefSnapshot(brief) } : missing(errors, slot, 'project_brief_missing');
  }
  if (slot.source === 'dependency') return resolveDependencyInput(state, scope, slot, base, errors);
  if (slot.source === 'workstream_dependency')
    return resolveWorkstreamDependencyInput(state, scope, slot, base, errors);
  if (slot.source === 'repository_workspace') return resolveRepositoryInput(state, scope, slot, base, errors);
  if (['asset', 'asset_version'].includes(slot.source) || slot.kind === 'asset_version')
    return resolveAssetInput(state, scope, slot, base, errors);
  if (slot.source === 'decision') {
    const decision = state.decisions.find(
      (item) => item.id === slot.ref_id && item.project_id === scope.project.id && item.status !== 'superseded'
    );
    return decision
      ? { ...base, context: decisionSnapshot(decision) }
      : missing(errors, slot, 'decision_input_missing');
  }
  if (slot.value != null || slot.source === 'inline' || (slot.source === 'explicit' && slot.kind === 'context'))
    return { ...base, context: slot.value ?? null };
  return slot.required === false ? null : missing(errors, slot, 'input_source_unresolved');
}

function resolveDependencyInput(state, scope, slot, base, errors) {
  const dependencies = dependencyIds(scope.task),
    dependencyId = slot.ref_id || dependencies[0];
  if (!dependencyId || !dependencies.includes(dependencyId))
    return missing(errors, slot, 'dependency_input_scope_invalid');
  const dependency = state.workflow_nodes.find(
    (item) => item.id === dependencyId && item.parent_node_id === scope.task.parent_node_id
  );
  const dependencyExecution = scope.taskExecution
    ? currentExecutionForTask(state, scope.taskExecution.workflow_execution_id, dependencyId)
    : null;
  if (
    !dependency ||
    (dependencyExecution ? dependencyExecution.status !== 'completed' : dependency.status !== 'completed') ||
    dependency.input_superseded
  )
    return missing(errors, slot, 'dependency_output_not_accepted', { dependency_id: dependencyId });
  const submission = state.submissions
    .filter((item) => item.node_id === dependencyId && item.status === 'accepted')
    .sort(byNewest)[0];
  const sourceBindings = dependencyExecution?.output_bindings?.length
      ? dependencyExecution.output_bindings
      : submission?.output_bindings || [],
    selectedBindings = selectTaskOutputBindings(state, dependency, dependencyExecution, slot.selector, sourceBindings);
  let bindings = validBindings(state, scope.project.id, selectedBindings, Boolean(scope.taskExecution));
  if (!bindings.length && !scope.strict) bindings = confirmedNodeAssets(state, scope.project.id, dependencyId);
  if (scope.taskExecution && bindings.length !== uniqueBindingCount(selectedBindings))
    return missing(errors, slot, 'dependency_output_binding_invalid', { dependency_id: dependencyId });
  if (!bindings.length) {
    const legacy =
      scope.strict && (!slot.selector || slot.selector === 'required_outputs')
        ? legacyAcceptedDependencySnapshot(state, dependencyId)
        : null;
    if (legacy)
      return {
        ...base,
        ref_id: dependencyId,
        representation: 'legacy_accepted_dependency',
        legacy_compatibility: true,
        legacy_accepted_dependency: legacy
      };
    return missing(errors, slot, 'dependency_output_binding_missing', { dependency_id: dependencyId });
  }
  return {
    ...base,
    ref_id: dependencyId,
    asset_versions: bindings,
    resolved_from: {
      kind: 'task_execution_outputs',
      workflow_execution_id: dependencyExecution?.workflow_execution_id || null,
      task_id: dependency.id,
      task_title: dependency.title,
      task_execution_id: dependencyExecution?.id || null,
      submission_id: dependencyExecution ? null : submission?.id || null,
      contract_id: dependencyExecution?.contract_id || dependency.current_contract_id || null,
      selector: slot.selector || 'required_outputs',
      selected_output_keys: bindings.map((item) => item.output_key).filter(Boolean),
      attestation_ids: selectedBindings.map((item) => item.attestation_id).filter(Boolean)
    }
  };
}

function resolveWorkstreamDependencyInput(state, scope, slot, base, errors) {
  const parentWorkstream = state.workflow_nodes.find(
    (item) =>
      item.id === scope.task.parent_node_id && item.role === 'workstream' && item.workflow_id === scope.workflow.id
  );
  if (!parentWorkstream || !dependencyIds(parentWorkstream).includes(slot.ref_id))
    return missing(errors, slot, 'workstream_dependency_input_scope_invalid', {
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
    return missing(errors, slot, code, detail);
  }
  return {
    ...base,
    ref_id: handoff.workstream.id,
    version_id: handoff.asset_versions.length === 1 ? handoff.asset_versions[0].version_id : null,
    asset_versions: handoff.asset_versions,
    resolved_from: handoff.resolved_from
  };
}

export function inspectWorkstreamDependencyHandoff(
  state,
  {
    projectId,
    workflowId,
    workflowExecutionId = null,
    workstreamId,
    selector = 'required_outputs',
    strict = true,
    receiptOnly = false
  }
) {
  const workstream = state.workflow_nodes.find(
    (item) => item.id === workstreamId && item.role === 'workstream' && item.workflow_id === workflowId
  );
  if (!workstream)
    return handoffNotReady('workstream_dependency_scope_invalid', { dependency_workstream_id: workstreamId || null });
  const asset = state.assets
    .filter(
      (item) =>
        item.node_id === workstream.id &&
        item.project_id === projectId &&
        item.asset_type === 'WorkstreamOutcomeAsset' &&
        item.status === 'confirmed' &&
        (!workflowExecutionId || item.provenance_workflow_execution_id === workflowExecutionId)
    )
    .sort(byNewest)[0];
  const version = state.asset_versions.find(
      (item) =>
        item.id === asset?.current_version_id &&
        item.asset_id === asset?.id &&
        (!strict || (item.verification_status === 'verified' && item.immutable === true))
    ),
    attestation = state.asset_attestations.find(
      (item) =>
        item.asset_version_id === version?.id &&
        item.decision === 'accepted' &&
        (!strict || item.attestor_type === 'trusted_verifier') &&
        (!workflowExecutionId || item.evidence?.workflow_execution_id === workflowExecutionId)
    );
  if (!asset || !version || (strict && !attestation))
    return handoffNotReady('workstream_dependency_output_missing', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId
    });
  if (!receiptOnly && selector === 'workstream_outcome')
    return handoffNotReady('workstream_outcome_not_consumable', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId
    });
  const declaredBindings =
    attestation?.evidence?.handoff_output_bindings || attestation?.evidence?.terminal_output_bindings || [];
  const selectedBindings = receiptOnly
    ? []
    : selector === 'required_outputs'
      ? declaredBindings.filter((item) => item.required !== false)
      : declaredBindings.filter((item) => item.key === selector);
  if (!receiptOnly && !selectedBindings.length && (strict || selector !== 'required_outputs'))
    return handoffNotReady('workstream_dependency_binding_missing', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId,
      selector
    });
  if (!receiptOnly && selector !== 'required_outputs' && selectedBindings.length > 1)
    return handoffNotReady('workstream_dependency_selector_ambiguous', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId,
      selector,
      producer_task_ids: [...new Set(selectedBindings.map((item) => item.producer_task_id).filter(Boolean))]
    });
  const selectedVersions = validBindings(state, projectId, selectedBindings, strict);
  if (strict && selectedVersions.length !== uniqueBindingCount(selectedBindings))
    return handoffNotReady('workstream_dependency_binding_invalid', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId,
      selector
    });
  const receipt = assetVersionSnapshot(asset, version, 'workstream_outcome'),
    selectedOutputs = selectedVersions.map((item) => ({
      output_key: item.output_key,
      asset_id: item.asset_id,
      version_id: item.version_id,
      asset_type: item.asset_type,
      producer_task_id: item.producer_task_id || null,
      producer_task_title:
        state.workflow_nodes.find((node) => node.id === item.producer_task_id)?.title || item.producer_task_id || null,
      producer_task_execution_id: item.producer_task_execution_id || null
    }));
  return {
    ready: true,
    workstream,
    asset,
    version,
    attestation,
    receipt,
    asset_versions: receiptOnly ? [] : uniqueAssets(selectedVersions),
    resolved_from: {
      kind: 'workstream_outcome',
      workflow_execution_id: asset.provenance_workflow_execution_id || workflowExecutionId || null,
      workstream_id: workstream.id,
      workstream_title: workstream.title,
      outcome_asset_id: asset.id,
      outcome_version_id: version.id,
      outcome_attestation_id: attestation?.id || null,
      selector,
      selected_output_keys: selectedOutputs.map((item) => item.output_key).filter(Boolean),
      selected_outputs: selectedOutputs
    }
  };
}

export function selectTaskOutputBindings(state, task, execution, selector, bindings = null) {
  const source = bindings || execution?.output_bindings || [],
    contract = state.node_contracts.find((item) => item.id === (execution?.contract_id || task?.current_contract_id));
  if (selector && selector !== 'required_outputs') return source.filter((item) => item.key === selector);
  if (!contract) return source;
  const requiredKeys = new Set(
    (contract.expected_outputs || []).filter((item) => item.required !== false).map((item) => item.key)
  );
  return source.filter((item) => requiredKeys.has(item.key));
}

function legacyAcceptedDependencySnapshot(state, dependencyId) {
  const dependency = state.workflow_nodes.find(
    (item) =>
      item.id === dependencyId &&
      item.role === 'task' &&
      item.status === 'completed' &&
      item.review?.decision === 'approve'
  );
  if (!dependency) return null;
  const submission = state.submissions
    .filter(
      (item) => item.node_id === dependency.id && item.status === 'accepted' && !(item.output_bindings || []).length
    )
    .sort(byNewest)[0];
  const delivery = state.deliveries
    .filter(
      (item) =>
        item.task_id === dependency.id &&
        item.status === 'completed' &&
        (item.commit_sha || item.result_json?.commit_sha)
    )
    .sort(byNewest)[0];
  if (!submission || !delivery) return null;
  const snapshot = {
    schema_version: 'aiws.legacy_accepted_dependency.v1',
    dependency_id: dependency.id,
    execution_revision: Number(dependency.execution_revision || 1),
    reviewed_at: dependency.reviewed_at || submission.reviewed_at || null,
    submission: {
      id: submission.id,
      title: submission.title || '',
      summary: submission.summary || '',
      evidence_refs: [...(submission.evidence_refs || [])],
      reviewed_at: submission.reviewed_at || null
    },
    delivery: {
      id: delivery.id,
      commit_sha: delivery.commit_sha || delivery.result_json?.commit_sha || null,
      pr_url: delivery.pr_url || delivery.result_json?.pr_url || null,
      pr_state: delivery.pr_state || delivery.result_json?.pr_state || null,
      completed_at: delivery.completed_at || null,
      test_results: (delivery.test_results || delivery.result_json?.test_results || []).map((item) => ({
        command: item.command || item.name || '',
        status: item.status || '',
        exit_code: item.exit_code ?? null
      }))
    }
  };
  snapshot.snapshot_hash = hashString(JSON.stringify(snapshot));
  return snapshot;
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
  if (
    !asset ||
    !version ||
    version.asset_id !== asset.id ||
    asset.status !== 'confirmed' ||
    asset.current_version_id !== version.id ||
    (scope.taskExecution && version.verification_status !== 'verified')
  )
    return missing(errors, slot, 'asset_version_not_confirmed');
  return { ...base, ref_id: asset.id, version_id: version.id, asset_versions: [assetVersionSnapshot(asset, version)] };
}

function resolveRepositoryInput(state, scope, slot, base, errors) {
  if (scope.repositoryLine) {
    const line = scope.repositoryLine;
    if (line.project_id !== scope.project.id || line.status !== 'active' || !line.head_sha)
      return missing(errors, slot, 'repository_line_not_ready', { repository_line_id: line.id });
    return {
      ...base,
      ref_id: line.id,
      repository_snapshot: {
        repository_line_id: line.id,
        connection_id: line.connection_id,
        ref: line.branch,
        fixed_sha: line.head_sha,
        current_sha: line.head_sha,
        mode: scope.task?.task_kind === 'test' ? 'read_only' : 'read_write',
        managed_path: line.checkout_path,
        snapshot_hash: hashString(
          JSON.stringify({ id: line.id, branch: line.branch, head_sha: line.head_sha, base_sha: line.base_sha })
        )
      }
    };
  }
  const workspaceId = slot.ref_id || scope.repositoryWorkspaceId || scope.project.default_repository_workspace_id;
  const workspace = state.repository_workspaces.find(
    (item) => item.id === workspaceId && item.project_id === scope.project.id && item.status === 'active'
  );
  if (!workspace) return scope.strict ? missing(errors, slot, 'repository_workspace_missing') : null;
  if (workspace.stale || workspace.sync_status !== 'ready')
    return missing(errors, slot, 'repository_workspace_stale', { repository_workspace_id: workspace.id });
  return {
    ...base,
    ref_id: workspace.id,
    repository_snapshot: {
      repository_workspace_id: workspace.id,
      connection_id: workspace.connection_id,
      ref: workspace.ref,
      fixed_sha: workspace.fixed_sha,
      current_sha: workspace.current_sha,
      mode: workspace.mode,
      scope: structuredClone(workspace.scope),
      managed_path: workspace.managed_path,
      snapshot_hash: repositoryWorkspaceSnapshotHash(workspace)
    }
  };
}

function validBindings(state, projectId, bindings, strict = false) {
  return uniqueAssets(
    (bindings || [])
      .map((item) => {
        const asset = state.assets.find(
            (entry) =>
              entry.id === item.asset_id &&
              entry.project_id === projectId &&
              entry.status === 'confirmed' &&
              entry.current_version_id === item.version_id
          ),
          version = state.asset_versions.find(
            (entry) =>
              entry.id === item.version_id &&
              entry.asset_id === asset?.id &&
              (!strict || (entry.verification_status === 'verified' && entry.immutable === true))
          );
        return asset && version ? assetVersionSnapshot(asset, version, item.key, item) : null;
      })
      .filter(Boolean)
  );
}
function confirmedNodeAssets(state, projectId, nodeId) {
  return state.assets
    .filter((item) => item.project_id === projectId && item.node_id === nodeId && item.status === 'confirmed')
    .map((asset) => {
      const version = state.asset_versions.find((item) => item.id === asset.current_version_id);
      return version ? assetVersionSnapshot(asset, version, asset.output_key || version.output_key || null) : null;
    })
    .filter(Boolean);
}

function runtimeContextSourceRefs(snapshot) {
  const refs = [];
  for (const input of snapshot.inputs || []) {
    if (input.ref_id && ['dependency', 'workstream_dependency'].includes(input.source))
      refs.push({ collection: 'workflow_nodes', id: input.ref_id });
    if (input.context?.id && input.source === 'brief')
      refs.push({ collection: 'project_briefs', id: input.context.id });
    if (input.context?.id && input.source === 'decision') refs.push({ collection: 'decisions', id: input.context.id });
    for (const binding of input.asset_versions || []) {
      refs.push({ collection: 'assets', id: binding.asset_id });
      refs.push({ collection: 'asset_versions', id: binding.version_id });
    }
  }
  if (snapshot.workstream_digest?.id) refs.push({ collection: 'digests', id: snapshot.workstream_digest.id });
  return refs;
}

function requiredContextSourceRefs(snapshot) {
  const refs = new Set();
  for (const input of snapshot.inputs || []) {
    if (input.required === false || !input.context?.id) continue;
    if (input.source === 'brief') refs.add(`project_briefs:${input.context.id}`);
    if (input.source === 'decision') refs.add(`decisions:${input.context.id}`);
  }
  if (snapshot.workstream_digest?.id) refs.add(`digests:${snapshot.workstream_digest.id}`);
  return refs;
}

function uniqueBindingCount(bindings) {
  return new Set((bindings || []).map((item) => `${item.asset_id}:${item.version_id}`)).size;
}

function handoffNotReady(code, detail = {}) {
  return { ready: false, reason: { code, ...detail } };
}

function assetVersionSnapshot(asset, version, outputKey = null, origin = null) {
  return {
    output_key: outputKey,
    asset_id: asset.id,
    version_id: version.id,
    asset_type: asset.asset_type,
    repository_sha: version.repository_sha || asset.repository_sha || null,
    title: version.title,
    summary: version.summary,
    ...(version.verification_status === 'verified'
      ? {
          payload_kind: version.payload_kind,
          media_type: version.media_type,
          content_sha256: version.content_sha256,
          size_bytes: version.size_bytes,
          blob_refs: structuredClone(version.blob_refs || []),
          manifest: structuredClone(version.manifest || {})
        }
      : { body: version.body }),
    evidence_refs: version.evidence_refs || [],
    verification_status: version.verification_status || 'legacy_unverified',
    handoff_manifest: version.provenance?.handoff_manifest
      ? structuredClone(version.provenance.handoff_manifest)
      : null,
    ...(origin?.producer_task_id
      ? {
          producer_task_id: origin.producer_task_id,
          producer_task_execution_id: origin.producer_task_execution_id || null
        }
      : {})
  };
}
function validateRepositoryVersionBinding(inputs, repository, errors) {
  const versions = inputs
    .flatMap((item) => item.asset_versions || [])
    .filter((item) => /RepositoryVersionAsset/i.test(item.asset_type));
  const hashes = [...new Set(versions.map((item) => item.repository_sha).filter(Boolean))];
  if (!versions.length) return;
  if (versions.some((item) => !item.repository_sha) || hashes.length !== 1)
    errors.push({ code: 'repository_version_sha_invalid', version_ids: versions.map((item) => item.version_id) });
  else if (!repository || repository.fixed_sha !== hashes[0])
    errors.push({
      code: 'repository_snapshot_version_mismatch',
      expected_sha: hashes[0],
      actual_sha: repository?.fixed_sha || null
    });
}
function legacyRepositorySnapshot(project, strict, errors) {
  if (strict || !project.repo_path) return null;
  return {
    repository_workspace_id: null,
    legacy: true,
    managed_path: project.repo_path,
    ref: null,
    fixed_sha: project.source_hash || null,
    snapshot_hash: hashString(
      JSON.stringify({ project_id: project.id, repo_path: project.repo_path, source_hash: project.source_hash || null })
    )
  };
}
function repositoryLineSnapshot(line, task) {
  return {
    repository_line_id: line.id,
    connection_id: line.connection_id,
    ref: line.branch,
    fixed_sha: line.head_sha,
    current_sha: line.head_sha,
    mode: task?.task_kind === 'test' ? 'read_only' : 'read_write',
    managed_path: line.checkout_path,
    snapshot_hash: hashString(
      JSON.stringify({ id: line.id, branch: line.branch, head_sha: line.head_sha, base_sha: line.base_sha })
    )
  };
}
function dependencySnapshot(state, task, workflowExecutionId = null) {
  return dependencyIds(task).map((id) => {
    const node = state.workflow_nodes.find((item) => item.id === id),
      execution = workflowExecutionId ? currentExecutionForTask(state, workflowExecutionId, id) : null;
    return {
      id,
      status: execution?.status || node?.status || 'missing',
      execution_revision: Number(node?.execution_revision || 1),
      task_execution_id: execution?.id || null,
      latest_submission_id: node?.latest_submission_id || null
    };
  });
}
function dependencyIds(task) {
  return [
    ...new Set(
      (task.dependencies || []).map((item) => (typeof item === 'string' ? item : item.node_id)).filter(Boolean)
    )
  ];
}
function taskSnapshot(task) {
  return {
    id: task.id,
    workflow_id: task.workflow_id,
    parent_node_id: task.parent_node_id || null,
    title: task.title,
    goal: task.goal,
    task_kind: task.task_kind,
    execution_mode: task.execution_mode,
    capability_tags: task.capability_tags || [],
    acceptance_criteria: task.acceptance_criteria || [],
    execution_revision: Number(task.execution_revision || 1)
  };
}
function briefSnapshot(brief) {
  const snapshot = {
    id: brief.id,
    version: brief.version,
    revision: brief.revision,
    content: structuredClone(brief.content)
  };
  return { ...snapshot, content_sha256: hashString(JSON.stringify(snapshot)) };
}
function digestSnapshot(digest) {
  const snapshot = {
    id: digest.id,
    version: digest.version,
    summary: digest.summary,
    body: digest.body,
    evidence_refs: digest.evidence_refs || []
  };
  return { ...snapshot, content_sha256: hashString(JSON.stringify(snapshot)) };
}
function decisionSnapshot(item) {
  const snapshot = {
    id: item.id,
    title: item.title,
    summary: item.summary,
    rationale: item.rationale,
    evidence_refs: item.evidence_refs || []
  };
  return { ...snapshot, content_sha256: hashString(JSON.stringify(snapshot)) };
}
function currentExecutionForTask(state, workflowExecutionId, taskId) {
  return (
    state.task_executions
      .filter((item) => item.workflow_execution_id === workflowExecutionId && item.task_id === taskId)
      .sort((a, b) => Number(b.attempt) - Number(a.attempt))[0] || null
  );
}
function uniqueAssets(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.asset_id}:${item.version_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function inputEffectObligations(inputs, contract) {
  return (inputs || []).map((input) => ({
    input_key: input.key,
    source: input.source,
    required: input.required !== false,
    application_policy: input.application_policy,
    purpose: input.purpose,
    target_output_keys: input.target_output_keys,
    coverage_policy: input.coverage_policy,
    version_ids: (input.asset_versions || []).map((item) => item.version_id).filter(Boolean)
  }));
}
function normalizeTargetOutputKeys(values, contract) {
  const declared = [
    ...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 120)).filter(Boolean))
  ];
  if (declared.length) return declared.sort();
  return [...new Set((contract?.expected_outputs || []).map((item) => clean(item?.key, 120)).filter(Boolean))].sort();
}
function missing(errors, slot, code, detail = {}) {
  errors.push({ code, slot_key: slot.key, ...detail });
  return null;
}
function notReady(reasons) {
  return new HttpError(409, { error: 'task_context_not_ready', reasons });
}
function byNewest(a, b) {
  return String(b.reviewed_at || b.created_at || '').localeCompare(String(a.reviewed_at || a.created_at || ''));
}
function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
