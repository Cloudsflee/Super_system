import { Bot, ChevronDown, ChevronUp, LockKeyhole, Maximize2, Paperclip, Send, ListTodo } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Project } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import { useUi } from '../../state/ui';
import { AssistComposer } from './AssistComposer';
import { useAssistCenter, useOptionalAssistCenter } from './AssistContext';
import type { AssistController } from './useAssistController';
import { assistScopeBreadcrumb, assistScopePath, assistScopeTitle, sessionIsReadOnly } from './scope-display';

export function CommandDock({ project }: { project: Project }) {
  const controller = useAssistCenter(),
    ui = useUi();
  const dockRef = useRef<HTMLElement>(null);
  useCommandDockSafeArea(dockRef, ui.assistOpen, ui.commandDockExpanded);
  if (ui.assistOpen) return null;
  const session = sessionIsReadOnly(controller.session) ? undefined : controller.session;
  const unavailable = writeModeUnavailableReason(project);
  const breadcrumb = assistScopeBreadcrumb(controller.session, controller.scopeBreadcrumb);
  const scopeTitle = assistScopeTitle(controller.scopeType, breadcrumb);
  const scopePath = assistScopePath(breadcrumb);
  return (
    <aside
      ref={dockRef}
      className={`command-dock ${ui.commandDockExpanded ? 'expanded' : 'collapsed'}`}
      aria-label="智能助手命令栏"
    >
      <header>
        <Bot size={14} />
        <span data-tooltip={scopePath}>
          {scopeTitle}
          {session ? ` / ${session.title}` : controller.sessions.isLoading ? ' / 正在载入线程' : ''}
        </span>
        <IconButton
          className="command-dock-toggle"
          label={ui.commandDockExpanded ? '收起智能助手输入' : '展开智能助手输入'}
          aria-expanded={ui.commandDockExpanded}
          aria-controls="command-dock-body"
          onClick={() => ui.setCommandDockExpanded(!ui.commandDockExpanded)}
        >
          {ui.commandDockExpanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </IconButton>
        <IconButton label="展开智能助手" onClick={() => ui.setAssist(true)}>
          <Maximize2 size={15} />
        </IconButton>
      </header>
      {ui.commandDockExpanded && (
        <div className="command-dock-body" id="command-dock-body">
          {session ? (
            <AssistComposer
              layout="dock"
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
              onTerminal={() => {
                ui.setAssist(true);
                controller.setTerminalSelectorOpen(true);
              }}
              onCommand={controller.composerCommand}
              onSaveConfiguration={controller.saveConfiguration}
              onError={(message) => controller.toast(message, 'error')}
            />
          ) : (
            <BootstrapAssistComposer unavailable={unavailable} />
          )}
        </div>
      )}
    </aside>
  );
}

function useCommandDockSafeArea(ref: RefObject<HTMLElement | null>, hidden: boolean, expanded: boolean) {
  useLayoutEffect(() => {
    const dock = ref.current,
      shell = dock?.closest('.app-shell');
    if (hidden || !dock || !(shell instanceof HTMLElement)) return;
    const update = () => {
      const rect = dock.getBoundingClientRect();
      if (rect.height <= 0) return;
      const viewportGap = Math.max(0, window.innerHeight - rect.bottom);
      shell.style.setProperty('--command-dock-safe-height', `${Math.ceil(rect.height + viewportGap + 26)}px`);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(dock);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      shell.style.removeProperty('--command-dock-safe-height');
    };
  }, [expanded, hidden, ref]);
}

export function BootstrapAssistComposer({
  unavailable,
  controller: provided
}: {
  unavailable: string | null;
  controller?: AssistController;
}) {
  const contextual = useOptionalAssistCenter(),
    controller = provided || contextual;
  if (!controller) throw new Error('智能助手输入区缺少控制器。');
  return (
    <section className="command-dock-bootstrap">
      {unavailable && (
        <div className="composer-readonly-status" role="status">
          <LockKeyhole size={12} />
          <span>代码工作区只读：{unavailable}</span>
        </div>
      )}
      <textarea
        aria-label="智能助手消息"
        value={controller.prompt}
        onChange={(event) => controller.setPrompt(event.target.value)}
        placeholder="输入消息，使用 /plan 开始规划"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) controller.submit('queue');
        }}
      />
      <footer>
        <button
          type="button"
          className={`composer-plan-toggle${controller.planNext ? ' active' : ''}`}
          aria-pressed={controller.planNext}
          onClick={() => controller.setPlanNext(!controller.planNext)}
        >
          <ListTodo size={13} />
          规划
        </button>
        <IconButton label="创建线程后添加附件" onClick={controller.createSession}>
          <Paperclip size={14} />
        </IconButton>
        <button
          className="button primary"
          aria-label="发送"
          disabled={controller.busy || !controller.prompt.trim()}
          onClick={() => controller.submit('queue')}
        >
          <Send size={14} />
          发送
        </button>
      </footer>
    </section>
  );
}

function writeModeUnavailableReason(project: Pick<Project, 'status' | 'managed_workspace_state'>) {
  if (project.status !== 'active') return '完成项目简报并激活项目后可用。';
  if (project.managed_workspace_state !== 'ready') return '项目代码迁移到受管工作区后可用。';
  return null;
}
