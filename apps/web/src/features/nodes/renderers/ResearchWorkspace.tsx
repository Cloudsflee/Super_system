import { Link2, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { RendererProps } from '../registry';
import { saveWorkspaceData } from './shared';
import { useUi } from '../../../state/ui';
import { useAssistSurface } from '../../../components/assist/semantic-actions';

type Source = { id: string; title: string; url: string; evidence: string; citation: string };
export function ResearchWorkspace({ value, onSaved }: RendererProps) {
  const initial = Array.isArray(value.data.sources) ? value.data.sources as Source[] : [];
  const [sources, setSources] = useState<Source[]>(initial);
  const toast = useUi((state) => state.toast);
  const update = (id: string, patch: Partial<Source>) => setSources((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const add = () => setSources((items) => [...items, { id: crypto.randomUUID(), title: '', url: '', evidence: '', citation: '' }]);
  const setPrimary = (field: keyof Omit<Source, 'id'>, input: unknown) => setSources((items) => {
    const next = items.length ? [...items] : [{ id: crypto.randomUUID(), title: '', url: '', evidence: '', citation: '' }];
    next[0] = { ...next[0], [field]: String(input ?? '') }; return next;
  });
  useAssistSurface({ id: 'research-workspace', fields: {
    'research.source.title': { label: '首个来源标题', elementId: 'research-source-title', set: (input) => setPrimary('title', input) },
    'research.source.url': { label: '首个来源 URL', elementId: 'research-source-url', set: (input) => setPrimary('url', input) },
    'research.source.evidence': { label: '首个来源证据', elementId: 'research-source-evidence', set: (input) => setPrimary('evidence', input) },
    'research.source.citation': { label: '首个来源引用', elementId: 'research-source-citation', set: (input) => setPrimary('citation', input) }
  } });
  async function save() { try { await saveWorkspaceData(value.node.id, { sources }); await onSaved(); toast('调研资料已保存'); } catch (error) { toast((error as Error).message, 'error'); } }
  return (
    <div className="research-workspace"><header className="content-header"><div><span className="overline">来源与证据</span><h2>来源与证据</h2></div><div><button className="button secondary" onClick={add}><Plus size={15} />来源</button><button className="button primary" onClick={save}><Save size={15} />保存</button></div></header>
      <div className="source-table"><div className="source-head"><span>来源</span><span>证据</span><span>引用</span><span /></div>{sources.map((source, index) => <div className="source-row" key={source.id}><div><input id={index === 0 ? 'research-source-title' : undefined} aria-label={`来源 ${index + 1} 标题`} value={source.title} onChange={(e) => update(source.id, { title: e.target.value })} placeholder="标题" /><label className="inline-url"><Link2 size={13} /><input id={index === 0 ? 'research-source-url' : undefined} aria-label={`来源 ${index + 1} URL`} value={source.url} onChange={(e) => update(source.id, { url: e.target.value })} placeholder="URL / 代码仓库路径" /></label></div><textarea id={index === 0 ? 'research-source-evidence' : undefined} aria-label={`来源 ${index + 1} 证据`} value={source.evidence} onChange={(e) => update(source.id, { evidence: e.target.value })} rows={3} /><textarea id={index === 0 ? 'research-source-citation' : undefined} aria-label={`来源 ${index + 1} 引用`} value={source.citation} onChange={(e) => update(source.id, { citation: e.target.value })} rows={3} /><button className="row-icon" aria-label="删除来源" onClick={() => setSources((items) => items.filter((item) => item.id !== source.id))}><Trash2 size={15} /></button></div>)}</div>
      {!sources.length && <div className="quiet-empty"><Link2 size={23} /><p>尚无来源</p></div>}
    </div>
  );
}
