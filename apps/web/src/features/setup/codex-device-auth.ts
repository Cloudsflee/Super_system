export type DeviceAuthSummary = {
  verification_uri?: string;
  user_code?: string;
  status?: 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
};

export function publicDeviceAuthSummary(value: unknown): DeviceAuthSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>,
    summary: DeviceAuthSummary = {};
  if (
    typeof input.status === 'string' &&
    ['starting', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(input.status)
  )
    summary.status = input.status as DeviceAuthSummary['status'];
  if (typeof input.verification_uri === 'string') {
    const uri = officialDeviceUri(input.verification_uri);
    if (uri) summary.verification_uri = uri;
  }
  if (typeof input.user_code === 'string' && /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2}$/i.test(input.user_code.trim()))
    summary.user_code = input.user_code.trim().toUpperCase();
  if (typeof input.output === 'string') {
    const legacy = summarizeDeviceAuthOutput(input.output);
    if (!summary.verification_uri && legacy.verification_uri) summary.verification_uri = legacy.verification_uri;
    if (!summary.user_code && legacy.user_code) summary.user_code = legacy.user_code;
  }
  return summary;
}

export function summarizeDeviceAuthOutput(value: unknown): DeviceAuthSummary {
  const text = typeof value === 'string' ? value.slice(0, 20_000) : '';
  const summary: DeviceAuthSummary = {};
  for (const match of text.match(/https:\/\/[^\s<>"']+/gi) || []) {
    try {
      const uri = officialDeviceUri(match.replace(/[),.;]+$/, ''));
      if (!uri) continue;
      summary.verification_uri = uri;
      break;
    } catch {
      continue;
    }
  }
  const code = text.toUpperCase().match(/(?:CODE|验证码)[^A-Z0-9]{0,40}([A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2})\b/);
  if (code) summary.user_code = code[1];
  return summary;
}

function officialDeviceUri(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!(
      host === 'openai.com' ||
      host.endsWith('.openai.com') ||
      host === 'chatgpt.com' ||
      host.endsWith('.chatgpt.com')
    ))
      return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}
