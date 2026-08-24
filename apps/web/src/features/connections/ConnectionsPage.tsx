import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Box, Cable, Check, Link, LoaderCircle, Plus, Power, Radio, RefreshCw, RotateCcw,
  Save, Server, ShieldOff, Unplug
} from 'lucide-react';
import { ApiError, apiV2, formatBytes, formatTime, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type BridgeDevice = {
  id: string;
  label: string;
  paired_transcript_sha256: string;
  status: string;
  last_nonce_sequence: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

type BridgeTransfer = {
  id: string;
  direction: 'send' | 'receive';
  transfer_type: 'git_bundle' | 'terminal_control';
  repository_ref?: string | null;
  head_sha?: string | null;
  bundle_sha256?: string | null;
  byte_length: number;
  status: string;
  error_code?: string | null;
  created_at: string;
};

type RunnerProfile = {
  id: string; label: string; runner_type: 'docker' | 'host' | 'windows_bridge'; endpoint_ref: string;
  image_digest: string; bridge_device_id?: string | null; capabilities: string[];
  limits: Record<string, { cpus: number; memory_bytes: number; pids: number; tmpfs_bytes: number }>;
  status: string; revision: number; profile_hash: string; last_probe_at?: string | null;
};

export function ConnectionsPage({ navigate, notify }: WorkspacePageProps) {
  const [tab, setTab] = useState<'bridge' | 'runners'>('bridge');
  const [devices, setDevices] = useState<BridgeDevice[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [transfers, setTransfers] = useState<BridgeTransfer[]>([]);
  const [label, setLabel] = useState('Windows workstation');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [direction, setDirection] = useState<'send' | 'receive'>('send');
  const [repositoryRef, setRepositoryRef] = useState('refs/heads/main');
  const [headSha, setHeadSha] = useState('');
  const [bundleSha, setBundleSha] = useState('');
  const [byteLength, setByteLength] = useState('0');
  const [probe, setProbe] = useState<{ status: string; capabilities: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState('');
  const [profiles, setProfiles] = useState<RunnerProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [runnerType, setRunnerType] = useState<RunnerProfile['runner_type']>('host');
  const [runnerLabel, setRunnerLabel] = useState('Local Host');
  const [runnerDigest, setRunnerDigest] = useState('');
  const [runnerEndpoint, setRunnerEndpoint] = useState('');
  const [runnerBridgeId, setRunnerBridgeId] = useState('');

  const selected = useMemo(() => devices.find((device) => device.id === selectedId) || null, [devices, selectedId]);
  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === selectedProfileId) || null, [profiles, selectedProfileId]);

  const load = useCallback(async () => {
    const result = await apiV2<{ devices: BridgeDevice[] }>('/api/v2/bridge/devices');
    const rows = result.data.devices || [];
    setDevices(rows);
    setSelectedId((current) => rows.some((device) => device.id === current) ? current : rows[0]?.id || '');
  }, []);

  const loadTransfers = useCallback(async () => {
    if (!selectedId) {
      setTransfers([]);
      return;
    }
    const result = await apiV2<{ transfers?: BridgeTransfer[]; transfer?: BridgeTransfer }>(`/api/v2/bridge/devices/${encodeURIComponent(selectedId)}/transfers`);
    setTransfers(result.data.transfers || (result.data.transfer ? [result.data.transfer] : []));
  }, [selectedId]);

  const loadProfiles = useCallback(async () => {
    const result = await apiV2<{ profiles: RunnerProfile[] }>('/api/v2/runners/profiles'); const rows = result.data.profiles || [];
    setProfiles(rows); setSelectedProfileId((current) => rows.some((profile) => profile.id === current) ? current : rows[0]?.id || '');
  }, []);

  useEffect(() => {
    void load().catch((error) => notify(error instanceof Error ? error.message : 'Bridge devices failed to load', 'error'));
  }, [load, notify]);

  useEffect(() => {
    setProbe(null);
    void loadTransfers().catch((error) => notify(error instanceof Error ? error.message : 'Bridge transfers failed to load', 'error'));
  }, [loadTransfers, notify]);

  useEffect(() => { if (tab === 'runners') void loadProfiles().catch((error) => notify(error instanceof Error ? error.message : 'Runner profiles failed to load', 'error')); }, [loadProfiles, notify, tab]);
  useEffect(() => { if (selectedProfile) setRunnerLabel(selectedProfile.label); }, [selectedProfile]);

  const handleError = async (error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.code === 'revision_conflict') await load().catch(() => undefined);
    notify(error instanceof Error ? error.message : fallback, 'error');
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('pair');
    try {
      const result = await mutateV2<{ device: BridgeDevice }>('/api/v2/bridge/pairing', {
        label: label.trim(),
        ...(confirmationCode.trim() ? { confirmation_code: confirmationCode.trim() } : {})
      }, 'POST', 0);
      await load();
      setSelectedId(result.data.device.id);
      setConfirmationCode('');
      notify('Windows Bridge paired');
    } catch (error) {
      await handleError(error, 'Bridge pairing failed');
    } finally {
      setBusy('');
    }
  };

  const mutateDevice = async (device: BridgeDevice, action: 'probe' | 'rotate' | 'revoke') => {
    setBusy(`${action}:${device.id}`);
    try {
      const result = await mutateV2<{ device: BridgeDevice; probe?: { status: string; capabilities: Record<string, unknown> } }>(`/api/v2/bridge/devices/${encodeURIComponent(device.id)}/${action}`, {}, 'POST', device.revision);
      if (result.data.probe) setProbe(result.data.probe);
      await load();
      if (action === 'revoke') setTransfers([]);
      notify(`Bridge ${action === 'revoke' ? 'revoked' : action === 'rotate' ? 'secret rotated' : 'probe completed'}`);
    } catch (error) {
      await handleError(error, `Bridge ${action} failed`);
    } finally {
      setBusy('');
    }
  };

  const createTransfer = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy('transfer');
    try {
      await mutateV2(`/api/v2/bridge/devices/${encodeURIComponent(selected.id)}/transfers`, {
        direction,
        transfer_type: 'git_bundle',
        repository_ref: repositoryRef.trim(),
        head_sha: headSha.trim(),
        bundle_sha256: bundleSha.trim(),
        byte_length: Number(byteLength || 0)
      }, 'POST', selected.revision);
      await Promise.all([load(), loadTransfers()]);
      notify('Bridge transfer verified');
    } catch (error) {
      await handleError(error, 'Bridge transfer failed');
      await loadTransfers().catch(() => undefined);
    } finally {
      setBusy('');
    }
  };

  const createRunner = async (event: FormEvent) => {
    event.preventDefault(); setBusy('runner-create');
    try {
      const result = await mutateV2<{ profile: RunnerProfile }>('/api/v2/runners/profiles', {
        label: runnerLabel.trim(), runner_type: runnerType,
        ...(runnerEndpoint.trim() ? { endpoint_ref: runnerEndpoint.trim() } : {}),
        ...(runnerType === 'docker' ? { image_digest: runnerDigest.trim() } : {}),
        ...(runnerType === 'windows_bridge' ? { bridge_device_id: runnerBridgeId } : {})
      }, 'POST', 0);
      await loadProfiles(); setSelectedProfileId(result.data.profile.id); notify('Runner profile created');
    } catch (error) { await handleError(error, 'Runner profile creation failed'); } finally { setBusy(''); }
  };

  const mutateRunner = async (profile: RunnerProfile, action: 'probe' | 'disable' | 'update') => {
    setBusy(`runner-${action}`);
    try {
      const route = action === 'update' ? `/api/v2/runners/profiles/${encodeURIComponent(profile.id)}` : `/api/v2/runners/profiles/${encodeURIComponent(profile.id)}/${action}`;
      await mutateV2(route, action === 'update' ? { label: runnerLabel.trim() } : {}, action === 'update' ? 'PATCH' : 'POST', profile.revision);
      await loadProfiles(); if (action === 'probe') setTimeout(() => void loadProfiles().catch(() => undefined), 100); notify(`Runner ${action} accepted`);
    } catch (error) { await handleError(error, `Runner ${action} failed`); } finally { setBusy(''); }
  };

  return (
    <div className="page connections-page">
      <div className="page-heading">
        <div><p className="eyebrow">Local native services</p><h1>Connections</h1></div>
        <button className="icon-button" title="Refresh Connections" aria-label="Refresh Connections" onClick={() => void (tab === 'bridge' ? load() : loadProfiles())}><RefreshCw size={17} /></button>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Settings views">
        <button onClick={() => navigate('settings')}>MCP &amp; Exchange</button>
        <button className={tab === 'bridge' ? 'active' : ''} aria-selected={tab === 'bridge'} onClick={() => setTab('bridge')}>Windows Bridge</button>
        <button className={tab === 'runners' ? 'active' : ''} aria-selected={tab === 'runners'} onClick={() => setTab('runners')}>Runner Profiles</button>
      </div>

      {tab === 'bridge' ? <div className="connections-layout">
        <section className="panel bridge-devices-panel">
          <div className="section-title"><div><h2>Bridge devices</h2><span>{devices.length} paired identities</span></div></div>
          <form className="bridge-pair-form" onSubmit={(event) => void pair(event)}>
            <label><span>Device label</span><input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
            <label><span>Confirmation code</span><input value={confirmationCode} inputMode="numeric" pattern="[0-9]{6,12}" placeholder="6-12 digits" onChange={(event) => setConfirmationCode(event.target.value)} /></label>
            <button className="button primary" disabled={busy === 'pair' || !label.trim()}>{busy === 'pair' ? <LoaderCircle className="spin" size={15} /> : <Link size={15} />}Pair</button>
          </form>
          <div className="bridge-device-list">
            {devices.map((device) => <button key={device.id} className={device.id === selectedId ? 'bridge-device-row selected' : 'bridge-device-row'} onClick={() => setSelectedId(device.id)}>
              <Cable size={16} />
              <span><strong>{device.label}</strong><small className="mono">Transcript {shortHash(device.paired_transcript_sha256)} | r{device.revision}</small></span>
              <Status value={device.status} />
            </button>)}
            {!devices.length && <div className="list-empty">No Bridge devices</div>}
          </div>
        </section>

        <section className="panel bridge-detail-panel">
          {selected ? <>
            <div className="section-title bridge-device-title">
              <div><h2>{selected.label}</h2><span>Nonce sequence {selected.last_nonce_sequence} | updated {formatTime(selected.updated_at)}</span></div>
              <div className="bridge-device-actions">
                <button className="icon-button" title="Probe Bridge" aria-label="Probe Bridge" disabled={selected.status !== 'paired' || Boolean(busy)} onClick={() => void mutateDevice(selected, 'probe')}><Radio size={15} /></button>
                <button className="icon-button" title="Rotate pairing secret" aria-label="Rotate pairing secret" disabled={selected.status !== 'paired' || Boolean(busy)} onClick={() => void mutateDevice(selected, 'rotate')}><RotateCcw size={15} /></button>
                <button className="icon-button danger" title="Revoke Bridge" aria-label="Revoke Bridge" disabled={selected.status !== 'paired' || Boolean(busy)} onClick={() => void mutateDevice(selected, 'revoke')}><ShieldOff size={15} /></button>
              </div>
            </div>
            {probe && <div className="bridge-probe" role="status"><Check size={16} /><span><strong>{probe.status}</strong><small>{Object.keys(probe.capabilities).join(', ') || 'Bridge reachable'}</small></span></div>}
            <form className="bridge-transfer-form" onSubmit={(event) => void createTransfer(event)}>
              <div className="terminal-subheading"><span>Git bundle transfer</span><small>Verified before acceptance</small></div>
              <div className="segmented" role="group" aria-label="Transfer direction"><button type="button" className={direction === 'send' ? 'active' : ''} onClick={() => setDirection('send')}>Send</button><button type="button" className={direction === 'receive' ? 'active' : ''} onClick={() => setDirection('receive')}>Receive</button></div>
              <label><span>Repository ref</span><input className="mono" value={repositoryRef} onChange={(event) => setRepositoryRef(event.target.value)} required /></label>
              <label><span>Head SHA</span><input className="mono" value={headSha} pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}" onChange={(event) => setHeadSha(event.target.value)} required /></label>
              <label><span>Bundle SHA-256</span><input className="mono" value={bundleSha} pattern="[a-fA-F0-9]{64}" onChange={(event) => setBundleSha(event.target.value)} required /></label>
              <label><span>Bytes</span><input type="number" min="0" max="1073741824" value={byteLength} onChange={(event) => setByteLength(event.target.value)} required /></label>
              <button className="button" disabled={selected.status !== 'paired' || busy === 'transfer'}>{busy === 'transfer' ? <LoaderCircle className="spin" size={15} /> : <Unplug size={15} />}Verify transfer</button>
            </form>
            <div className="bridge-transfer-list">
              {transfers.map((transfer) => <div className="bridge-transfer-row" key={transfer.id}>
                <span><strong>{transfer.direction} {transfer.transfer_type.replace('_', ' ')}</strong><small className="mono">{transfer.repository_ref || 'control'} | {shortHash(transfer.bundle_sha256 || transfer.head_sha || '')}</small></span>
                <span>{formatBytes(transfer.byte_length)}</span>
                <Status value={transfer.status} />
                {transfer.error_code && <small className="bridge-transfer-error">{transfer.error_code}</small>}
              </div>)}
              {!transfers.length && <div className="list-empty">No Bridge transfers</div>}
            </div>
          </> : <div className="empty-state"><Cable size={24} /><h2>Select a Bridge device</h2></div>}
        </section>
      </div> : <div className="runner-profile-layout">
        <section className="panel runner-profile-list-panel">
          <div className="section-title"><div><h2>Runner profiles</h2><span>{profiles.length} signed identities</span></div></div>
          <form className="runner-profile-form" onSubmit={(event) => void createRunner(event)}>
            <label><span>Label</span><input value={runnerLabel} onChange={(event) => setRunnerLabel(event.target.value)} required /></label>
            <label><span>Runner type</span><select aria-label="Runner type" value={runnerType} onChange={(event) => setRunnerType(event.target.value as RunnerProfile['runner_type'])}><option value="host">Host</option><option value="docker">Docker</option><option value="windows_bridge">Windows Bridge</option></select></label>
            <label><span>Endpoint ref</span><input value={runnerEndpoint} pattern="[A-Za-z][A-Za-z0-9._~-]{0,159}" onChange={(event) => setRunnerEndpoint(event.target.value)} /></label>
            {runnerType === 'docker' && <label className="runner-digest"><span>Image digest</span><input className="mono" value={runnerDigest} pattern="sha256:[a-f0-9]{64}" onChange={(event) => setRunnerDigest(event.target.value)} required /></label>}
            {runnerType === 'windows_bridge' && <label className="runner-digest"><span>Bridge device</span><select aria-label="Bridge device" value={runnerBridgeId} onChange={(event) => setRunnerBridgeId(event.target.value)} required><option value="">Select device</option>{devices.filter((device) => device.status === 'paired').map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}</select></label>}
            <button className="button primary" disabled={busy === 'runner-create'}>{busy === 'runner-create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Add profile</button>
          </form>
          <div className="runner-profile-list">{profiles.map((profile) => <button key={profile.id} className={profile.id === selectedProfileId ? 'selected' : ''} onClick={() => setSelectedProfileId(profile.id)}>{profile.runner_type === 'docker' ? <Box size={16} /> : <Server size={16} />}<span><strong>{profile.label}</strong><small className="mono">{profile.runner_type} | r{profile.revision}</small></span><Status value={profile.status} /></button>)}{!profiles.length && <div className="list-empty">No Runner profiles</div>}</div>
        </section>
        <section className="panel runner-profile-detail-panel">
          {selectedProfile ? <>
            <div className="section-title runner-profile-title"><div><h2>{selectedProfile.label}</h2><span>{selectedProfile.runner_type} | {selectedProfile.last_probe_at ? `probed ${formatTime(selectedProfile.last_probe_at)}` : 'unprobed'}</span></div><div className="runner-profile-actions"><button className="icon-button" title="Save Runner profile" aria-label="Save Runner profile" disabled={Boolean(busy) || selectedProfile.status === 'disabled'} onClick={() => void mutateRunner(selectedProfile, 'update')}><Save size={15} /></button><button className="icon-button" title="Probe Runner profile" aria-label="Probe Runner profile" disabled={Boolean(busy) || selectedProfile.status === 'disabled'} onClick={() => void mutateRunner(selectedProfile, 'probe')}><Radio size={15} /></button><button className="icon-button danger" title="Disable Runner profile" aria-label="Disable Runner profile" disabled={Boolean(busy) || selectedProfile.status === 'disabled'} onClick={() => void mutateRunner(selectedProfile, 'disable')}><Power size={15} /></button></div></div>
            <div className="runner-readiness"><Status value={selectedProfile.status} /><span className="mono">Profile {shortHash(selectedProfile.profile_hash)}</span></div>
            <div className="runner-profile-facts"><span><small>Endpoint</small><strong>{selectedProfile.endpoint_ref || 'local'}</strong></span><span><small>Digest</small><strong className="mono">{shortHash(selectedProfile.image_digest)}</strong></span><span><small>Bridge</small><strong className="mono">{shortHash(selectedProfile.bridge_device_id || '')}</strong></span></div>
            <div className="runner-capability-list"><h3>Capabilities</h3><div>{selectedProfile.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div></div>
            <div className="runner-limit-table"><div><span>Profile</span><span>CPU</span><span>Memory</span><span>PIDs</span><span>tmpfs</span></div>{Object.entries(selectedProfile.limits || {}).map(([name, limits]) => <div key={name}><strong>{name}</strong><span>{limits.cpus}</span><span>{formatBytes(limits.memory_bytes)}</span><span>{limits.pids}</span><span>{formatBytes(limits.tmpfs_bytes)}</span></div>)}</div>
          </> : <div className="empty-state"><Server size={24} /><h2>No Runner profile selected</h2></div>}
        </section>
      </div>}
    </div>
  );
}

function Status({ value }: { value: string }) {
  const tone = ['paired', 'verified', 'ready'].includes(value) ? 'positive'
    : ['pending', 'probing'].includes(value) ? 'working'
      : ['revoked', 'failed', 'cancelled', 'disabled', 'unavailable'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}
