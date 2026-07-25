import { Check, CircleCheck, Flag, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AssistGoal } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';

export function GoalCard({
  goal,
  busy,
  onSet,
  onClear
}: {
  goal: AssistGoal | null;
  busy: boolean;
  onSet: (value: Partial<AssistGoal>) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [objective, setObjective] = useState(goal?.objective || '');
  useEffect(() => {
    setObjective(goal?.objective || '');
  }, [goal?.objective]);
  useEffect(() => {
    const edit = () => setEditing(true);
    window.addEventListener('aiws:edit-goal', edit);
    return () => window.removeEventListener('aiws:edit-goal', edit);
  }, []);
  function save() {
    const value = objective.trim();
    if (busy || !value) return;
    onSet({ objective: value });
    setEditing(false);
  }
  return (
    <section className={`assist-goal-card ${goal?.status || 'unset'}`} aria-label="线程目标">
      <Flag size={14} />
      {editing ? (
        <input
          autoFocus
          aria-label="目标"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          className="goal-objective"
          aria-label={goal ? '编辑目标' : '设置线程目标'}
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          {goal?.objective || '设置目标'}
        </button>
      )}
      <div>
        {editing ? (
          <>
            <IconButton label={goal ? '更新' : '设置'} disabled={busy || !objective.trim()} onClick={save}>
              <Check size={13} />
            </IconButton>
            <IconButton label="取消编辑目标" onClick={() => setEditing(false)}>
              <X size={13} />
            </IconButton>
          </>
        ) : (
          <IconButton label="编辑目标" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </IconButton>
        )}
        {goal && goal.status !== 'complete' && (
          <IconButton label="完成目标" disabled={busy} onClick={() => onSet({ status: 'complete' })}>
            <CircleCheck size={13} />
          </IconButton>
        )}
        {goal && (
          <IconButton label="清除目标" disabled={busy} onClick={onClear}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
    </section>
  );
}
