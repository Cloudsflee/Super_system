import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

const STORAGE_KEY = 'aiws-composer-height-v16';

export function useComposerHeight(root: RefObject<HTMLElement | null>) {
  const [preferred, setPreferred] = useState<number | null>(() => storedHeight()), [viewport, setViewport] = useState(() => window.innerHeight), [dragging, setDragging] = useState<{ pointer: number; startY: number; startHeight: number } | null>(null);
  useEffect(() => { const resize = () => setViewport(window.innerHeight); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const available = Math.max(84, viewport - (root.current?.getBoundingClientRect().top || viewport - 220) - 58), height = preferred == null ? undefined : Math.min(preferred, available);
  const update = (value: number | null) => { setPreferred(value); if (value == null) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, String(Math.round(value))); };
  const handlers = useMemo(() => ({
    onPointerDown(event: PointerEvent<HTMLDivElement>) { event.currentTarget.setPointerCapture(event.pointerId); setDragging({ pointer: event.pointerId, startY: event.clientY, startHeight: height || root.current?.getBoundingClientRect().height || 180 }); },
    onPointerMove(event: PointerEvent<HTMLDivElement>) { if (!dragging || dragging.pointer !== event.pointerId) return; update(Math.max(84, dragging.startHeight + dragging.startY - event.clientY)); },
    onPointerUp(event: PointerEvent<HTMLDivElement>) { if (dragging?.pointer === event.pointerId) { event.currentTarget.releasePointerCapture(event.pointerId); setDragging(null); } },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) { if (dragging?.pointer === event.pointerId) setDragging(null); },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const step = event.shiftKey ? 48 : 12, current = height || root.current?.getBoundingClientRect().height || 180; update(Math.max(84, current + (event.key === 'ArrowUp' ? step : -step))); },
    onDoubleClick() { update(null); }
  }), [dragging, height, root]);
  return { height, available, dragging: Boolean(dragging), handlers };
}
function storedHeight() { const value = Number(localStorage.getItem(STORAGE_KEY)); return Number.isFinite(value) && value >= 84 ? value : null; }
