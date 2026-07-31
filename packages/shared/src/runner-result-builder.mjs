import { RunnerStatus } from './enums.mjs';
import { normalizedDispositionList, normalizedIdList } from './runner-context-utils.mjs';
import { normalizedEffectList } from './task-effects.mjs';
import { id, slugify } from './utils.mjs';

const RESULT_DEFAULTS = Object.freeze({
  changedFiles: [],
  raw: '',
  status: RunnerStatus.Succeeded,
  consumedInputVersions: null,
  consumedContextDocumentVersions: null,
  inputDispositions: [],
  contextDispositions: [],
  inputEffects: [],
  contextEffects: [],
  consumptionPlan: null,
  syntheticFallback: false
});

export function generateBranchName(nodeTitle, runId) {
  const title =
    slugify(nodeTitle)
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node';
  const suffix =
    String(runId || id('run'))
      .slice(-8)
      .replace(/[^a-zA-Z0-9_-]+/g, '')
      .toLowerCase() || 'run';
  return `aiws/${title}-${suffix}`;
}

export function generatePrBody({ project, node, run, diff, assets = [], tests = [] }) {
  return [
    '## AIWS NodeRun',
    `- Project: ${project?.title || ''}`,
    `- Goal: ${project?.goal || ''}`,
    `- Node: ${node?.title || ''}`,
    `- NodeRun: ${run?.id || ''}`,
    '',
    '## Summary',
    prSummary(diff, run),
    '',
    '## Changed Files',
    ...prChangedFiles(diff, run),
    '',
    '## Tests',
    ...prTests(tests, run),
    '',
    '## Assets / Trace',
    ...assets.map((asset) => `- ${asset.title}: ${asset.summary}`),
    '',
    '> GitHub 未绑定时，此内容作为 PR 草稿保存。'
  ].join('\n');
}

export function buildNodeRunResult(options) {
  const scope = normalizeResultOptions(options);
  const execution = scope.contextPack?.content_json?.task_execution_context;
  const nodeTitle = scope.contextPack?.content_json?.workflow_node?.title || '节点任务';
  if (['aiws.task_execution_context.v4', 'aiws.task_execution_context.v5'].includes(execution?.schema_version))
    return buildEffectAwareResult(scope, execution, nodeTitle);
  if (execution?.schema_version === 'aiws.task_execution_context.v3')
    return buildSlotAwareResult(scope, execution, nodeTitle);
  return buildLegacyNodeRunResult(scope, nodeTitle);
}

function normalizeResultOptions(options) {
  const normalized = { ...RESULT_DEFAULTS };
  for (const [key, value] of Object.entries(options || {})) if (value !== undefined) normalized[key] = value;
  return normalized;
}

function prSummary(diff, run) {
  return diff?.summary || run?.summary || '本 PR 由 AI Workspace System 生成草稿，需要人工 Review。';
}

function prChangedFiles(diff, run) {
  return (diff?.changed_files || run?.changed_files || []).map(
    (file) => `- ${typeof file === 'string' ? file : file.path || file.file}`
  );
}

function prTests(tests, run) {
  const values = tests.length ? tests : run?.test_results || [];
  return values.map((test) => `- ${test.name || 'test'}: ${test.status || 'unknown'}`);
}

function buildEffectAwareResult(scope, execution, nodeTitle) {
  const outputs = (execution.contract?.expected_outputs || []).map((slot) => effectAwareOutput(scope, slot, nodeTitle));
  const plannedInputEffects = Object.values(scope.consumptionPlan || {}).flatMap((item) => item?.input_effects || []);
  const plannedContextEffects = Object.values(scope.consumptionPlan || {}).flatMap(
    (item) => item?.context_effects || []
  );
  return {
    schema_version:
      execution.schema_version === 'aiws.task_execution_context.v5'
        ? 'aiws.task_runner_result.v4'
        : 'aiws.task_runner_result.v3',
    status: scope.status,
    summary: runnerSummary(nodeTitle, scope.status, scope.raw),
    input_effects: normalizedEffectList([...scope.inputEffects, ...plannedInputEffects], 'input_key'),
    context_effects: normalizedEffectList([...scope.contextEffects, ...plannedContextEffects], 'document_version_id'),
    outputs,
    synthetic_fallback: scope.syntheticFallback === true,
    warnings: scope.syntheticFallback ? ['synthetic fallback result; no effect is inferred from availability'] : []
  };
}

function effectAwareOutput(scope, slot, nodeTitle) {
  return {
    output_key: slot.key,
    asset_type: slot.asset_type,
    title: `${nodeTitle} ${slot.key}`,
    summary: 'Runner candidate output; server verification remains authoritative.',
    payload: textOutputPayload(scope.raw, nodeTitle),
    evidence_refs: [`node_run:${scope.run.id}`, `context_pack:${scope.contextPack?.id}`],
    purpose: String(slot.purpose || `Deliver ${slot.key}.`),
    consumer_hint: String(slot.consumer_hint || ''),
    unresolved_questions: [],
    limitations: []
  };
}

function buildSlotAwareResult(scope, execution, nodeTitle) {
  const explicitInput = normalizedIdList(scope.consumedInputVersions);
  const explicitContext = normalizedIdList(scope.consumedContextDocumentVersions);
  const outputs = (execution.contract?.expected_outputs || []).map((slot, index) =>
    slotAwareOutput(scope, slot, index, nodeTitle, explicitInput, explicitContext)
  );
  return {
    schema_version: 'aiws.task_runner_result.v2',
    status: scope.status,
    summary: runnerSummary(nodeTitle, scope.status, scope.raw),
    consumed_input_versions: normalizedIdList(outputs.flatMap((item) => item.consumed_input_versions)),
    consumed_context_document_versions: normalizedIdList(
      outputs.flatMap((item) => item.consumed_context_document_versions)
    ),
    input_dispositions: normalizedDispositionList(scope.inputDispositions, 'version_id'),
    context_dispositions: normalizedDispositionList(scope.contextDispositions, 'document_version_id'),
    outputs,
    synthetic_fallback: scope.syntheticFallback === true,
    warnings: scope.syntheticFallback ? ['synthetic fallback result; no usage is inferred from availability'] : []
  };
}

function slotAwareOutput(scope, slot, index, nodeTitle, explicitInput, explicitContext) {
  const plan = scope.consumptionPlan?.[slot.key] || {};
  const consumption = slotConsumption(scope, plan, index, explicitInput, explicitContext);
  return {
    output_key: slot.key,
    asset_type: slot.asset_type,
    title: `${nodeTitle} ${slot.key}`,
    summary: 'Runner candidate output; server verification remains authoritative.',
    payload: textOutputPayload(scope.raw, nodeTitle),
    evidence_refs: [`node_run:${scope.run.id}`, `context_pack:${scope.contextPack?.id}`],
    consumed_input_versions: consumption.inputs,
    consumed_context_document_versions: consumption.context,
    input_dispositions: normalizedDispositionList(plan.input_dispositions || [], 'version_id'),
    context_dispositions: normalizedDispositionList(plan.context_dispositions || [], 'document_version_id'),
    ...slotPlanMetadata(plan, slot)
  };
}

function slotConsumption(scope, plan, index, explicitInput, explicitContext) {
  const defaultInputs = index === 0 && scope.consumedInputVersions !== null ? explicitInput : [];
  const defaultContext = index === 0 && scope.consumedContextDocumentVersions !== null ? explicitContext : [];
  return {
    inputs: normalizedIdList(plan.consumed_input_versions ?? defaultInputs),
    context: normalizedIdList(plan.consumed_context_document_versions ?? defaultContext)
  };
}

function slotPlanMetadata(plan, slot) {
  return {
    purpose: String(plan.purpose || slot.purpose || `Deliver ${slot.key}.`),
    consumer_hint: String(plan.consumer_hint || slot.consumer_hint || ''),
    input_relations: arrayOrEmpty(plan.input_relations),
    unresolved_questions: arrayOrEmpty(plan.unresolved_questions),
    limitations: arrayOrEmpty(plan.limitations)
  };
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function buildLegacyNodeRunResult(scope, nodeTitle) {
  const changed = scope.changedFiles.length > 0;
  return {
    schema_version: 'aiws.node_run_result.v1',
    status: scope.status,
    summary: runnerSummary(nodeTitle, scope.status, scope.raw),
    changed_files: scope.changedFiles,
    asset_candidates: [legacyAssetCandidate(scope, nodeTitle, changed)],
    test_results: [],
    warnings: [],
    next_actions: ['Review asset candidates', 'Generate digest', 'Open Git Review']
  };
}

function legacyAssetCandidate(scope, nodeTitle, changed) {
  return {
    id: id('ac'),
    asset_type: changed ? 'CodeChangeAsset' : 'DecisionAsset',
    title: changed ? `${nodeTitle} 文件变更资产` : `${nodeTitle} 结果资产`,
    summary: changed
      ? `本次运行产生 ${scope.changedFiles.length} 个文件变化，可在 Git Review 中确认。`
      : '本次运行产出可复用结论，需要用户确认后进入资产库。',
    evidence_refs: [`node_run:${scope.run.id}`, `context_pack:${scope.contextPack?.id}`],
    tags: changed ? ['code-change', 'node-run'] : ['decision', 'node-run']
  };
}

function runnerSummary(nodeTitle, status, raw) {
  return `${nodeTitle} 已完成 ${status}。${raw ? `Runner 输出：${raw.slice(0, 220)}` : ''}`;
}

function textOutputPayload(raw, nodeTitle) {
  return {
    payload_kind: 'text',
    media_type: 'text/plain; charset=utf-8',
    content: raw || nodeTitle,
    files: []
  };
}
