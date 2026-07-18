import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { VAULT_DIR } from './config.mjs';
import { maskSecret } from '../../../packages/shared/index.mjs';

const knownSecrets = new Map();

export function rememberSecret(label, value) {
  if (!value || String(value).length < 4) return null;
  const ref = `memory:${safe(label)}:${randomBytes(6).toString('hex')}`;
  knownSecrets.set(ref, String(value));
  return ref;
}

export async function putSecret(label, value) {
  if (!value) return null;
  await fsp.mkdir(VAULT_DIR, { recursive: true });
  const id = `${safe(label)}_${randomBytes(12).toString('hex')}`;
  const file = path.join(VAULT_DIR, `${id}.secret`);
  await fsp.writeFile(file, String(value), { encoding: 'utf8', mode: 0o600 });
  try { await fsp.chmod(file, 0o600); } catch {}
  const ref = `vault:${id}`;
  knownSecrets.set(ref, String(value));
  return ref;
}

export async function readSecret(ref) {
  if (!ref) return '';
  if (String(ref).startsWith('env:')) return process.env[String(ref).slice(4)] || '';
  if (!String(ref).startsWith('vault:')) return '';
  const id = String(ref).slice(6);
  if (safe(id) !== id) throw new Error('invalid_vault_ref');
  try { const value = await fsp.readFile(path.join(VAULT_DIR, `${id}.secret`), 'utf8'); knownSecrets.set(String(ref), value); return value; }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function removeSecret(ref) {
  if (!String(ref || '').startsWith('vault:')) return;
  const id = String(ref).slice(6);
  if (safe(id) !== id) return;
  await fsp.rm(path.join(VAULT_DIR, `${id}.secret`), { force: true });
  knownSecrets.delete(String(ref));
}

export async function redactKnownSecrets(value) {
  let text = maskSecret(String(value ?? ''));
  const files = await fsp.readdir(VAULT_DIR).catch(() => []);
  for (const file of files.filter((item) => item.endsWith('.secret'))) {
    const secret = await fsp.readFile(path.join(VAULT_DIR, file), 'utf8').catch(() => '');
    if (secret.length < 4) continue;
    knownSecrets.set(`vault:${file.slice(0, -7)}`, secret);
  }
  return redactKnownSecretsSync(text);
}

export function redactKnownSecretsSync(value) {
  let text = maskSecret(String(value ?? ''));
  for (const secret of knownSecrets.values()) {
    if (secret.length < 4) continue;
    const quoted = JSON.stringify(secret);
    text = text.split(quoted).join(JSON.stringify('***MASKED***'));
    const encoded = quoted.slice(1, -1);
    if (secret.length >= 12) {
      text = text.split(secret).join('***MASKED***');
      if (encoded !== secret) text = text.split(encoded).join('***MASKED***');
    } else {
      text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(secret)}(?![A-Za-z0-9_])`, 'g'), '***MASKED***');
      if (encoded !== secret) text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(encoded)}(?![A-Za-z0-9_])`, 'g'), '***MASKED***');
    }
  }
  return text;
}

export function redactKnownSecretStream(value, pending = '') {
  const raw = `${pending}${String(value ?? '')}`;
  let overlap = '';
  for (const secret of knownSecrets.values()) {
    for (const candidate of [secret, JSON.stringify(secret).slice(1, -1)]) {
      const limit = Math.min(raw.length, candidate.length - 1);
      for (let size = limit; size > overlap.length; size--) if (raw.endsWith(candidate.slice(0, size))) { overlap = raw.slice(-size); break; }
    }
  }
  return { text: redactKnownSecretsSync(raw.slice(0, raw.length - overlap.length)), pending: overlap };
}

function safe(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, ''); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
