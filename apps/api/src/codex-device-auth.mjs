import fsp from 'node:fs/promises';
import path from 'node:path';
import { CODEX_HOME_DIR } from './config.mjs';

export function extractDeviceAuthPublicState(text, current = {}) {
  const next = { status: current.status || 'running' };
  const urls = String(text || '').match(/https:\/\/[^\s<>"']+/gi) || [];
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[),.;]+$/, ''));
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (url.hostname === 'openai.com' || url.hostname.endsWith('.openai.com') || url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'))) { next.verification_uri = url.href; break; }
    } catch {}
  }
  const code = String(text || '').match(/(?:user\s*code|device\s*code|enter\s+(?:this\s+)?code|\u9a8c\u8bc1\u7801)\s*[:\uff1a]?\s*([A-Z0-9]{4,16}(?:-[A-Z0-9]{4,16})?)/i)?.[1];
  if (code && /^[A-Z0-9]{4,16}(?:-[A-Z0-9]{4,16})?$/i.test(code)) next.user_code = code.toUpperCase();
  return { ...current, ...next };
}

export async function persistDeviceAuth(tempHome) {
  const source = await safeAuthFile(tempHome);
  if (!source) throw new Error('codex_device_auth_file_missing');
  const targetHome = path.join(CODEX_HOME_DIR, 'auth_owner');
  await fsp.mkdir(targetHome, { recursive: true });
  const target = path.join(targetHome, 'auth.json');
  await fsp.copyFile(source, target);
  try { await fsp.chmod(target, 0o600); } catch {}
  return targetHome;
}

export async function readDeviceAuthBundle(home) {
  const file = await safeAuthFile(home);
  if (!file) throw new Error('codex_device_auth_file_missing');
  const text = await fsp.readFile(file, 'utf8');
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); } catch { throw new Error('codex_device_auth_file_invalid'); }
  return text;
}

export async function persistImportedDeviceAuth(bundle, profileId) {
  const text = String(bundle || '');
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); } catch { throw new Error('codex_device_auth_file_invalid'); }
  if (Buffer.byteLength(text) > 512 * 1024) throw new Error('codex_device_auth_file_invalid');
  const targetHome = path.join(CODEX_HOME_DIR, `auth-import-${safe(profileId)}`);
  await fsp.mkdir(targetHome, { recursive: true });
  const target = path.join(targetHome, 'auth.json');
  await fsp.writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
  try { await fsp.chmod(target, 0o600); } catch {}
  return targetHome;
}

export async function materializeDeviceAuth(authHome, profileHome) {
  const source = await safeAuthFile(authHome);
  const root = path.resolve(CODEX_HOME_DIR), targetHome = path.resolve(String(profileHome || ''));
  if (!source || path.dirname(targetHome) !== root) throw new Error('codex_device_auth_materialize_failed');
  await fsp.mkdir(targetHome, { recursive: true });
  const target = path.join(targetHome, 'auth.json');
  await fsp.copyFile(source, target);
  try { await fsp.chmod(target, 0o600); } catch {}
  return target;
}

export async function cleanupCodexAuthHomes(homes = []) {
  const root = path.resolve(CODEX_HOME_DIR);
  for (const item of homes) {
    const home = path.resolve(String(item || ''));
    if (path.dirname(home) !== root) continue;
    await fsp.rm(path.join(home, 'auth.json'), { force: true }).catch(() => {});
    if (/^(?:device-|auth-import-)/.test(path.basename(home))) await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

async function safeAuthFile(home) {
  const root = path.resolve(CODEX_HOME_DIR), resolvedHome = path.resolve(home);
  if (path.dirname(resolvedHome) !== root) return null;
  const file = path.join(resolvedHome, 'auth.json');
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return null;
    return file;
  } catch { return null; }
}

function safe(value) { return String(value || 'profile').replace(/[^a-zA-Z0-9_-]/g, '_'); }
