import { HttpError } from './http.mjs';

export function safeHttpsReferenceUrl(value, errorCode = 'unsafe_reference_url') {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new HttpError(400, { error: errorCode }); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.toString().length > 4_000 || url.protocol !== 'https:' || !host || url.username || url.password || isPrivateHost(host) || [...url.searchParams.keys()].some((key) => /token|key|secret|password|auth/i.test(key))) {
    throw new HttpError(400, { error: errorCode });
  }
  return url.toString();
}

function isPrivateHost(host) {
  if (['localhost', '0.0.0.0', '::', '::1'].includes(host) || host.endsWith('.local')) return true;
  if (/^(?:127|10)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)) return true;
  if (host.startsWith('::ffff:')) return true;
  return false;
}
