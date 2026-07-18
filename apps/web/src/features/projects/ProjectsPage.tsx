import { ArrowRight, FolderGit2, Plus, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, json } from '../../api/client';
import { keys, useProjects } from '../../api/queries';
import type { DraftProjectResult, Project } from '../../api/types';
import { FullPageState } from '../../components/common/FullPageState';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';

export function ProjectsPage() {
  const projects = useProjects();
  const client = useQueryClient();
  const navigate = useNavigate();
  const ui = useUi();
  const operationKey = useRef(makeOperationKey());
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', goal: '' });

  useAssistSurface({ id: 'project-form', fields: {
    'project.title': { label: '项目名称', elementId: 'project-title', set: (value) => { setCreating(true); setForm((item) => ({ ...item, title: String(value ?? '') })); } },
    'project.goal': { label: '初始目标', elementId: 'project-goal', set: (value) => { setCreating(true); setForm((item) => ({ ...item, goal: String(value ?? '') })); } }
  } });

  const create = useMutation({
    mutationFn: () => api<DraftProjectResult>('/projects', json('POST', {
      title: form.title.trim(), goal: form.goal.trim(), operation_key: operationKey.current
    }, { name: '创建项目草稿', feedback: 'foreground', timeoutMs: 120_000, safeRetry: true, idempotencyKey: operationKey.current })),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: keys.projects });
      ui.setProject(result.project.id);
      setCreating(false);
      setForm({ title: '', goal: '' });
      operationKey.current = makeOperationKey();
      navigate(result.onboarding_route || `/projects/${result.project.id}/onboarding`);
    },
    onError: (error) => ui.toast(error.message, 'error')
  });

  if (projects.isLoading) return <FullPageState title="正在加载项目" />;
  if (projects.isError) return <FullPageState title="项目加载失败" detail={projects.error.message} retry={projects.refetch} />;
  const rows = projects.data || [];
  const empty = !rows.length;
  return (
    <section className={`projects-page ${empty ? 'empty' : ''}`}>
      <header className="page-heading">
        <div><span className="overline">PROJECTS</span><h1>{empty ? '创建第一个项目' : '项目'}</h1><p>{empty ? '先创建草稿，再由项目引导生成简报与工作流。' : `${rows.length} 个本地工作空间`}</p></div>
        {!empty && <button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />新建项目</button>}
      </header>
      {(empty || creating) && <form className="project-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        {creating && !empty && <button type="button" className="form-close" aria-label="关闭新建项目" onClick={() => setCreating(false)}><X size={18} /></button>}
        <div className="project-draft-notice"><strong>创建可恢复草稿</strong><span>代码源、背景材料和验收标准将在下一步配置；确认前不会激活工作流。</span></div>
        <label>项目名称<input id="project-title" autoFocus value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：发布桌面客户端" /></label>
        <label>初始目标（可选）<textarea id="project-goal" rows={3} value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder="用一句话描述希望交付的结果，之后可在引导中完善" /></label>
        <button type="submit" className="button primary" disabled={!form.title.trim() || create.isPending}><Plus size={16} />{create.isPending ? '正在创建草稿' : '创建并开始引导'}</button>
      </form>}
      {!empty && <div className="project-table" role="table">
        <div className="project-table-head" role="row"><span>项目</span><span>状态</span><span>工作流</span><span>最近活动</span><span /></div>
        {rows.map((project) => <button role="row" key={project.id} onClick={() => openProject(project, ui.setProject, navigate)}>
          <span className="project-name"><FolderGit2 size={18} /><span><strong>{project.title}</strong><small>{project.goal || (project.status === 'draft' ? '等待完成项目引导' : '尚未填写目标')}</small></span></span>
          <span><i className={`status ${project.status === 'draft' ? 'pending' : 'active'}`}>{project.status === 'draft' ? 'draft · 可恢复' : project.status}</i></span>
          <span>{project.workflow_count || 0}</span>
          <span>{project.status === 'draft' ? '继续引导' : `${project.run_count || 0} 次运行`}</span>
          <ArrowRight size={17} />
        </button>)}
      </div>}
    </section>
  );
}

function openProject(project: Project, setProject: (id: string) => void, navigate: ReturnType<typeof useNavigate>) {
  setProject(project.id);
  navigate(project.status === 'draft' || Boolean(project.onboarding_state && project.onboarding_state !== 'confirmed')
    ? `/projects/${project.id}/onboarding`
    : `/projects/${project.id}/workflow`);
}

function makeOperationKey() {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
