import { ArrowLeft, Check, Eye, FileDiff, MessageSquare, RotateCcw, Send, X } from 'lucide-react';
import { useState } from 'react';
import type { AssistReview } from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';
import { useDiffReviewController, type ReviewAction, type ReviewTarget } from './DiffReviewController';
import { UnifiedDiff, type DiffSelection } from './UnifiedDiff';

export type { ReviewTarget } from './DiffReviewController';

export function DiffReviewPanel({
  target,
  onBack,
  onResolved
}: {
  target: ReviewTarget;
  onBack: () => void;
  onResolved?: (action: 'apply' | 'rollback') => void;
}) {
  const controller = useDiffReviewController(target, onResolved);
  if (controller.review.isLoading) return <div className="review-loading">正在生成工作树差异…</div>;
  if (controller.review.isError || !controller.review.data)
    return (
      <div className="review-loading error">
        <strong>变更审查加载失败</strong>
        <span>{controller.review.error?.message}</span>
        <button className="button secondary" onClick={() => controller.review.refetch()}>
          重试
        </button>
      </div>
    );
  return <DiffReviewContent target={target} onBack={onBack} data={controller.review.data} {...controller} />;
}

function DiffReviewContent({
  target,
  onBack,
  data,
  path,
  setPath,
  pending,
  perform
}: {
  target: ReviewTarget;
  onBack: () => void;
  data: AssistReview;
  path: string;
  setPath: (path: string) => void;
  pending: boolean;
  perform: ReviewAction;
}) {
  const [selection, setSelection] = useState<DiffSelection | null>(null),
    [comment, setComment] = useState(''),
    [summary, setSummary] = useState(''),
    viewed = Boolean(data.viewed_files[path]),
    allViewed = data.changed_files.length > 0 && data.changed_files.every((item) => data.viewed_files[item.path]),
    resolved =
      Boolean(target.readOnly) ||
      ['applied', 'rolled_back'].includes(data.worktree.status) ||
      ['applied', 'rolled_back'].includes(data.status);
  return (
    <section className="diff-review-panel">
      <DiffReviewHeader
        data={data}
        viewed={viewed}
        canMarkViewed={Boolean(path) && !pending}
        onBack={onBack}
        onMarkViewed={() => perform('viewed', { path, viewed: !viewed })}
      />
      <ReviewWorkspace
        data={data}
        path={path}
        selection={selection}
        comment={comment}
        pending={pending}
        onPath={(value) => {
          setPath(value);
          setSelection(null);
        }}
        onSelection={setSelection}
        onComment={setComment}
        onAddComment={() => {
          if (!selection || !comment.trim()) return;
          perform('comments', { path, line: selection.line, side: selection.side, body: comment.trim() });
          setComment('');
        }}
      />
      <ReviewFooter
        target={target}
        data={data}
        summary={summary}
        allViewed={allViewed}
        resolved={resolved}
        pending={pending}
        onSummary={setSummary}
        perform={perform}
      />
    </section>
  );
}

function ReviewWorkspace({
  data,
  path,
  selection,
  comment,
  pending,
  onPath,
  onSelection,
  onComment,
  onAddComment
}: {
  data: AssistReview;
  path: string;
  selection: DiffSelection | null;
  comment: string;
  pending: boolean;
  onPath: (path: string) => void;
  onSelection: (selection: DiffSelection | null) => void;
  onComment: (comment: string) => void;
  onAddComment: () => void;
}) {
  return (
    <div className="diff-review-layout">
      <ChangedFilesTree data={data} path={path} onSelect={onPath} />
      <main className="diff-main">
        <div className="diff-file-head">
          <strong>{path}</strong>
          <span>{commentsFor(data, path).length} 条评论</span>
        </div>
        <UnifiedDiff diff={data.diff} path={path} selection={selection} onSelect={onSelection} />
      </main>
      <ReviewComments
        data={data}
        path={path}
        selection={selection}
        comment={comment}
        pending={pending}
        onSelection={onSelection}
        onComment={onComment}
        onAddComment={onAddComment}
      />
    </div>
  );
}

function ReviewComments({
  data,
  path,
  selection,
  comment,
  pending,
  onSelection,
  onComment,
  onAddComment
}: {
  data: AssistReview;
  path: string;
  selection: DiffSelection | null;
  comment: string;
  pending: boolean;
  onSelection: (selection: DiffSelection | null) => void;
  onComment: (comment: string) => void;
  onAddComment: () => void;
}) {
  const comments = commentsFor(data, path);
  return (
    <aside className="review-comments">
      <h3>
        <MessageSquare size={14} />
        逐行评论
      </h3>
      {selection && (
        <div className="new-comment">
          <span>
            {sideLabel(selection.side)}第 {selection.line} 行
          </span>
          <code>{selection.raw}</code>
          <textarea
            aria-label="行评论"
            rows={3}
            value={comment}
            onChange={(event) => onComment(event.target.value)}
            placeholder="留下具体、可执行的反馈"
          />
          <div>
            <button className="row-icon" aria-label="取消评论" onClick={() => onSelection(null)}>
              <X size={13} />
            </button>
            <button className="button primary" disabled={!comment.trim() || pending} onClick={onAddComment}>
              <Send size={13} />
              评论
            </button>
          </div>
        </div>
      )}
      {comments.map((item) => (
        <article key={item.id}>
          <span>
            {sideLabel(item.patch.side)}第 {item.patch.line} 行
          </span>
          <p>{item.patch.body}</p>
        </article>
      ))}
      {!selection && !comments.length && <p className="muted">点击差异行添加评论。</p>}
    </aside>
  );
}

function ReviewFooter({
  target,
  data,
  summary,
  allViewed,
  resolved,
  pending,
  onSummary,
  perform
}: {
  target: ReviewTarget;
  data: AssistReview;
  summary: string;
  allViewed: boolean;
  resolved: boolean;
  pending: boolean;
  onSummary: (summary: string) => void;
  perform: ReviewAction;
}) {
  return (
    <footer>
      <textarea
        aria-label="请求修改摘要"
        rows={2}
        value={summary}
        onChange={(event) => onSummary(event.target.value)}
        placeholder={target.readOnly ? '服务重启中断的命令行审查当前为只读' : '请求修改摘要（可选）'}
        disabled={target.readOnly}
      />
      {!resolved && (
        <button
          className="button danger"
          disabled={pending}
          onClick={() => perform('rollback', { target_hash: data.target_hash })}
        >
          <X size={14} />
          放弃本轮变更
        </button>
      )}
      <button
        className="button secondary"
        disabled={resolved || pending}
        onClick={() => perform('request-changes', { target_hash: data.target_hash, summary })}
      >
        <MessageSquare size={14} />
        请求修改
      </button>
      {data.worktree.status === 'applied' || data.status === 'applied' ? (
        <button
          className="button danger"
          disabled={pending || target.readOnly}
          onClick={() => perform('rollback', { target_hash: data.target_hash })}
        >
          <RotateCcw size={14} />
          回退变更
        </button>
      ) : (
        <button
          className="button primary"
          data-tooltip={!allViewed ? '请先标记所有文件为已查看' : undefined}
          disabled={resolved || !allViewed || pending}
          onClick={() => perform('apply', { target_hash: data.target_hash })}
        >
          <Check size={14} />
          安全应用
        </button>
      )}
    </footer>
  );
}

function DiffReviewHeader({
  data,
  viewed,
  canMarkViewed,
  onBack,
  onMarkViewed
}: {
  data: AssistReview;
  viewed: boolean;
  canMarkViewed: boolean;
  onBack: () => void;
  onMarkViewed: () => void;
}) {
  return (
    <header>
      <button className="row-icon" aria-label="返回对话" onClick={onBack}>
        <ArrowLeft size={16} />
      </button>
      <FileDiff size={17} />
      <div>
        <strong>审查变更</strong>
        <small>
          {data.changed_files.length} 个文件 · {displayStatus(data.worktree.status)} · {short(data.target_hash)}
        </small>
      </div>
      <button className={`button secondary ${viewed ? 'active' : ''}`} disabled={!canMarkViewed} onClick={onMarkViewed}>
        <Eye size={14} />
        {viewed ? '已查看' : '标记为已查看'}
      </button>
    </header>
  );
}

function ChangedFilesTree({
  data,
  path,
  onSelect
}: {
  data: AssistReview;
  path: string;
  onSelect: (path: string) => void;
}) {
  return (
    <aside className="changed-files" role="tree" aria-label="已变更文件">
      <h3>已变更文件</h3>
      {data.changed_files.map((file) => (
        <button
          role="treeitem"
          aria-level={file.path.split('/').length}
          className={file.path === path ? 'active' : ''}
          key={file.path}
          onClick={() => onSelect(file.path)}
        >
          <i className={file.status}>{statusLetter(file.status)}</i>
          <span style={{ paddingLeft: Math.min(24, (file.path.split('/').length - 1) * 5) }}>{file.path}</span>
          {data.viewed_files[file.path] && <Check size={13} />}
        </button>
      ))}
    </aside>
  );
}

function commentsFor(data: AssistReview, path: string) {
  return data.comments.filter((item) => item.patch.path === path && item.action === 'line_comment');
}
function statusLetter(value: string) {
  return (
    ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' } as Record<string, string>)[value] ||
    value.slice(0, 1).toUpperCase()
  );
}
function short(value: string) {
  return value ? `${value.slice(0, 10)}…` : '无哈希';
}
function sideLabel(value?: string) {
  return value === 'old' ? '原文件' : '新文件';
}
