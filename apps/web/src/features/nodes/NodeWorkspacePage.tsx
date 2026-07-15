import { ArrowLeft, Bot, FileCheck2, History, Play, ScrollText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { NodeWorkspace } from '../../api/types';
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
  const setAssist = useUi((state) => state.setAssist);
  useAssistSurface({ id: 'node-workspace', tabs: {
    work: { label: '工作内容', read: () => tab, select: () => setTab('work') },
    contract: { label: 'Contract', read: () => tab, select: () => setTab('contract') },
    activity: { label: '运行与 Trace', read: () => tab, select: () => setTab('activity') }
  } });
  const query = useQuery({ queryKey: keys.workspace(nodeId || ''), queryFn: () => api<NodeWorkspace>(`/nodes/${nodeId}/workspace`), enabled: Boolean(nodeId), refetchInterval: (current) => (current.state.data as NodeWorkspace | undefined)?.runs.some((run) => ['queued', 'running'].includes(run.status)) ? 1000 : false });
  if (query.isLoading) return <FullPageState title="正在打开节点工作区" />;
  if (query.isError || !query.data) return <FullPageState title="节点工作区加载失败" detail={query.error?.message} retry={query.refetch} />;
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
        <IconButton label="打开当前节点 Assist" onClick={() => setAssist(true)}><Bot size={19} /></IconButton>
      </header>
      <nav className="workspace-tabs" aria-label="节点视图">
        <button className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}><Play size={15} />工作内容</button>
        <button className={tab === 'contract' ? 'active' : ''} onClick={() => setTab('contract')}><FileCheck2 size={15} />Contract</button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><History size={15} />运行与 Trace</button>
      </nav>
      <div className="workspace-content">
        {tab === 'work' && <Suspense fallback={<FullPageState title="正在加载节点工具" />}><Renderer key={query.data.node.id} value={query.data} onSaved={query.refetch} /></Suspense>}
        {tab === 'contract' && <ContractPanel value={query.data} />}
        {tab === 'activity' && <ActivityPanel value={query.data} onSaved={query.refetch} />}
      </div>
    </section>
  );
}
