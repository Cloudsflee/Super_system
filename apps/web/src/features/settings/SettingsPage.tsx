import { Box, Copy, Github, HardDrive, KeyRound, Network, Plus, PlugZap, RefreshCw, Search, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../api/client';
import { keys, useDeployment, useProjects, useSetup } from '../../api/queries';
import { useUi } from '../../state/ui';
import type { ChangeProposal, CodexDiscoverySource, CodexProfile, CodexStatus, McpClientCreated, McpClientList } from '../../api/types';
import { CodexDiscoveryPicker } from '../setup/CodexDiscoveryPicker';
import { ProviderFields, validBaseUrl, type ProviderChoice, type WireApi } from '../setup/CodexProviderFields';
import { useCodexDiscovery } from '../setup/useCodexDiscovery';
import { DEFAULT_CODEX_TIMEOUT_MINUTES, codexTimeoutMinutesToMs, formatCodexTimeout, validCodexTimeoutMinutes } from '../setup/codex-timeout';

type GithubStatus = { connected: boolean; login?: string; installation_count?: number; repository_count?: number };
type ProfileDraft = { name: string; providerChoice: ProviderChoice; customProvider: string; baseUrl: string; wireApi: WireApi; model: string; timeoutMinutes: number };
const initialProfile: ProfileDraft = { name: '', providerChoice: 'openai', customProvider: '', baseUrl: '', wireApi: 'responses', model: 'gpt-5.1-codex', timeoutMinutes: DEFAULT_CODEX_TIMEOUT_MINUTES };
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MCP_SCOPES = ['system:read', 'project:read', 'project:write', 'workflow:read', 'workflow:write', 'assist:read', 'assist:write', 'runs:read', 'runs:write', 'files:read', 'files:write', 'terminal:read', 'terminal:write', 'terminal:execute', 'git:read', 'git:write', 'github:read', 'assets:read', 'assets:write', 'governance:read', 'governance:write', 'approval:read', 'setup:read'];

export function SettingsPage() {
  const setup = useSetup();
  const deployment = useDeployment();
  const github = useQuery({ queryKey: ['github-status'], queryFn: () => api<GithubStatus>('/github/status') });
  const profiles = useQuery({ queryKey: ['codex-profiles'], queryFn: () => api<CodexProfile[]>('/codex/profiles') });
  const codex = useQuery({ queryKey: ['codex-status'], queryFn: () => api<CodexStatus>('/codex/status') });
  const mcpClients = useQuery({ queryKey: ['mcp-clients'], queryFn: () => api<McpClientList>('/mcp/clients') });
  const projects = useProjects();
  const [adding, setAdding] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryType, setDiscoveryType] = useState<CodexDiscoverySource['type']>('codex_home');
  const [profile, setProfile] = useState<ProfileDraft>(initialProfile);
  const [mcpAdding, setMcpAdding] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpSubject, setMcpSubject] = useState('');
  const [mcpScopes, setMcpScopes] = useState<string[]>(DEFAULT_MCP_SCOPES);
  const [mcpProjects, setMcpProjects] = useState<string[]>([]);
  const [mcpExpires, setMcpExpires] = useState(true);
  const [mcpExpiryDays, setMcpExpiryDays] = useState(30);
  const [mcpConcurrency, setMcpConcurrency] = useState(4);
  const [mcpRate, setMcpRate] = useState(120);
  const [createdMcp, setCreatedMcp] = useState<McpClientCreated | null>(null);
  const [snippetMode, setSnippetMode] = useState<'codex' | 'stdio'>('codex');
  const client = useQueryClient();
  const navigate = useNavigate();
  const ui = useUi();
  const toast = ui.toast;
  const discovery = useCodexDiscovery(async () => { await refresh(); toast('本地 Codex 配置已导入，正在进入重配置'); setDiscoveryOpen(false); }, { reconfigure: true });
  const provider = profile.providerChoice === 'custom' ? profile.customProvider.trim() : profile.providerChoice;
  const thirdParty = profile.providerChoice !== 'openai';
  const profileValid = Boolean(profile.name.trim() && profile.model.trim() && provider && (!thirdParty || validBaseUrl(profile.baseUrl)) && validCodexTimeoutMinutes(profile.timeoutMinutes));
  const codexImport = deployment.data?.mode !== 'container' || Boolean(deployment.data?.imports.codex_home);
  const ccSwitchImport = deployment.data?.mode !== 'container' || Boolean(deployment.data?.imports.cc_switch);
  const visibleMcpClients = mcpClients.data?.clients || [];
  const mcpSubjects = mcpClients.data?.available_subjects || [];
  const selectedMcpSubject = mcpSubject || mcpSubjects[0]?.id || '';
  const teamGateway = Boolean(deployment.data?.collaboration?.mcp_gateway);

  async function act(path: string, notification: string, body?: unknown) {
    try { await api(path, json('POST', body, notification)); await refresh(); toast(notification); return true; }
    catch (error) { toast((error as Error).message, 'error'); return false; }
  }
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.setup }),
      client.invalidateQueries({ queryKey: ['github-status'] }),
      client.invalidateQueries({ queryKey: ['codex-profiles'] }),
      client.invalidateQueries({ queryKey: ['codex-status'] })
      ,client.invalidateQueries({ queryKey: ['mcp-clients'] })
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
      reasoning: 'high', web_search: false, timeout_ms: codexTimeoutMinutesToMs(profile.timeoutMinutes), mounts: []
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
    try { const proposal = await api<ChangeProposal>(`/codex/profiles/${id}/propose-apply`, json('POST', undefined, '创建 Codex Profile 切换提案')); await refresh(); ui.showProposal(proposal.id); }
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
  function toggleDiscovery() { setAdding(false); if (!codexImport && !ccSwitchImport) return; if (!codexImport) setDiscoveryType('cc_switch'); else if (!ccSwitchImport) setDiscoveryType('codex_home'); setDiscoveryOpen((value) => !value); }
  function toggleMcpScope(scope: string) { setMcpScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]); }
  function toggleMcpProject(projectId: string) { setMcpProjects((current) => current.includes(projectId) ? current.filter((item) => item !== projectId) : [...current, projectId]); }
  async function createMcp() {
    if (!mcpName.trim() || !mcpScopes.length || teamGateway && (!selectedMcpSubject || !mcpProjects.length)) return;
    try {
      const result = await api<McpClientCreated>('/mcp/clients', json('POST', {
        name: mcpName.trim(), subject_user_id: selectedMcpSubject || undefined, scopes: mcpScopes, project_allowlist: mcpProjects,
        ...(mcpExpires ? { expires_at: new Date(Date.now() + mcpExpiryDays * 24 * 60 * 60 * 1000).toISOString() } : {}),
        concurrent_limit: mcpConcurrency, rate_limit_per_minute: mcpRate
      }, '创建 MCP Client'));
      setCreatedMcp(result); setMcpAdding(false); setMcpName(''); await client.invalidateQueries({ queryKey: ['mcp-clients'] }); toast('MCP Client 已创建');
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  async function revokeMcp(id: string, name: string) {
    if (!window.confirm(`确认撤销 ${name}？`)) return;
    try { await api(`/mcp/clients/${id}`, json('DELETE', undefined, '撤销 MCP Client')); await client.invalidateQueries({ queryKey: ['mcp-clients'] }); toast('MCP Client 已撤销'); }
    catch (error) { toast((error as Error).message, 'error'); }
  }
  async function copyMcp(value: string) { try { await navigator.clipboard.writeText(value); toast('已复制'); } catch { toast('复制失败', 'error'); } }

  return (
    <section className="settings-page">
      <header className="page-heading"><div><span className="overline">INTEGRATIONS & POLICY</span><h1>设置</h1><p>当前 Owner 工作空间</p></div><span className={`status ${setup.data?.complete ? 'ready' : 'pending'}`}>{setup.data?.complete ? '配置完成' : '需要配置'}</span></header>
      <section className="settings-band deployment-band">
        <header><HardDrive size={19} /><div><h2>Deployment</h2><p>{deployment.data?.mode === 'container' ? 'Container · Docker volume · socket' : 'Host development · local directory'}</p></div><span className={`status ${deployment.data?.storage?.ready && deployment.data?.docker?.ready ? 'ready' : 'pending'}`}>{deployment.data?.collaboration?.mcp_gateway ? 'team gateway' : 'local only'}</span></header>
        <div className="deployment-flags"><span>Storage <b>{deployment.data?.storage?.ready ? 'ready' : 'unavailable'}</b></span><span>Docker <b>{deployment.data?.docker?.ready ? 'ready' : 'unavailable'}</b></span><span>MCP Gateway <b>{deployment.data?.collaboration?.mcp_gateway ? 'ready' : 'local'}</b></span><span>Codex import <b>{deployment.data?.imports?.codex_home ? 'ready' : 'off'}</b></span><span>cc-switch <b>{deployment.data?.imports?.cc_switch ? 'ready' : 'off'}</b></span><span>Projects root <b>{deployment.data?.imports?.projects_root ? deployment.data.imports.project_path_mode : 'off'}</b></span></div>
      </section>
      <section className="settings-band mcp-settings-band">
        <header><Network size={19} /><div><h2>MCP Clients</h2><p>Streamable HTTP · stdio bridge · project scoped</p></div><span className={`status ${visibleMcpClients.some((item) => item.status === 'active') ? 'ready' : 'pending'}`}>{visibleMcpClients.filter((item) => item.status === 'active').length} active</span></header>
        <div className="settings-actions"><button className="button secondary" onClick={() => setMcpAdding((value) => !value)}><Plus size={15} />创建 Client</button></div>
        {mcpAdding && <div className="mcp-client-form">
          <div className="mcp-form-grid">
             <label>名称<input aria-label="MCP Client 名称" value={mcpName} maxLength={120} onChange={(event) => setMcpName(event.target.value)} /></label>
             <label>绑定用户<select aria-label="MCP Client 绑定用户" value={selectedMcpSubject} onChange={(event) => setMcpSubject(event.target.value)}>{mcpSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.display_name} · {subject.role}</option>)}</select></label>
            <label>并发上限<input aria-label="MCP Client 并发上限" type="number" min={1} max={32} value={mcpConcurrency} onChange={(event) => setMcpConcurrency(Number(event.target.value))} /></label>
            <label>每分钟请求<input aria-label="MCP Client 每分钟请求" type="number" min={1} max={6000} value={mcpRate} onChange={(event) => setMcpRate(Number(event.target.value))} /></label>
            <label className="mcp-expiry-toggle"><input type="checkbox" checked={mcpExpires} onChange={(event) => setMcpExpires(event.target.checked)} />设置到期</label>
            {mcpExpires && <label>有效天数<input aria-label="MCP Client 有效天数" type="number" min={1} max={366} value={mcpExpiryDays} onChange={(event) => setMcpExpiryDays(Number(event.target.value))} /></label>}
          </div>
          <fieldset><legend>Scopes</legend><div className="mcp-choice-grid">{(mcpClients.data?.available_scopes || DEFAULT_MCP_SCOPES).map((scope) => <label key={scope}><input type="checkbox" checked={mcpScopes.includes(scope)} onChange={() => toggleMcpScope(scope)} /><span>{scope}</span></label>)}</div></fieldset>
          <fieldset><legend>Projects</legend><div className="mcp-choice-grid project-choices">{!teamGateway && <label><input type="checkbox" checked={!mcpProjects.length} onChange={() => setMcpProjects([])} /><span>All projects</span></label>}{projects.data?.map((project) => <label key={project.id}><input type="checkbox" checked={mcpProjects.includes(project.id)} onChange={() => toggleMcpProject(project.id)} /><span>{project.title}</span></label>)}</div></fieldset>
          <div className="settings-form-actions"><button className="button primary" disabled={!mcpName.trim() || !mcpScopes.length || teamGateway && (!selectedMcpSubject || !mcpProjects.length) || mcpConcurrency < 1 || mcpConcurrency > 32 || mcpRate < 1 || mcpRate > 6000} onClick={() => createMcp()}><Plus size={15} />创建</button></div>
        </div>}
        {createdMcp && <div className="mcp-credential">
          <header><div><strong>一次性凭据</strong><small>{createdMcp.client.name}</small></div><button className="icon-button" data-tooltip="关闭凭据" aria-label="关闭凭据" onClick={() => setCreatedMcp(null)}><X size={16} /></button></header>
          <div className="mcp-token-line"><code>{createdMcp.token}</code><button className="icon-button" data-tooltip="复制 token" aria-label="复制 token" onClick={() => copyMcp(createdMcp.token)}><Copy size={15} /></button></div>
          <div className="segmented compact" role="group" aria-label="MCP 配置格式"><button className={snippetMode === 'codex' ? 'active' : ''} onClick={() => setSnippetMode('codex')}>Codex</button><button className={snippetMode === 'stdio' ? 'active' : ''} onClick={() => setSnippetMode('stdio')}>stdio</button></div>
          <div className="mcp-snippet"><pre>{snippetMode === 'codex' ? `$env:AIWS_MCP_TOKEN=${JSON.stringify(createdMcp.token)}\n${createdMcp.configuration.codex_toml}` : JSON.stringify(createdMcp.configuration.stdio_json, null, 2)}</pre><button className="icon-button" data-tooltip="复制配置" aria-label="复制配置" onClick={() => copyMcp(snippetMode === 'codex' ? `$env:AIWS_MCP_TOKEN=${JSON.stringify(createdMcp.token)}\n${createdMcp.configuration.codex_toml}` : JSON.stringify(createdMcp.configuration.stdio_json, null, 2))}><Copy size={15} /></button></div>
        </div>}
        <div className="mcp-client-table">{visibleMcpClients.map((item) => <div key={item.id}><span><Network size={16} /><span><strong>{item.name}</strong><small>{item.token_prefix}… · {item.scopes.length} scopes · {item.project_allowlist.length ? `${item.project_allowlist.length} projects` : 'all projects'} · {mcpSubjects.find((subject) => subject.id === item.subject_user_id)?.display_name || 'service'}</small></span></span><span><i className={`status ${item.status}`}>{item.status}</i><small>{item.expires_at ? new Date(item.expires_at).toLocaleDateString() : 'no expiry'}</small></span><span>{item.usage_count} calls</span><button className="icon-button danger" data-tooltip="撤销 Client" aria-label={`撤销 ${item.name}`} disabled={item.status !== 'active'} onClick={() => revokeMcp(item.id, item.name)}><Trash2 size={15} /></button></div>)}</div>
      </section>
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
        <div className="settings-actions"><button className="button secondary" disabled={!codexImport && !ccSwitchImport} onClick={toggleDiscovery}><Search size={15} />导入本地配置</button><button className="button secondary" onClick={toggleAdding}><Plus size={15} />手动新增 Profile</button><button className="button danger" onClick={() => reopen('/codex/auth/reset')}><KeyRound size={15} />官方账户 / API 重新认证</button></div>
        {discoveryOpen && <div className="settings-discovery"><div className="segmented compact" role="group" aria-label="本地配置来源"><button disabled={!codexImport} className={discoveryType === 'codex_home' ? 'active' : ''} onClick={() => setDiscoveryType('codex_home')}>本地 Codex</button><button disabled={!ccSwitchImport} className={discoveryType === 'cc_switch' ? 'active' : ''} onClick={() => setDiscoveryType('cc_switch')}>cc-switch</button></div><CodexDiscoveryPicker type={discoveryType} data={discovery.data} loading={discovery.loading} error={discovery.error} actionError={discovery.actionError} busy={discovery.busy} reconfigure onRefresh={discovery.refresh} onImport={discovery.importConfig} /></div>}
        {adding && <div className="settings-form codex-settings-form">
          <label>名称<input aria-label="Profile 名称" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
          <ProviderFields providerChoice={profile.providerChoice} customProvider={profile.customProvider} baseUrl={profile.baseUrl} wireApi={profile.wireApi} onProvider={chooseProvider} onCustomProvider={(value) => setProfile({ ...profile, customProvider: value })} onBaseUrl={(value) => setProfile({ ...profile, baseUrl: value })} onWireApi={(value) => setProfile({ ...profile, wireApi: value })} />
          <label className={thirdParty ? 'span-2' : ''}>Model<input aria-label="Profile Model" value={profile.model} onChange={(event) => setProfile({ ...profile, model: event.target.value })} /></label>
          <label>任务超时（分钟）<input aria-label="Profile 任务超时（分钟）" type="number" min={1} max={30} step={1} value={profile.timeoutMinutes} onChange={(event) => setProfile({ ...profile, timeoutMinutes: Number(event.target.value) })} /></label>
          <div className="settings-form-actions span-2"><button className="button primary" disabled={!profileValid} onClick={() => saveProfile()}><Plus size={15} />保存 Profile</button></div>
        </div>}
        <div className="profile-table">{profiles.data?.map((item) => { const hostDisabled = deployment.data?.mode === 'container' && item.kind === 'host'; return <div key={item.id}><span><PlugZap size={16} /><span><strong>{item.name}</strong><small>{hostDisabled ? 'Host Profile 在容器部署中不可用' : `${item.provider || 'openai'} · ${item.model || 'default'} · ${formatCodexTimeout(item.timeout_ms)}${item.base_url ? ` · ${item.base_url}` : ''}${item.wire_api ? ` · ${item.wire_api}` : ''}`}</small></span></span><i className={`status ${item.status}`}>{hostDisabled ? 'disabled' : item.status}</i><button className="button secondary" disabled={hostDisabled || item.is_active || item.status !== 'validated'} onClick={() => proposeProfile(item.id)}>{item.is_active && !hostDisabled ? <ShieldCheck size={15} /> : <RefreshCw size={15} />}{hostDisabled ? '不可用' : item.is_active ? 'Active' : item.status === 'validated' ? '切换' : '待验证'}</button></div>; })}</div>
      </section>
    </section>
  );
}
