import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class VaultError extends Error {
  constructor(code, message, details = {}, status = 422) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

/** Small filesystem vault used by the clean credential adapter. */
export class VaultAdapter {
  constructor({ root, masterKey, fsModule = fs } = {}) {
    if (!root) throw new TypeError('vault_root_required');
    if (masterKey == null || String(masterKey).length < 1) throw new TypeError('vault_master_key_required');
    this.root = path.resolve(String(root));
    this.fs = fsModule;
    this.key = normalizeKey(masterKey);
    this.fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  put(ref, value) {
    const cleanRef = validateRef(ref);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([Buffer.from('AIWSVLT1'), iv, tag, ciphertext]);
    const file = this.#file(cleanRef);
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    this.fs.writeFileSync(temp, payload, { mode: 0o600, flag: 'wx' });
    try {
      this.fs.renameSync(temp, file);
    } catch (error) {
      try { this.fs.rmSync(temp, { force: true }); } catch { /* preserve failure */ }
      throw new VaultError('vault_write_failed', 'credential vault write failed', { reason: String(error?.code || 'rename_failed') }, 503);
    }
    return { external_ref: `vault:${cleanRef}`, byte_length: bytes.length };
  }

  read(ref) {
    const cleanRef = validateRef(String(ref).replace(/^vault:/, ''));
    const payload = this.fs.readFileSync(this.#file(cleanRef));
    if (payload.subarray(0, 8).toString() !== 'AIWSVLT1' || payload.length < 36) throw new VaultError('vault_corrupt', 'credential vault entry is corrupt', {}, 503);
    const iv = payload.subarray(8, 20);
    const tag = payload.subarray(20, 36);
    const ciphertext = payload.subarray(36);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new VaultError('vault_decrypt_failed', 'credential vault entry could not be decrypted', {}, 503);
    }
  }

  remove(ref) {
    const cleanRef = validateRef(String(ref).replace(/^vault:/, ''));
    this.fs.rmSync(this.#file(cleanRef), { force: true });
    return { removed: true, external_ref: `vault:${cleanRef}` };
  }

  has(ref) {
    const cleanRef = validateRef(String(ref).replace(/^vault:/, ''));
    return this.fs.existsSync(this.#file(cleanRef));
  }

  entries() {
    return this.fs.readdirSync(this.root).filter((name) => /^[A-Za-z0-9._~-]+\.vault$/.test(name)).map((name) => name.slice(0, -6));
  }

  #file(ref) { return path.join(this.root, `${ref}.vault`); }
}

export const CredentialVault = VaultAdapter;

function normalizeKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const text = String(value);
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.length === 32 && decoded.toString('base64url') === text.replace(/=+$/, '')) return decoded;
  return createHash('sha256').update(text, 'utf8').digest();
}

function validateRef(value) {
  const ref = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/.test(ref)) throw new VaultError('vault_ref_invalid', 'vault reference is invalid', {}, 400);
  return ref;
}
