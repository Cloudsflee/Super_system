import { Check, Copy, ExternalLink, Github, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api, json } from '../../api/client';
import type { StepState } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';
import { displayStatus, setupDetailLabel } from '../../components/common/display-labels';
import {
  GITHUB_INSTALL_URL_KEY,
  openGithubInstallation,
  startGithubManifest,
  type GithubInstallation as Installation,
  type GithubRepository as Repository
} from './GithubSetupActions';
import { GithubAppConfiguration, GithubInstallationStart, GithubOwnerAuthorization } from './GithubSetupStages';

type Device = { request_id: string; user_code: string; verification_uri: string };
type Discovery = { installed: boolean; installations: Installation[] };

function useGithubSetupController({
  mode,
  state,
  onChange
}: {
  mode: 'hosted' | 'byo';
  state: StepState;
  onChange: () => Promise<unknown>;
}) {
  const [form, setForm] = useState({
    app_id: '',
    client_id: '',
    client_secret: '',
    private_key: '',
    webhook_secret: ''
  });
  const [busy, setBusy] = useState(false);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [installationUrl, setInstallationUrl] = useState(() => sessionStorage.getItem(GITHUB_INSTALL_URL_KEY) || '');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const checks = state.checks || {};
  const deviceAuthorization = useGithubDeviceAuthorization({ mode, onChange, setBusy, setError, setFeedback });

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
    void api<{ app_id?: string; client_id?: string }>('/github/app-config/defaults')
      .then((value) =>
        setForm((current) => ({
          ...current,
          app_id: current.app_id || value.app_id || '',
          client_id: current.client_id || value.client_id || ''
        }))
      )
      .catch(() => undefined);
  }, [mode, checks.app_configured]);

  const discover = useCallback(
    async (silent = false) => {
      setBusy(true);
      if (!silent) {
        setError('');
        setFeedback('正在检查 GitHub App 安装…');
      }
      try {
        const result = await api<Discovery>(
          '/github/installations/discover',
          json('POST', undefined, '发现 GitHub App 安装')
        );
        if (!result.installed) {
          if (!silent) setFeedback('尚未检测到安装，请先在 GitHub 完成安装。');
          return false;
        }
        setInstallations(result.installations);
        setSelected(
          result.installations.flatMap((item) =>
            item.repositories.filter((repo) => repo.selected).map((repo) => repo.id)
          )
        );
        sessionStorage.removeItem(GITHUB_INSTALL_URL_KEY);
        setInstallationUrl('');
        setFeedback('已发现 GitHub App 安装，请选择代码仓库。');
        await onChange();
        return true;
      } catch (value) {
        if (!silent) setError(message(value));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChange]
  );

  useEffect(() => {
    if (!installationUrl || checks.installation_installed) return;
    const syncOnReturn = () => {
      if (document.visibilityState === 'visible') void discover(true);
    };
    window.addEventListener('focus', syncOnReturn);
    document.addEventListener('visibilitychange', syncOnReturn);
    return () => {
      window.removeEventListener('focus', syncOnReturn);
      document.removeEventListener('visibilitychange', syncOnReturn);
    };
  }, [installationUrl, checks.installation_installed, discover]);

  async function act(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      await onChange();
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(false);
    }
  }
  async function saveManual() {
    await act(() => api('/github/app-config/validate', json('POST', form, '验证 GitHub App 配置')));
  }
  const startManifest = () => startGithubManifest({ setBusy, setError }),
    openInstallation = () =>
      openGithubInstallation({
        mode,
        onChange,
        setBusy,
        setError,
        setInstallations,
        setInstallationUrl,
        setFeedback
      });
  async function saveRepositories(item: Installation) {
    const repositoryIds = item.repositories.filter((repo) => selected.includes(repo.id)).map((repo) => repo.id);
    await act(() =>
      api(
        `/github/installations/${item.installation_id}/repositories`,
        json('PUT', { repository_ids: repositoryIds }, '保存 GitHub 代码仓库选择')
      )
    );
  }

  return {
    form,
    setForm,
    busy,
    installations,
    selected,
    setSelected,
    installationUrl,
    feedback,
    error,
    checks,
    saveManual,
    startManifest,
    discover,
    openInstallation,
    saveRepositories,
    ...deviceAuthorization
  };
}

export function GithubSetup({
  mode,
  state,
  onChange
}: {
  mode: 'hosted' | 'byo';
  state: StepState;
  onChange: () => Promise<unknown>;
}) {
  const {
    form,
    setForm,
    busy,
    installations,
    selected,
    setSelected,
    installationUrl,
    feedback,
    error,
    checks,
    saveManual,
    startManifest,
    discover,
    openInstallation,
    saveRepositories,
    device,
    copied,
    connect,
    poll,
    copyDeviceCode
  } = useGithubSetupController({ mode, state, onChange });
  const installed = Boolean(checks.installation_installed || state.installation_count || installations.length);
  const ownerAuthorizationRequired = (mode === 'hosted' || checks.app_configured) && !checks.account_connected;
  return (
    <section className="setup-section">
      <div className="section-title">
        <Github size={18} />
        <div>
          <h2>GitHub</h2>
          <p>{setupDetailLabel(state.detail) || '等待连接'}</p>
        </div>
        <Status ready={state.ready} status={state.status} />
      </div>
      <GithubAppConfiguration
        visible={mode === 'byo' && !checks.app_configured}
        form={form}
        busy={busy}
        onForm={setForm}
        onManifest={startManifest}
        onSave={saveManual}
      />
      <GithubOwnerAuthorization
        required={ownerAuthorizationRequired}
        configured={Boolean(checks.app_configured)}
        device={device}
        copied={copied}
        busy={busy}
        onConnect={connect}
        onPoll={poll}
        onCopy={copyDeviceCode}
      />
      <GithubInstallationStart
        visible={Boolean(checks.account_connected && !installed)}
        installationUrl={installationUrl}
        busy={busy}
        onDiscover={() => void discover(false)}
        onOpen={() => void openInstallation()}
      />
      {!state.ready &&
        installations.map((item) => (
          <RepositoryPicker
            key={item.id}
            item={item}
            selected={selected}
            busy={busy}
            setSelected={setSelected}
            save={() => saveRepositories(item)}
            sync={() => discover(false)}
          />
        ))}
      {(busy || feedback || error) && (
        <div className={`setup-feedback${error ? ' error' : ''}`}>
          {busy && <LoaderCircle className="spin" size={15} />}
          <span>{error || feedback || '正在验证'}</span>
        </div>
      )}
    </section>
  );
}

function useGithubDeviceAuthorization({
  mode,
  onChange,
  setBusy,
  setError,
  setFeedback
}: {
  mode: 'hosted' | 'byo';
  onChange: () => Promise<unknown>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setFeedback: Dispatch<SetStateAction<string>>;
}) {
  const [device, setDevice] = useState<Device | null>(null);
  const [copied, setCopied] = useState(false);
  async function connect() {
    const popup = window.open('about:blank', 'aiws-github-device');
    if (popup) popup.opener = null;
    setBusy(true);
    setError('');
    try {
      const result = await api<Device>('/github/device/start', json('POST', { mode }, '启动 GitHub 设备登录'));
      setDevice(result);
      setCopied(false);
      if (popup) popup.location.replace(result.verification_uri);
      else window.open(result.verification_uri, '_blank', 'noopener,noreferrer');
    } catch (value) {
      popup?.close();
      setError(message(value));
    } finally {
      setBusy(false);
    }
  }
  async function poll() {
    if (!device) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ connected?: boolean; error?: string }>(
        '/github/device/poll',
        json('POST', { request_id: device.request_id }, '检查 GitHub 授权')
      );
      if (result.connected) {
        setDevice(null);
        setFeedback('GitHub 所有者授权已完成。');
      } else {
        setFeedback(
          result.error === 'authorization_pending'
            ? 'GitHub 尚未确认授权，请完成后再次检查。'
            : result.error || '等待 GitHub 授权。'
        );
      }
      await onChange();
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(false);
    }
  }
  async function copyDeviceCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.user_code);
      setCopied(true);
      setFeedback('设备码已复制。');
    } catch {
      setError('无法复制设备码，请手动选择。');
    }
  }
  return { device, copied, connect, poll, copyDeviceCode };
}

function RepositoryPicker({
  item,
  selected,
  busy,
  setSelected,
  save,
  sync
}: {
  item: Installation;
  selected: string[];
  busy: boolean;
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  save: () => void;
  sync: () => void;
}) {
  const count = item.repositories.filter((repo) => selected.includes(repo.id)).length;
  return (
    <div className="setup-block repository-picker">
      <strong>代码仓库</strong>
      {item.repositories.length ? (
        item.repositories.map((repo) => (
          <label key={repo.id}>
            <input
              type="checkbox"
              checked={selected.includes(repo.id)}
              onChange={(event) =>
                setSelected((values) =>
                  event.target.checked
                    ? [...new Set([...values, repo.id])]
                    : values.filter((value) => value !== repo.id)
                )
              }
            />
            {repo.full_name}
          </label>
        ))
      ) : (
        <p>当前 GitHub App 安装没有可访问的代码仓库，请在 GitHub 调整授权范围后重新同步。</p>
      )}
      <div className="block-actions">
        <button className="button secondary" disabled={busy} onClick={sync}>
          <RefreshCw size={15} />
          重新同步
        </button>
        {item.repositories.length > 0 && (
          <button className="button primary" disabled={!count || busy} onClick={save}>
            <Check size={15} />
            确认选择
          </button>
        )}
      </div>
    </div>
  );
}

function Status({ ready, status }: { ready: boolean; status: string }) {
  return (
    <span className={`status ${ready ? 'ready' : 'pending'}`}>
      {ready && <Check size={12} />}
      {displayStatus(status)}
    </span>
  );
}
function message(value: unknown) {
  return value instanceof Error ? value.message : 'GitHub 操作失败';
}
