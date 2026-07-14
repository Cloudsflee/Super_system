import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = path.resolve('apps/web/dist'), manifestFile = path.join(dist, '.vite', 'manifest.json');
assert.ok(fs.existsSync(manifestFile), 'Vite manifest exists');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const entries = Object.entries(manifest), entry = entries.find(([, value]) => value.isEntry);
assert.ok(entry, 'main entry exists');

const initial = closure(entry[0]), initialBytes = gzipFiles(initial);
assert.ok(initialBytes <= 300 * 1024, `initial bundle ${format(initialBytes)} exceeds 300 KiB gzip`);
assert.equal([...initial].some((file) => /(?:monaco|pdf|mammoth|xlsx|vendor-flow|xterm)/i.test(file)), false, 'heavy engines stay out of initial graph');

const assistEntry = entries.find(([key, value]) => /AssistWorkbench(?:\.tsx|-)/.test(`${key} ${value.src || ''} ${value.file || ''}`));
assert.ok(assistEntry, 'Assist dynamic entry exists');
const assistFiles = closure(assistEntry[0]), assistIncrement = new Set([...assistFiles].filter((file) => !initial.has(file))), assistBytes = gzipFiles(assistIncrement);
assert.ok(assistBytes <= 250 * 1024, `Assist increment ${format(assistBytes)} exceeds 250 KiB gzip`);

const engineFiles = fs.readdirSync(path.join(dist, 'assets')).filter((file) => /(?:pdf-|PdfPreview|mammoth|xlsx|OfficePreview)/i.test(file));
for (const file of engineFiles) assert.ok(gzipFile(path.join(dist, 'assets', file)) <= 650 * 1024, `${file} exceeds 650 KiB gzip`);
const workerFiles = fs.readdirSync(path.join(dist, 'assets')).filter((file) => /(?:monaco|\.worker|worker\.)/i.test(file));
for (const worker of workerFiles) assert.equal(initial.has(`assets/${worker}`), false, `${worker} must not enter initial graph`);

console.log(`bundle budgets passed: initial ${format(initialBytes)}, Assist +${format(assistBytes)}, ${engineFiles.length} preview assets, ${workerFiles.length} workers isolated`);

function closure(key, result = new Set(), seen = new Set()) {
  if (seen.has(key)) return result; seen.add(key);
  const item = manifest[key]; if (!item) return result;
  if (item.file) result.add(item.file); for (const css of item.css || []) result.add(css); for (const asset of item.assets || []) result.add(asset);
  for (const dependency of item.imports || []) closure(dependency, result, seen);
  return result;
}
function gzipFiles(files) { return [...files].reduce((total, file) => total + (fs.existsSync(path.join(dist, file)) ? gzipFile(path.join(dist, file)) : 0), 0); }
function gzipFile(file) { return gzipSync(fs.readFileSync(file), { level: 9 }).length; }
function format(bytes) { return `${(bytes / 1024).toFixed(1)} KiB gzip`; }
