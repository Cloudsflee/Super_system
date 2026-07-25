import { Check, GitPullRequest, ShieldAlert, X } from 'lucide-react';
import { api, json } from '../../api/client';
import type { UiAction } from '../../api/types';
import { useUi } from '../../state/ui';
import { displayStatus } from '../common/display-labels';

export function ActionIntent({ action, sessionId, onChange }: { action: UiAction; sessionId: string; onChange: (value: UiAction) => void }) {
  const { toast, showProposal } = useUi();
  async function decide(decision: 'confirm' | 'reject') {
    try {
      const next = await api<UiAction>(`/assist/v2/sessions/${sessionId}/actions/${action.id}/${decision}`, json('POST', undefined, decision === 'confirm' ? '确认智能助手操作' : '拒绝智能助手操作'));
      onChange(next);
      if (decision === 'confirm' && next.risk === 'proposal' && typeof next.result?.id === 'string') showProposal(next.result.id);
    } catch (error) { toast((error as Error).message, 'error'); }
  }
  return (
    <article className={`action-intent ${action.risk}`}>
      <header>{action.risk === 'proposal' ? <GitPullRequest size={16} /> : <ShieldAlert size={16} />}<strong>{action.label}</strong><span>{displayStatus(action.status)}</span></header>
      <pre>{JSON.stringify(action.args, null, 2)}</pre>
      {action.status === 'pending' && <footer><button className="button secondary" onClick={() => decide('reject')}><X size={15} />拒绝</button><button className="button primary" onClick={() => decide('confirm')}><Check size={15} />确认</button></footer>}
    </article>
  );
}
