import { useSyncExternalStore } from 'react';
import { ApiError } from '../../api';
function subscribe(listener: () => void) { window.addEventListener('online', listener); window.addEventListener('offline', listener); return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); }; }
export function useWorkbenchOnline() { return useSyncExternalStore(subscribe, () => navigator.onLine, () => true); }
export function workbenchError(error: unknown) {
  const api = error instanceof ApiError ? error : null;
  const message = error instanceof Error ? error.message : '请求失败';
  if (api?.status === 403 || api?.status === 401) return { kind: 'permission', message, action: '前往权限设置' };
  if (api?.code === 'source_drift' || api?.code === 'workflow_proposal_stale' || api?.code.includes('pins_changed')) return { kind: 'drift', message, action: '重新加载并检查来源' };
  if (api?.status === 409) return { kind: 'conflict', message, action: '重新加载服务器版本' };
  if (!navigator.onLine || api?.status === 0) return { kind: 'network', message, action: '恢复连接后重试' };
  return { kind: 'server', message, action: '重试' };
}
