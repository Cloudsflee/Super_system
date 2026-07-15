import {
  ArrowLeft, ArrowRight, BrainCircuit, CheckCircle2, FileStack, FolderGit2,
  LoaderCircle, RefreshCw, UploadCloud
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, json, multipart } from '../../../api/client';
import { keys, useDeployment, useProjectOnboarding } from '../../../api/queries';
import type {
  BriefSection, BriefTemplate, ProjectBrief, ProjectCodeSource, ProjectIntakeMode, ProjectOnboarding, Workflow, WorkflowDraft, WorkflowDraftNode
} from '../../../api/types';
import { FullPageState } from '../../../components/common/FullPageState';
import { useUi } from '../../../state/ui';
import {
  CompletedOnboarding, StepButton,
  codeSource, contextFromRecord, emptyAnswers, hasSavedAnswers, intakePayload,
  shortHash, sourcePlaceholder, toAnswerDraft,
  type AnswerDraft, type ContextDraft
} from './onboarding-support';
import { useProjectBriefAssistSurface } from './useProjectBriefAssistSurface';
import { BriefWorkspace } from './BriefWorkspace';

type Step = 'mode' | 'intake' | 'review';
type IntakeUpdate = Pick<ProjectOnboarding, 'project' | 'intake' | 'brief' | 'workflow_draft'>;

const listFields: Array<{ key: Exclude<keyof AnswerDraft, 'goal'>; label: string; hint: string }> = [
  { key: 'users', label: '目标用户', hint: '每行一个用户群体' },
  { key: 'features', label: '范围内功能', hint: '每行一个核心功能或交付项' },
  { key: 'scope_out', label: '范围外事项', hint: '本版本明确不做的内容' },
  { key: 'constraints', label: '约束', hint: '技术、时间、合规或资源约束' },
  { key: 'milestones', label: '里程碑', hint: '每行一个可检查的阶段' },
  { key: 'acceptance_criteria', label: '验收标准', hint: '每行一条可验证标准' },
  { key: 'risks', label: '风险', hint: '已知风险或关键假设' },
  { key: 'open_questions', label: '开放问题', hint: '仍需确认的问题' }
];

const sourceLabels: Record<ProjectCodeSource['type'], string> = {
  github: 'GitHub Repository', git: 'Git URL', local_directory: '本地目录',
  local_git: '本地 Git 仓库', archive: 'ZIP / TAR 归档'
};

export function ProjectOnboardingPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const ui = useUi();
  const query = useProjectOnboarding(projectId);
  const deployment = useDeployment();
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<ProjectIntakeMode | null>(null);
  const [answers, setAnswers] = useState<AnswerDraft>(emptyAnswers());
  const [sourceType, setSourceType] = useState<ProjectCodeSource['type']>('github');
  const [sourceValue, setSourceValue] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [contexts, setContexts] = useState<ContextDraft[]>([]);
  const hydrated = useRef('');
  const containerDeployment = deployment.data?.mode === 'container';
  const relativeImports = Boolean(containerDeployment && deployment.data?.imports.projects_root);
  const localPathAvailable = !containerDeployment || relativeImports;
  const sourceEntries = Object.entries(sourceLabels).filter(([value]) => localPathAvailable || value !== 'local_git');
  const templates = useQuery({ queryKey: ['brief-templates'], queryFn: () => api<{ items: BriefTemplate[] }>('/brief-templates'), enabled: Boolean(projectId) });

  useProjectBriefAssistSurface(projectId, setBriefField);

  function setBriefField(key: keyof AnswerDraft, value: unknown) {
    setAnswers((current) => ({ ...current, [key]: String(value ?? '') }));
    setStep('intake');
  }

  useEffect(() => { if (!localPathAvailable && sourceType === 'local_git') { setSourceType('github'); setSourceValue(''); } }, [localPathAvailable, sourceType]);

  useEffect(() => {
    const value = query.data;
    if (!value) return;
    const signature = `${value.project.id}:${value.intake?.revision || 0}`;
    if (hydrated.current === signature) return;
    hydrated.current = signature;
    const intakeMode = value.intake?.mode || null;
    setMode(intakeMode);
    setAnswers(toAnswerDraft(value.intake?.answers || {}, value.brief?.content.goal || value.project.goal));
    const source = value.intake?.code_source;
    if (source) {
      setSourceType(source.type);
      setSourceValue(source.path || source.url || source.repository_url || '');
    } else { setSourceType('github'); setSourceValue(''); }
    setUploadFiles([]);
    setContexts((value.intake?.context_sources || []).map((item, index) => contextFromRecord(item, index)));
    setStep(intakeMode ? (value.brief && hasSavedAnswers(value.intake?.answers) ? 'review' : 'intake') : 'mode');
  }, [query.data]);

  function mergeUpdate(result: IntakeUpdate) {
    if (!projectId) return;
    client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId), (current) => current ? {
      ...current, ...result,
      briefs: result.brief ? [result.brief, ...current.briefs.filter((item) => item.id !== result.brief?.id)] : current.briefs,
      can_confirm: Boolean(result.intake.mode && result.brief && !result.intake.last_error)
    } : current);
  }

  const chooseMode = useMutation({
    mutationFn: (next: ProjectIntakeMode) => api<IntakeUpdate>(`/projects/${projectId}/intake`, json('PUT', { mode: next })),
    onSuccess: (result, next) => { setMode(next); mergeUpdate(result); setStep('intake'); },
    onError: (error) => ui.toast(error.message, 'error')
  });

  const saveIntake = useMutation({
    mutationFn: () => api<IntakeUpdate>(`/projects/${projectId}/intake`, json('PUT', intakePayload(mode, answers, sourceType, sourceValue || uploadFiles[0]?.name || '', contexts, relativeImports))),
    onSuccess: (result) => { mergeUpdate(result); setStep('review'); ui.toast('项目简报与工作流草案已更新'); },
    onError: (error) => ui.toast(error.message, 'error')
  });

  const importSource = useMutation({
    mutationFn: () => {
      const operationKey = `web-import-${query.data?.intake.revision || 1}`;
      if (uploadFiles.length) {
        const form = new FormData(); form.set('operation_key', operationKey);
        for (const file of uploadFiles) form.append(sourceType === 'archive' ? 'code_archive' : 'code_file', file, file.webkitRelativePath || file.name);
        return api<{ job: { status: string }; project: ProjectOnboarding['project'] }>(`/projects/${projectId}/imports`, multipart('POST', form));
      }
      return api<{ job: { status: string }; project: ProjectOnboarding['project'] }>(`/projects/${projectId}/imports`, json('POST', { code_source: codeSource(sourceType, sourceValue, relativeImports), operation_key: operationKey }));
    },
    onSuccess: async () => { await query.refetch(); await client.invalidateQueries({ queryKey: keys.projects }); ui.toast('代码源已导入受管 workspace'); },
    onError: (error) => { void query.refetch(); ui.toast(error.message, 'error'); }
  });

  const patchBrief = useMutation({
    mutationFn: (operations: Array<Record<string, unknown> & { type: string }>) => api<ProjectBrief>(`/projects/${projectId}/briefs/${query.data?.brief?.id}`, json('PATCH', { expected_revision: query.data?.brief?.revision, operations })),
    onSuccess: (brief) => client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId || ''), (current) => current ? { ...current, brief, briefs: [brief, ...current.briefs.filter((item) => item.id !== brief.id)] } : current),
    onError: (error) => { void query.refetch(); ui.toast(error.message, 'error'); }
  });

  const patchWorkflow = useMutation({
    mutationFn: (operations: Array<Record<string, unknown> & { type: string }>) => api<WorkflowDraft>(`/projects/${projectId}/workflow-draft`, json('PATCH', { expected_revision: query.data?.workflow_draft?.revision, operations })),
    onSuccess: (workflow_draft) => client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId || ''), (current) => current ? { ...current, workflow_draft } : current),
    onError: (error) => { void query.refetch(); ui.toast(error.message, 'error'); }
  });

  const saveTemplate = useMutation({
    mutationFn: () => api<BriefTemplate>('/brief-templates', json('POST', { confirmed: true, title: `${query.data?.brief?.content.title || query.data?.project.title || '项目'}模板`, domain: 'general', sections: query.data?.brief?.content.sections || [], applicability: query.data?.brief?.content.summary || null })),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['brief-templates'] }); ui.toast('已保存到个人模板库'); },
    onError: (error) => ui.toast(error.message, 'error')
  });

  const applyTemplate = useMutation({
    mutationFn: (template: BriefTemplate) => api<ProjectBrief>(`/projects/${projectId}/briefs/${query.data?.brief?.id}/apply-template`, json('POST', { template_id: template.id, expected_revision: query.data?.brief?.revision })),
    onSuccess: (brief) => { client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId || ''), (current) => current ? { ...current, brief, briefs: [brief, ...current.briefs.filter((item) => item.id !== brief.id)] } : current); ui.toast('模板已无损合并到简报'); },
    onError: (error) => { void query.refetch(); ui.toast(error.message, 'error'); }
  });

  const confirm = useMutation({
    mutationFn: () => { const workflow = normalizeWorkflowDraft(query.data?.workflow_draft, projectId || 'project'), currentBrief = query.data?.brief ? normalizeBrief(query.data.brief, query.data.project.title) : null; return api<{ project: ProjectOnboarding['project']; workflow: Workflow; route?: string }>(`/projects/${projectId}/onboarding/confirm`, json('POST', { workflow_nodes: workflow?.nodes || [], expected_brief_revision: currentBrief?.revision, expected_workflow_revision: workflow?.revision })); },
    onSuccess: async (result) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.projects }),
        client.invalidateQueries({ queryKey: keys.project(projectId || '') }),
        client.invalidateQueries({ queryKey: keys.onboarding(projectId || '') })
      ]);
      ui.setProject(result.project.id);
      ui.toast('项目简报已确认，工作流现已激活');
      navigate(result.route || `/projects/${result.project.id}/workflow`);
    },
    onError: (error) => ui.toast(error.message, 'error')
  });

  if (query.isLoading) return <FullPageState title="正在恢复项目引导" />;
  if (query.isError || !query.data) return <FullPageState title="项目引导加载失败" detail={query.error?.message} retry={query.refetch} />;
  const data = query.data;
  if (data.project.status !== 'draft') return <CompletedOnboarding title={data.project.title} onOpen={() => navigate(`/projects/${data.project.id}/workflow`)} />;
  const brief = data.brief ? normalizeBrief(data.brief, data.project.title) : null;
  const workflowDraft = normalizeWorkflowDraft(data.workflow_draft, data.project.id);
  const sourceReady = mode !== 'existing' || data.project.managed_workspace_state === 'ready';
  const answersSaved = hasSavedAnswers(data.intake.answers);
  const latestImport = data.imports[0];
  const canSave = Boolean(mode && answers.goal.trim() && (mode !== 'existing' || sourceValue.trim() || uploadFiles.length));
  const workflowReady = Boolean(workflowDraft?.nodes.length && workflowDraft.nodes.every((node) => node.title.trim() && node.goal.trim()));
  const canConfirm = Boolean(data.can_confirm && answersSaved && workflowReady && sourceReady);

  return (
    <section className="onboarding-page">
      <header className="onboarding-header">
        <button className="icon-button" aria-label="返回项目" onClick={() => navigate('/projects')}><ArrowLeft size={18} /></button>
        <div><span className="overline">PROJECT ONBOARDING · DRAFT</span><h1>{data.project.title}</h1><p>确认简报和初始工作流后才会激活。所有代码将进入 AIWS 受管副本。</p></div>
        <span className="status pending">{data.project.status}</span>
      </header>
      <nav className="onboarding-steps" aria-label="项目引导步骤">
        <StepButton index="1" label="选择起点" active={step === 'mode'} done={Boolean(mode)} onClick={() => setStep('mode')} />
        <StepButton index="2" label="补充简报" active={step === 'intake'} done={Boolean(brief && mode)} disabled={!mode} onClick={() => setStep('intake')} />
        <StepButton index="3" label="审查并激活" active={step === 'review'} done={false} disabled={!brief || !mode || !answersSaved} onClick={() => setStep('review')} />
      </nav>

      <div className="onboarding-content">
        {step === 'mode' && <section className="onboarding-stage mode-stage">
          <div className="stage-heading"><span className="overline">STARTING POINT</span><h2>这个项目从哪里开始？</h2><p>选择会立即保存，刷新页面后仍可继续。</p></div>
          <div className="mode-cards">
            <button className={mode === 'brainstorm' ? 'selected' : ''} disabled={chooseMode.isPending} onClick={() => chooseMode.mutate('brainstorm')}>
              <BrainCircuit size={25} /><strong>从 0 头脑风暴</strong><span>通过目标、用户、范围和验收问题形成第一版项目简报。</span><i>不需要现有代码</i>
            </button>
            <button className={mode === 'existing' ? 'selected' : ''} disabled={chooseMode.isPending} onClick={() => chooseMode.mutate('existing')}>
              <FolderGit2 size={25} /><strong>基于已有项目</strong><span>导入 GitHub、Git URL、本地目录、Git 仓库或归档的只读副本。</span><i>外部源不会被修改</i>
            </button>
          </div>
          {chooseMode.isPending && <div className="inline-progress"><LoaderCircle className="spin" size={16} />正在保存选择</div>}
        </section>}

        {step === 'intake' && <section className="onboarding-stage intake-stage">
          <div className="stage-heading"><span className="overline">PROJECT INTAKE</span><h2>{mode === 'existing' ? '描述项目并选择代码源' : '建立可验证的项目简报'}</h2><p>不知道的内容可先留在开放问题中，之后可以生成新版本。</p></div>
          <div className="intake-grid">
            <div className="answer-form">
              <label>核心目标<textarea id="brief-goal" rows={5} value={answers.goal} onChange={(event) => setAnswers({ ...answers, goal: event.target.value })} placeholder="希望为谁解决什么问题，最终交付什么可验证结果？" /></label>
              {listFields.map((field) => <label key={field.key}>{field.label}<textarea id={`brief-${field.key.replaceAll('_', '-')}`} rows={field.key === 'features' || field.key === 'acceptance_criteria' ? 5 : 3} value={answers[field.key]} onChange={(event) => setAnswers({ ...answers, [field.key]: event.target.value })} placeholder={field.hint} /></label>)}
            </div>
            <aside className="intake-sources">
              {mode === 'existing' && <section className="source-card">
                <header><FolderGit2 size={17} /><div><strong>代码源</strong><small>只读扫描后复制或 clone 到受管 workspace</small></div></header>
                <label>来源类型<select value={sourceType} onChange={(event) => { setSourceType(event.target.value as ProjectCodeSource['type']); setSourceValue(''); setUploadFiles([]); }}>{sourceEntries.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                {(sourceType === 'github' || sourceType === 'git' || localPathAvailable) && <label>{sourceType === 'github' || sourceType === 'git' ? 'Repository URL' : relativeImports ? '导入根下的相对路径' : '本机绝对路径'}<input value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder={sourcePlaceholder(sourceType, relativeImports)} /></label>}
                {['local_directory', 'archive'].includes(sourceType) && <label>或从浏览器上传<input type="file" multiple={sourceType === 'local_directory'} accept={sourceType === 'archive' ? '.zip,.tar,.tgz,.gz' : undefined} {...(sourceType === 'local_directory' ? { webkitdirectory: '', directory: '' } : {})} onChange={(event) => { const files = [...(event.target.files || [])]; setUploadFiles(files); if (files[0]) setSourceValue(files[0].webkitRelativePath || files[0].name); }} /><small>{uploadFiles.length ? `已选择 ${uploadFiles.length} 个文件` : '上传内容同样先进入 staging 校验'}</small></label>}
                <p><CheckCircle2 size={13} />不会原地修改或删除外部目录和远端 Repository。</p>
              </section>}
            </aside>
          </div>
          <div className="stage-actions"><button className="button secondary" onClick={() => setStep('mode')}><ArrowLeft size={15} />返回</button><button className="button primary" disabled={!canSave || saveIntake.isPending} onClick={() => saveIntake.mutate()}>{saveIntake.isPending ? <LoaderCircle className="spin" size={15} /> : <FileStack size={15} />}保存并生成简报<ArrowRight size={15} /></button></div>
        </section>}

        {step === 'review' && brief && <section className="onboarding-stage review-stage">
          <div className="stage-heading"><span className="overline">BRIEF V{brief.version} · REVIEW</span><h2>审查项目简报与初始工作流</h2><p>确认后将原子创建节点并激活项目；工作流节点标题和目标可在此调整。</p></div>
          {data.intake.last_error && <div className="onboarding-alert" role="alert"><strong>上次处理失败</strong><span>{data.intake.last_error}</span><button className="button secondary" onClick={() => setStep('intake')}><RefreshCw size={14} />修正输入</button></div>}
          {workflowDraft && <BriefWorkspace brief={brief} workflow={workflowDraft} templates={templates.data?.items || []} busy={patchBrief.isPending || patchWorkflow.isPending || applyTemplate.isPending || saveTemplate.isPending} onBrief={async (operations) => { try { await patchBrief.mutateAsync(operations); return true; } catch { return false; } }} onWorkflow={async (operations) => { try { await patchWorkflow.mutateAsync(operations); return true; } catch { return false; } }} onSaveTemplate={() => saveTemplate.mutate()} onApplyTemplate={(template) => applyTemplate.mutate(template)} onSearchTemplates={() => { ui.setAssist(true); window.dispatchEvent(new CustomEvent('aiws:assist-prefill', { detail: { prompt: `请使用启用 Web Search 的 Profile，为“${brief.content.title}”检索 2-3 个权威简报模板，比较发布方、时效、适用性、局限、来源链接和推荐理由。` } })); }} />}
          {mode === 'existing' && <section className={`import-card ${sourceReady ? 'ready' : ''}`}>
            <div>{sourceReady ? <CheckCircle2 size={20} /> : <UploadCloud size={20} />}<span><strong>{sourceReady ? '受管代码副本已就绪' : '导入代码源到受管 workspace'}</strong><small>{sourceReady ? `源 hash ${shortHash(data.project.source_hash)}` : '确认外部源只读校验、clone/copy 和落盘结果后才能激活'}</small></span></div>
            {latestImport && <span className={`status ${latestImport.status === 'succeeded' ? 'ready' : latestImport.status === 'failed' ? 'failed' : 'pending'}`}>{latestImport.status}{latestImport.error_code ? ` · ${latestImport.error_code}` : ''}</span>}
            {!sourceReady && <button className="button secondary" disabled={importSource.isPending || (!sourceValue.trim() && !uploadFiles.length)} onClick={() => importSource.mutate()}>{importSource.isPending ? <LoaderCircle className="spin" size={15} /> : <UploadCloud size={15} />}{importSource.isPending ? '正在校验并导入' : '开始导入'}</button>}
          </section>}
          <div className="stage-actions"><button className="button secondary" onClick={() => setStep('intake')}><ArrowLeft size={15} />修改简报</button><button className="button primary" disabled={!canConfirm || confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}{sourceReady ? '确认简报并激活项目' : '请先完成代码导入'}</button></div>
        </section>}
      </div>
    </section>
  );
}

function normalizeWorkflowDraft(value: ProjectOnboarding['workflow_draft'] | unknown, projectId: string): WorkflowDraft | null {
  if (!value) return null;
  if (!Array.isArray(value)) return value as WorkflowDraft;
  const ids = value.map((node, index) => String((node as Partial<WorkflowDraftNode>).id || `legacy-node-${index + 1}`));
  const nodes = value.map((entry, index) => { const node = entry as Partial<WorkflowDraftNode> & { dependency_indexes?: number[] }; return { id: ids[index], type: node.type || 'execution', title: node.title || '新节点', goal: node.goal || node.title || '', dependency_ids: node.dependency_ids || (node.dependency_indexes || []).map((dependencyIndex) => ids[dependencyIndex]).filter(Boolean), position: node.position || { x: 80 + index * 310, y: 120 }, order: index }; });
  return { id: `legacy-draft-${projectId}`, project_id: projectId, revision: 1, nodes };
}

function normalizeBrief(value: ProjectBrief, projectTitle: string): ProjectBrief {
  if (Array.isArray(value.content?.sections)) return { ...value, revision: value.revision || value.version || 1 };
  const content = value.content as ProjectBrief['content'] & Record<string, unknown>, definitions: Array<[string, string, 'markdown' | 'list', unknown]> = [
    ['goal', '核心目标', 'markdown', content.goal], ['users', '目标用户', 'list', content.users], ['scope_in', '范围内', 'list', content.scope?.in], ['scope_out', '范围外', 'list', content.scope?.out], ['constraints', '约束', 'list', content.constraints], ['milestones', '里程碑', 'list', content.milestones], ['acceptance_criteria', '验收标准', 'list', content.acceptance_criteria], ['risks', '风险', 'list', content.risks], ['open_questions', '开放问题', 'list', content.open_questions]
  ];
  const sections = definitions.map(([key, title, type, raw]) => type === 'markdown' ? { id: `${value.id}-${key}`, semantic_key: key, title, type, markdown: String(raw || '') } : { id: `${value.id}-${key}`, semantic_key: key, title, type, items: Array.isArray(raw) ? raw.map(String) : [] }) as BriefSection[];
  return { ...value, revision: value.revision || value.version || 1, content: { ...content, schema_version: 2, title: `${projectTitle}简报`, summary: String(content.goal || '尚未形成项目摘要'), sections, template_ref: null, material_references: [] } };
}
