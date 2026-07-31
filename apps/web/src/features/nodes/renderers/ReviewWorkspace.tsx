import { Diff, FileArchive, GitBranch, GitCommit, GitPullRequest, Save, Send, Sparkles } from 'lucide-react';
import { assetTypeLabel, displayStatus } from '../../../components/common/display-labels';
import type { RendererProps } from '../registry';
import { useReviewWorkspaceController } from './ReviewWorkspaceController';

type ReviewController = ReturnType<typeof useReviewWorkspaceController>;

export function ReviewWorkspace({ value, onSaved }: RendererProps) {
  const controller = useReviewWorkspaceController(value, onSaved);
  return (
    <div className="review-workspace">
      <ReviewHeader summary={controller.summary} controller={controller} />
      <div className="review-columns">
        <ReviewEditor controller={controller} />
        <ReviewDelivery value={value} controller={controller} />
      </div>
    </div>
  );
}

function ReviewHeader({ summary, controller }: { summary: string; controller: ReviewController }) {
  return (
    <header className="content-header">
      <div>
        <span className="overline">复盘与沉淀</span>
        <h2>复盘与沉淀</h2>
      </div>
      <div>
        <button className="button secondary" disabled={!summary.trim()} onClick={controller.onSubmit}>
          <Send size={15} />
          提交顶层
        </button>
        <button className="button secondary" onClick={controller.onDigest}>
          <Sparkles size={15} />
          生成摘要
        </button>
        <button className="button primary" onClick={controller.onSave}>
          <Save size={15} />
          保存
        </button>
      </div>
    </header>
  );
}

function ReviewEditor({ controller }: { controller: ReviewController }) {
  return (
    <section>
      <label>
        复盘摘要
        <textarea
          id="review-summary"
          rows={12}
          value={controller.summary}
          onChange={(event) => controller.onSummaryChange(event.target.value)}
        />
      </label>
      <label>
        下一步
        <textarea
          id="review-next-steps"
          rows={9}
          value={controller.next}
          onChange={(event) => controller.onNextChange(event.target.value)}
          placeholder="每行一项"
        />
      </label>
    </section>
  );
}

function ReviewDelivery({ value, controller }: { value: RendererProps['value']; controller: ReviewController }) {
  const run = value.runs.filter((item) => item.status === 'succeeded').at(-1),
    change = value.code_changes?.find((item) => item.run_id === run?.id);
  return (
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
      <GitDelivery run={run} change={change} controller={controller} />
      {(controller.prUrl || change?.pr_url) && (
        <a className="text-link" href={controller.prUrl || change?.pr_url} target="_blank" rel="noreferrer">
          打开 GitHub 合并请求
        </a>
      )}
    </aside>
  );
}

function GitDelivery({
  run,
  change,
  controller
}: {
  run: RendererProps['value']['runs'][number] | undefined;
  change: NonNullable<RendererProps['value']['code_changes']>[number] | undefined;
  controller: ReviewController;
}) {
  return (
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
          disabled={!run || Boolean(change?.work_branch) || Boolean(controller.gitBusy)}
          onClick={() => controller.onGitStep('branch')}
        >
          <GitBranch size={14} />
          分支
        </button>
        <button
          className="button secondary"
          disabled={!change?.work_branch || Boolean(controller.gitBusy)}
          onClick={() => controller.onGitStep('diff')}
        >
          <Diff size={14} />
          差异
        </button>
        <button
          className="button secondary"
          disabled={change?.status !== 'diff_captured' || Boolean(controller.gitBusy)}
          onClick={() => controller.onGitStep('commit')}
        >
          <GitCommit size={14} />
          提交
        </button>
        <button
          className="button secondary"
          disabled={controller.creatingPr || change?.status !== 'committed'}
          onClick={controller.onCreatePr}
        >
          <GitPullRequest size={14} />
          {controller.creatingPr ? '创建中' : '草稿合并请求'}
        </button>
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
