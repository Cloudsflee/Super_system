import type { AssistScopeBreadcrumbItem, AssistScopeType, AssistV3Session } from '../../api/types';

const labels: Record<AssistScopeType, string> = {
  project: '项目',
  workflow: '工作流',
  workstream: '成果节点',
  task: '任务'
};

export function assistScopeLabel(scopeType?: string) {
  return labels[scopeType as AssistScopeType] || '未选择作用域';
}

export function assistScopeBreadcrumb(
  session: AssistV3Session | undefined,
  fallback: AssistScopeBreadcrumbItem[] = []
) {
  return session?.scope_breadcrumb?.length ? session.scope_breadcrumb : fallback;
}

export function assistScopePath(items: AssistScopeBreadcrumbItem[]) {
  return items
    .map((item) => item.label)
    .filter(Boolean)
    .join(' / ');
}

export function assistScopeTitle(scopeType: AssistScopeType | undefined, items: AssistScopeBreadcrumbItem[]) {
  const current = items.at(-1)?.label;
  return current ? `${assistScopeLabel(scopeType)} · ${current}` : assistScopeLabel(scopeType);
}

export function sessionIsReadOnly(session?: AssistV3Session) {
  return Boolean(
    session?.archived_at || session?.read_only || (session?.scope_status && session.scope_status !== 'active')
  );
}
