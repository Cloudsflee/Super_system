import { useEffect, useRef, useState } from 'react';
import { useUi } from '../../state/ui';

const DEFAULT_WIDTH = 760;
const MIN_WIDTH = 440;
const MIN_WORKSPACE_WIDTH = 360;

export function useAssistDockResize(active: boolean) {
  const width = useUi((state) => state.assistDockWidth);
  const setWidth = useUi((state) => state.setAssistDockWidth);
  const [dragging, setDragging] = useState(false);
  const stopRef = useRef<() => void>(() => undefined);
  const bounds = dockWidthBounds();

  useEffect(() => {
    if (!active) return;
    const clamp = () => setWidth(clampDockWidth(useUi.getState().assistDockWidth));
    window.addEventListener('resize', clamp);
    clamp();
    return () => window.removeEventListener('resize', clamp);
  }, [active, setWidth]);

  useEffect(() => () => stopRef.current(), []);

  function start(event: React.PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopRef.current();
    const initialWidth = useUi.getState().assistDockWidth;
    const startX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    let stopped = false;
    const move = (next: PointerEvent) => setWidth(clampDockWidth(initialWidth + startX - next.clientX));
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      setDragging(false);
    };
    stopRef.current = stop;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }

  function keyDown(event: React.KeyboardEvent) {
    const step = event.shiftKey ? 64 : 24;
    const current = useUi.getState().assistDockWidth;
    const next = event.key === 'ArrowLeft' ? current + step
      : event.key === 'ArrowRight' ? current - step
        : event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : null;
    if (next === null) return;
    event.preventDefault();
    setWidth(clampDockWidth(next));
  }

  return { width, min: bounds.min, max: bounds.max, dragging, start, keyDown, reset: () => setWidth(clampDockWidth(DEFAULT_WIDTH)) };
}

function dockWidthBounds() {
  const viewport = Math.max(1, window.innerWidth);
  const min = Math.min(MIN_WIDTH, viewport);
  const max = viewport <= 1100 ? viewport : Math.max(min, viewport - MIN_WORKSPACE_WIDTH);
  return { min, max };
}

function clampDockWidth(value: number) {
  const { min, max } = dockWidthBounds();
  return Math.round(Math.min(max, Math.max(min, Number(value) || DEFAULT_WIDTH)));
}
