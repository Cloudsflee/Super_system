export function renderOfficePreview(input: { kind: 'docx' | 'xlsx'; buffer: ArrayBuffer }): string {
  // Worker boundary keeps parsing isolated; the API may return a pre-rendered
  // bounded representation, which is sanitized before insertion by the UI.
  if (!input?.buffer || input.buffer.byteLength === 0) return '';
  return `<p>${input.kind.toUpperCase()} document (${input.buffer.byteLength} bytes)</p>`;
}

if (typeof self !== 'undefined' && 'postMessage' in self) {
  self.addEventListener('message', (event) => {
    try { (self as unknown as Worker).postMessage({ html: renderOfficePreview(event.data) }); }
    catch { (self as unknown as Worker).postMessage({ error: 'office_preview_failed' }); }
  });
}
