import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Append-only Evidence writer. Every receipt is created with exclusive
 * creation flags; a failed/checkpoint receipt can never be replaced in place.
 */
export class ImmutableEvidenceWriter {
  constructor(root, { runId = randomUUID(), resume = false } = {}) {
    this.root = path.resolve(String(root));
    this.runId = safeRunId(runId);
    this.attemptRoot = path.join(this.root, 'attempts', this.runId);
    fs.mkdirSync(path.dirname(this.attemptRoot), { recursive: true });
    if (fs.existsSync(this.attemptRoot) && !resume) throw new Error('evidence_attempt_exists');
    if (!fs.existsSync(this.attemptRoot)) fs.mkdirSync(this.attemptRoot, { recursive: false, mode: 0o700 });
    this.created = new Set(fs.readdirSync(this.attemptRoot, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
  }

  write(name, value) {
    const target = this.#target(name);
    const payload = typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(target, payload, { flag: 'wx', mode: 0o600 });
    this.created.add(path.basename(target));
    return target;
  }

  writeText(name, value) { return this.write(name, String(value)); }

  finalize(verification, manifest = null) {
    const final = verification && typeof verification === 'object' ? verification : { status: 'failed' };
    const verificationPath = this.write('verification.json', final);
    const manifestValue = manifest || { schema_version: 'aiws.v3.evidence.manifest.v1', status: final.status || 'failed', run_id: this.runId, files: [...this.created].sort() };
    const manifestPath = this.write('manifest.json', manifestValue);
    return { verification: verificationPath, manifest: manifestPath };
  }

  resume(runId = this.runId) {
    const base = safeRunId(runId);
    const attempts = path.join(this.root, 'attempts');
    const existing = fs.existsSync(attempts) ? fs.readdirSync(attempts).filter((name) => name === base || name.startsWith(`${base}-`)) : [];
    let suffix = existing.includes(base) ? 2 : 1;
    while (existing.includes(`${base}-${suffix}`)) suffix += 1;
    return new ImmutableEvidenceWriter(this.root, { runId: `${base}-${suffix}` });
  }

  #target(name) {
    const relative = String(name || '').replaceAll('\\', '/');
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('evidence_path_invalid');
    const target = path.resolve(this.attemptRoot, relative);
    if (!target.startsWith(this.attemptRoot + path.sep)) throw new Error('evidence_path_invalid');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    return target;
  }
}

export function createEvidenceWriter(root, options = {}) { return new ImmutableEvidenceWriter(root, options); }

function safeRunId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('evidence_run_id_invalid');
  return id;
}
