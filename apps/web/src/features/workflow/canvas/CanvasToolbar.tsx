import { Bot, Focus, LayoutGrid, Minus, Plus, Redo2, Shapes, Undo2, ZoomIn } from 'lucide-react';
import { useState } from 'react';
import type { NodeKind } from '../../../api/types';
import { IconButton } from '../../../components/common/IconButton';

type Props = {
  canUndo: boolean; canRedo: boolean;
  onAdd: (type: NodeKind) => void; onTemplate: () => void; onAi: () => void; onLayout: () => void;
  onUndo: () => void; onRedo: () => void; onZoomIn: () => void; onZoomOut: () => void; onFit: () => void;
};
export function CanvasToolbar(props: Props) {
  const [adding, setAdding] = useState(false);
  const options: Array<[NodeKind, string]> = [['goal_definition', '目标'], ['research', '调研'], ['analysis', '分析'], ['execution', '执行'], ['retrospective', '复盘']];
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="工作流工具栏">
      <div className="tool-group add-tool"><IconButton label="添加节点" active={adding} onClick={() => setAdding(!adding)}><Plus size={18} /></IconButton>{adding && <div className="tool-menu">{options.map(([type, label]) => <button key={type} onClick={() => { props.onAdd(type); setAdding(false); }}><span className={`type-swatch ${type}`} />{label}</button>)}</div>}</div>
      <IconButton label="应用模板" onClick={props.onTemplate}><Shapes size={18} /></IconButton>
      <IconButton label="AI 生成工作流" onClick={props.onAi}><Bot size={18} /></IconButton>
      <span className="tool-separator" />
      <IconButton label="自动布局" onClick={props.onLayout}><LayoutGrid size={18} /></IconButton>
      <IconButton label="撤销" disabled={!props.canUndo} onClick={props.onUndo}><Undo2 size={18} /></IconButton>
      <IconButton label="重做" disabled={!props.canRedo} onClick={props.onRedo}><Redo2 size={18} /></IconButton>
      <span className="tool-separator" />
      <IconButton label="放大" onClick={props.onZoomIn}><ZoomIn size={18} /></IconButton>
      <IconButton label="缩小" onClick={props.onZoomOut}><Minus size={18} /></IconButton>
      <IconButton label="适配视图" onClick={props.onFit}><Focus size={18} /></IconButton>
    </div>
  );
}
