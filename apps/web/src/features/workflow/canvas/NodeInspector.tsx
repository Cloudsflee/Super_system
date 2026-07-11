import { ArrowUpRight, FileCheck2, GitPullRequest, Pencil, Play, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeContract, WorkflowNode } from '../../../api/types';
import { useUi } from '../../../state/ui';
import { IconButton } from '../../../components/common/IconButton';
import { nodeLabels } from './node-types';
import { api, json } from '../../../api/client';
import type { ChangeProposal, NodeKind } from '../../../api/types';

export function NodeInspector({ node, contract, projectId }: { node: WorkflowNode; contract?: NodeContract; projectId: string }) {
  const navigate = useNavigate();
  const ui = useUi();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: node.title, goal: node.goal, type: node.type });
  useEffect(() => { setDraft({ title: node.title, goal: node.goal, type: node.type }); setEditing(false); }, [node.id, node.title, node.goal, node.type]);
  async function propose(action: 'update_node' | 'remove_node') {
    try { const proposal = await api<ChangeProposal>(`/workflows/${node.workflow_id}/proposals`, json('POST', action === 'remove_node' ? { action, node_id: node.id } : { action, node_id: node.id, patch: draft })); ui.showProposal(proposal.id); } catch (error) { ui.toast((error as Error).message, 'error'); }
  }
  return (
    <aside className="node-inspector">
      <header><div><span className="overline">{nodeLabels[node.type]} NODE</span><h2>{node.title}</h2></div><IconButton label="关闭 Inspector" onClick={() => ui.inspect(null)}><X size={17} /></IconButton></header>
      <div className="inspector-body">
        <div className="status-line"><span className={`status ${node.status}`}>{node.status}</span><small>Contract v{contract?.version || 0}</small></div>
        <section><h3>目标</h3><p>{node.goal || '尚未定义'}</p></section>
        <section><h3>验收标准</h3>{contract?.acceptance_criteria?.length ? <ul>{contract.acceptance_criteria.map((item) => <li key={item}>{item}</li>)}</ul> : <p>尚未建立 Contract</p>}</section>
        <dl><div><dt><Play size={13} />最近运行</dt><dd>{node.latest_run?.status || '未运行'}</dd></div><div><dt><FileCheck2 size={13} />输出</dt><dd>{node.output_count || 0}</dd></div><div><dt><ShieldCheck size={13} />待审批</dt><dd>{node.pending_approval_count || 0}</dd></div></dl>
        {editing && <section className="node-edit"><label>类型<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as NodeKind })}>{Object.entries(nodeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>目标<textarea rows={5} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label><button className="button primary" onClick={() => propose('update_node')}><GitPullRequest size={15} />提交变更</button></section>}
      </div>
      <footer><button className="button danger" onClick={() => propose('remove_node')}><Trash2 size={15} />移除</button><button className="button secondary" onClick={() => setEditing(!editing)}><Pencil size={15} />编辑</button><button className="button primary" onClick={() => navigate(`/projects/${projectId}/nodes/${node.id}`)}>进入工作区<ArrowUpRight size={16} /></button></footer>
    </aside>
  );
}
