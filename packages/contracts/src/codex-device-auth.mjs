const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const CODE_PATTERN = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}\b/i;

export function parseCodexDeviceAuthLine(value) {
  const line = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!line) return null;
  const rawUrl = line.match(URL_PATTERN)?.[0]?.replace(/[),.;]+$/, '') || '';
  const verification_url = publicVerificationUrl(rawUrl);
  const user_code = line.match(CODE_PATTERN)?.[0]?.toUpperCase() || null;
  if (verification_url || user_code) {
    return { type: 'verification', verification_url, user_code, status: 'waiting_for_user' };
  }
  if (/successfully logged in|authentication (?:complete|successful)|login successful/i.test(line)) {
    return { type: 'status', status: 'authorized' };
  }
  if (/expired|timed? out/i.test(line)) return { type: 'status', status: 'expired' };
  if (/denied|declined|cancelled|canceled/i.test(line)) return { type: 'status', status: 'cancelled' };
  if (/\b(?:error|failed|failure)\b/i.test(line)) return { type: 'status', status: 'failed' };
  return null;
}

export function parseCodexDeviceAuthOutput(value) {
  const result = { verification_url: null, user_code: null, status: 'starting' };
  for (const line of String(value || '').split(/\r?\n/)) {
    const event = parseCodexDeviceAuthLine(line);
    if (!event) continue;
    if (event.verification_url) result.verification_url = event.verification_url;
    if (event.user_code) result.user_code = event.user_code;
    result.status = event.status;
  }
  return result;
}

function publicVerificationUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
