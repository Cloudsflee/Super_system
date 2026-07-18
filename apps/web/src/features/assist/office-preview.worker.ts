type OfficeRequest = { kind: 'docx' | 'xlsx'; buffer: ArrayBuffer };
self.onmessage = async (event: MessageEvent<OfficeRequest>) => {
  try { self.postMessage({ html: await renderOfficePreview(event.data) }); }
  catch (error) { self.postMessage({ error: (error as Error).message }); }
};

export async function renderOfficePreview(request: OfficeRequest) {
  let html = '';
  if (request.kind === 'docx') {
    const mammoth = await import('mammoth/mammoth.browser');
    html = (await mammoth.convertToHtml({ arrayBuffer: request.buffer })).value;
  } else {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(request.buffer, { type: 'array', cellHTML: false, cellFormula: false, bookVBA: false, bookFiles: false, sheetRows: 5000 });
    const sheet = workbook.Sheets[workbook.SheetNames[0]]; html = sheet ? XLSX.utils.sheet_to_html(sheet, { editable: false }) : '';
  }
  return html.slice(0, 2_000_000);
}
export {};
