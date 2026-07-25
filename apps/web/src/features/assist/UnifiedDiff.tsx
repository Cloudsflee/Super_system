import { MessageSquarePlus } from 'lucide-react';

export type DiffSelection = { line: number; side: 'old' | 'new'; raw: string };
type DiffLine = { raw: string; kind: 'add' | 'delete' | 'context' | 'header' | 'meta'; oldLine?: number; newLine?: number };

export function UnifiedDiff({ diff, path, selection, onSelect }: { diff: string; path: string; selection?: DiffSelection | null; onSelect: (value: DiffSelection) => void }) {
  const lines = parseDiff(fileDiff(diff, path));
  if (!lines.length) return <div className="quiet-empty"><p>该文件没有可显示的文本差异</p></div>;
  return <div className="unified-diff" role="table" aria-label={`${path} unified diff`}>
    {lines.map((line, index) => {
      const target = line.kind === 'delete' ? line.oldLine : line.newLine;
      const side = line.kind === 'delete' ? 'old' as const : 'new' as const;
      const selectable = Boolean(target && ['add', 'delete', 'context'].includes(line.kind));
      const selected = Boolean(selection && selection.line === target && selection.side === side);
      return <button role="row" disabled={!selectable} className={`${line.kind}${selected ? ' selected' : ''}`} key={`${index}:${line.raw}`} onClick={() => target && onSelect({ line: target, side, raw: line.raw })}><span>{line.oldLine || ''}</span><span>{line.newLine || ''}</span><code>{line.raw || ' '}</code>{selectable && <MessageSquarePlus size={11} />}</button>;
    })}
  </div>;
}

function fileDiff(diff: string, path: string) {
  const chunks = String(diff || '').split(/(?=^diff --git )/m).filter(Boolean);
  return chunks.find((chunk) => chunk.startsWith(`diff --git a/${path} b/${path}`) || chunk.includes(` b/${path}\n`)) || '';
}

function parseDiff(value: string): DiffLine[] {
  let oldLine = 0, newLine = 0, inHunk = false;
  return value.split(/\r?\n/).map((raw): DiffLine => {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; return { raw, kind: 'header' }; }
    if (!inHunk) return { raw, kind: 'meta' };
    if (raw.startsWith('+') && !raw.startsWith('+++')) return { raw, kind: 'add', newLine: newLine++ };
    if (raw.startsWith('-') && !raw.startsWith('---')) return { raw, kind: 'delete', oldLine: oldLine++ };
    if (raw.startsWith(' ')) return { raw, kind: 'context', oldLine: oldLine++, newLine: newLine++ };
    return { raw, kind: 'meta' };
  });
}
