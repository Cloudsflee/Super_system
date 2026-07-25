import { useEffect, useRef, useState } from 'react';
import { previewErrorLabel } from '../../components/common/display-labels';

export default function PdfPreview({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), [error, setError] = useState('');
  useEffect(() => { let cancelled = false, task: import('pdfjs-dist').PDFDocumentLoadingTask | null = null; void import('pdfjs-dist').then(async (pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    task = pdfjs.getDocument({ url, isEvalSupported: false }); const pdf = await task.promise, page = await pdf.getPage(1), viewport = page.getViewport({ scale: Math.min(2, window.devicePixelRatio || 1.4) });
    if (cancelled || !canvas.current) return; canvas.current.width = viewport.width; canvas.current.height = viewport.height; const parameters = { canvasContext: canvas.current.getContext('2d')!, viewport } as Parameters<typeof page.render>[0]; await page.render(parameters).promise;
  }).catch((reason) => { if (!cancelled) setError(reason.message); }); return () => { cancelled = true; void task?.destroy(); }; }, [url]);
  return error ? <p className="attachment-preview-error">PDF 解析失败：{previewErrorLabel(error)}</p> : <canvas className="attachment-pdf-preview" ref={canvas} />;
}
