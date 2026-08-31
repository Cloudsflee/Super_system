import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Check, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw,
  RotateCw, Save, ShieldCheck, Users, UserRound, X, TimerReset, Ban
} from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { actionLabel, actorKindLabel, authTypeLabel, roleLabel, statusLabel } from '../../i18n';

type Actor = { id: string; kind: 'system' | 'user' | 'service' | 'agent'; display_name: string; status: string; revision: number };
type Team = { id: string; name: string; status: string; revision: number };
type Membership = { id: string; team_id?: string; project_id?: string; actor_id: string; role: string; status: string; revision: number; actor?: { display_name?: string; kind?: string } };
type Credential = { id: string; provider: 'codex' | 'github' | 'mcp'; status: string; external_ref: string; revision: number };
type Profile = { id: string; provider: 'codex' | 'github' | 'mcp'; label: string; status: string; revision: number; credential_ref_id?: string | null; lifecycle_status?: 'enabled' | 'disabled' };
type Session = { id: string; subject_actor_id: string; effective_actor_id: string; status: string; expires_at: string; last_seen_at?: string; revoked_at?: string | null; revision: number };
type Invitation = { id: string; project_id: string; invitee_ref: string; role: string; status: string; expires_at?: string | null; revision: number };
type Account = Actor & { metadata?: Record<string, unknown> };
type AclEntry = { id: string; project_id: string; principal_actor_id?: string | null; principal_team_id?: string | null; resource: string; action: string; effect: 'allow' | 'deny'; policy_revision: number; revision: number };
type View = 'identity' | 'teams' | 'members' | 'permissions' | 'credentials' | 'profiles' | 'sessions';
type LoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'error';

const views: Array<{ id: View; label: string; icon: typeof Users }> = [
  { id: 'identity', label: '身份', icon: UserRound },
  { id: 'teams', label: '团队', icon: Users },
  { id: 'members', label: '成员', icon: ShieldCheck },
  { id: 'permissions', label: '权限', icon: LockKeyhole },
  { id: 'credentials', label: '凭据', icon: KeyRound },
  { id: 'profiles', label: 'Profile', icon: Activity }
  , { id: 'sessions', label: '会话', icon: TimerReset }
];

function StatusPill({ value }: { value: string }) {
  const positive = ['active', 'available', 'accepted', 'owner'].includes(value);
  const negative = ['revoked', 'failed', 'denied', 'unavailable'].includes(value);
  return <span className={`status ${positive ? 'positive' : negative ? 'negative' : 'neutral'}`}><span />{statusLabel(value)}</span>;
}

function SectionTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

export function IdentityAccessPage({ setupReady, notify, projectId, initialView = 'identity' }: WorkspacePageProps & { initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  useEffect(() => setView(initialView), [initialView]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [projectMemberships, setProjectMemberships] = useState<Membership[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [permissionProjectId, setPermissionProjectId] = useState(projectId || '');
  const [permissionEntries, setPermissionEntries] = useState<AclEntry[]>([]);
  const [permissionRevision, setPermissionRevision] = useState(0);
  const [permissionState, setPermissionState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'denied' | 'error'>('idle');
  const [permissionFailure, setPermissionFailure] = useState('');
  const [permissionPrincipalType, setPermissionPrincipalType] = useState<'actor' | 'team'>('actor');
  const [permissionPrincipalId, setPermissionPrincipalId] = useState('');
  const [permissionResource, setPermissionResource] = useState('*');
  const [permissionAction, setPermissionAction] = useState('read');
  const [permissionEffect, setPermissionEffect] = useState<'allow' | 'deny'>('allow');
  const [permissionEditId, setPermissionEditId] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [failure, setFailure] = useState('');
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [rebindRequired, setRebindRequired] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [actorName, setActorName] = useState('');
  const [memberActorId, setMemberActorId] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [provider, setProvider] = useState<Credential['provider']>('codex');
  const [externalRef, setExternalRef] = useState('');
  const [credentialProof, setCredentialProof] = useState('');
  const [profileLabel, setProfileLabel] = useState('');
  const [profileCredentialId, setProfileCredentialId] = useState('');

  const load = useCallback(async () => {
    if (!setupReady) {
      setLoadState('empty');
      return;
    }
    setLoadState('loading');
    setFailure('');
    try {
      const [accountResult, actorsResult, teamsResult, credentialsResult, profilesResult, sessionsResult] = await Promise.all([
        apiV2<{ account: Account }>('/api/v2/account'),
        apiV2<{ actors: Actor[] }>('/api/v2/actors'),
        apiV2<{ teams: Team[] }>('/api/v2/teams'),
        apiV2<{ credentials: Credential[] }>('/api/v2/credentials'),
        apiV2<{ profiles: Profile[] }>('/api/v2/profiles'),
        apiV2<{ sessions: Session[] }>('/api/v2/sessions')
      ]);
      const nextAccount = accountResult.data.account;
      const nextTeams = teamsResult.data.teams || [];
      setAccount(nextAccount);
      setDisplayName(nextAccount.display_name);
      setActors(actorsResult.data.actors || []);
      setTeams(nextTeams);
      setCredentials(credentialsResult.data.credentials || []);
      setProfiles(profilesResult.data.profiles || []);
      setSessions(sessionsResult.data.sessions || []);
      setSelectedTeamId((current) => nextTeams.some((team) => team.id === current) ? current : (nextTeams[0]?.id || ''));
      setLoadState(nextAccount || nextTeams.length ? 'ready' : 'empty');
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) setLoadState('denied');
      else setLoadState('error');
      setFailure(error instanceof Error ? error.message : '请求失败');
    }
  }, [setupReady]);

  const loadMembers = useCallback(async () => {
    if (!selectedTeamId || !setupReady) {
      setMemberships([]);
      return;
    }
    try {
      const result = await apiV2<{ memberships: Membership[] }>(`/api/v2/teams/${encodeURIComponent(selectedTeamId)}/memberships`);
      setMemberships(result.data.memberships || []);
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) setFailure('权限不足');
      else setFailure(error instanceof Error ? error.message : '请求失败');
    }
  }, [selectedTeamId, setupReady]);

  const loadProjectMembers = useCallback(async () => {
    if (!projectId || !setupReady) { setProjectMemberships([]); setInvitations([]); return; }
    try {
      const [memberResult, inviteResult] = await Promise.all([
        apiV2<{ memberships: Membership[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/members`),
        apiV2<{ invitations: Invitation[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/invitations`)
      ]);
      setProjectMemberships(memberResult.data.memberships || []); setInvitations(inviteResult.data.invitations || []);
    } catch (error) { setFailure(error instanceof Error ? error.message : '项目成员请求失败'); }
  }, [projectId, setupReady]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadMembers(); }, [loadMembers]);
  useEffect(() => { if (view === 'members') void loadProjectMembers(); }, [loadProjectMembers, view]);
  useEffect(() => {
    setPermissionProjectId(projectId || '');
    setPermissionEntries([]);
    setPermissionRevision(0);
    setPermissionState(projectId ? 'idle' : 'empty');
  }, [projectId]);

  const loadPermissions = useCallback(async (id: string) => {
    const value = String(id || '').trim();
    if (!value) {
      setPermissionEntries([]);
      setPermissionRevision(0);
      setPermissionState('empty');
      setPermissionFailure('');
      return;
    }
    setPermissionState('loading');
    setPermissionFailure('');
    try {
      const result = await apiV2<{ entries: AclEntry[] }>(`/api/v2/projects/${encodeURIComponent(value)}/permissions`);
      const entries = result.data.entries || [];
      const revision = Number(result.meta.resource_revision || entries.reduce((max, entry) => Math.max(max, Number(entry.policy_revision || 0)), 0));
      setPermissionEntries(entries);
      setPermissionRevision(revision);
      setPermissionState(entries.length ? 'ready' : 'empty');
    } catch (error) {
      const denied = error instanceof ApiError && [401, 403].includes(error.status);
      setPermissionState(denied ? 'denied' : 'error');
      setPermissionFailure(error instanceof Error ? error.message : '权限请求失败');
    }
  }, []);

  useEffect(() => {
    if (view === 'permissions') void loadPermissions(permissionProjectId);
  }, [loadPermissions, permissionProjectId, view]);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setFailure('');
    setConflictRevision(null);
    try {
      await action();
      await load();
      await loadMembers();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'revision_conflict') setConflictRevision(Number(error.details.actual_revision || 0) || null);
        if (error.code === 'rebind_required') setRebindRequired(String(error.details.credential_ref_id || 'required'));
        setFailure(error.message);
      } else setFailure(error instanceof Error ? error.message : '请求失败');
    } finally {
      setBusy('');
    }
  }, [load, loadMembers]);

  const saveAccount = (event: FormEvent) => {
    event.preventDefault();
    if (!account) return;
    void run('account', async () => {
      await mutateV2('/api/v2/account', { display_name: displayName }, 'PATCH', account.revision);
      notify('账户已更新');
    });
  };

  const createTeam = (event: FormEvent) => {
    event.preventDefault();
    void run('team-create', async () => {
      await mutateV2('/api/v2/teams', { name: teamName }, 'POST', 0);
      setTeamName('');
      notify('团队已创建');
    });
  };

  const createActor = (event: FormEvent) => {
    event.preventDefault();
    void run('actor-create', async () => {
      await mutateV2('/api/v2/actors', { kind: 'service', display_name: actorName, metadata: {} }, 'POST', 0);
      setActorName('');
       notify('Actor 已创建');
    });
  };

  const setActorLifecycle = (actor: Actor, next: 'active' | 'suspended' | 'revoked') => void run(`actor-${next}-${actor.id}`, async () => {
    await mutateV2(`/api/v2/actors/${encodeURIComponent(actor.id)}/${next === 'active' ? 'activate' : next}`, {}, 'POST', actor.revision);
    notify(`Actor${next === 'active' ? '已激活' : next === 'suspended' ? '已暂停' : '已撤销'}`);
  });

  const createSession = () => {
    if (!account) return;
    void run('session-create', async () => {
      await mutateV2('/api/v2/sessions', { ttl_seconds: 30 * 24 * 60 * 60 }, 'POST', account.revision);
      notify('会话已创建');
    });
  };

  const revokeSession = (session: Session) => void run(`session-revoke-${session.id}`, async () => {
    await mutateV2(`/api/v2/sessions/${encodeURIComponent(session.id)}/revoke`, { reason: 'user_revoked' }, 'POST', session.revision);
    notify('会话已撤销');
  });

  const grantMember = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTeamId) return;
    void run('member-grant', async () => {
      const teamRevision = teams.find((team) => team.id === selectedTeamId)?.revision ?? 0;
      await mutateV2(`/api/v2/teams/${encodeURIComponent(selectedTeamId)}/memberships`, { actor_id: memberActorId, role: memberRole }, 'POST', teamRevision);
      setMemberActorId('');
      notify('团队成员关系已授予');
    });
  };

  const grantProjectMember = (event: FormEvent) => {
    event.preventDefault(); if (!projectId || !memberActorId) return;
    void run('project-member-grant', async () => {
      const current = projectMemberships.find((member) => member.actor_id === memberActorId);
      await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/members`, { actor_id: memberActorId, role: memberRole }, 'POST', current?.revision || 0);
      setMemberActorId(''); await loadProjectMembers(); notify('项目成员关系已授予');
    });
  };

  const createInvitation = (event: FormEvent) => {
    event.preventDefault(); if (!projectId || !memberActorId) return;
      void run('project-invite', async () => { await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/invitations`, { invitee_actor_id: memberActorId, role: memberRole }, 'POST', 0); await loadProjectMembers(); notify('项目邀请已创建'); });
  };

  const createCredential = (event: FormEvent) => {
    event.preventDefault();
    void run('credential-create', async () => {
      await mutateV2('/api/v2/credentials', { provider, external_ref: externalRef, scope: {} }, 'POST', 0);
      setExternalRef('');
      notify('凭据元数据已创建');
    });
  };

  const rebind = (credential: Credential) => {
    void run(`rebind-${credential.id}`, async () => {
      const result = await mutateV2(`/api/v2/credentials/${encodeURIComponent(credential.id)}/rebind`, { proof: credentialProof }, 'POST', credential.revision);
      setCredentialProof('');
      setRebindRequired(null);
      if (result.data) notify('凭据重新绑定已排队');
    });
  };

  const rotateCredential = (credential: Credential) => void run(`rotate-${credential.id}`, async () => {
    await mutateV2(`/api/v2/credentials/${encodeURIComponent(credential.id)}/rotate`, { proof: credentialProof }, 'POST', credential.revision);
    setCredentialProof('');
    notify('凭据已轮换');
  });

  const revokeCredential = (credential: Credential) => void run(`revoke-${credential.id}`, async () => {
    await mutateV2(`/api/v2/credentials/${encodeURIComponent(credential.id)}/revoke`, { reason: 'user_revoked' }, 'POST', credential.revision);
    notify('凭据已撤销');
  });

  const createProfile = (event: FormEvent) => {
    event.preventDefault();
    void run('profile-create', async () => {
      await mutateV2('/api/v2/profiles', { provider, label: profileLabel, credential_ref_id: profileCredentialId || undefined }, 'POST', 0);
      setProfileLabel('');
      notify('Profile 已创建');
    });
  };

  const probeProfile = (profile: Profile) => {
    void run(`probe-${profile.id}`, async () => {
      await mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/probe`, {}, 'POST', profile.revision);
      notify('Profile 探测已排队');
    });
  };

  const setProfileLifecycle = (profile: Profile, next: 'enable' | 'disable') => void run(`profile-${next}-${profile.id}`, async () => {
    await mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/${next}`, {}, 'POST', profile.revision);
    notify(`Profile${next === 'enable' ? '已启用' : '已禁用'}`);
  });

  const savePermission = (event: FormEvent) => {
    event.preventDefault();
    const project = permissionProjectId.trim();
    const principal = permissionPrincipalId.trim();
    if (!project || !principal) return;
    void run(`acl-${permissionEditId || 'create'}`, async () => {
      const body: Record<string, unknown> = {
        ...(permissionEditId ? { id: permissionEditId } : {}),
        ...(permissionPrincipalType === 'actor' ? { principal_actor_id: principal } : { principal_team_id: principal }),
        resource: permissionResource.trim() || '*',
        action: permissionAction,
        effect: permissionEffect
      };
      const current = permissionEntries.find((entry) => entry.id === permissionEditId);
      await mutateV2(`/api/v2/projects/${encodeURIComponent(project)}/permissions`, body, 'POST', current?.revision ?? permissionRevision);
      setPermissionEditId('');
      await loadPermissions(project);
      notify(permissionEffect === 'deny' ? '拒绝权限规则已保存' : '允许权限规则已保存');
    });
  };

  const editPermission = (entry: AclEntry) => {
    setPermissionEditId(entry.id);
    if (entry.principal_team_id) {
      setPermissionPrincipalType('team');
      setPermissionPrincipalId(entry.principal_team_id);
    } else {
      setPermissionPrincipalType('actor');
      setPermissionPrincipalId(entry.principal_actor_id || '');
    }
    setPermissionResource(entry.resource || '*');
    setPermissionAction(entry.action);
    setPermissionEffect(entry.effect);
  };

  const actorOptions = useMemo(() => actors.filter((actor) => actor.kind !== 'system'), [actors]);

  if (loadState === 'loading') return <div className="page-loader" data-testid="identity-loading"><LoaderCircle className="spin" size={18} />正在加载身份信息</div>;
  if (loadState === 'denied') return <div className="page identity-page"><div className="state-banner denied" data-testid="identity-denied"><LockKeyhole size={20} /><div><strong>访问被拒绝</strong><span>{failure || '权限不足'}</span></div><button className="icon-button" title="重试" aria-label="重试" onClick={() => void load()}><RefreshCw size={16} /></button></div></div>;
  if (!setupReady || loadState === 'empty') return <div className="page identity-page"><div className="empty-state" data-testid="identity-empty"><Users size={30} /><h2>{setupReady ? '暂无身份记录' : '需要先完成系统配置'}</h2><button className="button" onClick={() => void load()}><RefreshCw size={15} />刷新</button></div></div>;

  return <div className="page identity-page">
    <div className="page-heading"><div><p className="eyebrow">访问控制</p><h1>身份与团队</h1></div><button className="icon-button" title="刷新" aria-label="刷新" disabled={busy !== ''} onClick={() => void load()}><RefreshCw className={busy ? 'spin' : ''} size={17} /></button></div>
    {failure && <div className="state-banner error" role="alert"><AlertTriangle size={18} /><span>{failure}</span><button className="icon-button" title="关闭" aria-label="关闭" onClick={() => setFailure('')}><X size={15} /></button></div>}
    {conflictRevision != null && <div className="state-banner conflict" data-testid="identity-conflict"><AlertTriangle size={18} /><span>版本已变更为 r{conflictRevision}，请刷新后重试。</span><button className="button" onClick={() => { setConflictRevision(null); void load(); }}>刷新</button></div>}
    {rebindRequired && <div className="state-banner rebind" data-testid="identity-rebind"><KeyRound size={18} /><span>需要重新绑定凭据：{rebindRequired}</span><button className="button" onClick={() => setView('credentials')}>打开凭据</button></div>}
    <div className="identity-tabs" role="tablist" aria-label="身份视图">{views.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={15} />{label}</button>)}</div>
    {view === 'identity' && <IdentityView account={account} displayName={displayName} setDisplayName={setDisplayName} saveAccount={saveAccount} busy={busy} />}
    {view === 'teams' && <TeamsView teams={teams} actors={actorOptions} selectedTeamId={selectedTeamId} setSelectedTeamId={setSelectedTeamId} teamName={teamName} setTeamName={setTeamName} createTeam={createTeam} actorName={actorName} setActorName={setActorName} createActor={createActor} setActorLifecycle={setActorLifecycle} busy={busy} />}
    {view === 'members' && <MembersView teams={teams} selectedTeamId={selectedTeamId} setSelectedTeamId={setSelectedTeamId} memberships={memberships} projectMemberships={projectMemberships} invitations={invitations} projectId={projectId} actors={actorOptions} memberActorId={memberActorId} setMemberActorId={setMemberActorId} memberRole={memberRole} setMemberRole={setMemberRole} grantMember={grantMember} grantProjectMember={grantProjectMember} createInvitation={createInvitation} busy={busy} />}
    {view === 'permissions' && <PermissionsView
      projectId={permissionProjectId}
      setProjectId={setPermissionProjectId}
      entries={permissionEntries}
      revision={permissionRevision}
      state={permissionState}
      failure={permissionFailure}
      onLoad={() => void loadPermissions(permissionProjectId)}
      actors={actorOptions}
      teams={teams}
      principalType={permissionPrincipalType}
      setPrincipalType={setPermissionPrincipalType}
      principalId={permissionPrincipalId}
      setPrincipalId={setPermissionPrincipalId}
      resource={permissionResource}
      setResource={setPermissionResource}
      action={permissionAction}
      setAction={setPermissionAction}
      effect={permissionEffect}
      setEffect={setPermissionEffect}
      editId={permissionEditId}
      save={savePermission}
      edit={editPermission}
      busy={busy}
    />}
    {view === 'credentials' && <CredentialsView credentials={credentials} provider={provider} setProvider={setProvider} externalRef={externalRef} setExternalRef={setExternalRef} createCredential={createCredential} credentialProof={credentialProof} setCredentialProof={setCredentialProof} rebind={rebind} rotate={rotateCredential} revoke={revokeCredential} busy={busy} />}
    {view === 'profiles' && <><ProviderRecoveryPanel notify={notify} /><ProfilesView profiles={profiles} provider={provider} setProvider={setProvider} profileLabel={profileLabel} setProfileLabel={setProfileLabel} profileCredentialId={profileCredentialId} setProfileCredentialId={setProfileCredentialId} credentials={credentials} createProfile={createProfile} probeProfile={probeProfile} setProfileLifecycle={setProfileLifecycle} busy={busy} /></>}
    {view === 'sessions' && <SessionsView sessions={sessions} createSession={createSession} revokeSession={revokeSession} busy={busy} />}
  </div>;
}

function IdentityView({ account, displayName, setDisplayName, saveAccount, busy }: { account: Account | null; displayName: string; setDisplayName: (value: string) => void; saveAccount: (event: FormEvent) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="账户" meta={account ? `r${account.revision}` : '不可用'} /><form className="identity-form" onSubmit={saveAccount}><label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={160} /></label><button className="button primary" disabled={busy === 'account'}>{busy === 'account' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存</button></form></section><section className="panel"><SectionTitle title="会话主体" /><dl className="definition-list"><div><dt>Actor（主体）</dt><dd className="mono">{account?.id}</dd></div><div><dt>类型</dt><dd>{actorKindLabel(account?.kind)}</dd></div><div><dt>状态</dt><dd><StatusPill value={account?.status || 'unknown'} /></dd></div><div><dt>修订</dt><dd>r{account?.revision || 0}</dd></div></dl></section></div>;
}

function TeamsView({ teams, actors, selectedTeamId, setSelectedTeamId, teamName, setTeamName, createTeam, actorName, setActorName, createActor, setActorLifecycle, busy }: { teams: Team[]; actors: Actor[]; selectedTeamId: string; setSelectedTeamId: (value: string) => void; teamName: string; setTeamName: (value: string) => void; createTeam: (event: FormEvent) => void; actorName: string; setActorName: (value: string) => void; createActor: (event: FormEvent) => void; setActorLifecycle: (actor: Actor, next: 'active' | 'suspended' | 'revoked') => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="团队" meta={`${teams.length} 个可见团队`} /><div className="identity-list">{teams.map((team) => <button type="button" className={team.id === selectedTeamId ? 'identity-row selected' : 'identity-row'} key={team.id} onClick={() => setSelectedTeamId(team.id)}><span><strong>{team.name}</strong><small className="mono">{team.id} · r{team.revision}</small></span><StatusPill value={team.status} /></button>)}{!teams.length && <div className="list-empty">暂无团队</div>}</div><form className="inline-form" onSubmit={createTeam}><label><span>团队名称</span><input value={teamName} onChange={(event) => setTeamName(event.target.value)} required maxLength={160} /></label><button className="button primary" disabled={busy === 'team-create'}><Plus size={15} />创建</button></form></section><section className="panel"><SectionTitle title="Actor（主体）" meta="服务与代理身份" /><div className="identity-list">{actors.map((actor) => <div className="identity-row" key={actor.id}><span><strong>{actor.display_name}</strong><small className="mono">{actorKindLabel(actor.kind)} · {actor.id} · r{actor.revision}</small></span><StatusPill value={actor.status} /><div className="row-actions">{actor.status === 'active' && actor.kind !== 'user' && <button className="icon-button" title="暂停 Actor" aria-label={`暂停 Actor：${actor.display_name}`} onClick={() => setActorLifecycle(actor, 'suspended')}><Ban size={14} /></button>}{actor.status === 'suspended' && <button className="icon-button" title="激活 Actor" aria-label={`激活 Actor：${actor.display_name}`} onClick={() => setActorLifecycle(actor, 'active')}><Check size={14} /></button>}{actor.status !== 'revoked' && actor.kind !== 'user' && <button className="icon-button danger" title="撤销 Actor" aria-label={`撤销 Actor：${actor.display_name}`} onClick={() => setActorLifecycle(actor, 'revoked')}><X size={14} /></button>}</div></div>)}{!actors.length && <div className="list-empty">暂无 Actor</div>}</div><div className="inline-form"><label><span>显示名称</span><input value={actorName} onChange={(event) => setActorName(event.target.value)} placeholder="服务 Actor" /></label><button className="button" disabled={!actorName.trim() || busy === 'actor-create'} onClick={(event) => { event.preventDefault(); createActor(event); }}><Plus size={15} />添加 Actor</button></div></section></div>;
}

function MembersView({ teams, selectedTeamId, setSelectedTeamId, memberships, projectMemberships, invitations, projectId, actors, memberActorId, setMemberActorId, memberRole, setMemberRole, grantMember, grantProjectMember, createInvitation, busy }: { teams: Team[]; selectedTeamId: string; setSelectedTeamId: (value: string) => void; memberships: Membership[]; projectMemberships: Membership[]; invitations: Invitation[]; projectId: string; actors: Actor[]; memberActorId: string; setMemberActorId: (value: string) => void; memberRole: string; setMemberRole: (value: string) => void; grantMember: (event: FormEvent) => void; grantProjectMember: (event: FormEvent) => void; createInvitation: (event: FormEvent) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="团队成员" meta={selectedTeamId ? `团队 ${selectedTeamId.slice(-8)}` : '请选择团队'} /><label className="field-block"><span>团队</span><select value={selectedTeamId} onChange={(event) => setSelectedTeamId(event.target.value)}><option value="">选择团队</option>{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><div className="identity-list">{memberships.map((member) => <div className="identity-row" key={member.id}><span><strong>{member.actor?.display_name || member.actor_id}</strong><small>{roleLabel(member.role)} · r{member.revision}</small></span><StatusPill value={member.status} /></div>)}{!memberships.length && <div className="list-empty">暂无成员</div>}</div><form className="identity-form" onSubmit={grantMember}><label><span>Actor（主体）</span><select value={memberActorId} onChange={(event) => setMemberActorId(event.target.value)} required><option value="">选择 Actor</option>{actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.display_name}（{actorKindLabel(actor.kind)}）</option>)}</select></label><label><span>角色</span><select value={memberRole} onChange={(event) => setMemberRole(event.target.value)}><option value="member">成员</option><option value="admin">管理员</option><option value="observer">观察者</option></select></label><button className="button primary" disabled={!selectedTeamId || busy === 'member-grant'}><Check size={15} />授予</button></form></section><section className="panel"><SectionTitle title="项目成员" meta={projectId ? `${projectMemberships.length} 位成员 · ${invitations.length} 项邀请` : '请选择项目'} /><div className="identity-list">{projectMemberships.map((member) => <div className="identity-row" key={member.id}><span><strong>{member.actor?.display_name || member.actor_id}</strong><small>{roleLabel(member.role)} · r{member.revision}</small></span><StatusPill value={member.status} /></div>)}{invitations.map((invite) => <div className="identity-row" key={invite.id}><span><strong>{invite.invitee_ref}</strong><small>邀请 · {roleLabel(invite.role)} · r{invite.revision}</small></span><StatusPill value={invite.status} /></div>)}{projectId && !projectMemberships.length && !invitations.length && <div className="list-empty">暂无项目成员</div>}</div>{projectId && <><form className="identity-form" onSubmit={grantProjectMember}><label><span>Actor（主体）</span><select value={memberActorId} onChange={(event) => setMemberActorId(event.target.value)} required><option value="">选择 Actor</option>{actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.display_name}</option>)}</select></label><button className="button" disabled={busy === 'project-member-grant'}><Users size={15} />添加成员</button></form><form className="identity-form" onSubmit={createInvitation}><label><span>邀请 Actor</span><select value={memberActorId} onChange={(event) => setMemberActorId(event.target.value)} required><option value="">选择 Actor</option>{actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.display_name}</option>)}</select></label><button className="button" disabled={busy === 'project-invite'}><Plus size={15} />发送邀请</button></form></>}</section></div>;
}

function PermissionsView({
  projectId, setProjectId, entries, revision, state, failure, onLoad, actors, teams,
  principalType, setPrincipalType, principalId, setPrincipalId, resource, setResource,
  action, setAction, effect, setEffect, editId, save, edit, busy
}: {
  projectId: string;
  setProjectId: (value: string) => void;
  entries: AclEntry[];
  revision: number;
  state: 'idle' | 'loading' | 'ready' | 'empty' | 'denied' | 'error';
  failure: string;
  onLoad: () => void;
  actors: Actor[];
  teams: Team[];
  principalType: 'actor' | 'team';
  setPrincipalType: (value: 'actor' | 'team') => void;
  principalId: string;
  setPrincipalId: (value: string) => void;
  resource: string;
  setResource: (value: string) => void;
  action: string;
  setAction: (value: string) => void;
  effect: 'allow' | 'deny';
  setEffect: (value: 'allow' | 'deny') => void;
  editId: string;
  save: (event: FormEvent) => void;
  edit: (entry: AclEntry) => void;
  busy: string;
}) {
  const principals = principalType === 'actor' ? actors : teams;
  return <div className="identity-grid permissions-grid">
    <section className="panel">
      <SectionTitle title="项目权限" meta={revision ? `策略 r${revision}` : '项目范围'} action={<button className="icon-button" title="刷新权限" aria-label="刷新权限" onClick={onLoad} disabled={state === 'loading'}><RefreshCw className={state === 'loading' ? 'spin' : ''} size={16} /></button>} />
      <div className="inline-form permission-project-form">
        <label><span>项目 ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="项目引用" /></label>
        <button className="button" type="button" onClick={onLoad} disabled={!projectId.trim() || state === 'loading'}><Activity size={15} />加载</button>
      </div>
      {state === 'denied' && <div className="state-banner denied" data-testid="permissions-denied"><LockKeyhole size={18} /><span>{failure || '权限不足'}</span></div>}
      {state === 'error' && <div className="state-banner error" role="alert"><AlertTriangle size={18} /><span>{failure || '权限请求失败'}</span></div>}
      {state === 'empty' && <div className="empty-state compact" data-testid="permissions-empty"><LockKeyhole size={24} /><h3>{projectId ? '暂无 ACL 规则' : '请选择项目'}</h3><p className="muted-copy">{projectId ? '创建一条明确的允许或拒绝规则。' : '读取 ACL 前需要提供项目引用。'}</p></div>}
      {state === 'loading' && <div className="page-loader compact" data-testid="permissions-loading"><LoaderCircle className="spin" size={17} />正在加载权限</div>}
       {entries.length > 0 && <div className="identity-list permission-list">{entries.map((entry) => <div className="identity-row" key={entry.id}><span><strong>{entry.effect === 'allow' ? '允许' : '拒绝'} · {actionLabel(entry.action)}</strong><small className="mono">{entry.principal_actor_id || entry.principal_team_id || '未知主体'} · {entry.resource} · r{entry.revision}</small></span><StatusPill value={entry.effect === 'allow' ? 'active' : 'denied'} /><button className="icon-button" title="编辑权限" aria-label={`编辑权限 ${entry.id}`} onClick={() => edit(entry)}><Save size={14} /></button></div>)}</div>}
    </section>
    <section className="panel">
      <SectionTitle title={editId ? '编辑规则' : '添加规则'} meta="明确的拒绝规则优先" />
      <form className="identity-form" onSubmit={save}>
         <label><span>主体类型</span><select value={principalType} onChange={(event) => { const value = event.target.value as 'actor' | 'team'; setPrincipalType(value); setPrincipalId(''); }}><option value="actor">Actor（主体）</option><option value="team">团队</option></select></label>
        <label><span>主体</span><select value={principalId} onChange={(event) => setPrincipalId(event.target.value)} required><option value="">选择主体</option>{principals.map((principal) => <option key={principal.id} value={principal.id}>{'display_name' in principal ? principal.display_name : principal.name}</option>)}</select></label>
        <label><span>动作</span><select value={action} onChange={(event) => setAction(event.target.value)}><option value="read">读取</option><option value="write">写入</option><option value="run">运行</option><option value="approve">审批</option></select></label>
        <label><span>资源</span><input value={resource} onChange={(event) => setResource(event.target.value)} maxLength={160} required /></label>
        <label><span>效果</span><select value={effect} onChange={(event) => setEffect(event.target.value as 'allow' | 'deny')}><option value="allow">允许</option><option value="deny">拒绝</option></select></label>
        <div className="form-actions"><button className="button primary" disabled={!projectId.trim() || !principalId || busy.startsWith('acl-')}><ShieldCheck size={15} />{busy.startsWith('acl-') ? '保存中' : editId ? '保存规则' : '添加规则'}</button>{editId && <button className="button" type="button" onClick={() => edit({ id: '', project_id: projectId, resource: '*', action: 'read', effect: 'allow', policy_revision: revision, revision: 0 })}>清除</button>}</div>
      </form>
    </section>
  </div>;
}

function CredentialsView({ credentials, provider, setProvider, externalRef, setExternalRef, createCredential, credentialProof, setCredentialProof, rebind, rotate, revoke, busy }: { credentials: Credential[]; provider: Credential['provider']; setProvider: (value: Credential['provider']) => void; externalRef: string; setExternalRef: (value: string) => void; createCredential: (event: FormEvent) => void; credentialProof: string; setCredentialProof: (value: string) => void; rebind: (credential: Credential) => void; rotate: (credential: Credential) => void; revoke: (credential: Credential) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="凭据元数据" meta={`${credentials.length} 条记录`} /><div className="identity-list">{credentials.map((credential) => <div className="identity-row" key={credential.id}><span><strong>{credential.provider}</strong><small className="mono">{credential.external_ref} · r{credential.revision}</small></span><StatusPill value={credential.status} /><div className="row-actions">{['rebind_required', 'failed'].includes(credential.status) && <button className="icon-button" title="重新绑定" aria-label={`重新绑定 ${credential.id}`} onClick={() => rebind(credential)} disabled={!credentialProof || busy === `rebind-${credential.id}`}><RotateCw size={15} /></button>}{credential.status === 'active' && <button className="icon-button" title="轮换凭据" aria-label={`轮换凭据 ${credential.id}`} onClick={() => rotate(credential)} disabled={!credentialProof || busy === `rotate-${credential.id}`}><RefreshCw size={15} /></button>}{!['revoked'].includes(credential.status) && <button className="icon-button danger" title="撤销凭据" aria-label={`撤销凭据 ${credential.id}`} onClick={() => revoke(credential)} disabled={busy === `revoke-${credential.id}`}><Ban size={15} /></button>}</div></div>)}{!credentials.length && <div className="list-empty">暂无凭据</div>}</div><form className="inline-form" onSubmit={createCredential}><label><span>Provider</span><select value={provider} onChange={(event) => setProvider(event.target.value as Credential['provider'])}><option value="codex">Codex</option><option value="github">GitHub</option><option value="mcp">MCP</option></select></label><label><span>外部引用</span><input value={externalRef} onChange={(event) => setExternalRef(event.target.value)} placeholder="不透明引用" /></label><button className="button primary" disabled={busy === 'credential-create'}><Plus size={15} />创建</button></form></section><section className="panel"><SectionTitle title="重新绑定 / 轮换" meta="证明仅使用一次" /><label className="field-block"><span>Provider 证明</span><input type="password" autoComplete="new-password" value={credentialProof} onChange={(event) => setCredentialProof(event.target.value)} /></label><p className="muted-copy">输入证明后选择凭据操作。</p></section></div>;
}

function ProfilesView({ profiles, provider, setProvider, profileLabel, setProfileLabel, profileCredentialId, setProfileCredentialId, credentials, createProfile, probeProfile, setProfileLifecycle, busy }: { profiles: Profile[]; provider: Profile['provider']; setProvider: (value: Profile['provider']) => void; profileLabel: string; setProfileLabel: (value: string) => void; profileCredentialId: string; setProfileCredentialId: (value: string) => void; credentials: Credential[]; createProfile: (event: FormEvent) => void; probeProfile: (profile: Profile) => void; setProfileLifecycle: (profile: Profile, next: 'enable' | 'disable') => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="Provider Profile" meta={`${profiles.length} 个 Profile`} /><div className="identity-list">{profiles.map((profile) => <div className="identity-row" key={profile.id}><span><strong>{profile.label}</strong><small>{profile.provider} · r{profile.revision}</small></span><StatusPill value={profile.lifecycle_status === 'disabled' ? 'disabled' : profile.status} /><div className="row-actions"><button className="icon-button" title="探测" aria-label={`探测 ${profile.label}`} disabled={busy === `probe-${profile.id}` || profile.status === 'probing' || profile.lifecycle_status === 'disabled'} onClick={() => probeProfile(profile)}><Activity size={15} /></button>{profile.lifecycle_status === 'disabled' ? <button className="icon-button" title="启用 Profile" aria-label={`启用 Profile：${profile.label}`} disabled={Boolean(busy)} onClick={() => setProfileLifecycle(profile, 'enable')}><Check size={15} /></button> : <button className="icon-button danger" title="禁用 Profile" aria-label={`禁用 Profile：${profile.label}`} disabled={Boolean(busy)} onClick={() => setProfileLifecycle(profile, 'disable')}><Ban size={14} /></button>}</div></div>)}{!profiles.length && <div className="list-empty">暂无 Profile</div>}</div></section><section className="panel"><SectionTitle title="新建 Profile" /><form className="identity-form" onSubmit={createProfile}><label><span>Provider</span><select value={provider} onChange={(event) => setProvider(event.target.value as Profile['provider'])}><option value="codex">Codex</option><option value="github">GitHub</option><option value="mcp">MCP</option></select></label><label><span>名称</span><input value={profileLabel} onChange={(event) => setProfileLabel(event.target.value)} required maxLength={160} /></label><label><span>凭据</span><select value={profileCredentialId} onChange={(event) => setProfileCredentialId(event.target.value)}><option value="">无</option>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.provider} · {credential.id.slice(-8)}</option>)}</select></label><button className="button primary" disabled={busy === 'profile-create'}><Plus size={15} />创建</button></form></section></div>;
}

type DiscoveryRecord = { id: string; label: string; model?: string; auth_type: string; credential_available: boolean };
type DiscoverySource = { id: string; source_hint: string; priority: number; source_revision: string; status: string; records: DiscoveryRecord[] };
type LoginState = { id: string; status: string; verification_uri?: string | null; user_code?: string | null; revision: number; error_code?: string | null };

function ProviderRecoveryPanel({ notify }: { notify: (text: string, tone?: 'ok' | 'error') => void }) {
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [operationRevision, setOperationRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const discover = useCallback(async () => {
    setLoading(true); setFailure('');
    try { const result = await apiV2<{ sources?: DiscoverySource[] }>('/api/v2/provider-discovery/codex'); setSources(result.data.sources || []); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Codex 发现不可用'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void discover(); }, [discover]);
  useEffect(() => {
    if (!login || ['completed', 'failed', 'cancelled', 'expired', 'interrupted'].includes(login.status)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const result = await apiV2<{ login: LoginState; operation?: { revision: number } }>(`/api/v2/provider-auth/codex/device-logins/${encodeURIComponent(login.id)}`);
        if (!active) return;
        setLogin(result.data.login); if (result.data.operation) setOperationRevision(result.data.operation.revision);
      } catch (error) { if (active) setFailure(error instanceof Error ? error.message : '设备登录状态不可用'); }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [login?.id, login?.status]);
  const importRecord = async (source: DiscoverySource, record: DiscoveryRecord) => {
    if (!record.credential_available || record.auth_type === 'keyring_only') { await startLogin(); return; }
    setLoading(true); setFailure('');
    try {
      await mutateV2('/api/v2/provider-discovery/codex/import', { source_id: source.id, source_revision: source.source_revision, record_id: record.id, confirmed: true, label: record.label, profile_label: record.label }, 'POST', 0);
      notify('主机 Codex Profile 已导入'); await discover();
    } catch (error) { setFailure(error instanceof Error ? error.message : 'Codex 导入失败'); notify('Codex 导入失败', 'error'); }
    finally { setLoading(false); }
  };
  const startLogin = async () => {
    setLoading(true); setFailure('');
    try {
      const result = await mutateV2<{ login: LoginState; operation: { revision: number } }>('/api/v2/provider-auth/codex/device-logins', { label: 'Codex Device Login' }, 'POST', 0);
      const data = result.data;
      if (data.login) { setLogin(data.login); setOperationRevision(data.operation?.revision || null); }
      else { setFailure('设备登录回执不完整'); }
    } catch (error) { setFailure(error instanceof Error ? error.message : '设备登录失败'); }
    finally { setLoading(false); }
  };
  const cancelLogin = async () => {
    if (!login || operationRevision == null) return;
    setLoading(true);
    try { const result = await mutateV2<{ login: LoginState; operation: { revision: number } }>(`/api/v2/provider-auth/codex/device-logins/${encodeURIComponent(login.id)}/cancel`, { reason: 'user_cancelled' }, 'POST', operationRevision); setLogin(result.data.login); setOperationRevision(result.data.operation.revision); }
    catch (error) { setFailure(error instanceof Error ? error.message : '取消设备登录失败'); }
    finally { setLoading(false); }
  };
  return <section className="panel provider-recovery-panel"><SectionTitle title="Codex 访问恢复" meta="主机发现与 ChatGPT 设备登录" action={<button className="icon-button" aria-label="刷新 Codex 发现" title="刷新" onClick={() => void discover()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={15} /></button>} /><div className="discovery-list">{sources.map((source) => <div className="discovery-source" key={source.id}><div className="discovery-source-head"><span><strong>{source.source_hint}</strong><small>优先级 {source.priority} · {statusLabel(source.status)}</small></span><StatusPill value={source.status} /></div>{source.records.map((record) => <div className="discovery-record" key={record.id}><span><strong>{record.model || record.label}</strong><small>{authTypeLabel(record.auth_type)}</small></span><button className="button" disabled={loading || record.auth_type === 'none'} onClick={() => void importRecord(source, record)}>{record.auth_type === 'keyring_only' ? '设备登录' : '导入'}</button></div>)}</div>)}{!sources.length && <div className="list-empty">未发现主机 Codex Profile</div>}</div>{login && <div className="device-login-status"><StatusPill value={login.status} />{login.user_code && <code>{login.user_code}</code>}{login.verification_uri && <a className="button" href={login.verification_uri} target="_blank" rel="noreferrer">打开授权页</a>}{!['completed', 'failed', 'cancelled', 'expired', 'interrupted'].includes(login.status) && <button className="icon-button" aria-label="取消设备登录" title="取消" onClick={() => void cancelLogin()}><X size={15} /></button>}</div>}{!login && <button className="button" onClick={() => void startLogin()} disabled={loading}><ShieldCheck size={15} />启动设备登录</button>}{failure && <div className="state-banner error" role="alert">{failure}</div>}</section>;
}

function SessionsView({ sessions, createSession, revokeSession, busy }: { sessions: Session[]; createSession: () => void; revokeSession: (session: Session) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="浏览器会话" meta={`${sessions.length} 个会话`} action={<button className="button primary" onClick={createSession} disabled={busy === 'session-create'}><Plus size={15} />新建会话</button>} /><div className="identity-list">{sessions.map((session) => <div className="identity-row" key={session.id}><span><strong>{statusLabel(session.status)}</strong><small className="mono">{session.id} · 到期 {session.expires_at} · r{session.revision}</small></span><StatusPill value={session.status} />{session.status === 'active' && <button className="icon-button danger" title="撤销会话" aria-label={`撤销会话 ${session.id}`} onClick={() => revokeSession(session)} disabled={busy === `session-revoke-${session.id}`}><Ban size={15} /></button>}</div>)}{!sessions.length && <div className="list-empty">暂无会话</div>}</div></section><section className="panel"><SectionTitle title="会话恢复" /><p className="muted-copy">通过本地系统配置边界签发新的同源浏览器会话。</p></section></div>;
}

export default IdentityAccessPage;
