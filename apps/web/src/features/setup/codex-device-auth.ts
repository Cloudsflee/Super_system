const OFFICIAL_HOSTS = new Set(['auth.openai.com', 'chatgpt.com', 'auth0.openai.com']);
const CODE = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}\b/i;

export type DeviceAuthSummary = { status?: string; verification_uri?: string; user_code?: string };

export function summarizeDeviceAuthOutput(value: string): { verification_uri?: string; user_code?: string } {
  let verification_uri: string | undefined;
  let user_code: string | undefined;
  for (const line of String(value || '').split(/\r?\n/)) {
    const candidate = line.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, '');
    if (candidate) {
      try {
        const url = new URL(candidate);
        if (OFFICIAL_HOSTS.has(url.hostname.toLowerCase())) { url.search = ''; url.hash = ''; verification_uri = url.href; }
      } catch { /* malformed output is ignored */ }
    }
    const code = line.match(CODE)?.[0];
    if (code) user_code = code.toUpperCase();
  }
  return { ...(verification_uri ? { verification_uri } : {}), ...(user_code ? { user_code } : {}) };
}

export function publicDeviceAuthSummary(value: Record<string, unknown>): DeviceAuthSummary {
  const summary = summarizeDeviceAuthOutput(String(value.verification_uri || ''));
  const result: DeviceAuthSummary = { ...(value.status ? { status: String(value.status) } : {}), ...summary };
  if (!result.verification_uri || !result.verification_uri.startsWith('https://')) delete result.verification_uri;
  if (!result.user_code || !CODE.test(result.user_code)) delete result.user_code;
  return result;
}
