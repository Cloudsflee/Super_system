import { useEffect, useState } from 'react';
import { KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { apiV2, mutateV2 } from '../../api';
import { CodexDiscoveryPicker, type CodexDiscovery } from './CodexDiscoveryPicker';
import { publicDeviceAuthSummary, type DeviceAuthSummary } from './codex-device-auth';
import { statusLabel } from '../../i18n';

type StepState = { ready?: boolean; status?: string; profile_id?: string | null; checks?: Record<string, boolean> };

/** Compatibility setup surface used by Settings and embedded onboarding. */
export function CodexSetup({ state = {}, onChange = async () => undefined }: { state?: StepState; onChange?: () => Promise<unknown> }) {
  const [mode, setMode] = useState<'codex_home' | 'device' | 'manual'>('codex_home');
  const [discovery, setDiscovery] = useState<CodexDiscovery | null>(null);
  const [device, setDevice] = useState<DeviceAuthSummary>({});
  const [deviceId, setDeviceId] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setBusy(true); try { const result = await apiV2<CodexDiscovery>('/api/v2/provider-discovery/codex'); setDiscovery(result.data); } catch { setDiscovery({ sources: [] }); } finally { setBusy(false); } };
  const importDiscovery = async (input: Record<string, unknown>) => { await mutateV2('/api/v2/provider-discovery/codex/import', input, 'POST', 0); await onChange(); return true; };
  const startDevice = async () => { setBusy(true); try { const result = await mutateV2<{ login?: DeviceAuthSummary & { id?: string }; operation?: Record<string, unknown> }>('/api/v2/provider-auth/codex/device-logins', {}, 'POST', 0); const login = result.data.login || {}; setDevice(publicDeviceAuthSummary(login as Record<string, unknown>)); setDeviceId(String(login.id || (result.data.operation as { resource_id?: string } | undefined)?.resource_id || '')); } finally { setBusy(false); } };
  useEffect(() => {
    if (!deviceId || ['completed', 'failed', 'cancelled', 'expired', 'interrupted'].includes(String(device.status || ''))) return undefined;
    let active = true;
    const poll = async () => { try { const result = await apiV2<{ login: DeviceAuthSummary }>(`/api/v2/provider-auth/codex/device-logins/${encodeURIComponent(deviceId)}`); if (active) setDevice(publicDeviceAuthSummary(result.data.login as unknown as Record<string, unknown>)); } catch { /* status remains visible until the next retry */ } };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [device.status, deviceId]);
  return <section className="setup-block codex-compat-setup"><div className="segmented compact" role="group" aria-label="Codex 配置来源"><button className={mode === 'codex_home' ? 'active' : ''} onClick={() => setMode('codex_home')}><Laptop size={14} />本地 Codex</button><button className={mode === 'device' ? 'active' : ''} onClick={() => setMode('device')}><ShieldCheck size={14} />官方账户</button><button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}><KeyRound size={14} />手动 API</button></div>{mode === 'codex_home' && <CodexDiscoveryPicker type="codex_home" data={discovery} busy={busy} onRefresh={refresh} onImport={importDiscovery} />}{mode === 'device' && <div className="device-login-panel"><button className="button primary" disabled={busy} onClick={() => void startDevice()}><ShieldCheck size={15} />启动设备登录</button>{device.status && <div role="status"><span>{statusLabel(device.status)}</span>{device.verification_uri && <a href={device.verification_uri} target="_blank" rel="noreferrer">打开官方授权页</a>}{device.user_code && <code>{device.user_code}</code>}</div>}</div>}{mode === 'manual' && <div className="manual-provider-note"><KeyRound size={16} /><span>手动 API 配置请在“设置 → 凭据与 Profile”中完成。</span></div>}<small className="setup-status-hint">{statusLabel(state.status || 'pending')}</small></section>;
}

export default CodexSetup;
