import { Box, Github, KeyRound, Plus, PlugZap, RefreshCw, Search, ShieldCheck, Unplug } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../api/client';
import { keys, useSetup } from '../../api/queries';
import { useUi } from '../../state/ui';
import type { ChangeProposal, CodexDiscoverySource, CodexProfile, CodexStatus } from '../../api/types';
import { CodexDiscoveryPicker } from '../setup/CodexDiscoveryPicker';
import { ProviderFields, validBaseUrl, type ProviderChoice, type WireApi } from '../setup/CodexProviderFields';
import { useCodexDiscovery } from '../setup/useCodexDiscovery';

type GithubStatus = { connected: boolean; login?: string; installation_count?: number; repository_count?: number };
type ProfileDraft = { name: string; providerChoice: ProviderChoice; customProvider: string; baseUrl: string; wireApi: WireApi; model: string };
const initialProfile: ProfileDraft = { name: '', providerChoice: 'openai', customProvider: '', baseUrl: '', wireApi: 'responses', model: 'gpt-5.1-codex' };
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export function SettingsPage() {
  const setup = useSetup();
  const github = useQuery({ queryKey: ['github-status'], queryFn: () => api<GithubStatus>('/github/status') });
  const profiles = useQuery({ queryKey: ['codex-profiles'], queryFn: () => api<CodexProfile[]>('/codex/profiles') });
  const codex = useQuery({ queryKey: ['codex-status'], queryFn: () => api<CodexStatus>('/codex/status') });
  const [adding, setAdding] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryType, setDiscoveryType] = useState<CodexDiscoverySource['type']>('codex_home');
  const [profile, setProfile] = useState<ProfileDraft>(initialProfile);
  const client = useQueryClient();
  const navigate = useNavigate();
  const ui = useUi();
  const toast = ui.toast;
  const discovery = useCodexDiscovery(async () => { await refresh(); toast('本地 Codex 配置已导入，正在进入重配置'); setDiscoveryOpen(false); }, { reconfigure: true });
  const provider = profile.providerChoice === 'custom' ? profile.customProvider.trim() : profile.providerChoice;
  const thirdParty = profile.providerChoice !== 'openai';
  const profileValid = Boolean(profile.name.trim() && profile.model.trim() && provider && (!thirdParty || validBaseUrl(profile.baseUrl)));

  async function act(path: string, notification: string, body?: unknown) {
    try { await api(path, json('POST', body)); await refresh(); toast(notification); return true; }
    catch (error) { toast((error as Error).message, 'error'); return false; }
  }
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.setup }),
      client.invalidateQueries({ queryKey: ['github-status'] }),
      client.invalidateQueries({ queryKey: ['codex-profiles'] }),
      client.invalidateQueries({ queryKey: ['codex-status'] })
    ]);
  }
  async function reopen(path: string) {
    if (!window.confirm('确认进入重新配置流程？当前 Setup 门禁将重新启用。')) return;
    if (await act(path, '已进入重新配置流程', { confirmed: true })) navigate('/setup');
  }
  function profileBody() {
    return {
      name: profile.name.trim(), provider, model: profile.model.trim(),
      ...(thirdParty ? { base_url: profile.baseUrl.trim(), wire_api: 'responses' as const } : {}),
      reasoning: 'high', web_search: false, timeout_ms: 120000, mounts: []
    };
  }
  async function saveProfile() {
    if (!profileValid || !window.confirm('确认创建新的 Codex Profile？')) return;
    if (await act('/codex/profiles', 'Codex Profile 已创建', { ...profileBody(), confirmed: true })) {
      setAdding(false);
      setProfile(initialProfile);
    }
  }
  async function proposeProfile(id: string) {
    try { const proposal = await api<ChangeProposal>(`/codex/profiles/${id}/propose-apply`, json('POST')); await refresh(); ui.showProposal(proposal.id); }
    catch (error) { toast((error as Error).message, 'error'); }
  }
  function chooseProvider(value: ProviderChoice) {
    setProfile((current) => ({ ...current, providerChoice: value, customProvider: value === 'custom' && !current.customProvider ? 'custom' : current.customProvider, baseUrl: value === 'openai' ? '' : value === 'openrouter' ? OPENROUTER_URL : current.baseUrl === OPENROUTER_URL ? '' : current.baseUrl }));
  }
  function toggleAdding() {
    if (adding) { setAdding(false); return; }
    setDiscoveryOpen(false);
    const auth = codex.data?.auth;
    if (!auth?.provider) { setProfile(initialProfile); setAdding(true); return; }
    const providerChoice: ProviderChoice = auth.provider === 'openai' || auth.provider === 'chatgpt' ? 'openai' : auth.provider === 'openrouter' ? 'openrouter' : 'custom';
    setProfile({ ...initialProfile, providerChoice, customProvider: providerChoice === 'custom' ? auth.provider : '', baseUrl: providerChoice === 'openai' ? '' : auth.base_url || (providerChoice === 'openrouter' ? OPENROUTER_URL : ''), wireApi: 'responses' });
    setAdding(true);
  }
  function toggleDiscovery() { setAdding(false); setDiscoveryOpen((value) => !value); }

  return (
    <section className="settings-page">
      <header className="page-heading"><div><span className="overline">INTEGRATIONS & POLICY</span><h1>设置</h1><p>当前 Owner 工作空间</p></div><span className={`status ${setup.data?.complete ? 'ready' : 'pending'}`}>{setup.data?.complete ? '配置完成' : '需要配置'}</span></header>
      <section className="settings-band">
        <header><Github size={19} /><div><h2>GitHub</h2><p>{github.data?.connected ? `${github.data.login || 'Owner'} · ${github.data.repository_count || 0} repositories` : '未连接'}</p></div><span className={`status ${github.data?.connected ? 'ready' : 'pending'}`}>{github.data?.connected ? 'connected' : 'required'}</span></header>
        <div className="settings-actions">
          <button className="button secondary" onClick={() => act('/github/repositories/sync', 'Repository 已同步')} disabled={!github.data?.connected}><RefreshCw size={15} />同步</button>
          {setup.data?.mode === 'byo' && <button className="button secondary" onClick={() => reopen('/github/app-config/reset')}><KeyRound size={15} />更换 GitHub App</button>}
          <button className="button danger" onClick={() => reopen('/github/disconnect')} disabled={!github.data?.connected}><Unplug size={15} />重新授权</button>
        </div>
      </section>
      <section className="settings-band">
        <header><Box size={19} /><div><h2>Codex Profiles</h2><p>Docker workspace-write · profile scoped CODEX_HOME · endpoint scoped</p></div><span className={`status ${setup.data?.steps.codex.ready ? 'ready' : 'pending'}`}>{setup.data?.steps.codex.status}</span></header>
        <div className="settings-actions"><button className="button secondary" onClick={toggleDiscovery}><Search size={15} />导入本地配置</button><button className="button secondary" onClick={toggleAdding}><Plus size={15} />手动新增 Profile</button><button className="button danger" onClick={() => reopen('/codex/auth/reset')}><KeyRound size={15} />官方账户 / API 重新认证</button></div>
        {discoveryOpen && <div className="settings-discovery"><div className="segmented compact" role="group" aria-label="本地配置来源"><button className={discoveryType === 'codex_home' ? 'active' : ''} onClick={() => setDiscoveryType('codex_home')}>本地 Codex</button><button className={discoveryType === 'cc_switch' ? 'active' : ''} onClick={() => setDiscoveryType('cc_switch')}>cc-switch</button></div><CodexDiscoveryPicker type={discoveryType} data={discovery.data} loading={discovery.loading} error={discovery.error} actionError={discovery.actionError} busy={discovery.busy} reconfigure onRefresh={discovery.refresh} onImport={discovery.importConfig} /></div>}
        {adding && <div className="settings-form codex-settings-form">
          <label>名称<input aria-label="Profile 名称" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
          <ProviderFields providerChoice={profile.providerChoice} customProvider={profile.customProvider} baseUrl={profile.baseUrl} wireApi={profile.wireApi} onProvider={chooseProvider} onCustomProvider={(value) => setProfile({ ...profile, customProvider: value })} onBaseUrl={(value) => setProfile({ ...profile, baseUrl: value })} onWireApi={(value) => setProfile({ ...profile, wireApi: value })} />
          <label className={thirdParty ? 'span-2' : ''}>Model<input aria-label="Profile Model" value={profile.model} onChange={(event) => setProfile({ ...profile, model: event.target.value })} /></label>
          <div className="settings-form-actions span-2"><button className="button primary" disabled={!profileValid} onClick={() => saveProfile()}><Plus size={15} />保存 Profile</button></div>
        </div>}
        <div className="profile-table">{profiles.data?.map((item) => <div key={item.id}><span><PlugZap size={16} /><span><strong>{item.name}</strong><small>{item.provider || 'openai'} · {item.model || 'default'}{item.base_url ? ` · ${item.base_url}` : ''}{item.wire_api ? ` · ${item.wire_api}` : ''}</small></span></span><i className={`status ${item.status}`}>{item.status}</i><button className="button secondary" disabled={item.is_active || item.status !== 'validated'} onClick={() => proposeProfile(item.id)}>{item.is_active ? <ShieldCheck size={15} /> : <RefreshCw size={15} />}{item.is_active ? 'Active' : item.status === 'validated' ? '切换' : '待验证'}</button></div>)}</div>
      </section>
    </section>
  );
}
