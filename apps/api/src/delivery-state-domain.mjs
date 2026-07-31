import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { safeSegment } from './assist-v3-git.mjs';
import { HttpError } from './http.mjs';

export function appendDeliveryEvent(state, delivery, type, data) {
  const sequence =
      state.delivery_events
        .filter((item) => item.delivery_id === delivery.id)
        .reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1,
    event = {
      id: id('dle'),
      delivery_id: delivery.id,
      project_id: delivery.project_id,
      task_id: delivery.task_id,
      sequence,
      type,
      data: structuredClone(data || {}),
      created_at: now()
    };
  state.delivery_events.push(event);
  return event;
}

export function requireDeliveryTask(state, taskId) {
  const task = state.workflow_nodes.find(
    (item) => item.id === taskId && item.role === 'task' && !item.legacy_read_only
  );
  if (!task) throw new HttpError(404, { error: 'task_not_found' });
  return task;
}

export function stableDeliveryBranch(task) {
  return `aiws/${safeSegment(task.id).slice(0, 48)}-${hashString(task.id).slice(0, 8)}`;
}

export function sanitizeDeliveryTestInput(input) {
  return {
    changes: Array.isArray(input.test_changes)
      ? input.test_changes
          .slice(0, 50)
          .map((item) => ({ path: clean(item?.path, 500), content: String(item?.content ?? '').slice(0, 500_000) }))
      : null,
    force_test_failure: input.test_failure === true,
    force_path_violation: input.path_violation === true,
    force_secret: input.secret_violation === true
  };
}

export function publicDelivery(item) {
  if (!item) return null;
  const { test_input, ...visible } = item;
  return structuredClone(visible);
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
