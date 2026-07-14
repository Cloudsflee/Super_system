import { ExternalLink, RefreshCw, Route } from 'lucide-react';
import type { CcSwitchSource, CcSwitchStatus } from '../../api/types';

const SOURCES: CcSwitchSource[] = [
  { name: 'cc-switch Desktop', repo: 'https://github.com/farion1231/cc-switch.git' },
  { name: 'cc-switch CLI', repo: 'https://github.com/SaladDay/cc-switch-cli.git' }
];

export function CcSwitchCard({ status, loading, error, required, busy, onReload, onSync }: {
  status: CcSwitchStatus | null;
  loading: boolean;
  error: string;
  required: boolean;
  busy: boolean;
  onReload: () => Promise<void>;
  onSync: () => Promise<void>;
}) {
  const sources = status?.sources?.length ? status.sources : SOURCES;
  const state = loading ? 'loading' : error ? 'failed' : status?.status || 'not_synced';
  const ready = state === 'synced';
  return (
    <section className={`cc-switch-card ${required ? 'required' : ''}`} aria-labelledby="cc-switch-title">
      <header>
        <div><Route size={17} /><div><strong id="cc-switch-title">cc-switch 管理工具（可选）</strong><span>仅用于显式选择 cc-switch 管理模式的配置变更</span></div></div>
        <span className={`status ${ready ? 'ready' : state === 'failed' || state === 'degraded' ? 'failed' : 'pending'}`}>{statusLabel(state)}</span>
      </header>
      <p className={required ? 'cc-switch-required' : ''}>{required ? '当前配置变更已显式选择 cc-switch 管理模式。' : '普通 Profile 默认直接使用 AIWS 托管配置，不依赖此工具。'}</p>
      <div className="cc-switch-sources" aria-label="cc-switch 工具来源">
        {sources.map((source) => <div key={source.repo || source.name}><a href={source.repo} target="_blank" rel="noreferrer"><ExternalLink size={13} />{source.name}</a><span className={`status ${source.status === 'synced' ? 'ready' : source.status === 'degraded' ? 'failed' : 'pending'}`}>{source.status ? statusLabel(source.status) : '待同步'}</span>{source.error && <small data-tooltip={source.error}>同步失败</small>}</div>)}
      </div>
      {status?.providers?.length ? <div className="cc-switch-providers" aria-label="cc-switch Provider 映射">{status.providers.map((item) => <span key={item.profile_id || item.provider_id || item.name}><strong>{item.name || item.provider || item.provider_id}</strong><small>{item.model || item.base_url || '已创建映射'}</small></span>)}</div> : null}
      {status?.local_path && <code className="cc-switch-path" data-tooltip={status.local_path}>{status.local_path}</code>}
      {error && <div className="setup-feedback error" role="alert">状态读取失败：{error}</div>}
      <div className="block-actions">
        <button className="button secondary" disabled={loading || busy} onClick={() => void onReload()}><RefreshCw size={15} />刷新状态</button>
        <button className={required && !ready ? 'button primary' : 'button secondary'} disabled={busy || loading} onClick={() => void onSync()}><RefreshCw size={15} />{ready ? '更新管理工具' : '安装管理工具'}</button>
      </div>
    </section>
  );
}

function statusLabel(value: string) {
  return ({ loading: '读取中', synced: '已同步', not_synced: '未同步', degraded: '部分失败', failed: '读取失败' } as Record<string, string>)[value] || value;
}
