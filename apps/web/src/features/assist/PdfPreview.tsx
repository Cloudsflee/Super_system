import { useEffect, useState } from 'react';
import { fetchV2Binary } from '../../api';

export default function PdfPreview({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => { const controller = new AbortController(); fetchV2Binary(url, { signal: controller.signal }).then(() => setState('ready')).catch((reason) => { if (reason?.name !== 'AbortError') setState('error'); }); return () => controller.abort(); }, [url]);
  return state === 'error' ? <p role="alert">PDF 预览不可用</p> : <div className="pdf-preview" data-state={state}><span>{state === 'ready' ? 'PDF 已准备好预览' : '正在加载 PDF 预览'}</span></div>;
}
