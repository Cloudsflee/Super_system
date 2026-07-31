import { api, json } from '../../api/client';

export type GithubRepository = { id: string; full_name: string; selected: boolean };
export type GithubInstallation = {
  id: string;
  installation_id: string;
  repositories: GithubRepository[];
};
export const GITHUB_INSTALL_URL_KEY = 'aiws-github-installation-url';

export async function startGithubManifest({
  setBusy,
  setError
}: {
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
}) {
  setBusy(true);
  setError('');
  try {
    const result = await api<{ state: string; manifest: Record<string, unknown> }>(
      '/github/manifest/start',
      json('POST', undefined, '创建 GitHub App 应用清单')
    );
    localStorage.setItem('aiws-github-manifest-state', result.state);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://github.com/settings/apps/new';
    for (const [name, value] of Object.entries({ state: result.state, manifest: JSON.stringify(result.manifest) })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  } catch (value) {
    setError(errorMessage(value));
    setBusy(false);
  }
}

export async function openGithubInstallation({
  mode,
  onChange,
  setBusy,
  setError,
  setInstallations,
  setInstallationUrl,
  setFeedback
}: {
  mode: 'hosted' | 'byo';
  onChange: () => Promise<unknown>;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setInstallations: (value: GithubInstallation[]) => void;
  setInstallationUrl: (value: string) => void;
  setFeedback: (value: string) => void;
}) {
  const popup = window.open('about:blank', 'aiws-github-install');
  if (popup) popup.opener = null;
  setBusy(true);
  setError('');
  try {
    const result = await api<{ installation_url?: string; installation?: GithubInstallation }>(
      '/github/installations/start',
      json('POST', { mode }, '启动 GitHub App 安装')
    );
    if (result.installation) {
      popup?.close();
      setInstallations([result.installation]);
      await onChange();
      return;
    }
    if (!result.installation_url) throw new Error('未返回 GitHub App 安装地址');
    sessionStorage.setItem(GITHUB_INSTALL_URL_KEY, result.installation_url);
    setInstallationUrl(result.installation_url);
    setFeedback('已在新标签页打开 GitHub；安装完成后返回本页同步。');
    if (popup) popup.location.replace(result.installation_url);
    else window.open(result.installation_url, '_blank', 'noopener,noreferrer');
  } catch (value) {
    popup?.close();
    setError(errorMessage(value));
  } finally {
    setBusy(false);
  }
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
