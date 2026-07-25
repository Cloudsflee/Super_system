import { Check, GitPullRequest, LayoutDashboard, List, ListTree, Rows2, Rows3, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../components/common/IconButton';
import { ToolbarMenu } from '../../components/common/ToolbarMenu';
import type { WorkflowTaskDensity } from '../../state/ui';

export type WorkflowView = 'outcomes' | 'process';

export function WorkflowRouteToolbar({
  view,
  density,
  replanOpen,
  canReplan,
  onView,
  onDensity,
  onReplan
}: {
  view: WorkflowView;
  density: WorkflowTaskDensity;
  replanOpen: boolean;
  canReplan: boolean;
  onView: (value: WorkflowView) => void;
  onDensity: (value: WorkflowTaskDensity) => void;
  onReplan: () => void;
}) {
  const [densityOpen, setDensityOpen] = useState(false);
  const densityTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (view !== 'process') setDensityOpen(false);
  }, [view]);

  return (
    <div className="workflow-route-toolbar" aria-label="工作流视图工具">
      <div className="workflow-view-switch" role="tablist" aria-label="工作流视图">
        <button type="button" role="tab" aria-selected={view === 'outcomes'} onClick={() => onView('outcomes')}>
          <LayoutDashboard size={15} />
          成果视图
        </button>
        <button type="button" role="tab" aria-selected={view === 'process'} onClick={() => onView('process')}>
          <ListTree size={15} />
          完整流程
        </button>
      </div>
      {view === 'process' && (
        <div className="workflow-density-menu">
          <IconButton
            ref={densityTrigger}
            label={`显示设置，当前${densityLabel(density)}`}
            active={densityOpen}
            aria-haspopup="menu"
            aria-expanded={densityOpen}
            onClick={() => setDensityOpen((value) => !value)}
          >
            <Settings2 size={16} />
          </IconButton>
          <ToolbarMenu
            open={densityOpen}
            label="显示密度"
            triggerRef={densityTrigger}
            onClose={() => setDensityOpen(false)}
            focusSelected
          >
            {DENSITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={density === option.value}
                onClick={() => {
                  onDensity(option.value);
                  setDensityOpen(false);
                }}
              >
                <option.icon size={15} />
                <span>{option.label}</span>
                {density === option.value && <Check size={14} />}
              </button>
            ))}
          </ToolbarMenu>
        </div>
      )}
      <IconButton
        className="workflow-replan-open"
        label="重新规划"
        active={replanOpen}
        aria-expanded={replanOpen}
        disabled={!canReplan}
        onClick={onReplan}
      >
        <GitPullRequest size={16} />
      </IconButton>
    </div>
  );
}

const DENSITY_OPTIONS = [
  { value: 'compact', label: '紧凑', icon: List },
  { value: 'comfortable', label: '舒适', icon: Rows2 },
  { value: 'detailed', label: '详细', icon: Rows3 }
] as const;

function densityLabel(value: WorkflowTaskDensity) {
  return DENSITY_OPTIONS.find((item) => item.value === value)?.label || '舒适';
}
