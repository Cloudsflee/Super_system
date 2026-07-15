export function TurnUsage({ usage }: { usage: Record<string, unknown> }) {
  const input = tokenValue(usage, 'input_tokens', 'prompt_tokens');
  const output = tokenValue(usage, 'output_tokens', 'completion_tokens');
  const total = tokenValue(usage, 'total_tokens') ?? (input != null || output != null ? (input || 0) + (output || 0) : null);
  if (input == null && output == null && total == null) return null;
  return <div className="turn-usage-row" aria-label="Token 用量">
    <span>输入 <strong>{formatTokens(input)}</strong></span>
    <span>输出 <strong>{formatTokens(output)}</strong></span>
    <span>总计 <strong>{formatTokens(total)}</strong></span>
  </div>;
}

function tokenValue(usage: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const raw = usage[key];
    if (raw == null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function formatTokens(value: number | null) { return value == null ? '-' : value.toLocaleString(); }
