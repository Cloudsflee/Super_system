import { AssetStatus } from './enums.mjs';
import { buildMemoryManifest, buildSufficiencyCheck } from './memory.mjs';
import { qualityCheckContextPack } from './context-pack-rendering.mjs';
import { buildRunnerInstruction } from './runner-instruction.mjs';
import { runnerResultSchemaForContext } from './runner-result-schema.mjs';
import { estimateTokens, id, now, pick } from './utils.mjs';

const CONTEXT_PACK_DEFAULTS = Object.freeze({
  workspace: null,
  node: null,
  contract: null,
  purpose: 'node_run',
  receiver_name: 'CodexRunner',
  pinnedRefs: [],
  executionContext: null
});

export function buildContextPack(options) {
  const scope = normalizeContextPackOptions(options);
  const protocol = contextPackProtocol(scope.executionContext);
  const tokenBudget = scope.project.settings?.token_budget || 12000;
  const sufficiency = contextPackSufficiency(scope, tokenBudget);
  const manifest = contextPackMemoryManifest(scope, tokenBudget);
  applyMemoryManifestToSufficiency(sufficiency, manifest, Boolean(scope.executionContext));
  const sources = selectContextPackSources(scope);
  const content = contextPackContent(scope, protocol, sufficiency, manifest, sources);
  return contextPackRecord(scope, protocol, sufficiency, manifest, sources, content);
}

function normalizeContextPackOptions(options) {
  const normalized = { ...CONTEXT_PACK_DEFAULTS };
  for (const [key, value] of Object.entries(options || {})) if (value !== undefined) normalized[key] = value;
  return normalized;
}

function contextPackProtocol(executionContext) {
  const resultSchemaRef = resultSchemaRefForContext(executionContext);
  if (executionContext?.outcome_contract_hash && executionContext?.quality_rubric_hash)
    return { schemaVersion: 'aiws.context_pack.v5', version: 5, resultSchemaRef };
  if (['aiws.task_execution_context.v4', 'aiws.task_execution_context.v5'].includes(executionContext?.schema_version))
    return { schemaVersion: 'aiws.context_pack.v4', version: 4, resultSchemaRef };
  if (executionContext?.schema_version === 'aiws.task_execution_context.v3')
    return { schemaVersion: 'aiws.context_pack.v3', version: 3, resultSchemaRef };
  return executionContext
    ? { schemaVersion: 'aiws.context_pack.v2', version: 2, resultSchemaRef }
    : { schemaVersion: 'aiws.context_pack.v1', version: 1, resultSchemaRef };
}

function resultSchemaRefForContext(context) {
  if (context?.schema_version === 'aiws.task_execution_context.v5') return 'aiws.task_runner_result.v4';
  if (context?.schema_version === 'aiws.task_execution_context.v4') return 'aiws.task_runner_result.v3';
  return context?.schema_version === 'aiws.task_execution_context.v3'
    ? 'aiws.task_runner_result.v2'
    : 'aiws.node_run_result.v1';
}

function contextPackSufficiency(scope, tokenBudget) {
  return buildSufficiencyCheck({
    state: scope.state,
    project: scope.project,
    workspace: scope.workspace,
    node: scope.node,
    contract: scope.contract,
    target_type: scope.purpose,
    tokenBudget
  });
}

function contextPackMemoryManifest(scope, tokenBudget) {
  if (scope.executionContext)
    return executionMemoryManifest(scope.executionContext, scope.project, scope.workspace, scope.node, tokenBudget);
  return buildMemoryManifest({ ...scope, tokenBudget });
}

function applyMemoryManifestToSufficiency(sufficiency, manifest, executionScoped) {
  if (executionScoped)
    Object.assign(sufficiency, {
      status: 'sufficient',
      missing_slots: [],
      conflicts: [],
      stale_refs: [],
      recommended_questions: [],
      recommended_options: []
    });
  sufficiency.included_memory_refs = manifest.included.map((item) => item.ref);
  sufficiency.excluded_memory_refs = manifest.excluded.map((item) => ({ ref: item.ref, reason: item.reason }));
}

function selectContextPackSources({ state, project, workspace, node, contract, executionContext }) {
  const latestDigest = executionContext
    ? executionContext.workstream_digest || null
    : [...state.digests].reverse().find((item) => item.workspace_id === workspace?.id && item.status === 'confirmed') ||
      null;
  const assetRefs = new Set(
    executionContext?.inputs?.flatMap((item) => item.asset_versions || []).map((item) => item.asset_id) || []
  );
  const confirmedAssets = state.assets.filter(
    (item) =>
      item.project_id === project.id &&
      item.status === AssetStatus.Confirmed &&
      (!executionContext || assetRefs.has(item.id))
  );
  const decisions =
    executionContext?.project_decisions ||
    state.decisions.filter((item) => item.project_id === project.id && item.status !== 'superseded');
  const submissions = executionContext
    ? []
    : (state.submissions || [])
        .filter((item) => item.project_id === project.id && (!node || item.node_id !== node.id))
        .slice(-8);
  const availableTools = (state.tools || []).filter(
    (item) =>
      item.enabled !== false &&
      (contract.allowed_tools || []).some(
        (tool) => tool === item.id || tool === item.name || (item.capabilities || []).includes(tool)
      )
  );
  return { latestDigest, confirmedAssets, decisions, submissions, availableTools };
}

function contextPackContent(scope, protocol, sufficiency, manifest, sources) {
  const { project, workspace, node, contract, executionContext, purpose } = scope;
  return {
    schema_version: protocol.schemaVersion,
    project: pick(project, ['id', 'title', 'goal', 'role', 'background', 'workspace_root', 'repo_path']),
    workspace: workspace ? pick(workspace, ['id', 'title', 'goal', 'type', 'status', 'current_digest_id']) : null,
    workflow_node: node ? pick(node, ['id', 'type', 'title', 'goal', 'status', 'order_index']) : null,
    node_contract: contract,
    task_execution_context: executionContext,
    purpose,
    runner_instruction: buildRunnerInstruction({ project, node, contract, executionContext }),
    latest_digest: sources.latestDigest
      ? pick(sources.latestDigest, ['id', 'version', 'summary', 'body', 'evidence_refs'])
      : null,
    confirmed_assets: sources.confirmedAssets.map((asset) =>
      pick(asset, ['id', 'asset_type', 'title', 'summary', 'evidence_refs', 'tags', 'created_at'])
    ),
    decisions: sources.decisions.map((decision) =>
      pick(decision, ['id', 'title', 'summary', 'rationale', 'evidence_refs'])
    ),
    submissions: sources.submissions.map(submissionSnapshot),
    available_tools: sources.availableTools.map(toolSnapshot),
    git: contextPackGit(scope),
    return_schema_ref: protocol.resultSchemaRef,
    result_schema: runnerResultSchemaForContext(executionContext),
    sufficiency_check: sufficiency,
    memory_manifest: manifest
  };
}

function submissionSnapshot(submission) {
  return pick(submission, [
    'id',
    'title',
    'summary',
    'changes',
    'evidence_refs',
    'risks',
    'from_session_id',
    'to_session_id',
    'created_at'
  ]);
}

function toolSnapshot(tool) {
  return {
    id: tool.id,
    name: tool.name,
    type: tool.type,
    health_status: tool.health_status,
    permissions: tool.permissions || {},
    usage_boundary: tool.usage_boundary || '仅在 Node Contract 允许范围内使用'
  };
}

function contextPackGit(scope) {
  return {
    repo_path:
      scope.executionContext?.repository_snapshot?.managed_path ||
      scope.project.repo_path ||
      scope.project.workspace_root ||
      '',
    repository_snapshot: scope.executionContext?.repository_snapshot || null,
    branch_strategy: 'aiws/{node_slug}-{short_run_id}',
    dirty_policy: '执行上下文固定后不得静默切换分支或覆盖快照。'
  };
}

function contextPackRecord(scope, protocol, sufficiency, manifest, sources, content) {
  return {
    id: id('ctx'),
    source_workspace_id: scope.workspace?.id || scope.project.current_workspace_id,
    receiver_type: 'ai_runner',
    receiver_name: scope.receiver_name,
    purpose: scope.purpose,
    version: protocol.version,
    status: 'draft',
    content_json: content,
    content_file_ref_id: null,
    markdown_file_ref_id: null,
    included_asset_versions: includedAssetVersions(scope.executionContext, sources.confirmedAssets),
    token_estimate: estimateTokens(JSON.stringify(content)),
    quality_check: qualityCheckContextPack(content),
    memory_manifest: manifest,
    sufficiency_check_id: sufficiency.id,
    created_by: 'system',
    consumed_at: null,
    created_at: now(),
    updated_at: now(),
    _sufficiency_check: sufficiency
  };
}

function includedAssetVersions(executionContext, confirmedAssets) {
  return executionContext?.inputs
    ? executionContext.inputs
        .flatMap((item) => item.asset_versions || [])
        .map((item) => ({ asset_id: item.asset_id, version_id: item.version_id }))
    : confirmedAssets.map((asset) => ({ asset_id: asset.id, version_id: asset.current_version_id || null }));
}

function executionMemoryManifest(context, project, workspace, node, tokenBudget) {
  const included = executionInputMemoryItems(context);
  if (context.workstream_digest) included.push(digestMemoryItem(context.workstream_digest));
  if (context.project_brief) included.push(briefMemoryItem(context.project_brief, project));
  for (const decision of context.project_decisions || []) included.push(decisionMemoryItem(decision));
  return {
    id: id('mmf'),
    project_id: project.id,
    workspace_id: workspace?.id || project.current_workspace_id,
    node_id: node?.id || null,
    generated_at: now(),
    token_budget: tokenBudget,
    token_estimate: included.reduce((total, item) => total + item.token_estimate, 0),
    included,
    excluded: [],
    warnings: [],
    policy: executionMemoryPolicy()
  };
}

function executionInputMemoryItems(context) {
  const included = [];
  for (const input of context.inputs || [])
    for (const asset of input.asset_versions || [])
      included.push({
        ref: `asset_version:${asset.version_id}`,
        source_type: 'asset_version',
        source_id: asset.version_id,
        title: asset.title || asset.asset_type,
        summary: asset.summary || '',
        reason: executionInputReason(input),
        authority: 'user_confirmed',
        freshness: 'current',
        token_estimate: estimateTokens(`${asset.title || ''}\n${asset.summary || ''}`)
      });
  return included;
}

function digestMemoryItem(digest) {
  return {
    ref: `digest:${digest.id}`,
    source_type: 'digest',
    source_id: digest.id,
    title: `Workstream Digest v${digest.version}`,
    summary: digest.summary,
    reason: '当前 Workstream 摘要',
    authority: 'system_confirmed',
    freshness: 'current',
    token_estimate: estimateTokens(digest.summary || '')
  };
}

function briefMemoryItem(brief, project) {
  return {
    ref: `project_brief:${brief.id}`,
    source_type: 'project_brief',
    source_id: brief.id,
    title: 'Project Brief',
    summary: brief.content?.summary || project.goal,
    reason: '当前 Project Brief',
    authority: 'user_confirmed',
    freshness: 'current',
    token_estimate: estimateTokens(JSON.stringify(brief.content || {}))
  };
}

function decisionMemoryItem(decision) {
  return {
    ref: `decision:${decision.id}`,
    source_type: 'decision',
    source_id: decision.id,
    title: decision.title,
    summary: decision.summary,
    reason: 'Project Decision',
    authority: 'user_confirmed',
    freshness: 'current',
    token_estimate: estimateTokens(`${decision.title}\n${decision.summary}`)
  };
}

function executionMemoryPolicy() {
  return {
    explicit_inputs_only: true,
    sibling_context_included: false,
    authority_order: [
      'Task Execution Context',
      'NodeContract',
      'immutable input Asset versions',
      'Workstream Digest',
      'Project Brief/Decision'
    ],
    rule: '不得自动注入兄弟节点或全 Project 资产。'
  };
}

function executionInputReason(input) {
  if (input.resolved_from?.kind === 'workstream_outcome')
    return `成果节点交付 ${input.resolved_from.workstream_title || input.resolved_from.workstream_id} -> 输入槽 ${input.key}`;
  if (input.resolved_from?.kind === 'task_execution_outputs')
    return `前置任务交付 ${input.resolved_from.task_title || input.resolved_from.task_id} -> 输入槽 ${input.key}`;
  return `显式输入槽 ${input.key}`;
}
