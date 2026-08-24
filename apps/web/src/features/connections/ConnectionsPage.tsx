import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Cable, Check, Link, LoaderCircle, Radio, RefreshCw, RotateCcw, ShieldOff,
  Unplug
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

export function ConnectionsPage({ navigate, notify }: WorkspacePageProps) {
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

  const selected = useMemo(() => devices.find((device) => device.id === selectedId) || null, [devices, selectedId]);

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

  useEffect(() => {
    void load().catch((error) => notify(error instanceof Error ? error.message : 'Bridge devices failed to load', 'error'));
  }, [load, notify]);

  useEffect(() => {
    setProbe(null);
    void loadTransfers().catch((error) => notify(error instanceof Error ? error.message : 'Bridge transfers failed to load', 'error'));
  }, [loadTransfers, notify]);

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

  return (
    <div className="page connections-page">
      <div className="page-heading">
        <div><p className="eyebrow">Local native services</p><h1>Connections</h1></div>
        <button className="icon-button" title="Refresh Connections" aria-label="Refresh Connections" onClick={() => void load()}><RefreshCw size={17} /></button>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Settings views">
        <button onClick={() => navigate('settings')}>MCP &amp; Exchange</button>
        <button className="active" aria-selected="true">Windows Bridge</button>
      </div>

      <div className="connections-layout">
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
      </div>
    </div>
  );
}

function Status({ value }: { value: string }) {
  const tone = ['paired', 'verified', 'ready'].includes(value) ? 'positive'
    : ['pending', 'probing'].includes(value) ? 'working'
      : ['revoked', 'failed', 'cancelled'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}
