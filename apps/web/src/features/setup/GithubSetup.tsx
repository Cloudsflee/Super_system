import { Check, ExternalLink, Github, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, json } from '../../api/client';
import type { StepState } from '../../api/types';

type Device = { request_id: string; user_code: string; verification_uri: string };
type Repository = { id: string; full_name: string; selected: boolean };
type Installation = { id: string; installation_id: string; repositories: Repository[] };
type Discovery = { installed: boolean; installations: Installation[] };
type StartResult = { installation_url?: string; installation?: Installation };
const INSTALL_URL_KEY = 'aiws-github-installation-url';

export function GithubSetup({ mode, state, onChange }: { mode: 'hosted' | 'byo'; state: StepState; onChange: () => Promise<unknown> }) {
  const [form, setForm] = useState({ app_id: '', client_id: '', client_secret: '', private_key: '', webhook_secret: '' });
  const [device, setDevice] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [installationUrl, setInstallationUrl] = useState(() => sessionStorage.getItem(INSTALL_URL_KEY) || '');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const checks = state.checks || {};

  const loadInstallations = useCallback(async () => {
    const items = await api<Installation[]>('/github/installations');
    setInstallations(items);
    setSelected(items.flatMap((item) => item.repositories.filter((repo) => repo.selected).map((repo) => repo.id)));
  }, []);

  useEffect(() => {
    if (checks.account_connected) void loadInstallations().catch((value) => setError(message(value)));
  }, [checks.account_connected, state.status, state.installation_count, loadInstallations]);

  useEffect(() => {
    if (mode !== 'byo' || checks.app_configured) return;
    void api<{ app_id?: string; client_id?: string }>('/github/app-config/defaults').then((value) => setForm((current) => ({ ...current, app_id: current.app_id || value.app_id || '', client_id: current.client_id || value.client_id || '' }))).catch(() => undefined);
  }, [mode, checks.app_configured]);

  const discover = useCallback(async (silent = false) => {
    setBusy(true);
    if (!silent) { setError(''); setFeedback('正在检查 GitHub installation…'); }
    try {
      const result = await api<Discovery>('/github/installations/discover', json('POST'));
      if (!result.installed) { if (!silent) setFeedback('尚未检测到安装，请先在 GitHub 完成安装。'); return false; }
      setInstallations(result.installations);
      setSelected(result.installations.flatMap((item) => item.repositories.filter((repo) => repo.selected).map((repo) => repo.id)));
      sessionStorage.removeItem(INSTALL_URL_KEY);
      setInstallationUrl('');
      setFeedback('已发现 App installation，请选择 repository。');
      await onChange();
      return true;
    } catch (value) {
      if (!silent) setError(message(value));
      return false;
    } finally { setBusy(false); }
  }, [onChange]);

  useEffect(() => {
    if (!installationUrl || checks.installation_installed) return;
    const syncOnReturn = () => { if (document.visibilityState === 'visible') void discover(true); };
    window.addEventListener('focus', syncOnReturn);
    document.addEventListener('visibilitychange', syncOnReturn);
    return () => { window.removeEventListener('focus', syncOnReturn); document.removeEventListener('visibilitychange', syncOnReturn); };
  }, [installationUrl, checks.installation_installed, discover]);

  async function act(task: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await task(); await onChange(); } catch (value) { setError(message(value)); } finally { setBusy(false); }
  }
  async function saveManual() { await act(() => api('/github/app-config/validate', json('POST', form))); }
  async function startManifest() {
    setBusy(true); setError('');
    try { const result = await api<{ state: string; manifest: Record<string, unknown> }>('/github/manifest/start', json('POST')); localStorage.setItem('aiws-github-manifest-state', result.state); const manifestForm = document.createElement('form'); manifestForm.method = 'POST'; manifestForm.action = 'https://github.com/settings/apps/new'; for (const [name, value] of Object.entries({ state: result.state, manifest: JSON.stringify(result.manifest) })) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; manifestForm.append(input); } document.body.append(manifestForm); manifestForm.submit(); }
    catch (value) { setError(message(value)); setBusy(false); }
  }
  async function connect() {
    const popup = window.open('about:blank', 'aiws-github-device');
    if (popup) popup.opener = null;
    setBusy(true); setError('');
    try { const result = await api<Device>('/github/device/start', json('POST', { mode })); setDevice(result); if (popup) popup.location.replace(result.verification_uri); else window.open(result.verification_uri, '_blank', 'noopener,noreferrer'); }
    catch (value) { popup?.close(); setError(message(value)); }
    finally { setBusy(false); }
  }
  async function poll() {
    if (!device) return;
    setBusy(true); setError('');
    try { const result = await api<{ connected?: boolean; error?: string }>('/github/device/poll', json('POST', { request_id: device.request_id })); if (result.connected) { setDevice(null); setFeedback('GitHub Owner 授权已完成。'); } else setFeedback(result.error === 'authorization_pending' ? 'GitHub 尚未确认授权，请完成后再次检查。' : result.error || '等待 GitHub 授权。'); await onChange(); }
    catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }
  async function openInstallation() {
    const popup = window.open('about:blank', 'aiws-github-install');
    if (popup) popup.opener = null;
    setBusy(true); setError('');
    try {
      const result = await api<StartResult>('/github/installations/start', json('POST', { mode }));
      if (result.installation) { popup?.close(); setInstallations([result.installation]); await onChange(); return; }
      if (!result.installation_url) throw new Error('未返回 GitHub installation 地址');
      sessionStorage.setItem(INSTALL_URL_KEY, result.installation_url);
      setInstallationUrl(result.installation_url);
      setFeedback('已在新标签页打开 GitHub；安装完成后返回本页同步。');
      if (popup) popup.location.replace(result.installation_url); else window.open(result.installation_url, '_blank', 'noopener,noreferrer');
    } catch (value) { popup?.close(); setError(message(value)); } finally { setBusy(false); }
  }
  async function saveRepositories(item: Installation) {
    const repositoryIds = item.repositories.filter((repo) => selected.includes(repo.id)).map((repo) => repo.id);
    await act(() => api(`/github/installations/${item.installation_id}/repositories`, json('PUT', { repository_ids: repositoryIds })));
  }

  const installed = Boolean(checks.installation_installed || state.installation_count || installations.length);
  return (
    <section className="setup-section">
      <div className="section-title"><Github size={18} /><div><h2>GitHub</h2><p>{state.detail || '等待连接'}</p></div><Status ready={state.ready} status={state.status} /></div>
      {mode === 'byo' && !checks.app_configured && <div className="setup-block">
        <div className="block-head"><strong>GitHub App</strong><button className="text-button" onClick={startManifest}>通过 Manifest 创建 <ExternalLink size={13} /></button></div>
        <div className="form-grid">
          <label>App ID<input value={form.app_id} onChange={(event) => setForm({ ...form, app_id: event.target.value })} /></label>
          <label>Client ID<input value={form.client_id} onChange={(event) => setForm({ ...form, client_id: event.target.value })} /></label>
          <label>Client Secret<input type="password" value={form.client_secret} onChange={(event) => setForm({ ...form, client_secret: event.target.value })} /></label>
          <label>Webhook Secret<input type="password" value={form.webhook_secret} onChange={(event) => setForm({ ...form, webhook_secret: event.target.value })} /></label>
          <label className="span-2">Private Key<textarea rows={4} value={form.private_key} onChange={(event) => setForm({ ...form, private_key: event.target.value })} /></label>
        </div>
        <div className="block-actions"><button className="button primary" disabled={busy || !form.app_id || !form.client_id || !form.client_secret || !form.private_key || !form.webhook_secret} onClick={saveManual}><KeyRound size={15} />验证并保存</button></div>
      </div>}
      {(mode === 'hosted' || checks.app_configured) && !checks.account_connected && <div className="setup-row"><div><strong>Owner 授权</strong><span>{device ? `验证码 ${device.user_code}` : checks.app_configured ? 'GitHub OAuth Device Flow' : 'Hosted GitHub App 尚未配置'}</span></div>{device ? <button className="button primary" disabled={busy} onClick={poll}><RefreshCw size={15} />检查授权</button> : <button className="button primary" disabled={busy || !checks.app_configured} onClick={connect}><ExternalLink size={15} />连接 GitHub</button>}</div>}
      {checks.account_connected && !installed && !installationUrl && <div className="setup-row"><div><strong>App Installation</strong><span>已经安装过可直接同步；否则在新标签页安装</span></div><div className="setup-actions"><button className="button secondary" disabled={busy} onClick={() => discover(false)}><RefreshCw size={15} />已安装，立即同步</button><button className="button primary" disabled={busy} onClick={openInstallation}><Github size={15} />打开安装页</button></div></div>}
      {checks.account_connected && !installed && installationUrl && <div className="setup-block installation-waiting"><div><strong>等待 GitHub 安装</strong><span>完成后返回此页面，系统会自动检查；也可以立即手动同步。</span></div><div className="block-actions"><a className="button secondary" href={installationUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />重新打开</a><button className="button primary" disabled={busy} onClick={() => discover(false)}><RefreshCw size={15} />我已安装，立即同步</button></div></div>}
      {!state.ready && installations.map((item) => <RepositoryPicker key={item.id} item={item} selected={selected} busy={busy} setSelected={setSelected} save={() => saveRepositories(item)} sync={() => discover(false)} />)}
      {(busy || feedback || error) && <div className={`setup-feedback${error ? ' error' : ''}`}>{busy && <LoaderCircle className="spin" size={15} />}<span>{error || feedback || '正在验证'}</span></div>}
    </section>
  );
}

function RepositoryPicker({ item, selected, busy, setSelected, save, sync }: { item: Installation; selected: string[]; busy: boolean; setSelected: React.Dispatch<React.SetStateAction<string[]>>; save: () => void; sync: () => void }) {
  const count = item.repositories.filter((repo) => selected.includes(repo.id)).length;
  return <div className="setup-block repository-picker"><strong>Repository</strong>{item.repositories.length ? item.repositories.map((repo) => <label key={repo.id}><input type="checkbox" checked={selected.includes(repo.id)} onChange={(event) => setSelected((values) => event.target.checked ? [...new Set([...values, repo.id])] : values.filter((value) => value !== repo.id))} />{repo.full_name}</label>) : <p>当前 installation 没有可访问的 repository，请在 GitHub 调整授权范围后重新同步。</p>}<div className="block-actions"><button className="button secondary" disabled={busy} onClick={sync}><RefreshCw size={15} />重新同步</button>{item.repositories.length > 0 && <button className="button primary" disabled={!count || busy} onClick={save}><Check size={15} />确认选择</button>}</div></div>;
}

function Status({ ready, status }: { ready: boolean; status: string }) { return <span className={`status ${ready ? 'ready' : 'pending'}`}>{ready && <Check size={12} />}{status}</span>; }
function message(value: unknown) { return value instanceof Error ? value.message : 'GitHub 操作失败'; }
