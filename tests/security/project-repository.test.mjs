import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readMultipartUpload } from '../../apps/api/src/http-body.mjs';
import { canonicalImportPath, normalizeRepositorySource, validateGitUrl } from '../../apps/api/src/modules/repository/adapter.mjs';

function multipart(parts, boundary = 'r3-boundary', chunkSize = 7) {
  const body = Buffer.from(parts.map((part) => {
    const disposition = part.filename
      ? `form-data; name="${part.name || 'files'}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    return `--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${part.contentType || 'text/plain'}\r\n\r\n${part.body}\r\n`;
  }).join('') + `--${boundary}--\r\n`);
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += chunkSize) chunks.push(body.subarray(offset, offset + chunkSize));
  const request = Readable.from(chunks);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

async function rejectsWithCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code);
}

test('repository source adapters enforce HTTPS and canonical local allowlists', (t) => {
  assert.throws(() => validateGitUrl('http://github.com/ORG/REPO', ['github.com']), (error) => error.code === 'repository_source_invalid');
  assert.throws(() => validateGitUrl('https://user:pass@github.com/ORG/REPO', ['github.com']), (error) => error.code === 'repository_source_invalid');
  assert.throws(() => validateGitUrl('https://git.example.test/ORG/REPO', ['github.com']), (error) => error.code === 'repository_source_invalid');
  assert.equal(new URL(validateGitUrl('https://github.com/ORG/REPO', ['github.com'])).hostname, 'github.com');
  assert.throws(() => normalizeRepositorySource({ kind: 'git', url: 'https://user@github.com/ORG/REPO' }, { projectGitHosts: ['github.com'] }), (error) => error.code === 'repository_source_invalid');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-path-policy-'));
  const nested = path.join(root, 'nested');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-path-outside-'));
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'README.md'), 'fixture');
  try {
    assert.equal(canonicalImportPath(nested, [root]), fs.realpathSync(nested));
    assert.throws(() => canonicalImportPath(path.join(root, '..', path.basename(outside)), [root]), (error) => error.code === 'repository_source_invalid');
    let linked = false;
    try { fs.symlinkSync(outside, path.join(root, 'junction'), 'junction'); linked = true; } catch { /* Host may disallow junction creation. */ }
    if (linked) assert.throws(() => canonicalImportPath(path.join(root, 'junction'), [root]), (error) => error.code === 'repository_source_invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  if (!t) return undefined;
});

test('multipart intake rejects traversal and enforces file and byte limits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-upload-'));
  try {
    const valid = await readMultipartUpload(multipart([
      { name: 'files', filename: 'src/main.mjs', body: 'export default 1;' },
      { name: 'files', filename: 'README.md', body: '# fixture' },
      { name: 'mode', body: 'existing' }
    ]), { maxFiles: 2, maxFileBytes: 64, maxTotalBytes: 128 }, home);
    assert.equal(valid.files.length, 2);
    assert.deepEqual(valid.files.map((file) => file.path), ['src/main.mjs', 'README.md']);
    assert.equal(valid.fields.mode, 'existing');
    assert.ok(fs.existsSync(valid.staging_root));
    fs.rmSync(valid.staging_root, { recursive: true, force: true });

    await rejectsWithCode(() => readMultipartUpload(multipart([{ filename: '../escape.txt', body: 'x' }]), {}, home), 'repository_source_invalid');
    await rejectsWithCode(() => readMultipartUpload(multipart([{ filename: 'C:/escape.txt', body: 'x' }]), {}, home), 'repository_source_invalid');
    await rejectsWithCode(() => readMultipartUpload(multipart([{ filename: '.git/config', body: 'x' }]), {}, home), 'repository_source_invalid');
    await rejectsWithCode(() => readMultipartUpload(multipart([{ filename: 'nested/.AIWS/state.json', body: 'x' }]), {}, home), 'repository_source_invalid');
    await rejectsWithCode(() => readMultipartUpload(multipart([
      { filename: 'same.txt', body: '1' }, { filename: 'same.txt', body: '2' }
    ]), {}, home), 'repository_source_invalid');
    await rejectsWithCode(() => readMultipartUpload(multipart([
      { filename: 'a.txt', body: '1' }, { filename: 'b.txt', body: '2' }
    ]), { maxFiles: 1 }, home), 'upload_limit_exceeded');
    await rejectsWithCode(() => readMultipartUpload(multipart([{ filename: 'large.txt', body: '12345' }]), { maxFileBytes: 4 }, home), 'upload_limit_exceeded');
    await rejectsWithCode(() => readMultipartUpload(multipart([{ filename: 'a.txt', body: '1234' }, { filename: 'b.txt', body: '5678' }]), { maxTotalBytes: 7 }, home), 'upload_limit_exceeded');
    const uploadRoot = path.join(home, '.staging', 'uploads');
    assert.deepEqual(fs.readdirSync(uploadRoot), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
