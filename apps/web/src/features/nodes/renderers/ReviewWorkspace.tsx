import { Diff, FileArchive, GitBranch, GitCommit, GitPullRequest, Save, Send, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, json } from '../../../api/client';
import type { RendererProps } from '../registry';
import { lines, saveWorkspaceData, stringList } from './shared';
import { useUi } from '../../../state/ui';
import { useAssistSurface } from '../../../components/assist/semantic-actions';
import type { ChangeProposal } from '../../../api/types';
import { assetTypeLabel, displayStatus } from '../../../components/common/display-labels';

export function ReviewWorkspace({ value, onSaved }: RendererProps) {
  const [summary, setSummary] = useState(String(value.data.summary || ''));
  const [next, setNext] = useState(stringList(value.data.next_steps).join('\n'));
  const [prUrl, setPrUrl] = useState('');
  const [creatingPr, setCreatingPr] = useState(false);
  const [gitBusy, setGitBusy] = useState('');
  const ui = useUi();
  const toast = ui.toast;
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
  async function save() {
    try {
      await saveWorkspaceData(value.node.id, { summary, next_steps: lines(next) });
      await onSaved();
      toast('复盘内容已保存');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  async function digest() {
    try {
      await api(`/workspaces/${value.workspace.id}/digests`, json('POST', undefined, '生成工作空间摘要'));
      await onSaved();
      toast('工作空间摘要已生成');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  async function submitToProject() {
    try {
      await api(
        `/nodes/${value.node.id}/submissions`,
        json(
          'POST',
          {
            title: `${value.node.title} 提交`,
            summary,
            changes: lines(next),
            evidence_refs: [
              ...value.assets.map((item) => `asset:${item.id}`),
              ...value.runs.map((item) => `node_run:${item.id}`)
            ]
          },
          '提交节点结果到项目'
        )
      );
      await onSaved();
      toast('已提交到项目顶层上下文');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  const run = value.runs.filter((item) => item.status === 'succeeded').at(-1);
  const change = value.code_changes?.find((item) => item.run_id === run?.id);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ proposal?: ChangeProposal; applied?: { type?: string; run_id?: string } }>)
        .detail;
      const applied = detail.applied;
      if (!detail.proposal?.id || !applied || applied.run_id !== run?.id) return;
      if (applied.type === 'git_commit_authorization') void executeCommit(detail.proposal.id);
      if (applied.type === 'git_publish_authorization') void executePublish(detail.proposal.id);
    };
    window.addEventListener('aiws:proposal-applied', listener);
    return () => window.removeEventListener('aiws:proposal-applied', listener);
  }, [run?.id, summary]);
  async function gitStep(step: 'branch' | 'diff' | 'commit') {
    if (!run) return;
    if (step === 'commit') {
      await requestGitApproval('git_commit_authorization');
      return;
    }
    setGitBusy(step);
    try {
      await api(
        `/runs/${run.id}/git/${step}`,
        json('POST', undefined, step === 'branch' ? '创建工作分支' : '捕获代码差异')
      );
      await onSaved();
      toast({ branch: '工作分支已创建', diff: '代码差异已捕获' }[step]);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setGitBusy('');
    }
  }
  async function createPr() {
    await requestGitApproval('git_publish_authorization');
  }
  async function requestGitApproval(type: 'git_commit_authorization' | 'git_publish_authorization') {
    if (!run) return;
    try {
      const publish = type === 'git_publish_authorization';
      const proposal = await api<ChangeProposal>(
        '/change-proposals',
        json(
          'POST',
          {
            project_id: value.project.id,
            workspace_id: value.workspace.id,
            node_id: value.node.id,
            change_type: publish ? 'git_publish' : 'git_commit',
            title: publish ? `发布草稿合并请求：${value.node.title}` : `提交变更：${value.node.title}`,
            summary: publish ? '推送工作分支并调用 GitHub 创建草稿合并请求' : '把已审查的差异写入 Git 提交',
            before: change || null,
            after: { run_id: run.id, message: summary || `feat: ${value.node.title}` },
            impact: ['Git 代码仓库', ...(publish ? ['GitHub 代码仓库'] : [])],
            risks: [publish ? '将发生外部网络写入' : '将创建不可变提交记录'],
            apply_action: { type, run_id: run.id }
          },
          publish ? '创建草稿合并请求提案' : '创建 Git 提交提案'
        )
      );
      ui.showProposal(proposal.id);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }
  async function executeCommit(approvalId: string) {
    if (!run) return;
    setGitBusy('commit');
    try {
      await api(
        `/runs/${run.id}/git/commit`,
        json('POST', { approval_id: approvalId, message: summary || `feat: ${value.node.title}` }, '提交 Git 变更')
      );
      await onSaved();
      toast('变更已提交');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setGitBusy('');
    }
  }
  async function executePublish(approvalId: string) {
    if (!run) return;
    setCreatingPr(true);
    try {
      const result = await api<{
        code_change: { pr_url?: string };
        repository_bound: boolean;
        github_connected: boolean;
      }>(
        `/runs/${run.id}/github/pr`,
        json('POST', { approval_id: approvalId, draft: true }, '创建 GitHub 草稿合并请求')
      );
      setPrUrl(result.code_change.pr_url || '');
      await onSaved();
      const message = result.code_change.pr_url
        ? '草稿合并请求已创建'
        : !result.github_connected
          ? '合并请求草稿已生成，请重新授权 GitHub'
          : !result.repository_bound
            ? '合并请求草稿已生成，请先绑定 GitHub 代码仓库'
            : '合并请求草稿已生成';
      toast(message);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setCreatingPr(false);
    }
  }
  return (
    <div className="review-workspace">
      <header className="content-header">
        <div>
          <span className="overline">复盘与沉淀</span>
          <h2>复盘与沉淀</h2>
        </div>
        <div>
          <button className="button secondary" disabled={!summary.trim()} onClick={submitToProject}>
            <Send size={15} />
            提交顶层
          </button>
          <button className="button secondary" onClick={digest}>
            <Sparkles size={15} />
            生成摘要
          </button>
          <button className="button primary" onClick={save}>
            <Save size={15} />
            保存
          </button>
        </div>
      </header>
      <div className="review-columns">
        <section>
          <label>
            复盘摘要
            <textarea id="review-summary" rows={12} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label>
            下一步
            <textarea
              id="review-next-steps"
              rows={9}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="每行一项"
            />
          </label>
        </section>
        <aside>
          <h3>
            <FileArchive size={15} />
            已关联资产
          </h3>
          {value.assets.map((asset) => (
            <div className="asset-line" key={asset.id}>
              <span>
                <strong>{asset.title}</strong>
                <small>{assetTypeLabel(asset.type || asset.asset_type)}</small>
              </span>
              <i className={`status ${asset.status}`}>{displayStatus(asset.status)}</i>
            </div>
          ))}
          {!value.assets.length && (
            <div className="quiet-empty">
              <FileArchive size={22} />
              <p>尚无资产</p>
            </div>
          )}
          <h3>Git 交付</h3>
          <div className="git-delivery">
            <span>
              {change
                ? `${codeChangeStatus(change.status)}${change.work_branch ? ` · ${change.work_branch}` : ''}`
                : run
                  ? '等待创建工作分支'
                  : '需要成功的节点运行'}
            </span>
            <div>
              <button
                className="button secondary"
                disabled={!run || Boolean(change?.work_branch) || Boolean(gitBusy)}
                onClick={() => gitStep('branch')}
              >
                <GitBranch size={14} />
                分支
              </button>
              <button
                className="button secondary"
                disabled={!change?.work_branch || Boolean(gitBusy)}
                onClick={() => gitStep('diff')}
              >
                <Diff size={14} />
                差异
              </button>
              <button
                className="button secondary"
                disabled={change?.status !== 'diff_captured' || Boolean(gitBusy)}
                onClick={() => gitStep('commit')}
              >
                <GitCommit size={14} />
                提交
              </button>
              <button
                className="button secondary"
                disabled={creatingPr || change?.status !== 'committed'}
                onClick={createPr}
              >
                <GitPullRequest size={14} />
                {creatingPr ? '创建中' : '草稿合并请求'}
              </button>
            </div>
          </div>
          {(prUrl || change?.pr_url) && (
            <a className="text-link" href={prUrl || change?.pr_url} target="_blank" rel="noreferrer">
              打开 GitHub 合并请求
            </a>
          )}
        </aside>
      </div>
    </div>
  );
}

function codeChangeStatus(value: string) {
  return (
    (
      {
        branch_created: '工作分支已创建',
        diff_captured: '差异已捕获',
        committed: '变更已提交',
        published: '变更已发布'
      } as Record<string, string>
    )[value] || displayStatus(value)
  );
}
