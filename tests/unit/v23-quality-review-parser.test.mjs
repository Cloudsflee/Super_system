import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { createCanvas } from '@napi-rs/canvas';
import * as XLSX from 'xlsx';

import { buildAnchors, qualityReviewAnchorResolves } from '../../apps/api/src/quality-review-parser.mjs';

const textMatrix = [
  ['plain.txt', 'text/plain', 'alpha\nbeta', 'text'],
  ['readme.md', 'text/markdown', '# Heading\nBody', 'text'],
  ['data.json', 'application/json', '{"ok":true}', 'json'],
  ['rows.csv', 'text/csv', 'name,value\nalpha,1', 'text'],
  ['result.xml', 'application/xml', '<result><ok>true</ok></result>', 'xml'],
  ['drawing.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>', 'xml']
];
for (const [path, mediaType, content, kind] of textMatrix) {
  const result = await parseFiles([{ path, media_type: mediaType, bytes: Buffer.from(content) }]);
  assert.equal(result.files[0].kind, kind, path);
  assert.ok(result.normalized_text.length > 0, path);
}

const separated = await parseFiles([
  { path: 'one.txt', media_type: 'text/plain', bytes: Buffer.from('one\ntwo') },
  { path: 'two.txt', media_type: 'text/plain', bytes: Buffer.from('three') }
]);
assert.equal(separated.files[1].segments[0].locator, 'line:6');
assert.equal(separated.normalized_text.split('\n')[5], 'three');
assert.match(separated.normalized_text, /--- two\.txt ---/);
assertAnchors(separated, 'asset-version-text');

const textPdf = await parseFiles([
  { path: 'text.pdf', media_type: 'application/pdf', bytes: pdfFixture('PDF anchor text') }
]);
assert.equal(textPdf.files[0].kind, 'pdf');
assert.equal(textPdf.files[0].segments[0].locator, 'page:1');
assert.match(textPdf.normalized_text, /PDF anchor text/);
assertAnchors(textPdf, 'asset-version-pdf');

const scannedPdf = await parseFiles([{ path: 'scan.pdf', media_type: 'application/pdf', bytes: pdfFixture('') }]);
assert.equal(scannedPdf.image_count, 1);
assert.equal(scannedPdf.files[0].segments[0].locator, 'page:1');
assert.equal(scannedPdf.files[0].segments[0].text, '');
assertAnchors(scannedPdf, 'asset-version-scan-pdf');

const docx = await parseFiles([
  {
    path: 'document.docx',
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: docxFixture()
  }
]);
assert.ok(docx.files[0].segments.some((item) => item.locator === 'paragraph:1' && item.text === 'Introduction'));
assert.ok(
  docx.files[0].segments.some((item) => item.locator === 'table:1/row:1/cell:2/paragraph:1' && item.text === 'Cell B1')
);
assertAnchors(docx, 'asset-version-docx');

const xlsx = await parseFiles([
  {
    path: 'workbook.xlsx',
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: xlsxFixture()
  }
]);
assert.ok(xlsx.files[0].segments.some((item) => item.locator === 'sheet:Summary/cell:A1'));
assert.ok(xlsx.files[0].segments.some((item) => item.locator === 'sheet:Summary/cell:C2/formula'));
assert.ok(xlsx.files[0].segments.some((item) => item.locator === 'sheet:Details/cell:A1'));
assertAnchors(xlsx, 'asset-version-xlsx');

const images = imageFixtures();
for (const image of images) {
  const result = await parseFiles([image]);
  assert.equal(result.files[0].kind, 'image', image.path);
  assert.equal(result.files[0].segments[0].locator, 'frame:1', image.path);
  assert.equal(result.image_count, 1, image.path);
  assertAnchors(result, `asset-version-${image.path}`);
}
const octetPng = await parseFiles([
  { path: 'opaque.bin', media_type: 'application/octet-stream', bytes: images[0].bytes }
]);
assert.equal(octetPng.files[0].kind, 'image');
assert.equal(octetPng.review_images[0].media_type, 'image/png');

await assertFailure(
  [{ path: 'mismatch.jpg', media_type: 'image/jpeg', bytes: images[0].bytes }],
  'quality_review_media_type_conflict'
);
await assertFailure(
  [{ path: 'empty.txt', media_type: 'text/plain', bytes: Buffer.alloc(0) }],
  'quality_review_file_empty'
);
await assertFailure(
  [{ path: 'broken.json', media_type: 'application/json', bytes: Buffer.from('{"ok":') }],
  'quality_review_json_invalid'
);
await assertFailure(
  [{ path: 'broken.xml', media_type: 'application/xml', bytes: Buffer.from('<root>') }],
  'quality_review_xml_invalid'
);
await assertFailure(
  [{ path: 'broken.pdf', media_type: 'application/pdf', bytes: Buffer.from('%PDF-not-valid') }],
  'quality_review_pdf_invalid'
);
await assertFailure(
  [
    {
      path: 'broken.docx',
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: zipFixture([{ name: '[Content_Types].xml', data: '<Types />' }])
    }
  ],
  'quality_review_docx_invalid'
);
await assertFailure(
  [
    {
      path: 'broken.xlsx',
      media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: zipFixture([{ name: '[Content_Types].xml', data: '<Types />' }])
    }
  ],
  'quality_review_xlsx_invalid'
);
await assertFailure(
  [
    {
      path: 'bomb.docx',
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: zipFixture([
        { name: '[Content_Types].xml', data: '<Types />' },
        { name: 'word/document.xml', data: '<w:document />', uncompressedSize: 26 * 1024 * 1024 }
      ])
    }
  ],
  'quality_review_zip_entry_too_large'
);
await assertFailure(
  [{ path: 'large.txt', media_type: 'text/plain', bytes: Buffer.from('01234567890') }],
  'quality_review_normalized_text_exceeded',
  { max_normalized_text_chars: 10 }
);
await assertFailure([images[0]], 'quality_review_image_count_exceeded', { max_direct_images: 0 });

console.log('V2.3 parser format matrix, media identity, limits, and evidence anchor tests passed');

async function parseFiles(files, options = {}) {
  const message = await workerMessage({ files, max_direct_images: 20, ...options });
  if (!message.ok) {
    const error = new Error(message.error.code);
    error.code = message.error.code;
    error.details = message.error.details;
    throw error;
  }
  return message.result;
}

async function assertFailure(files, code, options = {}) {
  await assert.rejects(
    () => parseFiles(files, options),
    (error) => error.code === code,
    code
  );
}

function workerMessage(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../apps/api/src/quality-review-parser-worker.mjs', import.meta.url));
    worker.once('message', (message) => {
      void worker.terminate();
      resolve(message);
    });
    worker.once('error', reject);
    worker.postMessage(input);
  });
}

function assertAnchors(result, versionId) {
  const version = { id: versionId },
    anchors = buildAnchors({}, version, result.files);
  assert.ok(anchors.length > 0, versionId);
  assert.ok(
    anchors.every((anchor) => qualityReviewAnchorResolves(version, result.files, anchor)),
    versionId
  );
  for (const anchor of anchors) {
    assert.equal(anchor.asset_version_id, versionId);
    assert.ok(anchor.path);
    assert.ok(anchor.locator);
  }
}

function imageFixtures() {
  const canvas = createCanvas(4, 4),
    context = canvas.getContext('2d');
  context.fillStyle = '#e32636';
  context.fillRect(0, 0, 4, 4);
  return [
    { path: 'image.png', media_type: 'image/png', bytes: canvas.toBuffer('image/png') },
    { path: 'image.jpg', media_type: 'image/jpeg', bytes: canvas.toBuffer('image/jpeg') },
    { path: 'image.webp', media_type: 'image/webp', bytes: canvas.toBuffer('image/webp') },
    {
      path: 'image.gif',
      media_type: 'image/gif',
      bytes: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
    }
  ];
}

function docxFixture() {
  return zipFixture([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />'
    },
    {
      name: 'word/document.xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:t>Introduction</w:t></w:r></w:p>',
        '<w:tbl><w:tr>',
        '<w:tc><w:p><w:r><w:t>Cell A1</w:t></w:r></w:p></w:tc>',
        '<w:tc><w:p><w:r><w:t>Cell B1</w:t></w:r></w:p></w:tc>',
        '</w:tr></w:tbl>',
        '</w:body></w:document>'
      ].join('')
    }
  ]);
}

function xlsxFixture() {
  const workbook = XLSX.utils.book_new(),
    summary = XLSX.utils.aoa_to_sheet([
      ['Metric', 'Value', 'Calculated'],
      ['Total', 4, { t: 'n', v: 8, f: 'B2*2' }]
    ]),
    details = XLSX.utils.aoa_to_sheet([['Detail'], ['Alpha']]);
  XLSX.utils.book_append_sheet(workbook, summary, 'Summary');
  XLSX.utils.book_append_sheet(workbook, details, 'Details');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

function pdfFixture(text) {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${escapePdf(text)}) Tj ET` : '',
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
  let output = '%PDF-1.4\n',
    offset = Buffer.byteLength(output),
    offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    output += object;
    offset += Buffer.byteLength(object);
  }
  const xref = offset;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const position of offsets.slice(1)) output += `${String(position).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'binary');
}

function escapePdf(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function zipFixture(entries) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46),
      uncompressed = entry.uncompressedSize ?? data.length;
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    const localEntry = Buffer.concat([local, name, data]);
    locals.push(localEntry);
    centrals.push(Buffer.concat([central, name]));
    offset += localEntry.length;
  }
  const centralDirectory = Buffer.concat(centrals),
    eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
