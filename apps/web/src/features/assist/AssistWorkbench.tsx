import { Bot, Columns2, Maximize2, MessageSquare, Minimize2, PanelLeft, PanelRight, Plus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { AssistSurfaceMode } from '../../api/types';
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

export function AssistWorkbench({ projectId, nodeId }: { projectId?: string; nodeId?: string }) {
  const ui = useUi();
  const location = useLocation();
  const controller = useAssistController({ projectId, nodeId, enabled: ui.assistOpen, route: location.pathname });
  const floating = useAssistFloating(ui.assistOpen && ui.assistSurface === 'floating');
  const dockResize = useAssistDockResize(ui.assistOpen && ui.assistSurface === 'docked');
  const [threadsOpen, setThreadsOpen] = useState(() => !isMobileAssist());
  useEffect(() => {
    if (!ui.assistOpen || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 700px)'), collapse = () => { if (media.matches) setThreadsOpen(false); };
    collapse(); media.addEventListener('change', collapse);
    return () => media.removeEventListener('change', collapse);
  }, [ui.assistOpen]);
  if (!ui.assistOpen) return null;
  if (ui.assistSurface === 'minimized') return <button className="assist-minimized" onClick={ui.restoreAssist}><Bot size={16} /><span>Assist</span><i className={controller.running ? 'running' : ''} />{controller.running?.status || controller.session?.status || 'idle'}</button>;
  const session = controller.session;
  const surfaceClass = `surface-${ui.assistSurface}`;
  return <section className={`assist-workbench ${surfaceClass}${threadsOpen ? ' threads-open' : ''}`} style={floating.style} aria-label="Codex Assist V3">
    {ui.assistSurface === 'docked' && <div className={`assist-dock-resizer${dockResize.dragging ? ' dragging' : ''}`} role="separator" aria-label="调整 Assist 宽度" aria-orientation="vertical" aria-valuemin={dockResize.min} aria-valuemax={dockResize.max} aria-valuenow={dockResize.width} tabIndex={0} title="拖动调整宽度；双击复位" onPointerDown={dockResize.start} onKeyDown={dockResize.keyDown} onDoubleClick={dockResize.reset} />}
    <header className="assist-workbench-head" onPointerDown={ui.assistSurface === 'floating' ? floating.startMove : undefined}>
      <IconButton label={threadsOpen ? '隐藏线程列表' : '显示线程列表'} active={threadsOpen} onClick={() => setThreadsOpen(!threadsOpen)}><PanelLeft size={17} /></IconButton>
      <Bot size={18} /><div><strong>Assist</strong><small>{session?.title || '选择或创建线程'}{controller.stream.connected ? ' · live' : ''}</small></div>
      <nav>{controller.view !== 'chat' && <button onClick={controller.backToChat}><MessageSquare size={13} />对话</button>}{controller.reviewTarget && <button className={controller.view === 'review' ? 'active' : ''} onClick={controller.showReview}>Review</button>}{controller.terminal && <button className={controller.view === 'terminal' ? 'active' : ''} onClick={controller.showTerminal}>CLI</button>}</nav>
      <div className="assist-surface-actions"><SurfaceButton surface="docked" current={ui.assistSurface} set={ui.setAssistSurface} icon={Columns2} label="停靠" /><SurfaceButton surface="floating" current={ui.assistSurface} set={ui.setAssistSurface} icon={Square} label="浮动" /><SurfaceButton surface="fullscreen" current={ui.assistSurface} set={ui.setAssistSurface} icon={Maximize2} label="全屏" /><IconButton label="最小化 Assist" onClick={() => ui.setAssistSurface('minimized')}><Minimize2 size={16} /></IconButton><IconButton label="关闭 Assist" onClick={() => ui.setAssist(false)}><X size={17} /></IconButton></div>
    </header>
    <div className="assist-workbench-body">
      {threadsOpen && <ThreadSidebar sessions={controller.sessions.data || []} selectedId={controller.selectedId} search={controller.search} archived={controller.archived} loading={controller.sessions.isLoading} onSearch={controller.setSearch} onArchived={controller.setArchived} onSelect={(id) => { controller.setSelectedId(id); controller.backToChat(); if (isMobileAssist()) setThreadsOpen(false); }} onCreate={() => { controller.createSession(); if (isMobileAssist()) setThreadsOpen(false); }} onRename={controller.rename} onPin={controller.pin} onArchive={controller.archive} onFork={(item) => { controller.fork(item); if (isMobileAssist()) setThreadsOpen(false); }} />}
      <main className="assist-main">
        {!session && <div className="assist-no-session"><Bot size={28} /><h3>{controller.archived ? '选择一个已归档线程' : '创建 Assist 线程'}</h3><p>线程保存 Turn、附件、typed events 和 Review 状态。</p>{!controller.archived && <button className="button primary" onClick={controller.createSession}><Plus size={15} />新建线程</button>}</div>}
        {session && controller.view === 'chat' && <><TurnTimeline turns={session.turns || []} events={controller.stream.events} connected={controller.stream.connected} onRetry={controller.retry} onReview={controller.openReview} /><AssistComposer session={session} profiles={controller.profiles.data || []} mode={controller.mode} profileId={controller.profileId} prompt={controller.prompt} attachments={session.attachments || []} selectedAttachments={controller.attachmentIds} activeTurn={controller.running} busy={controller.busy} onMode={controller.setMode} onProfile={controller.setProfileId} onPrompt={controller.setPrompt} onAttachments={controller.setAttachmentIds} onAttachmentCreated={controller.addAttachment} onSubmit={controller.submit} onStop={controller.stop} onError={(message) => controller.toast(message, 'error')} /></>}
        {session && controller.view === 'review' && controller.reviewTarget && <DiffReviewPanel target={controller.reviewTarget} onBack={controller.backToChat} onResolved={controller.resolveReview} />}
        {session && controller.view === 'terminal' && controller.terminal && <TerminalPanel session={controller.terminal} reviewDisabled={controller.terminalRolledBack} onSession={controller.setTerminal} onBack={controller.backToChat} onReview={controller.openTerminalReview} onError={(message) => controller.toast(message, 'error')} />}
      </main>
    </div>
    {ui.assistSurface === 'floating' && <button className="assist-resize-handle" aria-label="调整 Assist 大小" onClick={floating.grow} onPointerDown={floating.startResize}><PanelRight size={13} /></button>}
  </section>;
}

function SurfaceButton({ surface, current, set, icon: Icon, label }: { surface: AssistSurfaceMode; current: AssistSurfaceMode; set: (value: AssistSurfaceMode) => void; icon: typeof Columns2; label: string }) {
  return <IconButton label={`${label} Assist`} active={surface === current} onClick={() => set(surface)}><Icon size={16} /></IconButton>;
}

function isMobileAssist() { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches; }
