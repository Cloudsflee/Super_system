import { HttpError } from './http.mjs';

export function semanticRoute(value) {
  const route = semanticLabel(value, 500);
  if (!route) return '/';
  if (!route.startsWith('/') || route.includes('://'))
    throw new HttpError(400, { error: 'context_browser_route_invalid' });
  return route.split(/[?#]/, 1)[0];
}

export function semanticLabel(value, maximum) {
  const text = String(value ?? '')
    .replace(/[\u0000\r\n\t]/g, ' ')
    .trim();
  return text ? text.slice(0, maximum) : null;
}

export function semanticFilters(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, { error: 'context_browser_filters_invalid' });
  const output = {};
  for (const [key, raw] of Object.entries(value).slice(0, 50)) {
    const safeKey = semanticLabel(key, 80);
    if (!safeKey || /mouse|hover|toast|pixel|layout|coordinate|geometry/i.test(safeKey)) continue;
    if (Array.isArray(raw))
      output[safeKey] = raw
        .slice(0, 100)
        .map((item) => semanticLabel(item, 300))
        .filter(Boolean);
    else if (typeof raw === 'boolean' || typeof raw === 'number') output[safeKey] = raw;
    else if (raw == null) output[safeKey] = null;
    else if (typeof raw === 'string') output[safeKey] = semanticLabel(raw, 1000);
  }
  return output;
}
