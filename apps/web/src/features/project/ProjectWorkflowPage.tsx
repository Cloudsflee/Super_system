import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle, Check, CircleAlert, GitBranch, LoaderCircle, Play, Plus, RefreshCw,
  RotateCcw, Save, ShieldAlert, Square, Workflow as WorkflowIcon
} from 'lucide-react';
import { ApiError, apiV2, mutateOfflineV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { WorkflowEditor } from './WorkflowEditor';
import { BriefEditor } from './BriefEditor';
import { GenerationTimeline } from './GenerationTimeline';
import { ExecutionLauncher } from './ExecutionLauncher';
import { OperationNotice } from './OperationNotice';
import { useProjectWorkflowData } from './useProjectWorkflowData';
import { useWorkbenchOnline, workbenchError } from './workbenchStatus';
import { parseWorkflowGraph, validateWorkflowGraph } from './workflowEditorModel';
import type { P3Project, RepositoryConnection, RepositoryTarget, RepositoryDeletionIntent, Generation, BriefDraft } from './workflowTypes';
import { commandLabel, errorCodeLabel, kindLabel, statusLabel } from '../../i18n';
import './workflow-workbench.css';

type Section = 'overview' | 'intake' | 'brief' | 'repository' | 'workflow';
type LoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'error';
const sections: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'intake', label: '来源接入' },
  { id: 'brief', label: 'Brief' },
  { id: 'repository', label: '代码仓库' },
  { id: 'workflow', label: '工作流' }
];

function Status({ value }: { value?: string }) {
  const status = value || 'unknown';
  const tone = ['ready', 'active', 'confirmed', 'applied', 'passed'].includes(status)
    ? 'positive' : ['queued', 'running', 'processing', 'critic_pending', 'proposed'].includes(status)
      ? 'working' : ['failed', 'cancelled', 'rejected', 'stale', 'faulted', 'archived'].includes(status) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{statusLabel(status)}</span>;
}

function PanelTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

function ErrorState({ state, message, onRetry }: { state: LoadState; message: string; onRetry: () => void }) {
  if (state === 'denied') return <div className="state-banner denied" data-testid="project-workflow-denied"><ShieldAlert size={18} /><span>{message || '没有项目访问权限'}</span></div>;
  if (state === 'error') return <div className="state-banner error" role="alert"><CircleAlert size={18} /><span>{message || '项目请求失败'}</span><button className="icon-button" title="重试" aria-label="重试" onClick={onRetry}><RefreshCw size={15} /></button></div>;
  return null;
}

function unwrap<T>(envelope: { data: T }): T { return envelope.data; }

export function ProjectWorkflowPage(props: WorkspacePageProps & { initialSection?: Section }) {
  const id = props.projectId || props.selectedProject?.id || '';
  const actor = sessionStorage.getItem('aiws:v3:actor-id') || 'session-actor';
  return <ProjectWorkflowWorkspace key={`${actor}:${id}`} {...props} projectId={id} />;
}

function ProjectWorkflowWorkspace({ projectId, selectedProject, selectProject, refreshProjects, notify, setupReady, navigate, navigateProject, initialSection }: WorkspacePageProps & { initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection || 'overview');
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [showArchived, setShowArchived] = useState(false);
  const selectedId = projectId || selectedProject?.id || '';
  const data = useProjectWorkflowData(selectedId, setupReady !== false, showArchived);
  const { project, projects, brief, intake, connections, lines, workflow, generations, requirements, profiles, runnerProfiles, contextPacks, loadProjects } = data;
  const loadProject = data.refresh;
  const online = useWorkbenchOnline();
  const [briefUnsaved, setBriefUnsaved] = useState(false);
  const [workflowDirty, setWorkflowDirty] = useState(false);
  const [workflowQueued, setWorkflowQueued] = useState(false);
  const workflowBase = useRef<number | undefined>(undefined);
  const [resultMessage, setResultMessage] = useState('');
  const [errorAction, setErrorAction] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  const loadState: LoadState = data.loading ? 'loading' : data.error ? (data.error instanceof ApiError && data.error.status === 403 ? 'denied' : 'error') : !selectedId ? 'empty' : 'ready';
  useEffect(() => { if (project) { setProjectName(project.name || ''); setProjectDescription(project.description || ''); } }, [project?.id, project?.revision]);
  useEffect(() => { if (!workflowDirty) { setWorkflowGraph(JSON.stringify(workflow?.current?.graph || { nodes: [] }, null, 2)); workflowBase.current = workflow?.revision; } }, [workflow, workflowDirty]);
  const [targets, setTargets] = useState<RepositoryTarget[]>([]);
  const [providerProfileId, setProviderProfileId] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState('');
  const [busy, setBusy] = useState('');
  const [operationId, setOperationId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const offlineScope = useMemo(() => ({
    actorId: sessionStorage.getItem('aiws:v3:actor-id') || project?.owner_actor_id || 'session-actor',
    teamId: project?.team_id || 'default-team',
    projectId: selectedId
  }), [project?.owner_actor_id, project?.team_id, selectedId]);
  const [intakeMode, setIntakeMode] = useState<'brainstorm' | 'existing'>('brainstorm');
  const [sourceLocator, setSourceLocator] = useState('fixture/project-source');
  const [repositoryLocator, setRepositoryLocator] = useState('fixture/project-repository');
  const [workflowGraph, setWorkflowGraph] = useState('{"nodes":[]}');
  const [requirementKey, setRequirementKey] = useState('');
  const [deletionIntent, setDeletionIntent] = useState<{ id: string; status: string; revision: number; blockers?: Array<{ domain?: string }> } | null>(null);
  const [deletionName, setDeletionName] = useState('');
  const [repositoryDeletionIntent, setRepositoryDeletionIntent] = useState<RepositoryDeletionIntent | null>(null);
  const [repositoryDeletionName, setRepositoryDeletionName] = useState('');
  const [repositoryDeletionHead, setRepositoryDeletionHead] = useState('');
  useEffect(() => { setDeletionIntent(null); setRepositoryDeletionIntent(null); setTargets([]); }, [selectedId]);

  const restoreDeletionIntent = useCallback(async (id: string) => {
    if (!id) { setDeletionIntent(null); return; }
    try {
      const operations = await apiV2<{ operations?: Array<{ command_id?: string; resource_type?: string; resource_id?: string; created_at?: string }> }>(`/api/v2/operations?project_id=${encodeURIComponent(id)}`);
      const candidate = (operations.data.operations || [])
        .filter((item) => item.resource_type === 'project_deletion_intent' && item.resource_id)
        .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0];
      if (!candidate?.resource_id) { setDeletionIntent(null); return; }
      const intent = await apiV2<{ intent?: { id: string; status: string; revision: number; blockers?: Array<{ domain?: string }> } }>(`/api/v2/project-deletion-intents/${encodeURIComponent(candidate.resource_id)}`);
      setDeletionIntent(intent.data.intent || null);
    } catch {
      // Deletion intent visibility is best-effort during the normal project
      // refresh; the authoritative mutation still reports conflicts inline.
    }
  }, []);

  const restoreRepositoryDeletionIntent = useCallback(async (id: string) => {
    if (!id) { setRepositoryDeletionIntent(null); return; }
    try {
      const operations = await apiV2<{ operations?: Array<{ resource_type?: string; resource_id?: string; created_at?: string }> }>(`/api/v2/operations?project_id=${encodeURIComponent(id)}`);
      const candidate = (operations.data.operations || [])
        .filter((item) => item.resource_type === 'repository_deletion_intent' && item.resource_id)
        .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0];
      if (!candidate?.resource_id) { setRepositoryDeletionIntent(null); return; }
      const intent = await apiV2<{ intent?: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(candidate.resource_id)}`);
      setRepositoryDeletionIntent(intent.data.intent || null);
      if (intent.data.intent?.target_full_name) setRepositoryDeletionName(intent.data.intent.target_full_name);
      if (intent.data.intent?.expected_head_sha) setRepositoryDeletionHead(intent.data.intent.expected_head_sha);
    } catch {
      // Intent recovery is advisory; the server remains authoritative for
      // snapshot and revision checks on every destructive action.
    }
  }, []);

  const loadRepositoryTargets = useCallback(async (rows: RepositoryConnection[], project: string) => {
    const connection = rows[0];
    if (!connection || !project) { setTargets([]); setRepositoryDeletionIntent(null); return; }
    try {
      const result = await apiV2<{ targets?: RepositoryTarget[] }>(`/api/v2/repository-connections/${encodeURIComponent(connection.id)}/targets`);
      const next = result.data.targets || [];
      setTargets(next);
      const target = next[0];
      if (target) {
        setRepositoryDeletionName((current) => current || target.source_locator || target.remote_ref || target.name || '');
        setRepositoryDeletionHead((current) => current || target.expected_head_sha || '');
      }
      await restoreRepositoryDeletionIntent(project);
    } catch {
      setTargets([]);
    }
  }, [restoreRepositoryDeletionIntent]);

  useEffect(() => { void loadRepositoryTargets(connections, selectedId); void restoreDeletionIntent(selectedId); }, [connections.map(item => item.id + ':' + item.revision).join(','), selectedId, loadRepositoryTargets, restoreDeletionIntent]);
  useEffect(() => { if (message || conflict || resultMessage || operationId) resultRef.current?.focus(); }, [message, conflict, resultMessage, operationId]);
  const reportError = useCallback((error: unknown) => {
    const result = workbenchError(error); const api = error instanceof ApiError ? error : null;
    setMessage(result.message); setErrorAction(result.action);
    if (result.kind === 'conflict' || result.kind === 'drift') setConflict(api?.details.actual_revision != null ? `服务器修订 r${api.details.actual_revision}` : '服务器状态已变化');
    notify(result.message, 'error');
  }, [notify]);
  const showResult = useCallback((text: string, result?: Record<string, unknown>) => {
    const operation = result?.operation as { id?: string; operation_id?: string } | undefined;
    const id = String(result?.operation_id || operation?.operation_id || operation?.id || '');
    if (id) setOperationId(id);
    setResultMessage(text); notify(text);
  }, [notify]);

  const runMutation = useCallback(async (label: string, action: () => Promise<{ data: Record<string, unknown> } | { queued: true; record: unknown }>, refresh = true) => {
    setBusy(label); setConflict(''); setMessage(''); setResultMessage('');
    try {
      const response = await action();
      if ('queued' in response) { showResult(`${commandLabel(label)}已离线保存，等待同步`); return { queued: true }; }
      const result = response.data || {};
      showResult(`${commandLabel(label)}已提交`, result);
      if (refresh) await loadProject();
      return result;
    } catch (error) { reportError(error); return null; }
    finally { setBusy(''); }
  }, [loadProject, reportError, showResult]);

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    const result = await runMutation('Project', () => mutateV2('/api/v2/projects', { name: newName.trim(), description: newDescription, metadata: {} }, 'POST', 0), false);
    if (result?.project) {
      const created = result.project as P3Project;
      setNewName(''); setNewDescription('');
      await refreshProjects();
      await loadProjects();
      selectProject(created.id);
      navigateProject?.(created.id, 'onboarding');
    }
  };

  const updateProject = () => runMutation('Project', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}`, {
    name: projectName.trim(), description: projectDescription, metadata: {}
  }, 'PATCH', { command: 'project.update', scope: offlineScope, aggregateKey: `project:${selectedId}`, expectedRevision: project?.revision }));
  const archiveProject = (item: P3Project) => runMutation('Archive project', () => mutateV2(`/api/v2/projects/${encodeURIComponent(item.id)}/archive`, {}, 'POST', item.revision));
  const restoreProject = (item: P3Project) => runMutation('Restore project', () => mutateV2(`/api/v2/projects/${encodeURIComponent(item.id)}/restore`, {}, 'POST', item.revision));
  const prepareDeletion = () => runMutation('Prepare deletion', async () => { const result = await mutateV2<{ intent: { id: string; status: string; revision: number; blockers?: Array<{ domain?: string }> } }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/deletion-intents`, { target_name: deletionName.trim() || project?.name || '' }, 'POST', project?.revision); setDeletionIntent(result.data.intent); return result; });
  const confirmDeletion = () => deletionIntent && runMutation('Confirm deletion', async () => { const result = await mutateV2<{ intent: typeof deletionIntent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(deletionIntent.id)}/confirm`, { target_name: deletionName.trim() || project?.name || '' }, 'POST', deletionIntent.revision); setDeletionIntent(result.data.intent); return result; });
  const executeDeletion = () => deletionIntent && runMutation('Execute deletion', async () => { const result = await mutateV2<{ intent: typeof deletionIntent }>(`/api/v2/project-deletion-intents/${encodeURIComponent(deletionIntent.id)}/execute`, {}, 'POST', deletionIntent.revision); setDeletionIntent(result.data.intent); return result; });

  const prepareRepositoryDeletion = () => {
    const target = targets[0];
    if (!target) return Promise.resolve(null);
    return runMutation('Prepare repository deletion', async () => {
      const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-targets/${encodeURIComponent(target.id)}/deletion-intents`, {
        target_full_name: repositoryDeletionName.trim(), expected_head_sha: repositoryDeletionHead.trim()
      }, 'POST', target.revision);
      setRepositoryDeletionIntent(result.data.intent);
      return result;
    });
  };
  const confirmRepositoryDeletion = (role: 'creator' | 'owner') => repositoryDeletionIntent && runMutation(`Repository ${role} confirmation`, async () => {
    const path = role === 'creator' ? 'creator-confirm' : 'owner-confirm';
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/${path}`, {
      target_full_name: repositoryDeletionName.trim(), expected_head_sha: repositoryDeletionHead.trim()
    }, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });
  const executeRepositoryDeletion = () => repositoryDeletionIntent && runMutation('Execute repository deletion', async () => {
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/execute`, {}, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });
  const reconcileRepositoryDeletion = () => repositoryDeletionIntent && runMutation('Reconcile repository deletion', async () => {
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/reconcile`, {}, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });
  const cancelRepositoryDeletion = () => repositoryDeletionIntent && runMutation('Cancel repository deletion', async () => {
    const result = await mutateV2<{ intent: RepositoryDeletionIntent }>(`/api/v2/repository-deletion-intents/${encodeURIComponent(repositoryDeletionIntent.id)}/cancel`, {}, 'POST', repositoryDeletionIntent.revision);
    setRepositoryDeletionIntent(result.data.intent);
    return result;
  });

  const submitIntake = () => runMutation('Intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake`, {
    mode: intakeMode,
    source: intakeMode === 'existing' ? { kind: 'fixture', locator: sourceLocator, revision: 'fixture-r1', hash: 'a'.repeat(64) } : {},
    content: {},
  }, 'POST', project?.revision));

  const retryIntake = () => runMutation('Retry intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake/retry`, {}, 'POST', intake?.revision));
  const cancelIntake = () => runMutation('Cancel intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake/cancel`, {}, 'POST', intake?.revision));

  const saveBrief = (draft: BriefDraft, expectedRevision: number) => runMutation('Brief', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs`, {
    content: { ...brief?.current?.content, objective: draft.objective.trim(), acceptance: draft.acceptance.map(item => item.trim()) },
    template: 'default'
  }, 'POST', { command: 'brief.create', scope: offlineScope, aggregateKey: `project:${selectedId}:brief`, expectedRevision }));
  const confirmBrief = () => {
    if (!online) return Promise.resolve(null);
    const revision = brief?.current_revision || brief?.current?.revision || 0;
    return runMutation('Confirm brief', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs/${revision}/confirm`, { brief_revision: revision }, 'POST', project?.revision));
  };

  const connectRepository = () => runMutation('Repository', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-connections`, {
    provider: 'fixture', source_kind: 'fixture', source_locator: repositoryLocator, source_revision: 'fixture-r1', source_hash: 'a'.repeat(64), branch: 'main', read_only: true
  }, 'POST', project?.revision));

  const reviseWorkflow = async () => {
    const graph = parseWorkflowGraph(workflowGraph);
    const issues = validateWorkflowGraph(graph);
    if (!graph || issues.length) { setMessage(issues[0]?.message || '图谱 JSON 无效'); return null; }
    const result = await runMutation('Workflow', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-draft`, { graph, layout: workflow?.current?.layout || {} }, 'POST', { command: 'workflow.revise', scope: offlineScope, aggregateKey: `project:${selectedId}:workflow`, expectedRevision: workflowBase.current ?? workflow?.revision }));
    if (result?.queued) setWorkflowQueued(true);
    else if (result) { setWorkflowDirty(false); setWorkflowQueued(false); }
    return result;
  };
  const confirmedRevision = brief?.confirmed_revision || project?.confirmed_brief_revision || 0;
  const confirmedBrief = Boolean(confirmedRevision && confirmedRevision === (brief?.current_revision || brief?.current?.revision || project?.current_brief_revision));
  const savedWorkflow = Boolean(workflow?.current_revision);
  const availableProviders = profiles.filter(profile => profile.provider === 'codex' && profile.status === 'available' && profile.lifecycle_status !== 'disabled');
  const generationReasons = [!online && '恢复连接后可用', !confirmedBrief && '请先确认当前 Brief', briefUnsaved && '请先保存 Brief 修改', !savedWorkflow && '请先保存 Workflow 草稿', workflowDirty && '请先保存或放弃 Workflow 修改', !availableProviders.some(profile => profile.id === providerProfileId) && '请选择可用 Provider Profile'].filter(Boolean);
  const startGeneration = (mode: 'initial' | 'replan' = 'initial') => {
    if (generationReasons.length) return Promise.resolve(null);
    return runMutation('Generation', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-generations`, { mode, provider_profile_id: providerProfileId }, 'POST', project?.revision));
  };
  const generationAction = (action: 'critic' | 'retry' | 'cancel' | 'apply', generation: Generation) => {
    if (!online || busy) return;
    if (action === 'apply') {
      if (!generation.proposal_id || workflowDirty || generation.proposal?.base_workflow_revision !== workflow?.current_revision) { setConflict('提案基准修订已过期，请重新加载。'); return; }
      void runMutation('Apply proposal', () => mutateV2(`/api/v2/workflow-proposals/${encodeURIComponent(generation.proposal_id!)}/apply`, {}, 'POST', workflow?.revision));
    } else void runMutation(action === 'critic' ? 'Critic' : action === 'retry' ? 'Retry generation' : 'Cancel generation', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/${action}`, {}, 'POST', generation.revision));
  };
  const createRequirement = () => runMutation('Requirement', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/outcome-requirements`, { requirement_key: requirementKey.trim(), rubric: {}, workflow_revision: workflow?.current_revision || 0 }, 'POST', { command: 'outcome.requirement.create', scope: offlineScope, aggregateKey: `project:${selectedId}:outcome`, expectedRevision: project?.revision }));

  const workflowInitialView = /\/nodes?(?:\/|$)/.test(window.location.hash) ? 'nodes' : /\/workstreams?(?:\/|$)/.test(window.location.hash) ? 'workstreams' : 'canvas';
  const openProjectRoute = (target: 'workflow' | 'execution' | 'outcome' | 'delivery') => {
    if (navigateProject) navigateProject(selectedId, target);
    else navigate(target);
  };

  if (loadState === 'loading') return <div className="page-loader" data-testid="project-workflow-loading"><LoaderCircle className="spin" size={18} />正在加载项目工作区</div>;
  if (loadState === 'denied') return <div className="page"><ErrorState state="denied" message={data.error instanceof Error ? data.error.message : '没有项目访问权限'} onRetry={() => void loadProject()} /><button className="button" onClick={() => navigate('identity')}>前往权限设置</button></div>;
  if (loadState === 'empty' || (!project && !selectedId)) return <div className="page project-workflow-page"><div className="page-heading"><div><p className="eyebrow">项目工作区</p><h1>项目</h1></div></div><div className="empty-state" data-testid="project-workflow-empty"><GitBranch size={30} /><h2>创建第一个项目</h2><form className="project-create-form" onSubmit={createProject}><label><span>项目名称</span><input aria-label="项目名称" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="项目名称" required /></label><label><span>项目说明</span><input aria-label="项目说明" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="简短说明" /></label><button className="button primary" disabled={busy === 'Project'}><Plus size={15} />创建项目</button></form></div></div>;

  return <div className="page project-workflow-page">
    <div className="page-heading project-workflow-heading"><div><p className="eyebrow">项目工作区</p><h1>{project?.name || selectedProject?.name || '项目'}</h1><span className="mono project-id">{project?.id || selectedId}</span></div><div className="project-workflow-actions"><nav className="project-route-links" aria-label="项目工具"><button type="button" className={section === 'workflow' ? 'active' : ''} onClick={() => openProjectRoute('workflow')}>工作流</button><button type="button" onClick={() => openProjectRoute('execution')}>执行</button><button type="button" onClick={() => openProjectRoute('outcome')}>结果</button><button type="button" onClick={() => openProjectRoute('delivery')}>交付</button></nav><Status value={project?.status} /><button className="icon-button" title="刷新项目" aria-label="刷新项目" onClick={() => void loadProject()}><RefreshCw size={17} /></button></div></div>
    <div ref={resultRef} tabIndex={-1} className="workbench-result" role={message || conflict ? 'alert' : 'status'}>
      {message && <p>{message}</p>}
      {conflict && <div className="state-banner conflict" data-testid="project-workflow-conflict"><AlertTriangle size={18} /><span>{conflict}</span><button className="button" onClick={() => void loadProject()}>重新加载服务器版本</button><span>本地修改会保留；选择“放弃本地修改”可使用服务器内容。</span></div>}
      {message && !conflict && <button className="button" onClick={() => errorAction.includes('设置') ? navigate('identity') : void loadProject()}>{errorAction || '重试'}</button>}
      {resultMessage && <p>{resultMessage}</p>}
      {operationId && <div className="operation-strip" data-testid="project-workflow-operation"><OperationNotice key={operationId} id={operationId} projectId={selectedId} onTerminal={loadProject} /><button className="button" onClick={() => setOperationId('')}>关闭操作提示</button></div>}
    </div>
    <ErrorState state={loadState} message={data.error instanceof Error ? data.error.message : ''} onRetry={() => void loadProject()} />
    <div className="project-workflow-tabs" role="tablist" aria-label="项目工作流视图">{sections.map((item) => <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>{item.label}</button>)}</div>

    {section === 'overview' && <div className="project-workflow-grid">
      <section className="panel"><PanelTitle title="项目状态" meta={`修订 ${project?.revision || 0}`} /><dl className="project-facts"><div><dt>团队</dt><dd className="mono">{project?.team_id || '由 ACL 解析'}</dd></div><div><dt>引导状态</dt><dd><Status value={project?.onboarding_state} /></dd></div><div><dt>Brief</dt><dd>r{project?.current_brief_revision || 0} {project?.confirmed_brief_revision ? `· 已确认 r${project.confirmed_brief_revision}` : ''}</dd></div><div><dt>Workflow</dt><dd>r{project?.current_workflow_revision || workflow?.current_revision || 0}</dd></div></dl><div className="project-edit-grid"><label><span>名称</span><input aria-label="名称" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label><span>说明</span><input aria-label="说明" value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label><button className="button" disabled={!projectName.trim() || busy === 'Project'} onClick={() => void updateProject()}><Save size={15} />保存</button></div></section>
      <section className="panel"><PanelTitle title="项目列表" meta={`${projects.length} 个可见项目`} action={<button className="button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? '隐藏归档项目' : '显示归档项目'}</button>} /><div className="compact-list">{projects.map((item) => <div key={item.id} className={`compact-row ${item.id === selectedId ? 'selected' : ''}`}><span><strong>{item.name}</strong><small className="mono">{item.id} · r{item.revision}</small></span><Status value={item.status} /><div className="row-actions">{item.status === 'archived' ? <button className="icon-button" title="恢复项目" aria-label={`恢复项目 ${item.name}`} onClick={() => void restoreProject(item)}><RefreshCw size={14} /></button> : <button className="icon-button" title="归档项目" aria-label={`归档项目 ${item.name}`} onClick={() => void archiveProject(item)}><Square size={14} /></button>}</div></div>)}{!projects.length && <div className="list-empty">暂无可见项目</div>}</div></section>
      <section className="panel"><PanelTitle title="结果要求" meta={`${requirements.length} 条规则`} /><div className="compact-list">{requirements.map((item) => <div key={item.id} className="compact-row"><span><strong>{item.requirement_key}</strong><small>Workflow r{item.workflow_revision} · r{item.revision}</small></span></div>)}{!requirements.length && <div className="list-empty">暂无结果要求</div>}</div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void createRequirement(); }}><label><span>要求标识</span><input aria-label="要求标识" value={requirementKey} onChange={(event) => setRequirementKey(event.target.value)} placeholder="acceptance.core" required /></label><button className="button" disabled={busy === 'Requirement'}><Plus size={15} />添加</button></form></section>
    </div>}
    {section === 'overview' && <section className="panel project-lifecycle-panel"><PanelTitle title="项目生命周期" meta={project?.status === 'archived' ? '已归档项目可从项目列表恢复' : '归档项目或准备删除意图'} /><div className="form-actions"><button className="button" disabled={!project || project.status === 'archived' || Boolean(busy)} onClick={() => project && void archiveProject(project)}><Square size={15} />归档</button><button className="button" disabled={!project || project.status !== 'archived' || Boolean(busy)} onClick={() => project && void restoreProject(project)}><RefreshCw size={15} />恢复</button></div><div className="deletion-intent-form"><label><span>项目完整名称</span><input aria-label="项目完整名称" value={deletionName} onChange={(event) => setDeletionName(event.target.value)} placeholder={project?.name || '项目名称'} /></label><button className="button" disabled={!project || !deletionName.trim() || Boolean(busy)} onClick={() => void prepareDeletion()}><ShieldAlert size={15} />准备删除</button></div>{deletionIntent && <div className="deletion-intent-state"><Status value={deletionIntent.status} /><span>意图 {deletionIntent.id} · r{deletionIntent.revision}</span>{deletionIntent.blockers?.length ? <small>阻塞项：{deletionIntent.blockers.map((item) => item.domain).join('、')}</small> : null}<div className="form-actions">{deletionIntent.status === 'prepared' && <button className="button" onClick={() => void confirmDeletion()}><Check size={15} />确认</button>}{deletionIntent.status === 'ready' && <button className="button danger" onClick={() => void executeDeletion()}><ShieldAlert size={15} />执行</button>}</div></div>}</section>}

    {section === 'intake' && <section className="panel"><PanelTitle title="来源接入" meta={`修订 ${intake?.revision || 0} · 尝试 ${intake?.attempt || 0}`} /><div className="workflow-status-line"><Status value={intake?.status} />{intake?.error_code && <span className="fault-text"><CircleAlert size={14} />{errorCodeLabel(intake.error_code)}</span>}</div>{intake?.status === 'failed' && intake.error_code === 'source_drift' && <div className="state-banner error" data-testid="project-workflow-drift"><CircleAlert size={16} /><span>{message || '检测到源版本漂移，请对账后重试。'}</span></div>}<div className="segmented" role="group" aria-label="来源接入模式"><button className={intakeMode === 'brainstorm' ? 'active' : ''} onClick={() => setIntakeMode('brainstorm')}>从零构思</button><button className={intakeMode === 'existing' ? 'active' : ''} onClick={() => setIntakeMode('existing')}>已有来源</button></div>{intakeMode === 'existing' && <label><span>来源地址</span><input aria-label="来源地址" value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} /></label>}<div className="form-actions"><button className="button primary" disabled={Boolean(busy) || ['processing', 'submitted'].includes(intake?.status || '')} onClick={() => void (intake?.status === 'failed' ? retryIntake() : submitIntake())}>{intake?.status === 'failed' ? <RotateCcw size={15} /> : <Play size={15} />}{intake?.status === 'failed' ? '重试接入' : '提交接入'}</button>{['processing', 'submitted'].includes(intake?.status || '') && <button className="button" disabled={Boolean(busy)} onClick={() => void cancelIntake()}><Square size={15} />取消</button>}</div></section>}

    <section className="panel" hidden={section !== 'brief'}><PanelTitle title="Brief 修订" meta={`项目修订 ${project?.revision || 0}`} /><BriefEditor brief={brief} projectRevision={project?.revision || 0} busy={Boolean(busy)} online={online} intakeReady={intake?.status === 'ready'} onSave={saveBrief} onConfirm={confirmBrief} onDirty={setBriefUnsaved} /></section>

    {section === 'repository' && <div className="project-workflow-grid"><section className="panel"><PanelTitle title="代码仓库连接" meta={`${connections.length} 个连接`} /><div className="compact-list">{connections.map((connection) => <div className="compact-row" key={connection.id}><span><strong>{kindLabel(connection.provider || 'fixture')}</strong><small>{kindLabel(connection.source_kind)} · {connection.source_revision || '未版本化'} · r{connection.revision}</small></span><Status value={connection.status} /></div>)}{!connections.length && <div className="list-empty">暂无代码仓库连接</div>}</div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void connectRepository(); }}><label><span>来源地址</span><input aria-label="来源地址" value={repositoryLocator} onChange={(event) => setRepositoryLocator(event.target.value)} required /></label><button className="button primary" disabled={busy === 'Repository'}><GitBranch size={15} />连接代码仓库</button></form></section><section className="panel"><PanelTitle title="仓库分支" meta={`${lines.length} 条分支`} /><div className="compact-list">{lines.map((line) => <div className="compact-row" key={line.id}><span><strong>{line.id}</strong><small>{line.source_revision || '未知'} · r{line.revision}{line.fault_code ? ` · ${errorCodeLabel(line.fault_code)}` : ''}</small></span><Status value={line.status} /></div>)}{!lines.length && <div className="list-empty">连接仓库后显示分支</div>}</div></section><RepositoryDeletionPanel targets={targets} intent={repositoryDeletionIntent} name={repositoryDeletionName} head={repositoryDeletionHead} setName={setRepositoryDeletionName} setHead={setRepositoryDeletionHead} onPrepare={() => void prepareRepositoryDeletion()} onCreatorConfirm={() => void confirmRepositoryDeletion('creator')} onOwnerConfirm={() => void confirmRepositoryDeletion('owner')} onExecute={() => void executeRepositoryDeletion()} onReconcile={() => void reconcileRepositoryDeletion()} onCancel={() => void cancelRepositoryDeletion()} busy={busy} /></div>}

    {section === 'workflow' && <div className="project-workflow-grid">
      <section className="panel workflow-editor"><PanelTitle title="工作流草稿" meta={`修订 ${workflow?.current_revision || 0} · CAS r${workflow?.revision || 0} · 图谱 ${workflow?.current?.graph_sha256 || '未提交'}`} />
        <WorkflowEditor source={workflowGraph} busy={Boolean(busy)} onChange={source => { if (!workflowDirty) workflowBase.current = workflow?.revision; setWorkflowGraph(source); setWorkflowDirty(true); setWorkflowQueued(false); }} initialView={workflowInitialView} onContext={() => navigateProject?.(selectedId, 'context')} onReplan={() => void startGeneration('replan')} replanDisabled={generationReasons.length > 0} />
        <p role="status">{workflowQueued ? '已离线保存，等待同步' : workflowDirty ? '有未保存修改' : '与服务器一致'}</p>
        <div className="form-actions"><button className="button" disabled={Boolean(busy) || workflowQueued || validateWorkflowGraph(parseWorkflowGraph(workflowGraph)).length > 0} onClick={() => void reviseWorkflow()}><Save size={15} />保存草稿</button>{workflowDirty && <button className="button" disabled={Boolean(busy)} onClick={() => { setWorkflowDirty(false); setWorkflowQueued(false); }}>放弃本地修改</button>}</div>
        <label><span>Provider Profile</span><select aria-label="Provider Profile" value={providerProfileId} onChange={event => setProviderProfileId(event.target.value)}><option value="">选择可用配置</option>{profiles.filter(profile => profile.provider === 'codex').map(profile => <option key={profile.id} value={profile.id} disabled={!availableProviders.some(item => item.id === profile.id)}>{profile.label || profile.id} · {profile.lifecycle_status === 'disabled' ? 'disabled' : profile.status}</option>)}</select></label>
        {generationReasons.length > 0 && <ul className="prerequisite-note">{generationReasons.map(reason => <li key={String(reason)}>{reason}</li>)}</ul>}
        {!availableProviders.length && <button className="button" onClick={() => navigate('settings')}>前往 Provider 设置</button>}
        <button className="button primary" disabled={Boolean(busy) || generationReasons.length > 0} onClick={() => void startGeneration()}><WorkflowIcon size={15} />生成候选</button>
        {data.prerequisiteError && <div role="alert">执行前置条件查询失败：{data.prerequisiteError instanceof Error ? data.prerequisiteError.message : '请刷新'}<button className="button" onClick={() => void loadProject()}>重试</button></div>}
        <ExecutionLauncher projectId={selectedId} projectRevision={project?.revision || 0} confirmed={confirmedBrief} saved={savedWorkflow} dirty={workflowDirty || briefUnsaved} runners={runnerProfiles} packs={contextPacks} online={online} busy={Boolean(busy)} navigate={navigate} navigateProject={navigateProject} onResult={showResult} onError={reportError} />
      </section>
      <GenerationTimeline generations={generations} workflow={workflow} online={online} busy={Boolean(busy)} dirty={workflowDirty || briefUnsaved} acceptanceCount={Array.isArray(brief?.current?.content?.acceptance) ? brief.current.content.acceptance.length : 0} onAction={generationAction} />
    </div>}

  </div>;
}

export function ProjectPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} />; }
export function CleanWorkflowPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} />; }

export function RepositoryDeletionPanel({ targets, intent, name, head, setName, setHead, onPrepare, onCreatorConfirm, onOwnerConfirm, onExecute, onReconcile, onCancel, busy }: {
  targets: RepositoryTarget[];
  intent: RepositoryDeletionIntent | null;
  name: string;
  head: string;
  setName: (value: string) => void;
  setHead: (value: string) => void;
  onPrepare: () => void;
  onCreatorConfirm: () => void;
  onOwnerConfirm: () => void;
  onExecute: () => void;
  onReconcile: () => void;
  onCancel: () => void;
  busy: string;
}) {
  const target = targets[0];
  return <section className="panel repository-deletion-panel">
    <PanelTitle title="代码仓库删除" meta={target ? `目标修订 ${target.revision}` : '需要只读目标元数据'} />
    {!target ? <div className="list-empty">暂无可用的仓库目标</div> : <>
      <label><span>完整名称</span><input aria-label="完整名称" value={name} onChange={(event) => setName(event.target.value)} placeholder={target.source_locator || target.remote_ref || target.name || 'owner/repository'} /></label>
      <label><span>预期 HEAD</span><input aria-label="预期 HEAD" className="mono" value={head} onChange={(event) => setHead(event.target.value)} placeholder={target.expected_head_sha || '提交 SHA'} /></label>
      {!intent && <button className="button danger" disabled={!name.trim() || !head.trim() || Boolean(busy)} onClick={onPrepare}><ShieldAlert size={15} />准备删除意图</button>}
      {intent && <div className="repository-deletion-state"><div className="workflow-status-line"><Status value={intent.status} /><span className="mono">{intent.id} · r{intent.revision}</span></div><small>远程删除需要两个相互独立的会话确认。</small><div className="form-actions">{intent.status === 'prepared' && <button className="button" disabled={Boolean(busy)} onClick={onCreatorConfirm}><Check size={14} />创建者确认</button>}{intent.status === 'creator_confirmed' && <button className="button" disabled={Boolean(busy)} onClick={onOwnerConfirm}><ShieldAlert size={14} />所有者确认</button>}{intent.status === 'ready' && <button className="button danger" disabled={Boolean(busy)} onClick={onExecute}><ShieldAlert size={14} />执行删除</button>}{['needs_reconcile', 'failed'].includes(intent.status) && <button className="button" disabled={Boolean(busy)} onClick={onReconcile}><RotateCcw size={14} />重新对账</button>}{!['completed', 'cancelled'].includes(intent.status) && <button className="icon-button" title="取消删除意图" aria-label="取消删除意图" disabled={Boolean(busy)} onClick={onCancel}><Square size={14} /></button>}</div>{intent.error_code && <div className="fault-text"><CircleAlert size={14} />{errorCodeLabel(intent.error_code)}</div>}</div>}
    </>}
  </section>;
}
