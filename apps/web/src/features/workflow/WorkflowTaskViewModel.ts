import type {
  AssetRecord,
  NodeContract,
  NodeInputSlot,
  NodeOutputSlot,
  ProjectBundle,
  TaskExecutionRecord,
  Workflow,
  WorkflowExecutionSnapshot,
  WorkflowNode
} from '../../api/types';
import { capabilityTagLabel } from '../../components/common/display-labels';

export const WORKFLOW_STAGES = [
  ['research_evidence', '调研取证'],
  ['constraint_analysis', '约束分析'],
  ['solution_decision', '方案决策'],
  ['execution', '实现执行'],
  ['acceptance', '测试验收'],
  ['integration_delivery', '集成交付']
] as const;

const COVERAGE_LABELS: Record<string, string> = {
  features: '特性',
  acceptance_criteria: '验收',
  milestones: '里程碑',
  risks: '风险'
};
const PRIORITY_STATUSES = new Set(['running', 'verifying', 'awaiting_human', 'failed']);
const READY_STATUSES = new Set(['ready', 'queued']);
const CHINESE_TASK_TITLES: Record<string, string> = {
  research_evidence: '梳理并固化任务证据',
  constraint_analysis: '明确任务约束与风险边界',
  solution_decision: '确定可实施方案',
  execution: '实施并固化任务成果',
  acceptance: '验证精确实现与验收证据',
  integration_delivery: '集成并交付已验收成果'
};
const CHINESE_STAGE_REQUIREMENTS: Record<string, string> = {
  research_evidence: '梳理输入材料、来源位置和验证证据，确保结论可追溯。',
  constraint_analysis: '明确约束、风险、失败边界和不可变要求。',
  solution_decision: '基于已确认约束形成可实施、可复核的方案决策。',
  execution: '按已确认方案实施，并将成果绑定到精确版本。',
  acceptance: '针对同一实现版本执行确定性验证并保留验收证据。',
  integration_delivery: '仅集成已验收成果，并保留完整的交付追溯关系。'
};
const CHINESE_CONTEXT_RULES: Array<[RegExp, string]> = [
  [/\bread[- ]only\b|\bno[- ]write\b|write nothing|do not modify|never modify/i, '只读执行'],
  [/\b(?:fixed|exact|same)[ -]?sha\b|repository snapshot|immutable repository/i, '固定 SHA'],
  [/\boffline\b/i, '离线运行'],
  [/\bidempoten\w*\b|\bdeterministic\w*\b|per-date lock/i, '确定性与幂等'],
  [/\bredact\w*\b|\bcredential\w*\b|\bsecret\w*\b/i, '敏感信息脱敏'],
  [/structured output|\bjson\b|\bschema\b/i, '结构化输出'],
  [/fail[- ]closed/i, '失败时闭合'],
  [/\btest\w*\b|\bacceptance\b|\bevidence\b|\baudit\b/i, '测试与验收证据']
];
const CHINESE_WORKSTREAM_TITLES: Array<[RegExp, string]> = [
  [/integrity|tamper|verification|verify/i, '运行完整性审计与交付'],
  [/security|credential|secret/i, '安全审计与交付'],
  [/migration|upgrade/i, '迁移升级成果交付'],
  [/workflow|orchestrat/i, '工作流成果交付'],
  [/release|delivery|increment/i, '可验收成果交付']
];

export type TaskObjectiveValue = {
  raw: string;
  summary: string;
  summaryLanguage?: 'zh-CN' | 'en';
  keyPoints: string[];
  command: string;
  times: string[];
  timezone: string;
  chinese: string;
  english: string;
  fallback: string;
  detail: string;
};
export type TaskMetricValues = { dependencies: number; inputs: number; outputs: number; versions: number };
export type WorkflowTaskDependency = { id: string; title: string; status: string };
export type WorkflowTaskVersion = { key: string; label: string; meta?: string };

export type WorkflowTaskViewModel = {
  id: string;
  task: WorkflowNode;
  displayTitle: string;
  assistBreadcrumb: string[];
  workstream?: WorkflowNode;
  workstreamDisplayTitle?: string;
  execution?: TaskExecutionRecord;
  status: string;
  statusText: string;
  phase: string;
  phaseTags: string[];
  objective: TaskObjectiveValue;
  metrics: TaskMetricValues;
  dependencies: WorkflowTaskDependency[];
  blockers: string[];
  inputs: NodeInputSlot[];
  outputs: NodeOutputSlot[];
  versions: WorkflowTaskVersion[];
  capabilityTags: string[];
  coverage: string[];
  actionLocked: boolean;
  actionLockReason: string;
  detailsId: string;
};

export type WorkflowWorkstreamViewModel = {
  node: WorkflowNode;
  displayTitle: string;
  displayOutcome: string;
  tasks: WorkflowTaskViewModel[];
};
export type WorkflowProcessViewModel = { tasks: WorkflowTaskViewModel[]; workstreams: WorkflowWorkstreamViewModel[] };

export function buildWorkflowProcessViewModel(
  bundle: ProjectBundle,
  workflow: Workflow,
  snapshot?: WorkflowExecutionSnapshot | null
): WorkflowProcessViewModel {
  const preferChinese = projectUsesChinese(bundle.project.title, bundle.project.goal);
  const nodes = bundle.nodes.filter((item) => item.workflow_id === workflow.id);
  const workstreamNodes = nodes.filter((item) => item.role === 'workstream').sort(byOrder);
  const taskNodes = nodes.filter((item) => item.role === 'task');
  const taskById = new Map(taskNodes.map((item) => [item.id, item]));
  const workstreamById = new Map(workstreamNodes.map((item) => [item.id, item]));
  const build = (task: WorkflowNode) =>
    buildTaskViewModel(
      bundle,
      workflow,
      task,
      taskById,
      workstreamById.get(task.parent_node_id || ''),
      latestExecution(snapshot, task.id),
      preferChinese
    );
  const workstreams = workstreamNodes.map((node) => {
    const displayTitle = workstreamDisplayTitle(node, preferChinese);
    return {
      node,
      displayTitle,
      displayOutcome: workstreamDisplayOutcome(node, displayTitle, preferChinese),
      tasks: taskNodes
        .filter((item) => item.parent_node_id === node.id)
        .sort(byOrder)
        .map(build)
    };
  });
  const visibleIds = new Set(workstreams.flatMap((item) => item.tasks.map((task) => task.id)));
  const orphans = taskNodes
    .filter((item) => !visibleIds.has(item.id))
    .sort(byOrder)
    .map(build);
  return { workstreams, tasks: [...workstreams.flatMap((item) => item.tasks), ...orphans] };
}

export function selectDefaultWorkflowTask(tasks: WorkflowTaskViewModel[]) {
  return (
    tasks.find((item) => PRIORITY_STATUSES.has(item.status))?.id ||
    tasks.find((item) => READY_STATUSES.has(item.status))?.id ||
    tasks[0]?.id ||
    null
  );
}

export function normalizeTaskStatus(value?: string | null) {
  if (value === 'draft') return 'pending';
  if (value === 'succeeded') return 'completed';
  if (value === 'needs_review') return 'awaiting_human';
  return value || 'pending';
}

export function workflowStatusLabel(value?: string | null) {
  const labels: Record<string, string> = {
    pending: '等待依赖',
    ready: '已就绪',
    queued: '已排队',
    running: '执行中',
    verifying: '验证中',
    awaiting_human: '等待人工',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
    superseded: '已替代',
    blocked: '已锁定'
  };
  return labels[normalizeTaskStatus(value)] || '其他状态';
}

export function workflowCategoryLabel(value?: string | null) {
  const labels: Record<string, string> = {
    deliverable: '交付成果',
    decision: '关键决策',
    coordination: '协同成果',
    operation: '运营成果'
  };
  return labels[value || ''] || '成果节点';
}

export function workflowPhaseTags(task: WorkflowNode) {
  if (task.capability_tags?.length) return task.capability_tags;
  const inferred: Record<string, string[]> = {
    research: ['research_evidence'],
    analysis: ['constraint_analysis'],
    design: ['solution_decision'],
    code: ['execution'],
    content: ['execution'],
    test: ['acceptance'],
    review: ['acceptance'],
    deploy: ['integration_delivery'],
    integration: ['integration_delivery']
  };
  return inferred[task.task_kind || ''] || ['execution'];
}

export function projectUsesChinese(...values: Array<string | null | undefined>) {
  const text = values.filter(Boolean).join(' ');
  const chineseCharacters = text.match(/[\u3400-\u9fff]/g)?.length || 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length || 0;
  return chineseCharacters >= 2 && (chineseCharacters >= 4 || chineseCharacters >= latinWords);
}

export function taskDisplayTitle(task: WorkflowNode, preferChinese: boolean) {
  if (!preferChinese || hasMeaningfulChinese(task.title)) return task.title;
  const phaseTag = workflowPhaseTags(task).find((item) => CHINESE_TASK_TITLES[item]);
  return CHINESE_TASK_TITLES[phaseTag || 'execution'];
}

export function workstreamDisplayTitle(node: WorkflowNode, preferChinese: boolean) {
  if (!preferChinese || hasMeaningfulChinese(node.title)) return node.title;
  const source = [node.title, node.goal, node.outcome].filter(Boolean).join(' ');
  return CHINESE_WORKSTREAM_TITLES.find(([pattern]) => pattern.test(source))?.[1] || '可验收项目成果';
}

export function primaryTaskObjective(content: TaskObjectiveValue) {
  return content.summary || content.chinese || content.english || content.fallback;
}

function buildTaskViewModel(
  bundle: ProjectBundle,
  workflow: Workflow,
  task: WorkflowNode,
  taskById: Map<string, WorkflowNode>,
  workstream?: WorkflowNode,
  execution?: TaskExecutionRecord,
  preferChinese = false
): WorkflowTaskViewModel {
  const dependencyNodes = dependencyIds(task)
    .map((id) => taskById.get(id))
    .filter(Boolean) as WorkflowNode[];
  const contract = currentContract(
    bundle.contracts.filter((item) => item.node_id === task.id),
    task.current_contract_id
  );
  const inputs = contract?.expected_inputs?.length ? contract.expected_inputs : task.input_slots || [];
  const outputs = contract?.expected_outputs?.length ? contract.expected_outputs : task.output_slots || [];
  const readinessBlockers = execution?.readiness?.reasons?.map(reasonLabel) || [];
  const blockers = readinessBlockers.length
    ? readinessBlockers
    : blockingReasons(bundle, task, dependencyNodes, inputs, preferChinese);
  const status = normalizeTaskStatus(execution?.status || task.status);
  const inputVersions = execution?.context_snapshot?.inputs?.flatMap((item) => item.asset_versions || []) || [];
  const outputVersions = execution?.output_bindings || [];
  const versionCount =
    new Set([...inputVersions.map((item) => item.version_id), ...outputVersions.map((item) => item.version_id)]).size ||
    bundle.assets.filter((item) => item.node_id === task.id && item.current_version_id).length;
  const phaseTags = workflowPhaseTags(task);
  const phaseTag = phaseTags.find((item) => WORKFLOW_STAGES.some(([key]) => key === item));
  const displayTitle = taskDisplayTitle(task, preferChinese);
  const objective = parseTaskObjective(task.goal || '', {
    preferChinese,
    displayTitle,
    projectGoal: bundle.project.goal,
    phaseTag
  });
  const actionLocked = taskActionLocked(status, blockers);
  return {
    id: task.id,
    task,
    displayTitle,
    assistBreadcrumb: [
      bundle.project.title,
      workflow.title,
      ...(workstream ? [workstreamDisplayTitle(workstream, preferChinese)] : []),
      displayTitle
    ],
    workstream,
    workstreamDisplayTitle: workstream ? workstreamDisplayTitle(workstream, preferChinese) : undefined,
    execution,
    status,
    statusText: workflowStatusLabel(status),
    phase: WORKFLOW_STAGES.find(([key]) => key === phaseTag)?.[1] || '执行任务',
    phaseTags,
    objective,
    metrics: {
      dependencies: dependencyNodes.length,
      inputs: inputs.length,
      outputs: outputs.length,
      versions: versionCount
    },
    dependencies: dependencyNodes.map((item) => ({
      id: item.id,
      title: taskDisplayTitle(item, preferChinese),
      status: normalizeTaskStatus(item.status)
    })),
    blockers,
    inputs,
    outputs,
    versions: execution
      ? executionVersions(execution)
      : assetFlow(
          bundle,
          task,
          dependencyNodes,
          inputs,
          outputs.map((item) => item.key),
          preferChinese
        ),
    capabilityTags: [...new Set(phaseTags.map(capabilityTagLabel))],
    coverage: Object.entries(workflow.brief_coverage || {})
      .filter(([, ids]) => ids.includes(task.id))
      .map(([key]) => COVERAGE_LABELS[key] || '其他简报项'),
    actionLocked,
    actionLockReason: actionLocked ? blockers[0] || `任务状态为${workflowStatusLabel(status)}` : '',
    detailsId: `workflow-task-details-${task.id.replace(/[^A-Za-z0-9_-]/g, '-')}`
  };
}

export function parseTaskObjective(
  goal: string,
  options: {
    preferChinese?: boolean;
    displayTitle?: string;
    projectGoal?: string;
    phaseTag?: string;
  } = {}
): TaskObjectiveValue {
  const raw = String(goal || '');
  const quotedCommand = raw.match(/\bCLI\s*:\s*`([^`\r\n]+)`/i);
  const bareCommand = quotedCommand
    ? null
    : raw.match(
        /\bCLI\s*:\s*((?:node|npm|pnpm|yarn|bun|python|cargo|go)\b[^\r\n。]*?)(?=\.\s+[A-Z\u4e00-\u9fff]|[\r\n]|$)/i
      );
  const commandMatch = quotedCommand || bareCommand;
  const command = String(commandMatch?.[1] || '')
    .trim()
    .replace(/[.;]+$/, '');
  const plain = (commandMatch ? raw.replace(commandMatch[0], ' ') : raw)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\t ]+/g, ' ')
    .trim();
  const sentences = plain
    .split(/\r?\n+|(?<=[。！？])|(?<=[.!?])\s+/)
    .map((item) => item.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
  const chinese = sentences.find((item) => /[\u3400-\u9fff]/.test(item)) || '';
  const english = sentences.find((item) => !/[\u3400-\u9fff]/.test(item) && /[A-Za-z]{3}/.test(item)) || '';
  const times = [...new Set(raw.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) || [])];
  const timezone =
    raw.match(/\b(?:Asia|America|Europe|Africa|Australia|Pacific)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?\b/)?.[0] || '';
  const sameLanguage = sentences.filter((item) =>
    chinese ? /[\u3400-\u9fff]/.test(item) : english ? !/[\u3400-\u9fff]/.test(item) : true
  );
  const coreSentences = (sameLanguage.length ? sameLanguage : sentences).filter(
    (item) => !scheduleOnly(item, times, timezone)
  );
  const summarySource = coreSentences[0] || sameLanguage[0] || sentences[0] || plain || '未提供目标或执行上下文';
  let summary = compactObjectiveText(summarySource, 180);
  let keyPoints = [
    ...new Set(
      coreSentences
        .slice(1)
        .map((item) => compactObjectiveText(item, 120))
        .filter((item) => item && item !== summary)
    )
  ].slice(0, 3);
  if (options.preferChinese && !hasMeaningfulChinese(chinese)) {
    const localized = localizedChineseObjective(raw, options);
    summary = localized.summary;
    keyPoints = localized.keyPoints;
  }
  return {
    raw,
    summary,
    summaryLanguage: hasMeaningfulChinese(summary) ? 'zh-CN' : /[A-Za-z]{3}/.test(summary) ? 'en' : undefined,
    keyPoints,
    command,
    times,
    timezone,
    chinese,
    english,
    fallback: raw.replace(/\s+/g, ' ').trim(),
    detail: plain.replace(/\s+/g, ' ').trim()
  };
}

function localizedChineseObjective(
  raw: string,
  options: { displayTitle?: string; projectGoal?: string; phaseTag?: string }
) {
  const title = String(options.displayTitle || '当前任务')
    .replace(/[。！？.!?]+$/, '')
    .trim();
  const summary = compactObjectiveText(`${title}，并形成可核验的阶段成果。`, 180);
  const keyPoints: string[] = [];
  if (hasMeaningfulChinese(options.projectGoal || '')) {
    keyPoints.push(compactObjectiveText(`对齐项目目标：${options.projectGoal}`, 120));
  }
  const stageRequirement = CHINESE_STAGE_REQUIREMENTS[options.phaseTag || ''];
  if (stageRequirement) keyPoints.push(stageRequirement);
  const rules = CHINESE_CONTEXT_RULES.filter(([pattern]) => pattern.test(raw)).map(([, label]) => label);
  if (rules.length) keyPoints.push(compactObjectiveText(`执行要求：${[...new Set(rules)].join('、')}。`, 120));
  return { summary, keyPoints: keyPoints.slice(0, 3) };
}

function workstreamDisplayOutcome(node: WorkflowNode, displayTitle: string, preferChinese: boolean) {
  const source = node.outcome || node.goal || '';
  if (!preferChinese || hasMeaningfulChinese(source)) return source;
  return `围绕“${displayTitle}”形成可追溯、可独立验收的交付结果。`;
}

function hasMeaningfulChinese(value: string) {
  return (value.match(/[\u3400-\u9fff]/g)?.length || 0) >= 2;
}

function scheduleOnly(value: string, times: string[], timezone: string) {
  const hasScheduleValue = times.some((item) => value.includes(item)) || Boolean(timezone && value.includes(timezone));
  return hasScheduleValue && /^(?:run|schedule|execute|at\b|每天|每晚|执行时间|调度|时区)/i.test(value.trim());
}

function compactObjectiveText(value: string, maximum: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  const characters = [...text];
  return characters.length <= maximum
    ? text
    : `${characters
        .slice(0, maximum - 1)
        .join('')
        .trimEnd()}…`;
}

function blockingReasons(
  bundle: ProjectBundle,
  task: WorkflowNode,
  dependencies: WorkflowNode[],
  inputs: NodeInputSlot[],
  preferChinese: boolean
) {
  const reasons: string[] = [];
  const failedRun = task.latest_run && ['failed', 'partial'].includes(task.latest_run.status) ? task.latest_run : null;
  if (normalizeTaskStatus(task.status) === 'blocked' && failedRun)
    reasons.push(`上次执行失败：${failedRun.summary || '运行器未完成任务'}`);
  const waiting = dependencies.filter((item) => normalizeTaskStatus(item.status) !== 'completed');
  if (waiting.length) reasons.push(`等待 ${waiting.map((item) => taskDisplayTitle(item, preferChinese)).join('、')}`);
  for (const slot of inputs.filter((item) => item.required && item.source === 'dependency')) {
    if (
      !bundle.assets.some(
        (asset) => asset.node_id === slot.ref_id && asset.status === 'confirmed' && asset.current_version_id
      )
    )
      reasons.push(`输入 ${slot.key} 待确认`);
  }
  if (bundle.runs.some((run) => run.node_id === task.id && run.input_superseded))
    reasons.push('输入版本已替代，需重新验收');
  if (normalizeTaskStatus(task.status) === 'blocked' && !reasons.length) reasons.push('执行上下文门禁未满足');
  return [...new Set(reasons)];
}

function assetFlow(
  bundle: ProjectBundle,
  task: WorkflowNode,
  dependencies: WorkflowNode[],
  inputs: NodeInputSlot[],
  outputKeys: string[],
  preferChinese: boolean
) {
  const outputAssets = bundle.assets.filter((item) => item.node_id === task.id);
  const outputIds = new Set(outputAssets.map((item) => item.id));
  const exact = (bundle.asset_relations || [])
    .filter((item) => item.relation_type === 'derived_from' && outputIds.has(item.target_asset_id))
    .map((item, index) => ({
      key: `relation-${index}`,
      label: `${assetVersionLabel(bundle, item.source_asset_id, item.source_asset_version_id)} -> 当前输入 -> ${assetVersionLabel(bundle, item.target_asset_id, item.target_asset_version_id)}`
    }));
  if (exact.length) return exact;
  const targets = outputAssets.length
    ? outputAssets.map((item) => assetVersionLabel(bundle, item.id, item.current_version_id))
    : outputKeys.map((key) => `${key}（待产出）`);
  const planned = inputs.map((slot) => ({
    key: slot.key,
    label: `${inputSourceLabel(bundle, slot, dependencies, preferChinese)} -> ${slot.key} -> ${targets.join('、') || '待定义输出'}`
  }));
  return planned.length ? planned : [{ key: 'empty', label: '无显式输入 -> 待定义输出' }];
}

function inputSourceLabel(
  bundle: ProjectBundle,
  slot: NodeInputSlot,
  dependencies: WorkflowNode[],
  preferChinese: boolean
) {
  if (slot.version_id)
    return assetVersionLabel(
      bundle,
      bundle.asset_versions?.find((item) => item.id === slot.version_id)?.asset_id || slot.ref_id || '',
      slot.version_id
    );
  if (slot.source === 'dependency') {
    const dependency = dependencies.find((item) => item.id === slot.ref_id);
    const assets = bundle.assets.filter((item) => item.node_id === dependency?.id && item.status === 'confirmed');
    return assets.length
      ? assets.map((item) => assetVersionLabel(bundle, item.id, item.current_version_id)).join('、')
      : `${dependency ? taskDisplayTitle(dependency, preferChinese) : slot.ref_id || '上游任务'}（待确认）`;
  }
  if (slot.source === 'brief') return '项目简报';
  if (slot.source === 'repository_workspace') return '代码仓库固定快照';
  const asset = bundle.assets.find((item) => item.id === slot.ref_id);
  return asset ? assetVersionLabel(bundle, asset.id, asset.current_version_id) : slot.selector || slot.source;
}

function executionVersions(execution: TaskExecutionRecord): WorkflowTaskVersion[] {
  const inputs = execution.context_snapshot?.inputs?.flatMap((item) => item.asset_versions || []) || [];
  const values = [
    ...inputs.map((item) => ({
      key: `in-${item.version_id}`,
      label: `输入 · ${shortId(item.version_id)}`,
      meta: shortId(item.content_sha256)
    })),
    ...execution.output_bindings.map((item) => ({
      key: `out-${item.version_id}`,
      label: `输出 · ${item.key}`,
      meta: `${shortId(item.version_id)} · ${shortId(item.repository_sha || item.content_sha256)}`
    }))
  ];
  return values.length ? values : [{ key: 'empty', label: '等待载荷' }];
}

function assetVersionLabel(bundle: ProjectBundle, assetId: string, versionId?: string | null) {
  const asset: AssetRecord | undefined = bundle.assets.find((item) => item.id === assetId);
  const version = bundle.asset_versions?.find((item) => item.id === versionId);
  return `${asset?.title || version?.title || assetId || '资产'} @ ${shortId(versionId || asset?.current_version_id)}`;
}

function reasonLabel(reason: { code: string; [key: string]: unknown }) {
  const labels: Record<string, string> = {
    workflow_paused: '工作流已暂停',
    task_dependency_waiting: '等待上游任务',
    task_dependency_outputs_unaccepted: '等待上游资产验收',
    required_input_missing: '必需输入缺失',
    input_asset_unverified: '输入资产未验证',
    repository_line_provisioning: '代码仓库执行线准备中',
    manual_input_required: '等待人工输入',
    pull_request_create_approval_required: '等待批准创建合并请求',
    pull_request_merge_approval_required: '等待批准合并请求'
  };
  return labels[reason.code] || '等待执行条件';
}

function dependencyIds(task: WorkflowNode) {
  return (task.dependencies || []).map((item) => item.node_id).filter(Boolean) as string[];
}
function currentContract(items: NodeContract[], id?: string) {
  return items.find((item) => item.id === id) || [...items].sort((a, b) => b.version - a.version)[0];
}
function latestExecution(snapshot: WorkflowExecutionSnapshot | null | undefined, taskId: string) {
  return snapshot?.task_executions.filter((item) => item.task_id === taskId).sort((a, b) => b.attempt - a.attempt)[0];
}
function taskActionLocked(status: string, blockers: string[]) {
  return (
    status === 'blocked' ||
    (status === 'pending' && blockers.length > 0) ||
    status === 'cancelled' ||
    status === 'superseded'
  );
}
function byOrder(a: WorkflowNode, b: WorkflowNode) {
  return a.order_index - b.order_index;
}
function shortId(value?: string | null) {
  return value ? value.slice(0, 10) : '待绑定';
}
