import type { AssistScopeType } from '../../api/types';

export type SelectionAskScope = {
  type: AssistScopeType;
  id: string;
  label: string;
  breadcrumb: string[];
  status?: string;
  statusLabel?: string;
  lockReason?: string;
};

export type SelectionAskDetail = {
  selection: string;
  rect: { left: number; top: number; bottom: number; width: number } | null;
  pageUrl: string;
  semanticScope?: SelectionAskScope;
};
let pending: SelectionAskDetail | null = null;
const listeners = new Set<(value: SelectionAskDetail) => void>();

export function publishSelectionAsk(value: SelectionAskDetail) {
  pending = value;
  for (const listener of listeners) listener(value);
}

export function subscribeSelectionAsk(listener: (value: SelectionAskDetail) => void) {
  listeners.add(listener);
  if (pending) {
    const value = pending;
    pending = null;
    queueMicrotask(() => listener(value));
  }
  return () => {
    listeners.delete(listener);
  };
}
