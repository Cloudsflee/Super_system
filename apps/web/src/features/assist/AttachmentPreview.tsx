import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileQuestion, X } from 'lucide-react';
import { AssistMarkdown } from './AssistMarkdown';
import { fetchV2Binary } from '../../api';

type AttachmentLike = {
  id: string;
  title?: string;
  filename?: string;
  media_type?: string;
  content_type?: string;
  detected_mime_type?: string;
  preview_kind?: string;
  size_bytes?: number;
  byte_length?: number;
  disposition?: string;
  content_deleted_at?: string | null;
};

export default function AttachmentPreview({ attachment, onClose }: { attachment: AttachmentLike; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const ref = useRef<HTMLElement>(null);
  const title = attachment.title || attachment.filename || attachment.id;
  const kind = String(attachment.preview_kind || previewKind(attachment.media_type || attachment.content_type || ''));
  const contentUrl = `/api/v2/attachments/${encodeURIComponent(attachment.id)}/preview`;
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focus = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button,a[href]')?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !ref.current) return;
      const controls = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')];
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { cancelAnimationFrame(focus); document.removeEventListener('keydown', key, true); queueMicrotask(() => prior?.focus()); };
  }, [onClose]);
  useEffect(() => {
    if (!['text', 'markdown', 'json', 'csv'].includes(kind) || attachment.content_deleted_at) return undefined;
    const controller = new AbortController();
      fetchV2Binary(contentUrl, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`preview_${response.status}`);
      const payload = await response.json().catch(() => null);
      if (payload?.data?.content_base64) return decodeBase64(payload.data.content_base64);
      if (payload?.content_base64) return decodeBase64(payload.content_base64);
      return response.text();
    }).then((value) => setText(String(value).slice(0, 2_000_000))).catch((reason) => { if (reason?.name !== 'AbortError') setError(String(reason?.message || '预览加载失败')); });
    return () => controller.abort();
  }, [attachment.content_deleted_at, contentUrl, kind]);
  const body = attachment.content_deleted_at ? <PreviewState text="内容不可用" /> : error ? <PreviewState text="预览不可用" /> : kind === 'markdown' ? <AssistMarkdown>{text}</AssistMarkdown> : kind === 'json' ? <pre>{formatJson(text)}</pre> : kind === 'csv' ? <CsvPreview text={text} /> : ['text', 'docx', 'xlsx', 'pdf'].includes(kind) ? <pre>{text || `正在加载 ${kind} 预览`}</pre> : <PreviewState text="可查看元数据或下载原文件" />;
  return <div className="preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={ref} className="preview-dialog" role="dialog" aria-modal="true" aria-label={`${title} 预览`} tabIndex={-1}><header><div><strong>{title}</strong><small>{attachment.detected_mime_type || attachment.media_type || attachment.content_type || '文件'} · {formatBytes(attachment.size_bytes ?? attachment.byte_length ?? 0)}</small></div><a className="icon-button" aria-label="下载原文件" href={`/api/v2/attachments/${encodeURIComponent(attachment.id)}/content`} download><Download size={15} /></a><button className="icon-button" aria-label="关闭预览" title="关闭预览" onClick={onClose}><X size={15} /></button></header><main className="preview-main">{body}</main></section></div>;
}

function PreviewState({ text }: { text: string }) { return <div className="preview-state"><FileQuestion size={28} /><p>{text}</p></div>; }
function formatJson(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
function CsvPreview({ text }: { text: string }) { const rows = text.split(/\r?\n/).slice(0, 500).map(parseCsvRow); return <div className="preview-table"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>; }
export function parseCsvRow(value: string) { const cells: string[] = []; let cell = ''; let quoted = false; for (let index = 0; index < value.length; index += 1) { const char = value[index]; if (quoted && char === '"') { if (value[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false; } else if (!quoted && char === ',') { cells.push(cell); cell = ''; } else if (!quoted && char === '"' && !cell) quoted = true; else cell += char; } cells.push(cell); return cells; }
function previewKind(value: string) { const type = value.toLowerCase(); if (type.includes('markdown')) return 'markdown'; if (type.includes('json')) return 'json'; if (type.includes('csv')) return 'csv'; if (type.includes('pdf')) return 'pdf'; if (type.includes('word') || type.includes('docx')) return 'docx'; if (type.includes('sheet') || type.includes('xlsx')) return 'xlsx'; if (type.startsWith('text/')) return 'text'; return 'metadata'; }
function decodeBase64(value: string) { try { const binary = atob(value); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return new TextDecoder().decode(bytes); } catch { return ''; } }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
