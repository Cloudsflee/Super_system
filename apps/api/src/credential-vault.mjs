import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_SECRET_BYTES = 64 * 1024;

export class CredentialVault {
  constructor(home) {
    this.root = path.resolve(home, 'vault');
    this.keyFile = path.join(this.root, '.master-key');
  }

  put(reference, value) {
    const secret = Buffer.from(String(value ?? ''), 'utf8');
    if (secret.length < 1 || secret.length > MAX_SECRET_BYTES) throw new Error('credential_secret_invalid');
    const target = this.pathFor(reference);
    const key = this.loadKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    }));
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, target);
      try { fs.chmodSync(target, 0o600); } catch { /* Windows applies ACLs instead. */ }
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Atomic rename already consumed it. */ }
      secret.fill(0);
      key.fill(0);
    }
    return path.basename(target);
  }

  get(reference) {
    const target = this.pathFor(reference);
    let payload;
    try { payload = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch { throw new Error('credential_secret_unavailable'); }
    if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') throw new Error('credential_secret_invalid');
    const key = this.loadKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new Error('credential_secret_invalid'); }
    finally { key.fill(0); }
  }

  remove(reference) {
    fs.rmSync(this.pathFor(reference), { force: true });
  }

  exists(reference) {
    return fs.existsSync(this.pathFor(reference));
  }

  pathFor(reference) {
    const name = String(reference || '');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw new Error('credential_reference_invalid');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    return path.join(this.root, `${name}.vault`);
  }

  loadKey() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.keyFile)) {
      try { fs.writeFileSync(this.keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const key = Buffer.from(fs.readFileSync(this.keyFile));
    if (key.length !== 32) throw new Error('credential_vault_key_invalid');
    try { fs.chmodSync(this.keyFile, 0o600); } catch { /* Windows applies ACLs instead. */ }
    return key;
  }
}
