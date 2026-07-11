export const CODEX_PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'
]);

export function containerizeLoopbackUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname)) return raw;
    url.hostname = 'host.docker.internal';
    return url.href.replace(/\/$/, raw.endsWith('/') ? '/' : '');
  } catch { return raw; }
}

export function codexContainerProxyEnv(source = process.env) {
  const values = {};
  let hasProxy = false;
  for (const key of CODEX_PROXY_ENV_KEYS) {
    const raw = typeof source[key] === 'string' ? source[key].trim() : '';
    if (!raw) continue;
    if (key.toLowerCase() === 'no_proxy') values[key] = appendNoProxy(raw);
    else {
      values[key] = containerizeLoopbackUrl(raw);
      hasProxy = true;
    }
  }
  if (hasProxy && !values.NO_PROXY && !values.no_proxy) values.NO_PROXY = 'host.docker.internal';
  return values;
}

function appendNoProxy(value) {
  const entries = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!entries.some((item) => item.toLowerCase() === 'host.docker.internal')) entries.push('host.docker.internal');
  return entries.join(',');
}

function isLoopbackHost(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) && octets[0] === 127;
}
