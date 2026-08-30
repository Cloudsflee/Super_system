import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle, Check, ChevronRight, CircleAlert, FileText, Github, LoaderCircle,
  Play, RefreshCw, RotateCcw, Save, Sparkles, Workflow as WorkflowIcon
} from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type ProjectRecord = {
  id: string; name: string; description?: string; status: string; onboarding_state?: string;
  current_brief_revision: number; confirmed_brief_revision?: number | null;
  current_workflow_revision: number; revision: number;
};
type Intake = { id: string; status: string; mode: 'brainstorm' | 'existing'; source_kind?: string; source_revision?: string; source_hash?: string; error_code?: string; attempt: number; revision: number };
type BriefRevision = { revision: number; content: Record<string, unknown>; content_sha256?: string; template_id?: string | null; template_revision?: number | null };
type BriefHead = { current_revision: number; confirmed_revision?: number | null; current?: BriefRevision | null };
type Workflow = { id: string; status: string; current_revision: number; revision: number; current?: { graph?: Record<string, unknown>; graph_sha256?: string } | null };
type Generation = { id: string; phase: string; revision: number; proposal_id?: string | null; error_code?: string; attempt: number };
type BriefTemplate = { id: string; name: string; description?: string; current_revision: number; revision: number; content: Record<string, unknown> };
type ProviderProfile = { id: string; provider: string; status: string; lifecycle_status?: string };
type GithubRepository = { id: number; full_name: string; private?: boolean; default_branch?: string };

type BriefDraft = {
  objective: string; users: string; scopeIn: string; scopeOut: string; constraints: string;
  milestones: string; acceptance: string; risks: string; openQuestions: string;
};

const EMPTY_BRIEF: BriefDraft = { objective: '', users: '', scopeIn: '', scopeOut: '', constraints: '', milestones: '', acceptance: '', risks: '', openQuestions: '' };
const DEFAULT_WORKFLOW = JSON.stringify({ nodes: [{ id: 'discover', kind: 'workstream', title: 'Discovery' }, { id: 'deliver', kind: 'task', title: 'Delivery', parent_id: 'discover' }] }, null, 2);

export function deriveProjectOnboardingStep(project: ProjectRecord | null, intake: Intake | null): 1 | 2 | 3 {
  if (!project || intake?.status !== 'ready') return 1;
  if (Number(project.current_brief_revision || 0) < 1) return 2;
  return 3;
}

function listText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join('\n') : typeof value === 'string' ? value : '';
}

function draftFromContent(content: Record<string, unknown> = {}): BriefDraft {
  const scope = content.scope && typeof content.scope === 'object' && !Array.isArray(content.scope) ? content.scope as Record<string, unknown> : {};
  return {
    objective: typeof content.objective === 'string' ? content.objective : '',
    users: listText(content.users ?? content.target_users),
    scopeIn: listText(scope.in ?? content.scope_in),
    scopeOut: listText(scope.out ?? content.scope_out),
    constraints: listText(content.constraints),
    milestones: listText(content.milestones),
    acceptance: listText(content.acceptance),
    risks: listText(content.risks),
    openQuestions: listText(content.open_questions)
  };
}

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function Status({ value }: { value?: string }) {
  const status = value || 'pending';
  const tone = ['ready', 'active', 'confirmed', 'applied', 'proposed', 'critic_pending'].includes(status) ? 'positive' : ['processing', 'queued', 'running'].includes(status) ? 'working' : ['failed', 'stale', 'rejected', 'cancelled'].includes(status) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{status.replaceAll('_', ' ')}</span>;
}

export function ProjectOnboardingPage({ projectId, refreshProjects, navigateProject, notify }: WorkspacePageProps) {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [brief, setBrief] = useState<BriefHead | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [templates, setTemplates] = useState<BriefTemplate[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const [conflict, setConflict] = useState('');
  const [mode, setMode] = useState<'brainstorm' | 'existing'>('brainstorm');
  const [idea, setIdea] = useState('');
  const [sourceLocator, setSourceLocator] = useState('');
  const [sourceRevision, setSourceRevision] = useState('');
  const [selectedRepository, setSelectedRepository] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [continueAfterConfirm, setContinueAfterConfirm] = useState(false);
  const [briefDraft, setBriefDraft] = useState<BriefDraft>(EMPTY_BRIEF);
  const [workflowGraph, setWorkflowGraph] = useState(DEFAULT_WORKFLOW);
  const loadedBriefRevision = useRef(-1);
  const loadedWorkflowRevision = useRef(-1);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!projectId) { setLoadState('error'); setFailure('项目未选择'); return; }
    try {
      const id = encodeURIComponent(projectId);
      const [detailResult, intakeResult, briefResult, workflowResult, generationResult, templateResult, profileResult] = await Promise.all([
        apiV2<{ project: ProjectRecord; brief?: BriefHead; workflow?: Workflow }>(`/api/v2/projects/${id}`),
        apiV2<{ intake: Intake }>(`/api/v2/projects/${id}/intake`),
        apiV2<{ briefs: BriefRevision[] }>(`/api/v2/projects/${id}/briefs`),
        apiV2<{ workflow: Workflow }>(`/api/v2/projects/${id}/workflow-draft`),
        apiV2<{ generations: Generation[] }>(`/api/v2/projects/${id}/workflow-generations`),
        apiV2<{ templates: BriefTemplate[] }>('/api/v2/brief-templates'),
        apiV2<{ profiles: ProviderProfile[] }>('/api/v2/profiles')
      ]);
      const nextProject = detailResult.data.project;
      const revisions = briefResult.data.briefs || [];
      const detailBrief = detailResult.data.brief || null;
      const currentRevision = Number(detailBrief?.current_revision || nextProject.current_brief_revision || revisions[0]?.revision || 0);
      const currentContent = detailBrief?.current?.content || revisions.find((item) => item.revision === currentRevision)?.content || {};
      const nextWorkflow = workflowResult.data.workflow || detailResult.data.workflow || null;
      if (sequence !== loadSequence.current) return;
      setProject(nextProject);
      setIntake(intakeResult.data.intake || null);
      setBrief(detailBrief || { current_revision: currentRevision, confirmed_revision: nextProject.confirmed_brief_revision || null, current: revisions.find((item) => item.revision === currentRevision) || null });
      setWorkflow(nextWorkflow);
      setGenerations(generationResult.data.generations || []);
      setTemplates(templateResult.data.templates || []);
      setProfiles(profileResult.data.profiles || []);
      if (currentRevision !== loadedBriefRevision.current) { setBriefDraft(draftFromContent(currentContent)); loadedBriefRevision.current = currentRevision; }
      if (nextWorkflow && nextWorkflow.current_revision !== loadedWorkflowRevision.current) {
        if (nextWorkflow.current?.graph) setWorkflowGraph(JSON.stringify(nextWorkflow.current.graph, null, 2));
        loadedWorkflowRevision.current = nextWorkflow.current_revision;
      }
      setFailure('');
      setLoadState('ready');
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      const apiError = error instanceof ApiError ? error : null;
      setFailure(apiError?.message || (error instanceof Error ? error.message : '项目引导加载失败'));
      setLoadState(apiError && [401, 403].includes(apiError.status) ? 'denied' : 'error');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  const currentGeneration = generations[0] || null;
  useEffect(() => {
    if (!['processing', 'submitted'].includes(intake?.status || '') && !['queued', 'running'].includes(currentGeneration?.phase || '')) return undefined;
    const timer = setInterval(() => void load(), 300);
    return () => clearInterval(timer);
  }, [currentGeneration?.phase, intake?.status, load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setFailure(''); setConflict('');
    try {
      await action();
      await load();
      return true;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 409 || apiError?.code === 'revision_conflict') setConflict(apiError.message);
      else setFailure(apiError?.message || (error instanceof Error ? error.message : '命令失败'));
      notify(apiError?.message || '命令失败', 'error');
      return false;
    } finally { setBusy(''); }
  };

  const discoverGithub = () => void run('discover', async () => {
    const profile = profiles.find((item) => item.provider === 'github' && item.status === 'available' && item.lifecycle_status !== 'disabled');
    if (!profile) throw new Error('请先在设置中验证 GitHub Profile');
    const result = await apiV2<{ repositories: GithubRepository[] }>(`/api/v2/provider-profiles/${encodeURIComponent(profile.id)}/repositories`);
    setRepositories(result.data.repositories || []);
  });

  const selectGithubRepository = (fullName: string) => {
    const repository = repositories.find((item) => item.full_name === fullName);
    setSelectedRepository(fullName);
    setSourceLocator(fullName);
    setSourceRevision(repository?.default_branch || 'main');
  };

  const submitIntake = (event: FormEvent) => {
    event.preventDefault();
    void run('intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/intake`, {
      mode,
      source: mode === 'existing' ? { kind: selectedRepository ? 'github' : 'opaque', locator: sourceLocator.trim(), revision: sourceRevision.trim() } : {},
      content: mode === 'brainstorm' ? { idea: idea.trim() } : { read_only: true }
    }, 'POST', intake?.revision));
  };

  const retryIntake = () => void run('intake-retry', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/intake/retry`, {}, 'POST', intake?.revision));

  const applyTemplate = () => {
    const template = templates.find((item) => item.id === selectedTemplate);
    if (template) setBriefDraft(draftFromContent(template.content));
  };

  const saveBrief = (event: FormEvent) => {
    event.preventDefault();
    const template = templates.find((item) => item.id === selectedTemplate);
    const content = {
      objective: briefDraft.objective.trim(), users: lines(briefDraft.users),
      scope: { in: lines(briefDraft.scopeIn), out: lines(briefDraft.scopeOut) },
      constraints: lines(briefDraft.constraints), milestones: lines(briefDraft.milestones),
      acceptance: lines(briefDraft.acceptance), risks: lines(briefDraft.risks),
      open_questions: lines(briefDraft.openQuestions)
    };
    void run('brief', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/briefs`, {
      content, objective: content.objective, constraints: content.constraints, acceptance: content.acceptance,
      template: template?.name || 'default', ...(template ? { template_id: template.id, template_revision: template.current_revision } : {})
    }, 'POST', project?.revision));
  };

  const saveWorkflow = () => void run('workflow', async () => {
    let graph: Record<string, unknown>;
    try { graph = JSON.parse(workflowGraph) as Record<string, unknown>; } catch { throw new Error('Workflow JSON 格式错误'); }
    await mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/workflow-draft`, { graph, nodes: Array.isArray(graph.nodes) ? graph.nodes : [], layout: {} }, 'POST', workflow?.revision);
  });
  const generate = () => void run('generation', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/workflow-generations`, { mode: 'initial', candidate: {} }, 'POST', project?.revision));
  const retryGeneration = () => currentGeneration && void run('generation-retry', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(currentGeneration.id)}/retry`, {}, 'POST', currentGeneration.revision));
  const critic = () => currentGeneration && void run('critic', () => mutateV2(`/api/v2/workflow-generations/${encodeURIComponent(currentGeneration.id)}/critic`, { status: 'passed', issues: [] }, 'POST', currentGeneration.revision));
  const applyProposal = () => currentGeneration?.proposal_id && void run('apply', () => mutateV2(`/api/v2/workflow-proposals/${encodeURIComponent(currentGeneration.proposal_id || '')}/apply`, {}, 'POST', workflow?.revision));
  const confirmBrief = () => void (async () => {
    const revision = Number(brief?.current_revision || project?.current_brief_revision || 0);
    const confirmed = await run('confirm', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/briefs/${revision}/confirm`, { brief_revision: revision }, 'POST', project?.revision));
    if (confirmed) { await refreshProjects(); setContinueAfterConfirm(true); }
  })();

  const step = deriveProjectOnboardingStep(project, intake);
  const complete = project?.status === 'active' && project.onboarding_state === 'confirmed';
  useEffect(() => {
    if (complete && continueAfterConfirm) navigateProject?.(projectId, 'workflow');
  }, [complete, continueAfterConfirm, navigateProject, projectId]);

  if (loadState === 'loading') return <div className="page-loader" data-testid="project-onboarding-loading"><LoaderCircle className="spin" size={18} />加载项目引导</div>;
  if (loadState !== 'ready') return <div className="page project-onboarding-page"><div className={`state-banner ${loadState === 'denied' ? 'denied' : 'error'}`} role="alert">{failure}<button className="icon-button" aria-label="重试" title="重试" onClick={() => void load()}><RefreshCw size={15} /></button></div></div>;

  return <div className="page project-onboarding-page" data-testid="project-onboarding" data-step={step}>
    <div className="project-onboarding-heading"><div><p className="eyebrow">Project onboarding</p><h1>{project?.name}</h1><span>Brief 与 Workflow 初始化</span></div><Status value={complete ? 'confirmed' : project?.status} /></div>
    <ol className="project-stepper" aria-label="项目引导进度">{['项目来源', '完整 Brief', 'Workflow 审查'].map((label, index) => <li key={label} className={step === index + 1 ? 'active' : step > index + 1 || complete ? 'complete' : ''}><span>{step > index + 1 || complete ? <Check size={13} /> : index + 1}</span><strong>{label}</strong></li>)}</ol>
    {conflict && <div className="state-banner conflict" data-testid="project-onboarding-conflict"><AlertTriangle size={17} /><span>{conflict}</span><button className="button" onClick={() => void load()}>重新加载</button></div>}
    {failure && <div className="state-banner error" role="alert"><CircleAlert size={17} /><span>{failure}</span></div>}

    {step === 1 && <section className="onboarding-workstage"><div className="workstage-title"><span>1</span><div><h2>选择项目来源</h2><small>Intake attempt {intake?.attempt || 0}</small></div><Status value={intake?.status} /></div>{intake?.status === 'failed' ? <div className="intake-retry"><CircleAlert size={20} /><div><strong>{intake.error_code || 'intake_failed'}</strong><small>保留原 source revision 后重试</small></div><button className="button" disabled={Boolean(busy)} onClick={retryIntake}><RotateCcw size={15} />重试 Intake</button></div> : <form className="project-intake-form" onSubmit={submitIntake}><div className="segmented" role="group" aria-label="项目来源"><button type="button" className={mode === 'brainstorm' ? 'active' : ''} onClick={() => setMode('brainstorm')}>从零构思</button><button type="button" className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>已有项目</button></div>{mode === 'brainstorm' ? <label><span>初始构想</span><textarea aria-label="初始构想" rows={6} value={idea} onChange={(event) => setIdea(event.target.value)} /></label> : <><div className="github-discovery-row"><button type="button" className="button" onClick={discoverGithub} disabled={busy === 'discover'}><Github size={15} />发现 GitHub 仓库</button>{repositories.length > 0 && <select aria-label="GitHub 仓库" value={selectedRepository} onChange={(event) => selectGithubRepository(event.target.value)}><option value="">选择仓库</option>{repositories.map((item) => <option key={item.id} value={item.full_name}>{item.full_name}</option>)}</select>}</div><div className="two-column"><label><span>Source</span><input aria-label="Source" value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} required /></label><label><span>Revision</span><input aria-label="Source revision" value={sourceRevision} onChange={(event) => setSourceRevision(event.target.value)} /></label></div><div className="readonly-note"><Check size={13} />只记录只读 source / repository 元数据</div></>}<button className="button primary" disabled={Boolean(busy) || ['processing', 'submitted'].includes(intake?.status || '') || (mode === 'existing' && !sourceLocator.trim())}>{busy === 'intake' || ['processing', 'submitted'].includes(intake?.status || '') ? <LoaderCircle className="spin" size={15} /> : <ChevronRight size={15} />}提交 Intake</button></form>}</section>}

    {step === 2 && <section className="onboarding-workstage"><div className="workstage-title"><span>2</span><div><h2>编辑完整 Brief</h2><small>Project revision {project?.revision}</small></div><FileText size={19} /></div><form className="brief-onboarding-form" onSubmit={saveBrief}><div className="template-picker"><label><span>Brief template</span><select aria-label="Brief template" value={selectedTemplate} onChange={(event) => setSelectedTemplate(event.target.value)}><option value="">不使用模板</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name} · r{item.current_revision}</option>)}</select></label><button type="button" className="button" disabled={!selectedTemplate} onClick={applyTemplate}><Sparkles size={15} />应用模板</button></div><label><span>目标</span><textarea aria-label="目标" rows={3} value={briefDraft.objective} onChange={(event) => setBriefDraft((value) => ({ ...value, objective: event.target.value }))} required /></label><div className="brief-field-grid"><BriefField label="用户" value={briefDraft.users} setValue={(users) => setBriefDraft((value) => ({ ...value, users }))} /><BriefField label="范围内" value={briefDraft.scopeIn} setValue={(scopeIn) => setBriefDraft((value) => ({ ...value, scopeIn }))} /><BriefField label="范围外" value={briefDraft.scopeOut} setValue={(scopeOut) => setBriefDraft((value) => ({ ...value, scopeOut }))} /><BriefField label="约束" value={briefDraft.constraints} setValue={(constraints) => setBriefDraft((value) => ({ ...value, constraints }))} /><BriefField label="里程碑" value={briefDraft.milestones} setValue={(milestones) => setBriefDraft((value) => ({ ...value, milestones }))} /><BriefField label="验收" value={briefDraft.acceptance} setValue={(acceptance) => setBriefDraft((value) => ({ ...value, acceptance }))} /><BriefField label="风险" value={briefDraft.risks} setValue={(risks) => setBriefDraft((value) => ({ ...value, risks }))} /><BriefField label="开放问题" value={briefDraft.openQuestions} setValue={(openQuestions) => setBriefDraft((value) => ({ ...value, openQuestions }))} /></div><button className="button primary" disabled={busy === 'brief' || !briefDraft.objective.trim()}>{busy === 'brief' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存 Brief</button></form></section>}

    {step === 3 && <section className="onboarding-workstage"><div className="workstage-title"><span>3</span><div><h2>审查 Brief 与初始 Workflow</h2><small>Brief r{brief?.current_revision || 0} · Workflow r{workflow?.current_revision || 0}</small></div><Status value={complete ? 'confirmed' : currentGeneration?.phase || workflow?.status} /></div><div className="onboarding-review-grid"><div className="brief-review"><h3>Brief</h3><strong>{briefDraft.objective}</strong><dl><div><dt>用户</dt><dd>{lines(briefDraft.users).length}</dd></div><div><dt>验收</dt><dd>{lines(briefDraft.acceptance).length}</dd></div><div><dt>风险</dt><dd>{lines(briefDraft.risks).length}</dd></div><div><dt>开放问题</dt><dd>{lines(briefDraft.openQuestions).length}</dd></div></dl></div><label className="workflow-review"><span>Workflow JSON</span><textarea aria-label="Workflow JSON" rows={13} spellCheck={false} value={workflowGraph} onChange={(event) => setWorkflowGraph(event.target.value)} /></label></div><div className="onboarding-command-chain"><ChainItem done={Boolean(workflow?.current_revision)} label="初始 Workflow" detail={workflow?.current_revision ? `r${workflow.current_revision}` : '待保存'} /><ChainItem done={Boolean(currentGeneration)} active={Boolean(workflow?.current_revision && !currentGeneration)} label="Generation" detail={currentGeneration?.phase || '待执行'} /><ChainItem done={['proposed', 'applied'].includes(currentGeneration?.phase || '')} active={currentGeneration?.phase === 'critic_pending'} label="Critic" detail={currentGeneration?.phase === 'critic_pending' ? '等待审查' : currentGeneration?.phase || '待执行'} /><ChainItem done={currentGeneration?.phase === 'applied'} active={currentGeneration?.phase === 'proposed'} label="Proposal apply" detail={currentGeneration?.phase === 'applied' ? '已应用' : '待执行'} /><ChainItem done={complete} active={currentGeneration?.phase === 'applied' && !complete} label="确认 Brief" detail={complete ? '项目已激活' : '最后一步'} /></div><div className="onboarding-actions command-actions">{!workflow?.current_revision && <button className="button primary" disabled={Boolean(busy)} onClick={saveWorkflow}><Save size={15} />保存初始 Workflow</button>}{Boolean(workflow?.current_revision) && !currentGeneration && <button className="button primary" disabled={Boolean(busy)} onClick={generate}><Play size={15} />生成候选</button>}{['queued', 'running'].includes(currentGeneration?.phase || '') && <span className="command-running"><LoaderCircle className="spin" size={15} />Generation 运行中</span>}{currentGeneration?.phase === 'critic_pending' && <button className="button primary" disabled={Boolean(busy)} onClick={critic}><Check size={15} />执行 Critic</button>}{currentGeneration?.phase === 'proposed' && <button className="button primary" disabled={Boolean(busy)} onClick={applyProposal}><WorkflowIcon size={15} />应用 Proposal</button>}{['failed', 'rejected', 'cancelled'].includes(currentGeneration?.phase || '') && <button className="button" disabled={Boolean(busy)} onClick={retryGeneration}><RotateCcw size={15} />重试 Generation</button>}{currentGeneration?.phase === 'applied' && !complete && <button className="button primary" disabled={Boolean(busy)} onClick={confirmBrief}><Check size={15} />确认 Brief 并激活</button>}{complete && <button className="button primary" onClick={() => navigateProject?.(projectId, 'workflow')}><ChevronRight size={15} />进入 Workflow</button>}</div>{currentGeneration?.error_code && <div className="state-banner error"><CircleAlert size={16} />{currentGeneration.error_code}</div>}</section>}
  </div>;
}

function BriefField({ label, value, setValue }: { label: string; value: string; setValue: (value: string) => void }) {
  return <label><span>{label}</span><textarea aria-label={label} rows={4} value={value} onChange={(event) => setValue(event.target.value)} /></label>;
}

function ChainItem({ done, active = false, label, detail }: { done: boolean; active?: boolean; label: string; detail: string }) {
  return <div className={done ? 'done' : active ? 'active' : ''}><span>{done ? <Check size={13} /> : active ? <LoaderCircle className="spin" size={13} /> : null}</span><strong>{label}</strong><small>{detail}</small></div>;
}
