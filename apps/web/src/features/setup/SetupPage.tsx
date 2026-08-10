import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, Check, CircleAlert, Clipboard, ExternalLink, Github, KeyRound, Link2,
  LoaderCircle, LogOut, Plus, RefreshCw, RotateCw, Search, ShieldCheck, Trash2, UserRound, X
} from 'lucide-react';
import { api, ApiError, formatTime, mutate, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../pages';
import type {
  Account, Capabilities, CodexProfile, Credential, DiscoverySource, GithubApp,
  GithubInstallation, Operation, OperationEvent, Session, SetupCheck, SetupState
} from './types';

type SetupTab = 'overview' | 'identity' | 'codex' | 'github';
type CredentialKind = Credential['kind'];

const CHECK_LABELS: Record<SetupCheck, string> = {
  owner: 'Local owner',
  active_codex_credential: 'Codex credential',
  active_codex_profile: 'Active Codex profile',
  current_codex_probe: 'Current Codex probe',
  verified_github_app: 'Verified GitHub App',
  active_github_installation: 'Active installation',
  repository_permissions: 'Repository permissions',
  current_github_probe: 'Current GitHub probe'
};

const TERMINAL_OPERATIONS = new Set(['completed', 'failed', 'cancelled']);

function Status({ value }: { value: string }) {
  const tone = ['ready', 'available', 'active', 'completed', 'verified', 'accepted'].includes(value)
    ? 'positive' : ['running', 'pending', 'starting', 'waiting_for_user'].includes(value)
      ? 'working' : ['failed', 'invalid', 'revoked', 'expired', 'unavailable'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}

function SectionTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

function FailureBand({ message, retry }: { message: string; retry: () => void }) {
  return <section className="setup-state-band failed" role="alert"><CircleAlert size={18} /><div><strong>Action failed</strong><span>{message}</span></div><button className="button" onClick={retry}><RefreshCw size={15} />Retry</button></section>;
}

export function SetupPage({ navigate, notify, refreshSetup }: WorkspacePageProps) {
  const [tab, setTab] = useState<SetupTab>('overview');
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [readiness, setReadiness] = useState('checking');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [operationEvents, setOperationEvents] = useState<OperationEvent[]>([]);
  const retryRef = useRef<(() => Promise<void>) | null>(null);

  const load = useCallback(async () => {
    setLoadState((current) => current === 'ready' ? current : 'loading');
    try {
      const [state, sessionRows, discovery, caps, ready] = await Promise.all([
        api<SetupState>('/api/v1/setup'),
        api<Session[]>('/api/v1/sessions'),
        api<DiscoverySource[]>('/api/v1/integrations/codex/discovery'),
        api<Capabilities>('/api/v1/system/capabilities').catch(() => null),
        api<{ status: string }>('/readyz').catch((error) => error instanceof ApiError ? { status: 'not_ready' } : Promise.reject(error))
      ]);
      setSetup(state);
      setSessions(sessionRows);
      setSources(discovery);
      setCapabilities(caps);
      setReadiness(ready.status);
      setLoadState('ready');
    } catch {
      setLoadState('offline');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(async (key: string, action: () => Promise<void>, remember = true) => {
    setBusy(key);
    setFailure('');
    if (remember) retryRef.current = action;
    try { await action(); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Request failed'); }
    finally { setBusy(''); }
  }, []);

  const pollOperation = useCallback(async (receipt: Operation) => {
    const operationId = receipt.operation_id || receipt.id;
    if (!operationId) return;
    setOperation(receipt);
    setOperationEvents([]);
    let cursor = 0;
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const [current, events] = await Promise.all([
        api<Operation>(`/api/v1/operations/${operationId}`),
        api<OperationEvent[]>(`/api/v1/operations/${operationId}/events?after=${cursor}`)
      ]);
      setOperation(current);
      if (events.length) {
        cursor = Math.max(cursor, ...events.map((event) => event.cursor));
        setOperationEvents((value) => [...value, ...events].slice(-100));
      }
      if (TERMINAL_OPERATIONS.has(current.status)) {
        await Promise.all([load(), refreshSetup()]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, [load, refreshSetup]);

  const beginOperation = useCallback(async (key: string, path: string, body: Record<string, unknown>) => {
    const action = async () => {
      const receipt = await mutate<Operation>(path, body);
      void pollOperation(receipt).catch((error) => setFailure(error instanceof Error ? error.message : 'Operation failed'));
    };
    await runAction(key, action);
  }, [pollOperation, runAction]);

  const cancelOperation = async () => {
    const operationId = operation?.id || operation?.operation_id;
    if (!operationId || !operation) return;
    await runAction('operation-cancel', async () => {
      const cancelled = await mutate<Operation>(`/api/v1/operations/${operationId}/cancel`, { expected_revision: operation.revision });
      setOperation(cancelled);
      await load();
    }, false);
  };

  if (loadState === 'loading' && !setup) return <div className="page-loader"><LoaderCircle className="spin" />Loading setup</div>;
  if (loadState === 'offline' && !setup) return <div className="page setup-offline"><section className="setup-state-band offline"><CircleAlert size={20} /><div><strong>Workspace offline</strong><span>API connection is unavailable.</span></div><button className="button primary" onClick={() => void load()}><RefreshCw size={16} />Retry</button></section></div>;

  const verification = [...operationEvents].reverse().find((event) => event.data.verification_url || event.data.user_code);
  return <div className="page page-setup">
    <div className="page-heading">
      <div><p className="eyebrow">Instance setup</p><h1>Workspace configuration</h1></div>
      <button className="icon-button" title="Refresh setup" aria-label="Refresh setup" disabled={busy === 'refresh'} onClick={() => void runAction('refresh', load)}><RefreshCw className={busy === 'refresh' ? 'spin' : ''} size={18} /></button>
    </div>

    <section className="health-band setup-health">
      <div><span>Infrastructure</span><Status value={readiness} /></div>
      <div><span>Setup</span><Status value={setup?.status || 'checking'} /></div>
      <div><span>Runner broker</span><Status value={capabilities?.broker.status || 'checking'} /></div>
      <div><span>Runner</span><strong className="mono">{shortHash(capabilities?.broker.runner_digest)}</strong></div>
    </section>

    <div className="setup-tabs" role="tablist" aria-label="Setup views">
      {(['overview', 'identity', 'codex', 'github'] as SetupTab[]).map((value) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
    </div>

    {failure && <FailureBand message={failure} retry={() => void retryRef.current?.()} />}
    {operation && <section className={`setup-operation ${operation.status}`} aria-live="polite">
      <Activity className={['pending', 'running'].includes(operation.status) ? 'spin' : ''} size={18} />
      <div><strong>{operation.kind?.replaceAll('.', ' ') || 'Provider operation'}</strong><span>{operation.error_code || operation.status.replaceAll('_', ' ')}</span></div>
      <Status value={operation.status} />
      {['pending', 'running'].includes(operation.status) && <button className="button" disabled={busy === 'operation-cancel'} onClick={() => void cancelOperation()}><X size={15} />Cancel</button>}
      {['failed', 'cancelled'].includes(operation.status) && retryRef.current && <button className="button" onClick={() => void retryRef.current?.()}><RefreshCw size={15} />Retry</button>}
    </section>}
    {verification && <section className="setup-human-input"><Link2 size={19} /><div><strong>Device verification</strong>{verification.data.verification_url && <a href={verification.data.verification_url} target="_blank" rel="noreferrer">{verification.data.verification_url}<ExternalLink size={13} /></a>}</div>{verification.data.user_code && <code>{verification.data.user_code}</code>}</section>}

    {tab === 'overview' && <OverviewTab setup={setup} capabilities={capabilities} busy={busy} runAction={runAction} refresh={async () => { await load(); await refreshSetup(); }} navigate={navigate} />}
    {tab === 'identity' && <IdentityTab setup={setup} sessions={sessions} busy={busy} runAction={runAction} refresh={load} notify={notify} />}
    {tab === 'codex' && <CodexTab setup={setup} sources={sources} busy={busy} runAction={runAction} beginOperation={beginOperation} refresh={load} />}
    {tab === 'github' && <GithubTab setup={setup} busy={busy} runAction={runAction} beginOperation={beginOperation} refresh={load} />}
  </div>;
}

function OverviewTab({ setup, capabilities, busy, runAction, refresh, navigate }: {
  setup: SetupState | null; capabilities: Capabilities | null; busy: string;
  runAction: (key: string, action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>; navigate: WorkspacePageProps['navigate'];
}) {
  const complete = async () => runAction('complete', async () => {
    if (!setup) return;
    await mutate('/api/v1/setup/complete', { expected_revision: setup.revision });
    await refresh();
  });
  return <div className="setup-overview-grid">
    <section className="panel setup-checks">
      <SectionTitle title="Readiness checks" meta={`${Object.values(setup?.checks || {}).filter(Boolean).length}/8 passed`} />
      <div className="check-list">{Object.entries(setup?.checks || {}).map(([key, passed]) => <div key={key}><span className={passed ? 'check-icon passed' : 'check-icon'}>{passed ? <Check size={14} /> : <CircleAlert size={14} />}</span><strong>{CHECK_LABELS[key as SetupCheck]}</strong><Status value={passed ? 'ready' : 'blocked'} /></div>)}</div>
    </section>
    <section className="panel setup-completion">
      <SectionTitle title="Setup state" meta={setup?.completed_at ? `Completed ${formatTime(setup.completed_at)}` : 'Not completed'} />
      <dl className="definition-list">
        <div><dt>Version</dt><dd>{capabilities?.version || '3.0.0'}</dd></div>
        <div><dt>Owner</dt><dd>{setup?.owner.display_name || 'Local owner'}</dd></div>
        <div><dt>Revision</dt><dd>r{setup?.revision || 0}</dd></div>
        <div><dt>Blockers</dt><dd>{setup?.blockers.length || 0}</dd></div>
      </dl>
      <div className="setup-complete-actions">
        <button className="button primary" disabled={!setup?.can_complete || busy === 'complete'} onClick={() => void complete()}>{busy === 'complete' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{setup?.complete ? 'Reconfirm setup' : 'Complete setup'}</button>
        <button className="button" disabled={!setup?.complete} onClick={() => navigate('projects')}>Open projects</button>
      </div>
    </section>
  </div>;
}

function IdentityTab({ setup, sessions, busy, runAction, refresh, notify }: {
  setup: SetupState | null; sessions: Session[]; busy: string;
  runAction: (key: string, action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>; notify: WorkspacePageProps['notify'];
}) {
  const owner = setup?.owner;
  const [displayName, setDisplayName] = useState(owner?.display_name || '');
  const [locale, setLocale] = useState(owner?.locale || 'zh-CN');
  const [timezone, setTimezone] = useState(owner?.timezone || 'Asia/Shanghai');
  const [ttl, setTtl] = useState(30);
  const [issuedToken, setIssuedToken] = useState('');
  useEffect(() => { if (owner) { setDisplayName(owner.display_name); setLocale(owner.locale); setTimezone(owner.timezone); } }, [owner]);
  const saveOwner = async (event: FormEvent) => {
    event.preventDefault();
    await runAction('owner', async () => {
      await mutate<Account>('/api/v1/account', { expected_revision: owner?.revision, display_name: displayName, locale, timezone }, 'PATCH');
      await refresh();
    });
  };
  const createSession = async () => runAction('session-create', async () => {
    const session = await mutate<Session>('/api/v1/sessions', { ttl_seconds: ttl * 24 * 60 * 60 });
    setIssuedToken(session.token || '');
    await refresh();
  });
  const revokeSession = async (session: Session) => runAction(session.id, async () => {
    await mutate(`/api/v1/sessions/${session.id}/revoke`, { expected_revision: session.revision });
    await refresh();
  });
  const copyToken = async () => {
    await navigator.clipboard?.writeText(issuedToken);
    notify('Session token copied');
  };
  return <div className="setup-identity-grid">
    <section className="panel">
      <SectionTitle title="Local owner" meta={`Revision ${owner?.revision || 0}`} />
      <form className="setup-form" onSubmit={(event) => void saveOwner(event)}>
        <label><span>Display name</span><input value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)} required /></label>
        <label><span>Locale</span><input value={locale} onChange={(event) => setLocale(event.target.value)} required /></label>
        <label><span>Timezone</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></label>
        <button className="button primary" disabled={busy === 'owner'}>{busy === 'owner' ? <LoaderCircle className="spin" size={16} /> : <UserRound size={16} />}Save owner</button>
      </form>
    </section>
    <section className="panel">
      <SectionTitle title="Sessions" meta={`${sessions.length} issued`} action={<div className="session-create"><label><span>Days</span><input type="number" min={1} max={90} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></label><button className="button primary" disabled={busy === 'session-create'} onClick={() => void createSession()}><Plus size={15} />Create</button></div>} />
      {issuedToken && <div className="issued-token"><strong>Session token</strong><code>{issuedToken}</code><button className="icon-button" aria-label="Copy session token" title="Copy session token" onClick={() => void copyToken()}><Clipboard size={15} /></button><button className="icon-button" aria-label="Dismiss session token" title="Dismiss session token" onClick={() => setIssuedToken('')}><X size={15} /></button></div>}
      <div className="config-list session-list">{sessions.map((session) => <div key={session.id}><div><strong className="mono">{session.id}</strong><small>Expires {formatTime(session.expires_at)} · r{session.revision}</small></div><Status value={session.revoked_at ? 'revoked' : 'active'} /><button className="icon-button" title="Revoke session" aria-label={`Revoke ${session.id}`} disabled={Boolean(session.revoked_at) || busy === session.id} onClick={() => void revokeSession(session)}><LogOut size={15} /></button></div>)}{!sessions.length && <div className="list-empty">No bearer sessions</div>}</div>
    </section>
  </div>;
}

function CredentialManager({ provider, setup, busy, runAction, refresh }: {
  provider: 'codex' | 'github'; setup: SetupState | null; busy: string;
  runAction: (key: string, action: () => Promise<void>) => Promise<void>; refresh: () => Promise<void>;
}) {
  const kinds: CredentialKind[] = provider === 'codex' ? ['codex_api_key'] : ['github_app_private_key', 'github_webhook_secret'];
  const [kind, setKind] = useState<CredentialKind>(kinds[0]);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [rotating, setRotating] = useState('');
  const [rotationSecret, setRotationSecret] = useState('');
  const credentials = setup?.credentials.filter((item) => item.provider === provider) || [];
  const create = async (event: FormEvent) => {
    event.preventDefault();
    await runAction(`credential-${provider}`, async () => {
      await mutate('/api/v1/credentials', { kind, label, secret });
      setLabel(''); setSecret(''); await refresh();
    });
  };
  const rotate = async (credential: Credential) => runAction(`rotate-${credential.id}`, async () => {
    await mutate(`/api/v1/credentials/${credential.id}/rotate`, { expected_revision: credential.revision, secret: rotationSecret });
    setRotating(''); setRotationSecret(''); await refresh();
  });
  const revoke = async (credential: Credential) => runAction(`revoke-${credential.id}`, async () => {
    await mutate(`/api/v1/credentials/${credential.id}/revoke`, { expected_revision: credential.revision });
    await refresh();
  });
  const remove = async (credential: Credential) => runAction(`delete-${credential.id}`, async () => {
    await mutate(`/api/v1/credentials/${credential.id}`, { expected_revision: credential.revision }, 'DELETE');
    await refresh();
  });
  return <section className="panel setup-credentials">
    <SectionTitle title={`${provider === 'codex' ? 'Codex' : 'GitHub'} credentials`} meta={`${credentials.length} metadata records`} />
    <form className="setup-credential-form" onSubmit={(event) => void create(event)}>
      <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as CredentialKind)}>{kinds.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      <label><span>Label</span><input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} required /></label>
      <label className="credential-secret"><span>Secret</span>{kind === 'github_app_private_key' ? <textarea rows={3} value={secret} onChange={(event) => setSecret(event.target.value)} required /> : <input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} required />}</label>
      <button className="button primary" disabled={busy === `credential-${provider}`}><KeyRound size={15} />Store</button>
    </form>
    <div className="config-list credential-list">{credentials.map((credential) => <div className="credential-row" key={credential.id}><div><strong>{credential.label}</strong><small>{credential.kind.replaceAll('_', ' ')} · {credential.origin} · r{credential.revision}</small></div><Status value={credential.status} /><div className="row-tools">{credential.origin === 'vault' && credential.status === 'active' && <button className="icon-button" title="Rotate credential" aria-label={`Rotate ${credential.label}`} onClick={() => { setRotating(credential.id); setRotationSecret(''); }}><RotateCw size={14} /></button>}{credential.origin !== 'secret_bundle' && credential.status === 'active' && <button className="icon-button" title="Revoke credential" aria-label={`Revoke ${credential.label}`} onClick={() => void revoke(credential)}><Trash2 size={14} /></button>}{credential.origin !== 'secret_bundle' && credential.status !== 'active' && <button className="icon-button" title="Delete credential" aria-label={`Delete ${credential.label}`} onClick={() => void remove(credential)}><X size={14} /></button>}</div>{rotating === credential.id && <form className="credential-rotation" onSubmit={(event) => { event.preventDefault(); void rotate(credential); }}><input type="password" autoComplete="new-password" value={rotationSecret} onChange={(event) => setRotationSecret(event.target.value)} required aria-label={`New secret for ${credential.label}`} /><button className="button primary" disabled={busy === `rotate-${credential.id}`}><RotateCw size={14} />Rotate</button><button type="button" className="icon-button" title="Cancel rotation" aria-label="Cancel rotation" onClick={() => setRotating('')}><X size={14} /></button></form>}</div>)}{!credentials.length && <div className="list-empty">No credential metadata</div>}</div>
  </section>;
}

function CodexTab({ setup, sources, busy, runAction, beginOperation, refresh }: {
  setup: SetupState | null; sources: DiscoverySource[]; busy: string;
  runAction: (key: string, action: () => Promise<void>) => Promise<void>;
  beginOperation: (key: string, path: string, body: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-5.5');
  const [baseUrl, setBaseUrl] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const credentials = setup?.credentials.filter((item) => item.provider === 'codex' && item.status === 'active') || [];
  useEffect(() => { if (!credentials.some((item) => item.id === credentialRef)) setCredentialRef(credentials[0]?.id || ''); }, [credentialRef, credentials]);
  const createProfile = async (event: FormEvent) => {
    event.preventDefault();
    await runAction('profile-create', async () => {
      await mutate('/api/v1/profiles/codex', { label, provider, model, base_url: baseUrl, wire_api: 'responses', reasoning: 'medium', timeout_ms: 120000, credential_ref: credentialRef });
      setLabel(''); await refresh();
    });
  };
  const activate = async (profile: CodexProfile) => runAction(`activate-${profile.id}`, async () => {
    await mutate(`/api/v1/profiles/codex/${profile.id}/activate`, { expected_revision: profile.revision });
    await refresh();
  });
  const importRecord = async (source: DiscoverySource, recordId: string) => runAction(`import-${recordId}`, async () => {
    await mutate('/api/v1/integrations/codex/discovery/import', { confirmed: true, source_id: source.id, source_revision: source.source_revision, record_id: recordId, activate: true });
    setConfirmed(''); await refresh();
  });
  return <div className="setup-provider-stack">
    <CredentialManager provider="codex" setup={setup} busy={busy} runAction={runAction} refresh={refresh} />
    <section className="panel codex-access">
      <SectionTitle title="Codex access" meta="Device sign-in and read-only discovery" action={<div className="provider-actions"><button className="button" disabled={busy === 'device-auth'} onClick={() => void beginOperation('device-auth', '/api/v1/integrations/codex/device-auth', { label: 'Codex device login' })}><Link2 size={15} />Device sign-in</button><button className="button" disabled={busy === 'discovery'} onClick={() => void beginOperation('discovery', '/api/v1/integrations/codex/discovery', {})}><Search size={15} />Discover</button></div>} />
      <div className="discovery-list">{sources.map((source) => <div className="discovery-source" key={source.id}><div className="discovery-source-head"><div><strong>{source.display_name}</strong><small>{source.source_type.replaceAll('_', ' ')} · r{source.source_revision.slice(0, 8)}</small></div><Status value={source.status} /></div>{source.records.map((record) => <div className="discovery-record" key={record.id}><div><strong>{record.label}</strong><small>{record.provider} · {record.model || 'model unset'} · {record.auth_kind.replaceAll('_', ' ')}</small></div><label className="confirm-import"><input type="checkbox" checked={confirmed === record.id} onChange={(event) => setConfirmed(event.target.checked ? record.id : '')} /><span>Confirm</span></label><button className="button" disabled={!record.credential_available || confirmed !== record.id || busy === `import-${record.id}`} onClick={() => void importRecord(source, record.id)}>Import</button></div>)}</div>)}{!sources.length && <div className="list-empty">No discovery sources configured</div>}</div>
    </section>
    <section className="panel codex-profiles">
      <SectionTitle title="Codex profiles" meta={`${setup?.codex_profiles.length || 0} configured`} />
      <form className="profile-form" onSubmit={(event) => void createProfile(event)}>
        <label><span>Label</span><input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
        <label><span>Provider</span><input value={provider} onChange={(event) => setProvider(event.target.value)} required /></label>
        <label><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} required /></label>
        <label><span>Base URL</span><input value={baseUrl} disabled={provider === 'openai'} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label><span>Credential</span><select value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} required><option value="">Select credential</option>{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}</option>)}</select></label>
        <button className="button primary" disabled={!credentialRef || busy === 'profile-create'}><Plus size={15} />Add profile</button>
      </form>
      <div className="config-list">{setup?.codex_profiles.map((profile) => <div key={profile.id}><div><strong>{profile.label}</strong><small>{profile.provider} · {profile.model} · r{profile.revision}</small></div><Status value={profile.is_active ? profile.probe_status : profile.status} /><div className="row-tools">{!profile.is_active && <button className="icon-button" title="Activate profile" aria-label={`Activate ${profile.label}`} onClick={() => void activate(profile)}><Check size={14} /></button>}<button className="icon-button" title="Probe profile" aria-label={`Probe ${profile.label}`} disabled={!profile.is_active} onClick={() => void beginOperation(`probe-${profile.id}`, `/api/v1/profiles/codex/${profile.id}/probe`, { expected_revision: profile.revision, force: true })}><Activity size={14} /></button></div></div>)}{!setup?.codex_profiles.length && <div className="list-empty">No Codex profiles</div>}</div>
    </section>
  </div>;
}

function GithubTab({ setup, busy, runAction, beginOperation, refresh }: {
  setup: SetupState | null; busy: string;
  runAction: (key: string, action: () => Promise<void>) => Promise<void>;
  beginOperation: (key: string, path: string, body: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [appId, setAppId] = useState('');
  const [clientId, setClientId] = useState('');
  const privateKeys = setup?.credentials.filter((item) => item.kind === 'github_app_private_key' && item.status === 'active') || [];
  const webhookSecrets = setup?.credentials.filter((item) => item.kind === 'github_webhook_secret' && item.status === 'active') || [];
  const [privateKeyRef, setPrivateKeyRef] = useState('');
  const [webhookRef, setWebhookRef] = useState('');
  useEffect(() => {
    if (!privateKeys.some((item) => item.id === privateKeyRef)) setPrivateKeyRef(privateKeys[0]?.id || '');
    if (!webhookSecrets.some((item) => item.id === webhookRef)) setWebhookRef(webhookSecrets[0]?.id || '');
  }, [privateKeyRef, privateKeys, webhookRef, webhookSecrets]);
  const createApp = async (event: FormEvent) => {
    event.preventDefault();
    await runAction('github-app-create', async () => {
      await mutate('/api/v1/github/apps', { label, app_id: appId, client_id: clientId, private_key_ref: privateKeyRef, webhook_secret_ref: webhookRef });
      setLabel(''); setAppId(''); setClientId(''); await refresh();
    });
  };
  const discover = (app: GithubApp) => beginOperation(`discover-${app.id}`, `/api/v1/github/apps/${app.id}/installations/discover`, { expected_revision: app.revision });
  const sync = (installation: GithubInstallation) => beginOperation(`sync-${installation.id}`, `/api/v1/github/installations/${installation.id}/repositories/sync`, { expected_revision: installation.revision });
  const probe = (app: GithubApp) => beginOperation(`github-probe-${app.id}`, '/api/v1/integrations/github/probe', { app_config_id: app.id, expected_revision: app.revision, force: true });
  return <div className="setup-provider-stack">
    <CredentialManager provider="github" setup={setup} busy={busy} runAction={runAction} refresh={refresh} />
    <section className="panel github-apps">
      <SectionTitle title="GitHub App" meta={`${setup?.github_apps.length || 0} configured`} />
      <form className="github-app-form" onSubmit={(event) => void createApp(event)}>
        <label><span>Label</span><input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
        <label><span>App ID</span><input inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value)} required /></label>
        <label><span>Client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
        <label><span>Private key</span><select value={privateKeyRef} onChange={(event) => setPrivateKeyRef(event.target.value)} required><option value="">Select key</option>{privateKeys.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}</option>)}</select></label>
        <label><span>Webhook secret</span><select value={webhookRef} onChange={(event) => setWebhookRef(event.target.value)} required><option value="">Select secret</option>{webhookSecrets.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}</option>)}</select></label>
        <button className="button primary" disabled={!privateKeyRef || !webhookRef || busy === 'github-app-create'}><Github size={15} />Add App</button>
      </form>
      <div className="github-app-list">{setup?.github_apps.map((app) => <div className="github-app" key={app.id}><div className="github-app-head"><div><strong>{app.label}</strong><small>App {app.app_id} · {app.slug || 'unverified'} · r{app.revision}</small></div><Status value={app.probe_status === 'available' ? 'verified' : app.status} /><div className="provider-actions"><button className="button" onClick={() => void discover(app)}><Search size={14} />Installations</button><button className="button" disabled={!app.installations.length} onClick={() => void probe(app)}><Activity size={14} />Probe</button></div></div><div className="installation-list">{app.installations.map((installation) => <div className="installation-row" key={installation.id}><div><strong>{installation.account_login || installation.installation_id}</strong><small>Installation {installation.installation_id} · {installation.repositories.length} repositories</small></div><Status value={installation.status} /><button className="button" onClick={() => void sync(installation)}><RefreshCw size={14} />Sync</button>{installation.last_probe_code && <span className="installation-error">{installation.last_probe_code}</span>}</div>)}{!app.installations.length && <div className="list-empty">No installations discovered</div>}</div></div>)}{!setup?.github_apps.length && <div className="list-empty">No GitHub App configuration</div>}</div>
    </section>
  </div>;
}
