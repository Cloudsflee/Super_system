type OfficeRequest = { kind: 'docx' | 'xlsx'; buffer: ArrayBuffer };
self.onmessage = async (event: MessageEvent<OfficeRequest>) => {
  try {
    let html = '';
    if (event.data.kind === 'docx') {
      const mammoth = await import('mammoth/mammoth.browser');
      html = (await mammoth.convertToHtml({ arrayBuffer: event.data.buffer })).value;
    } else {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(event.data.buffer, { type: 'array', cellHTML: false, cellFormula: false, bookVBA: false, bookFiles: false, sheetRows: 5000 });
      const sheet = workbook.Sheets[workbook.SheetNames[0]]; html = sheet ? XLSX.utils.sheet_to_html(sheet, { editable: false }) : '';
    }
    self.postMessage({ html: html.slice(0, 2_000_000) });
  } catch (error) { self.postMessage({ error: (error as Error).message }); }
};
export {};
