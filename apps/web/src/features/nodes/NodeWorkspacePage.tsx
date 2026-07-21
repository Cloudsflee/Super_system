import { ArrowLeft, Bot, FileCheck2, History, Play, ScrollText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type { ChangeProposal, NodeWorkspace } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { IconButton } from '../../components/common/IconButton';
import { useUi } from '../../state/ui';
import { ContractPanel } from './panels/ContractPanel';
import { ActivityPanel } from './panels/ActivityPanel';
import { rendererFor } from './registry';
import { useAssistSurface } from '../../components/assist/semantic-actions';

type Tab = 'work' | 'contract' | 'activity';

export function NodeWorkspacePage() {
  const { projectId, nodeId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('work');
  const [runningNode, setRunningNode] = useState(false);
  const setAssist = useUi((state) => state.setAssist);
  useAssistSurface({ id: 'node-workspace', tabs: {
    work: { label: '工作内容', read: () => tab, select: () => setTab('work') },
    contract: { label: 'Contract', read: () => tab, select: () => setTab('contract') },
    activity: { label: '运行与 Trace', read: () => tab, select: () => setTab('activity') }
  } });
  const query = useQuery({ queryKey: keys.workspace(nodeId || ''), queryFn: () => api<NodeWorkspace>(`/nodes/${nodeId}/workspace`), enabled: Boolean(nodeId), refetchInterval: (current) => (current.state.data as NodeWorkspace | undefined)?.runs.some((run) => ['queued', 'running'].includes(run.status)) ? 1000 : false });
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ proposal?: ChangeProposal; applied?: { type?: string; node_id?: string; repository_workspace_id?: string | null } }>).detail;
      if (detail?.applied?.type === 'node_run_authorization' && detail.applied.node_id === nodeId && detail.proposal?.id) void executeApproved(detail.proposal.id, detail.applied.repository_workspace_id || undefined);
    };
    window.addEventListener('aiws:proposal-applied', listener);
    return () => window.removeEventListener('aiws:proposal-applied', listener);
  }, [nodeId]);
  async function runNode(repositoryWorkspaceId = query.data?.project.default_repository_workspace_id || undefined) {
    if (!query.data || runningNode) return;
    try {
      const value = query.data, repositoryBinding = repositoryWorkspaceId ? { repository_workspace_id: repositoryWorkspaceId } : {};
      const proposal = await api<ChangeProposal>('/change-proposals', json('POST', { project_id: value.project.id, workspace_id: value.workspace.id, node_id: value.node.id, change_type: 'node_run_write', title: `运行节点：${value.node.title}`, summary: 'Codex 将在固定 Repository Workspace 上执行并生成可验证资产', before: null, after: { runner: 'codex_docker', ...repositoryBinding }, impact: ['Repository Workspace', 'NodeRun 资产与 Trace'], risks: ['模型可能产生非预期文件变更'], apply_action: { type: 'node_run_authorization', node_id: value.node.id, runner: 'codex_docker', ...repositoryBinding } }, '创建 NodeRun 授权提案'));
      useUi.getState().showProposal(proposal.id);
    } catch (error) { useUi.getState().toast((error as Error).message, 'error'); }
  }
  async function executeApproved(approvalId: string, repositoryWorkspaceId?: string) {
    if (!nodeId) return;
    setRunningNode(true);
    try { await api(`/nodes/${nodeId}/run/start`, json('POST', { runner: 'codex_docker', approval_id: approvalId, ...(repositoryWorkspaceId ? { repository_workspace_id: repositoryWorkspaceId } : {}) }, '启动 NodeRun')); await query.refetch(); useUi.getState().toast('NodeRun 已启动'); }
    catch (error) { useUi.getState().toast((error as Error).message, 'error'); }
    finally { setRunningNode(false); }
  }
  if (query.isLoading) return <FullPageState title="正在打开节点工作区" />;
  if (query.isError || !query.data) return <FullPageState title="节点工作区加载失败" detail={query.error?.message} retry={query.refetch} />;
  if (query.data.project.id !== projectId) return <Navigate to={`/projects/${query.data.project.id}/nodes/${query.data.node.id}`} replace />;
  const definition = rendererFor(query.data.node.type);
  const Renderer = definition.component;
  return (
    <section className="node-workspace-page">
      <header className="workspace-header">
        <IconButton label="返回工作流" onClick={() => navigate(`/projects/${projectId}/workflow`)}><ArrowLeft size={18} /></IconButton>
        <definition.icon size={19} />
        <div><span>{definition.label}</span><h1>{query.data.node.title}</h1></div>
        <span className={`status ${query.data.node.status}`}>{query.data.node.status}</span>
        <div className="workspace-header-spacer" />
        <button className="button primary" aria-label="运行节点" disabled={runningNode} onClick={() => void runNode()}><Play size={15} />{runningNode ? 'Running' : '运行节点'}</button>
        <IconButton label="打开当前节点 Assist" onClick={() => setAssist(true)}><Bot size={19} /></IconButton>
      </header>
      <nav className="workspace-tabs" aria-label="节点视图">
        <button className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}><Play size={15} />工作内容</button>
        <button className={tab === 'contract' ? 'active' : ''} onClick={() => setTab('contract')}><FileCheck2 size={15} />Contract</button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><History size={15} />运行与 Trace</button>
      </nav>
      <div className="workspace-content">
        {tab === 'work' && <Suspense fallback={<FullPageState title="正在加载节点工具" />}><Renderer key={query.data.node.id} value={query.data} onSaved={query.refetch} onRunNode={(repositoryWorkspaceId) => void runNode(repositoryWorkspaceId)} runningNode={runningNode} /></Suspense>}
        {tab === 'contract' && <ContractPanel value={query.data} />}
        {tab === 'activity' && <ActivityPanel value={query.data} onSaved={query.refetch} />}
      </div>
    </section>
  );
}
