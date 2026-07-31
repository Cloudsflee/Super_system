import { useEffect, useState } from 'react';
import { api, json } from '../../../api/client';
import type { ChangeProposal } from '../../../api/types';
import { useAssistSurface } from '../../../components/assist/semantic-actions';
import { useUi } from '../../../state/ui';
import type { RendererProps } from '../registry';
import { lines, saveWorkspaceData, stringList } from './shared';

type WorkspaceValue = RendererProps['value'];
type ReviewActionContext = {
  value: WorkspaceValue;
  onSaved: RendererProps['onSaved'];
  summary: string;
  next: string;
  run: WorkspaceValue['runs'][number] | undefined;
  change: NonNullable<WorkspaceValue['code_changes']>[number] | undefined;
  setPrUrl: (value: string) => void;
  setCreatingPr: (value: boolean) => void;
  setGitBusy: (value: string) => void;
};

export function useReviewWorkspaceController(value: WorkspaceValue, onSaved: RendererProps['onSaved']) {
  const [summary, setSummary] = useState(String(value.data.summary || '')),
    [next, setNext] = useState(stringList(value.data.next_steps).join('\n')),
    [prUrl, setPrUrl] = useState(''),
    [creatingPr, setCreatingPr] = useState(false),
    [gitBusy, setGitBusy] = useState(''),
    run = value.runs.filter((item) => item.status === 'succeeded').at(-1),
    change = value.code_changes?.find((item) => item.run_id === run?.id);
  useAssistSurface({
    id: 'review-workspace',
    fields: {
      'review.summary': {
        label: '复盘摘要',
        elementId: 'review-summary',
        set: (input) => setSummary(String(input ?? ''))
      },
      'review.next_steps': {
        label: '下一步',
        elementId: 'review-next-steps',
        set: (input) => setNext(Array.isArray(input) ? input.map(String).join('\n') : String(input ?? ''))
      }
    }
  });
  const context: ReviewActionContext = {
    value,
    onSaved,
    summary,
    next,
    run,
    change,
    setPrUrl,
    setCreatingPr,
    setGitBusy
  };
  useReviewGitApprovalEvents(context);
  return {
    summary,
    next,
    prUrl,
    creatingPr,
    gitBusy,
    onSummaryChange: setSummary,
    onNextChange: setNext,
    onSubmit: () => submitReview(context),
    onDigest: () => generateReviewDigest(context),
    onSave: () => saveReview(context),
    onGitStep: (step: 'branch' | 'diff' | 'commit') => runReviewGitStep(context, step),
    onCreatePr: () => requestGitApproval(context, 'git_publish_authorization')
  };
}

function useReviewGitApprovalEvents(context: ReviewActionContext) {
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ proposal?: ChangeProposal; applied?: { type?: string; run_id?: string } }>)
          .detail,
        applied = detail.applied;
      if (!detail.proposal?.id || !applied || applied.run_id !== context.run?.id) return;
      if (applied.type === 'git_commit_authorization') void executeReviewCommit(context, detail.proposal.id);
      if (applied.type === 'git_publish_authorization') void executeReviewPublish(context, detail.proposal.id);
    };
    window.addEventListener('aiws:proposal-applied', listener);
    return () => window.removeEventListener('aiws:proposal-applied', listener);
  }, [context.run?.id, context.summary]);
}

async function saveReview(context: ReviewActionContext) {
  try {
    await saveWorkspaceData(context.value.node.id, {
      summary: context.summary,
      next_steps: lines(context.next)
    });
    await context.onSaved();
    notify('复盘内容已保存');
  } catch (error) {
    notifyError(error);
  }
}

async function generateReviewDigest(context: ReviewActionContext) {
  try {
    await api(`/workspaces/${context.value.workspace.id}/digests`, json('POST', undefined, '生成工作空间摘要'));
    await context.onSaved();
    notify('工作空间摘要已生成');
  } catch (error) {
    notifyError(error);
  }
}

async function submitReview(context: ReviewActionContext) {
  try {
    await api(
      `/nodes/${context.value.node.id}/submissions`,
      json(
        'POST',
        {
          title: `${context.value.node.title} 提交`,
          summary: context.summary,
          changes: lines(context.next),
          evidence_refs: [
            ...context.value.assets.map((item) => `asset:${item.id}`),
            ...context.value.runs.map((item) => `node_run:${item.id}`)
          ]
        },
        '提交节点结果到项目'
      )
    );
    await context.onSaved();
    notify('已提交到项目顶层上下文');
  } catch (error) {
    notifyError(error);
  }
}

async function runReviewGitStep(context: ReviewActionContext, step: 'branch' | 'diff' | 'commit') {
  if (!context.run) return;
  if (step === 'commit') return requestGitApproval(context, 'git_commit_authorization');
  context.setGitBusy(step);
  try {
    await api(
      `/runs/${context.run.id}/git/${step}`,
      json('POST', undefined, step === 'branch' ? '创建工作分支' : '捕获代码差异')
    );
    await context.onSaved();
    notify({ branch: '工作分支已创建', diff: '代码差异已捕获' }[step]);
  } catch (error) {
    notifyError(error);
  } finally {
    context.setGitBusy('');
  }
}

async function requestGitApproval(
  context: ReviewActionContext,
  type: 'git_commit_authorization' | 'git_publish_authorization'
) {
  if (!context.run) return;
  try {
    const publish = type === 'git_publish_authorization',
      proposal = await api<ChangeProposal>(
        '/change-proposals',
        json(
          'POST',
          {
            project_id: context.value.project.id,
            workspace_id: context.value.workspace.id,
            node_id: context.value.node.id,
            change_type: publish ? 'git_publish' : 'git_commit',
            title: publish ? `发布草稿合并请求：${context.value.node.title}` : `提交变更：${context.value.node.title}`,
            summary: publish ? '推送工作分支并调用 GitHub 创建草稿合并请求' : '把已审查的差异写入 Git 提交',
            before: context.change || null,
            after: { run_id: context.run.id, message: context.summary || `feat: ${context.value.node.title}` },
            impact: ['Git 代码仓库', ...(publish ? ['GitHub 代码仓库'] : [])],
            risks: [publish ? '将发生外部网络写入' : '将创建不可变提交记录'],
            apply_action: { type, run_id: context.run.id }
          },
          publish ? '创建草稿合并请求提案' : '创建 Git 提交提案'
        )
      );
    useUi.getState().showProposal(proposal.id);
  } catch (error) {
    notifyError(error);
  }
}

async function executeReviewCommit(context: ReviewActionContext, approvalId: string) {
  if (!context.run) return;
  context.setGitBusy('commit');
  try {
    await api(
      `/runs/${context.run.id}/git/commit`,
      json(
        'POST',
        { approval_id: approvalId, message: context.summary || `feat: ${context.value.node.title}` },
        '提交 Git 变更'
      )
    );
    await context.onSaved();
    notify('变更已提交');
  } catch (error) {
    notifyError(error);
  } finally {
    context.setGitBusy('');
  }
}

async function executeReviewPublish(context: ReviewActionContext, approvalId: string) {
  if (!context.run) return;
  context.setCreatingPr(true);
  try {
    const result = await api<{
      code_change: { pr_url?: string };
      repository_bound: boolean;
      github_connected: boolean;
    }>(
      `/runs/${context.run.id}/github/pr`,
      json('POST', { approval_id: approvalId, draft: true }, '创建 GitHub 草稿合并请求')
    );
    context.setPrUrl(result.code_change.pr_url || '');
    await context.onSaved();
    notify(publishResultMessage(result));
  } catch (error) {
    notifyError(error);
  } finally {
    context.setCreatingPr(false);
  }
}

function publishResultMessage(result: {
  code_change: { pr_url?: string };
  repository_bound: boolean;
  github_connected: boolean;
}) {
  if (result.code_change.pr_url) return '草稿合并请求已创建';
  if (!result.github_connected) return '合并请求草稿已生成，请重新授权 GitHub';
  if (!result.repository_bound) return '合并请求草稿已生成，请先绑定 GitHub 代码仓库';
  return '合并请求草稿已生成';
}

function notify(message: string) {
  useUi.getState().toast(message);
}

function notifyError(error: unknown) {
  useUi.getState().toast((error as Error).message, 'error');
}
