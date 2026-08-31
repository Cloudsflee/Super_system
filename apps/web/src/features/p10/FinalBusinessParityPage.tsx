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
import { dimensionLabel, fieldLabel, modeLabel, statusLabel } from '../../i18n';

type Profile = { id: string; label: string; provider: string; status: string; lifecycle_status?: 'enabled' | 'disabled'; revision: number; credential_ref_id?: string | null; config?: Record<string, unknown> };
type Credential = { id: string; provider: string; status: string; revision: number };
type Template = { id: string; name: string; description: string; status: string; current_revision: number; revision: number; content: Record<string, unknown>; content_sha256?: string };
type Intent = { id: string; status: string; revision: number; target_name?: string; target_full_name?: string; expected_head_sha?: string; blockers?: Array<{ domain: string; count: number }> };
type Session = { id: string; title?: string; mode?: string; status: string; revision: number; pinned_at?: string | null; archived_at?: string | null; deleted_at?: string | null };
type QualityReadiness = { readiness?: { ready: boolean; checks: Record<string, string> }; policy?: { workflow_id?: string; revision?: number; threshold?: number; reviewer_profile_id?: string | null; rubric?: { schema_version?: string; dimensions?: Array<{ key: string; label?: string; enabled?: boolean; weight: number; description?: string }>; threshold?: number } } };
type RepositoryTarget = { id: string; connection_id: string; name: string; branch: string; remote_ref: string; expected_head_sha: string; revision: number; source_locator: string };

const tabs = [
  { id: 'provider', label: 'Provider', icon: Settings2 },
  { id: 'brief', label: 'Brief 模板', icon: Archive },
  { id: 'project-delete', label: '项目删除', icon: Trash2 },
  { id: 'repository-delete', label: '代码仓库删除', icon: GitBranch },
  { id: 'assist', label: 'Assist 生命周期', icon: MessageSquare },
  { id: 'quality', label: '质量就绪', icon: ShieldCheck }
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
    const message = caught instanceof ApiError ? `${caught.code}: ${caught.message}` : caught instanceof Error ? caught.message : '项目控制请求失败';
    setError(message);
  }


  return <div className="page p10-governance-page">
    <div className="page-heading">
       <div><p className="eyebrow">高级管理</p><h1>项目控制</h1><p className="muted-copy">针对所选项目的修订绑定业务控制。</p></div>
       <button className="icon-button" title="刷新治理工作区" aria-label="刷新治理工作区" onClick={() => void load()}><RefreshCw size={16} /></button>
    </div>
    {error && <div className="state-banner error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    <div className="p10-layout">
       <aside className="panel p10-tabs" aria-label="项目控制分区">
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
   if (!profile) return <section className="panel p10-panel"><PanelHeader icon={<Settings2 size={18} />} title="Provider Profile" detail="尚未绑定 Profile。" /><button className="button primary" onClick={() => navigate('identity')}><Plus size={15} />创建 Profile</button></section>;
  const availableCredentials = credentials.filter((credential) => credential.provider === profile.provider && credential.status === 'active');
   return <section className="panel p10-panel"><PanelHeader icon={<Settings2 size={18} />} title="Provider Profile" detail={`${profile.provider} · 修订 ${profile.revision}`} /><label><span>Profile</span><select value={profile.id} onChange={(event) => setSelectedId(event.target.value)}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.provider}</option>)}</select></label><div className="p10-profile-row"><div><strong>{profile.label}</strong><small>{statusLabel(profile.status)} · {statusLabel(profile.lifecycle_status || 'enabled')} · {shortHash(profile.id)}</small></div><span className={`status ${profile.lifecycle_status === 'disabled' ? 'negative' : profile.status === 'available' ? 'positive' : 'working'}`}><span />{statusLabel(profile.lifecycle_status === 'disabled' ? 'disabled' : profile.status)}</span></div><div className="two-column"><label><span>Profile 名称</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} /></label><label><span>凭据</span><select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">未绑定</option>{availableCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.provider} · {shortHash(credential.id)}</option>)}</select></label></div><label><span>Profile 配置</span><textarea rows={5} spellCheck={false} value={config} onChange={(event) => setConfig(event.target.value)} /></label>{!parsedConfig && <div className="state-banner error" role="alert">Profile 配置无效。</div>}<div className="p10-actions"><button className="button primary" disabled={!label.trim() || !parsedConfig || busy === 'profile-update'} onClick={() => void run('profile-update', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}`, { label, config: parsedConfig, ...(credentialId ? { credential_ref_id: credentialId } : {}) }, 'PATCH', profile.revision), 'Profile 已更新')}><Save size={15} />保存</button><button className="button" disabled={profile.lifecycle_status === 'disabled' || busy === 'profile-probe'} onClick={() => void run('profile-probe', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/probe`, {}, 'POST', profile.revision), 'Profile 已探测')}><Activity size={15} />探测</button>{profile.provider === 'github' && <button className="button" disabled={profile.lifecycle_status === 'disabled' || busy === 'profile-discovery'} onClick={() => void run('profile-discovery', async () => { const response = await apiV2<{ repositories: typeof repositories }>(`/api/v2/provider-profiles/${encodeURIComponent(profile.id)}/repositories`); setRepositories(response.data.repositories || []); }, '代码仓库已发现')}><Search size={15} />发现仓库</button>}{profile.lifecycle_status === 'disabled' ? <button className="button" disabled={busy === 'profile-enable'} onClick={() => void run('profile-enable', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/enable`, {}, 'POST', profile.revision), 'Profile 已启用')}><Check size={15} />启用</button> : <button className="button" disabled={busy === 'profile-disable'} onClick={() => void run('profile-disable', () => mutateV2(`/api/v2/profiles/${encodeURIComponent(profile.id)}/disable`, {}, 'POST', profile.revision), 'Profile 已禁用')}><CircleAlert size={15} />禁用</button>}</div>{repositories.length > 0 && <div className="p10-repository-list">{repositories.map((repository) => <div key={repository.id}><GitBranch size={14} /><span><strong>{repository.full_name}</strong><small>{repository.default_branch || 'main'} · {repository.private ? '私有' : '公开'}</small></span></div>)}</div>}</section>;
}

function TemplatePanel({ templates, projectId, teamId, busy, run }: { templates: Template[]; projectId: string; teamId: string; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState('new');
  const [name, setName] = useState('');
  const [content, setContent] = useState('{"sections":["objective","acceptance"]}');
  const template = templates.find((item) => item.id === selectedId) || null;
  useEffect(() => { setSelectedId((current) => templates.some((item) => item.id === current) ? current : templates[0]?.id || 'new'); }, [templates]);
  useEffect(() => { setName(template?.name || ''); if (template?.content) setContent(JSON.stringify(template.content, null, 2)); }, [template?.id, template?.revision]);
  const parsed = useMemo(() => { try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; } }, [content]);
  return <section className="panel p10-panel"><PanelHeader icon={<Archive size={18} />} title="Brief 模板" detail={template ? `模板修订 ${template.current_revision} · 记录 ${template.revision}` : '新建模板'} /><div className="form-stack"><label><span>模板</span><select value={template?.id || 'new'} onChange={(event) => setSelectedId(event.target.value)}><option value="new">新建模板</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name} · r{item.current_revision}</option>)}</select></label><label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder="交付 Brief" /></label><label><span>模板 JSON</span><textarea value={content} onChange={(event) => setContent(event.target.value)} rows={8} spellCheck={false} /></label>{!parsed && <div className="state-banner error" role="alert">模板 JSON 无效。</div>}<div className="p10-actions">{template ? <><button className="button primary" disabled={!name.trim() || !parsed || busy === 'template-update'} onClick={() => void run('template-update', () => mutateV2(`/api/v2/brief-templates/${encodeURIComponent(template.id)}`, { name, content: parsed }, 'PATCH', template.revision), '模板修订已创建')}><Save size={15} />保存修订</button><button className="button" disabled={busy === 'template-archive'} onClick={() => void run('template-archive', () => mutateV2(`/api/v2/brief-templates/${encodeURIComponent(template.id)}/archive`, {}, 'POST', template.revision), '模板已归档')}><Archive size={15} />归档</button></> : <button className="button primary" disabled={!projectId || !teamId || !name.trim() || !parsed || busy === 'template-create'} onClick={() => void run('template-create', () => mutateV2('/api/v2/brief-templates', { team_id: teamId, name, content: parsed }, 'POST', 0), '模板已创建')}><Plus size={15} />创建模板</button>}</div></div></section>;
}

function ProjectDeletionPanel({ projectId, revision, intent, setIntent, busy, run }: { projectId: string; revision: number; intent: Intent | null; setIntent: (value: Intent | null) => void; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  return <section className="panel p10-panel"><PanelHeader icon={<Trash2 size={18} />} title="项目删除" detail="绑定修订的封存操作，并重新检查阻塞项" /><label><span>确认项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入完整项目名称" /></label><div className="p10-actions"><button className="button" disabled={!name.trim() || busy === 'project-prepare'} onClick={() => void run('project-prepare', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/projects/${encodeURIComponent(projectId)}/deletion-intents`, { target_name: name }, 'POST', revision); setIntent(result.data.intent); setLoaded(true); }, '删除意图已准备')}><ShieldCheck size={15} />准备</button>{intent && <><button className="button" disabled={busy === 'project-confirm' || !['prepared', 'blocked'].includes(intent.status)} onClick={() => void run('project-confirm', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(intent.id)}/confirm`, { target_name: name }, 'POST', intent.revision); setIntent(result.data.intent); }, '确认已记录')}><Check size={15} />确认</button><button className="button primary" disabled={busy === 'project-execute' || intent.status !== 'ready'} onClick={() => void run('project-execute', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(intent.id)}/execute`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, '项目已封存')}><Trash2 size={15} />执行</button><button className="button" disabled={busy === 'project-cancel' || ['executing', 'completed', 'cancelled'].includes(intent.status)} onClick={() => void run('project-cancel', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(intent.id)}/cancel`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, '删除意图已取消')}><XCircle size={15} />取消</button></>}</div>{loaded && intent && <IntentStatus intent={intent} />}</section>;
}

function RepositoryDeletionPanel({ targets, actorRevision, intent, setIntent, busy, run }: { targets: RepositoryTarget[]; actorRevision: number; intent: Intent | null; setIntent: (value: Intent | null) => void; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [targetId, setTargetId] = useState('');
  const [fullName, setFullName] = useState('');
  const [head, setHead] = useState('');
  const target = targets.find((item) => item.id === targetId) || targets[0] || null;
  useEffect(() => { setTargetId((current) => targets.some((item) => item.id === current) ? current : targets[0]?.id || ''); }, [targets]);
  useEffect(() => { if (!target) return; const candidate = [target.remote_ref, target.source_locator, target.name].find((value) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)); setFullName(candidate || ''); setHead(target.expected_head_sha || ''); setIntent(null); }, [target?.id]);
  return <section className="panel p10-panel"><PanelHeader icon={<GitBranch size={18} />} title="代码仓库删除" detail="完整名称、HEAD、目标修订和两次会话证明" />{target ? <><label><span>代码仓库目标</span><select value={target.id} onChange={(event) => setTargetId(event.target.value)}>{targets.map((item) => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}</select></label><div className="two-column"><label><span>完整名称</span><input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="owner/repository" /></label><label><span>预期 HEAD</span><input className="mono" value={head} onChange={(event) => setHead(event.target.value)} maxLength={128} /></label></div><div className="p10-actions"><button className="button" disabled={!fullName || !head || busy === 'repository-prepare'} onClick={() => void run('repository-prepare', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-targets/${encodeURIComponent(target.id)}/deletion-intents`, { target_full_name: fullName, expected_head_sha: head }, 'POST', target.revision); setIntent(result.data.intent); }, '代码仓库删除意图已准备')}><ShieldCheck size={15} />准备</button>{intent && <><button className="button" disabled={busy === 'repository-creator' || intent.status !== 'prepared'} onClick={() => void run('repository-creator', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/creator-confirm`, { target_full_name: fullName, expected_head_sha: head }, 'POST', intent.revision); setIntent(result.data.intent); }, '创建者证明已记录')}><Check size={15} />创建者证明</button><button className="button" disabled={busy === 'repository-owner' || intent.status !== 'creator_confirmed'} onClick={() => void run('repository-owner', async () => { await mutateV2('/api/v2/sessions', { ttl_seconds: 3600 }, 'POST', actorRevision); const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/owner-confirm`, { target_full_name: fullName, expected_head_sha: head }, 'POST', intent.revision); setIntent(result.data.intent); }, '独立所有者证明已记录')}><ShieldCheck size={15} />所有者证明</button><button className="button primary" disabled={busy === 'repository-execute' || intent.status !== 'ready'} onClick={() => void run('repository-execute', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/execute`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, '已请求删除代码仓库')}><Trash2 size={15} />执行</button>{['needs_reconcile', 'failed'].includes(intent.status) && <button className="button" disabled={busy === 'repository-reconcile'} onClick={() => void run('repository-reconcile', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/reconcile`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, '代码仓库状态已对账')}><RotateCw size={15} />对账</button>}<button className="button" disabled={busy === 'repository-cancel' || ['executing', 'completed', 'cancelled'].includes(intent.status)} onClick={() => void run('repository-cancel', async () => { const result = await mutateV2<{ intent: Intent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(intent.id)}/cancel`, {}, 'POST', intent.revision); setIntent(result.data.intent); }, '代码仓库删除意图已取消')}><XCircle size={15} />取消</button></>}</div>{intent && <IntentStatus intent={intent} />}</> : <p className="list-empty">暂无代码仓库目标</p>}</section>;
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
  if (!session) return <section className="panel p10-panel"><PanelHeader icon={<MessageSquare size={18} />} title="Assist 生命周期" detail="当前项目暂无会话" /></section>;
  return <section className="panel p10-panel"><PanelHeader icon={<MessageSquare size={18} />} title={session.title || 'Assist 会话'} detail={`${modeLabel(session.mode || 'guided')} · 修订 ${session.revision}`} /><label><span>会话</span><select value={session.id} onChange={(event) => setSelectedId(event.target.value)}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title || shortHash(item.id)} · {statusLabel(item.status)}</option>)}</select></label><div className="p10-profile-row"><div><strong>{shortHash(session.id)}</strong><small>{statusLabel(session.status)}{session.pinned_at ? ' · 已置顶' : ''}{session.archived_at ? ' · 已归档' : ''}{session.deleted_at ? ' · 已删除' : ''}</small></div><span className="status neutral"><span />{statusLabel(session.status)}</span></div><div className="two-column"><label><span>会话标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} /></label><label><span>会话模式</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="guided">引导模式</option><option value="agent">代理模式</option><option value="side_thread">旁支线程</option></select></label></div><label className="p10-toggle"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span>置顶会话</span></label><div className="p10-actions"><button className="button primary" disabled={busy === 'assist-metadata'} onClick={() => void run('assist-metadata', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}`, { title, mode, pinned }, 'PATCH', session.revision), 'Assist 元数据已更新')}><Save size={15} />保存元数据</button><button className="button" disabled={busy === 'assist-fork' || Boolean(session.deleted_at)} onClick={() => void run('assist-fork', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/fork`, { title: `由 ${title || shortHash(session.id)} 分叉` }, 'POST', session.revision), 'Assist 分叉已创建')}><GitBranch size={15} />分叉</button><button className="button" disabled={busy === 'assist-side' || Boolean(session.deleted_at)} onClick={() => void run('assist-side', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/side-threads`, { title: `${title || shortHash(session.id)} 的旁支线程` }, 'POST', session.revision), '旁支线程已创建')}><MessageSquare size={15} />旁支线程</button></div><label><span>配置修订</span><textarea rows={5} spellCheck={false} value={configuration} onChange={(event) => setConfiguration(event.target.value)} /></label>{!parsedConfiguration && <div className="state-banner error" role="alert">Assist 配置无效。</div>}<div className="p10-actions"><button className="button" disabled={!parsedConfiguration || busy === 'assist-configuration'} onClick={() => void run('assist-configuration', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/configurations`, { configuration: parsedConfiguration }, 'POST', session.revision), 'Assist 配置已记录')}><Plus size={15} />记录配置</button><button className="button" disabled={busy === 'assist-archive' || Boolean(session.archived_at)} onClick={() => void run('assist-archive', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/archive`, {}, 'POST', session.revision), 'Assist 会话已归档')}><Archive size={15} />归档</button><button className="button" disabled={busy === 'assist-restore' || !session.archived_at || Boolean(session.deleted_at)} onClick={() => void run('assist-restore', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/restore`, {}, 'POST', session.revision), 'Assist 会话已恢复')}><Undo2 size={15} />恢复</button><button className="button" disabled={busy === 'assist-delete' || Boolean(session.deleted_at)} onClick={() => void run('assist-delete', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/delete`, {}, 'POST', session.revision), 'Assist 会话已删除')}><Trash2 size={15} />删除</button><button className="button" disabled={busy === 'assist-restore-deleted' || !session.deleted_at} onClick={() => void run('assist-restore-deleted', () => mutateV2(`/api/v2/assist/sessions/${encodeURIComponent(session.id)}/restore-deleted`, {}, 'POST', session.revision), '已删除的 Assist 会话已恢复')}><Undo2 size={15} />恢复已删除</button></div></section>;
}

function QualityPanel({ quality, profiles, busy, run }: { quality: QualityReadiness | null; profiles: Profile[]; busy: string; run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const dimensions = quality?.policy?.rubric?.dimensions || [];
  const [threshold, setThreshold] = useState(80);
  const [reviewerId, setReviewerId] = useState('');
  useEffect(() => { setThreshold(Number(quality?.policy?.threshold ?? quality?.policy?.rubric?.threshold ?? 80)); setReviewerId(quality?.policy?.reviewer_profile_id || ''); }, [quality?.policy?.workflow_id, quality?.policy?.revision]);
  const reviewers = profiles.filter((profile) => profile.provider === 'codex' && profile.status === 'available' && profile.lifecycle_status !== 'disabled');
  return <section className="panel p10-panel"><PanelHeader icon={<ShieldCheck size={18} />} title="质量就绪" detail="策略、选择、建议和人工评分彼此独立" />{quality ? <><div className="p10-readiness"><span className={`status ${quality.readiness?.ready ? 'positive' : 'negative'}`}><span />{quality.readiness?.ready ? '已就绪' : '已阻塞'}</span>{Object.entries(quality.readiness?.checks || {}).map(([key, value]) => <span key={key} className="p10-check"><strong>{fieldLabel(key)}</strong>{statusLabel(value)}</span>)}</div><div className="p10-dimensions">{dimensions.map((dimension) => <span key={dimension.key}><Check size={13} />{dimensionLabel(dimension.key)}<small>{dimension.weight}%</small></span>)}</div>{quality.policy?.workflow_id && <><div className="two-column"><label><span>批准阈值</span><input type="number" min="0" max="100" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label><label><span>建议审阅者</span><select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">不使用模型建议</option>{reviewers.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label></div><div className="p10-actions"><button className="button primary" disabled={!dimensions.length || busy === 'quality-policy'} onClick={() => void run('quality-policy', () => mutateV2(`/api/v2/workflows/${encodeURIComponent(quality.policy!.workflow_id!)}/quality-policy`, { rubric: { schema_version: quality.policy?.rubric?.schema_version || 'quality.rubric.v1', dimensions: dimensions.map((dimension) => ({ key: dimension.key, label: dimension.label || dimension.key, enabled: dimension.enabled !== false, weight: dimension.weight, description: dimension.description || '' })), threshold }, ...(reviewerId ? { reviewer_profile_id: reviewerId } : {}) }, 'PUT', Number(quality.policy?.revision || 0)), '质量策略已更新')}><Save size={15} />保存策略</button></div></>}</> : <p className="list-empty">暂无执行</p>}</section>;
}

function IntentStatus({ intent }: { intent: Intent }) { return <div className="p10-intent-status"><span className={`status ${['ready','completed'].includes(intent.status) ? 'positive' : intent.status === 'blocked' ? 'negative' : 'working'}`}><span />{statusLabel(intent.status)}</span><span className="mono">r{intent.revision}</span>{intent.blockers?.map((blocker) => <span key={blocker.domain} className="p10-blocker">{fieldLabel(blocker.domain)}：{blocker.count}</span>)}</div>; }
function PanelHeader({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="section-title"><div className="p10-panel-title"><span className="p10-title-icon">{icon}</span><div><h2>{title}</h2><span>{detail}</span></div></div></div>; }
