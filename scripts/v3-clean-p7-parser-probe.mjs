import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrokerParserAdapter } from '../apps/api/src/clean/parser-adapters.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';
import { start as startBroker } from '../apps/runner-broker/clean-server.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';
import {
  createParserServiceIdentity, publicKey, publicParserReceipt, signedParserJob,
  verifyParserTerminal, waitForParser
} from './lib/v3-clean-p7-parser-probe.mjs';

const execFileAsync = promisify(execFile);

await emitProbe('aiws.v3-clean.p7-parser-probe.v1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p7-parser-probe-'));
  const images = [`aiws-parser:p7-probe-${process.pid}-a`, `aiws-parser:p7-probe-${process.pid}-b`];
  const secret = 'p7-parser-probe-transport-secret';
  let broker;
  try {
    const imageIds = [];
    for (const image of images) {
      await execFileAsync('docker', ['build', '--provenance=false', '--target', 'parser-worker', '-t', image, '.'], dockerOptions(600000));
      const inspected = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], dockerOptions());
      imageIds.push(String(inspected.stdout || '').trim().toLowerCase());
    }
    if (imageIds.length !== 2 || imageIds[0] !== imageIds[1]) throw Object.assign(new Error('parser_image_not_reproducible'), { code: 'parser_image_not_reproducible' });
    const digest = imageIds[0];
    if (digest !== P7_PARSER_IMAGE_DIGEST) throw Object.assign(new Error('parser_image_digest_mismatch'), { code: 'parser_image_digest_mismatch' });
    const workerProbe = await execFileAsync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=134217728,mode=1777', digest, '--probe'], dockerOptions(120000));
    const worker = JSON.parse(String(workerProbe.stdout || '').trim());
    if (worker.status !== 'parsed') throw Object.assign(new Error('parser_worker_probe_failed'), { code: 'parser_worker_probe_failed' });

    const identity = createParserServiceIdentity();
    const servicePublicKey = publicKey(identity);
    broker = await startBroker({ port: 0, secret, stateRoot: path.join(root, 'broker'), runnerDigest: `sha256:${'1'.repeat(64)}`, parserDigest: digest, servicePublicKey });
    const adapter = new BrokerParserAdapter({ baseUrl: broker.url, secret });
    const input = Buffer.from('P7 real isolated parser probe\n');
    const signed = signedParserJob({ identity, input, suffix: 'real_container' });
    const submitted = await adapter.submit(signed.job, { jobSignature: signed.signature, servicePublicKey, input });
    const terminal = await waitForParser(adapter, submitted.job_id);
    const verified = verifyParserTerminal(terminal, signed);
    if (terminal.outputs.length !== 1 || terminal.outputs[0].content_sha256 !== signed.job.input_sha256) throw Object.assign(new Error('parser_output_hash_mismatch'), { code: 'parser_output_hash_mismatch' });
    return {
      image_build_command: 'docker build --provenance=false --target parser-worker',
      image_build_count: imageIds.length, image_ids: imageIds,
      image_digest: digest, digest_reproducible: imageIds.every((value) => value === digest), real_container: true,
      worker_probe: worker, broker_protocol: 'parser.job.v1', receipt_protocol: 'parser.receipt.v1',
      isolation: ['network:none', 'read-only-root', 'cap-drop-all', 'no-new-privileges', 'bounded-tmpfs'],
      receipt: publicParserReceipt(verified.receipt), output_sha256: terminal.outputs[0].content_sha256
    };
  } finally {
    await broker?.close?.();
    for (const image of images) await execFileAsync('docker', ['image', 'rm', '--force', image], dockerOptions()).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function dockerOptions(timeout = 30000) { return { cwd: process.cwd(), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }; }
