import { cloneStateValue as structuredClone } from './state-clone.mjs';

export function normalizeIdList(values, { rejectInvalid = false } = {}) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    if (rejectInvalid) throw new TypeError('id_list_must_be_array');
    return [];
  }
  const result = [],
    seen = new Set();
  for (const value of values) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string') {
      if (rejectInvalid) throw new TypeError('id_must_be_string');
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort();
}

export function selectorIncludesOutput(task, selector, outputKey) {
  if (selector === outputKey) return true;
  if (selector !== 'required_outputs') return false;
  const required = (task.output_slots || []).filter((item) => item.required !== false);
  return required.length === 1 && required[0].key === outputKey;
}

export function dependencyIds(node) {
  const source = Array.isArray(node?.dependency_ids) ? node.dependency_ids : node?.dependencies || [];
  return source.map((item) => (typeof item === 'string' ? item : item?.node_id || item?.id)).filter(Boolean);
}

export function normalizeEffects(values, identityKey) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object' && clean(item[identityKey], 200))
    .map((item) => ({
      ...structuredClone(item),
      [identityKey]: clean(item[identityKey], 200),
      ...(identityKey === 'input_key' ? { version_ids: normalizeIdList(item.version_ids) } : {}),
      output_keys: normalizeIdList(item.output_keys),
      ...(item.criterion_ids ? { criterion_ids: normalizeIdList(item.criterion_ids) } : {}),
      statement: clean(item.statement, 2000),
      evidence_refs: normalizeTextList(item.evidence_refs),
      ...(item.source_receipts ? { source_receipts: normalizeTextList(item.source_receipts) } : {})
    }))
    .sort(
      (left, right) =>
        left[identityKey].localeCompare(right[identityKey]) ||
        String(left.effect).localeCompare(String(right.effect)) ||
        left.output_keys.join(',').localeCompare(right.output_keys.join(','))
    );
}

export function normalizeRoutes(values) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object' && clean(item.route_type, 80))
    .map((item) => ({
      ...structuredClone(item),
      target_output_keys: normalizeIdList(item.target_output_keys),
      ...(item.contribution_id ? { target_criterion_ids: normalizeIdList(item.target_criterion_ids) } : {})
    }))
    .sort(
      (left, right) =>
        String(left.route_type).localeCompare(String(right.route_type)) ||
        String(left.consumer_task_id || '').localeCompare(String(right.consumer_task_id || '')) ||
        String(left.input_key || '').localeCompare(String(right.input_key || ''))
    );
}

export function normalizeTextList(values) {
  return (Array.isArray(values) ? values : []).map((value) => clean(value, 1000)).filter(Boolean);
}

export function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
