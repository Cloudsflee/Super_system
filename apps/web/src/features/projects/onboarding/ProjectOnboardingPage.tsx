import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, json, multipart } from '../../../api/client';
import { keys, useDeployment, useProjectOnboarding } from '../../../api/queries';
import type {
  BriefSection,
  BriefTemplate,
  ProjectBrief,
  ProjectCodeSource,
  ProjectIntakeMode,
  ProjectOnboarding,
  Workflow,
  WorkflowDraft,
  WorkflowDraftNode
} from '../../../api/types';
import { FullPageState } from '../../../components/common/FullPageState';
import { useUi } from '../../../state/ui';
import {
  CompletedOnboarding,
  ContextSources,
  codeSource,
  emptyAnswers,
  hasSavedAnswers,
  intakePayload,
  type AnswerDraft,
  type ContextDraft
} from './onboarding-support';
import { useProjectBriefAssistSurface } from './useProjectBriefAssistSurface';
import { ProjectOnboardingView } from './ProjectOnboardingView';
import { useProjectOnboardingHydration } from './ProjectOnboardingHydration';

export type Step = 'mode' | 'intake' | 'review';
type IntakeUpdate = Pick<ProjectOnboarding, 'project' | 'intake' | 'brief' | 'workflow_draft'>;

const sourceLabels: Record<ProjectCodeSource['type'], string> = {
  github: 'GitHub 代码仓库',
  git: 'Git 地址',
  local_directory: '本地目录',
  local_git: '本地 Git 仓库',
  archive: 'ZIP / TAR 归档'
};

export function ProjectOnboardingPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
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
  const templates = useQuery({
    queryKey: ['brief-templates'],
    queryFn: () => api<{ items: BriefTemplate[] }>('/brief-templates'),
    enabled: Boolean(projectId)
  });

  useProjectBriefAssistSurface(projectId, answers, setBriefField, persistBriefFields);
  function setBriefField(key: keyof AnswerDraft, value: unknown) {
    setAnswers((current) => ({ ...current, [key]: String(value ?? '') }));
    setStep('intake');
  }

  async function persistBriefFields(nextAnswers: AnswerDraft) {
    if (!projectId || !mode) throw new Error('project_intake_not_ready');
    const result = await api<IntakeUpdate>(
      `/projects/${projectId}/intake`,
      json(
        'PUT',
        intakePayload(
          mode,
          nextAnswers,
          sourceType,
          sourceValue || uploadFiles[0]?.name || '',
          contexts,
          relativeImports
        ),
        { name: '保存智能助手简报字段', feedback: 'background', timeoutMs: 120_000 }
      )
    );
    hydrated.current = `${result.project.id}:${result.intake.revision || 0}`;
    mergeUpdate(result);
  }

  useProjectOnboardingHydration({
    localPathAvailable,
    sourceType,
    data: query.data,
    hydrated,
    setSourceType,
    setSourceValue,
    setMode,
    setAnswers,
    setUploadFiles,
    setContexts,
    setStep
  });

  function mergeUpdate(result: IntakeUpdate) {
    if (!projectId) return;
    client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId), (current) =>
      current
        ? {
            ...current,
            ...result,
            briefs: result.brief
              ? [result.brief, ...current.briefs.filter((item) => item.id !== result.brief?.id)]
              : current.briefs,
            can_confirm: Boolean(result.intake.mode && result.brief && !result.intake.last_error)
          }
        : current
    );
  }

  const intakeOperations = useIntakeOperations({
    projectId,
    query,
    mode,
    answers,
    sourceType,
    sourceValue,
    uploadFiles,
    contexts,
    relativeImports,
    mergeUpdate,
    setMode,
    setStep
  });
  const briefOperations = useBriefOperations({ projectId, query });
  const confirm = useConfirmOnboarding({ projectId, query, navigate });

  if (query.isLoading) return <FullPageState title="正在恢复项目引导" />;
  if (query.isError || !query.data)
    return <FullPageState title="项目引导加载失败" detail={query.error?.message} retry={query.refetch} />;
  const data = query.data;
  if (data.project.status !== 'draft')
    return (
      <CompletedOnboarding
        title={data.project.title}
        onOpen={() => navigate(`/projects/${data.project.id}/workflow`)}
      />
    );
  const brief = data.brief ? normalizeBrief(data.brief, data.project.title) : null;
  const workflowDraft = normalizeWorkflowDraft(data.workflow_draft, data.project.id);
  const sourceReady = mode !== 'existing' || data.project.managed_workspace_state === 'ready';
  const answersSaved = hasSavedAnswers(data.intake.answers);
  const canSave = Boolean(
    mode && answers.goal.trim() && (mode !== 'existing' || sourceValue.trim() || uploadFiles.length)
  );
  const workflowReady = Boolean(
    workflowDraft?.nodes.length && workflowDraft.nodes.every((node) => node.title.trim() && node.goal.trim())
  );
  const canConfirm = Boolean(data.can_confirm && answersSaved && workflowReady && sourceReady);

  return (
    <ProjectOnboardingView
      data={data}
      step={step}
      mode={mode}
      brief={brief}
      workflowDraft={workflowDraft}
      answersSaved={answersSaved}
      answers={answers}
      sourceType={sourceType}
      sourceValue={sourceValue}
      uploadFiles={uploadFiles}
      contexts={contexts}
      sourceEntries={sourceEntries}
      localPathAvailable={localPathAvailable}
      relativeImports={relativeImports}
      canSave={canSave}
      canConfirm={canConfirm}
      sourceReady={sourceReady}
      templates={templates.data?.items || []}
      intakeOperations={intakeOperations}
      briefOperations={briefOperations}
      confirm={confirm}
      onStep={setStep}
      onAnswers={setAnswers}
      onSourceType={setSourceType}
      onSourceValue={setSourceValue}
      onUploadFiles={setUploadFiles}
      onContexts={setContexts}
    />
  );
}

type OnboardingQuery = ReturnType<typeof useProjectOnboarding>;

function useIntakeOperations({
  projectId,
  query,
  mode,
  answers,
  sourceType,
  sourceValue,
  uploadFiles,
  contexts,
  relativeImports,
  mergeUpdate,
  setMode,
  setStep
}: {
  projectId?: string;
  query: OnboardingQuery;
  mode: ProjectIntakeMode | null;
  answers: AnswerDraft;
  sourceType: ProjectCodeSource['type'];
  sourceValue: string;
  uploadFiles: File[];
  contexts: ContextDraft[];
  relativeImports: boolean;
  mergeUpdate: (result: IntakeUpdate) => void;
  setMode: (value: ProjectIntakeMode) => void;
  setStep: (value: Step) => void;
}) {
  const client = useQueryClient();
  const ui = useUi();
  const chooseMode = useMutation({
    mutationFn: (next: ProjectIntakeMode) =>
      api<IntakeUpdate>(`/projects/${projectId}/intake`, json('PUT', { mode: next }, '选择项目引导模式')),
    onSuccess: (result, next) => {
      setMode(next);
      mergeUpdate(result);
      setStep('intake');
    },
    onError: (error) => ui.toast(error.message, 'error')
  });
  const saveIntake = useMutation({
    mutationFn: () =>
      api<IntakeUpdate>(
        `/projects/${projectId}/intake`,
        json(
          'PUT',
          intakePayload(
            mode,
            answers,
            sourceType,
            sourceValue || uploadFiles[0]?.name || '',
            contexts,
            relativeImports
          ),
          '保存项目引导信息'
        )
      ),
    onSuccess: (result) => {
      mergeUpdate(result);
      setStep('review');
      ui.toast('项目简报与工作流草案已更新');
    },
    onError: (error) => ui.toast(error.message, 'error')
  });
  const importSource = useMutation({
    mutationFn: () => {
      const operationKey = `web-import-${query.data?.intake.revision || 1}`;
      if (uploadFiles.length) {
        const form = new FormData();
        form.set('operation_key', operationKey);
        for (const file of uploadFiles)
          form.append(
            sourceType === 'archive' ? 'code_archive' : 'code_file',
            file,
            file.webkitRelativePath || file.name
          );
        return api<{ job: { status: string }; project: ProjectOnboarding['project'] }>(
          `/projects/${projectId}/imports`,
          multipart('POST', form, { name: '上传并导入项目代码源', feedback: 'foreground', timeoutMs: 600_000 })
        );
      }
      return api<{ job: { status: string }; project: ProjectOnboarding['project'] }>(
        `/projects/${projectId}/imports`,
        json(
          'POST',
          { code_source: codeSource(sourceType, sourceValue, relativeImports), operation_key: operationKey },
          {
            name: '导入项目代码源',
            feedback: 'foreground',
            timeoutMs: 600_000,
            safeRetry: true,
            idempotencyKey: operationKey
          }
        )
      );
    },
    onSuccess: async () => {
      await query.refetch();
      await client.invalidateQueries({ queryKey: keys.projects });
      ui.toast('代码源已导入受管 workspace');
    },
    onError: (error) => {
      void query.refetch();
      ui.toast(error.message, 'error');
    }
  });
  return { chooseMode, saveIntake, importSource };
}

function useBriefOperations({ projectId, query }: { projectId?: string; query: OnboardingQuery }) {
  const client = useQueryClient();
  const ui = useUi();
  const patchBrief = useMutation({
    mutationFn: (operations: Array<Record<string, unknown> & { type: string }>) =>
      api<ProjectBrief>(
        `/projects/${projectId}/briefs/${query.data?.brief?.id}`,
        json('PATCH', { expected_revision: query.data?.brief?.revision, operations }, '更新项目简报')
      ),
    onSuccess: (brief) =>
      client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId || ''), (current) =>
        current
          ? { ...current, brief, briefs: [brief, ...current.briefs.filter((item) => item.id !== brief.id)] }
          : current
      ),
    onError: (error) => {
      void query.refetch();
      ui.toast(error.message, 'error');
    }
  });
  const patchWorkflow = useMutation({
    mutationFn: (operations: Array<Record<string, unknown> & { type: string }>) =>
      api<WorkflowDraft>(
        `/projects/${projectId}/workflow-draft`,
        json('PATCH', { expected_revision: query.data?.workflow_draft?.revision, operations }, '更新工作流草案')
      ),
    onSuccess: (workflow_draft) =>
      client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId || ''), (current) =>
        current ? { ...current, workflow_draft } : current
      ),
    onError: (error) => {
      void query.refetch();
      ui.toast(error.message, 'error');
    }
  });
  const saveTemplate = useMutation({
    mutationFn: () =>
      api<BriefTemplate>(
        '/brief-templates',
        json(
          'POST',
          {
            confirmed: true,
            title: `${query.data?.brief?.content.title || query.data?.project.title || '项目'}模板`,
            domain: 'general',
            sections: query.data?.brief?.content.sections || [],
            applicability: query.data?.brief?.content.summary || null
          },
          '保存个人简报模板'
        )
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['brief-templates'] });
      ui.toast('已保存到个人模板库');
    },
    onError: (error) => ui.toast(error.message, 'error')
  });
  const applyTemplate = useMutation({
    mutationFn: (template: BriefTemplate) =>
      api<ProjectBrief>(
        `/projects/${projectId}/briefs/${query.data?.brief?.id}/apply-template`,
        json('POST', { template_id: template.id, expected_revision: query.data?.brief?.revision }, '应用简报模板')
      ),
    onSuccess: (brief) => {
      client.setQueryData<ProjectOnboarding>(keys.onboarding(projectId || ''), (current) =>
        current
          ? { ...current, brief, briefs: [brief, ...current.briefs.filter((item) => item.id !== brief.id)] }
          : current
      );
      ui.toast('模板已无损合并到简报');
    },
    onError: (error) => {
      void query.refetch();
      ui.toast(error.message, 'error');
    }
  });
  return { patchBrief, patchWorkflow, saveTemplate, applyTemplate };
}

function useConfirmOnboarding({
  projectId,
  query,
  navigate
}: {
  projectId?: string;
  query: OnboardingQuery;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const client = useQueryClient();
  const ui = useUi();
  return useMutation({
    mutationFn: () => {
      const workflow = normalizeWorkflowDraft(query.data?.workflow_draft, projectId || 'project');
      const currentBrief = query.data?.brief ? normalizeBrief(query.data.brief, query.data.project.title) : null;
      return api<{ project: ProjectOnboarding['project']; workflow: Workflow; route?: string }>(
        `/projects/${projectId}/onboarding/confirm`,
        json(
          'POST',
          {
            workflow_nodes: workflow?.nodes || [],
            expected_brief_revision: currentBrief?.revision,
            expected_workflow_revision: workflow?.revision
          },
          '确认项目简报与工作流'
        )
      );
    },
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
}

export type ProjectOnboardingViewProps = {
  data: ProjectOnboarding;
  step: Step;
  mode: ProjectIntakeMode | null;
  brief: ProjectBrief | null;
  workflowDraft: WorkflowDraft | null;
  answersSaved: boolean;
  answers: AnswerDraft;
  sourceType: ProjectCodeSource['type'];
  sourceValue: string;
  uploadFiles: File[];
  contexts: ContextDraft[];
  sourceEntries: Array<[string, string]>;
  localPathAvailable: boolean;
  relativeImports: boolean;
  canSave: boolean;
  canConfirm: boolean;
  sourceReady: boolean;
  templates: BriefTemplate[];
  intakeOperations: ReturnType<typeof useIntakeOperations>;
  briefOperations: ReturnType<typeof useBriefOperations>;
  confirm: ReturnType<typeof useConfirmOnboarding>;
  onStep: (value: Step) => void;
  onAnswers: (value: AnswerDraft) => void;
  onSourceType: (value: ProjectCodeSource['type']) => void;
  onSourceValue: (value: string) => void;
  onUploadFiles: (value: File[]) => void;
  onContexts: (value: ContextDraft[]) => void;
};

function normalizeWorkflowDraft(
  value: ProjectOnboarding['workflow_draft'] | unknown,
  projectId: string
): WorkflowDraft | null {
  if (!value) return null;
  if (!Array.isArray(value)) return value as WorkflowDraft;
  const ids = value.map((node, index) => String((node as Partial<WorkflowDraftNode>).id || `legacy-node-${index + 1}`));
  const nodes = value.map((entry, index) => {
    const node = entry as Partial<WorkflowDraftNode> & { dependency_indexes?: number[] };
    return {
      id: ids[index],
      type: node.type || 'execution',
      title: node.title || '新节点',
      goal: node.goal || node.title || '',
      dependency_ids:
        node.dependency_ids ||
        (node.dependency_indexes || []).map((dependencyIndex) => ids[dependencyIndex]).filter(Boolean),
      position: node.position || { x: 80 + index * 310, y: 120 },
      order: index
    };
  });
  return { id: `legacy-draft-${projectId}`, project_id: projectId, revision: 1, nodes };
}

function normalizeBrief(value: ProjectBrief, projectTitle: string): ProjectBrief {
  if (Array.isArray(value.content?.sections)) return { ...value, revision: value.revision || value.version || 1 };
  const content = value.content as ProjectBrief['content'] & Record<string, unknown>,
    definitions: Array<[string, string, 'markdown' | 'list', unknown]> = [
      ['goal', '核心目标', 'markdown', content.goal],
      ['users', '目标用户', 'list', content.users],
      ['scope_in', '范围内', 'list', content.scope?.in],
      ['scope_out', '范围外', 'list', content.scope?.out],
      ['constraints', '约束', 'list', content.constraints],
      ['milestones', '里程碑', 'list', content.milestones],
      ['acceptance_criteria', '验收标准', 'list', content.acceptance_criteria],
      ['risks', '风险', 'list', content.risks],
      ['open_questions', '开放问题', 'list', content.open_questions]
    ];
  const sections = definitions.map(([key, title, type, raw]) =>
    type === 'markdown'
      ? { id: `${value.id}-${key}`, semantic_key: key, title, type, markdown: String(raw || '') }
      : { id: `${value.id}-${key}`, semantic_key: key, title, type, items: Array.isArray(raw) ? raw.map(String) : [] }
  ) as BriefSection[];
  return {
    ...value,
    revision: value.revision || value.version || 1,
    content: {
      ...content,
      schema_version: 2,
      title: `${projectTitle}简报`,
      summary: String(content.goal || '尚未形成项目摘要'),
      sections,
      template_ref: null,
      material_references: []
    }
  };
}
