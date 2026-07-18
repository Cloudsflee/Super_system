import { Focus, LayoutGrid, Minus, MoreHorizontal, Plus, Redo2, Undo2, ZoomIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../../components/common/IconButton';

type Props = {
  canUndo: boolean; canRedo: boolean; focusMode: boolean;
  onAdd: () => void; onLayout: () => void; onFocus: () => void;
  onUndo: () => void; onRedo: () => void; onZoomIn: () => void; onZoomOut: () => void; onFit: () => void;
};

export function CanvasToolbar(props: Props) {
  const [menu, setMenu] = useState<'more' | null>(null), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    window.addEventListener('pointerdown', pointer); window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('pointerdown', pointer); window.removeEventListener('keydown', keyboard); };
  }, [menu]);
  function close(restore = false) { setMenu(null); if (restore) queueMicrotask(() => trigger.current?.focus()); }
  function toggle(value: 'more', button: HTMLButtonElement) { trigger.current = button; setMenu(menu === value ? null : value); }
  function run(operation: () => void) { operation(); close(); }
  return <div className="canvas-huds" ref={root}>
    <div className="canvas-toolbar canvas-edit-tools" role="toolbar" aria-label="工作流编辑工具">
      <IconButton label="添加成果节点" onClick={props.onAdd}><Plus size={18} /></IconButton>
      <IconButton label={props.focusMode ? '退出专注模式' : '进入专注模式'} active={props.focusMode} onClick={props.onFocus}><Focus size={17} /></IconButton>
      <div className="tool-group"><IconButton label="更多画布操作" active={menu === 'more'} aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={(event) => toggle('more', event.currentTarget)}><MoreHorizontal size={18} /></IconButton>{menu === 'more' && <div className="tool-menu tool-menu-wide" role="menu" aria-label="画布操作"><button role="menuitem" onClick={() => run(props.onLayout)}><LayoutGrid size={15} />自动布局</button><hr /><button role="menuitem" disabled={!props.canUndo} onClick={() => run(props.onUndo)}><Undo2 size={15} />撤销</button><button role="menuitem" disabled={!props.canRedo} onClick={() => run(props.onRedo)}><Redo2 size={15} />重做</button></div>}</div>
    </div>
    <div className="canvas-toolbar canvas-view-tools" role="toolbar" aria-label="画布视图工具"><IconButton label="放大" onClick={props.onZoomIn}><ZoomIn size={17} /></IconButton><IconButton label="缩小" onClick={props.onZoomOut}><Minus size={17} /></IconButton><IconButton label="适配视图" onClick={props.onFit}><Focus size={17} /></IconButton></div>
  </div>;
}
