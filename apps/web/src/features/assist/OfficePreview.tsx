import { useEffect, useState } from 'react';
import { fetchV2Binary } from '../../api';

export function sanitizeOfficePreviewHtml(html: string) {
  const source = String(html || '');
  if (typeof DOMParser === 'undefined') {
    return source
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/\s(?:style|src|srcset|href|action|formaction|xlink:href|on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }
  const document = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
  const blocked = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'META', 'LINK']);
  document.body.querySelectorAll('*').forEach((element) => {
    if (blocked.has(element.tagName)) { element.remove(); return; }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ['style', 'src', 'srcset', 'href', 'action', 'formaction', 'xlink:href'].includes(name)
          || (['href', 'src'].includes(name) && /^(?:javascript|data):/.test(value))) element.removeAttribute(attribute.name);
    }
  });
  return document.body.innerHTML;
}

export default function OfficePreview({ url, kind }: { url: string; kind: 'docx' | 'xlsx' }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetchV2Binary(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`preview_${response.status}`);
      const value = await response.text();
      setHtml(sanitizeOfficePreviewHtml(value));
    }).catch((reason) => { if (reason?.name !== 'AbortError') setError(String(reason?.message || 'preview_failed')); });
    return () => controller.abort();
  }, [url]);
  if (error) return <p role="alert">Office preview unavailable: {error}</p>;
  return html ? <div className={`office-preview ${kind}`} dangerouslySetInnerHTML={{ __html: html }} /> : <p>Loading {kind} preview</p>;
}
