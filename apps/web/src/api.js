const DEFAULT_API_BASE = 'http://localhost:4317';
let activeBase = null;

export async function api(path, options = {}) {
  const bases = activeBase !== null ? [activeBase] : candidateBases();
  let lastError = null;
  for (const base of bases) {
    try {
      const data = await request(base, path, options);
      activeBase = base;
      return data;
    } catch (error) {
      lastError = error;
      if (!error.fallbackable && base !== '') break;
    }
  }
  throw lastError;
}

async function request(base, path, options) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const text = await res.text();
  const data = parseJson(text, res);
  if (!res.ok) throw apiError(res, data);
  return data;
}

function candidateBases() {
  const configured = apiBaseFromConfig();
  if (configured) return [configured];
  if (location.protocol === 'file:') return [DEFAULT_API_BASE];
  return location.origin === DEFAULT_API_BASE ? [''] : ['', DEFAULT_API_BASE];
}

function apiBaseFromConfig() {
  const params = new URLSearchParams(location.search);
  const value = params.get('api') || params.get('apiBase') || localStorage.getItem('aiws_api_base') || '';
  if (value) localStorage.setItem('aiws_api_base', value);
  return value.replace(/\/+$/, '');
}

function parseJson(text, res) {
  if (!text) return null;
  try { return JSON.parse(text); }
  catch {
    const error = new Error(`API 返回了非 JSON 响应，请确认页面从 ${DEFAULT_API_BASE} 打开或后端已启动。`);
    error.fallbackable = res.status === 404 || res.status === 405 || res.headers.get('content-type')?.includes('text/html');
    throw error;
  }
}

function apiError(res, data) {
  const error = new Error(data?.error || data?.message || `${res.status} ${res.statusText}`);
  error.fallbackable = !data && (res.status === 404 || res.status === 405);
  return error;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
