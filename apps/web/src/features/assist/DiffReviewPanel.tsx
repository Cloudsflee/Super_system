import { ArrowLeft, Check, Eye, FileDiff, MessageSquare, RotateCcw, Send, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, json } from '../../api/client';
import type { AssistReview } from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';
import { useUi } from '../../state/ui';
import { assistKeys } from './assist-api';
import { UnifiedDiff, type DiffSelection } from './UnifiedDiff';

export type ReviewTarget = { kind: 'turn' | 'terminal'; id: string; readOnly?: boolean };

export function DiffReviewPanel({ target, onBack, onResolved }: { target: ReviewTarget; onBack: () => void; onResolved?: (action: 'apply' | 'rollback') => void }) {
  const base = target.kind === 'turn' ? `/assist/v3/turns/${target.id}/review` : `/assist/v3/terminal-sessions/${target.id}/review`;
  const key = `${target.kind}:${target.id}`;
  const review = useQuery({ queryKey: assistKeys.review(key), queryFn: () => api<AssistReview>(base) });
  const [path, setPath] = useState('');
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [comment, setComment] = useState('');
  const [summary, setSummary] = useState('');
  const ui = useUi();
  const client = useQueryClient();
  useEffect(() => { if (review.data?.changed_files.length && !review.data.changed_files.some((item) => item.path === path)) setPath(review.data.changed_files[0].path); }, [review.data, path]);

  const action = useMutation({
    mutationFn: ({ name, body }: { name: string; body: Record<string, unknown> }) => api(`${base}/${name}`, json('POST', body, reviewOperationName(name))),
    onSuccess: async (_, variables) => {
      if (variables.name === 'rollback') client.removeQueries({ queryKey: assistKeys.review(key) });
      else if (variables.name === 'apply') await client.invalidateQueries({ queryKey: assistKeys.review(key), refetchType: 'none' });
      else await client.invalidateQueries({ queryKey: assistKeys.review(key) });
      if (variables.name === 'apply' || variables.name === 'rollback') onResolved?.(variables.name); ui.toast(reviewMessage(variables.name));
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409 && ['review_stale', 'review_base_changed', 'review_target_dirty'].includes(String(error.payload.error))) { ui.toast('审查内容已变化，请重新检查差异', 'error'); await review.refetch(); }
      else ui.toast(error.message, 'error');
    }
  });
  const data = review.data;
  if (review.isLoading) return <div className="review-loading">正在生成工作树差异…</div>;
  if (review.isError || !data) return <div className="review-loading error"><strong>变更审查加载失败</strong><span>{review.error?.message}</span><button className="button secondary" onClick={() => review.refetch()}>重试</button></div>;
  const viewed = Boolean(data.viewed_files[path]);
  const allViewed = data.changed_files.length > 0 && data.changed_files.every((item) => data.viewed_files[item.path]);
  const resolved = Boolean(target.readOnly) || ['applied', 'rolled_back'].includes(data.worktree.status) || ['applied', 'rolled_back'].includes(data.status);
  function markViewed(value = !viewed) { action.mutate({ name: 'viewed', body: { path, viewed: value } }); }
  function addComment() { if (!selection || !comment.trim()) return; action.mutate({ name: 'comments', body: { path, line: selection.line, side: selection.side, body: comment.trim() } }); setComment(''); }
  return <section className="diff-review-panel">
    <header><button className="row-icon" aria-label="返回对话" onClick={onBack}><ArrowLeft size={16} /></button><FileDiff size={17} /><div><strong>审查变更</strong><small>{data.changed_files.length} 个文件 · {displayStatus(data.worktree.status)} · {short(data.target_hash)}</small></div><button className={`button secondary ${viewed ? 'active' : ''}`} disabled={!path || action.isPending} onClick={() => markViewed()}><Eye size={14} />{viewed ? '已查看' : '标记为已查看'}</button></header>
    <div className="diff-review-layout">
      <aside className="changed-files" role="tree" aria-label="已变更文件"><h3>已变更文件</h3>{data.changed_files.map((file) => <button role="treeitem" aria-level={file.path.split('/').length} className={file.path === path ? 'active' : ''} key={file.path} onClick={() => { setPath(file.path); setSelection(null); }}><i className={file.status}>{statusLetter(file.status)}</i><span style={{ paddingLeft: Math.min(24, (file.path.split('/').length - 1) * 5) }}>{file.path}</span>{data.viewed_files[file.path] && <Check size={13} />}</button>)}</aside>
      <main className="diff-main"><div className="diff-file-head"><strong>{path}</strong><span>{commentsFor(data, path).length} 条评论</span></div><UnifiedDiff diff={data.diff} path={path} selection={selection} onSelect={setSelection} /></main>
      <aside className="review-comments"><h3><MessageSquare size={14} />逐行评论</h3>{selection && <div className="new-comment"><span>{sideLabel(selection.side)}第 {selection.line} 行</span><code>{selection.raw}</code><textarea aria-label="行评论" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="留下具体、可执行的反馈" /><div><button className="row-icon" aria-label="取消评论" onClick={() => setSelection(null)}><X size={13} /></button><button className="button primary" disabled={!comment.trim() || action.isPending} onClick={addComment}><Send size={13} />评论</button></div></div>}{commentsFor(data, path).map((item) => <article key={item.id}><span>{sideLabel(item.patch.side)}第 {item.patch.line} 行</span><p>{item.patch.body}</p></article>)}{!selection && !commentsFor(data, path).length && <p className="muted">点击差异行添加评论。</p>}</aside>
    </div>
    <footer><textarea aria-label="请求修改摘要" rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={target.readOnly ? '服务重启中断的命令行审查当前为只读' : '请求修改摘要（可选）'} disabled={target.readOnly} />{!resolved && <button className="button danger" disabled={action.isPending} onClick={() => action.mutate({ name: 'rollback', body: { target_hash: data.target_hash } })}><X size={14} />放弃本轮变更</button>}<button className="button secondary" disabled={resolved || action.isPending} onClick={() => action.mutate({ name: 'request-changes', body: { target_hash: data.target_hash, summary } })}><MessageSquare size={14} />请求修改</button>{data.worktree.status === 'applied' || data.status === 'applied' ? <button className="button danger" disabled={action.isPending || target.readOnly} onClick={() => action.mutate({ name: 'rollback', body: { target_hash: data.target_hash } })}><RotateCcw size={14} />回退变更</button> : <button className="button primary" data-tooltip={!allViewed ? '请先标记所有文件为已查看' : undefined} disabled={resolved || !allViewed || action.isPending} onClick={() => action.mutate({ name: 'apply', body: { target_hash: data.target_hash } })}><Check size={14} />安全应用</button>}</footer>
  </section>;
}

function commentsFor(data: AssistReview, path: string) { return data.comments.filter((item) => item.patch.path === path && item.action === 'line_comment'); }
function statusLetter(value: string) { return ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' } as Record<string, string>)[value] || value.slice(0, 1).toUpperCase(); }
function short(value: string) { return value ? `${value.slice(0, 10)}…` : '无哈希'; }
function sideLabel(value?: string) { return value === 'old' ? '原文件' : '新文件'; }
function reviewMessage(value: string) { return ({ viewed: '文件查看状态已更新', comments: '行评论已添加', 'request-changes': '已请求修改', apply: '变更已安全应用', rollback: '本轮变更已回退' } as Record<string, string>)[value] || '审查已更新'; }
function reviewOperationName(value: string) { return ({ viewed: '更新文件审阅状态', comments: '添加差异行评论', 'request-changes': '请求修改智能助手变更', apply: '应用智能助手变更', rollback: '回退智能助手变更' } as Record<string, string>)[value] || '更新变更审查'; }
