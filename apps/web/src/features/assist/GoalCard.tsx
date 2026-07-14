import { Check, CircleCheck, Flag, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AssistGoal } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';

export function GoalCard({ goal, busy, onSet, onClear }: { goal: AssistGoal | null; busy: boolean; onSet: (value: Partial<AssistGoal>) => void; onClear: () => void }) {
  const [editing, setEditing] = useState(false), [objective, setObjective] = useState(goal?.objective || '');
  useEffect(() => { setObjective(goal?.objective || ''); }, [goal?.objective]);
  useEffect(() => { const edit = () => setEditing(true); window.addEventListener('aiws:edit-goal', edit); return () => window.removeEventListener('aiws:edit-goal', edit); }, []);
  function save() { const value = objective.trim(); if (!value) return; onSet({ objective: value }); setEditing(false); }
  return <section className={`assist-goal-card ${goal?.status || 'unset'}`} aria-label="线程 Goal"><Flag size={14} />{editing
    ? <input autoFocus aria-label="Objective" value={objective} onChange={(event) => setObjective(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setEditing(false); }} />
    : <button className="goal-objective" aria-label={goal ? '编辑 Goal' : '设置线程 Goal'} onClick={() => setEditing(true)}>{goal?.objective || '设置 Goal'}</button>}
    <div>{editing ? <><IconButton label={goal ? '更新' : '设置'} disabled={busy || !objective.trim()} onClick={save}><Check size={13} /></IconButton><IconButton label="取消编辑 Goal" onClick={() => setEditing(false)}><X size={13} /></IconButton></> : <IconButton label="编辑 Goal" onClick={() => setEditing(true)}><Pencil size={13} /></IconButton>}{goal && goal.status !== 'complete' && <IconButton label="完成 Goal" disabled={busy} onClick={() => onSet({ status: 'complete' })}><CircleCheck size={13} /></IconButton>}{goal && <IconButton label="清除 Goal" disabled={busy} onClick={onClear}><Trash2 size={13} /></IconButton>}</div>
  </section>;
}
