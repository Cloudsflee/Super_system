import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Check, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw,
  RotateCw, Save, ShieldCheck, Users, UserRound, X
} from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Actor = { id: string; kind: 'system' | 'user' | 'service' | 'agent'; display_name: string; status: string; revision: number };
type Team = { id: string; name: string; status: string; revision: number };
type Membership = { id: string; team_id?: string; project_id?: string; actor_id: string; role: string; status: string; revision: number; actor?: { display_name?: string; kind?: string } };
type Credential = { id: string; provider: 'codex' | 'github' | 'mcp'; status: string; external_ref: string; revision: number };
type Profile = { id: string; provider: 'codex' | 'github' | 'mcp'; label: string; status: string; revision: number; credential_ref_id?: string | null };
type Account = Actor & { metadata?: Record<string, unknown> };
type AclEntry = { id: string; project_id: string; principal_actor_id?: string | null; principal_team_id?: string | null; resource: string; action: string; effect: 'allow' | 'deny'; policy_revision: number; revision: number };
type View = 'identity' | 'teams' | 'members' | 'permissions' | 'credentials' | 'profiles';
type LoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'error';

const views: Array<{ id: View; label: string; icon: typeof Users }> = [
  { id: 'identity', label: 'Identity', icon: UserRound },
  { id: 'teams', label: 'Teams', icon: Users },
  { id: 'members', label: 'Members', icon: ShieldCheck },
  { id: 'permissions', label: 'Permissions', icon: LockKeyhole },
  { id: 'credentials', label: 'Credentials', icon: KeyRound },
  { id: 'profiles', label: 'Profiles', icon: Activity }
];

function StatusPill({ value }: { value: string }) {
  const positive = ['active', 'available', 'accepted', 'owner'].includes(value);
  const negative = ['revoked', 'failed', 'denied', 'unavailable'].includes(value);
  return <span className={`status ${positive ? 'positive' : negative ? 'negative' : 'neutral'}`}><span />{value.replaceAll('_', ' ')}</span>;
}

function SectionTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

export function IdentityAccessPage({ setupReady, notify, projectId }: WorkspacePageProps) {
  const [view, setView] = useState<View>('identity');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
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
      const [accountResult, actorsResult, teamsResult, credentialsResult, profilesResult] = await Promise.all([
        apiV2<{ account: Account }>('/api/v2/account'),
        apiV2<{ actors: Actor[] }>('/api/v2/actors'),
        apiV2<{ teams: Team[] }>('/api/v2/teams'),
        apiV2<{ credentials: Credential[] }>('/api/v2/credentials'),
        apiV2<{ profiles: Profile[] }>('/api/v2/profiles')
      ]);
      const nextAccount = accountResult.data.account;
      const nextTeams = teamsResult.data.teams || [];
      setAccount(nextAccount);
      setDisplayName(nextAccount.display_name);
      setActors(actorsResult.data.actors || []);
      setTeams(nextTeams);
      setCredentials(credentialsResult.data.credentials || []);
      setProfiles(profilesResult.data.profiles || []);
      setSelectedTeamId((current) => nextTeams.some((team) => team.id === current) ? current : (nextTeams[0]?.id || ''));
      setLoadState(nextAccount || nextTeams.length ? 'ready' : 'empty');
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) setLoadState('denied');
      else setLoadState('error');
      setFailure(error instanceof Error ? error.message : 'Request failed');
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
      if (error instanceof ApiError && [401, 403].includes(error.status)) setFailure('Permission denied');
      else setFailure(error instanceof Error ? error.message : 'Request failed');
    }
  }, [selectedTeamId, setupReady]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadMembers(); }, [loadMembers]);
  useEffect(() => {
    if (!permissionProjectId && projectId) setPermissionProjectId(projectId);
  }, [permissionProjectId, projectId]);

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
      setPermissionFailure(error instanceof Error ? error.message : 'Permission request failed');
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
      } else setFailure(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy('');
    }
  }, [load, loadMembers]);

  const saveAccount = (event: FormEvent) => {
    event.preventDefault();
    if (!account) return;
    void run('account', async () => {
      await mutateV2('/api/v2/account', { display_name: displayName }, 'PATCH', account.revision);
      notify('Account updated');
    });
  };

  const createTeam = (event: FormEvent) => {
    event.preventDefault();
    void run('team-create', async () => {
      await mutateV2('/api/v2/teams', { name: teamName }, 'POST', 0);
      setTeamName('');
      notify('Team created');
    });
  };

  const createActor = (event: FormEvent) => {
    event.preventDefault();
    void run('actor-create', async () => {
      await mutateV2('/api/v2/actors', { kind: 'service', display_name: actorName, metadata: {} }, 'POST', 0);
      setActorName('');
      notify('Actor created');
    });
  };

  const grantMember = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTeamId) return;
    void run('member-grant', async () => {
      const teamRevision = teams.find((team) => team.id === selectedTeamId)?.revision ?? 0;
      await mutateV2(`/api/v2/teams/${encodeURIComponent(selectedTeamId)}/memberships`, { actor_id: memberActorId, role: memberRole }, 'POST', teamRevision);
      setMemberActorId('');
      notify('Membership granted');
    });
  };

  const createCredential = (event: FormEvent) => {
    event.preventDefault();
    void run('credential-create', async () => {
      await mutateV2('/api/v2/credentials', { provider, external_ref: externalRef, scope: {} }, 'POST', 0);
      setExternalRef('');
      notify('Credential metadata created');
    });
  };

  const rebind = (credential: Credential) => {
    void run(`rebind-${credential.id}`, async () => {
      const result = await mutateV2(`/api/v2/credentials/${encodeURIComponent(credential.id)}/rebind`, { proof: credentialProof }, 'POST', credential.revision);
      setCredentialProof('');
      setRebindRequired(null);
      if (result.data) notify('Credential rebind queued');
    });
  };

  const createProfile = (event: FormEvent) => {
    event.preventDefault();
    void run('profile-create', async () => {
      await mutateV2('/api/v2/profiles', { provider, label: profileLabel, credential_ref_id: profileCredentialId || undefined }, 'POST', 0);
      setProfileLabel('');
      notify('Profile created');
    });
  };

  const probeProfile = (profile: Profile) => {
    void run(`probe-${profile.id}`, async () => {
      await mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/probe`, {}, 'POST', profile.revision);
      notify('Profile probe queued');
    });
  };

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
      notify(permissionEffect === 'deny' ? 'Permission deny saved' : 'Permission allow saved');
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

  if (loadState === 'loading') return <div className="page-loader" data-testid="identity-loading"><LoaderCircle className="spin" size={18} />Loading identity</div>;
  if (loadState === 'denied') return <div className="page identity-page"><div className="state-banner denied" data-testid="identity-denied"><LockKeyhole size={20} /><div><strong>Access denied</strong><span>{failure || 'Permission denied'}</span></div><button className="icon-button" title="Retry" aria-label="Retry" onClick={() => void load()}><RefreshCw size={16} /></button></div></div>;
  if (!setupReady || loadState === 'empty') return <div className="page identity-page"><div className="empty-state" data-testid="identity-empty"><Users size={30} /><h2>{setupReady ? 'No identity records' : 'Setup required'}</h2><button className="button" onClick={() => void load()}><RefreshCw size={15} />Refresh</button></div></div>;

  return <div className="page identity-page">
    <div className="page-heading"><div><p className="eyebrow">Access control</p><h1>Identity and teams</h1></div><button className="icon-button" title="Refresh" aria-label="Refresh" disabled={busy !== ''} onClick={() => void load()}><RefreshCw className={busy ? 'spin' : ''} size={17} /></button></div>
    {failure && <div className="state-banner error" role="alert"><AlertTriangle size={18} /><span>{failure}</span><button className="icon-button" title="Dismiss" aria-label="Dismiss" onClick={() => setFailure('')}><X size={15} /></button></div>}
    {conflictRevision != null && <div className="state-banner conflict" data-testid="identity-conflict"><AlertTriangle size={18} /><span>Revision changed to r{conflictRevision}. Refresh before retrying.</span><button className="button" onClick={() => { setConflictRevision(null); void load(); }}>Refresh</button></div>}
    {rebindRequired && <div className="state-banner rebind" data-testid="identity-rebind"><KeyRound size={18} /><span>Credential rebind required: {rebindRequired}</span><button className="button" onClick={() => setView('credentials')}>Open credentials</button></div>}
    <div className="identity-tabs" role="tablist" aria-label="Identity views">{views.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}><Icon size={15} />{label}</button>)}</div>
    {view === 'identity' && <IdentityView account={account} displayName={displayName} setDisplayName={setDisplayName} saveAccount={saveAccount} busy={busy} />}
    {view === 'teams' && <TeamsView teams={teams} selectedTeamId={selectedTeamId} setSelectedTeamId={setSelectedTeamId} teamName={teamName} setTeamName={setTeamName} createTeam={createTeam} actorName={actorName} setActorName={setActorName} createActor={createActor} busy={busy} />}
    {view === 'members' && <MembersView teams={teams} selectedTeamId={selectedTeamId} setSelectedTeamId={setSelectedTeamId} memberships={memberships} actors={actorOptions} memberActorId={memberActorId} setMemberActorId={setMemberActorId} memberRole={memberRole} setMemberRole={setMemberRole} grantMember={grantMember} busy={busy} />}
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
    {view === 'credentials' && <CredentialsView credentials={credentials} provider={provider} setProvider={setProvider} externalRef={externalRef} setExternalRef={setExternalRef} createCredential={createCredential} credentialProof={credentialProof} setCredentialProof={setCredentialProof} rebind={rebind} busy={busy} />}
    {view === 'profiles' && <ProfilesView profiles={profiles} provider={provider} setProvider={setProvider} profileLabel={profileLabel} setProfileLabel={setProfileLabel} profileCredentialId={profileCredentialId} setProfileCredentialId={setProfileCredentialId} credentials={credentials} createProfile={createProfile} probeProfile={probeProfile} busy={busy} />}
  </div>;
}

function IdentityView({ account, displayName, setDisplayName, saveAccount, busy }: { account: Account | null; displayName: string; setDisplayName: (value: string) => void; saveAccount: (event: FormEvent) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="Account" meta={account ? `r${account.revision}` : 'Unavailable'} /><form className="identity-form" onSubmit={saveAccount}><label><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={160} /></label><button className="button primary" disabled={busy === 'account'}>{busy === 'account' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Save</button></form></section><section className="panel"><SectionTitle title="Session subject" /><dl className="definition-list"><div><dt>Actor</dt><dd className="mono">{account?.id}</dd></div><div><dt>Kind</dt><dd>{account?.kind}</dd></div><div><dt>Status</dt><dd><StatusPill value={account?.status || 'unknown'} /></dd></div><div><dt>Revision</dt><dd>r{account?.revision || 0}</dd></div></dl></section></div>;
}

function TeamsView({ teams, selectedTeamId, setSelectedTeamId, teamName, setTeamName, createTeam, actorName, setActorName, createActor, busy }: { teams: Team[]; selectedTeamId: string; setSelectedTeamId: (value: string) => void; teamName: string; setTeamName: (value: string) => void; createTeam: (event: FormEvent) => void; actorName: string; setActorName: (value: string) => void; createActor: (event: FormEvent) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="Teams" meta={`${teams.length} visible`} /><div className="identity-list">{teams.map((team) => <button className={team.id === selectedTeamId ? 'identity-row selected' : 'identity-row'} key={team.id} onClick={() => setSelectedTeamId(team.id)}><span><strong>{team.name}</strong><small className="mono">{team.id} · r{team.revision}</small></span><StatusPill value={team.status} /></button>)}{!teams.length && <div className="list-empty">No teams</div>}</div><form className="inline-form" onSubmit={createTeam}><label><span>Team name</span><input value={teamName} onChange={(event) => setTeamName(event.target.value)} required maxLength={160} /></label><button className="button primary" disabled={busy === 'team-create'}><Plus size={15} />Create</button></form></section><section className="panel"><SectionTitle title="Actors" meta="Service and agent identities" /><div className="inline-form"><label><span>Display name</span><input value={actorName} onChange={(event) => setActorName(event.target.value)} placeholder="Service actor" /></label><button className="button" disabled={!actorName.trim() || busy === 'actor-create'} onClick={(event) => { event.preventDefault(); createActor(event); }}><Plus size={15} />Add actor</button></div></section></div>;
}

function MembersView({ teams, selectedTeamId, setSelectedTeamId, memberships, actors, memberActorId, setMemberActorId, memberRole, setMemberRole, grantMember, busy }: { teams: Team[]; selectedTeamId: string; setSelectedTeamId: (value: string) => void; memberships: Membership[]; actors: Actor[]; memberActorId: string; setMemberActorId: (value: string) => void; memberRole: string; setMemberRole: (value: string) => void; grantMember: (event: FormEvent) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="Team members" meta={selectedTeamId ? `Team ${selectedTeamId.slice(-8)}` : 'Select a team'} /><label className="field-block"><span>Team</span><select value={selectedTeamId} onChange={(event) => setSelectedTeamId(event.target.value)}><option value="">Select team</option>{teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><div className="identity-list">{memberships.map((member) => <div className="identity-row" key={member.id}><span><strong>{member.actor?.display_name || member.actor_id}</strong><small>{member.role} · r{member.revision}</small></span><StatusPill value={member.status} /></div>)}{!memberships.length && <div className="list-empty">No members</div>}</div></section><section className="panel"><SectionTitle title="Grant membership" /><form className="identity-form" onSubmit={grantMember}><label><span>Actor</span><select value={memberActorId} onChange={(event) => setMemberActorId(event.target.value)} required><option value="">Select actor</option>{actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.display_name} ({actor.kind})</option>)}</select></label><label><span>Role</span><select value={memberRole} onChange={(event) => setMemberRole(event.target.value)}><option value="member">Member</option><option value="admin">Admin</option><option value="observer">Observer</option></select></label><button className="button primary" disabled={!selectedTeamId || busy === 'member-grant'}><Check size={15} />Grant</button></form></section></div>;
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
      <SectionTitle title="Project permissions" meta={revision ? `Policy r${revision}` : 'Project scope'} action={<button className="icon-button" title="Reload permissions" aria-label="Reload permissions" onClick={onLoad} disabled={state === 'loading'}><RefreshCw className={state === 'loading' ? 'spin' : ''} size={16} /></button>} />
      <div className="inline-form permission-project-form">
        <label><span>Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="project reference" /></label>
        <button className="button" type="button" onClick={onLoad} disabled={!projectId.trim() || state === 'loading'}><Activity size={15} />Load</button>
      </div>
      {state === 'denied' && <div className="state-banner denied" data-testid="permissions-denied"><LockKeyhole size={18} /><span>{failure || 'Permission denied'}</span></div>}
      {state === 'error' && <div className="state-banner error" role="alert"><AlertTriangle size={18} /><span>{failure || 'Permission request failed'}</span></div>}
      {state === 'empty' && <div className="empty-state compact" data-testid="permissions-empty"><LockKeyhole size={24} /><h3>{projectId ? 'No ACL entries' : 'Select a project'}</h3><p className="muted-copy">{projectId ? 'Create an explicit allow or deny rule.' : 'A project reference is required before ACLs can be read.'}</p></div>}
      {state === 'loading' && <div className="page-loader compact" data-testid="permissions-loading"><LoaderCircle className="spin" size={17} />Loading permissions</div>}
      {entries.length > 0 && <div className="identity-list permission-list">{entries.map((entry) => <div className="identity-row" key={entry.id}><span><strong>{entry.effect.toUpperCase()} · {entry.action}</strong><small className="mono">{entry.principal_actor_id || entry.principal_team_id || 'unknown principal'} · {entry.resource} · r{entry.revision}</small></span><StatusPill value={entry.effect === 'allow' ? 'active' : 'denied'} /><button className="icon-button" title="Edit permission" aria-label={`Edit permission ${entry.id}`} onClick={() => edit(entry)}><Save size={14} /></button></div>)}</div>}
    </section>
    <section className="panel">
      <SectionTitle title={editId ? 'Edit rule' : 'Add rule'} meta="Explicit deny takes precedence" />
      <form className="identity-form" onSubmit={save}>
        <label><span>Principal type</span><select value={principalType} onChange={(event) => { const value = event.target.value as 'actor' | 'team'; setPrincipalType(value); setPrincipalId(''); }}><option value="actor">Actor</option><option value="team">Team</option></select></label>
        <label><span>Principal</span><select value={principalId} onChange={(event) => setPrincipalId(event.target.value)} required><option value="">Select principal</option>{principals.map((principal) => <option key={principal.id} value={principal.id}>{'display_name' in principal ? principal.display_name : principal.name}</option>)}</select></label>
        <label><span>Action</span><select value={action} onChange={(event) => setAction(event.target.value)}><option value="read">Read</option><option value="write">Write</option><option value="run">Run</option><option value="approve">Approve</option></select></label>
        <label><span>Resource</span><input value={resource} onChange={(event) => setResource(event.target.value)} maxLength={160} required /></label>
        <label><span>Effect</span><select value={effect} onChange={(event) => setEffect(event.target.value as 'allow' | 'deny')}><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <div className="form-actions"><button className="button primary" disabled={!projectId.trim() || !principalId || busy.startsWith('acl-')}><ShieldCheck size={15} />{busy.startsWith('acl-') ? 'Saving' : editId ? 'Save rule' : 'Add rule'}</button>{editId && <button className="button" type="button" onClick={() => edit({ id: '', project_id: projectId, resource: '*', action: 'read', effect: 'allow', policy_revision: revision, revision: 0 })}>Clear</button>}</div>
      </form>
    </section>
  </div>;
}

function CredentialsView({ credentials, provider, setProvider, externalRef, setExternalRef, createCredential, credentialProof, setCredentialProof, rebind, busy }: { credentials: Credential[]; provider: Credential['provider']; setProvider: (value: Credential['provider']) => void; externalRef: string; setExternalRef: (value: string) => void; createCredential: (event: FormEvent) => void; credentialProof: string; setCredentialProof: (value: string) => void; rebind: (credential: Credential) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="Credential metadata" meta={`${credentials.length} records`} /><div className="identity-list">{credentials.map((credential) => <div className="identity-row" key={credential.id}><span><strong>{credential.provider}</strong><small className="mono">{credential.external_ref} · r{credential.revision}</small></span><StatusPill value={credential.status} />{['rebind_required', 'failed'].includes(credential.status) && <button className="icon-button" title="Rebind" aria-label={`Rebind ${credential.id}`} onClick={() => rebind(credential)} disabled={!credentialProof || busy === `rebind-${credential.id}`}><RotateCw size={15} /></button>}</div>)}{!credentials.length && <div className="list-empty">No credentials</div>}</div><form className="inline-form" onSubmit={createCredential}><label><span>Provider</span><select value={provider} onChange={(event) => setProvider(event.target.value as Credential['provider'])}><option value="codex">Codex</option><option value="github">GitHub</option><option value="mcp">MCP</option></select></label><label><span>External reference</span><input value={externalRef} onChange={(event) => setExternalRef(event.target.value)} placeholder="opaque-ref" /></label><button className="button primary" disabled={busy === 'credential-create'}><Plus size={15} />Create</button></form></section><section className="panel"><SectionTitle title="Rebind" meta="Proof is used once" /><label className="field-block"><span>Provider proof</span><input type="password" autoComplete="new-password" value={credentialProof} onChange={(event) => setCredentialProof(event.target.value)} /></label><p className="muted-copy">Select a failed or rebind-required row after entering proof.</p></section></div>;
}

function ProfilesView({ profiles, provider, setProvider, profileLabel, setProfileLabel, profileCredentialId, setProfileCredentialId, credentials, createProfile, probeProfile, busy }: { profiles: Profile[]; provider: Profile['provider']; setProvider: (value: Profile['provider']) => void; profileLabel: string; setProfileLabel: (value: string) => void; profileCredentialId: string; setProfileCredentialId: (value: string) => void; credentials: Credential[]; createProfile: (event: FormEvent) => void; probeProfile: (profile: Profile) => void; busy: string }) {
  return <div className="identity-grid"><section className="panel"><SectionTitle title="Provider profiles" meta={`${profiles.length} profiles`} /><div className="identity-list">{profiles.map((profile) => <div className="identity-row" key={profile.id}><span><strong>{profile.label}</strong><small>{profile.provider} · r{profile.revision}</small></span><StatusPill value={profile.status} /><button className="icon-button" title="Probe" aria-label={`Probe ${profile.label}`} disabled={busy === `probe-${profile.id}` || profile.status === 'probing'} onClick={() => probeProfile(profile)}><Activity size={15} /></button></div>)}{!profiles.length && <div className="list-empty">No profiles</div>}</div></section><section className="panel"><SectionTitle title="New profile" /><form className="identity-form" onSubmit={createProfile}><label><span>Provider</span><select value={provider} onChange={(event) => setProvider(event.target.value as Profile['provider'])}><option value="codex">Codex</option><option value="github">GitHub</option><option value="mcp">MCP</option></select></label><label><span>Label</span><input value={profileLabel} onChange={(event) => setProfileLabel(event.target.value)} required maxLength={160} /></label><label><span>Credential</span><select value={profileCredentialId} onChange={(event) => setProfileCredentialId(event.target.value)}><option value="">None</option>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.provider} · {credential.id.slice(-8)}</option>)}</select></label><button className="button primary" disabled={busy === 'profile-create'}><Plus size={15} />Create</button></form></section></div>;
}

export default IdentityAccessPage;
