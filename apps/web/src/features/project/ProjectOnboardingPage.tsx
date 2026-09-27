import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, ChevronRight, CircleAlert, Github, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { ApiError, apiV2, mutateV2 } from '../../api';
import type { WorkspacePageProps } from '../../workspace';
import { errorCodeLabel, statusLabel } from '../../i18n';

type ProjectRecord = { id: string; name: string; status: string; onboarding_state?: string; revision: number };
type Intake = { id: string; status: string; mode: 'brainstorm' | 'existing'; source_kind?: string; source_revision?: string; source_hash?: string; error_code?: string; attempt: number; revision: number };
type GithubRepository = { id: number; full_name: string; default_branch?: string };

/** The onboarding surface owns only initial Intake. All Brief/Workflow mutations live in ProjectWorkflowPage. */
export function deriveProjectOnboardingStep(_project: ProjectRecord | null, intake: Intake | null): 1 | 2 | 3 {
  return intake?.status === 'ready' ? 2 : 1;
}

function Status({ value }: { value?: string }) {
  const status = value || 'pending';
  const tone = ['ready', 'active', 'confirmed'].includes(status) ? 'positive' : ['processing', 'queued', 'running'].includes(status) ? 'working' : ['failed', 'stale', 'rejected', 'cancelled'].includes(status) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{statusLabel(status)}</span>;
}

export function ProjectOnboardingPage({ projectId, navigateProject, notify }: WorkspacePageProps) {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [profiles, setProfiles] = useState<Array<{ id: string; provider: string; status: string; lifecycle_status?: string }>>([]);
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

  const load = useCallback(async () => {
    if (!projectId) { setLoadState('error'); setFailure('项目未选择'); return; }
    try {
      const id = encodeURIComponent(projectId);
      const [projectResult, intakeResult, profileResult] = await Promise.all([
        apiV2<{ project: ProjectRecord }>(`/api/v2/projects/${id}`),
        apiV2<{ intake: Intake }>(`/api/v2/projects/${id}/intake`),
        apiV2<{ profiles: Array<{ id: string; provider: string; status: string; lifecycle_status?: string }> }>('/api/v2/profiles')
      ]);
      setProject(projectResult.data.project); setIntake(intakeResult.data.intake || null); setProfiles(profileResult.data.profiles || []);
      setFailure(''); setLoadState('ready');
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setFailure(apiError?.message || (error instanceof Error ? error.message : '项目引导加载失败'));
      setLoadState(apiError && [401, 403].includes(apiError.status) ? 'denied' : 'error');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setFailure(''); setConflict('');
    try { await action(); await load(); }
    catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 409 || apiError?.code === 'revision_conflict') setConflict(apiError.message);
      else setFailure(apiError?.message || (error instanceof Error ? error.message : 'Intake 操作失败'));
      notify(apiError?.message || 'Intake 操作失败', 'error');
    } finally { setBusy(''); }
  };

  const discoverGithub = () => void run('discover', async () => {
    const profile = profiles.find((item) => item.provider === 'github' && item.status === 'available' && item.lifecycle_status !== 'disabled');
    if (!profile) throw new Error('请先在设置中验证 GitHub Profile');
    const result = await apiV2<{ repositories: GithubRepository[] }>(`/api/v2/provider-profiles/${encodeURIComponent(profile.id)}/repositories`);
    setRepositories(result.data.repositories || []);
  });

  const submitIntake = (event: FormEvent) => {
    event.preventDefault();
    void run('intake', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/intake`, {
      mode,
      source: mode === 'existing' ? { kind: selectedRepository ? 'github' : 'opaque', locator: sourceLocator.trim(), revision: sourceRevision.trim() } : {},
      content: mode === 'brainstorm' ? { idea: idea.trim() } : { read_only: true }
    }, 'POST', intake?.revision));
  };

  const retryIntake = () => void run('intake-retry', () => mutateV2(`/api/v2/projects/${encodeURIComponent(projectId)}/intake/retry`, {}, 'POST', intake?.revision));
  const step = deriveProjectOnboardingStep(project, intake);
  const complete = step === 2;

  if (loadState === 'loading') return <div className="page-loader" data-testid="project-onboarding-loading"><LoaderCircle className="spin" size={18} />加载项目引导</div>;
  if (loadState !== 'ready') return <div className="page project-onboarding-page"><div className={`state-banner ${loadState === 'denied' ? 'denied' : 'error'}`} role="alert">{failure}<button className="icon-button" aria-label="重试" title="重试" onClick={() => void load()}><RefreshCw size={15} /></button></div></div>;

  return <div className="page project-onboarding-page" data-testid="project-onboarding" data-step={step}>
    <div className="project-onboarding-heading"><div><p className="eyebrow">项目引导</p><h1>{project?.name}</h1><span>先完成 Intake，再进入统一 Workflow 工作台</span></div><Status value={complete ? 'ready' : project?.status} /></div>
    <ol className="project-stepper" aria-label="项目引导进度"><li className={step === 1 ? 'active' : 'complete'}><span>{step > 1 ? <Check size={13} /> : 1}</span><strong>项目来源 Intake</strong></li><li className={step === 2 ? 'active' : ''}><span>{step === 2 ? <Check size={13} /> : 2}</span><strong>Workflow 工作台</strong></li></ol>
    {conflict && <div className="state-banner conflict" data-testid="project-onboarding-conflict"><AlertTriangle size={17} /><span>{conflict}</span><button className="button" onClick={() => void load()}>重新加载</button></div>}
    {failure && <div className="state-banner error" role="alert"><CircleAlert size={17} /><span>{failure}</span></div>}
    {step === 1 ? <section className="onboarding-workstage"><div className="workstage-title"><span>1</span><div><h2>选择项目来源</h2><small>Intake 尝试次数 {intake?.attempt || 0}</small></div><Status value={intake?.status} /></div>{intake?.status === 'failed' ? <div className="intake-retry"><CircleAlert size={20} /><div><strong>{errorCodeLabel(intake.error_code || 'intake_failed')}</strong><small>保留原源版本后重试</small></div><button className="button" disabled={Boolean(busy)} onClick={retryIntake}><RotateCcw size={15} />重试 Intake</button></div> : <form className="project-intake-form" onSubmit={submitIntake}><div className="segmented" role="group" aria-label="项目来源"><button type="button" className={mode === 'brainstorm' ? 'active' : ''} onClick={() => setMode('brainstorm')}>从零构思</button><button type="button" className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>已有项目</button></div>{mode === 'brainstorm' ? <label><span>初始构想</span><textarea aria-label="初始构想" rows={6} value={idea} onChange={(event) => setIdea(event.target.value)} /></label> : <><div className="github-discovery-row"><button type="button" className="button" onClick={discoverGithub} disabled={busy === 'discover'}><Github size={15} />发现 GitHub 仓库</button>{repositories.length > 0 && <select aria-label="GitHub 仓库" value={selectedRepository} onChange={(event) => { const value = event.target.value; const repository = repositories.find((item) => item.full_name === value); setSelectedRepository(value); setSourceLocator(value); setSourceRevision(repository?.default_branch || 'main'); }}><option value="">选择仓库</option>{repositories.map((item) => <option key={item.id} value={item.full_name}>{item.full_name}</option>)}</select>}</div><div className="two-column"><label><span>源地址</span><input aria-label="源地址" value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} required /></label><label><span>源版本</span><input aria-label="源版本" value={sourceRevision} onChange={(event) => setSourceRevision(event.target.value)} /></label></div><div className="readonly-note"><Check size={13} />只记录只读来源和代码仓库元数据</div></>}<button className="button primary" disabled={Boolean(busy) || ['processing', 'submitted'].includes(intake?.status || '') || (mode === 'existing' && !sourceLocator.trim())}>{busy === 'intake' || ['processing', 'submitted'].includes(intake?.status || '') ? <LoaderCircle className="spin" size={15} /> : <ChevronRight size={15} />}提交 Intake</button></form>}</section> : <section className="onboarding-workstage"><div className="workstage-title"><span>2</span><div><h2>Intake 已完成</h2><small>Brief、Workflow、Generation、Critic 和 Confirm 均由统一 Workflow 工作台负责</small></div><Check size={19} /></div><p className="readonly-note">项目的后续编辑和业务 mutation 已收敛到 Project Workflow。</p><button className="button primary" onClick={() => navigateProject?.(projectId, 'workflow')}><ChevronRight size={15} />进入 Workflow 工作台</button></section>}
  </div>;
}
