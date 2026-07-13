import { Activity, ChevronDown } from 'lucide-react';
import type { AssistOperation } from '../../api/types';

export function ActivityLedger({ operations }: { operations: AssistOperation[] }) {
  if (!operations.length) return null;
  const groups = operations.reduce((map, item) => map.set(item.turn_id, [...(map.get(item.turn_id) || []), item]), new Map<string, AssistOperation[]>());
  return <details className="assist-activity-ledger"><summary><Activity size={13} />Activity · {operations.length} semantic operations<ChevronDown size={12} /></summary>{[...groups].map(([turnId, items]) => <section key={turnId}><header>Turn {turnId.slice(-8)}</header>{items.map((item) => { const status = item.undone_by ? 'undone' : item.status; return <article key={item.id}><i className={status} /><span><strong>{item.tool}</strong><small>{item.target_id} · {new Date(item.created_at).toLocaleTimeString()}</small></span><em>{status}{item.forced ? ' · forced' : ''}</em></article>; })}</section>)}</details>;
}
