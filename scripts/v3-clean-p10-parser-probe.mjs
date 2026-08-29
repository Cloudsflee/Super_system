import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { parseAssetBytes } from '../apps/parser-worker/parser-engine.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';
import { P10_PARSER_IMAGE_DIGEST } from '../apps/api/src/clean/migrations/009-final-business-parity-governance.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

const FORMATS = ['7z','audio','csv','docx','gif','gzip','jpeg','json','markdown','pdf','png','pptx','rar','svg','tar','text','video','webp','xlsx','xml','zip'];
const CONTAINER_RUNNER = `
import fs from 'node:fs';
import { parseAssetBytes } from '/app/apps/parser-worker/parser-engine.mjs';
const manifest = JSON.parse(fs.readFileSync('/fixtures/manifest.json', 'utf8'));
const results = [];
for (const item of manifest.cases) {
  const bytes = fs.readFileSync('/fixtures/' + item.file);
  const parsed = await parseAssetBytes(bytes, item.format, item.limits ? { limits: item.limits } : {});
  results.push({ name: item.name, format: item.format, input_sha256: item.input_sha256, status: parsed.status, error_code: parsed.error_code || '', output_count: parsed.outputs?.length || 0 });
}
console.log(JSON.stringify({ status: 'passed', results }));
`;

await emitProbe('aiws.v3-clean.p10-parser-probe.v1', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p10-parser-probe-'));
  const tags = [`aiws-parser-p10-probe-a:${process.pid}`, `aiws-parser-p10-probe-b:${process.pid}`];
  try {
    const image = ensurePinnedImage(tags);
    const samples = validSamples();
    if (Object.keys(samples).length !== FORMATS.length || FORMATS.some((format) => !samples[format])) throw new Error('parser_fixture_inventory_incomplete');
    const cases = [];
    for (const format of FORMATS) addCase(temporaryRoot, cases, format, format, samples[format]);

    addCase(temporaryRoot, cases, 'malformed', 'gzip', corruptGzipFixture());
    addCase(temporaryRoot, cases, 'signature', 'png', Buffer.from('not-a-png'));
    addCase(temporaryRoot, cases, 'quota', 'text', Buffer.from('0123456789'), { max_text_chars: 5 });
    addCase(temporaryRoot, cases, 'archive_traversal', 'zip', createZip([{ name: '../escape.txt', bytes: Buffer.from('escape') }]));
    addCase(temporaryRoot, cases, 'encrypted_archive', 'zip', createZip([{ name: 'secret.txt', bytes: Buffer.from('encrypted marker'), encrypted: true }]));
    const nested = createZip([{ name: 'nested.gz', bytes: gzipSync(Buffer.alloc(1024 * 1024, 65), { level: 9 }) }]);
    addCase(temporaryRoot, cases, 'nested_bomb', 'zip', nested, { max_compression_ratio: 10, max_expanded_bytes: 2 * 1024 * 1024 });
    fs.writeFileSync(path.join(temporaryRoot, 'manifest.json'), `${JSON.stringify({ cases }, null, 2)}\n`);

    const container = run('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:size=134217728,mode=1777',
      '--mount', `type=bind,src=${temporaryRoot},dst=/fixtures,readonly`,
      '--entrypoint', 'node', image.digest, '--input-type=module', '-e', CONTAINER_RUNNER
    ], 240_000);
    if (container.status !== 0) throw coded('parser_container_failed');
    const parsed = parseLastJson(container.stdout);
    const byName = new Map((parsed?.results || []).map((item) => [item.name, item]));
    const formats = FORMATS.map((format) => byName.get(format));
    const invalidFormats = formats.filter((item) => item?.status !== 'parsed' || item.output_count < 1);
    if (invalidFormats.length) {
      process.stderr.write(`P10 parser format diagnostics: ${JSON.stringify(invalidFormats)}\n`);
      throw coded(`parser_valid_format_failed_${invalidFormats.map((item) => `${item?.format || 'missing'}_${item?.status || 'missing'}_${item?.error_code || 'no_output'}`).join('_')}`);
    }
    const expected = {
      malformed: ['invalid', 'parser_invalid_archive'],
      signature: ['invalid', 'parser_media_signature_mismatch'],
      quota: ['resource_exceeded', 'parser_quota_text'],
      archive_traversal: ['invalid', 'parser_invalid_archive_path'],
      encrypted_archive: ['invalid', 'parser_invalid_encrypted_archive'],
      nested_bomb: ['resource_exceeded', 'parser_quota_compression_ratio']
    };
    for (const [name, [status, errorCode]] of Object.entries(expected)) {
      const item = byName.get(name);
      if (item?.status !== status || item.error_code !== errorCode) {
        process.stderr.write(`P10 parser negative diagnostics: ${JSON.stringify(Object.fromEntries(Object.keys(expected).map((key) => [key, byName.get(key)])))}\n`);
        throw coded(`parser_negative_${name}_failed`);
      }
    }

    const windowsHost = [];
    if (process.platform === 'win32') {
      for (const format of ['zip','tar','gzip','7z','rar']) {
        const result = await parseAssetBytes(samples[format], format);
        windowsHost.push({ format, status: result.status, error_code: result.error_code || '' });
      }
      if (windowsHost.some((item) => item.status !== 'parsed')) {
        process.stderr.write(`P10 Windows archive diagnostics: ${JSON.stringify(windowsHost)}\n`);
        throw coded('parser_windows_archive_wrapper_failed');
      }
    }

    return {
      image_digest: image.digest,
      base_image_digest: P7_PARSER_IMAGE_DIGEST,
      image_build_count: image.build_count,
      image_ids: image.ids,
      digest_reproducible: image.ids.every((value) => value === image.digest),
      real_container: true,
      isolation: ['network:none','read-only-root','cap-drop-all','no-new-privileges','bounded-tmpfs'],
      formats,
      format_count: formats.length,
      valid_samples: formats.filter((item) => item.status === 'parsed').length,
      negatives: Object.fromEntries(Object.keys(expected).map((name) => [name, byName.get(name)])),
      worker_threads: true,
      worker_path: 'apps/parser-worker/archive-worker.mjs',
      windows_host_archive_wrapper: process.platform === 'win32' ? { status: 'passed', formats: windowsHost } : { status: 'not_applicable', formats: [] }
    };
  } finally {
    for (const tag of tags) run('docker', ['image', 'rm', '--force', tag], 60_000);
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function ensurePinnedImage(tags) {
  const base = run('docker', ['image', 'inspect', P7_PARSER_IMAGE_DIGEST, '--format', '{{.Id}}']);
  if (base.status !== 0 || base.stdout.trim() !== P7_PARSER_IMAGE_DIGEST) throw coded('parser_p7_base_digest_missing');
  if (run('docker', ['tag', P7_PARSER_IMAGE_DIGEST, 'aiws-parser:p7-p10-base']).status !== 0) throw coded('parser_p7_base_tag_failed');
  const ids = [];
  for (const tag of tags) {
    const build = run('docker', ['build', '--provenance=false', '--build-arg', 'P10_PARSER_BASE=aiws-parser:p7-p10-base', '--target', 'parser-worker-p10', '--tag', tag, '.'], 600_000);
    if (build.status !== 0) throw coded('parser_image_build_failed');
    const inspect = run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']);
    ids.push(inspect.stdout.trim());
  }
  if (ids.length !== 2 || ids.some((id) => id !== P10_PARSER_IMAGE_DIGEST)) throw coded('parser_image_digest_mismatch');
  run('docker', ['tag', P10_PARSER_IMAGE_DIGEST, 'aiws-parser:p10-fixed']);
  return { digest: P10_PARSER_IMAGE_DIGEST, ids, build_count: 2 };
}

function validSamples() {
  return {
    text: Buffer.from('P10 parser text\n'),
    markdown: Buffer.from('# P10 parser\n\nVerified fixture.\n'),
    json: Buffer.from('{"p10":true,"items":[1,2]}'),
    csv: Buffer.from('name,value\nparity,10\n'),
    xml: Buffer.from('<?xml version="1.0"?><root><item>P10</item></root>'),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#123456"/></svg>'),
    pdf: pdfFixture(),
    docx: docxFixture(),
    xlsx: xlsxFixture(),
    pptx: pptxFixture(),
    png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAUSURBVAiZYxQyCfvPwMDAwMQABQAXpAGf6d+7bgAAAABJRU5ErkJggg==', 'base64'),
    jpeg: Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJYAXGP/2Q==', 'base64'),
    webp: Buffer.from('UklGRhoCAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggLAAAANABAJ0BKgIAAgAAgA4liAJ0ugH4AAOwAP7+ahh/56ZrzB/Xh/5glfkG65AA', 'base64'),
    gif: Buffer.from('R0lGODlhAgACAIEAAAAA/wAAAP///wAAACH5BAEAAAAALAAAAAACAAIAAAgFAAMIBAA7', 'base64'),
    audio: wavFixture(),
    video: Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAGm1kYXQAAAGzABAHAAABthGBRgj2378AAAMcbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAmt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAHjbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABjm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAU5zdGJsAAAA6nN0c2QAAAAAAAAAAQAAANptcDR2AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABCkxhdmMgbXBlZzQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAYGVzZHMAAAAAA4CAgE8AAQAEgICAQSARAAAAAAMNQAAAAtAFgICALwAAAbABAAABtYkTAAABAAAAASAAxI2IAC0AhAIUYwAAAbJMYXZjNjAuMzEuMTAyBoCAgAECAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAADDUAAAALQAAAAGHN0dHMAAAAAAAAAAQAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAABIAAAABAAAAFHN0Y28AAAAAAAAAAQAAACwAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0', 'base64'),
    zip: createZip([{ name: 'sample.txt', bytes: Buffer.from('P10 ZIP fixture\n') }]),
    tar: tarFixture(),
    gzip: gzipSync(Buffer.from('P10 GZIP fixture\n'), { level: 9 }),
    '7z': Buffer.from('N3q8ryccAATbPw0+GAAAAAAAAABiAAAAAAAAAA1dYuYBABNQMTAgYXJjaGl2ZSBmaXh0dXJlCgABBAYAAQkYAAcLAQABISEBAAwUAAgKAbsvJ/4AAAUBGQwAAAAAAAAAAAAAAAARFwBzAGEAbQBwAGwAZQAuAHQAeAB0AAAAGQQAAAAAFAoBAIQGPpuqN90BFQYBACCApIEAAA==', 'base64'),
    rar: Buffer.from('UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAAFAXAxKAIDC5QABJQApIMCuy8n/oAAAQpzYW1wbGUudHh0CgMTucSSatGzyydQMTAgYXJjaGl2ZSBmaXh0dXJlCh13VlEDBQQA', 'base64')
  };
}

function docxFixture() {
  return createZip([
    { name: '[Content_Types].xml', bytes: xml('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', bytes: xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', bytes: xml('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>P10 DOCX fixture</w:t></w:r></w:p><w:sectPr/></w:body></w:document>') }
  ]);
}

function xlsxFixture() {
  return createZip([
    { name: '[Content_Types].xml', bytes: xml('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
    { name: '_rels/.rels', bytes: xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', bytes: xml('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', bytes: xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', bytes: xml('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>P10 XLSX fixture</t></is></c></row></sheetData></worksheet>') }
  ]);
}

function pptxFixture() {
  return createZip([
    { name: '[Content_Types].xml', bytes: xml('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>') },
    { name: '_rels/.rels', bytes: xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>') },
    { name: 'ppt/presentation.xml', bytes: xml('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>') },
    { name: 'ppt/_rels/presentation.xml.rels', bytes: xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>') },
    { name: 'ppt/slides/slide1.xml', bytes: xml('<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>P10 PPTX fixture</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>') }
  ]);
}

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 45 >>\nstream\nBT /F1 12 Tf 20 100 Td (P10 parser) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) value += `${String(offset).padStart(10, '0')} 00000 n \n`;
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value, 'ascii');
}

function wavFixture() {
  const samples = 800;
  const dataSize = samples * 2;
  const value = Buffer.alloc(44 + dataSize);
  value.write('RIFF', 0); value.writeUInt32LE(36 + dataSize, 4); value.write('WAVE', 8);
  value.write('fmt ', 12); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22);
  value.writeUInt32LE(8000, 24); value.writeUInt32LE(16000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write('data', 36); value.writeUInt32LE(dataSize, 40);
  return value;
}

function tarFixture() {
  const content = Buffer.from('P10 TAR fixture\n');
  const header = Buffer.alloc(512, 0);
  Buffer.from('sample.txt').copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  Buffer.from(`${content.length.toString(8).padStart(11, '0')}\0`).copy(header, 124);
  Buffer.from('00000000000\0').copy(header, 136);
  Buffer.from('        ').copy(header, 148);
  header[156] = 48;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  const sum = [...header].reduce((total, byte) => total + byte, 0);
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]);
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const bytes = Buffer.from(entry.bytes);
    const flags = entry.encrypted ? 1 : 0;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30 + name.length + bytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    name.copy(local, 30); bytes.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    localParts.push(local); centralParts.push(central); offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function corruptGzipFixture() {
  const value = gzipSync(Buffer.from('valid before corruption'));
  value[value.length - 1] ^= 0xff;
  return value;
}

function addCase(root, cases, name, format, bytes, limits = null) {
  const file = `${String(cases.length).padStart(2, '0')}-${name.replace(/[^a-z0-9_-]/gi, '_')}.bin`;
  fs.writeFileSync(path.join(root, file), bytes, { flag: 'wx' });
  cases.push({ name, format, file, input_sha256: createHash('sha256').update(bytes).digest('hex'), ...(limits ? { limits } : {}) });
}

function xml(value) { return Buffer.from(value, 'utf8'); }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function run(command, args, timeout = 30_000) { return spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
function parseLastJson(value) { const lines = String(value || '').trim().split(/\r?\n/); for (let index = lines.length - 1; index >= 0; index -= 1) { try { return JSON.parse(lines[index]); } catch { /* inspect earlier output */ } } return null; }
function coded(code) { const error = new Error(code); error.code = code; return error; }
