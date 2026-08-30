import { useEffect, useState } from 'react';
import { fetchV2Binary } from '../../api';

export default function PdfPreview({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => { const controller = new AbortController(); fetchV2Binary(url, { signal: controller.signal }).then(() => setState('ready')).catch((reason) => { if (reason?.name !== 'AbortError') setState('error'); }); return () => controller.abort(); }, [url]);
  return state === 'error' ? <p role="alert">PDF preview unavailable</p> : <div className="pdf-preview" data-state={state}><span>{state === 'ready' ? 'PDF ready for preview' : 'Loading PDF preview'}</span></div>;
}
