import { useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronRight, Github, KeyRound, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';

export type OnboardingAccount = { id: string; display_name: string; revision: number };
export type OnboardingCredential = { id: string; provider: string; status: string; revision: number };
export type OnboardingProfile = {
  id: string;
  provider: string;
  label: string;
  status: string;
  revision: number;
  credential_ref_id?: string | null;
  lifecycle_status?: string;
  config?: Record<string, unknown>;
};

export type SystemOnboardingSnapshot = {
  needsSetup: boolean;
  account: OnboardingAccount | null;
  credentials: OnboardingCredential[];
  profiles: OnboardingProfile[];
  projectCount: number;
};

export const SYSTEM_ONBOARDING_VERSION = '1';

export function systemOnboardingKey(accountId: string) {
  return `aiws:v3:onboarding:${accountId}:v${SYSTEM_ONBOARDING_VERSION}`;
}

export function githubSkipKey(accountId: string) {
  return `aiws:v3:onboarding:${accountId}:github-skip:v${SYSTEM_ONBOARDING_VERSION}`;
}

export function hasSystemOnboardingCompletion(snapshot: SystemOnboardingSnapshot) {
  if (snapshot.projectCount > 0) return true;
  if (!snapshot.account) return false;
  return localStorage.getItem(systemOnboardingKey(snapshot.account.id)) === SYSTEM_ONBOARDING_VERSION;
}

export function deriveSystemOnboardingStep(snapshot: SystemOnboardingSnapshot, githubSkipped = false): 1 | 2 | 3 | 4 {
  if (snapshot.needsSetup) return 1;
  const activeCredentials = new Set(snapshot.credentials.filter((item) => item.status === 'active').map((item) => item.id));
  const codexReady = snapshot.profiles.some((item) => item.provider === 'codex' && item.status === 'available' && item.lifecycle_status !== 'disabled' && Boolean(item.credential_ref_id && activeCredentials.has(item.credential_ref_id)));
  if (!codexReady) return 2;
  const githubReady = snapshot.profiles.some((item) => item.provider === 'github' && item.status === 'available' && item.lifecycle_status !== 'disabled' && Boolean(item.credential_ref_id && activeCredentials.has(item.credential_ref_id)));
  if (!githubReady && !githubSkipped) return 3;
  return 4;
}

type Props = {
  snapshot: SystemOnboardingSnapshot;
  refresh: () => Promise<void>;
  onComplete: () => Promise<void>;
};

export function SystemOnboarding({ snapshot, refresh, onComplete }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [codexSecret, setCodexSecret] = useState('');
  const [codexLabel, setCodexLabel] = useState('Codex');
  const [codexModel, setCodexModel] = useState('gpt-5.2');
  const [githubAppId, setGithubAppId] = useState('');
  const [githubInstallationId, setGithubInstallationId] = useState('');
  const [githubPrivateKey, setGithubPrivateKey] = useState('');
  const [githubRepositories, setGithubRepositories] = useState(0);
  const [markerRevision, setMarkerRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');

  const githubSkipped = Boolean(snapshot.account && localStorage.getItem(githubSkipKey(snapshot.account.id)) === SYSTEM_ONBOARDING_VERSION);
  const step = deriveSystemOnboardingStep(snapshot, githubSkipped || markerRevision > 0);
  const codexCredential = useMemo(() => snapshot.credentials.find((item) => item.provider === 'codex' && item.status === 'active') || snapshot.credentials.find((item) => item.provider === 'codex' && ['rebind_required', 'failed'].includes(item.status)), [snapshot.credentials]);
  const githubCredential = useMemo(() => snapshot.credentials.find((item) => item.provider === 'github' && item.status === 'active') || snapshot.credentials.find((item) => item.provider === 'github' && ['rebind_required', 'failed'].includes(item.status)), [snapshot.credentials]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setFailure('');
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : error instanceof Error ? error.message : '请求失败');
    } finally {
      setBusy('');
    }
  };

  const createOwner = (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim() || !teamName.trim()) return;
    void run('owner', async () => {
      await mutateV2('/api/v2/setup', { display_name: displayName.trim(), team_name: teamName.trim(), expected_revision: 0 }, 'POST', 0);
      setDisplayName('');
      setTeamName('');
      await refresh();
    });
  };

  const configureCodex = (event: FormEvent) => {
    event.preventDefault();
    void run('codex', async () => {
      let credential = codexCredential;
      if (!credential) {
        const created = await mutateV2<{ credential: OnboardingCredential }>('/api/v2/credentials', { provider: 'codex', external_ref: 'onboarding:codex', scope: {} }, 'POST', 0);
        credential = created.data.credential;
      }
      if (credential.status !== 'active') {
        if (!codexSecret) throw new Error('请输入 Codex credential');
        await mutateV2(`/api/v2/credentials/${encodeURIComponent(credential.id)}/rebind`, { proof: codexSecret }, 'POST', credential.revision);
      }
      let profile = snapshot.profiles.find((item) => item.provider === 'codex' && item.credential_ref_id === credential?.id && ['unprobed', 'unavailable', 'available'].includes(item.status));
      if (!profile) {
        const created = await mutateV2<{ profile: OnboardingProfile }>('/api/v2/profiles', { provider: 'codex', label: codexLabel.trim() || 'Codex', credential_ref_id: credential.id, config: { model: codexModel.trim() || 'gpt-5.2' } }, 'POST', 0);
        profile = created.data.profile;
      }
      if (profile.status !== 'available') await mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/probe`, {}, 'POST', profile.revision);
      await refresh();
    }).finally(() => setCodexSecret(''));
  };

  const configureGithub = (event: FormEvent) => {
    event.preventDefault();
    void run('github', async () => {
      let credential = githubCredential;
      if (!credential) {
        const created = await mutateV2<{ credential: OnboardingCredential }>('/api/v2/credentials', { provider: 'github', external_ref: 'onboarding:github-app', scope: {} }, 'POST', 0);
        credential = created.data.credential;
      }
      if (credential.status !== 'active') {
        if (!githubAppId.trim() || !githubInstallationId.trim() || !githubPrivateKey) throw new Error('请填写 GitHub App、Installation 与 private key');
        const proof = JSON.stringify({ app_id: githubAppId.trim(), installation_id: githubInstallationId.trim(), private_key: githubPrivateKey });
        await mutateV2(`/api/v2/credentials/${encodeURIComponent(credential.id)}/rebind`, { proof }, 'POST', credential.revision);
      }
      let profile = snapshot.profiles.find((item) => item.provider === 'github' && item.credential_ref_id === credential?.id && ['unprobed', 'unavailable', 'available'].includes(item.status));
      if (!profile) {
        const created = await mutateV2<{ profile: OnboardingProfile }>('/api/v2/profiles', { provider: 'github', label: 'GitHub App', credential_ref_id: credential.id, config: { app_id: githubAppId.trim(), installation_id: githubInstallationId.trim() } }, 'POST', 0);
        profile = created.data.profile;
      }
      if (profile.status !== 'available') await mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/probe`, {}, 'POST', profile.revision);
      const discovered = await apiV2<{ repositories: unknown[] }>(`/api/v2/provider-profiles/${encodeURIComponent(profile.id)}/repositories`);
      setGithubRepositories(discovered.data.repositories?.length || 0);
      await refresh();
    }).finally(() => setGithubPrivateKey(''));
  };

  const skipGithub = () => {
    if (!snapshot.account) return;
    localStorage.setItem(githubSkipKey(snapshot.account.id), SYSTEM_ONBOARDING_VERSION);
    setMarkerRevision((value) => value + 1);
    setFailure('');
  };

  const finish = () => {
    if (!snapshot.account) return;
    localStorage.setItem(systemOnboardingKey(snapshot.account.id), SYSTEM_ONBOARDING_VERSION);
    void run('finish', onComplete);
  };

  return <main className="system-onboarding" data-testid="system-onboarding" data-step={step}>
    <header className="onboarding-brand"><span className="brand-mark">A3</span><div><strong>AIWS 工作区</strong><small>本地系统配置</small></div></header>
    <ol className="system-stepper" aria-label="系统配置进度">
      {['Owner 与 Team', 'Codex', 'GitHub', '检查'].map((label, index) => <li key={label} className={step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''} aria-current={step === index + 1 ? 'step' : undefined}><span>{step > index + 1 ? <Check size={14} /> : index + 1}</span><strong>{label}</strong></li>)}
    </ol>
    <section className="system-onboarding-stage">
      {step === 1 && <form className="onboarding-form" onSubmit={createOwner}><div className="onboarding-stage-title"><UserRound size={22} /><div><p>步骤 1 / 4</p><h1>创建本地 Owner</h1></div></div><label><span>显示名称</span><input aria-label="显示名称" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label><label><span>Team 名称</span><input aria-label="Team 名称" value={teamName} onChange={(event) => setTeamName(event.target.value)} required /></label><button className="button primary" disabled={busy === 'owner' || !displayName.trim() || !teamName.trim()}>{busy === 'owner' ? <LoaderCircle className="spin" size={16} /> : <ChevronRight size={16} />}创建并继续</button></form>}
      {step === 2 && <form className="onboarding-form" onSubmit={configureCodex}><div className="onboarding-stage-title"><KeyRound size={22} /><div><p>步骤 2 / 4 · 必需</p><h1>连接 Codex</h1></div></div>{codexCredential?.status === 'active' ? <div className="onboarding-resource"><Check size={16} /><span><strong>已绑定 credential</strong><small>{codexCredential.id}</small></span></div> : <label><span>Codex credential</span><input aria-label="Codex credential" type="password" autoComplete="off" value={codexSecret} onChange={(event) => setCodexSecret(event.target.value)} required /></label>}<div className="two-column"><label><span>Profile 名称</span><input aria-label="Codex Profile 名称" value={codexLabel} onChange={(event) => setCodexLabel(event.target.value)} required /></label><label><span>Model</span><input aria-label="Codex Model" value={codexModel} onChange={(event) => setCodexModel(event.target.value)} required /></label></div><button className="button primary" disabled={busy === 'codex' || (!codexCredential?.status.includes('active') && !codexSecret)}>{busy === 'codex' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}验证并继续</button></form>}
      {step === 3 && <form className="onboarding-form" onSubmit={configureGithub}><div className="onboarding-stage-title"><Github size={22} /><div><p>步骤 3 / 4 · 可稍后配置</p><h1>连接 GitHub App</h1></div></div><div className="two-column"><label><span>App ID</span><input aria-label="GitHub App ID" value={githubAppId} onChange={(event) => setGithubAppId(event.target.value)} required={!githubCredential || githubCredential.status !== 'active'} /></label><label><span>Installation ID</span><input aria-label="GitHub Installation ID" value={githubInstallationId} onChange={(event) => setGithubInstallationId(event.target.value)} required={!githubCredential || githubCredential.status !== 'active'} /></label></div>{githubCredential?.status !== 'active' && <label><span>Private key</span><textarea aria-label="GitHub private key" rows={5} autoComplete="off" value={githubPrivateKey} onChange={(event) => setGithubPrivateKey(event.target.value)} required /></label>}<div className="onboarding-actions"><button type="button" className="button" onClick={skipGithub}>稍后配置</button><button className="button primary" disabled={busy === 'github'}>{busy === 'github' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}验证仓库访问</button></div></form>}
      {step === 4 && <div className="onboarding-form onboarding-summary"><div className="onboarding-stage-title"><ShieldCheck size={22} /><div><p>步骤 4 / 4</p><h1>配置检查</h1></div></div><dl><div><dt>Owner</dt><dd>{snapshot.account?.display_name || '已创建'}</dd></div><div><dt>Codex</dt><dd><Check size={14} />已验证</dd></div><div><dt>GitHub</dt><dd>{githubSkipped ? '稍后配置' : <><Check size={14} />已验证{githubRepositories ? ` · ${githubRepositories} 个仓库` : ''}</>}</dd></div></dl><button className="button primary" disabled={busy === 'finish'} onClick={finish}>{busy === 'finish' ? <LoaderCircle className="spin" size={16} /> : <ChevronRight size={16} />}进入项目创建</button></div>}
      {failure && <div className="state-banner error onboarding-failure" role="alert">{failure}</div>}
    </section>
  </main>;
}
