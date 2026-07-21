import { ArrowRight, Check, CircleDashed, GitBranch, Link2, LockKeyhole } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AssetRecord, NodeContract, NodeInputSlot, ProjectBundle, Workflow, WorkflowNode } from '../../api/types';

const STAGES = [
  ['research_evidence', '调研取证'], ['constraint_analysis', '约束分析'], ['solution_decision', '方案决策'],
  ['execution', '实现执行'], ['acceptance', '测试验收'], ['integration_delivery', '集成交付']
] as const;
const COVERAGE_LABELS: Record<string, string> = { features: '特性', acceptance_criteria: '验收', milestones: '里程碑', risks: '风险' };

export function WorkflowFullProcess({ bundle, workflow }: { bundle: ProjectBundle; workflow: Workflow }) {
  const nodes = bundle.nodes.filter((item) => item.workflow_id === workflow.id);
  const workstreams = nodes.filter((item) => item.role === 'workstream');
  const tasks = nodes.filter((item) => item.role === 'task');
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const software = /software|code/i.test(workflow.project_classification || '');
  return <section className="workflow-full-process" aria-label="完整 Task 流程">
    <header className="workflow-process-summary">
      <div><span>PROCESS COVERAGE</span><strong>{tasks.length} 个任务 · {workstreams.length} 个成果</strong></div>
      <div className="workflow-phase-coverage" role="list" aria-label="六阶段覆盖">
        {STAGES.map(([key, label]) => <PhaseState key={key} tag={key} label={label} tasks={tasks} software={software} />)}
      </div>
    </header>
    <div className="workflow-process-streams">
      {workstreams.map((workstream, streamIndex) => {
        const localTasks = tasks.filter((item) => item.parent_node_id === workstream.id).sort(byOrder);
        return <section className="workflow-process-stream" key={workstream.id} aria-labelledby={`process-${workstream.id}`}>
          <header>
            <div className="workflow-stream-index">{String(streamIndex + 1).padStart(2, '0')}</div>
            <div><span>{categoryLabel(workstream.category)}</span><h2 id={`process-${workstream.id}`}>{workstream.title}</h2><p>{workstream.outcome || workstream.goal}</p></div>
            <div className="workflow-stream-progress"><strong>{localTasks.filter((item) => normalizedStatus(item.status) === 'completed').length}/{localTasks.length}</strong><span>已验收</span></div>
            <Link to={`/projects/${bundle.project.id}/workflow/${workstream.id}`} aria-label={`进入成果节点：${workstream.title}`}><ArrowRight size={17} /></Link>
          </header>
          <div className="workflow-task-dag" role="list">
            {localTasks.map((task, index) => <TaskProcessRow key={task.id} bundle={bundle} task={task} taskById={taskById} workflow={workflow} index={index} />)}
          </div>
        </section>;
      })}
      {!workstreams.length && <div className="workflow-process-empty">当前工作流没有成果节点。</div>}
    </div>
  </section>;
}

function PhaseState({ tag, label, tasks, software }: { tag: string; label: string; tasks: WorkflowNode[]; software: boolean }) {
  const matched = tasks.filter((item) => phaseTags(item).includes(tag));
  const completed = matched.length > 0 && matched.every((item) => normalizedStatus(item.status) === 'completed');
  const active = matched.some((item) => ['running', 'needs_review'].includes(normalizedStatus(item.status)));
  const state = !matched.length ? (software ? 'missing' : 'merged') : completed ? 'completed' : active ? 'active' : 'planned';
  return <div role="listitem" className={`workflow-phase ${state}`}><span>{completed ? <Check size={12} /> : <CircleDashed size={12} />}{label}</span><small>{matched.length ? `${matched.length} Task` : software ? '缺失' : '已合并'}</small></div>;
}

function TaskProcessRow({ bundle, task, taskById, workflow, index }: { bundle: ProjectBundle; task: WorkflowNode; taskById: Map<string, WorkflowNode>; workflow: Workflow; index: number }) {
  const dependencies = dependencyIds(task).map((id) => taskById.get(id)).filter(Boolean) as WorkflowNode[];
  const contract = currentContract(bundle.contracts.filter((item) => item.node_id === task.id), task.current_contract_id);
  const inputs = contract?.expected_inputs?.length ? contract.expected_inputs : task.input_slots || [];
  const outputs = contract?.expected_outputs?.length ? contract.expected_outputs : task.output_slots || [];
  const blockers = blockingReasons(bundle, task, dependencies, inputs);
  const coverage = Object.entries(workflow.brief_coverage || {}).filter(([, ids]) => ids.includes(task.id)).map(([key]) => COVERAGE_LABELS[key] || key);
  const lineages = assetFlow(bundle, task, dependencies, inputs, outputs.map((item) => item.key));
  return <article className={`workflow-process-task ${normalizedStatus(task.status)}`} role="listitem">
    <div className="workflow-task-sequence"><span>{String(index + 1).padStart(2, '0')}</span><i /></div>
    <div className="workflow-task-main">
      <header><span className="workflow-task-stage">{phaseLabel(task)}</span><span className={`task-status ${normalizedStatus(task.status)}`}>{statusLabel(task.status)}</span></header>
      <h3>{task.title}</h3><p>{task.goal}</p>
      <div className="workflow-task-tags">{task.capability_tags?.map((tag) => <span key={tag}>{tag}</span>)}{coverage.map((item) => <span className="brief-map" key={item}>{item}</span>)}</div>
    </div>
    <div className="workflow-task-dependencies">
      <strong><GitBranch size={13} />前置依赖</strong>
      {dependencies.length ? dependencies.map((item) => <span key={item.id}>{normalizedStatus(item.status) === 'completed' ? <Check size={12} /> : <CircleDashed size={12} />}{item.title}</span>) : <span>无</span>}
      {blockers.map((item) => <em key={item}><LockKeyhole size={12} />{item}</em>)}
    </div>
    <div className="workflow-task-contract">
      <div><strong>Typed inputs</strong>{inputs.map((slot) => <span key={slot.key}>{slot.key}<small>{slot.kind} · {slot.required ? '必需' : '可选'}</small></span>)}</div>
      <div><strong>Typed outputs</strong>{outputs.map((slot) => <span key={slot.key}>{slot.key}<small>{slot.asset_type} · {slot.confirmation_policy === 'human' ? '人工确认' : '证据确认'}</small></span>)}</div>
    </div>
    <div className="workflow-task-assets"><strong><Link2 size={13} />资产流</strong>{lineages.map((item, itemIndex) => <span key={`${item}-${itemIndex}`}>{item}</span>)}</div>
    <Link className="workflow-task-enter" to={`/projects/${bundle.project.id}/nodes/${task.id}`} aria-label={`打开任务：${task.title}`}><ArrowRight size={16} /></Link>
  </article>;
}

function blockingReasons(bundle: ProjectBundle, task: WorkflowNode, dependencies: WorkflowNode[], inputs: NodeInputSlot[]) {
  const reasons: string[] = [], waiting = dependencies.filter((item) => normalizedStatus(item.status) !== 'completed');
  if (waiting.length) reasons.push(`等待 ${waiting.map((item) => item.title).join('、')}`);
  for (const slot of inputs.filter((item) => item.required && item.source === 'dependency')) {
    if (!bundle.assets.some((asset) => asset.node_id === slot.ref_id && asset.status === 'confirmed' && asset.current_version_id)) reasons.push(`输入 ${slot.key} 待确认`);
  }
  if (bundle.runs.some((run) => run.node_id === task.id && run.input_superseded)) reasons.push('输入版本已替代，需重新验收');
  if (normalizedStatus(task.status) === 'blocked' && !reasons.length) reasons.push('执行上下文门禁未满足');
  return [...new Set(reasons)];
}

function assetFlow(bundle: ProjectBundle, task: WorkflowNode, dependencies: WorkflowNode[], inputs: NodeInputSlot[], outputKeys: string[]) {
  const outputAssets = bundle.assets.filter((item) => item.node_id === task.id), outputIds = new Set(outputAssets.map((item) => item.id));
  const exact = (bundle.asset_relations || []).filter((item) => item.relation_type === 'derived_from' && outputIds.has(item.target_asset_id)).map((item) => `${assetVersionLabel(bundle, item.source_asset_id, item.source_asset_version_id)} -> 当前输入 -> ${assetVersionLabel(bundle, item.target_asset_id, item.target_asset_version_id)}`);
  if (exact.length) return exact;
  const targets = outputAssets.length ? outputAssets.map((item) => assetVersionLabel(bundle, item.id, item.current_version_id)) : outputKeys.map((key) => `${key}（待产出）`);
  const planned = inputs.map((slot) => `${inputSourceLabel(bundle, slot, dependencies)} -> ${slot.key} -> ${targets.join('、') || '待定义输出'}`);
  return planned.length ? planned : ['无显式输入 -> 待定义输出'];
}

function inputSourceLabel(bundle: ProjectBundle, slot: NodeInputSlot, dependencies: WorkflowNode[]) {
  if (slot.version_id) return assetVersionLabel(bundle, bundle.asset_versions?.find((item) => item.id === slot.version_id)?.asset_id || slot.ref_id || '', slot.version_id);
  if (slot.source === 'dependency') {
    const dependency = dependencies.find((item) => item.id === slot.ref_id), assets = bundle.assets.filter((item) => item.node_id === dependency?.id && item.status === 'confirmed');
    return assets.length ? assets.map((item) => assetVersionLabel(bundle, item.id, item.current_version_id)).join('、') : `${dependency?.title || slot.ref_id || '上游任务'}（待确认）`;
  }
  if (slot.source === 'brief') return 'Project Brief';
  if (slot.source === 'repository_workspace') return 'Repository 固定快照';
  const asset = bundle.assets.find((item) => item.id === slot.ref_id);
  return asset ? assetVersionLabel(bundle, asset.id, asset.current_version_id) : slot.selector || slot.source;
}

function assetVersionLabel(bundle: ProjectBundle, assetId: string, versionId?: string | null) {
  const asset: AssetRecord | undefined = bundle.assets.find((item) => item.id === assetId), version = bundle.asset_versions?.find((item) => item.id === versionId);
  return `${asset?.title || version?.title || assetId || '资产'} @ ${shortId(versionId || asset?.current_version_id)}`;
}

function dependencyIds(task: WorkflowNode) { return (task.dependencies || []).map((item) => item.node_id).filter(Boolean) as string[]; }
function currentContract(items: NodeContract[], id?: string) { return items.find((item) => item.id === id) || [...items].sort((a, b) => b.version - a.version)[0]; }
function phaseTags(task: WorkflowNode) { return task.capability_tags?.length ? task.capability_tags : inferredTags(task.task_kind); }
function phaseLabel(task: WorkflowNode) { const tag = phaseTags(task).find((item) => STAGES.some(([key]) => key === item)); return STAGES.find(([key]) => key === tag)?.[1] || '执行任务'; }
function inferredTags(kind?: string | null) { return ({ research: ['research_evidence'], analysis: ['constraint_analysis'], design: ['solution_decision'], code: ['execution'], content: ['execution'], test: ['acceptance'], review: ['acceptance'], deploy: ['integration_delivery'], integration: ['integration_delivery'] } as Record<string, string[]>)[kind || ''] || ['execution']; }
function byOrder(a: WorkflowNode, b: WorkflowNode) { return a.order_index - b.order_index; }
function normalizedStatus(value: string) { return value === 'draft' || value === 'queued' ? 'ready' : value === 'succeeded' ? 'completed' : value; }
function statusLabel(value: string) { return ({ ready: '待执行', running: '进行中', needs_review: '待验收', completed: '已完成', blocked: '阻塞' } as Record<string, string>)[normalizedStatus(value)] || value; }
function categoryLabel(value?: string | null) { return ({ deliverable: '交付成果', decision: '关键决策', coordination: '协同成果', operation: '运营成果' } as Record<string, string>)[value || ''] || '成果节点'; }
function shortId(value?: string | null) { return value ? value.slice(0, 10) : '待绑定'; }
