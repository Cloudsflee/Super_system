import { BadgePlus, FileText, GitBranch, Library, ListTree, Search } from 'lucide-react';
import type { BriefTemplate } from '../../../api/types';
import { IconButton } from '../../../components/common/IconButton';
import { templateDomainLabel } from '../../../components/common/display-labels';

export type BriefMobilePane = 'brief' | 'outline' | 'workflow';

export function BriefMobileTabs({ pane, onPane }: { pane: BriefMobilePane; onPane: (value: BriefMobilePane) => void }) {
  const tabs = [
    ['brief', '简报', FileText],
    ['outline', '大纲', ListTree],
    ['workflow', '工作流', GitBranch]
  ] as const;
  return (
    <nav className="brief-mobile-tabs" aria-label="简报工作区视图">
      {tabs.map(([value, label, Icon]) => (
        <button
          className={pane === value ? 'active' : ''}
          aria-pressed={pane === value}
          key={value}
          onClick={() => onPane(value)}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
    </nav>
  );
}

export function BriefTemplateActions({
  busy,
  open,
  templates,
  onOpen,
  onSearch,
  onSave,
  onApply
}: {
  busy: boolean;
  open: boolean;
  templates: BriefTemplate[];
  onOpen: (value: boolean) => void;
  onSearch: () => void;
  onSave: () => void;
  onApply: (template: BriefTemplate) => void;
}) {
  return (
    <div className="brief-template-actions">
      <IconButton label="检索权威简报模板" disabled={busy} onClick={onSearch}>
        <Search size={15} />
      </IconButton>
      <div>
        <IconButton label="个人模板库" active={open} disabled={busy} onClick={() => onOpen(!open)}>
          <Library size={15} />
        </IconButton>
        {open && (
          <div className="brief-template-menu" role="menu">
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => {
                onSave();
                onOpen(false);
              }}
            >
              <BadgePlus size={14} />
              保存当前结构
            </button>
            {templates.map((template) => (
              <button
                role="menuitem"
                disabled={busy}
                key={template.id}
                onClick={() => {
                  onApply(template);
                  onOpen(false);
                }}
              >
                <span>
                  <strong>{template.title}</strong>
                  <small>
                    {templateDomainLabel(template.domain)} · 第 {template.version} 版
                  </small>
                </span>
              </button>
            ))}
            {!templates.length && <p>模板库为空</p>}
          </div>
        )}
      </div>
    </div>
  );
}
