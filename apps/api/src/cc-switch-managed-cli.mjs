import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AIWS_HOME, ROOT } from './config.mjs';
import { command, HttpError } from './http.mjs';

export const CC_SWITCH_VERSION = '5.9.0';
const RELEASE = 'https://github.com/SaladDay/cc-switch-cli/releases/download/v5.9.0';
const assets = Object.freeze({
  'win32-x64': ['cc-switch-cli-v5.9.0-windows-x64.zip', '61775ef923f59c8f7877e1391c114a6a603f45980d1279410222734b2254ca9a'],
  'linux-x64': ['cc-switch-cli-v5.9.0-linux-x64.tar.gz', '8467f6f6d22a166eea75c98e4d7f976651cdddbd157d702d5a8452a94968b9e3'],
  'linux-arm64': ['cc-switch-cli-v5.9.0-linux-arm64.tar.gz', 'bf40b41de405f75187e1bb44b82a4b13ccd8260362360700a0ad7a7c72ad555d'],
  'darwin-x64': ['cc-switch-cli-v5.9.0-darwin-x64.tar.gz', 'e012ff272230b5a7040c815f251b48084d4383cd6686b236c06dc3c1ce80e3d7'],
  'darwin-arm64': ['cc-switch-cli-v5.9.0-darwin-arm64.tar.gz', 'f03cdcb0f4b2e6efb1875b5d2001b2b1b132e4ecc24c19d95c37c6eebe296345']
});

export function managedCcSwitchPaths(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`, asset = assets[key];
  const installDir = path.join(AIWS_HOME, 'tools', 'cc-switch', CC_SWITCH_VERSION, key);
  return { key, asset, install_dir: installDir, manifest_file: path.join(installDir, '.aiws-release.json'), config_dir: path.join(AIWS_HOME, 'cc-switch-managed', 'config') };
}

export async function managedCcSwitchStatus() {
  const paths = managedCcSwitchPaths(); const binary = await findBinary(paths.install_dir);
  if (!paths.asset) return { installed: false, supported: false, version: CC_SWITCH_VERSION, platform: paths.key, error_code: 'cc_switch_platform_unsupported' };
  if (!binary) return { installed: false, supported: true, version: CC_SWITCH_VERSION, platform: paths.key, checksum: paths.asset[1], install_required: true };
  const version = command(binary, ['--version'], ROOT, 5000, managedEnv(paths.config_dir)), integrity = await verifyInstalledRelease(paths, binary);
  const installed = version.ok && String(version.stdout).includes(CC_SWITCH_VERSION) && integrity.ok;
  return { installed, supported: true, version: CC_SWITCH_VERSION, platform: paths.key, checksum: paths.asset[1], checksum_verified: integrity.ok, binary_ready: version.ok, error_code: installed ? null : integrity.error_code || 'cc_switch_binary_invalid' };
}

export async function installManagedCcSwitch({ adapted = false } = {}) {
  const paths = managedCcSwitchPaths();
  if (!paths.asset) throw new HttpError(409, { error: 'cc_switch_platform_unsupported', platform: paths.key });
  if (adapted) return { installed: true, supported: true, version: CC_SWITCH_VERSION, platform: paths.key, checksum_verified: true, adapter: true };
  const [assetName, expected] = paths.asset, existing = await findBinary(paths.install_dir);
  if (existing) { const current = await managedCcSwitchStatus(); if (current.installed) return { ...current, checksum_verified: true, idempotent: true }; }
  const stage = path.join(AIWS_HOME, 'staging', `cc-switch-${process.pid}-${Date.now()}`), archive = path.join(stage, assetName), extracted = path.join(stage, 'extract');
  await fsp.mkdir(extracted, { recursive: true });
  try {
    const response = await fetch(`${RELEASE}/${assetName}`, { redirect: 'follow', headers: { 'user-agent': 'ai-workspace-v1.3' } });
    if (!response.ok) throw new HttpError(502, { error: 'cc_switch_download_failed', status: response.status });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024) throw new HttpError(413, { error: 'cc_switch_asset_too_large' });
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new HttpError(409, { error: 'cc_switch_checksum_mismatch', expected, actual });
    await fsp.writeFile(archive, bytes, { mode: 0o600 });
    const unpacked = command('tar', ['-xf', archive, '-C', extracted], stage, 60000);
    if (!unpacked.ok) throw new HttpError(409, { error: 'cc_switch_extract_failed', detail: unpacked.stderr || unpacked.error });
    const binary = await findBinary(extracted); if (!binary) throw new HttpError(409, { error: 'cc_switch_binary_missing' });
    const manifest = { version: CC_SWITCH_VERSION, asset: assetName, asset_sha256: expected, binary_path: path.relative(extracted, binary), binary_sha256: await hashFile(binary), installed_at: new Date().toISOString() };
    await fsp.writeFile(path.join(extracted, '.aiws-release.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rm(paths.install_dir, { recursive: true, force: true }); await fsp.mkdir(path.dirname(paths.install_dir), { recursive: true }); await fsp.rename(extracted, paths.install_dir);
    const installed = await managedCcSwitchStatus(); if (!installed.installed) throw new HttpError(409, { error: 'cc_switch_version_verification_failed' });
    return { ...installed, checksum_verified: true, idempotent: false };
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
}

export async function runManagedCcSwitch(args, { configDir, codexHome, adapted = false, adaptedOutput = '' } = {}) {
  const paths = managedCcSwitchPaths(), targetConfig = configDir || paths.config_dir;
  if (adapted) return { ok: true, status: 0, stdout: adaptedOutput, stderr: '', error: null };
  const binary = await findBinary(paths.install_dir); if (!binary) throw new HttpError(409, { error: 'managed_cc_switch_install_required' });
  await fsp.mkdir(targetConfig, { recursive: true });
  return command(binary, args, ROOT, 60000, managedEnv(targetConfig, codexHome), { inheritEnv: false });
}

export async function createPrivateProviderConfig(profile, apiKey) {
  const dir = path.join(AIWS_HOME, 'cc-switch-managed', 'private-tmp'); await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `provider-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`);
  const config = { config: providerToml(profile), auth: { OPENAI_API_KEY: String(apiKey || '') } };
  await fsp.writeFile(file, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
  try { await fsp.chmod(file, 0o600); } catch {}
  return file;
}
export async function removePrivateProviderConfig(file) { if (file) await fsp.rm(file, { force: true }); }
export function parseProviderList(output) { return String(output || '').split(/\r?\n/).map((line) => line.replace(/[│|]/g, ' ').trim()).filter((line) => line && !/^[─+\-\s]+$/.test(line) && !/\b(?:ID|Name|Current)\b/i.test(line)).map((line) => { const current = /^\*/.test(line), cells = line.replace(/^\*\s*/, '').split(/\s{2,}/).filter(Boolean); return cells.length >= 2 ? { id: cells[0], name: cells[1], current } : null; }).filter(Boolean); }

async function findBinary(root) { if (!fs.existsSync(root)) return null; for (const entry of await fsp.readdir(root, { withFileTypes: true })) { const full = path.join(root, entry.name); if (entry.isDirectory()) { const nested = await findBinary(full); if (nested) return nested; } else if (/^cc-switch(?:\.exe)?$/i.test(entry.name)) return full; } return null; }
async function verifyInstalledRelease(paths, binary) {
  const manifest = await fsp.readFile(paths.manifest_file, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
  if (!manifest) return { ok: false, error_code: 'cc_switch_install_manifest_missing' };
  const expectedAsset = paths.asset?.[1], relative = path.relative(paths.install_dir, binary);
  if (manifest.version !== CC_SWITCH_VERSION || manifest.asset_sha256 !== expectedAsset || path.normalize(manifest.binary_path) !== path.normalize(relative)) return { ok: false, error_code: 'cc_switch_install_manifest_invalid' };
  return await hashFile(binary) === manifest.binary_sha256 ? { ok: true, error_code: null } : { ok: false, error_code: 'cc_switch_binary_checksum_mismatch' };
}
async function hashFile(file) { return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex'); }
function managedEnv(configDir, codexHome) { return { CC_SWITCH_CONFIG_DIR: configDir, CODEX_HOME: codexHome || path.join(AIWS_HOME, 'codex-homes', 'managed-cc-switch'), HOME: path.join(AIWS_HOME, 'cc-switch-managed', 'home'), XDG_CONFIG_HOME: path.join(AIWS_HOME, 'cc-switch-managed', 'xdg-config'), XDG_STATE_HOME: path.join(AIWS_HOME, 'cc-switch-managed', 'xdg-state') }; }
function providerToml(profile) { const provider = String(profile.provider || 'custom').replace(/[^a-zA-Z0-9_-]/g, '_'); return `model = ${JSON.stringify(profile.model || '')}\nmodel_provider = ${JSON.stringify(provider)}\n[model_providers.${provider}]\nname = ${JSON.stringify(profile.provider_name || profile.name || provider)}\nbase_url = ${JSON.stringify(profile.base_url || '')}\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\n`; }
