import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Download, Eye, FileDiff, FolderOpen, LoaderCircle, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { ApiError, apiV2, formatBytes, mutateV2, shortHash } from '../../api';

type Attachment = { id: string; filename: string; media_type: string; byte_length: number; disposition: string; parser_status: string; status: string; revision: number; content_sha256: string };
type FileRef = { id: string; path: string; relative_path?: string; content_sha256: string; byte_length: number; status: string; revision: number };
type Batch = { id: string; workspace_id: string; item_count: number; total_bytes: number; status: string; revision: number; batch_sha256: string };
type BatchItem = { id: string; path: string; action: string; before_sha256?: string | null; after_sha256?: string | null; status: string };
type Workspace = { id: string; status: string; revision: number; relative_path?: string };

export function FilesDrawer({ open, projectId, sessionId, notify, onClose }: { open: boolean; projectId: string; sessionId?: string; notify: (text: string, tone?: 'ok' | 'error') => void; onClose: () => void }) {
  const [tab, setTab] = useState<'attachments' | 'files' | 'changes'>('attachments');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [items, setItems] = useState<BatchItem[]>([]);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [pathValue, setPathValue] = useState('notes.txt');
  const [content, setContent] = useState('');
  const [action, setAction] = useState<'create' | 'replace' | 'delete'>('create');
  const [busy, setBusy] = useState('');
  const selectedBatch = useMemo(() => batches.find((batch) => batch.id === selectedBatchId) || null, [batches, selectedBatchId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [attachmentResult, fileResult, batchResult, workspaceResult] = await Promise.all([
      apiV2<{ attachments: Attachment[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/attachments`),
      apiV2<{ files: FileRef[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/files`),
      apiV2<{ batches: Batch[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/change-batches`),
      apiV2<{ workspaces: Workspace[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/repository-workspaces`)
    ]);
    setAttachments(attachmentResult.data.attachments || []); setFiles(fileResult.data.files || []); setBatches(batchResult.data.batches || []); setWorkspaces(workspaceResult.data.workspaces || []);
    setSelectedBatchId((current) => batchResult.data.batches?.some((batch) => batch.id === current) ? current : batchResult.data.batches?.[0]?.id || '');
  }, [projectId]);

  useEffect(() => { if (open) void load().catch((error) => notify(error instanceof Error ? error.message : 'Files request failed', 'error')); }, [load, notify, open]);
  useEffect(() => {
    if (!selectedBatchId || !open) { setItems([]); return; }
    void apiV2<{ batch: Batch; items: BatchItem[] }>(`/api/v2/change-batches/${encodeURIComponent(selectedBatchId)}/review`).then((result) => setItems(result.data.items || [])).catch(() => setItems([]));
  }, [open, selectedBatchId]);

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy('upload');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/attachments`, { filename: file.name, media_type: file.type || 'application/octet-stream', content_base64: toBase64(bytes), ...(sessionId ? { session_id: sessionId } : {}) }, 'POST', 0);
      await load(); notify('Attachment uploaded');
    } catch (error) { notify(error instanceof Error ? error.message : 'Attachment upload failed', 'error'); } finally { setBusy(''); }
  };

  const showPreview = async (attachment: Attachment) => {
    setBusy(`preview:${attachment.id}`);
    try {
      const result = await apiV2<{ content_base64: string }>(`/api/v2/attachments/${encodeURIComponent(attachment.id)}/preview`);
      setPreview({ name: attachment.filename, content: decodeBase64(result.data.content_base64) });
    } catch (error) { notify(error instanceof Error ? error.message : 'Preview unavailable', 'error'); } finally { setBusy(''); }
  };

  const download = async (attachment: Attachment) => {
    const response = await fetch(`/api/v2/attachments/${encodeURIComponent(attachment.id)}/content`, { headers: { accept: 'application/octet-stream' }, credentials: 'same-origin' });
    if (!response.ok) return notify('Attachment download failed', 'error');
    const link = document.createElement('a'); link.href = URL.createObjectURL(await response.blob()); link.download = attachment.filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };

  const remove = async (attachment: Attachment) => {
    setBusy(`delete:${attachment.id}`);
    try { await mutateV2(`/api/v2/attachments/${encodeURIComponent(attachment.id)}`, {}, 'DELETE', attachment.revision); await load(); setPreview(null); notify('Attachment deleted'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Attachment delete failed', 'error'); } finally { setBusy(''); }
  };

  const createBatch = async (event: FormEvent) => {
    event.preventDefault(); const workspace = workspaces.find((item) => ['ready', 'released'].includes(item.status)) || workspaces[0]; if (!workspace) return notify('Repository workspace is unavailable', 'error');
    setBusy('batch-create');
    try {
      await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/change-batches`, { workspace_id: workspace.id, changes: [{ path: pathValue, action, ...(action === 'delete' ? {} : { content }) }] }, 'POST', workspace.revision);
      await load(); setContent(''); notify('Change batch created');
    } catch (error) { notify(error instanceof Error ? error.message : 'Change batch failed', 'error'); } finally { setBusy(''); }
  };

  const mutateBatch = async (next: 'approve' | 'apply' | 'undo') => {
    if (!selectedBatch) return; setBusy(`batch-${next}`);
    try {
      const result = await mutateV2<Record<string, unknown>>(`/api/v2/change-batches/${encodeURIComponent(selectedBatch.id)}/${next}`, {}, 'POST', selectedBatch.revision);
      const operationId = String((result.data.operation_id || (result.data.operation as { operation_id?: string } | undefined)?.operation_id) || '');
      if (operationId) await waitOperation(operationId);
      await load(); notify(`Change batch ${next === 'approve' ? 'approved' : next === 'apply' ? 'applied' : 'undone'}`);
    } catch (error) { notify(error instanceof ApiError ? error.message : `Change batch ${next} failed`, 'error'); await load().catch(() => undefined); } finally { setBusy(''); }
  };

  if (!open) return null;
  return <><button className="drawer-scrim" aria-label="Close Files" onClick={onClose} /><aside className="files-drawer" aria-label="Files and changes">
    <header><div><FolderOpen size={18} /><strong>Files</strong></div><button className="icon-button" title="Close Files" aria-label="Close Files" onClick={onClose}><X size={17} /></button></header>
    <div className="drawer-tabs" role="tablist"><button className={tab === 'attachments' ? 'active' : ''} onClick={() => setTab('attachments')}>Attachments</button><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Workspace</button><button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Changes</button></div>
    {tab === 'attachments' && <div className="drawer-body"><label className="button file-upload"><Upload size={15} />{busy === 'upload' ? 'Uploading' : 'Upload'}<input type="file" disabled={busy === 'upload'} onChange={(event) => void upload(event.target.files?.[0])} /></label><div className="drawer-list">{attachments.map((attachment) => <div key={attachment.id} className="drawer-row"><span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.byte_length)} · {attachment.disposition} · {attachment.status}</small></span><div><button className="icon-button" title="Preview" aria-label={`Preview ${attachment.filename}`} disabled={attachment.disposition !== 'preview'} onClick={() => void showPreview(attachment)}>{busy === `preview:${attachment.id}` ? <LoaderCircle className="spin" size={14} /> : <Eye size={14} />}</button><button className="icon-button" title="Download" aria-label={`Download ${attachment.filename}`} onClick={() => void download(attachment)}><Download size={14} /></button><button className="icon-button danger" title="Delete" aria-label={`Delete ${attachment.filename}`} onClick={() => void remove(attachment)}><Trash2 size={14} /></button></div></div>)}{!attachments.length && <div className="list-empty">No attachments</div>}</div>{preview && <div className="file-preview"><strong>{preview.name}</strong><pre>{preview.content}</pre></div>}</div>}
    {tab === 'files' && <div className="drawer-body"><div className="drawer-list">{files.map((file) => <div key={file.id} className="drawer-row"><FileDiff size={15} /><span><strong>{file.path || file.relative_path}</strong><small>{formatBytes(file.byte_length)} · {shortHash(file.content_sha256)} · r{file.revision}</small></span></div>)}{!files.length && <div className="list-empty">No indexed files</div>}</div></div>}
    {tab === 'changes' && <div className="drawer-body">
      <form className="change-compose" onSubmit={(event) => void createBatch(event)}>
        <label><span>Path</span><input value={pathValue} onChange={(event) => setPathValue(event.target.value)} required /></label>
        <div className="segmented">
          <button type="button" className={action === 'create' ? 'active' : ''} onClick={() => setAction('create')}>Create</button>
          <button type="button" className={action === 'replace' ? 'active' : ''} onClick={() => setAction('replace')}>Replace</button>
          <button type="button" className={action === 'delete' ? 'active' : ''} onClick={() => setAction('delete')}>Delete</button>
        </div>
        {action !== 'delete' && <label><span>Content</span><textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} /></label>}
        <button className="button" disabled={busy === 'batch-create'}><FileDiff size={15} />Create batch</button>
      </form>
      <div className="drawer-list">
        {batches.map((batch) => <button key={batch.id} className={`drawer-row selectable ${batch.id === selectedBatchId ? 'selected' : ''}`} onClick={() => setSelectedBatchId(batch.id)}><span><strong>{batch.item_count} files · {batch.status}</strong><small>{formatBytes(batch.total_bytes)} · {shortHash(batch.batch_sha256)} · r{batch.revision}</small></span></button>)}
        {!batches.length && <div className="list-empty">No change batches</div>}
      </div>
      {selectedBatch && <div className="batch-review">
        <div className="drawer-list">{items.map((item) => <div className="drawer-row" key={item.id}><span><strong>{item.action} {item.path}</strong><small>{shortHash(item.before_sha256 || '')} -&gt; {shortHash(item.after_sha256 || '')}</small></span></div>)}</div>
        <div className="form-actions">
          {selectedBatch.status === 'proposed' && <button className="button primary" onClick={() => void mutateBatch('approve')}><Check size={15} />Approve</button>}
          {selectedBatch.status === 'approved' && <button className="button primary" onClick={() => void mutateBatch('apply')}><Check size={15} />Apply</button>}
          {selectedBatch.status === 'applied' && <button className="button" onClick={() => void mutateBatch('undo')}><RotateCcw size={15} />Undo</button>}
        </div>
      </div>}
    </div>}
  </aside></>;
}

async function waitOperation(id: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await apiV2<{ status: string }>(`/api/v2/operations/${encodeURIComponent(id)}`); if (['succeeded', 'failed', 'cancelled', 'expired'].includes(result.data.status)) { if (result.data.status !== 'succeeded') throw new Error(`Operation ${result.data.status}`); return; } await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Operation timed out');
}
function toBase64(bytes: Uint8Array) { let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }
function decodeBase64(value: string) { try { return decodeURIComponent(Array.from(atob(value), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')); } catch { return '[preview unavailable]'; } }
