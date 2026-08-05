import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import type { WorkflowTaskViewModel } from './WorkflowTaskViewModel';
import { selectDefaultWorkflowTask } from './WorkflowTaskViewModel';

export const MASTER_DETAIL_MIN_WIDTH = 1360;
export type WorkflowProcessLayout = 'accordion' | 'master-detail';

export function useWorkflowProcessLayout(containerRef: RefObject<HTMLElement | null>) {
  const [measurement, setMeasurement] = useState<{ width: number; layout: WorkflowProcessLayout }>({
    width: 0,
    layout: 'accordion'
  });
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const commit = (width: number) => {
      const next = {
        width,
        layout: width >= MASTER_DETAIL_MIN_WIDTH ? ('master-detail' as const) : ('accordion' as const)
      };
      setMeasurement((current) => (current.width === next.width && current.layout === next.layout ? current : next));
    };
    const measure = () => commit(container.getBoundingClientRect().width || container.clientWidth || 0);
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === container);
      commit(entry?.contentRect.width || container.getBoundingClientRect().width || container.clientWidth || 0);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);
  return measurement;
}

export function useWorkflowTaskSelection(tasks: WorkflowTaskViewModel[], resetKey: string) {
  const [pinnedTaskId, setPinnedTaskId] = useState<string | null>(null);
  const taskIds = useMemo(() => new Set(tasks.map((item) => item.id)), [tasks]);
  const taskIdKey = tasks.map((item) => item.id).join('\u0000');
  const defaultTaskId = useMemo(() => selectDefaultWorkflowTask(tasks), [tasks]);
  const validPinnedTaskId = pinnedTaskId && taskIds.has(pinnedTaskId) ? pinnedTaskId : null;
  const displayedTaskId = validPinnedTaskId || defaultTaskId;

  const setPin = (taskId: string) => setPinnedTaskId(taskId);
  const togglePin = (taskId: string) => {
    setPinnedTaskId((current) => (current === taskId ? null : taskId));
  };

  useEffect(() => {
    if (pinnedTaskId && !taskIds.has(pinnedTaskId)) setPinnedTaskId(null);
  }, [pinnedTaskId, taskIdKey, taskIds]);
  useEffect(() => {
    setPinnedTaskId(null);
  }, [resetKey]);

  return {
    defaultTaskId,
    pinnedTaskId: validPinnedTaskId,
    displayedTaskId,
    setPin,
    togglePin
  };
}
