import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { WorkflowTaskViewModel } from './WorkflowTaskViewModel';
import { selectDefaultWorkflowTask } from './WorkflowTaskViewModel';

export const MASTER_DETAIL_MIN_WIDTH = 1360;
export type WorkflowProcessLayout = 'accordion' | 'master-detail';
export type TransientTask = { taskId: string; anchor: HTMLElement };

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

export function useWorkflowTaskSelection(
  tasks: WorkflowTaskViewModel[],
  layout: WorkflowProcessLayout,
  resetKey: string
) {
  const [pinnedTaskId, setPinnedTaskId] = useState<string | null>(null);
  const [transient, setTransient] = useState<TransientTask | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const taskIds = useMemo(() => new Set(tasks.map((item) => item.id)), [tasks]);
  const taskIdKey = tasks.map((item) => item.id).join('\u0000');
  const defaultTaskId = useMemo(() => selectDefaultWorkflowTask(tasks), [tasks]);
  const validPinnedTaskId = pinnedTaskId && taskIds.has(pinnedTaskId) ? pinnedTaskId : null;
  const transientTaskId = transient && taskIds.has(transient.taskId) ? transient.taskId : null;
  const displayedTaskId = transientTaskId || validPinnedTaskId || defaultTaskId;

  const clearTimer = (timer: RefObject<number | null>) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const clearTimers = () => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
  };
  const beginTransient = (taskId: string, anchor: HTMLElement, delay: number) => {
    clearTimers();
    const commit = () => {
      openTimer.current = null;
      setTransient({ taskId, anchor });
    };
    if (delay > 0) openTimer.current = window.setTimeout(commit, delay);
    else commit();
  };
  const restoreSelection = (delay: number) => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
    const commit = () => {
      closeTimer.current = null;
      setTransient(null);
    };
    if (delay > 0) closeTimer.current = window.setTimeout(commit, delay);
    else commit();
  };
  const cancelRestore = () => clearTimer(closeTimer);
  const setPin = (taskId: string) => {
    clearTimers();
    setPinnedTaskId(taskId);
    setTransient(null);
  };
  const togglePin = (taskId: string) => {
    clearTimers();
    setPinnedTaskId((current) => (current === taskId ? null : taskId));
    setTransient(null);
  };

  useEffect(() => {
    if (pinnedTaskId && !taskIds.has(pinnedTaskId)) setPinnedTaskId(null);
    if (transient && !taskIds.has(transient.taskId)) setTransient(null);
  }, [pinnedTaskId, taskIdKey, taskIds, transient]);
  useEffect(() => {
    clearTimers();
    setPinnedTaskId(null);
    setTransient(null);
  }, [resetKey]);
  useEffect(() => {
    clearTimers();
    setTransient(null);
  }, [layout]);
  useEffect(() => () => clearTimers(), []);

  return {
    defaultTaskId,
    pinnedTaskId: validPinnedTaskId,
    transientTaskId,
    transientAnchor: transientTaskId ? transient?.anchor || null : null,
    displayedTaskId,
    beginTransient,
    restoreSelection,
    cancelRestore,
    setPin,
    togglePin
  };
}
