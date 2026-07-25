export const ASSIST_COMMANDS = [
  ['plan', '下一次先制定计划'],
  ['goal', '编辑线程目标'],
  ['model', '选择模型'],
  ['reasoning', '选择推理强度'],
  ['terminal', '打开终端'],
  ['review', '打开变更审查'],
  ['fork', '创建线程分支'],
  ['btw', '打开临时问答']
] as const;

export type AssistCommand = (typeof ASSIST_COMMANDS)[number][0];
export type ReferenceCandidate = {
  id: string;
  reference_id: string;
  kind: string;
  title: string;
  path?: string | null;
  available: boolean;
  content_type?: string;
  preview_kind?: string;
  selection?: { text: string; start_line: number; start_column: number; end_line: number; end_column: number };
};
export type ActiveToken = { kind: 'reference' | 'command'; query: string; start: number; end: number };

export function activeComposerToken(value: string, caret: number): ActiveToken | null {
  const prefix = value.slice(0, caret),
    match = prefix.match(/(?:^|\s)([@/])(\S*)$/);
  if (!match || match[2].includes('@') || (match[1] === '/' && match[2].includes('/'))) return null;
  const start = caret - match[0].length + (match[0].startsWith(' ') ? 1 : 0);
  return { kind: match[1] === '@' ? 'reference' : 'command', query: match[2].toLowerCase(), start, end: caret };
}

export function removeComposerToken(value: string, token: ActiveToken) {
  return `${value.slice(0, token.start)}${value.slice(token.end)}`.replace(/ {2,}/g, ' ');
}
