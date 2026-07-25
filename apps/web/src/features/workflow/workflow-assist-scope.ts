import type { WorkflowTaskViewModel } from './WorkflowTaskViewModel';

export function taskAssistScopeAttributes(model: WorkflowTaskViewModel) {
  return {
    'data-assist-scope-type': 'task',
    'data-assist-scope-id': model.id,
    'data-assist-scope-label': model.displayTitle,
    'data-assist-scope-breadcrumb': JSON.stringify(model.assistBreadcrumb),
    'data-assist-scope-status': model.status,
    'data-assist-scope-status-label': model.statusText,
    'data-assist-scope-lock-reason': model.actionLockReason || undefined
  } as const;
}
