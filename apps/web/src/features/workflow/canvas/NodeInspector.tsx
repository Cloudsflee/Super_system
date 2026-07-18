import { ArrowUpRight, CircleAlert, FileCheck2, GitBranch, GitPullRequest, ListChecks, MoreHorizontal, PanelRightClose, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../../api/client';
import type { ChangeProposal, NodeContract, WorkflowNode, WorkstreamCategory } from '../../../api/types';
import { useContextMenu } from '../../../components/common/ContextMenu';
import { IconButton } from '../../../components/common/IconButton';
import { useUi } from '../../../state/ui';
import { nodeLabels, nodeStatusLabel, normalizeNodeStatus } from './node-types';
import { workflowNodeActions } from './workflow-node-actions';

type Props = { node: WorkflowNode; contract?: NodeContract; projectId: string; workflowVersion: number; startEditing?: boolean; onAssist: () => void; onEditingChange?: (editing: boolean) => void };

export function NodeInspector({ node, contract, projectId, workflowVersion, startEditing = false, onAssist, onEditingChange = () => undefined }: Props) {
  const navigate = useNavigate(), ui = useUi(), menu = useContextMenu(), more = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState({ title: node.title, goal: node.goal, outcome: node.outcome || node.goal, category: node.category || 'deliverable' as WorkstreamCategory });
  useEffect(() => { setDraft({ title: node.title, goal: node.goal, outcome: node.outcome || node.goal, category: node.category || 'deliverable' }); setEditing(startEditing); }, [node.id, node.title, node.goal, node.outcome, node.category, startEditing]);
  async function propose(action: 'update_node' | 'remove_node') {
    try {
      const operations = action === 'remove_node' ? [{ type: 'delete_node', node_id: node.id }] : [{ type: 'update_node', node_id: node.id, patch: draft }];
      const proposal = await api<ChangeProposal>(`/workflows/${node.workflow_id}/graph-proposals`, json('POST', { parent_node_id: null, expected_revision: workflowVersion, operations }, action === 'remove_node' ? '创建删除成果节点提案' : '创建更新成果节点提案'));
      if (action === 'update_node') { setEditing(false); onEditingChange(false); }
      ui.showProposal(proposal.id);
    } catch (error) { ui.toast((error as Error).message, 'error'); }
  }
  const actions = useMemo(() => [...workflowNodeActions(node, {
    view: () => undefined,
    enter: () => navigate(`/projects/${projectId}/workflow/${node.id}`),
    assist: onAssist,
    edit: () => { setEditing(true); onEditingChange(true); },
    remove: () => void propose('remove_node')
  }), { id: `workflow-node.${node.id}.close`, label: '关闭详情', icon: PanelRightClose, onSelect: () => ui.inspect(null) }], [navigate, node, onAssist, onEditingChange, projectId, draft, workflowVersion, ui]);
  function openMenu() { const trigger = more.current; if (!trigger) return; const rect = trigger.getBoundingClientRect(); menu.open(actions, { x: rect.right - 8, y: rect.bottom + 5 }, trigger); }
  return <aside className="node-inspector" aria-label={`${node.title} 详情`}>
    <header><div><span className="overline">{workstreamLabel(node.category)}</span><h2>{node.title}</h2></div><nav><IconButton label="进入成果节点" onClick={() => navigate(`/projects/${projectId}/workflow/${node.id}`)}><ArrowUpRight size={16} /></IconButton><IconButton ref={more} label="更多节点操作" aria-haspopup="menu" onClick={openMenu}><MoreHorizontal size={17} /></IconButton></nav></header>
    <div className="inspector-body">
      <div className="status-line"><span className={`status ${normalizeNodeStatus(node.status)}`}>{nodeStatusLabel(node.status)}</span><small>Contract v{contract?.version || 0}</small></div>
      <section><h3>可验收成果</h3><p>{node.outcome || node.goal || '尚未定义'}</p></section>
      <section><h3>验收标准</h3>{contract?.acceptance_criteria?.length ? <ul>{contract.acceptance_criteria.map((item) => <li key={item}>{item}</li>)}</ul> : <p>尚未建立 Contract</p>}</section>
      <dl><div><dt><ListChecks size={13} />任务进度</dt><dd>{node.completed_task_count || 0}/{node.task_count || 0}</dd></div><div><dt><CircleAlert size={13} />阻塞</dt><dd>{node.blocked_count || 0}</dd></div><div><dt><FileCheck2 size={13} />输出</dt><dd>{node.output_count || 0}</dd></div><div><dt><ShieldCheck size={13} />待审批</dt><dd>{node.pending_approval_count || 0}</dd></div><div><dt><GitBranch size={13} />仓库</dt><dd>{node.repository_status?.ready_count || 0}/{node.repository_status?.target_count || 0}</dd></div></dl>
      {editing && <section className="node-edit"><label>类别<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as WorkstreamCategory })}><option value="deliverable">交付成果</option><option value="decision">关键决策</option><option value="coordination">协同成果</option><option value="operation">运营成果</option></select></label><label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>成果<textarea rows={5} value={draft.outcome} onChange={(event) => setDraft({ ...draft, outcome: event.target.value, goal: event.target.value })} /></label><footer><button className="button secondary" onClick={() => { setDraft({ title: node.title, goal: node.goal, outcome: node.outcome || node.goal, category: node.category || 'deliverable' }); setEditing(false); onEditingChange(false); }}>取消</button><button className="button primary" onClick={() => void propose('update_node')}><GitPullRequest size={15} />提交提案</button></footer></section>}
    </div>
  </aside>;
}

function workstreamLabel(value?: string | null) { return ({ deliverable: '交付成果', decision: '关键决策', coordination: '协同成果', operation: '运营成果' } as Record<string, string>)[value || ''] || '成果节点'; }
