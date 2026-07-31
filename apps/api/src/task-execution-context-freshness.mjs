import { hashString } from '../../../packages/shared/index.mjs';
import { repositoryWorkspaceSnapshotHash } from './repository-workspace-service.mjs';
import { verifyContributionRoutes } from './task-handoff.mjs';
import { legacyAcceptedDependencySnapshot } from './task-execution-context-snapshots.mjs';
import { inspectWorkstreamDependencyHandoff } from './task-execution-handoff.mjs';

const VERIFIED_CONTEXT_SCHEMAS = new Set([
  'aiws.task_execution_context.v3',
  'aiws.task_execution_context.v4',
  'aiws.task_execution_context.v5'
]);

export function evaluateTaskExecutionContextFreshness(state, context) {
  const reasons = [];
  for (const input of context?.inputs || []) appendInputFreshnessReasons(state, context, input, reasons);
  reasons.push(...contextDocumentFreshnessReasons(state, context));
  reasons.push(...repositoryFreshnessReasons(state, context));
  return { current: reasons.length === 0, reasons };
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

function appendInputFreshnessReasons(state, context, input, reasons) {
  reasons.push(...inputAssetFreshnessReasons(state, context, input));
  reasons.push(...legacyDependencyFreshnessReasons(state, input));
  reasons.push(...workstreamHandoffFreshnessReasons(state, context, input));
  const routes = verifyContributionRoutes(context.task, input, input.asset_versions || []);
  if (!routes.ok) reasons.push({ code: routes.code, input_key: input.key, contribution_id: routes.contribution_id });
}

function inputAssetFreshnessReasons(state, context, input) {
  const reasons = [];
  for (const binding of input.asset_versions || []) {
    const asset = state.assets.find((item) => item.id === binding.asset_id);
    const version = state.asset_versions.find(
      (item) => item.id === binding.version_id && item.asset_id === binding.asset_id
    );
    if (inputAssetVersionInvalid(asset, version))
      reasons.push(assetFreshnessReason('input_asset_version_invalid', binding));
    if (inputAssetIntegrityInvalid(context, version, binding))
      reasons.push(assetFreshnessReason('input_asset_integrity_invalid', binding));
    if (inputAssetSuperseded(input, asset, binding))
      reasons.push({
        ...assetFreshnessReason('input_asset_version_superseded', binding),
        current_version_id: asset.current_version_id
      });
  }
  return reasons;
}

function inputAssetVersionInvalid(asset, version) {
  return !asset || !version || ['stale', 'disputed', 'superseded', 'rejected'].includes(asset.status);
}

function inputAssetIntegrityInvalid(context, version, binding) {
  if (!VERIFIED_CONTEXT_SCHEMAS.has(context.schema_version)) return false;
  return (
    version?.verification_status !== 'verified' ||
    version?.immutable !== true ||
    version?.content_sha256 !== binding.content_sha256
  );
}

function inputAssetSuperseded(input, asset, binding) {
  return (
    ['dependency', 'workstream_dependency'].includes(input.source) && asset?.current_version_id !== binding.version_id
  );
}

function assetFreshnessReason(code, binding) {
  return { code, asset_id: binding.asset_id, version_id: binding.version_id };
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
  });
  const expectedVersions = (input.asset_versions || []).map((item) => item.version_id).sort();
  const currentVersions = current.ready ? current.asset_versions.map((item) => item.version_id).sort() : [];
  if (!workstreamHandoffChanged(current, input, expectedVersions, currentVersions)) return [];
  return [
    {
      code: 'workstream_handoff_changed',
      dependency_workstream_id: input.resolved_from.workstream_id,
      detail_code: current.ready ? 'handoff_version_changed' : current.reason.code
    }
  ];
}

function workstreamHandoffChanged(current, input, expectedVersions, currentVersions) {
  if (!current.ready) return true;
  if (current.version.id !== input.resolved_from.outcome_version_id) return true;
  if (current.attestation?.id !== input.resolved_from.outcome_attestation_id) return true;
  return JSON.stringify(currentVersions) !== JSON.stringify(expectedVersions);
}

function contextDocumentFreshnessReasons(state, context) {
  const reasons = [];
  const selection = state.context_selections.find((item) => item.id === context?.system_context?.context_selection_id);
  for (const document of context?.system_context?.document_versions || []) {
    const current = currentContextDocument(state, selection, document);
    if (!current.valid) reasons.push(invalidContextDocumentReason(document));
    else if (requiredContextDocumentSuperseded(document, current.node, current.version))
      reasons.push(supersededContextDocumentReason(document, current.node));
  }
  return reasons;
}

function currentContextDocument(state, selection, document) {
  const node = state.context_nodes.find((item) => item.id === document.node_id);
  const version = state.context_document_versions.find(
    (item) => item.id === document.document_version_id && item.node_id === document.node_id
  );
  const included = selection?.included?.find(
    (item) => item.node_id === document.node_id && item.document_version_id === document.document_version_id
  );
  const valid = Boolean(
    selection &&
    node &&
    version &&
    included &&
    version.content_sha256 === document.content_sha256 &&
    included.content_sha256 === document.content_sha256
  );
  return { valid, node, version };
}

function invalidContextDocumentReason(document) {
  return {
    code: 'context_document_version_invalid',
    node_id: document.node_id,
    document_version_id: document.document_version_id
  };
}

function requiredContextDocumentSuperseded(document, node, version) {
  return (
    document.required === true && (node.current_version_id !== version.id || node.source_hash !== version.source_hash)
  );
}

function supersededContextDocumentReason(document, node) {
  return {
    code: 'required_context_document_superseded',
    node_id: document.node_id,
    document_version_id: document.document_version_id,
    current_document_version_id: node.current_version_id || null
  };
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
