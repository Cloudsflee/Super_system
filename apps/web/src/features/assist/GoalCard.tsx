import { CheckCircle2, ChevronDown, CirclePause, CirclePlay, Flag, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AssistGoal } from '../../api/types';

export function GoalCard({ goal, busy, onSet, onClear }: { goal: AssistGoal | null; busy: boolean; onSet: (value: Partial<AssistGoal>) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false), [objective, setObjective] = useState(goal?.objective || ''), [budget, setBudget] = useState(String(goal?.tokenBudget || ''));
  useEffect(() => { setObjective(goal?.objective || ''); setBudget(String(goal?.tokenBudget || '')); }, [goal?.objective, goal?.tokenBudget]);
  return <section className={`assist-goal-card ${goal?.status || 'unset'}`}>
    <button className="goal-summary" aria-expanded={open} onClick={() => setOpen(!open)}><Flag size={14} /><span><strong>{goal ? goal.objective : '设置线程 Goal'}</strong>{goal && <small>{goal.status} · {goal.tokensUsed.toLocaleString()}/{goal.tokenBudget?.toLocaleString() || '∞'} tokens · {goal.timeUsedSeconds}s</small>}</span><ChevronDown size={13} /></button>
    {open && <div className="goal-editor"><label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={2} /></label><label>Token budget<input type="number" min={1} value={budget} onChange={(event) => setBudget(event.target.value)} /></label><footer><button disabled={busy || !objective.trim()} onClick={() => onSet({ objective: objective.trim(), ...(budget ? { tokenBudget: Number(budget) } : {}) })}>{goal ? '更新' : '设置'}</button>{goal?.status === 'active' && <button onClick={() => onSet({ status: 'paused' })}><CirclePause size={13} />暂停</button>}{goal?.status === 'paused' && <button onClick={() => onSet({ status: 'active' })}><CirclePlay size={13} />恢复</button>}{goal && goal.status !== 'complete' && <button onClick={() => onSet({ status: 'complete' })}><CheckCircle2 size={13} />完成</button>}{goal && <button className="danger" onClick={onClear}><Trash2 size={13} />清除</button>}</footer></div>}
  </section>;
}
