import {
  Bot,
  Boxes,
  Check,
  Columns2,
  FolderKanban,
  FolderPlus,
  GitBranch,
  LayoutPanelTop,
  ListTodo,
  LockKeyhole,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeft,
  PanelRight,
  Square,
  X
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEventHandler } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AssistScopeType, AssistSurfaceMode, Project } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import { useUi } from '../../state/ui';
import { AssistComposer } from './AssistComposer';
import { DiffReviewPanel } from './DiffReviewPanel';
import { TerminalPanel } from './TerminalPanel';
import { ThreadSidebar } from './ThreadSidebar';
import { TurnTimeline } from './TurnTimeline';
import { useAssistCenter } from './AssistContext';
import type { AssistController } from './useAssistController';
import { useAssistDockResize } from './useAssistDockResize';
import { useAssistFloating } from './useAssistFloating';
import { GoalCard } from './GoalCard';
import { TerminalRuntimeSelector } from './TerminalRuntimeSelector';
import { BtwPopover } from './BtwPopover';
import { BootstrapAssistComposer } from './CommandDock';
import { assistScopeBreadcrumb, assistScopeLabel, assistScopePath, sessionIsReadOnly } from './scope-display';

export function AssistWorkbench({ project }: { project?: Project }) {
  const controller = useAssistCenter();
  return <AssistWorkbenchSurface project={project} controller={controller} />;
}

function AssistWorkbenchSurface({ project, controller }: { project?: Project; controller: AssistController }) {
  const ui = useUi();
  const projectId = project?.id;
  const expanded = ui.assistOpen && ui.contextLane !== 'inspector';
  const floating = useAssistFloating(expanded && ui.assistSurface === 'floating');
  const dockResize = useAssistDockResize(expanded && ui.assistSurface === 'docked');
  const [threadsOpen, setThreadsOpen] = useState(false);
  const writeModeUnavailableReason = assistWriteModeUnavailableReason(project);
  useEffect(() => {
    if (!ui.assistOpen || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 700px)'),
      collapse = () => {
        if (media.matches) setThreadsOpen(false);
      };
    collapse();
    media.addEventListener('change', collapse);
    return () => media.removeEventListener('change', collapse);
  }, [ui.assistOpen]);
  const btw = (
    <BtwPopover
      projectId={controller.projectId}
      scopeType={controller.scopeType}
      scopeId={controller.scopeId}
      scopeBreadcrumb={controller.scopeBreadcrumb}
      sessionId={controller.session?.id}
      profileId={controller.profileId}
    />
  );
  if (!ui.assistOpen) return btw;
  if (!expanded)
    return (
      <>
        <button className="context-peek assist-peek" onClick={() => ui.setAssist(true)}>
          <Bot size={15} />
          <span>智能助手</span>
          {controller.running && <i className="running" />}
        </button>
        {btw}
      </>
    );
  if (ui.assistSurface === 'minimized') return btw;
  const showThreads = Boolean(projectId && threadsOpen);
  const surfaceClass = `surface-${ui.assistSurface}`;
  return (
    <>
      <section
        className={`assist-workbench ${surfaceClass}${showThreads ? ' threads-open' : ''}`}
        style={floating.style}
        aria-label="Codex 智能助手"
      >
        {ui.assistSurface === 'docked' && (
          <div
            className={`assist-dock-resizer${dockResize.dragging ? ' dragging' : ''}`}
            role="separator"
            aria-label="调整智能助手宽度"
            data-tooltip="拖动调整宽度，双击复位"
            aria-orientation="vertical"
            aria-valuemin={dockResize.min}
            aria-valuemax={dockResize.max}
            aria-valuenow={dockResize.width}
            tabIndex={0}
            onPointerDown={dockResize.start}
            onKeyDown={dockResize.keyDown}
            onDoubleClick={dockResize.reset}
          />
        )}
        <AssistWorkbenchHeader
          project={project}
          controller={controller}
          showThreads={showThreads}
          onToggleThreads={() => setThreadsOpen(!threadsOpen)}
          onPointerDown={ui.assistSurface === 'floating' ? floating.startMove : undefined}
        />
        <AssistWorkbenchBody
          project={project}
          controller={controller}
          showThreads={showThreads}
          writeModeUnavailableReason={writeModeUnavailableReason}
          onCloseThreads={() => setThreadsOpen(false)}
        />
        {ui.assistSurface === 'floating' && (
          <button
            className="assist-resize-handle"
            aria-label="调整智能助手大小"
            onClick={floating.grow}
            onPointerDown={floating.startResize}
          >
            <PanelRight size={13} />
          </button>
        )}
        {controller.terminalSelectorOpen && (
          <TerminalRuntimeSelector
            capabilities={controller.terminalCapabilities.data}
            onClose={() => controller.setTerminalSelectorOpen(false)}
            onSelect={controller.openTerminal}
          />
        )}
      </section>
      {btw}
    </>
  );
}

function AssistWorkbenchHeader({
  project,
  controller,
  showThreads,
  onToggleThreads,
  onPointerDown
}: {
  project?: Project;
  controller: AssistController;
  showThreads: boolean;
  onToggleThreads: () => void;
  onPointerDown?: PointerEventHandler<HTMLElement>;
}) {
  const ui = useUi();
  const session = controller.session;
  const readOnlySession = sessionIsReadOnly(session);
  const scopeType = session?.scope_type || controller.scopeType;
  const breadcrumb = assistScopeBreadcrumb(session, controller.scopeBreadcrumb);
  const breadcrumbText = assistScopePath(breadcrumb) || project?.title || '未选择项目';
  const ScopeIcon = iconForScope(scopeType);
  return (
    <header className="assist-workbench-head" onPointerDown={onPointerDown}>
      <IconButton
        label={showThreads ? '隐藏线程列表' : '显示线程列表'}
        active={showThreads}
        disabled={!project?.id}
        onClick={onToggleThreads}
      >
        <PanelLeft size={17} />
      </IconButton>
      <div className="assist-head-title">
        <span className="assist-scope-heading">
          <ScopeIcon size={14} />
          <strong>{assistScopeLabel(scopeType)}智能助手</strong>
          {readOnlySession && <LockKeyhole size={12} aria-label="只读" />}
          <i>{session?.title || '选择或创建线程'}</i>
        </span>
        <small className="assist-scope-breadcrumb" data-tooltip={breadcrumbText}>
          {breadcrumbText}
        </small>
      </div>
      <nav>
        {controller.view !== 'chat' && (
          <button onClick={controller.backToChat}>
            <MessageSquare size={13} />
            对话
          </button>
        )}
        {controller.reviewTarget && (
          <button className={controller.view === 'review' ? 'active' : ''} onClick={controller.showReview}>
            变更审查
          </button>
        )}
        {controller.terminal && (
          <button className={controller.view === 'terminal' ? 'active' : ''} onClick={controller.showTerminal}>
            终端
          </button>
        )}
      </nav>
      <div className="assist-surface-actions">
        <SurfaceMenu current={ui.assistSurface} set={ui.setAssistSurface} />
        <IconButton label="最小化智能助手" onClick={() => ui.setAssistSurface('minimized')}>
          <Minimize2 size={16} />
        </IconButton>
        <IconButton label="关闭智能助手" onClick={() => ui.setAssist(false)}>
          <X size={17} />
        </IconButton>
      </div>
    </header>
  );
}

function AssistWorkbenchBody({
  project,
  controller,
  showThreads,
  writeModeUnavailableReason,
  onCloseThreads
}: {
  project?: Project;
  controller: AssistController;
  showThreads: boolean;
  writeModeUnavailableReason: string | null;
  onCloseThreads: () => void;
}) {
  const ui = useUi();
  const navigate = useNavigate();
  const session = controller.session;
  const readOnlySession = sessionIsReadOnly(session);
  const closeThreadsOnMobile = () => {
    if (isMobileAssist()) onCloseThreads();
  };
  return (
    <div className="assist-workbench-body">
      {showThreads && (
        <ThreadSidebar
          sessions={controller.sessions.data || []}
          selectedId={controller.selectedId}
          search={controller.search}
          archived={controller.archived}
          loading={controller.sessions.isLoading}
          onSearch={controller.setSearch}
          onArchived={controller.setArchived}
          onSelect={(id) => {
            controller.setSelectedId(id);
            controller.backToChat();
            closeThreadsOnMobile();
          }}
          onCreate={() => {
            controller.createSession();
            closeThreadsOnMobile();
          }}
          onRename={controller.rename}
          onPin={controller.pin}
          onArchive={controller.archive}
          onFork={(item) => {
            controller.fork(item);
            closeThreadsOnMobile();
          }}
          onDelete={controller.deleteBranch}
          onRestoreDeleted={controller.restoreDeleted}
        />
      )}
      <main className="assist-main">
        {!project?.id && (
          <div className="assist-no-session">
            <FolderPlus size={28} />
            <h3>先创建项目</h3>
            <p>智能助手线程必须归属于一个项目。</p>
            <button
              className="button primary"
              onClick={() => {
                ui.setAssist(false);
                navigate('/projects');
              }}
            >
              <FolderPlus size={15} />
              创建项目
            </button>
          </div>
        )}
        {project?.id && !session && (
          <div className="assist-no-session">
            <Bot size={28} />
            <h3>{controller.archived ? '选择一个已归档线程' : '创建智能助手线程'}</h3>
            <p>对话、附件与审查记录会保存在当前项目中。</p>
            {controller.archived ? null : (
              <BootstrapAssistComposer unavailable={writeModeUnavailableReason} controller={controller} />
            )}
          </div>
        )}
        {session && controller.view === 'chat' && (
          <>
            <GoalCard
              goal={controller.goal.data?.goal || session.native_goal_snapshot || null}
              busy={controller.busy || readOnlySession}
              onSet={controller.setGoal}
              onClear={controller.clearGoal}
            />
            {readOnlySession && (
              <div className="assist-archived-status" role="status">
                {session.archived_at
                  ? '此线程已归档，只读显示历史记录。恢复后可继续对话。'
                  : '原作用域已删除或换版，此线程按审计快照只读保留。'}
              </div>
            )}
            <TurnTimeline
              turns={session.turns || []}
              events={controller.stream.events}
              reconnecting={controller.stream.reconnecting}
              busy={controller.busy}
              onRetry={controller.retry}
              onReview={controller.openReview}
              onRespondUserInput={controller.respondUserInput}
              onConfirmOperation={controller.confirmOperation}
              onUndoOperation={controller.undoOperation}
              onReviseOperation={controller.reviseOperation}
              onContinueOperation={controller.continueOperation}
            />
            {!readOnlySession && (
              <AssistWorkbenchComposer
                controller={controller}
                session={session}
                unavailable={writeModeUnavailableReason}
              />
            )}
          </>
        )}
        {session && controller.view === 'review' && controller.reviewTarget && (
          <DiffReviewPanel
            target={controller.reviewTarget}
            onBack={controller.backToChat}
            onResolved={controller.resolveReview}
          />
        )}
        {session && controller.view === 'terminal' && controller.terminal && (
          <TerminalPanel
            session={controller.terminal}
            reviewDisabled={controller.terminalRolledBack}
            onSession={controller.setTerminal}
            onBack={controller.backToChat}
            onReview={controller.openTerminalReview}
            onError={(message) => controller.toast(message, 'error')}
          />
        )}
      </main>
    </div>
  );
}

function AssistWorkbenchComposer({
  controller,
  session,
  unavailable
}: {
  controller: AssistController;
  session: NonNullable<AssistController['session']>;
  unavailable: string | null;
}) {
  return (
    <AssistComposer
      layout="workbench"
      session={session}
      profileName={controller.profiles.data?.find((item) => item.id === controller.profileId)?.name || 'Codex'}
      catalog={controller.models.data}
      configurations={Array.isArray(controller.configurations.data) ? controller.configurations.data : []}
      configurationId={controller.configurationId}
      model={controller.model}
      reasoning={controller.reasoning}
      clarificationPolicy={session.clarification_policy || 'ask'}
      planNext={controller.planNext}
      prompt={controller.prompt}
      attachments={session.attachments || []}
      selectedAttachments={controller.attachmentIds}
      activeTurn={controller.running}
      busy={controller.busy}
      writeModeUnavailableReason={unavailable}
      onModel={controller.setModel}
      onReasoning={controller.setReasoning}
      onConfiguration={controller.selectConfiguration}
      onClarificationPolicy={controller.setClarificationPolicy}
      onPlanNext={controller.setPlanNext}
      onPrompt={controller.setPrompt}
      onAttachments={controller.setAttachmentIds}
      onAttachmentCreated={controller.addAttachment}
      onAttachmentDeleted={controller.attachmentDeleted}
      onSubmit={controller.submit}
      onStop={controller.stop}
      onTerminal={() => controller.setTerminalSelectorOpen(true)}
      onCommand={controller.composerCommand}
      onSaveConfiguration={controller.saveConfiguration}
      onError={(message) => controller.toast(message, 'error')}
    />
  );
}

function iconForScope(scopeType?: AssistScopeType) {
  if (scopeType === 'project') return FolderKanban;
  if (scopeType === 'workflow') return GitBranch;
  if (scopeType === 'workstream') return Boxes;
  if (scopeType === 'task') return ListTodo;
  return Bot;
}

export function assistWriteModeUnavailableReason(project?: Pick<Project, 'status' | 'managed_workspace_state'>) {
  if (!project) return '请先创建或选择项目。';
  if (project.status !== 'active') return '完成项目简报并激活项目后可用。';
  if (project.managed_workspace_state !== 'ready') return '项目代码迁移到受管工作区后可用。';
  return null;
}

const surfaceOptions = [
  { surface: 'docked', label: '停靠', icon: Columns2 },
  { surface: 'floating', label: '浮动', icon: Square },
  { surface: 'fullscreen', label: '全屏', icon: Maximize2 }
] satisfies Array<{ surface: Exclude<AssistSurfaceMode, 'minimized'>; label: string; icon: typeof Columns2 }>;

function SurfaceMenu({ current, set }: { current: AssistSurfaceMode; set: (value: AssistSurfaceMode) => void }) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() =>
      root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    );
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        (root.current?.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement | null)?.focus();
      }
    };
    window.addEventListener('pointerdown', pointer);
    window.addEventListener('keydown', keyboard, true);
    return () => {
      window.removeEventListener('pointerdown', pointer);
      window.removeEventListener('keydown', keyboard, true);
    };
  }, [open]);
  return (
    <div className="assist-layout-menu" ref={root}>
      <IconButton
        label="智能助手布局"
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        onClick={() => setOpen(!open)}
      >
        <LayoutPanelTop size={16} />
      </IconButton>
      {open && (
        <div role="menu" aria-label="智能助手布局" onKeyDown={(event) => moveMenuFocus(event)}>
          {surfaceOptions.map(({ surface, label, icon: Icon }) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={surface === current}
              key={surface}
              onClick={() => {
                set(surface);
                setOpen(false);
              }}
            >
              <Icon size={15} />
              <span>{label}</span>
              {surface === current && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')],
    current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
  items[index]?.focus();
}

function isMobileAssist() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 700px)').matches
  );
}
