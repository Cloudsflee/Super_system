import { Gauge, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../components/common/IconButton';

export function TurnUsage({ usage }: { usage: Record<string, unknown> }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close); }, [open]);
  const rows = Object.entries(usage).filter(([, value]) => Number.isFinite(Number(value)));
  if (!rows.length) return null;
  return <div className="turn-usage" ref={root}><IconButton label="查看本次回复用量" aria-expanded={open} onClick={() => setOpen(!open)}><Gauge size={13} /></IconButton>{open && <div className="turn-usage-popover" role="dialog" aria-label="本次回复用量"><header><strong>用量</strong><IconButton label="关闭用量" onClick={() => setOpen(false)}><X size={13} /></IconButton></header>{rows.map(([key, value]) => <div key={key}><span>{usageLabel(key)}</span><strong>{Number(value).toLocaleString()}</strong></div>)}</div>}</div>;
}
function usageLabel(value: string) { return ({ input_tokens: '输入', cached_input_tokens: '缓存输入', output_tokens: '输出', reasoning_output_tokens: '推理', total_tokens: '总计' } as Record<string, string>)[value] || value.replaceAll('_', ' '); }
