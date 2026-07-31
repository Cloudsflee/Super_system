import { current, isDraft } from 'immer';

export function cloneStateValue(value, options) {
  const source = isDraft(value) ? current(value) : value;
  try {
    return structuredClone(source, options);
  } catch (error) {
    if (error?.name !== 'DataCloneError') throw error;
    return structuredClone(materializeDrafts(source), options);
  }
}

function materializeDrafts(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  const source = isDraft(value) ? current(value) : value;
  if (seen.has(source)) return seen.get(source);
  if (source instanceof Date || source instanceof RegExp || source instanceof ArrayBuffer || ArrayBuffer.isView(source))
    return source;
  if (source instanceof Map) {
    const copy = new Map();
    seen.set(source, copy);
    for (const [key, item] of source) copy.set(materializeDrafts(key, seen), materializeDrafts(item, seen));
    return copy;
  }
  if (source instanceof Set) {
    const copy = new Set();
    seen.set(source, copy);
    for (const item of source) copy.add(materializeDrafts(item, seen));
    return copy;
  }
  const copy = Array.isArray(source) ? [] : {};
  seen.set(source, copy);
  for (const [key, item] of Object.entries(source)) copy[key] = materializeDrafts(item, seen);
  return copy;
}
