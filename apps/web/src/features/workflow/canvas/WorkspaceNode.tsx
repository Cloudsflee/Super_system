import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, CheckCircle2, Clock3, FileOutput, ShieldCheck } from 'lucide-react';
import type { CanvasNode } from './node-types';
import { nodeLabels } from './node-types';

export function WorkspaceNode({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.record;
  const blocked = node.status === 'blocked';
  return (
    <article className={`workspace-node ${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <header><span>{nodeLabels[node.type]}</span><StatusIcon status={node.status} /></header>
      <h3>{node.title}</h3>
      <p>{node.goal || '尚未定义节点目标'}</p>
      <footer>
        <span title="最近运行"><Clock3 size={12} />{node.latest_run?.status || '未运行'}</span>
        <span title="输出"><FileOutput size={12} />{node.output_count || 0}</span>
        <span title="待审批"><ShieldCheck size={12} />{node.pending_approval_count || 0}</span>
      </footer>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'blocked' || status === 'failed') return <AlertCircle size={15} className="node-bad" />;
  if (status === 'completed' || status === 'succeeded') return <CheckCircle2 size={15} className="node-ok" />;
  return <span className={`node-status ${status}`}>{status}</span>;
}
