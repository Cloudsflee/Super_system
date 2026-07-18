import DOMPurify from 'dompurify';
import { useEffect, useState } from 'react';

export function sanitizeOfficePreviewHtml(html: string) {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['style', 'href', 'src', 'srcset', 'xlink:href', 'action', 'formaction'] });
}

export default function OfficePreview({ url, kind }: { url: string; kind: 'docx' | 'xlsx' }) {
  const [html, setHtml] = useState(''), [error, setError] = useState('');
  useEffect(() => { const worker = new Worker(new URL('./office-preview.worker.ts', import.meta.url), { type: 'module' }), controller = new AbortController(), timeout = window.setTimeout(() => { worker.terminate(); setError('preview_timeout'); }, 15_000); worker.onmessage = (event: MessageEvent<{ html?: string; error?: string }>) => { clearTimeout(timeout); if (event.data.error) setError(event.data.error); else setHtml(sanitizeOfficePreviewHtml(event.data.html || '')); }; fetch(url, { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error(`preview_${response.status}`); return response.arrayBuffer(); }).then((buffer) => worker.postMessage({ kind, buffer }, [buffer])).catch((reason) => { clearTimeout(timeout); if (reason.name !== 'AbortError') setError(reason.message); }); return () => { clearTimeout(timeout); controller.abort(); worker.terminate(); }; }, [kind, url]);
  return error ? <p className="attachment-preview-error">Office 解析失败：{error}</p> : html ? <div className="attachment-office-preview" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="attachment-preview-loading">正在解析文档</p>;
}
