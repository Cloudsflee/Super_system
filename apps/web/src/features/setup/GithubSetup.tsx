import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, ExternalLink, Github, KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';

type PublicApp = { name: string; app_id: string; client_id: string; slug: string };
type GithubProfile = { id: string; label: string; status: string; revision: number; config?: Record<string, unknown> };
type GithubDiscovery = {
  provider: 'github';
  status: 'connected' | 'verification_required' | 'installation_required' | 'manifest_required';
  app: PublicApp;
  server_managed: boolean;
  profile: GithubProfile | null;
  can_install: boolean;
  can_create_manifest: boolean;
  repositories_count: number;
};
type GithubSetupReceipt = {
  action: 'manifest' | 'installation' | 'complete' | 'sync';
  status: 'authorization_required' | 'installation_required' | 'connected';
  app: PublicApp;
  profile: GithubProfile | null;
  probe: Record<string, unknown> | null;
  repositories: Array<{ id: number | string; full_name: string }>;
  next_cursor: string | null;
  state: string | null;
  manifest: Record<string, unknown> | null;
  manifest_url: string | null;
  installation_url: string | null;
};

type Props = {
  returnPath?: 'setup' | 'settings';
  standalone?: boolean;
  onConnected?: (repositoryCount: number) => void | Promise<void>;
  onSkip?: () => void;
  notify?: (message: string, tone?: 'ok' | 'error') => void;
};

const EMPTY_APP: PublicApp = { name: 'GitHub App', app_id: '', client_id: '', slug: '' };

export function GithubSetup({ returnPath = 'setup', standalone = false, onConnected, onSkip, notify }: Props) {
  const [discovery, setDiscovery] = useState<GithubDiscovery | null>(null);
  const [receipt, setReceipt] = useState<GithubSetupReceipt | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [appId, setAppId] = useState('');
  const [slug, setSlug] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const processedCallback = useRef('');

  const load = useCallback(async () => {
    const result = await apiV2<GithubDiscovery>('/api/v2/provider-discovery/github');
    setDiscovery(result.data);
    setAppId((current) => current || result.data.app?.app_id || '');
    setSlug((current) => current || result.data.app?.slug || '');
    return result.data;
  }, []);

  useEffect(() => {
    void load().catch((error) => setFailure(message(error, 'GitHub 配置读取失败')));
  }, [load]);

  const callback = useMemo(readGithubCallback, []);
  useEffect(() => {
    if (!callback || processedCallback.current === callback.key) return;
    processedCallback.current = callback.key;
    let active = true;
    const finish = async () => {
      setBusy('callback');
      setFailure('');
      try {
        const result = callback.kind === 'manifest'
          ? await mutateV2<GithubSetupReceipt>('/api/v2/provider-auth/github/manifest', {
              action: 'callback', code: callback.code, state: callback.state
            }, 'POST', { expectedRevision: 0, idempotencyKey: callbackIdempotency('manifest', callback.state) })
          : await mutateV2<GithubSetupReceipt>('/api/v2/provider-auth/github/installations', {
              action: 'complete', installation_id: callback.installationId, ...(callback.state ? { state: callback.state } : {})
            }, 'POST', { expectedRevision: 0, idempotencyKey: callbackIdempotency('installation', callback.state || callback.installationId) });
        if (!active) return;
        setReceipt(result.data);
        cleanGithubCallbackUrl();
        const latest = await load();
        if (result.data.status === 'connected') {
          await onConnected?.(result.data.repositories.length || latest.repositories_count || 0);
          notify?.(`GitHub 已连接，发现 ${result.data.repositories.length} 个代码仓库`);
        }
      } catch (error) {
        if (active) {
          const text = message(error, 'GitHub 回调处理失败');
          setFailure(text);
          notify?.(text, 'error');
        }
      } finally {
        if (active) setBusy('');
      }
    };
    void finish();
    return () => { active = false; };
  }, [callback, load, notify, onConnected]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setFailure('');
    try { await action(); }
    catch (error) {
      const text = message(error, 'GitHub 操作失败');
      setFailure(text);
      notify?.(text, 'error');
    } finally { setBusy(''); }
  };

  const startManifest = () => {
    const popup = openPlaceholder('aiws-github-manifest');
    void run('manifest', async () => {
      try {
        const result = await mutateV2<GithubSetupReceipt>('/api/v2/provider-auth/github/manifest', {
          action: 'start', callback_origin: window.location.origin, return_path: returnPath
        }, 'POST', 0);
        setReceipt(result.data);
        submitGithubManifest(result.data, popup);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  };

  const startInstallation = () => {
    const popup = openPlaceholder('aiws-github-installation');
    void run('installation', async () => {
      try {
        const result = await mutateV2<GithubSetupReceipt>('/api/v2/provider-auth/github/installations', {
          action: 'start', callback_origin: window.location.origin, return_path: returnPath,
          ...(discovery?.profile?.id ? { profile_id: discovery.profile.id } : {})
        }, 'POST', 0);
        setReceipt(result.data);
        if (result.data.status === 'connected') {
          popup?.close();
          await load();
          await onConnected?.(result.data.repositories.length);
          return;
        }
        openReceiptUrl(result.data.installation_url, popup);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  };

  const configureExisting = (event: FormEvent) => {
    event.preventDefault();
    void run('configure', async () => {
      try {
        const result = await mutateV2<GithubSetupReceipt>('/api/v2/provider-auth/github/manifest', {
          action: 'configure', confirmed: true, callback_origin: window.location.origin, return_path: returnPath,
          app_id: appId.trim(), slug: slug.trim(), private_key: privateKey,
          ...(webhookSecret ? { webhook_secret: webhookSecret } : {})
        }, 'POST', 0);
        setReceipt(result.data);
        await load();
      } finally {
        setPrivateKey('');
        setWebhookSecret('');
      }
    });
  };

  const sync = () => void run('sync', async () => {
    const profileId = receipt?.profile?.id || discovery?.profile?.id;
    if (!profileId) return;
    const result = await mutateV2<GithubSetupReceipt>('/api/v2/provider-auth/github/installations', {
      action: 'sync', profile_id: profileId
    }, 'POST', 0);
    setReceipt(result.data);
    await load();
    await onConnected?.(result.data.repositories.length);
    notify?.(`已同步 ${result.data.repositories.length} 个代码仓库`);
  });

  const app = receipt?.app || discovery?.app || EMPTY_APP;
  const status = receipt?.status === 'connected'
    ? 'connected'
    : receipt?.status === 'installation_required'
      ? 'installation_required'
      : discovery?.status || 'loading';
  const installationUrl = receipt?.installation_url;
  const repositories = receipt?.repositories || [];
  const loading = !discovery && !failure;

  return <div className={`github-guided-setup${standalone ? ' panel' : ''}`} data-status={status}>
    {standalone && <header className="github-guided-header"><Github size={19} /><div><h2>GitHub App</h2><small>代码仓库访问与交付身份</small></div><GithubStatus value={status} /></header>}
    <div className="github-app-identity">
      <span className="github-app-mark"><Github size={20} /></span>
      <span><strong>{app.name || 'GitHub App'}</strong><small>{app.app_id ? `App ID ${app.app_id}` : '等待 GitHub 配置'}</small></span>
      {status === 'connected' && <Check size={18} />}
    </div>

    {loading && <div className="github-guided-state"><LoaderCircle className="spin" size={16} />读取 GitHub App 配置</div>}
    {busy === 'callback' && <div className="github-guided-state"><LoaderCircle className="spin" size={16} />正在完成 GitHub 回调与仓库验证</div>}

    {!loading && status === 'manifest_required' && <div className="github-guided-actions">
      <button type="button" className="button primary" disabled={Boolean(busy)} onClick={startManifest}>
        {busy === 'manifest' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
        使用 GitHub 引导配置
      </button>
    </div>}

    {!loading && ['installation_required', 'verification_required'].includes(status) && <div className="github-guided-actions">
      {installationUrl
        ? <a className="button primary" href={installationUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开安装页</a>
        : <button type="button" className="button primary" disabled={Boolean(busy)} onClick={startInstallation}>
            {busy === 'installation' ? <LoaderCircle className="spin" size={15} /> : <Github size={15} />}
            安装 GitHub App
          </button>}
      {status === 'verification_required' && discovery?.profile?.id && <button type="button" className="button" disabled={Boolean(busy)} onClick={sync}><RefreshCw size={15} />重新验证</button>}
    </div>}

    {status === 'connected' && <div className="github-connected-state">
      <div><Check size={16} /><span><strong>GitHub 已连接</strong><small>{repositories.length ? `${repositories.length} 个代码仓库可用` : 'Profile 与安装权限已验证'}</small></span></div>
      <button type="button" className="icon-button" aria-label="同步 GitHub 代码仓库" title="同步" disabled={Boolean(busy)} onClick={sync}>{busy === 'sync' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button>
    </div>}
    {repositories.length > 0 && <div className="github-repository-preview">{repositories.slice(0, 8).map((repository) => <span key={String(repository.id)}>{repository.full_name}</span>)}</div>}

    {!loading && status !== 'connected' && <div className="github-advanced">
      <button type="button" className="github-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
        <KeyRound size={14} />已有其他 GitHub App<ChevronDown size={14} />
      </button>
      {advanced && <form onSubmit={configureExisting}>
        <div className="two-column">
          <label><span>App ID</span><input aria-label="已有 GitHub App ID" inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value.replace(/\D/g, ''))} required /></label>
          <label><span>App 标识（Slug，小写）</span><input aria-label="已有 GitHub App 标识" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().trim())} required /></label>
        </div>
        <label><span>私钥</span><textarea aria-label="已有 GitHub App 私钥" rows={5} autoComplete="off" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} required /></label>
        <label><span>Webhook Secret（可选）</span><input aria-label="已有 GitHub Webhook Secret" type="password" autoComplete="off" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} /></label>
        <button type="submit" className="button" disabled={busy === 'configure' || !privateKey}>
          {busy === 'configure' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
          {busy === 'configure' ? '正在绑定…' : '绑定到本地凭据库'}
        </button>
      </form>}
    </div>}

    {onSkip && status !== 'connected' && <button type="button" className="button github-skip" disabled={Boolean(busy)} onClick={onSkip}>稍后配置</button>}
    {failure && <div className="state-banner error github-guided-error" role="alert">{failure}</div>}
  </div>;
}

function GithubStatus({ value }: { value: string }) {
  const connected = value === 'connected';
  return <span className={`status ${connected ? 'positive' : value === 'loading' ? 'working' : 'neutral'}`}><span />{connected ? '已连接' : value === 'loading' ? '读取中' : '待配置'}</span>;
}

function readGithubCallback() {
  const search = new URLSearchParams(window.location.search);
  const hashQuery = new URLSearchParams(String(window.location.hash || '').split('?', 2)[1] || '');
  const value = (key: string) => search.get(key) || hashQuery.get(key) || '';
  const code = value('code');
  const installationId = value('installation_id');
  const state = value('state');
  if (code && state) return { kind: 'manifest' as const, code, state, installationId: '', key: `manifest:${state}:${code}` };
  if (/^[1-9][0-9]{0,19}$/.test(installationId)) return { kind: 'installation' as const, code: '', state, installationId, key: `installation:${state}:${installationId}` };
  return null;
}

function callbackIdempotency(kind: string, value: string) {
  const suffix = String(value || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(-48) || 'callback';
  return `github-${kind}-${suffix}`.slice(0, 120);
}

function cleanGithubCallbackUrl() {
  const url = new URL(window.location.href);
  for (const key of ['github_callback', 'return_path', 'code', 'state', 'installation_id', 'setup_action']) url.searchParams.delete(key);
  const [hashPath, hashRaw = ''] = url.hash.split('?', 2);
  const hashQuery = new URLSearchParams(hashRaw);
  for (const key of ['github_callback', 'return_path', 'code', 'state', 'installation_id', 'setup_action']) hashQuery.delete(key);
  const nextHash = hashQuery.size ? `${hashPath}?${hashQuery}` : hashPath;
  window.history.replaceState(null, '', `${url.pathname}${url.search}${nextHash}`);
}

function submitGithubManifest(receipt: GithubSetupReceipt, popup: Window | null) {
  if (!receipt.state || !receipt.manifest) throw new Error('GitHub Manifest 回执不完整');
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = 'https://github.com/settings/apps/new';
  form.target = popup ? 'aiws-github-manifest' : '_self';
  for (const [name, value] of Object.entries({ state: receipt.state, manifest: JSON.stringify(receipt.manifest) })) {
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}

function openPlaceholder(name: string) {
  const popup = window.open('about:blank', name);
  if (popup) popup.opener = null;
  return popup;
}

function openReceiptUrl(url: string | null, popup: Window | null) {
  if (!url) throw new Error('GitHub 安装地址未返回');
  if (popup) popup.location.replace(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function message(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}
