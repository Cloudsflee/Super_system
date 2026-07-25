import { Activity, Bot, Check, ChevronDown, ChevronRight, Focus, MoreHorizontal, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../api/types';
import { useOperationFeedback, OperationDiagnosticsButton } from '../../operations/OperationFeedback';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { ToolbarMenu } from '../common/ToolbarMenu';
import { Tooltip } from '../common/Tooltip';

export function WorkflowProjectBreadcrumb({
  projects,
  current,
  onSelect
}: {
  projects: Project[];
  current?: Project;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = current?.title || '暂无项目';
  useEffect(() => setOpen(false), [current?.id]);

  return (
    <nav className="workflow-project-breadcrumb" aria-label="工作流项目">
      <span>工作流</span>
      <ChevronRight size={13} aria-hidden="true" />
      <div className="workflow-project-switcher">
        <Tooltip label={label}>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`当前项目：${label}`}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={!projects.length}
            onClick={() => setOpen((value) => !value)}
          >
            <span>{label}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </Tooltip>
        <ToolbarMenu open={open} label="切换项目" triggerRef={triggerRef} onClose={() => setOpen(false)} focusSelected>
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={project.id === current?.id}
              onClick={() => {
                setOpen(false);
                onSelect(project.id);
              }}
            >
              <span>{project.title}</span>
              {project.id === current?.id && <Check size={14} />}
            </button>
          ))}
        </ToolbarMenu>
      </div>
    </nav>
  );
}

export function WorkflowHeaderActions({ compact }: { compact: boolean }) {
  const ui = useUi();
  const feedback = useOperationFeedback();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusLabel = ui.focusMode ? '退出专注模式' : '进入专注模式';

  if (!compact)
    return (
      <div className="workflow-global-actions" role="group" aria-label="全局操作">
        <OperationDiagnosticsButton />
        <IconButton
          label="审批队列"
          active={ui.approvalCenterOpen || Boolean(ui.proposalId)}
          onClick={() => ui.openApprovalCenter(!ui.approvalCenterOpen)}
        >
          <ShieldCheck size={18} />
        </IconButton>
        <IconButton
          label="打开 Codex 智能助手"
          active={ui.assistOpen && ui.contextLane === 'assist'}
          onClick={() => ui.setAssist(!(ui.assistOpen && ui.contextLane === 'assist'))}
        >
          <Bot size={19} />
        </IconButton>
        <IconButton label={focusLabel} active={ui.focusMode} onClick={ui.toggleFocusMode}>
          <Focus size={18} />
        </IconButton>
      </div>
    );

  return (
    <div className="workflow-mobile-actions">
      <IconButton
        label="打开 Codex 智能助手"
        active={ui.assistOpen && ui.contextLane === 'assist'}
        onClick={() => ui.setAssist(!(ui.assistOpen && ui.contextLane === 'assist'))}
      >
        <Bot size={19} />
      </IconButton>
      <div className="workflow-more-menu">
        <IconButton
          ref={triggerRef}
          label="更多工作流操作"
          active={open}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={19} />
        </IconButton>
        <ToolbarMenu open={open} label="更多工作流操作" triggerRef={triggerRef} onClose={() => setOpen(false)}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              feedback.setOpen(true);
            }}
          >
            <Activity size={16} />
            <span>操作与诊断</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              ui.openApprovalCenter(true);
            }}
          >
            <ShieldCheck size={16} />
            <span>审批队列</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              ui.toggleFocusMode();
            }}
          >
            <Focus size={16} />
            <span>{focusLabel}</span>
          </button>
        </ToolbarMenu>
      </div>
    </div>
  );
}

export function useCompactWorkflowHeader() {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 700px)').matches)
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 700px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
