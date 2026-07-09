import { state } from '../state.js';
import { esc } from '../ui.js';

export const infoChip = (label, value) => `<div class="assist-chip"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;

export function renderQuestions(questions = []) {
  return questions.map((q) => `<label class="choice-card"><input type="checkbox" ${q.required ? 'checked' : ''}/><span><b>${esc(q.question)}</b><small>${esc(q.why)}</small></span></label>`).join('');
}

export function renderOptions(options = []) {
  return options.map((o) => `<button class="option-card ${o.recommended ? 'recommended' : ''}" data-option-id="${esc(o.id)}" type="button"><b>${o.recommended ? '推荐 · ' : ''}${esc(o.label)}</b><span>${esc(o.description)}</span><small>${esc(o.impact)}</small></button>`).join('');
}

export function assistPayload(target, prompt) {
  const node = state.project?.nodes?.find((item) => item.id === state.selectedNodeId) || state.project?.nodes?.[0];
  return { target_type: target, target_id: target === 'node_contract' ? node?.id : state.project?.project?.id, node_id: node?.id, project_id: state.project?.project?.id, user_prompt: prompt };
}
