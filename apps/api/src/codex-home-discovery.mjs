import os from 'node:os';
import path from 'node:path';
import { authJsonInfo, opaqueId, privateRevision, publicProviderFromToml, readCodexHome } from './codex-discovery-utils.mjs';

export async function scanCodexHomes() {
  const candidates = [];
  const hostMounted = String(process.env.AIWS_HOST_CODEX_HOME || '').trim();
  if (hostMounted) candidates.push({ root: path.resolve(hostMounted), hint: '$AIWS_HOST_CODEX_HOME/config.toml', name: 'Mounted host Codex' });
  const configured = String(process.env.CODEX_HOME || '').trim();
  if (configured) candidates.push({ root: path.resolve(configured), hint: '$CODEX_HOME/config.toml', name: 'Configured CODEX_HOME' });
  candidates.push({ root: path.join(os.homedir(), '.codex'), hint: '~/.codex/config.toml', name: 'Local ~/.codex' });
  const seen = new Set(), results = [];
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.root.toLowerCase() : candidate.root;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(await scanOne(candidate));
  }
  return results;
}

async function scanOne(candidate) {
  const sourceId = opaqueId('source', 'codex_home', candidate.hint);
  const base = { source_id: sourceId, type: 'codex_home', display_name: candidate.name, path_hint: candidate.hint, read_only: true };
  const files = await readCodexHome(candidate.root);
  if (!files) return { source: { ...base, status: 'unavailable', revision: null, providers: [] }, records: [] };
  const auth = authJsonInfo(files.auth);
  const parsed = publicProviderFromToml(files.config, { credentialPresent: Boolean(auth.credential || auth.oauth), sourceType: 'codex_home' });
  const revision = privateRevision('codex-home', files.statKey, files.config, files.auth);
  if (!parsed.ok) return { source: { ...base, status: 'invalid', revision, providers: [], issues: [parsed.issue] }, records: [] };
  const descriptor = parsed.descriptor;
  if (!descriptor.has_credential && !isThirdParty(descriptor.provider)) {
    descriptor.importable = false;
    if (!descriptor.issues.includes('official_device_login_required')) descriptor.issues.push('official_device_login_required');
    descriptor.credential_hint = auth.oauth ? 'device_login' : 'required';
  }
  if (auth.issue) descriptor.issues.push(auth.issue);
  if (auth.oauth && isThirdParty(descriptor.provider)) descriptor.issues.push('oauth_ignored_for_third_party');
  descriptor.credential_kind = auth.oauth && !isThirdParty(descriptor.provider) ? 'oauth_bundle' : descriptor.has_credential ? 'api_key' : 'none';
  const discoveryId = opaqueId('provider', sourceId, descriptor.provider);
  const publicDescriptor = { discovery_id: discoveryId, source_revision: revision, ...descriptor, is_current: true, category: 'local_config' };
  return {
    source: { ...base, status: 'available', revision, providers: [publicDescriptor] },
    records: [{ descriptor: publicDescriptor, credential: auth.credential || parsed.credential, auth_bundle: auth.oauth && !isThirdParty(descriptor.provider) ? files.auth : '', root: files.root }]
  };
}

function isThirdParty(provider) { return !['openai', 'chatgpt'].includes(String(provider || '').toLowerCase()); }
