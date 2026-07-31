import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, json } from '../../api/client';
import type { AssistReview } from '../../api/types';
import { useUi } from '../../state/ui';
import { assistKeys } from './assist-api';

export type ReviewTarget = { kind: 'turn' | 'terminal'; id: string; readOnly?: boolean };
export type ReviewActionName = 'viewed' | 'comments' | 'request-changes' | 'apply' | 'rollback';
export type ReviewAction = (name: ReviewActionName, body: Record<string, unknown>) => void;

export function useDiffReviewController(target: ReviewTarget, onResolved?: (action: 'apply' | 'rollback') => void) {
  const base =
      target.kind === 'turn'
        ? `/assist/v3/turns/${target.id}/review`
        : `/assist/v3/terminal-sessions/${target.id}/review`,
    key = `${target.kind}:${target.id}`,
    review = useQuery({ queryKey: assistKeys.review(key), queryFn: () => api<AssistReview>(base) }),
    [path, setPath] = useState(''),
    ui = useUi(),
    client = useQueryClient();
  useEffect(() => {
    if (review.data?.changed_files.length && !review.data.changed_files.some((item) => item.path === path))
      setPath(review.data.changed_files[0].path);
  }, [review.data, path]);
  const mutation = useMutation({
    mutationFn: ({ name, body }: { name: ReviewActionName; body: Record<string, unknown> }) =>
      api(`${base}/${name}`, json('POST', body, reviewOperationName(name))),
    onSuccess: async (_, variables) => {
      if (variables.name === 'rollback') client.removeQueries({ queryKey: assistKeys.review(key) });
      else if (variables.name === 'apply')
        await client.invalidateQueries({ queryKey: assistKeys.review(key), refetchType: 'none' });
      else await client.invalidateQueries({ queryKey: assistKeys.review(key) });
      if (variables.name === 'apply' || variables.name === 'rollback') onResolved?.(variables.name);
      ui.toast(reviewMessage(variables.name));
    },
    onError: async (error) => {
      if (isStaleReviewError(error)) {
        ui.toast('审查内容已变化，请重新检查差异', 'error');
        await review.refetch();
      } else ui.toast(error.message, 'error');
    }
  });
  const perform: ReviewAction = (name, body) => mutation.mutate({ name, body });
  return { review, path, setPath, pending: mutation.isPending, perform };
}

function isStaleReviewError(error: Error) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    ['review_stale', 'review_base_changed', 'review_target_dirty'].includes(String(error.payload.error))
  );
}

function reviewMessage(value: ReviewActionName) {
  return (
    {
      viewed: '文件查看状态已更新',
      comments: '行评论已添加',
      'request-changes': '已请求修改',
      apply: '变更已安全应用',
      rollback: '本轮变更已回退'
    }[value] || '审查已更新'
  );
}

function reviewOperationName(value: ReviewActionName) {
  return (
    {
      viewed: '更新文件审阅状态',
      comments: '添加差异行评论',
      'request-changes': '请求修改智能助手变更',
      apply: '应用智能助手变更',
      rollback: '回退智能助手变更'
    }[value] || '更新变更审查'
  );
}
