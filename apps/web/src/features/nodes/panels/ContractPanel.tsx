import { GitPullRequest } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, json } from '../../../api/client';
import type { ChangeProposal, NodeWorkspace } from '../../../api/types';
import { useUi } from '../../../state/ui';
import { useAssistSurface } from '../../../components/assist/semantic-actions';

type Tool = { id: string; name: string; status?: string };

export function ContractPanel({ value }: { value: NodeWorkspace }) {
  const [goal, setGoal] = useState(value.contract?.node_goal || value.node.goal);
  const [criteria, setCriteria] = useState((value.contract?.acceptance_criteria || []).join('\n'));
  const [allowedTools, setAllowedTools] = useState(value.contract?.allowed_tools || []);
  useEffect(() => { setGoal(value.contract?.node_goal || value.node.goal); setCriteria((value.contract?.acceptance_criteria || []).join('\n')); setAllowedTools(value.contract?.allowed_tools || []); }, [value.contract?.id]);
  const ui = useUi();
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/tools') });
  useAssistSurface({ id: 'node-contract', fields: {
    'contract.node_goal': { label: '节点目标', elementId: 'contract-node-goal', set: (input) => setGoal(String(input ?? '')) },
    'contract.acceptance_criteria': { label: '验收标准', elementId: 'contract-criteria', set: (input) => setCriteria(toLines(input).join('\n')) },
    'contract.allowed_tools': { label: '允许工具', set: (input) => setAllowedTools(toLines(input)) }
  } });
  async function propose() {
    try { const proposal = await api<ChangeProposal>('/change-proposals', json('POST', { project_id: value.project.id, workspace_id: value.workspace.id, node_id: value.node.id, change_type: 'node_contract_patch', title: `更新 ${value.node.title} Contract`, summary: '调整节点目标、验收标准与允许工具', before: value.contract, after: { node_goal: goal, acceptance_criteria: criteria.split('\n').filter(Boolean), allowed_tools: allowedTools }, impact: ['后续 Context Pack 与 NodeRun'], risks: ['验收边界或工具权限发生变化'], apply_action: { type: 'node_contract_patch' } })); ui.showProposal(proposal.id); } catch (error) { ui.toast((error as Error).message, 'error'); }
  }
  return (
    <div className="contract-panel"><header className="content-header"><div><span className="overline">NODE CONTRACT V{value.contract?.version || 0}</span><h2>节点契约</h2></div><button className="button primary" onClick={propose}><GitPullRequest size={15} />提交变更提案</button></header><div className="contract-grid"><section><label>节点目标<textarea id="contract-node-goal" rows={8} value={goal} onChange={(e) => setGoal(e.target.value)} /></label><label>验收标准<textarea id="contract-criteria" rows={12} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label></section><aside><h3>允许工具</h3><div className="tool-checks">{[...new Set([...(tools.data?.map((tool) => tool.name) || []), ...allowedTools])].map((tool) => <label key={tool}><input type="checkbox" checked={allowedTools.includes(tool)} onChange={(event) => setAllowedTools((items) => event.target.checked ? [...new Set([...items, tool])] : items.filter((item) => item !== tool))} /><span>{tool}</span></label>)}</div><h3>期望输出</h3><ul>{value.contract?.expected_outputs?.map((output) => <li key={output.label}>{output.label}</li>)}</ul></aside></div></div>
  );
}

function toLines(value: unknown) { return (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n|,/)).map(String).map((item) => item.trim()).filter(Boolean); }
