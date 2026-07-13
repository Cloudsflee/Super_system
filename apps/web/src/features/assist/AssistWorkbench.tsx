import { Bot, Columns2, FolderPlus, Maximize2, MessageSquare, Minimize2, PanelLeft, PanelRight, Plus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AssistSurfaceMode, Project } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import { useUi } from '../../state/ui';
import { AssistComposer } from './AssistComposer';
import { DiffReviewPanel } from './DiffReviewPanel';
import { TerminalPanel } from './TerminalPanel';
import { ThreadSidebar } from './ThreadSidebar';
import { TurnTimeline } from './TurnTimeline';
import { useAssistController } from './useAssistController';
import { useAssistDockResize } from './useAssistDockResize';
import { useAssistFloating } from './useAssistFloating';
import { GoalCard } from './GoalCard';
import { ActivityLedger } from './ActivityLedger';
import { TerminalRuntimeSelector } from './TerminalRuntimeSelector';

export function AssistWorkbench({ project, nodeId }: { project?: Project; nodeId?: string }) {
  const ui = useUi();
  const location = useLocation();
  const navigate = useNavigate();
  const projectId = project?.id;
  const controller = useAssistController({ projectId, nodeId, enabled: ui.assistOpen, route: location.pathname });
  const floating = useAssistFloating(ui.assistOpen && ui.assistSurface === 'floating');
  const dockResize = useAssistDockResize(ui.assistOpen && ui.assistSurface === 'docked');
  const [threadsOpen, setThreadsOpen] = useState(() => !isMobileAssist());
  const writeModeUnavailableReason = assistWriteModeUnavailableReason(project);
  useEffect(() => {
    if (!ui.assistOpen || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 700px)'), collapse = () => { if (media.matches) setThreadsOpen(false); };
    collapse(); media.addEventListener('change', collapse);
    return () => media.removeEventListener('change', collapse);
  }, [ui.assistOpen]);
  if (!ui.assistOpen) return null;
  if (ui.assistSurface === 'minimized') return <button className="assist-minimized" onClick={ui.restoreAssist}><Bot size={16} /><span>Assist</span><i className={controller.running ? 'running' : ''} />{controller.running?.status || controller.session?.status || 'idle'}</button>;
  const session = controller.session;
  const showThreads = Boolean(projectId && threadsOpen);
  const surfaceClass = `surface-${ui.assistSurface}`;
  return <section className={`assist-workbench ${surfaceClass}${showThreads ? ' threads-open' : ''}`} style={floating.style} aria-label="Codex Assist V3">
    {ui.assistSurface === 'docked' && <div className={`assist-dock-resizer${dockResize.dragging ? ' dragging' : ''}`} role="separator" aria-label="调整 Assist 宽度" aria-orientation="vertical" aria-valuemin={dockResize.min} aria-valuemax={dockResize.max} aria-valuenow={dockResize.width} tabIndex={0} title="拖动调整宽度；双击复位" onPointerDown={dockResize.start} onKeyDown={dockResize.keyDown} onDoubleClick={dockResize.reset} />}
    <header className="assist-workbench-head" onPointerDown={ui.assistSurface === 'floating' ? floating.startMove : undefined}>
      <IconButton label={showThreads ? '隐藏线程列表' : '显示线程列表'} active={showThreads} disabled={!projectId} onClick={() => setThreadsOpen(!threadsOpen)}><PanelLeft size={17} /></IconButton>
      <Bot size={18} /><div><strong>Assist</strong><small>{session?.title || '选择或创建线程'}{controller.stream.connected ? ' · live' : ''}</small></div>
      <nav>{controller.view !== 'chat' && <button onClick={controller.backToChat}><MessageSquare size={13} />对话</button>}{controller.reviewTarget && <button className={controller.view === 'review' ? 'active' : ''} onClick={controller.showReview}>Review</button>}{controller.terminal && <button className={controller.view === 'terminal' ? 'active' : ''} onClick={controller.showTerminal}>Terminal</button>}</nav>
      <div className="assist-surface-actions"><SurfaceButton surface="docked" current={ui.assistSurface} set={ui.setAssistSurface} icon={Columns2} label="停靠" /><SurfaceButton surface="floating" current={ui.assistSurface} set={ui.setAssistSurface} icon={Square} label="浮动" /><SurfaceButton surface="fullscreen" current={ui.assistSurface} set={ui.setAssistSurface} icon={Maximize2} label="全屏" /><IconButton label="最小化 Assist" onClick={() => ui.setAssistSurface('minimized')}><Minimize2 size={16} /></IconButton><IconButton label="关闭 Assist" onClick={() => ui.setAssist(false)}><X size={17} /></IconButton></div>
    </header>
    <div className="assist-workbench-body">
      {showThreads && <ThreadSidebar sessions={controller.sessions.data || []} selectedId={controller.selectedId} search={controller.search} archived={controller.archived} loading={controller.sessions.isLoading} onSearch={controller.setSearch} onArchived={controller.setArchived} onSelect={(id) => { controller.setSelectedId(id); controller.backToChat(); if (isMobileAssist()) setThreadsOpen(false); }} onCreate={() => { controller.createSession(); if (isMobileAssist()) setThreadsOpen(false); }} onRename={controller.rename} onPin={controller.pin} onArchive={controller.archive} onFork={(item) => { controller.fork(item); if (isMobileAssist()) setThreadsOpen(false); }} />}
      <main className="assist-main">
        {!projectId && <div className="assist-no-session"><FolderPlus size={28} /><h3>先创建项目</h3><p>Assist 线程必须归属于一个项目。</p><button className="button primary" onClick={() => { ui.setAssist(false); navigate('/projects'); }}><FolderPlus size={15} />创建项目</button></div>}
        {projectId && !session && <div className="assist-no-session"><Bot size={28} /><h3>{controller.archived ? '选择一个已归档线程' : '创建 Assist 线程'}</h3><p>线程保存 Turn、附件、typed events 和 Review 状态。</p>{!controller.archived && <button className="button primary" onClick={controller.createSession}><Plus size={15} />新建线程</button>}</div>}
        {session && controller.view === 'chat' && <><GoalCard goal={controller.goal.data?.goal || session.native_goal_snapshot || null} busy={controller.busy} onSet={controller.setGoal} onClear={controller.clearGoal} /><ActivityLedger operations={Array.isArray(controller.operations.data) ? controller.operations.data : []} /><TurnTimeline turns={session.turns || []} events={controller.stream.events} connected={controller.stream.connected} busy={controller.busy} onRetry={controller.retry} onReview={controller.openReview} onRespondUserInput={controller.respondUserInput} onConfirmOperation={controller.confirmOperation} onUndoOperation={controller.undoOperation} /><AssistComposer session={session} profileName={controller.profiles.data?.find((item) => item.id === controller.profileId)?.name || 'Codex'} catalog={controller.models.data} configurations={Array.isArray(controller.configurations.data) ? controller.configurations.data : []} configurationId={controller.configurationId} model={controller.model} reasoning={controller.reasoning} planNext={controller.planNext} prompt={controller.prompt} attachments={session.attachments || []} selectedAttachments={controller.attachmentIds} activeTurn={controller.running} busy={controller.busy} writeModeUnavailableReason={writeModeUnavailableReason} onModel={controller.setModel} onReasoning={controller.setReasoning} onConfiguration={controller.selectConfiguration} onPlanNext={controller.setPlanNext} onPrompt={controller.setPrompt} onAttachments={controller.setAttachmentIds} onAttachmentCreated={controller.addAttachment} onSubmit={controller.submit} onStop={controller.stop} onTerminal={() => controller.setTerminalSelectorOpen(true)} onSaveConfiguration={controller.saveConfiguration} onError={(message) => controller.toast(message, 'error')} /></>}
        {session && controller.view === 'review' && controller.reviewTarget && <DiffReviewPanel target={controller.reviewTarget} onBack={controller.backToChat} onResolved={controller.resolveReview} />}
        {session && controller.view === 'terminal' && controller.terminal && <TerminalPanel session={controller.terminal} reviewDisabled={controller.terminalRolledBack} onSession={controller.setTerminal} onBack={controller.backToChat} onReview={controller.openTerminalReview} onError={(message) => controller.toast(message, 'error')} />}
      </main>
    </div>
    {ui.assistSurface === 'floating' && <button className="assist-resize-handle" aria-label="调整 Assist 大小" onClick={floating.grow} onPointerDown={floating.startResize}><PanelRight size={13} /></button>}
    {controller.terminalSelectorOpen && <TerminalRuntimeSelector capabilities={controller.terminalCapabilities.data} onClose={() => controller.setTerminalSelectorOpen(false)} onSelect={controller.openTerminal} />}
  </section>;
}

export function assistWriteModeUnavailableReason(project?: Pick<Project, 'status' | 'managed_workspace_state'>) {
  if (!project) return '请先创建或选择项目。';
  if (project.status !== 'active') return '完成项目简报并激活项目后可用。';
  if (project.managed_workspace_state !== 'ready') return '项目代码迁移到受管工作区后可用。';
  return null;
}

function SurfaceButton({ surface, current, set, icon: Icon, label }: { surface: AssistSurfaceMode; current: AssistSurfaceMode; set: (value: AssistSurfaceMode) => void; icon: typeof Columns2; label: string }) {
  return <IconButton label={`${label} Assist`} active={surface === current} onClick={() => set(surface)}><Icon size={16} /></IconButton>;
}

function isMobileAssist() { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches; }
