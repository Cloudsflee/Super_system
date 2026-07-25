import { spawnSync } from 'node:child_process';
import { ProxyAgent } from 'undici';

const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const agents = new Map();
let cachedWindowsProxy;

export function githubDispatcher(url) {
  const proxy = resolveProxyForUrl(url);
  if (!proxy) return null;
  if (!agents.has(proxy)) agents.set(proxy, new ProxyAgent(proxy));
  return agents.get(proxy);
}

export function resolveProxyForUrl(url, options = {}) {
  const env = options.env || process.env;
  const target = new URL(url);
  if (proxyBypassed(target.hostname, env.NO_PROXY || env.no_proxy || '')) return null;
  const environmentProxy =
    target.protocol === 'https:'
      ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
      : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  const platform = options.platform || process.platform;
  const windowsProxy =
    options.windowsProxy !== undefined ? options.windowsProxy : platform === 'win32' ? readWindowsProxy() : '';
  return normalizeProxy(environmentProxy || parseWindowsProxy(windowsProxy, target.protocol));
}

export function parseWindowsProxy(value, protocol = 'https:') {
  const source = String(value || '').trim();
  if (!source.includes('=')) return source;
  const entries = Object.fromEntries(
    source
      .split(';')
      .map((item) => item.trim().split('=', 2))
      .filter((item) => item.length === 2)
      .map(([key, entry]) => [key.toLowerCase(), entry])
  );
  const key = protocol.replace(':', '').toLowerCase();
  return entries[key] || entries.http || '';
}

export async function closeGithubProxyDispatchers() {
  const pending = [...agents.values()].map((agent) => agent.close().catch(() => undefined));
  agents.clear();
  await Promise.all(pending);
}

function readWindowsProxy() {
  if (cachedWindowsProxy !== undefined) return cachedWindowsProxy;
  const result = spawnSync('reg.exe', ['query', WINDOWS_PROXY_KEY], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2000
  });
  const output = result.status === 0 ? result.stdout : '';
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output);
  cachedWindowsProxy = enabled ? output.match(/ProxyServer\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim() || '' : '';
  return cachedWindowsProxy;
}

function normalizeProxy(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(source) ? source : `http://${source}`;
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function proxyBypassed(hostname, value) {
  const host = String(hostname || '').toLowerCase();
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((item) => {
      if (item === '*') return true;
      const candidate = item.replace(/^\./, '').replace(/:\d+$/, '');
      return host === candidate || host.endsWith(`.${candidate}`);
    });
}
