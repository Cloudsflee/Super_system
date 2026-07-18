import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { sanitizeOfficePreviewHtml } from '../features/assist/OfficePreview';
import { renderOfficePreview } from '../features/assist/office-preview.worker';

describe('Office attachment preview', () => {
  it('removes executable markup and remote attributes', () => {
    const html = sanitizeOfficePreviewHtml('<table style="color:red"><tr><td onclick="alert(1)">Safe</td></tr></table><img src="https://invalid.test/x" onerror="alert(2)"><script>alert(3)</script>');
    expect(html).toContain('Safe');
    expect(html).not.toMatch(/script|onclick|onerror|style=|src=/i);
  });

  it('renders an XLSX workbook with the maintained SheetJS build', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Status'], ['Focus OS', 'Ready']]), 'Summary');
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const html = await renderOfficePreview({ kind: 'xlsx', buffer: bytes });
    expect(html).toContain('Focus OS');
    expect(html).toContain('Ready');
  });
});
