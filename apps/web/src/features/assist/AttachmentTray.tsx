import { FileCode2, Image, Paperclip, Plus, Quote, X } from 'lucide-react';
import { useState } from 'react';
import { api, json } from '../../api/client';
import type { AssistAttachment } from '../../api/types';
import { useIdeContext } from '../../state/ide-context';

type Props = {
  sessionId: string; attachments: AssistAttachment[]; selectedIds: string[];
  onSelected: (ids: string[]) => void; onCreated: (item: AssistAttachment) => void; onError: (message: string) => void;
};

export function AttachmentTray(props: Props) {
  const ide = useIdeContext();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'project_file' | 'text' | 'image' | 'artifact'>('project_file');
  const [value, setValue] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function attach(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const item = await api<AssistAttachment>(`/assist/v3/sessions/${props.sessionId}/attachments`, json('POST', body));
      props.onCreated(item); props.onSelected([...new Set([...props.selectedIds, item.id])]); setValue(''); setTitle(''); setOpen(false);
    } catch (error) { props.onError((error as Error).message); } finally { setBusy(false); }
  }
  function submit() {
    if (!value.trim()) return;
    if (kind === 'project_file') void attach({ kind, path: value.trim(), title: title.trim() || value.trim() });
    else if (kind === 'text') void attach({ kind, text: value, title: title.trim() || '文本材料', content_type: 'text/plain' });
    else void attach({ kind, file_ref_id: value.trim(), title: title.trim() || (kind === 'image' ? '图片' : 'Artifact') });
  }
  function toggle(id: string) { props.onSelected(props.selectedIds.includes(id) ? props.selectedIds.filter((item) => item !== id) : [...props.selectedIds, id]); }

  return <div className="attachment-tray">
    <div className="attachment-actions">
      <button type="button" className="attachment-add-button" title="添加附件" onClick={() => setOpen(!open)}><Paperclip size={14} />附件</button>
      <button type="button" disabled={!ide.path || busy} onClick={() => attach({ kind: 'monaco_file', path: ide.path, title: ide.path })}><FileCode2 size={14} />当前文件</button>
      <button type="button" disabled={!ide.path || !ide.selection?.text || busy} onClick={() => attach({ kind: 'selection', path: ide.path, text: ide.selection?.text, title: `${ide.path} · 选区`, selection: ide.selection })}><Quote size={14} />当前选区</button>
    </div>
    {props.attachments.length > 0 && <div className="attachment-chips">{props.attachments.map((item) => <label key={item.id} title={`${item.content_type} · ${formatBytes(item.size_bytes)} · ${item.model_policy}`}><input type="checkbox" checked={props.selectedIds.includes(item.id)} onChange={() => toggle(item.id)} />{item.kind === 'image' ? <Image size={12} /> : <Paperclip size={12} />}<span>{item.title}</span></label>)}</div>}
    {open && <div className="attachment-popover"><header><strong>添加附件元数据</strong><button className="row-icon" onClick={() => setOpen(false)}><X size={14} /></button></header><select aria-label="附件类型" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="project_file">@file 项目文件</option><option value="text">文本</option><option value="image">图片 FileRef</option><option value="artifact">Artifact FileRef</option></select><input aria-label="附件标题" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题（可选）" />{kind === 'text' ? <textarea aria-label="附件内容" rows={4} value={value} onChange={(event) => setValue(event.target.value)} placeholder="粘贴文本" /> : <input aria-label="附件位置" value={value} onChange={(event) => setValue(event.target.value)} placeholder={kind === 'project_file' ? 'src/path/to/file.ts' : 'file_ref_id'} />}<button className="button primary" disabled={!value.trim() || busy} onClick={submit}><Plus size={14} />添加</button></div>}
  </div>;
}

function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
