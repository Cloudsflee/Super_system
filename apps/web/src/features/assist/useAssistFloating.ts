import { useEffect } from 'react';
import { useUi, type AssistGeometry } from '../../state/ui';

export function useAssistFloating(active: boolean) {
  const geometry = useUi((state) => state.assistGeometry);
  const setGeometry = useUi((state) => state.setAssistGeometry);
  useEffect(() => {
    if (!active) return;
    const clamp = () => setGeometry(clampGeometry(useUi.getState().assistGeometry));
    window.addEventListener('resize', clamp); clamp();
    return () => window.removeEventListener('resize', clamp);
  }, [active, setGeometry]);
  function start(event: React.PointerEvent, kind: 'move' | 'resize') {
    if (kind === 'move' && (event.target as HTMLElement).closest('button,input,select')) return;
    event.preventDefault();
    const initial = useUi.getState().assistGeometry, startX = event.clientX, startY = event.clientY;
    const move = (next: PointerEvent) => {
      const dx = next.clientX - startX, dy = next.clientY - startY;
      setGeometry(clampGeometry(kind === 'move' ? { ...initial, x: initial.x + dx, y: initial.y + dy } : { ...initial, width: initial.width + dx, height: initial.height + dy }));
    };
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true });
  }
  function grow() {
    const current = useUi.getState().assistGeometry;
    setGeometry(clampGeometry({ ...current, width: current.width + 48, height: current.height + 32 }));
  }
  return { geometry, style: active ? { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height } : undefined, startMove: (event: React.PointerEvent) => start(event, 'move'), startResize: (event: React.PointerEvent) => start(event, 'resize'), grow };
}

function clampGeometry(value: AssistGeometry): AssistGeometry {
  const width = Math.min(Math.max(520, value.width), Math.max(520, window.innerWidth - 16));
  const height = Math.min(Math.max(420, value.height), Math.max(420, window.innerHeight - 64));
  return { width, height, x: Math.max(8, Math.min(value.x, window.innerWidth - width - 8)), y: Math.max(64, Math.min(value.y, window.innerHeight - height - 8)) };
}
