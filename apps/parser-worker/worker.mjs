import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../api/src/clean/canonical.mjs';
import { parseAssetBytes } from './parser-engine.mjs';

const RESULT_VERSION = 'parser.worker-result.v1';

if (process.argv.includes('--probe')) {
  const result = await parseAssetBytes(Buffer.from('{"probe":true}', 'utf8'), 'json');
  process.stdout.write(`${JSON.stringify({ schema_version: 'parser.worker-probe.v1', status: result.status, runtime: process.version })}\n`);
  process.exitCode = result.status === 'parsed' ? 0 : 1;
} else {
  const jobFile = argument('--job');
  const inputFile = argument('--input');
  const outputRoot = argument('--output');
  if (!jobFile || !inputFile || !outputRoot) throw workerError('parser_worker_arguments_invalid');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const bytes = fs.readFileSync(inputFile);
  if (sha256Hex(bytes) !== String(job.input_sha256 || '') || bytes.byteLength !== Number(job.input_bytes)) {
    throw workerError('parser_input_mismatch');
  }
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const result = await parseAssetBytes(bytes, job.format_key, { limits: job.limits });
  const outputs = [];
  for (const [index, value] of (result.outputs || []).entries()) {
    const output = Buffer.from(value.bytes || []);
    const file = `output-${String(index + 1).padStart(3, '0')}.bin`;
    const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
    fs.writeFileSync(path.join(outputRoot, file), output, { mode: 0o600, flag: 'wx' });
    outputs.push({
      kind: String(value.kind || `output_${index + 1}`),
      file,
      content_sha256: sha256Hex(output),
      byte_length: output.byteLength,
      media_type: String(value.media_type || 'application/octet-stream'),
      metadata,
      metadata_sha256: sha256Hex(canonicalJson(metadata))
    });
  }
  const receipt = {
    schema_version: RESULT_VERSION,
    parser_job_id: String(job.parser_job_id || ''),
    status: String(result.status || 'failed'),
    error_code: String(result.error_code || ''),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    outputs
  };
  const temporary = path.join(outputRoot, `result.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${canonicalJson(receipt)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, path.join(outputRoot, 'result.json'));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : null;
}

function workerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
