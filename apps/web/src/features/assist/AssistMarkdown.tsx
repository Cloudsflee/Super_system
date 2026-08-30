import { useMemo, type ElementType, type ReactNode } from 'react';

/** Safe, dependency-free GFM subset used for assistant output and previews. */
export function AssistMarkdown({ children, className = '' }: { children: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(String(children || '')), [children]);
  return <div className={`assist-markdown ${className}`.trim()}>{blocks}</div>;
}

function parseMarkdown(source: string): ReactNode[] {
  const lines = source.split(/\r?\n/);
  const output: ReactNode[] = [];
  let code: string[] = [];
  let inCode = false;
  let list: string[] = [];
  const flushList = () => { if (list.length) { output.push(<ul key={`list-${output.length}`}>{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>); list = []; } };
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      flushList();
      if (inCode) output.push(<pre key={`code-${index}`}><code>{code.join('\n')}</code></pre>);
      code = []; inCode = !inCode; return;
    }
    if (inCode) { code.push(line); return; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flushList(); const Tag = `h${heading[1].length}` as ElementType; output.push(<Tag key={index}>{inline(heading[2])}</Tag>); return; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) { list.push(bullet[1]); return; }
    if (isTableHeader(lines, index)) {
      flushList();
      const table = parseTable(lines, index);
      output.push(<table key={`table-${index}`}><thead><tr>{table.header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table>);
      table.consumed.forEach(() => lines.splice(index + 1, 1));
      return;
    }
    flushList();
    if (!line.trim()) { output.push(<br key={`br-${index}`} />); return; }
    output.push(<p key={index}>{inline(line)}</p>);
  });
  flushList();
  if (inCode && code.length) output.push(<pre key="code-tail"><code>{code.join('\n')}</code></pre>);
  return output;
}

function inline(value: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|!\[[^\]]*\]\(https?:\/\/[^\s)]+\)|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|~~[^~]+~~)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > cursor) result.push(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) result.push(<strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('~~')) result.push(<del key={`${index}-del`}>{token.slice(2, -2)}</del>);
    else if (token.startsWith('`')) result.push(<code key={`${index}-code`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('![')) { const image = token.match(/^!\[([^\]]*)\]\(https?:\/\/[^\s)]+\)$/); result.push(<span key={`${index}-image`}>{image?.[1] || 'image'}</span>); }
    else { const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/); if (link) result.push(<a key={`${index}-link`} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>); }
    cursor = index + token.length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

function splitTableRow(value: string) { return value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()); }
function isTableHeader(lines: string[], index: number) { return Boolean(lines[index]?.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')); }
function parseTable(lines: string[], index: number) {
  const header = splitTableRow(lines[index]); const consumed: string[] = [lines[index + 1]]; const rows: string[][] = []; let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) { rows.push(splitTableRow(lines[cursor])); consumed.push(lines[cursor]); cursor += 1; }
  return { header, rows, consumed };
}

export default AssistMarkdown;
