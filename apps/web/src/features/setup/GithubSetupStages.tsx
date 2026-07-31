import { Check, Copy, ExternalLink, Github, KeyRound, RefreshCw } from 'lucide-react';
import { IconButton } from '../../components/common/IconButton';

export type GithubAppForm = {
  app_id: string;
  client_id: string;
  client_secret: string;
  private_key: string;
  webhook_secret: string;
};
export type GithubDevice = { request_id: string; user_code: string; verification_uri: string };

export function GithubAppConfiguration({
  visible,
  form,
  busy,
  onForm,
  onManifest,
  onSave
}: {
  visible: boolean;
  form: GithubAppForm;
  busy: boolean;
  onForm: (value: GithubAppForm) => void;
  onManifest: () => void;
  onSave: () => void;
}) {
  if (!visible) return null;
  const complete = form.app_id && form.client_id && form.client_secret && form.private_key && form.webhook_secret;
  return (
    <div className="setup-block">
      <div className="block-head">
        <strong>GitHub App</strong>
        <button className="text-button" onClick={onManifest}>
          通过应用清单创建 <ExternalLink size={13} />
        </button>
      </div>
      <GithubAppFields form={form} onForm={onForm} />
      <div className="block-actions">
        <button className="button primary" disabled={busy || !complete} onClick={onSave}>
          <KeyRound size={15} />
          验证并保存
        </button>
      </div>
    </div>
  );
}

function GithubAppFields({ form, onForm }: { form: GithubAppForm; onForm: (value: GithubAppForm) => void }) {
  return (
    <div className="form-grid">
      <label>
        应用 ID
        <input value={form.app_id} onChange={(event) => onForm({ ...form, app_id: event.target.value })} />
      </label>
      <label>
        客户端 ID
        <input value={form.client_id} onChange={(event) => onForm({ ...form, client_id: event.target.value })} />
      </label>
      <label>
        客户端密钥
        <input
          type="password"
          value={form.client_secret}
          onChange={(event) => onForm({ ...form, client_secret: event.target.value })}
        />
      </label>
      <label>
        Webhook 密钥
        <input
          type="password"
          value={form.webhook_secret}
          onChange={(event) => onForm({ ...form, webhook_secret: event.target.value })}
        />
      </label>
      <label className="span-2">
        私钥
        <textarea
          rows={4}
          value={form.private_key}
          onChange={(event) => onForm({ ...form, private_key: event.target.value })}
        />
      </label>
    </div>
  );
}

export function GithubOwnerAuthorization({
  required,
  configured,
  device,
  copied,
  busy,
  onConnect,
  onPoll,
  onCopy
}: {
  required: boolean;
  configured: boolean;
  device: GithubDevice | null;
  copied: boolean;
  busy: boolean;
  onConnect: () => void;
  onPoll: () => void;
  onCopy: () => void;
}) {
  if (!required) return null;
  if (!device)
    return (
      <div className="setup-row">
        <div>
          <strong>所有者授权</strong>
          <span>{configured ? 'GitHub OAuth 设备授权流程' : '平台托管的 GitHub App 尚未配置'}</span>
        </div>
        <button className="button primary" disabled={busy || !configured} onClick={onConnect}>
          <ExternalLink size={15} />
          连接 GitHub
        </button>
      </div>
    );
  return (
    <div className="github-device-auth" role="status" aria-live="polite">
      <div className="github-device-code">
        <span>GitHub 设备码</span>
        <div>
          <code aria-label="GitHub 设备码">{device.user_code}</code>
          <IconButton label={copied ? '设备码已复制' : '复制设备码'} active={copied} onClick={onCopy}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </IconButton>
        </div>
        <small>等待 GitHub 授权</small>
      </div>
      <div className="github-device-actions">
        <a className="button secondary" href={device.verification_uri} target="_blank" rel="noreferrer">
          <ExternalLink size={15} />
          打开 GitHub
        </a>
        <button className="button primary" disabled={busy} onClick={onPoll}>
          <RefreshCw size={15} />
          检查授权
        </button>
      </div>
    </div>
  );
}

export function GithubInstallationStart({
  visible,
  installationUrl,
  busy,
  onDiscover,
  onOpen
}: {
  visible: boolean;
  installationUrl: string;
  busy: boolean;
  onDiscover: () => void;
  onOpen: () => void;
}) {
  if (!visible) return null;
  if (!installationUrl)
    return (
      <div className="setup-row">
        <div>
          <strong>GitHub App 安装</strong>
          <span>已经安装过可直接同步；否则在新标签页安装</span>
        </div>
        <div className="setup-actions">
          <button className="button secondary" disabled={busy} onClick={onDiscover}>
            <RefreshCw size={15} />
            已安装，立即同步
          </button>
          <button className="button primary" disabled={busy} onClick={onOpen}>
            <Github size={15} />
            打开安装页
          </button>
        </div>
      </div>
    );
  return (
    <div className="setup-block installation-waiting">
      <div>
        <strong>等待 GitHub 安装</strong>
        <span>完成后返回此页面，系统会自动检查；也可以立即手动同步。</span>
      </div>
      <div className="block-actions">
        <a className="button secondary" href={installationUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={15} />
          重新打开
        </a>
        <button className="button primary" disabled={busy} onClick={onDiscover}>
          <RefreshCw size={15} />
          我已安装，立即同步
        </button>
      </div>
    </div>
  );
}
