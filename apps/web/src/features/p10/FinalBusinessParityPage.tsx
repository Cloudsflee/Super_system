import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  Check,
  ChevronRight,
  CircleAlert,
  GitBranch,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Undo2,
  XCircle
} from 'lucide-react';
import { ApiError, apiV2, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Profile = { id: string; label: string; provider: string; status: string; lifecycle_status?: 'enabled' | 'disabled'; revision: number; credential_ref_id?: string | null; config?: Record<string, unknown> };
type Credential = { id: string; provider: string; status: string; revision: number };
type Template = { id: string; name: string; description: string; status: string; current_revision: number; revision: number; content: Record<string, unknown>; content_sha256?: string };
type Intent = { id: string; status: string; revision: number; target_name?: string; target_full_name?: string; expected_head_sha?: string; blockers?: Array<{ domain: string; count: number }> };
type Session = { id: string; title?: string; mode?: string; status: string; revision: number; pinned_at?: string | null; archived_at?: string | null; deleted_at?: string | null };
type QualityReadiness = { readiness?: { ready: boolean; checks: Record<string, string> }; policy?: { workflow_id?: string; revision?: number; threshold?: number; reviewer_profile_id?: string | null; rubric?: { schema_version?: string; dimensions?: Array<{ key: string; label?: string; enabled?: boolean; weight: number; description?: string }>; threshold?: number } } };
type RepositoryTarget = { id: string; connection_id: string; name: string; branch: string; remote_ref: string; expected_head_sha: string; revision: number; source_locator: string };

const tabs = [
  { id: 'provider', label: 'Provider', icon: Settings2 },
  { id: 'brief', label: 'Brief templates', icon: Archive },
  { id: 'project-delete', label: 'Project deletion', icon: Trash2 },
  { id: 'repository-delete', label: 'Repository deletion', icon: GitBranch },
  { id: 'assist', label: 'Assist lifecycle', icon: MessageSquare },
  { id: 'quality', label: 'Quality readiness', icon: ShieldCheck }
] as const;

export function FinalBusinessParityPage({ projectId, selectedProject, notify, navigate }: WorkspacePageProps) {
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('provider');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repositoryTargets, setRepositoryTargets] = useState<RepositoryTarget[]>([]);
  const [actorRevision, setActorRevision] = useState(1);
  const [projectRevision, setProjectRevision] = useState(selectedProject?.revision || 1);
  const [quality, setQuality] = useState<QualityReadiness | null>(null);
  const [projectIntent, setProjectIntent] = useState<Intent | null>(null);
  const [repositoryIntent, setRepositoryIntent] = useState<Intent | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    setError('');
    try {
      const [profileResult, credentialResult, templateResult, sessionResult, projectResult, executionResult, accountResult, connectionResult] = await Promise.all([
        apiV2<{ profiles: Profile[] }>('/api/v2/profiles'),
        apiV2<{ credentials: Credential[] }>('/api/v2/credentials'),
        apiV2<{ templates: Template[] }>('/api/v2/brief-templates'),
        apiV2<{ sessions: Session[] }>(`/api/v2/assist/sessions?project_id=${encodeURIComponent(projectId)}`),
        apiV2<{ project: { revision: number } }>(`/api/v2/projects/${encodeURIComponent(projectId)}`),
        apiV2<{ executions: Array<{ id: string }> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/executions`),
        apiV2<{ account: { revision: number } }>('/api/v2/account'),
        apiV2<{ connections: Array<{ id: string; source_locator: string }> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/repository-connections`)
      ]);
      setProfiles(profileResult.data.profiles || []);
      setCredentials(credentialResult.data.credentials || []);
      setTemplates(templateResult.data.templates || []);
      setSessions(sessionResult.data.sessions || []);
      setActorRevision(Number(accountResult.data.account?.revision || 1));
      setProjectRevision(Number(projectResult.data.project?.revision || selectedProject?.revision || 1));
      const connections = connectionResult.data.connections || [];
      const targetResults = await Promise.all(connections.map(async (connection) => {
        const response = await apiV2<{ targets: Omit<RepositoryTarget, 'source_locator'>[] }>(`/api/v2/repository-connections/${encodeURIComponent(connection.id)}/targets`);
        return (response.data.targets || []).map((target) => ({ ...target, source_locator: connection.source_locator }));
      }));
      setRepositoryTargets(targetResults.flat());
      const executionId = executionResult.data.executions?.[0]?.id;
      if (executionId) setQuality((await apiV2<QualityReadiness>(`/api/v2/executions/${encodeURIComponent(executionId)}/quality-reviews/prepare`)).data);
      else setQuality(null);
    } catch (caught) { report(caught); }
  }, [projectId, selectedProject?.revision]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setError('');
    try { await action(); notify(success); await load(); }
    catch (caught) { report(caught); }
    finally { setBusy(''); }
  };

  function report(caught: unknown) {
    const message = caught instanceof ApiError ? `${caught.code}: ${caught.message}` : caught instanceof Error ? caught.message : 'P10 request failed';
    setError(message);
  }


  return <div className="page p10-governance-page">
    <div className="page-heading">
      <div><p className="eyebrow">P10 final business parity</p><h1>Governance workspace</h1><p className="muted-copy">Revision-bound business controls for the selected project.</p></div>
      <button className="icon-button" title="Refresh governance" aria-label="Refresh governance" onClick={() => void load()}><RefreshCw size={16} /></button>
    </div>
    {error && <div className="state-banner error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    <div className="p10-layout">
      <aside className="panel p10-tabs" aria-label="P10 governance sections">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'p10-tab active' : 'p10-tab'} onClick={() => setTab(id)}><Icon size={16} /><span>{label}</span><ChevronRight size={14} /></button>)}
      </aside>
      <section className="p10-content">
        {tab === 'provider' && <ProviderPanel profiles={profiles} credentials={credentials} busy={busy} run={run} navigate={navigate} />}
        {tab === 'brief' && <TemplatePanel templates={templates} projectId={projectId} teamId={(selectedProject as (typeof selectedProject & { team_id?: string }) | undefined)?.team_id || ''} busy={busy} run={run} />}
        {tab === 'project-delete' && <ProjectDeletionPanel projectId={projectId} revision={projectRevision} intent={projectIntent} setIntent={setProjectIntent} busy={busy} run={run} />}
        {tab === 'repository-delete' && <RepositoryDeletionPanel targets={repositoryTargets} actorRevision={actorRevision} intent={repositoryIntent} setIntent={setRepositoryIntent} busy={busy} run={run} />}
        {tab === 'assist' && <AssistPanel sessions={sessions} busy={busy} run={run} />}
        {tab === 'quality' && <QualityPanel quality={quality} profiles={profiles} busy={busy} run={run} />}
      </section>
    </div>
  </div>;
}

function ProviderPanel({ profiles, credentials, busy, run, navigate }: { profiles: Profile[]; credentials: Credential[]; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void>; navigate: WorkspacePageProps['navigate'] }) {
  const [selectedId, setSelectedId] = useState('');
  const [label, setLabel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [config, setConfig] = useState('{}');
  const [repositories, setRepositories] = useState<Array<{ id: number; full_name: string; private?: boolean; default_branch?: string }>>([]);
  const profile = profiles.find((item) => item.id === selectedId) || profiles[0];
  const parsedConfig = useMemo(() => { try { const value = JSON.parse(config); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }, [config]);
  useEffect(() => { setSelectedId((current) => profiles.some((item) => item.id === current) ? current : profiles[0]?.id || ''); }, [profiles]);
  useEffect(() => { setLabel(profile?.label || ''); setCredentialId(profile?.credential_ref_id || ''); setConfig(JSON.stringify(profile?.config || {}, null, 2)); }, [profile?.id, profile?.revision]);
  useEffect(() => { setRepositories([]); }, [profile?.id]);
  if (!profile) return <section className="panel p10-panel"><PanelHeader icon={<Settings2 size={18} />} title="Provider profiles" detail="No profile is bound." /><button className="button primary" onClick={() => navigate('identity')}><Plus size={15} />Create profile</button></section>;
  const availableCredentials = credentials.filter((credential) => credential.provider === profile.provider && credential.status === 'active');
  return <section className="panel p10-panel"><PanelHeader icon={<Settings2 size={18} />} title="Provider profiles" detail={`${profile.provider} · revision ${profile.revision}`} /><label><span>Profile</span><select value={profile.id} onChange={(event) => setSelectedId(event.target.value)}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.provider}</option>)}</select></label><div className="p10-profile-row"><div><strong>{profile.label}</strong><small>{profile.status} · {profile.lifecycle_status || 'enabled'} · {shortHash(profile.id)}</small></div><span className={`status ${profile.lifecycle_status === 'disabled' ? 'negative' : profile.status === 'available' ? 'positive' : 'working'}`}><span />{profile.lifecycle_status === 'disabled' ? 'disabled' : profile.status}</span></div><div className="two-column"><label><span>Profile label</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} /></label><label><span>Credential</span><select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Unbound</option>{availableCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.provider} · {shortHash(credential.id)}</option>)}</select></label></div><label><span>Profile configuration</span><textarea rows={5} spellCheck={false} value={config} onChange={(event) => setConfig(event.target.value)} /></label>{!parsedConfig && <div className="state-banner error" role="alert">Profile configuration is invalid.</div>}<div className="p10-actions"><button className="button primary" disabled={!label.trim() || !parsedConfig || busy === 'profile-update'} onClick={() => void run('profile-update', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}`, { label, config: parsedConfig, ...(credentialId ? { credential_ref_id: credentialId } : {}) }, 'PATCH', profile.revision), 'Profile updated')}><Save size={15} />Save</button><button className="button" disabled={profile.lifecycle_status === 'disabled' || busy === 'profile-probe'} onClick={() => void run('profile-probe', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/probe`, {}, 'POST', profile.revision), 'Profile probed')}><Activity size={15} />Probe</button>{profile.provider === 'github' && <button className="button" disabled={profile.lifecycle_status === 'disabled' || busy === 'profile-discovery'} onClick={() => void run('profile-discovery', async () => { const response = await apiV2<{ repositories: typeof repositories }>(`/api/v2/provider-profiles/${encodeURIComponent(profile.id)}/repositories`); setRepositories(response.data.repositories || []); }, 'Repositories discovered')}><Search size={15} />Discover</button>}{profile.lifecycle_status === 'disabled' ? <button className="button" disabled={busy === 'profile-enable'} onClick={() => void run('profile-enable', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/enable`, {}, 'POST', profile.revision), 'Profile enabled')}><Check size={15} />Enable</button> : <button className="button" disabled={busy === 'profile-disable'} onClick={() => void run('profile-disable', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/disable`, {}, 'POST', profile.revision), 'Profile disabled')}><CircleAlert size={15} />Disable</button>}</div>{repositories.length > 0 && <div className="p10-repository-list">{repositories.map((repository) => <div key={repository.id}><GitBranch size={14} /><span><strong>{repository.full_name}</strong><small>{repository.default_branch || 'main'} · {repository.private ? 'private' : 'public'}</small></span></div>)}</div>}</section>;
}

function TemplatePanel({ templates, projectId, teamId, busy, run }: { templates: Template[]; projectId: string; teamId: string; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState('new');
  const [name, setName] = useState('');
  const [content, setContent] = useState('{"sections":["objective","acceptance"]}');
  const template = templates.find((item) => item.id === selectedId) || null;
  useEffect(() => { setSelectedId((current) => templates.some((item) => item.id === current) ? current : templates[0]?.id || 'new'); }, [templates]);
  useEffect(() => { setName(template?.name || ''); if (template?.content) setContent(JSON.stringify(template.content, null, 2)); }, [template?.id, template?.revision]);
  const parsed = useMemo(() => { try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; } }, [content]);
  return <section className="panel p10-panel"><PanelHeader icon={<Archive size={18} />} title="Brief templates" detail={template ? `template revision ${template.current_revision} · record ${template.revision}` : 'New template'} /><div className="form-stack"><label><span>Template</span><select value={template?.id || 'new'} onChange={(event) => setSelectedId(event.target.value)}><option value="new">New template</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name} · r{item.current_revision}</option>)}</select></label><label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder="Delivery Brief" /></label><label><span>Template JSON</span><textarea value={content} onChange={(event) => setContent(event.target.value)} rows={8} spellCheck={false} /></label>{!parsed && <div className="state-banner error" role="alert">Template JSON is invalid.</div>}<div className="p10-actions">{template ? <><button className="button primary" disabled={!name.trim() || !parsed || busy === 'template-update'} onClick={() => void run('template-update', () => mutateV2(`/api/v2/brief-templates/${encodeURIComponent(template.id)}`, { name, content: parsed }, 'PATCH', template.revision), 'Template revision created')}><Save size={15} />Save revision</button><button className="button" disabled={busy === 'template-archive'} onClick={() => void run('template-archive', () => mutateV2(`/api/v2/brief-templates/${encodeURIComponent(template.id)}/archive`, {}, 'POST', template.revision), 'Template archived')}><Archive size={15} />Archive</button></> : <button className="button primary" disabled={!projectId || !teamId || !name.trim() || !parsed || busy === 'template-create'} onClick={() => void run('template-create', () => mutateV2('/api/v2/brief-templates', { team_id: teamId, name, content: parsed }, 'POST', 0), 'Template created')}><Plus size={15} />Create template</button>}</div></div></section>;
}

function ProjectDeletionPanel({ projectId, revision, intent, setIntent, busy, run }: { projectId: string; revision: number; intent: Intent | null; setIntent: (value: Intent | null) => void; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  return <section className="panel p10-panel"><PanelHeader icon={<Trash2 size={18} />} title="Project deletion" detail="Revision-bound tombstone with blocker recheck" /><label><span>Project name confirmation</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Type the exact project name" /></label><div className="p10-actions"><button className="button" disabled={!name.trim() || busy === 'project-prepare'} onClick={() => void run('project-prepare', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/projects/${encodeURIComponent(projectId)}/deletion-intents`, { target_name: name }, 'POST', revision); setIntent(result.data.intent); setLoaded(true); }, 'Deletion intent prepared')}><ShieldCheck size={15} />Prepare</button>{intent && <><button className="button" disabled={busy === 'project-confirm' || !['prepared', 'blocked'].includes(intent.status)} onClick={() => void run('project-confirm', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(intent.id)}/confirm`, { target_name: name }, 'POST', intent.revision); setIntent(result.data.intent); }, 'Confirmation recorded')}><Check size={15} />Confirm</button><button className="button primary" disabled={busy === 'project-execute' || intent.status !== 'ready'} onClick={() => void run('project-execute', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(intent.id)}/execute`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, 'Project tombstoned')}><Trash2 size={15} />Execute</button><button className="button" disabled={busy === 'project-cancel' || ['executing', 'completed', 'cancelled'].includes(intent.status)} onClick={() => void run('project-cancel', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(intent.id)}/cancel`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, 'Deletion intent cancelled')}><XCircle size={15} />Cancel</button></>}</div>{loaded && intent && <IntentStatus intent={intent} />}</section>;
}

function RepositoryDeletionPanel({ targets, actorRevision, intent, setIntent, busy, run }: { targets: RepositoryTarget[]; actorRevision: number; intent: Intent | null; setIntent: (value: Intent | null) => void; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [targetId, setTargetId] = useState('');
  const [fullName, setFullName] = useState('');
  const [head, setHead] = useState('');
  const target = targets.find((item) => item.id === targetId) || targets[0] || null;
  useEffect(() => { setTargetId((current) => targets.some((item) => item.id === current) ? current : targets[0]?.id || ''); }, [targets]);
  useEffect(() => { if (!target) return; const candidate = [target.remote_ref, target.source_locator, target.name].find((value) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)); setFullName(candidate || ''); setHead(target.expected_head_sha || ''); setIntent(null); }, [target?.id]);
  return <section className="panel p10-panel"><PanelHeader icon={<GitBranch size={18} />} title="Repository deletion" detail="Full name, HEAD, target revision, and two session proofs" />{target ? <><label><span>Repository target</span><select value={target.id} onChange={(event) => setTargetId(event.target.value)}>{targets.map((item) => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select></label><div className="two-column"><label><span>Full name</span><input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="owner/repository" /></label><label><span>Expected HEAD</span><input className="mono" value={head} onChange={(event) => setHead(event.target.value)} maxLength={128} /></label></div><div className="p10-actions"><button className="button" disabled={!fullName || !head || busy === 'repository-prepare'} onClick={() => void run('repository-prepare', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-targets/${encodeURIComponent(target.id)}/deletion-intents`, { target_full_name: fullName, expected_head_sha: head }, 'POST', target.revision); setIntent(result.data.intent); }, 'Repository intent prepared')}><ShieldCheck size={15} />Prepare</button>{intent && <><button className="button" disabled={busy === 'repository-creator' || intent.status !== 'prepared'} onClick={() => void run('repository-creator', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/creator-confirm`, { target_full_name: fullName, expected_head_sha: head }, 'POST', intent.revision); setIntent(result.data.intent); }, 'Creator proof recorded')}><Check size={15} />Creator proof</button><button className="button" disabled={busy === 'repository-owner' || intent.status !== 'creator_confirmed'} onClick={() => void run('repository-owner', async () => { await mutateV2('/api/v2/sessions', { ttl_seconds: 3600 }, 'POST', actorRevision); const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/owner-confirm`, { target_full_name: fullName, expected_head_sha: head }, 'POST', intent.revision); setIntent(result.data.intent); }, 'Independent owner proof recorded')}><ShieldCheck size={15} />Owner proof</button><button className="button primary" disabled={busy === 'repository-execute' || intent.status !== 'ready'} onClick={() => void run('repository-execute', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/execute`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, 'Repository deletion requested')}><Trash2 size={15} />Execute</button>{['needs_reconcile', 'failed'].includes(intent.status) && <button className="button" disabled={busy === 'repository-reconcile'} onClick={() => void run('repository-reconcile', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/reconcile`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, 'Repository state reconciled')}><RotateCw size={15} />Reconcile</button>}<button className="button" disabled={busy === 'repository-cancel' || ['executing', 'completed', 'cancelled'].includes(intent.status)} onClick={() => void run('repository-cancel', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/cancel`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, 'Repository intent cancelled')}><XCircle size={15} />Cancel</button></>}</div>{intent && <IntentStatus intent={intent} />}</> : <p className="list-empty">No repository targets</p>}</section>;
}

function AssistPanel({ sessions, busy, run }: { sessions: Session[]; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('guided');
  const [pinned, setPinned] = useState(false);
  const [configuration, setConfiguration] = useState('{}');
  const session = sessions.find((item) => item.id === selectedId) || sessions[0] || null;
  useEffect(() => { setSelectedId((current) => sessions.some((item) => item.id === current) ? current : sessions[0]?.id || ''); }, [sessions]);
  useEffect(() => { setTitle(session?.title || ''); setMode(session?.mode || 'guided'); setPinned(Boolean(session?.pinned_at)); }, [session?.id, session?.revision]);
  const parsedConfiguration = useMemo(() => { try { const value = JSON.parse(configuration); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }, [configuration]);
  if (!session) return <section className="panel p10-panel"><PanelHeader icon={<MessageSquare size={18} />} title="Assist lifecycle" detail="No project session" /></section>;
  return <section className="panel p10-panel"><PanelHeader icon={<MessageSquare size={18} />} title={session.title || 'Assist session'} detail={`${session.mode || 'guided'} · revision ${session.revision}`} /><label><span>Session</span><select value={session.id} onChange={(event) => setSelectedId(event.target.value)}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title || shortHash(item.id)} · {item.status}</option>)}</select></label><div className="p10-profile-row"><div><strong>{shortHash(session.id)}</strong><small>{session.status}{session.pinned_at ? ' · pinned' : ''}{session.archived_at ? ' · archived' : ''}{session.deleted_at ? ' · deleted' : ''}</small></div><span className="status neutral"><span />{session.status}</span></div><div className="two-column"><label><span>Session title</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} /></label><label><span>Session mode</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="guided">Guided</option><option value="agent">Agent</option><option value="side_thread">Side thread</option></select></label></div><label className="p10-toggle"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span>Pin session</span></label><div className="p10-actions"><button className="button primary" disabled={busy === 'assist-metadata'} onClick={() => void run('assist-metadata', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}`, { title, mode, pinned }, 'PATCH', session.revision), 'Assist metadata updated')}><Save size={15} />Save metadata</button><button className="button" disabled={busy === 'assist-fork' || Boolean(session.deleted_at)} onClick={() => void run('assist-fork', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/fork`, { title: `Fork of ${title || shortHash(session.id)}` }, 'POST', session.revision), 'Assist fork created')}><GitBranch size={15} />Fork</button><button className="button" disabled={busy === 'assist-side' || Boolean(session.deleted_at)} onClick={() => void run('assist-side', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/side-threads`, { title: `Side thread of ${title || shortHash(session.id)}` }, 'POST', session.revision), 'Side thread created')}><MessageSquare size={15} />Side thread</button></div><label><span>Configuration revision</span><textarea rows={5} spellCheck={false} value={configuration} onChange={(event) => setConfiguration(event.target.value)} /></label>{!parsedConfiguration && <div className="state-banner error" role="alert">Assist configuration is invalid.</div>}<div className="p10-actions"><button className="button" disabled={!parsedConfiguration || busy === 'assist-configuration'} onClick={() => void run('assist-configuration', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/configurations`, { configuration: parsedConfiguration }, 'POST', session.revision), 'Assist configuration recorded')}><Plus size={15} />Record configuration</button><button className="button" disabled={busy === 'assist-archive' || Boolean(session.archived_at)} onClick={() => void run('assist-archive', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/archive`, {}, 'POST', session.revision), 'Assist session archived')}><Archive size={15} />Archive</button><button className="button" disabled={busy === 'assist-restore' || !session.archived_at || Boolean(session.deleted_at)} onClick={() => void run('assist-restore', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/restore`, {}, 'POST', session.revision), 'Assist session restored')}><Undo2 size={15} />Restore</button><button className="button" disabled={busy === 'assist-delete' || Boolean(session.deleted_at)} onClick={() => void run('assist-delete', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/delete`, {}, 'POST', session.revision), 'Assist session deleted')}><Trash2 size={15} />Delete</button><button className="button" disabled={busy === 'assist-restore-deleted' || !session.deleted_at} onClick={() => void run('assist-restore-deleted', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/restore-deleted`, {}, 'POST', session.revision), 'Deleted Assist session restored')}><Undo2 size={15} />Restore deleted</button></div></section>;
}

function QualityPanel({ quality, profiles, busy, run }: { quality: QualityReadiness | null; profiles: Profile[]; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const dimensions = quality?.policy?.rubric?.dimensions || [];
  const [threshold, setThreshold] = useState(80);
  const [reviewerId, setReviewerId] = useState('');
  useEffect(() => { setThreshold(Number(quality?.policy?.threshold ?? quality?.policy?.rubric?.threshold ?? 80)); setReviewerId(quality?.policy?.reviewer_profile_id || ''); }, [quality?.policy?.workflow_id, quality?.policy?.revision]);
  const reviewers = profiles.filter((profile) => profile.provider === 'codex' && profile.status === 'available' && profile.lifecycle_status !== 'disabled');
  return <section className="panel p10-panel"><PanelHeader icon={<ShieldCheck size={18} />} title="Quality readiness" detail="Policy, selections, advice, and human scores remain separate" />{quality ? <><div className="p10-readiness"><span className={`status ${quality.readiness?.ready ? 'positive' : 'negative'}`}><span />{quality.readiness?.ready ? 'ready' : 'blocked'}</span>{Object.entries(quality.readiness?.checks || {}).map(([key, value]) => <span key={key} className="p10-check"><strong>{key}</strong>{value}</span>)}</div><div className="p10-dimensions">{dimensions.map((dimension) => <span key={dimension.key}><Check size={13} />{dimension.key}<small>{dimension.weight}%</small></span>)}</div>{quality.policy?.workflow_id && <><div className="two-column"><label><span>Approval threshold</span><input type="number" min="0" max="100" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label><label><span>Advisory reviewer</span><select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">No model advice</option>{reviewers.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label></div><div className="p10-actions"><button className="button primary" disabled={!dimensions.length || busy === 'quality-policy'} onClick={() => void run('quality-policy', () => mutateV2(`/api/v2/workflows/${encodeURIComponent(quality.policy!.workflow_id!)}/quality-policy`, { rubric: { schema_version: quality.policy?.rubric?.schema_version || 'quality.rubric.v1', dimensions: dimensions.map((dimension) => ({ key: dimension.key, label: dimension.label || dimension.key, enabled: dimension.enabled !== false, weight: dimension.weight, description: dimension.description || '' })), threshold }, ...(reviewerId ? { reviewer_profile_id: reviewerId } : {}) }, 'PUT', Number(quality.policy?.revision || 0)), 'Quality policy updated')}><Save size={15} />Save policy</button></div></>}</> : <p className="list-empty">No execution</p>}</section>;
}

function IntentStatus({ intent }: { intent: Intent }) { return <div className="p10-intent-status"><span className={`status ${['ready','completed'].includes(intent.status) ? 'positive' : intent.status === 'blocked' ? 'negative' : 'working'}`}><span />{intent.status}</span><span className="mono">r{intent.revision}</span>{intent.blockers?.map((blocker) => <span key={blocker.domain} className="p10-blocker">{blocker.domain}: {blocker.count}</span>)}</div>; }
function PanelHeader({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="section-title"><div className="p10-panel-title"><span className="p10-title-icon">{icon}</span><div><h2>{title}</h2><span>{detail}</span></div></div></div>; }
