import { Download, FileQuestion, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AssistAttachment } from '../../api/types';
import { apiUrl } from '../../api/client';
import { IconButton } from '../../components/common/IconButton';
import { AssistMarkdown } from './AssistMarkdown';

const PdfPreview = lazy(() => import('./PdfPreview'));
const OfficePreview = lazy(() => import('./OfficePreview'));

export default function AttachmentPreview({ attachment, onClose }: { attachment: AssistAttachment; onClose: () => void }) {
  const [text, setText] = useState(''), [error, setError] = useState(''), modal = useRef<HTMLElement>(null), kind = attachment.preview_kind || 'metadata';
  const contentUrl = apiUrl(`/assist/v3/attachments/${attachment.id}/content`), downloadUrl = apiUrl(`/assist/v3/attachments/${attachment.id}/download`);
  useEffect(() => { const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null, focusable = () => [...(modal.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),audio[controls],video[controls],[tabindex]:not([tabindex="-1"])') || [])]; const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } else if (event.key === 'Tab') { const items = focusable(); if (!items.length) { event.preventDefault(); modal.current?.focus(); return; } const first = items[0], last = items.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }; window.addEventListener('keydown', keydown, true); requestAnimationFrame(() => { const first = focusable()[0]; if (first) first.focus(); else modal.current?.focus(); }); return () => { window.removeEventListener('keydown', keydown, true); queueMicrotask(() => previous?.focus({ preventScroll: true })); }; }, [onClose]);
  useEffect(() => {
    if (!['text', 'markdown', 'json', 'csv'].includes(kind) || attachment.content_deleted_at) return;
    const controller = new AbortController(); fetch(contentUrl, { signal: controller.signal }).then(async (response) => { if (!response.ok) throw new Error(`preview_${response.status}`); return response.text(); }).then((value) => setText(value.slice(0, 2_000_000))).catch((reason) => { if (reason.name !== 'AbortError') setError(reason.message); }); return () => controller.abort();
  }, [attachment.content_deleted_at, contentUrl, kind]);
  const body = attachment.content_deleted_at ? <PreviewState text="内容已删除" />
    : error ? <PreviewState text={`无法预览：${error}`} />
      : kind === 'image' ? <img className="attachment-image-preview" src={contentUrl} alt={attachment.title} onError={() => setError('image_load_failed')} />
        : kind === 'audio' ? <audio controls src={contentUrl} onError={() => setError('audio_load_failed')} />
          : kind === 'video' ? <video controls src={contentUrl} onError={() => setError('video_load_failed')} />
            : kind === 'pdf' ? <Suspense fallback={<PreviewState text="正在加载 PDF" />}><PdfPreview url={contentUrl} /></Suspense>
              : kind === 'docx' || kind === 'xlsx' ? <Suspense fallback={<PreviewState text="正在加载 Office 预览" />}><OfficePreview url={contentUrl} kind={kind} /></Suspense>
                : kind === 'markdown' ? <div className="attachment-text-preview markdown"><AssistMarkdown>{text}</AssistMarkdown></div>
                  : kind === 'json' ? <pre className="attachment-text-preview">{formatJson(text)}</pre>
                    : kind === 'csv' ? <CsvPreview text={text} />
                      : kind === 'text' ? <pre className="attachment-text-preview">{text}</pre>
                        : <PreviewState text="此格式提供元数据与下载" />;
  return <div className="attachment-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={modal} className="attachment-preview-modal" role="dialog" aria-modal="true" aria-label={`${attachment.title} 预览`} tabIndex={-1}>
    <header><div><strong>{attachment.title}</strong><small>{attachment.detected_mime_type || attachment.content_type} · {formatBytes(attachment.size_bytes)}</small></div><a className="icon-button" data-tooltip="下载原文件" aria-label="下载原文件" href={downloadUrl} download><Download size={15} /></a><IconButton label="关闭预览" onClick={onClose}><X size={16} /></IconButton></header>
    <main>{body}</main>
  </section></div>;
}

function PreviewState({ text }: { text: string }) { return <div className="attachment-preview-state"><FileQuestion size={30} /><p>{text}</p></div>; }
function formatJson(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
function CsvPreview({ text }: { text: string }) { const rows = text.split(/\r?\n/).slice(0, 500).map(parseCsvRow), width = Math.max(0, ...rows.map((row) => row.length)); return <div className="attachment-csv-preview"><table><tbody>{rows.map((row, index) => <tr key={index}>{Array.from({ length: width }, (_, cell) => index ? <td key={cell}>{row[cell] || ''}</td> : <th key={cell}>{row[cell] || ''}</th>)}</tr>)}</tbody></table></div>; }
export function parseCsvRow(value: string) { const cells: string[] = []; let cell = '', quoted = false; for (let index = 0; index < value.length; index++) { const char = value[index]; if (quoted && char === '"') { if (value[index + 1] === '"') { cell += '"'; index++; } else quoted = false; } else if (!quoted && char === ',') { cells.push(cell); cell = ''; } else if (!quoted && char === '"' && cell === '') quoted = true; else cell += char; } cells.push(cell); return cells; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
