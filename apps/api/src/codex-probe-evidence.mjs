import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CODEX_HOME_DIR } from './config.mjs';

const EVIDENCE_VERSION = 1;

export function createCodexProbeEvidence({ profile, auth, runtime } = {}) {
  const config = readProfileConfig(profile);
  const imageId = profile?.kind === 'docker' ? runtime?.image?.id : 'host';
  if (!profile?.id || !auth || !config || !imageId) return null;
  return {
    version: EVIDENCE_VERSION,
    profile_revision: digest(profileRevisionInput(profile)),
    auth_revision: digest(authRevisionInput(auth)),
    config_revision: digest(config),
    image_id: String(imageId)
  };
}

export function codexProbeEvidenceMatches(saved, current) {
  if (!saved || !current || saved.version !== EVIDENCE_VERSION || current.version !== EVIDENCE_VERSION) return false;
  return ['profile_revision', 'auth_revision', 'config_revision', 'image_id'].every(
    (key) => typeof saved[key] === 'string' && saved[key] === current[key]
  );
}

function readProfileConfig(profile) {
  const base = path.resolve(CODEX_HOME_DIR);
  const home = path.resolve(base, String(profile?.id || ''));
  if (path.dirname(home) !== base || path.resolve(String(profile?.codex_home || '')) !== home) return null;
  const file = path.join(home, 'config.toml');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function profileRevisionInput(profile) {
  return JSON.stringify({
    id: profile.id,
    kind: profile.kind,
    provider: profile.provider,
    provider_name: profile.provider_name,
    base_url: profile.base_url,
    wire_api: profile.wire_api,
    requires_openai_auth: profile.requires_openai_auth === true,
    model: profile.model,
    reasoning: profile.reasoning,
    web_search: profile.web_search === true,
    timeout_ms: Number(profile.timeout_ms || 0),
    mounts: profile.mounts || [],
    mcp_servers: profile.mcp_servers || [],
    image: profile.image,
    codex_home: profile.codex_home,
    cc_switch_provider_id: profile.cc_switch_provider_id,
    cc_switch_bridge_revision: profile.cc_switch_bridge_revision,
    cc_switch_source_commit: profile.cc_switch_source_commit,
    discovery_source: profile.discovery_source || null
  });
}

function authRevisionInput(auth) {
  return JSON.stringify({
    status: auth.status,
    provider: auth.provider,
    base_url: auth.base_url,
    wire_api: auth.wire_api,
    auth_mode: auth.auth_mode,
    home: auth.home,
    refs: Object.entries(auth.refs || {}).sort(([left], [right]) => left.localeCompare(right))
  });
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}
