import { Check, KeyRound, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { CodexDiscovery, CodexDiscoveryImportInput, CodexDiscoveryProvider, CodexDiscoverySource } from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';

export function CodexDiscoveryPicker({ type, data, loading, error, actionError, busy, reconfigure = false, onRefresh, onImport }: {
  type: CodexDiscoverySource['type']; data: CodexDiscovery | null; loading: boolean; error: string; actionError: string; busy: boolean;
  reconfigure?: boolean;
  onRefresh: () => Promise<unknown>; onImport: (input: CodexDiscoveryImportInput) => Promise<unknown>;
}) {
  const sources = useMemo(() => (data?.sources || []).filter((item) => item.type === type), [data, type]);
  const providers = useMemo(() => sources.flatMap((source) => source.providers.map((provider) => ({ provider, source }))), [sources]);
  const [selectedId, setSelectedId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const selected = providers.find((item) => item.provider.discovery_id === selectedId);
  useEffect(() => {
    if (selectedId && !providers.some((item) => item.provider.discovery_id === selectedId)) setSelectedId('');
  }, [providers, selectedId]);
  useEffect(() => { setSelectedId(''); setApiKey(''); setConfirmed(false); }, [type]);
  useEffect(() => { setApiKey(''); setConfirmed(false); }, [selected?.provider.source_revision]);

  async function submit() {
    if (!selected || !confirmed || (!selected.provider.has_credential && !apiKey.trim())) return;
    const result = await onImport({ discovery_id: selected.provider.discovery_id, source_revision: selected.provider.source_revision, confirmed: true, ...(selected.provider.has_credential ? {} : { api_key: apiKey }) });
    if (result) { setSelectedId(''); setApiKey(''); setConfirmed(false); }
  }

  return <section className="discovery-picker" aria-label={type === 'cc_switch' ? 'cc-switch 配置发现' : '本地 Codex 配置发现'}>
    <header><div><Search size={16} /><div><strong>{type === 'cc_switch' ? '从 cc-switch 选择服务商' : '读取本地 Codex 配置'}</strong><span>{type === 'cc_switch' ? '读取本机 cc-switch 目录中的脱敏服务商摘要' : '读取本机 CODEX_HOME 中 config.toml 与 auth.json 的脱敏摘要'}</span></div></div><button className="button secondary" disabled={loading || busy} onClick={() => void onRefresh()}><RefreshCw className={loading ? 'spin' : ''} size={15} />刷新</button></header>
    {(error || actionError) && <div className="setup-feedback error" role="alert">{actionError || `发现失败：${error}`}</div>}
    {!error && !loading && !sources.length && <div className="discovery-empty"><Search size={19} /><span>未发现此类本地配置</span></div>}
    {sources.map((source) => <div className="discovery-source" key={source.source_id}>
      <div className="discovery-source-head"><span><strong>{source.display_name}</strong><small>{source.path_hint || '路径已隐藏'} · 修订版 {shortRevision(source.revision)}</small></span><i className={`status ${source.status === 'ready' || source.status === 'available' ? 'ready' : ['degraded', 'failed', 'invalid', 'unsupported'].includes(source.status) ? 'failed' : 'pending'}`}>{displayStatus(source.status)}</i></div>
      <div className="discovery-options">{source.providers.map((provider) => <ProviderOption key={provider.discovery_id} source={source} provider={provider} selected={selectedId === provider.discovery_id} onSelect={() => { setSelectedId(provider.discovery_id); setApiKey(''); setConfirmed(false); }} />)}</div>
      {!source.providers.length && <div className="discovery-source-empty">{source.issues?.map(discoveryIssueLabel).join(' · ') || '此来源未发现可导入服务商'}</div>}
    </div>)}
    {selected && <div className="discovery-confirm">
      {!selected.provider.has_credential && <label><span>API 密钥 <em className="required-mark">本地配置未包含可用凭据</em></span><input aria-label="导入配置所需的 API 密钥" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>}
      <label className="discovery-consent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{reconfigure ? '确认导入所选脱敏配置并重新进入首次配置；当前 Codex 配置将被替换' : '确认导入所选脱敏配置，并写入 AIWS 托管的 Codex 配置'}</span></label>
      <button className="button primary" disabled={busy || !confirmed || (!selected.provider.has_credential && !apiKey.trim())} onClick={() => void submit()}><Check size={15} />确认导入配置</button>
    </div>}
  </section>;
}

function ProviderOption({ source, provider, selected, onSelect }: { source: CodexDiscoverySource; provider: CodexDiscoveryProvider; selected: boolean; onSelect: () => void }) {
  const importable = provider.importable !== false;
  return <label className={`discovery-option ${selected ? 'selected' : ''} ${importable ? '' : 'disabled'}`} aria-disabled={!importable}>
    <input type="radio" name={`discovery-${source.type}`} value={provider.discovery_id} checked={selected} disabled={!importable} onChange={onSelect} />
    <span className="discovery-option-main"><strong>{provider.name || provider.provider_name || provider.provider}</strong><small>{provider.provider} · {provider.model || '默认模型'}</small><small>{endpointHint(provider.base_url)}</small></span>
    <span className={`credential-summary ${provider.has_credential ? 'ready' : 'missing'}`}>{provider.has_credential ? <ShieldCheck size={14} /> : <KeyRound size={14} />}{credentialLabel(provider)}</span>
  </label>;
}

function endpointHint(value?: string | null) {
  if (!value) return '官方接口地址';
  try { return `${new URL(value).origin}/...`; } catch { return '接口地址已脱敏'; }
}
function credentialLabel(provider: CodexDiscoveryProvider) { return provider.importable === false && provider.issues?.includes('official_device_login_required') ? '需官方账户登录' : provider.credential_kind === 'oauth_bundle' ? '本地登录可复用' : provider.has_credential ? '凭据已配置（内容隐藏）' : '需 API 密钥'; }
function shortRevision(value: string | null) { return value ? value.slice(0, 10) : '未知'; }
function discoveryIssueLabel(value: string) { return ({ official_device_login_required: '需要官方账户登录', credential_missing: '缺少可用凭据', invalid_endpoint: '接口地址无效', unsupported_provider: '暂不支持此服务商' } as Record<string, string>)[value] || '配置存在问题'; }
