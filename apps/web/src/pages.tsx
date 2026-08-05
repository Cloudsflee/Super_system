import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowRight, Check, CircleAlert, ClipboardCheck, Code2, Download, FilePlus2,
  GitBranch, GitPullRequest, Layers3, LoaderCircle, PackageCheck, Play, Plus, RefreshCw,
  Save, Search, ShieldCheck, Square, Trash2, Upload, WandSparkles
} from 'lucide-react';
import { api, formatBytes, formatTime, mutate, shortHash } from './api';
import type { PageKey } from './App';
import type {
  AssetVersion, AuditEvent, ContextPack, ContextSource, Execution, Project, Review, WorkflowTask
} from './types';

export interface WorkspacePageProps {
  projectId: string;
  selectedProject?: Project;
  selectProject: (id: string) => void;
  refreshProjects: () => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  navigate: (page: PageKey) => void;
}

type Capabilities = {
  version: string;
  api: string;
  codex: { status: string };
  github: { status: string };
  broker: { status: string; runner_digest: string };
};

function SectionTitle({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

function Status({ value }: { value: string }) {
  const tone = ['ready', 'available', 'active', 'completed', 'approved', 'ok', 'draft'].includes(value)
    ? 'positive' : ['running', 'queued', 'pending', 'ready'].includes(value) ? 'working' : ['failed', 'invalid', 'rejected'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}

function EmptyProject({ navigate }: Pick<WorkspacePageProps, 'navigate'>) {
  return (
    <div className="empty-state">
      <GitBranch size={28} />
      <h2>No project selected</h2>
      <button className="button primary" onClick={() => navigate('projects')}><Plus size={16} />Create project</button>
    </div>
  );
}

function useProjectBundle(projectId: string) {
  const [bundle, setBundle] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!projectId) { setBundle(null); return; }
    setLoading(true);
    try { setBundle(await api<Project>(`/api/v1/projects/${projectId}`)); } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  return { bundle, loading, reload: load };
}

export function SetupPage({ navigate }: WorkspacePageProps) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [readiness, setReadiness] = useState<{ status: string; checks?: Record<string, unknown> } | null>(null);
  const load = useCallback(async () => {
    const [caps, ready] = await Promise.all([
      api<Capabilities>('/api/v1/system/capabilities'),
      api<{ status: string; checks?: Record<string, unknown> }>('/readyz')
    ]);
    setCapabilities(caps);
    setReadiness(ready);
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="page page-setup">
      <div className="page-heading"><div><p className="eyebrow">Instance</p><h1>AIWS 3.0 workspace</h1></div><button className="icon-button" title="刷新" aria-label="刷新" onClick={() => void load()}><RefreshCw size={18} /></button></div>
      <section className="health-band">
        <div><span>Process</span><Status value={readiness?.status || 'checking'} /></div>
        <div><span>SQLite</span><Status value={readiness?.status === 'ready' ? 'ready' : 'checking'} /></div>
        <div><span>Runner broker</span><Status value={capabilities?.broker.status || 'checking'} /></div>
        <div><span>API</span><strong>{capabilities?.api || '/api/v1'}</strong></div>
      </section>
      <div className="two-column setup-grid">
        <section className="panel">
          <SectionTitle title="Runtime" meta="Local instance" />
          <dl className="definition-list">
            <div><dt>Version</dt><dd>{capabilities?.version || '3.0.0'}</dd></div>
            <div><dt>Bind</dt><dd>127.0.0.1:4317</dd></div>
            <div><dt>Data</dt><dd>aiws-data-v3</dd></div>
            <div><dt>Runner</dt><dd className="mono">{shortHash(capabilities?.broker.runner_digest)}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <SectionTitle title="Integrations" meta="Cached probe" />
          <div className="integration-row"><div><Code2 size={18} /><span>Codex</span></div><Status value={capabilities?.codex.status || 'checking'} /></div>
          <div className="integration-row"><div><GitPullRequest size={18} /><span>GitHub App</span></div><Status value={capabilities?.github.status || 'checking'} /></div>
          <button className="button primary setup-action" onClick={() => navigate('projects')}>Open projects<ArrowRight size={16} /></button>
        </section>
      </div>
    </div>
  );
}

export function ProjectsPage(props: WorkspacePageProps) {
  const { projectId, selectProject, refreshProjects, notify } = props;
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => setProjects(await api<Project[]>('/api/v1/projects')), []);
  useEffect(() => { void load(); }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const created = await mutate<Project>('/api/v1/projects', { name, description, repository: { local_path: repoPath || undefined } });
      setName(''); setDescription(''); setRepoPath('');
      selectProject(created.id);
      await Promise.all([load(), refreshProjects()]);
      notify('Project created');
    } catch (error) { notify(error instanceof Error ? error.message : 'Project creation failed', 'error'); }
    finally { setSaving(false); }
  };
  return (
    <div className="page">
      <div className="page-heading"><div><p className="eyebrow">Workspace index</p><h1>Projects</h1></div><span className="count-label">{projects.length} total</span></div>
      <div className="project-layout">
        <section className="panel project-list-panel">
          <SectionTitle title="Managed repositories" meta="One repository per project" />
          <div className="project-list">
            {projects.map((project) => (
              <button key={project.id} className={project.id === projectId ? 'project-row selected' : 'project-row'} onClick={() => selectProject(project.id)}>
                <span className="project-icon"><FolderIcon /></span>
                <span><strong>{project.name}</strong><small>{project.description || project.id}</small></span>
                <span><Status value={project.status} /><small>{formatTime(project.updated_at)}</small></span>
              </button>
            ))}
            {!projects.length && <div className="list-empty">No projects</div>}
          </div>
        </section>
        <section className="panel create-project-panel">
          <SectionTitle title="New project" meta="Local managed workspace" />
          <form className="form-stack" onSubmit={(event) => void submit(event)}>
            <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} placeholder="DesignSignal" /></label>
            <label><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="Release validation workspace" /></label>
            <label><span>Workspace path</span><input className="mono" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="projects/designsignal" /></label>
            <button className="button primary" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Create project</button>
          </form>
        </section>
      </div>
    </div>
  );
}

function FolderIcon() { return <GitBranch size={18} />; }

const DEFAULT_TASKS: WorkflowTask[] = [
  { id: 'analyze', title: 'Analyze brief and repository', level: 1, deps: [], mode: 'read', inputs: [], outputs: ['analysis.md'] },
  { id: 'implement', title: 'Implement and verify change', level: 2, deps: ['analyze'], mode: 'write', inputs: ['analysis.md'], outputs: ['change.diff', 'test-report.json'] }
];

export function WorkflowPage({ projectId, navigate, notify }: WorkspacePageProps) {
  const { bundle, loading, reload } = useProjectBundle(projectId);
  const [objective, setObjective] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [workflowName, setWorkflowName] = useState('Delivery workflow');
  const [tasks, setTasks] = useState<WorkflowTask[]>(DEFAULT_TASKS);
  const [selectedTask, setSelectedTask] = useState('');
  const [hoveredTask, setHoveredTask] = useState('');
  const [sources, setSources] = useState<ContextSource[]>([]);
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const loadContext = useCallback(async () => {
    if (!projectId) return;
    const [sourceRows, packRows] = await Promise.all([
      api<ContextSource[]>(`/api/v1/projects/${projectId}/context/sources`),
      api<ContextPack[]>(`/api/v1/projects/${projectId}/context/packs`)
    ]);
    setSources(sourceRows); setPacks(packRows);
  }, [projectId]);
  useEffect(() => { void loadContext(); }, [loadContext]);
  useEffect(() => {
    if (bundle?.brief?.content.objective) setObjective(bundle.brief.content.objective);
    if (bundle?.brief?.content.acceptance) setAcceptance(bundle.brief.content.acceptance.join('\n'));
    if (bundle?.workflow) { setWorkflowName(bundle.workflow.name); setTasks(bundle.workflow.tasks); setSelectedTask(bundle.workflow.tasks[0]?.id || ''); }
  }, [bundle]);
  if (!projectId) return <EmptyProject navigate={navigate} />;
  if (loading && !bundle) return <div className="page-loader"><LoaderCircle className="spin" />Loading workflow</div>;

  const saveBrief = async () => {
    setBusy('brief');
    try {
      await mutate(`/api/v1/projects/${projectId}/briefs`, { content: { objective, acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean), constraints: [] } });
      await reload(); notify('Brief revision created');
    } catch (error) { notify(error instanceof Error ? error.message : 'Brief failed', 'error'); } finally { setBusy(''); }
  };
  const saveWorkflow = async () => {
    setBusy('workflow');
    try { await mutate(`/api/v1/projects/${projectId}/workflows`, { name: workflowName, tasks }); await reload(); notify('Workflow revision created'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Workflow failed', 'error'); } finally { setBusy(''); }
  };
  const addContext = async () => {
    if (!note.trim()) return;
    setBusy('context');
    try {
      await mutate(`/api/v1/projects/${projectId}/context/sources`, { kind: 'note', title: 'AI Assist input', content: note });
      setNote(''); await loadContext(); notify('Context source added');
    } catch (error) { notify(error instanceof Error ? error.message : 'Context failed', 'error'); } finally { setBusy(''); }
  };
  const makePack = async () => {
    setBusy('pack');
    try { await mutate(`/api/v1/projects/${projectId}/context/packs`, { source_ids: sources.map((source) => source.id), selection: 'explicit' }); await loadContext(); notify('Context pack sealed'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Context pack failed', 'error'); } finally { setBusy(''); }
  };
  const displayed = tasks.find((task) => task.id === selectedTask) || tasks[0];
  const related = new Set(displayed ? [displayed.id, ...displayed.deps, ...tasks.filter((task) => task.deps.includes(displayed.id)).map((task) => task.id)] : []);
  const hoverRelated = new Set(hoveredTask ? [hoveredTask, ...(tasks.find((task) => task.id === hoveredTask)?.deps || []), ...tasks.filter((task) => task.deps.includes(hoveredTask)).map((task) => task.id)] : []);
  return (
    <div className="page">
      <div className="page-heading"><div><p className="eyebrow">{bundle?.name}</p><h1>Workflow</h1></div><div className="revision-pair"><span>Brief r{bundle?.brief?.revision || 0}</span><span>Workflow r{bundle?.workflow?.revision || 0}</span></div></div>
      <section className="panel brief-editor">
        <SectionTitle title="Project Brief" meta={bundle?.brief ? `Hash ${shortHash(bundle.brief.content_hash)}` : 'No revision'} action={<button className="button" disabled={busy === 'brief' || !objective.trim()} onClick={() => void saveBrief()}><Save size={16} />New revision</button>} />
        <div className="brief-grid"><label><span>Objective</span><textarea rows={4} value={objective} onChange={(event) => setObjective(event.target.value)} /></label><label><span>Acceptance</span><textarea rows={4} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder={'Tests pass\nDraft PR reviewed'} /></label></div>
      </section>
      <section className="panel context-strip">
        <SectionTitle title="AI Assist context" meta={`${sources.length} sources · ${packs.length} sealed packs`} action={<button className="button" disabled={!sources.length || busy === 'pack'} onClick={() => void makePack()}><PackageCheck size={16} />Seal pack</button>} />
        <div className="assist-input"><WandSparkles size={18} /><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add repository constraint or implementation signal" onKeyDown={(event) => { if (event.key === 'Enter') void addContext(); }} /><button className="icon-button" title="添加上下文" aria-label="添加上下文" disabled={!note.trim()} onClick={() => void addContext()}><Plus size={17} /></button></div>
        {packs[0] && <div className="pack-line"><Layers3 size={15} /><span className="mono">{shortHash(packs[0].pack_hash)}</span><span>{packs[0].source_ids.length} sources</span><Status value="sealed" /></div>}
      </section>
      <section className="panel workflow-editor">
        <SectionTitle title="Dynamic two-level DAG" meta={`${tasks.length} tasks`} action={<button className="button primary" disabled={busy === 'workflow' || !bundle?.brief} onClick={() => void saveWorkflow()}><Save size={16} />Save revision</button>} />
        <div className="workflow-name"><label><span>Name</span><input value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} /></label></div>
        <div className="dag-workspace">
          <div className="dag-board">
            {[1, 2].map((level) => (
              <div className="dag-level" key={level}><div className="dag-level-title">Level {level}</div>{tasks.filter((task) => task.level === level).map((task) => (
                <button key={task.id} className={`dag-task ${selectedTask === task.id ? 'selected' : ''} ${hoveredTask && !hoverRelated.has(task.id) ? 'dimmed' : ''} ${!hoveredTask && selectedTask && !related.has(task.id) ? 'muted' : ''}`} onClick={() => setSelectedTask(task.id)} onMouseEnter={() => setHoveredTask(task.id)} onMouseLeave={() => setHoveredTask('')}>
                  <span className={task.mode === 'write' ? 'task-mode write' : 'task-mode'}>{task.mode}</span><strong>{task.title}</strong><small>{task.id}</small>
                </button>
              ))}</div>
            ))}
          </div>
          <aside className="task-inspector">
            {displayed && <>
              <div className="inspector-head"><span className={displayed.mode === 'write' ? 'task-mode write' : 'task-mode'}>{displayed.mode}</span><span className="mono">{displayed.id}</span></div>
              <label><span>Title</span><input value={displayed.title} onChange={(event) => setTasks((rows) => rows.map((task) => task.id === displayed.id ? { ...task, title: event.target.value } : task))} /></label>
              <dl className="definition-list compact"><div><dt>Level</dt><dd>{displayed.level}</dd></div><div><dt>Depends on</dt><dd>{displayed.deps.join(', ') || 'none'}</dd></div><div><dt>Outputs</dt><dd>{displayed.outputs.join(', ') || 'none'}</dd></div></dl>
            </>}
          </aside>
        </div>
      </section>
    </div>
  );
}

type ExecutionEvent = { cursor: number; type: string; task_id?: string; created_at: string };

export function ExecutionPage({ projectId, navigate, notify }: WorkspacePageProps) {
  const { bundle } = useProjectBundle(projectId);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [selectedId, setSelectedId] = useState(() => sessionStorage.getItem(`aiws:v3:execution:${projectId}`) || '');
  const [selected, setSelected] = useState<Execution | null>(null);
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    if (!projectId) return;
    const [runs, contextPacks, reviewRows] = await Promise.all([
      api<Execution[]>(`/api/v1/projects/${projectId}/executions`),
      api<ContextPack[]>(`/api/v1/projects/${projectId}/context/packs`),
      api<Review[]>(`/api/v1/reviews?project_id=${projectId}`)
    ]);
    setExecutions(runs); setPacks(contextPacks); setReviews(reviewRows);
    setSelectedId((current) => current && runs.some((run) => run.id === current) ? current : runs[0]?.id || '');
  }, [projectId]);
  const loadSelected = useCallback(async () => {
    if (!selectedId) { setSelected(null); return; }
    setSelected(await api<Execution>(`/api/v1/executions/${selectedId}`));
  }, [selectedId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { sessionStorage.setItem(`aiws:v3:execution:${projectId}`, selectedId); void loadSelected(); }, [loadSelected, projectId, selectedId]);
  useEffect(() => {
    if (!selectedId || selected?.status !== 'running') return;
    const timer = setInterval(() => void loadSelected(), 700);
    return () => clearInterval(timer);
  }, [loadSelected, selected?.status, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    setEvents([]);
    const stream = new EventSource(`/api/v1/executions/${selectedId}/events`);
    const handler = (event: MessageEvent) => {
      const item = JSON.parse(event.data) as ExecutionEvent;
      setEvents((rows) => [...rows.filter((row) => row.cursor !== item.cursor), item].sort((a, b) => a.cursor - b.cursor).slice(-100));
      if (item.type.endsWith('completed') || item.type.endsWith('failed') || item.type.endsWith('human')) void loadSelected();
    };
    ['execution.created', 'execution.started', 'execution.completed', 'execution.awaiting_human', 'task.ready', 'task.running', 'task.completed', 'task.failed', 'task.awaiting_human'].forEach((name) => stream.addEventListener(name, handler as EventListener));
    return () => stream.close();
  }, [loadSelected, selectedId]);
  useEffect(() => {
    if (!projectId || selected?.status !== 'completed') { setDiff(''); return; }
    void api<{ diff: string }>(`/api/v1/projects/${projectId}/diff`).then((result) => setDiff(result.diff)).catch(() => setDiff(''));
  }, [projectId, selected?.status]);
  if (!projectId) return <EmptyProject navigate={navigate} />;

  const createExecution = async () => {
    setBusy('create');
    try {
      const execution = await mutate<Execution>(`/api/v1/projects/${projectId}/executions`, { context_pack_id: packs[0]?.id });
      setSelectedId(execution.id); await load(); notify('Execution created');
    } catch (error) { notify(error instanceof Error ? error.message : 'Execution failed', 'error'); } finally { setBusy(''); }
  };
  const startExecution = async () => {
    if (!selected) return;
    setBusy('start');
    try { await mutate(`/api/v1/executions/${selected.id}/start`, { expected_revision: selected.revision, mode: selected.status === 'awaiting_human' ? 'human_retry' : 'initial' }); await loadSelected(); notify('Execution started'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Start failed', 'error'); } finally { setBusy(''); }
  };
  const createReview = async () => {
    if (!selected) return;
    setBusy('review');
    try { await mutate('/api/v1/reviews', { project_id: projectId, execution_id: selected.id, kind: 'delivery_create', model_status: 'unavailable', suggestion: {} }); await load(); notify('Review opened'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Review failed', 'error'); } finally { setBusy(''); }
  };
  const executionReview = reviews.find((review) => review.execution_id === selectedId && review.kind === 'delivery_create');
  const approve = async () => {
    if (!executionReview) return;
    setBusy('approve');
    try { await mutate(`/api/v1/reviews/${executionReview.id}/decisions`, { decision: 'approved', note: 'Verified locally' }); await load(); notify('Review approved'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Decision failed', 'error'); } finally { setBusy(''); }
  };
  const createDelivery = async () => {
    if (!selected || !executionReview) return;
    setBusy('delivery');
    try { await mutate('/api/v1/deliveries', { project_id: projectId, execution_id: selected.id, review_id: executionReview.id, title: `${bundle?.name || 'AIWS'} changes`, body: 'Generated from immutable execution evidence.' }); notify('Draft PR delivery created'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Delivery failed', 'error'); } finally { setBusy(''); }
  };
  const downloadDiff = () => {
    const url = URL.createObjectURL(new Blob([diff], { type: 'text/x-diff' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${bundle?.name || 'workspace'}.diff`; anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="page execution-page">
      <div className="page-heading"><div><p className="eyebrow">{bundle?.name}</p><h1>Execution</h1></div><button className="button primary" disabled={!bundle?.brief || !bundle?.workflow || busy === 'create'} onClick={() => void createExecution()}><Plus size={16} />New execution</button></div>
      <div className="execution-toolbar">
        <label><span>Run</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{!executions.length && <option value="">No execution</option>}{executions.map((execution) => <option key={execution.id} value={execution.id}>{execution.id.slice(-8)} · {execution.status}</option>)}</select></label>
        {selected && <><Status value={selected.status} /><span className="pin"><span>Workflow</span>r{selected.workflow_revision}</span><span className="pin"><span>Brief</span>{shortHash(selected.brief_hash)}</span><span className="pin"><span>Repo</span>{shortHash(selected.repository_sha)}</span></>}
        <button className="button" disabled={!selected || !['queued', 'failed', 'awaiting_human'].includes(selected.status) || busy === 'start'} onClick={() => void startExecution()}>{selected?.status === 'running' ? <Square size={15} /> : <Play size={15} />}Run</button>
      </div>
      {!selected ? <div className="empty-state"><Activity size={28} /><h2>No execution</h2></div> : <div className="execution-grid">
        <section className="panel task-table-panel">
          <SectionTitle title="Task attempts" meta={`${selected.tasks.length} tasks`} />
          <div className="data-table task-table"><div className="table-head"><span>Task</span><span>Attempt</span><span>Mode</span><span>Status</span></div>{selected.tasks.map((task) => <div className="table-row" key={task.id}><span className="mono">{task.task_id}</span><span>#{task.attempt_no}</span><span>{task.mode.replaceAll('_', ' ')}</span><Status value={task.status} /></div>)}</div>
        </section>
        <section className="panel event-panel">
          <SectionTitle title="Event stream" meta={events.length ? `Cursor ${events.at(-1)?.cursor}` : 'Connected'} />
          <div className="event-list">{events.slice().reverse().map((event) => <div key={event.cursor}><span className="event-dot" /><span>{event.type}</span><small>{event.task_id || 'execution'}</small><time>{formatTime(event.created_at)}</time></div>)}{!events.length && <div className="list-empty">Waiting for events</div>}</div>
        </section>
        <section className="panel diff-panel">
          <SectionTitle title="Git Diff" meta={selected.status === 'completed' ? 'Managed repository' : 'Pending'} action={<button className="icon-button" title="下载 diff" aria-label="下载 diff" disabled={!diff} onClick={downloadDiff}><Download size={17} /></button>} />
          <pre>{diff || 'No repository changes captured for this execution.'}</pre>
        </section>
        <section className="panel review-panel">
          <SectionTitle title="Human review" meta="Draft PR gate" />
          {!executionReview && <button className="button" disabled={selected.status !== 'completed' || busy === 'review'} onClick={() => void createReview()}><ClipboardCheck size={16} />Open review</button>}
          {executionReview && <div className="review-state"><div><Status value={executionReview.decision?.decision || 'awaiting_human'} /><span>Model suggestion: {executionReview.model_status}</span></div>{!executionReview.decision && <button className="button" onClick={() => void approve()} disabled={busy === 'approve'}><Check size={16} />Approve</button>}{executionReview.decision?.decision === 'approved' && <button className="button primary" onClick={() => void createDelivery()} disabled={busy === 'delivery'}><GitPullRequest size={16} />Create draft PR</button>}</div>}
        </section>
      </div>}
    </div>
  );
}

export function AssetsPage({ projectId, navigate, notify }: WorkspacePageProps) {
  const [assets, setAssets] = useState<AssetVersion[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { if (projectId) setAssets(await api<AssetVersion[]>(`/api/v1/projects/${projectId}/assets`)); }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  if (!projectId) return <EmptyProject navigate={navigate} />;
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const content = await fileToBase64(file);
      await mutate(`/api/v1/projects/${projectId}/assets`, { name: file.name, media_type: file.type || 'application/octet-stream', content, encoding: 'base64' });
      setFile(null); await load(); notify('Asset version stored');
    } catch (error) { notify(error instanceof Error ? error.message : 'Upload failed', 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <div className="page-heading"><div><p className="eyebrow">Content addressed</p><h1>Assets</h1></div><label className="button"><Upload size={16} />Choose file<input type="file" hidden onChange={(event) => setFile(event.target.files?.[0] || null)} /></label></div>
      {file && <section className="upload-band"><FilePlus2 size={20} /><div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div><button className="icon-button" title="移除" aria-label="移除" onClick={() => setFile(null)}><Trash2 size={17} /></button><button className="button primary" disabled={busy} onClick={() => void upload()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}Upload</button></section>}
      <section className="panel">
        <SectionTitle title="Immutable versions" meta={`${assets.length} versions`} />
        <div className="data-table asset-table"><div className="table-head"><span>Name</span><span>Version</span><span>Hash</span><span>Size</span><span /></div>{assets.map((asset) => <div className="table-row" key={asset.id}><span><strong>{asset.name}</strong><small>{asset.media_type}</small></span><span>v{asset.version}</span><span className="mono">{shortHash(asset.cas_hash)}</span><span>{formatBytes(asset.byte_size)}</span><a className="icon-button" href={`/api/v1/assets/${asset.id}/content`} title="下载" aria-label={`下载 ${asset.name}`}><Download size={17} /></a></div>)}{!assets.length && <div className="list-empty">No asset versions</div>}</div>
      </section>
    </div>
  );
}

export function AuditPage({ notify }: WorkspacePageProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState('');
  const load = useCallback(async () => {
    try { setEvents(await api<AuditEvent[]>('/api/v1/audit?limit=300')); }
    catch (error) { notify(error instanceof Error ? error.message : 'Audit failed', 'error'); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);
  const filtered = useMemo(() => events.filter((event) => `${event.action} ${event.entity_type} ${event.entity_id}`.toLowerCase().includes(query.toLowerCase())), [events, query]);
  return (
    <div className="page">
      <div className="page-heading"><div><p className="eyebrow">Append only</p><h1>Audit</h1></div><div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter events" /></div></div>
      <section className="panel audit-panel">
        <SectionTitle title="Command history" meta={`${filtered.length} events`} action={<button className="icon-button" title="刷新" aria-label="刷新" onClick={() => void load()}><RefreshCw size={17} /></button>} />
        <div className="data-table audit-table"><div className="table-head"><span>Time</span><span>Action</span><span>Entity</span><span>Actor</span></div>{filtered.map((event) => <div className="table-row" key={event.id}><span>{formatTime(event.created_at)}</span><span><strong>{event.action}</strong></span><span className="mono">{event.entity_type}:{event.entity_id.slice(-10)}</span><span>{event.actor}</span></div>)}</div>
      </section>
    </div>
  );
}

export function SettingsPage(_: WorkspacePageProps) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  useEffect(() => { void api<Capabilities>('/api/v1/system/capabilities').then(setCapabilities); }, []);
  return (
    <div className="page settings-page">
      <div className="page-heading"><div><p className="eyebrow">Instance policy</p><h1>Settings</h1></div></div>
      <div className="settings-layout">
        <section className="panel">
          <SectionTitle title="Runner security" meta="Fixed profile" />
          <div className="security-summary"><ShieldCheck size={26} /><div><strong>Isolated broker</strong><span className="mono">{capabilities?.broker.runner_digest || 'probing'}</span></div><Status value={capabilities?.broker.status || 'checking'} /></div>
          <dl className="definition-list"><div><dt>CPU</dt><dd>2</dd></div><div><dt>Memory</dt><dd>4 GB</dd></div><div><dt>PIDs</dt><dd>512</dd></div><div><dt>Root filesystem</dt><dd>Read only</dd></div><div><dt>Capabilities</dt><dd>None</dd></div></dl>
        </section>
        <section className="panel">
          <SectionTitle title="GitHub App" meta="Single instance" />
          <div className="integration-row"><div><GitPullRequest size={18} /><span>Probe</span></div><Status value={capabilities?.github.status || 'checking'} /></div>
          <label className="toggle-line"><span><strong>Draft PR only</strong><small>Merge requires a separate review</small></span><input type="checkbox" checked readOnly /></label>
        </section>
        <section className="panel">
          <SectionTitle title="Review policy" meta="Human decision" />
          <label className="toggle-line"><span><strong>Model suggestions</strong><small>Never prefill a decision</small></span><input type="checkbox" checked readOnly /></label>
          <label className="toggle-line"><span><strong>Automatic correction</strong><small>One attempt before human retry</small></span><input type="checkbox" checked readOnly /></label>
        </section>
      </div>
    </div>
  );
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return dataUrl.split(',', 2)[1] || '';
}
