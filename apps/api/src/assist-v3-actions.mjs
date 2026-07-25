// V1.5 keeps these exports only as a narrow compatibility boundary for callers that
// still import the V1.4 module. Page mutation now exclusively uses native
// aiws_page dynamic tools and the append-only operation ledger.
import { HttpError } from './http.mjs';
import { cleanText } from './assist-v3-domain.mjs';

export function assistPageActionInstruction() {
  return '';
}

export function parseV3AssistOutput(value) {
  return { message: cleanText(value, 200_000) || 'Codex Turn 已完成。', actions: [] };
}

export function materializeV3PageActions() {
  return [];
}

export async function recordV3PageActionResult() {
  throw new HttpError(410, { error: 'legacy_assist_page_actions_removed', action: 'use_assist_operations' });
}
