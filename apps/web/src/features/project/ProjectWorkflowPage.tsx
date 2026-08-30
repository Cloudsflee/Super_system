import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle, Check, CircleAlert, GitBranch, LoaderCircle, Play, Plus, RefreshCw,
  RotateCcw, Save, ShieldAlert, Square, Workflow as WorkflowIcon
} from 'lucide-react';
import { ApiError, apiV2, mutateOfflineV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Section = 'overview' | 'intake' | 'brief' | 'repository' | 'workflow';
type LoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'error';
type P3Project = {
  id: string;
  team_id?: string;
  owner_actor_id?: string;
  name: string;
  description?: string;
  status: string;
  onboarding_state?: string;
  current_brief_revision?: number;
  confirmed_brief_revision?: number | null;
  confirmed_brief_hash?: string;
  current_workflow_revision?: number;
  revision: number;
  updated_at?: string;
};
type Intake = {
  id: string;
  project_id: string;
  status: string;
  mode: 'brainstorm' | 'existing';
  source_kind?: string;
  source_revision?: string;
  source_hash?: string;
  error_code?: string;
  attempt?: number;
  revision: number;
  operation_id?: string | null;
};
type Brief = {
  id?: string;
  project_id: string;
  status?: string;
  current_revision?: number;
  confirmed_revision?: number | null;
  confirmed_hash?: string;
  revision?: number;
  current?: { revision: number; content?: Record<string, unknown>; content_sha256?: string } | null;
};
type RepositoryConnection = {
  id: string;
  project_id: string;
  provider?: string;
  source_kind?: string;
  source_revision?: string;
  source_hash?: string;
  status: string;
  read_only?: boolean;
  revision: number;
};
type RepositoryLine = { id: string; status: string; source_revision?: string; source_hash?: string; revision: number; fault_code?: string };
type Workflow = { id: string; project_id: string; status: string; current_revision: number; revision: number; current?: { graph?: Record<string, unknown>; graph_sha256?: string } | null };
type Generation = { id: string; phase: string; revision: number; attempt?: number; error_code?: string; proposal_id?: string | null; critic_receipt_id?: string | null; candidate?: Record<string, unknown> };
type Requirement = { id: string; requirement_key: string; workflow_revision: number; revision: number; rubric?: Record<string, unknown> };

const sections: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'intake', label: 'Intake' },
  { id: 'brief', label: 'Brief' },
  { id: 'repository', label: 'Repository' },
  { id: 'workflow', label: 'Workflow' }
];

function Status({ value }: { value?: string }) {
  const status = value || 'unknown';
  const tone = ['ready', 'active', 'confirmed', 'applied', 'passed'].includes(status)
    ? 'positive' : ['queued', 'running', 'processing', 'critic_pending', 'proposed'].includes(status)
      ? 'working' : ['failed', 'cancelled', 'rejected', 'stale', 'faulted', 'archived'].includes(status) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{status.replaceAll('_', ' ')}</span>;
}

function PanelTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

function ErrorState({ state, message, onRetry }: { state: LoadState; message: string; onRetry: () => void }) {
  if (state === 'denied') return <div className="state-banner denied" data-testid="project-workflow-denied"><ShieldAlert size={18} /><span>{message || 'Project access denied'}</span></div>;
  if (state === 'error') return <div className="state-banner error" role="alert"><CircleAlert size={18} /><span>{message || 'Project request failed'}</span><button className="icon-button" title="Retry" aria-label="Retry" onClick={onRetry}><RefreshCw size={15} /></button></div>;
  return null;
}

function unwrap<T>(envelope: { data: T }): T { return envelope.data; }

export function ProjectWorkflowPage({ projectId, selectedProject, selectProject, refreshProjects, notify, setupReady, navigateProject, initialSection }: WorkspacePageProps & { initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection || 'overview');
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [projects, setProjects] = useState<P3Project[]>([]);
  const [project, setProject] = useState<P3Project | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [connections, setConnections] = useState<RepositoryConnection[]>([]);
  const [lines, setLines] = useState<RepositoryLine[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState('');
  const [busy, setBusy] = useState('');
  const [operationId, setOperationId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const selectedId = projectId || selectedProject?.id || '';
  const offlineScope = useMemo(() => ({
    actorId: sessionStorage.getItem('aiws:v3:actor-id') || project?.owner_actor_id || 'session-actor',
    teamId: project?.team_id || 'default-team',
    projectId: selectedId
  }), [project?.owner_actor_id, project?.team_id, selectedId]);
  const [intakeMode, setIntakeMode] = useState<'brainstorm' | 'existing'>('brainstorm');
  const [sourceLocator, setSourceLocator] = useState('fixture/project-source');
  const [objective, setObjective] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [repositoryLocator, setRepositoryLocator] = useState('fixture/project-repository');
  const [workflowGraph, setWorkflowGraph] = useState('{"nodes":[]}');
  const [requirementKey, setRequirementKey] = useState('');

  const loadProjects = useCallback(async () => {
    const result = await apiV2<{ projects: P3Project[] }>('/api/v2/projects');
    setProjects(unwrap(result).projects || []);
  }, []);

  const loadProject = useCallback(async () => {
    setLoadState('loading');
    setMessage('');
    try {
      if (!selectedId) {
        await loadProjects();
        setProject(null); setIntake(null); setBrief(null); setConnections([]); setLines([]); setWorkflow(null); setGenerations([]); setRequirements([]);
        setLoadState('empty');
        return;
      }
      await loadProjects();
      const [detail, intakeResult, briefResult, connectionResult, lineResult, workflowResult, generationResult, requirementResult] = await Promise.all([
        apiV2<{ project: P3Project; intake?: Intake; brief?: Brief; workflow?: Workflow }>(`/api/v2/projects/${encodeURIComponent(selectedId)}`),
        apiV2<{ intake: Intake }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake`),
        apiV2<{ briefs: Brief[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs`),
        apiV2<{ connections: RepositoryConnection[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-connections`),
        apiV2<{ lines: RepositoryLine[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-lines`),
        apiV2<{ workflow: Workflow }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-draft`),
        apiV2<{ generations: Generation[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-generations`),
        apiV2<{ requirements: Requirement[] }>(`/api/v2/projects/${encodeURIComponent(selectedId)}/outcome-requirements`)
      ]);
      const detailData = unwrap(detail);
      const projectData = detailData.project || detailData as unknown as P3Project;
      setProject(projectData);
      setProjectName(projectData.name || '');
      setProjectDescription(projectData.description || '');
      setIntake(unwrap(intakeResult).intake || detailData.intake || null);
      const briefs = unwrap(briefResult).briefs || [];
      setBrief((detailData.brief as Brief | undefined) || briefs[0] || null);
      setConnections(unwrap(connectionResult).connections || []);
      setLines(unwrap(lineResult).lines || []);
      setWorkflow(unwrap(workflowResult).workflow || detailData.workflow || null);
      setGenerations(unwrap(generationResult).generations || []);
      setRequirements(unwrap(requirementResult).requirements || []);
      const content = (detailData.brief as Brief | undefined)?.current?.content || briefs[0]?.current?.content;
      setObjective(typeof content?.objective === 'string' ? content.objective : '');
      setAcceptance(Array.isArray(content?.acceptance) ? content.acceptance.join('\n') : '');
      setLoadState('ready');
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setMessage(apiError?.message || (error instanceof Error ? error.message : 'Project request failed'));
      setLoadState(apiError?.status === 403 ? 'denied' : 'error');
    }
  }, [loadProjects, selectedId]);

  useEffect(() => { if (setupReady !== false) void loadProject(); }, [loadProject, setupReady]);

  const runMutation = useCallback(async (label: string, action: () => Promise<{ data: Record<string, unknown> } | { queued: true; record: unknown }>, refresh = true) => {
    setBusy(label); setConflict(''); setMessage('');
    try {
      const response = await action();
      if ('queued' in response) {
        notify(`${label} saved offline`);
        return {};
      }
      const data = response.data || {};
      const operation = (data.operation || {}) as { operation_id?: string; id?: string };
      if (operation.operation_id || operation.id) setOperationId(operation.operation_id || operation.id || '');
      if (refresh) await loadProject();
      notify(`${label} accepted`);
      return data;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.code === 'revision_conflict' || apiError?.status === 409) setConflict(apiError.message || 'Revision changed; reload and retry.');
      else if (apiError?.code === 'source_drift') setMessage(apiError.message || 'Source drift detected; retry after reconciling.');
      else setMessage(apiError?.message || (error instanceof Error ? error.message : `${label} failed`));
      notify(apiError?.message || `${label} failed`, 'error');
      return null;
    } finally { setBusy(''); }
  }, [loadProject, notify]);

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

  const submitIntake = () => runMutation('Intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake`, {
    mode: intakeMode,
    source: intakeMode === 'existing' ? { kind: 'fixture', locator: sourceLocator, revision: 'fixture-r1', hash: 'a'.repeat(64) } : {},
    content: {},
  }, 'POST', project?.revision));

  const retryIntake = () => runMutation('Retry intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake/retry`, {}, 'POST', intake?.revision));
  const cancelIntake = () => runMutation('Cancel intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/intake/cancel`, {}, 'POST', intake?.revision));

  const saveBrief = () => runMutation('Brief', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs`, {
    content: { objective: objective.trim(), constraints: [], acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean) },
    objective: objective.trim(), constraints: [], acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean), template: 'default'
  }, 'POST', { command: 'brief.create', scope: offlineScope, aggregateKey: `project:${selectedId}:brief`, expectedRevision: project?.revision }));

  const confirmBrief = () => {
    const revision = brief?.current_revision || brief?.current?.revision || 0;
    return runMutation('Confirm brief', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/briefs/${revision}/confirm`, { brief_revision: revision }, 'POST', project?.revision));
  };

  const connectRepository = () => runMutation('Repository', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/repository-connections`, {
    provider: 'fixture', source_kind: 'fixture', source_locator: repositoryLocator, source_revision: 'fixture-r1', source_hash: 'a'.repeat(64), branch: 'main', read_only: true
  }, 'POST', project?.revision));

  const reviseWorkflow = () => {
    let graph: Record<string, unknown> = {};
    try { graph = JSON.parse(workflowGraph) as Record<string, unknown>; } catch { setMessage('Workflow graph must be valid JSON.'); return Promise.resolve(null); }
    return runMutation('Workflow', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-draft`, { graph, nodes: Array.isArray(graph.nodes) ? graph.nodes : [], layout: {} }, 'POST', { command: 'workflow.revise', scope: offlineScope, aggregateKey: `project:${selectedId}:workflow`, expectedRevision: workflow?.revision }));
  };

  const startGeneration = () => runMutation('Generation', () => mutateV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/workflow-generations`, { mode: 'initial', candidate: {}, provider: 'fake-generator' }, 'POST', project?.revision));
  const evaluateCritic = (generation: Generation) => runMutation('Critic', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/critic`, { status: 'passed', issues: [] }, 'POST', generation.revision));
  const retryGeneration = (generation: Generation) => runMutation('Retry generation', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/retry`, {}, 'POST', generation.revision));
  const cancelGeneration = (generation: Generation) => runMutation('Cancel generation', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(generation.id)}/cancel`, {}, 'POST', generation.revision));
  const applyProposal = (generation: Generation) => generation.proposal_id
    ? runMutation('Apply proposal', () => mutateV2(`/api/v2/workflow-proposals/${encodeURIComponent(generation.proposal_id || '')}/apply`, {}, 'POST', generation.revision))
    : Promise.resolve(null);
  const createRequirement = () => runMutation('Requirement', () => mutateOfflineV2(`/api/v2/projects/${encodeURIComponent(selectedId)}/outcome-requirements`, { requirement_key: requirementKey.trim(), rubric: {}, workflow_revision: workflow?.current_revision || 0 }, 'POST', { command: 'outcome.requirement.create', scope: offlineScope, aggregateKey: `project:${selectedId}:outcome`, expectedRevision: project?.revision }));

  const currentGeneration = useMemo(() => generations[0] || null, [generations]);

  if (loadState === 'loading') return <div className="page-loader" data-testid="project-workflow-loading"><LoaderCircle className="spin" size={18} />Loading Project workspace</div>;
  if (loadState === 'empty' || (!project && !selectedId)) return <div className="page project-workflow-page"><div className="page-heading"><div><p className="eyebrow">Clean project surface</p><h1>项目</h1></div></div><div className="empty-state" data-testid="project-workflow-empty"><GitBranch size={30} /><h2>创建首个项目</h2><form className="project-create-form" onSubmit={createProject}><label><span>项目名称</span><input aria-label="项目名称" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="项目名称" required /></label><label><span>项目说明</span><input aria-label="项目说明" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="简短说明" /></label><button className="button primary" disabled={busy === 'Project'}><Plus size={15} />创建项目</button></form></div></div>;

  return <div className="page project-workflow-page">
    <div className="page-heading project-workflow-heading"><div><p className="eyebrow">Clean project surface</p><h1>{project?.name || selectedProject?.name || 'Project'}</h1><span className="mono project-id">{project?.id || selectedId}</span></div><div className="project-workflow-actions"><Status value={project?.status} /><button className="icon-button" title="Reload project" aria-label="Reload project" onClick={() => void loadProject()}><RefreshCw size={17} /></button></div></div>
    {conflict && <div className="state-banner conflict" data-testid="project-workflow-conflict"><AlertTriangle size={18} /><span>{conflict}</span><button className="button" onClick={() => void loadProject()}>Reload</button></div>}
    <ErrorState state={loadState} message={message} onRetry={() => void loadProject()} />
    {operationId && <div className="operation-strip" data-testid="project-workflow-operation"><LoaderCircle className="spin" size={15} /><span>Operation queued</span><code>{operationId}</code><button className="icon-button" title="Dismiss operation" aria-label="Dismiss operation" onClick={() => setOperationId('')}><Check size={15} /></button></div>}
    <div className="project-workflow-tabs" role="tablist" aria-label="Project workflow views">{sections.map((item) => <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>{item.label}</button>)}</div>

    {section === 'overview' && <div className="project-workflow-grid">
      <section className="panel"><PanelTitle title="Project state" meta={`Revision ${project?.revision || 0}`} /><dl className="project-facts"><div><dt>Team</dt><dd className="mono">{project?.team_id || 'resolved by ACL'}</dd></div><div><dt>Onboarding</dt><dd><Status value={project?.onboarding_state} /></dd></div><div><dt>Brief</dt><dd>r{project?.current_brief_revision || 0} {project?.confirmed_brief_revision ? `· confirmed r${project.confirmed_brief_revision}` : ''}</dd></div><div><dt>Workflow</dt><dd>r{project?.current_workflow_revision || workflow?.current_revision || 0}</dd></div></dl><div className="project-edit-grid"><label><span>Name</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><label><span>Description</span><input value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label><button className="button" disabled={!projectName.trim() || busy === 'Project'} onClick={() => void updateProject()}><Save size={15} />Save</button></div></section>
      <section className="panel"><PanelTitle title="Project collection" meta={`${projects.length} visible`} /><div className="compact-list">{projects.map((item) => <div key={item.id} className={`compact-row ${item.id === selectedId ? 'selected' : ''}`}><span><strong>{item.name}</strong><small className="mono">{item.id} · r{item.revision}</small></span><Status value={item.status} /></div>)}{!projects.length && <div className="list-empty">No visible projects</div>}</div></section>
      <section className="panel"><PanelTitle title="Outcome requirements" meta={`${requirements.length} rules`} /><div className="compact-list">{requirements.map((item) => <div key={item.id} className="compact-row"><span><strong>{item.requirement_key}</strong><small>Workflow r{item.workflow_revision} · r{item.revision}</small></span></div>)}{!requirements.length && <div className="list-empty">No requirements yet</div>}</div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void createRequirement(); }}><label><span>Requirement key</span><input value={requirementKey} onChange={(event) => setRequirementKey(event.target.value)} placeholder="acceptance.core" required /></label><button className="button" disabled={busy === 'Requirement'}><Plus size={15} />Add</button></form></section>
    </div>}

    {section === 'intake' && <section className="panel"><PanelTitle title="Source intake" meta={`Revision ${intake?.revision || 0} · Attempt ${intake?.attempt || 0}`} /><div className="workflow-status-line"><Status value={intake?.status} />{intake?.error_code && <span className="fault-text"><CircleAlert size={14} />{intake.error_code}</span>}</div>{intake?.status === 'failed' && intake.error_code === 'source_drift' && <div className="state-banner error" data-testid="project-workflow-drift"><CircleAlert size={16} /><span>{message || 'Source drift detected; retry after reconciling.'}</span></div>}<div className="segmented" role="group" aria-label="Intake mode"><button className={intakeMode === 'brainstorm' ? 'active' : ''} onClick={() => setIntakeMode('brainstorm')}>Brainstorm</button><button className={intakeMode === 'existing' ? 'active' : ''} onClick={() => setIntakeMode('existing')}>Existing source</button></div>{intakeMode === 'existing' && <label><span>Source locator</span><input value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} /></label>}<div className="form-actions"><button className="button primary" disabled={Boolean(busy) || ['processing', 'submitted'].includes(intake?.status || '')} onClick={() => void (intake?.status === 'failed' ? retryIntake() : submitIntake())}>{intake?.status === 'failed' ? <RotateCcw size={15} /> : <Play size={15} />}{intake?.status === 'failed' ? 'Retry intake' : 'Submit intake'}</button>{['processing', 'submitted'].includes(intake?.status || '') && <button className="button" disabled={Boolean(busy)} onClick={() => void cancelIntake()}><Square size={15} />Cancel</button>}</div></section>}

    {section === 'brief' && <section className="panel"><PanelTitle title="Brief revision" meta={`Project revision ${project?.revision || 0}`} /><label><span>Objective</span><textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Measurable objective" /></label><label><span>Acceptance criteria</span><textarea rows={4} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder="One criterion per line" /></label><div className="form-actions"><button className="button" disabled={!objective.trim() || Boolean(busy)} onClick={() => void saveBrief()}><Save size={15} />Save revision</button><button className="button primary" disabled={!brief || !(brief.current_revision || brief.current?.revision) || Boolean(busy)} onClick={() => void confirmBrief()}><Check size={15} />Confirm revision</button></div>{brief && <div className="revision-note"><span>Current revision</span><strong>r{brief.current_revision || brief.current?.revision || 0}</strong><Status value={brief.status} /></div>}</section>}

    {section === 'repository' && <div className="project-workflow-grid"><section className="panel"><PanelTitle title="Repository connections" meta={`${connections.length} connections`} /><div className="compact-list">{connections.map((connection) => <div className="compact-row" key={connection.id}><span><strong>{connection.provider || 'fixture'}</strong><small>{connection.source_kind} · {connection.source_revision || 'unversioned'} · r{connection.revision}</small></span><Status value={connection.status} /></div>)}{!connections.length && <div className="list-empty">No repository connection</div>}</div><form className="inline-form" onSubmit={(event) => { event.preventDefault(); void connectRepository(); }}><label><span>Source locator</span><input value={repositoryLocator} onChange={(event) => setRepositoryLocator(event.target.value)} required /></label><button className="button primary" disabled={busy === 'Repository'}><GitBranch size={15} />Connect fixture</button></form></section><section className="panel"><PanelTitle title="Repository lines" meta={`${lines.length} lines`} /><div className="compact-list">{lines.map((line) => <div className="compact-row" key={line.id}><span><strong>{line.id}</strong><small>{line.source_revision || 'unknown'} · r{line.revision}{line.fault_code ? ` · ${line.fault_code}` : ''}</small></span><Status value={line.status} /></div>)}{!lines.length && <div className="list-empty">Lines appear after a connection</div>}</div></section></div>}

    {section === 'workflow' && <div className="project-workflow-grid"><section className="panel workflow-editor"><PanelTitle title="Workflow draft" meta={`Revision ${workflow?.revision || 0} · Graph ${workflow?.current?.graph_sha256?.slice(0, 10) || 'uncommitted'}`} /><label><span>Graph JSON</span><textarea rows={7} value={workflowGraph} onChange={(event) => setWorkflowGraph(event.target.value)} spellCheck={false} /></label><div className="form-actions"><button className="button" disabled={Boolean(busy)} onClick={() => void reviseWorkflow()}><Save size={15} />Save draft</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void startGeneration()}><WorkflowIcon size={15} />Generate candidate</button></div></section><section className="panel"><PanelTitle title="Generation and critic" meta={`${generations.length} attempts`} /><div className="compact-list">{generations.map((generation) => <div className="compact-row" key={generation.id}><span><strong>{generation.phase}</strong><small className="mono">{generation.id} · attempt {generation.attempt || 1} · r{generation.revision}</small></span><Status value={generation.phase} /><div className="row-actions">{generation.phase === 'critic_pending' && <button className="icon-button" title="Evaluate critic" aria-label={`Evaluate critic ${generation.id}`} onClick={() => void evaluateCritic(generation)}><Check size={14} /></button>}{generation.phase === 'failed' && <button className="icon-button" title="Retry generation" aria-label={`Retry generation ${generation.id}`} onClick={() => void retryGeneration(generation)}><RotateCcw size={14} /></button>}{['queued', 'running', 'critic_pending'].includes(generation.phase) && <button className="icon-button" title="Cancel generation" aria-label={`Cancel generation ${generation.id}`} onClick={() => void cancelGeneration(generation)}><Square size={14} /></button>}{generation.proposal_id && generation.phase === 'proposed' && <button className="icon-button" title="Apply proposal" aria-label={`Apply proposal ${generation.id}`} onClick={() => void applyProposal(generation)}><Check size={14} /></button>}</div></div>)}{!generations.length && <div className="list-empty">No generation attempts</div>}</div>{currentGeneration?.error_code && <div className="state-banner error"><AlertTriangle size={16} /><span>{currentGeneration.error_code}</span></div>}</section></div>}
  </div>;
}

export function ProjectPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} />; }
export function CleanWorkflowPage(props: WorkspacePageProps) { return <ProjectWorkflowPage {...props} />; }
