import { scanCcSwitchDiscovery, readCcSwitchCredential } from './cc-switch-discovery.mjs';
import { scanCodexHomes } from './codex-home-discovery.mjs';

export class DiscoveryError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export async function discoverLocalCodex() {
  const scans = await scanAll();
  return { updated_at: new Date().toISOString(), sources: scans.map((item) => item.source) };
}

export async function resolveDiscoveryImport({ discoveryId, sourceRevision }) {
  if (!discoveryId || !sourceRevision) throw new DiscoveryError(400, 'discovery_id_and_source_revision_required');
  const scans = await scanAll();
  for (const scan of scans) {
    const record = scan.records.find((item) => item.descriptor.discovery_id === discoveryId);
    if (!record) continue;
    if (scan.source.revision !== sourceRevision || record.descriptor.source_revision !== sourceRevision) throw new DiscoveryError(409, 'discovery_source_stale');
    if (!record.descriptor.importable) throw new DiscoveryError(409, record.descriptor.issues.includes('official_device_login_required') ? 'official_device_login_required' : 'discovery_item_not_importable');
    let credential = record.credential || '', authBundle = record.auth_bundle || '';
    if (scan.source.type === 'cc_switch') {
      const selected = await readCcSwitchCredential(scan.database_path, record.source_provider_id).catch(() => null);
      if (!selected) throw new DiscoveryError(409, 'discovery_source_stale');
      if (selected.credential_fingerprint !== record.credential_fingerprint || publicSignature(selected.descriptor) !== publicSignature(record.descriptor)) throw new DiscoveryError(409, 'discovery_source_stale');
      credential = selected.credential || '';
    }
    if (record.descriptor.has_credential && !credential && !authBundle) throw new DiscoveryError(409, 'discovery_source_stale');
    return {
      descriptor: structuredClone(record.descriptor), credential, auth_bundle: authBundle,
      source: { source_id: scan.source.source_id, source_provider_id: record.descriptor.discovery_id, type: scan.source.type, revision: scan.source.revision }
    };
  }
  throw new DiscoveryError(404, 'discovery_item_not_found');
}

async function scanAll() {
  const ccSwitch = await scanCcSwitchDiscovery();
  const homes = await scanCodexHomes();
  return [ccSwitch, ...homes];
}

function publicSignature(value) { return JSON.stringify([value.provider, value.base_url, value.model, value.wire_api, value.has_credential]); }
