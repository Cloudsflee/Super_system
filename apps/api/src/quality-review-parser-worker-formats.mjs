import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';

import { modulePathFor, decodeUtf8Strict, normalizeText, qualityError } from './quality-review-parser-worker-utils.mjs';
import { assertValidImage } from './quality-review-parser-worker-images.mjs';
import { assertZipContainerWithinLimits, unzip } from './quality-review-parser-worker-zip.mjs';

const MAX_PDF_PAGES = 500;
const MAX_XLSX_CELLS = 100_000;

export async function extractText(file, kind, remainingImageCount = Number.POSITIVE_INFINITY) {
  if (kind === 'text') return extractLineText(file.bytes, 'quality_review_text_invalid');
  if (kind === 'json') return extractJsonText(file.bytes);
  if (kind === 'xml') return extractXmlText(file.bytes);
  if (kind === 'pdf') return extractPdfText(file.bytes, remainingImageCount);
  if (kind === 'docx') return extractDocxText(file.bytes, remainingImageCount);
  if (kind === 'xlsx') return extractXlsxText(file.bytes);
  return { text: '', segments: [] };
}

async function extractPdfText(bytes, maxImages) {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw qualityError('quality_review_pdf_invalid');
  try {
    return await extractPdfWithPdfjs(bytes, maxImages);
  } catch (error) {
    if (String(error?.code || '').startsWith('quality_review_')) throw error;
    throw qualityError('quality_review_pdf_invalid');
  }
}

async function extractPdfWithPdfjs(bytes, maxImages) {
  const modulePath = modulePathFor('pdfjs-dist', ['legacy', 'build', 'pdf.mjs']),
    pdfjs = await import(pathToFileURL(modulePath).href),
    document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  if (!document.numPages || document.numPages > MAX_PDF_PAGES)
    throw qualityError(
      document.numPages > MAX_PDF_PAGES ? 'quality_review_pdf_page_count_exceeded' : 'quality_review_pdf_invalid',
      { max_pages: MAX_PDF_PAGES }
    );
  const pages = await readPdfPages(document),
    scanPages = pages.filter((item) => !item.text.trim()).map((item) => item.number);
  if (scanPages.length > maxImages) throw qualityError('quality_review_image_count_exceeded');
  const reviewImages = await renderScanPages(document, scanPages);
  return {
    text: normalizeText(pages.map((item) => item.text).join('\n')),
    segments: pages.map((item) => ({ locator: `page:${item.number}`, text: normalizeText(item.text) })),
    image_count: scanPages.length,
    scan_page_count: scanPages.length,
    review_images: reviewImages,
    limitations: scanPages.length ? [`PDF 包含 ${scanPages.length} 个无文本层扫描页；扫描页仅作为图片输入。`] : []
  };
}

async function readPdfPages(document) {
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number),
      content = await page.getTextContent();
    pages.push({ number, text: content.items.map((item) => item.str || '').join(' ') });
  }
  return pages;
}

async function renderScanPages(document, pageNumbers) {
  if (!pageNumbers.length) return [];
  const modulePath = modulePathFor('@napi-rs/canvas', ['index.js']),
    canvasModule = await import(pathToFileURL(modulePath).href),
    createCanvas = canvasModule.createCanvas;
  if (typeof createCanvas !== 'function') throw qualityError('quality_review_pdf_renderer_unavailable');
  const images = [];
  for (const pageNumber of pageNumbers) images.push(await renderPdfPage(document, pageNumber, createCanvas));
  return images;
}

async function renderPdfPage(document, pageNumber, createCanvas) {
  const page = await document.getPage(pageNumber),
    viewport = page.getViewport({ scale: 1 }),
    scale = Math.min(1.5, 2048 / Math.max(viewport.width, viewport.height, 1)),
    scaledViewport = page.getViewport({ scale }),
    canvas = createCanvas(Math.max(1, Math.ceil(scaledViewport.width)), Math.max(1, Math.ceil(scaledViewport.height))),
    context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
  return {
    path: `page-${pageNumber}.png`,
    media_type: 'image/png',
    bytes: canvas.toBuffer('image/png')
  };
}

async function extractDocxText(bytes, maxImages) {
  assertZipContainerWithinLimits(bytes);
  try {
    return await extractDocxStructure(bytes, maxImages);
  } catch (error) {
    if (String(error?.code || '').startsWith('quality_review_')) throw error;
    throw qualityError('quality_review_docx_invalid');
  }
}

async function extractDocxStructure(bytes, maxImages) {
  const entries = unzip(bytes),
    documentXml = entries.get('word/document.xml');
  if (!documentXml || !entries.has('[Content_Types].xml')) throw qualityError('quality_review_docx_invalid');
  const segments = parseDocxSegments(documentXml),
    reviewImages = await docxImages(entries, maxImages);
  return {
    text: normalizeText(segments.map((item) => item.text).join('\n')),
    segments,
    image_count: reviewImages.length,
    review_images: reviewImages,
    limitations: reviewImages.length ? ['DOCX 嵌入图片作为独立视觉输入，未伪造 OCR 文本。'] : []
  };
}

function parseDocxSegments(bytes) {
  const text = decodeUtf8Strict(bytes, 'quality_review_docx_invalid'),
    parser = new SaxesParser({ xmlns: true }),
    segments = [],
    tables = [];
  let paragraph = null,
    paragraphNumber = 0,
    tableNumber = 0,
    textDepth = 0,
    parseFailure = null;
  parser.on('error', (error) => {
    parseFailure = error;
  });
  parser.on('doctype', () => {
    parseFailure = new Error('xml_doctype_not_supported');
  });
  parser.on('opentag', (tag) => {
    const name = xmlLocalName(tag);
    if (name === 'tbl') {
      tableNumber += 1;
      tables.push({ number: tableNumber, row: 0, cell: 0, paragraph: 0 });
    } else if (name === 'tr' && tables.length) {
      tables.at(-1).row += 1;
      tables.at(-1).cell = 0;
      tables.at(-1).paragraph = 0;
    } else if (name === 'tc' && tables.length) {
      tables.at(-1).cell += 1;
      tables.at(-1).paragraph = 0;
    } else if (name === 'p') {
      const table = tables.at(-1);
      if (table) table.paragraph += 1;
      else paragraphNumber += 1;
      paragraph = {
        locator: table
          ? `table:${table.number}/row:${Math.max(1, table.row)}/cell:${Math.max(1, table.cell)}/paragraph:${table.paragraph}`
          : `paragraph:${paragraphNumber}`,
        parts: []
      };
    } else if (name === 't') textDepth += 1;
    else if (paragraph && name === 'tab') paragraph.parts.push('\t');
    else if (paragraph && (name === 'br' || name === 'cr')) paragraph.parts.push('\n');
  });
  parser.on('text', (value) => {
    if (paragraph && textDepth) paragraph.parts.push(value);
  });
  parser.on('closetag', (tag) => {
    const name = xmlLocalName(tag);
    if (name === 't') textDepth = Math.max(0, textDepth - 1);
    else if (name === 'p' && paragraph) {
      const value = normalizeText(paragraph.parts.join(''));
      if (value) segments.push({ locator: paragraph.locator, text: value });
      paragraph = null;
      textDepth = 0;
    } else if (name === 'tbl') tables.pop();
  });
  try {
    parser.write(text).close();
  } catch (error) {
    parseFailure = error;
  }
  if (parseFailure) throw qualityError('quality_review_docx_invalid');
  return segments;
}

async function docxImages(entries, maxImages) {
  const images = [...entries.entries()].filter(([name]) => /^word\/media\/[^/]+$/i.test(name));
  if (images.length > maxImages) throw qualityError('quality_review_image_count_exceeded', { max_images: maxImages });
  const result = [];
  for (const [name, bytes] of images) {
    const mediaType = imageMediaType(name);
    if (!mediaType) continue;
    await assertValidImage(bytes, mediaType);
    result.push({ path: name, media_type: mediaType, bytes });
  }
  return result;
}

function imageMediaType(name) {
  const extension = String(name)
    .toLowerCase()
    .match(/\.(png|jpe?g|webp|gif)$/)?.[1];
  if (!extension) return null;
  return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
}

async function extractXlsxText(bytes) {
  assertZipContainerWithinLimits(bytes);
  try {
    return await extractXlsxWithLibrary(bytes);
  } catch (error) {
    if (String(error?.code || '').startsWith('quality_review_')) throw error;
    throw qualityError('quality_review_xlsx_invalid');
  }
}

async function extractXlsxWithLibrary(bytes) {
  const modulePath = modulePathFor('xlsx', ['xlsx.mjs']),
    xlsx = await import(pathToFileURL(modulePath).href),
    book = xlsx.read(bytes, { type: 'buffer', cellFormula: true, cellHTML: false });
  if (!book.SheetNames.length) throw qualityError('quality_review_xlsx_invalid');
  const segments = spreadsheetSegments(xlsx, book);
  return { text: normalizeText(segments.map((item) => item.text).join('\n')), segments };
}

function spreadsheetSegments(xlsx, book) {
  const segments = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name],
      cells = Object.keys(sheet)
        .filter((address) => !address.startsWith('!'))
        .map((address) => ({ address, position: xlsx.utils.decode_cell(address), cell: sheet[address] }))
        .sort((left, right) => left.position.r - right.position.r || left.position.c - right.position.c);
    if (segments.length + cells.length > MAX_XLSX_CELLS)
      throw qualityError('quality_review_xlsx_cell_count_exceeded', { max_cells: MAX_XLSX_CELLS });
    for (const { address, cell } of cells) {
      const formula = typeof cell?.f === 'string' && cell.f ? cell.f : null,
        value = cell?.v == null ? '' : String(cell.v),
        text = normalizeText(`${value}${formula ? ` [formula: ${formula}]` : ''}`);
      if (!text) continue;
      segments.push({
        locator: `sheet:${encodeURIComponent(name)}/cell:${address}${formula ? '/formula' : ''}`,
        text
      });
    }
  }
  return segments;
}

function extractJsonText(bytes) {
  const text = decodeUtf8Strict(bytes, 'quality_review_json_invalid');
  try {
    JSON.parse(text);
  } catch {
    throw qualityError('quality_review_json_invalid');
  }
  return lineSegments(text);
}

function extractXmlText(bytes) {
  const text = decodeUtf8Strict(bytes, 'quality_review_xml_invalid'),
    parser = new SaxesParser({ xmlns: true }),
    errors = [];
  parser.on('error', (error) => errors.push(error));
  parser.on('doctype', () => errors.push(new Error('xml_doctype_not_supported')));
  parser.write(text).close();
  if (errors.length) throw qualityError('quality_review_xml_invalid');
  return lineSegments(text);
}

function extractLineText(bytes, errorCode) {
  return lineSegments(decodeUtf8Strict(bytes, errorCode));
}

function lineSegments(value) {
  const text = normalizeText(value),
    segments = text ? text.split('\n').map((line) => ({ locator: null, text: line })) : [];
  return { text, segments };
}

function xmlLocalName(tag) {
  if (typeof tag === 'string') return tag.includes(':') ? tag.split(':').at(-1) : tag;
  return (
    tag?.local ||
    String(tag?.name || '')
      .split(':')
      .at(-1)
  );
}
