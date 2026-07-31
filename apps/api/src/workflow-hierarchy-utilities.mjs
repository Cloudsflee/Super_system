import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { HttpError } from './http.mjs';

const TASK_KIND_SET = new Set([
  'research',
  'analysis',
  'design',
  'content',
  'code',
  'test',
  'review',
  'deploy',
  'manual',
  'integration'
]);
const BOUNDARY_KEYS = Object.freeze([
  'owner',
  'owner_id',
  'permissions',
  'permission_boundary',
  'repository',
  'repository_id',
  'repository_target_ids',
  'external_dependency',
  'external_dependencies',
  'deliverable',
  'deliverables',
  'delivery_boundary'
]);

export function hierarchySort(left, right, workstreamOrder) {
  const leftRoot = left.role === 'workstream' ? left.id : left.parent_node_id;
  const rightRoot = right.role === 'workstream' ? right.id : right.parent_node_id;
  const rootDiff = (workstreamOrder.get(leftRoot) ?? 10000) - (workstreamOrder.get(rightRoot) ?? 10000);
  if (rootDiff) return rootDiff;
  if (left.role !== right.role) return left.role === 'workstream' ? -1 : 1;
  return orderNodes(left, right);
}

export function orderNodes(left, right) {
  return Number(left.order_index || left.order || 0) - Number(right.order_index || right.order || 0);
}

export function dependencyIds(node) {
  return uniqueStrings(
    Array.isArray(node?.dependency_ids)
      ? node.dependency_ids
      : (node?.dependencies || []).map((item) => (typeof item === 'string' ? item : item?.node_id))
  );
}

export function inferTaskKind(type) {
  return TASK_KIND_SET.has(type)
    ? type
    : { goal_definition: 'analysis', execution: 'code', retrospective: 'review' }[type] || 'manual';
}

export function defaultExecutionMode(taskKind) {
  return ['code', 'test', 'deploy'].includes(taskKind)
    ? 'codex'
    : taskKind === 'integration'
      ? 'integration'
      : taskKind === 'manual'
        ? 'manual'
        : 'assist';
}

export function normalizeBoundary(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
}

export function hasIndependentBoundary(value) {
  return value && typeof value === 'object' && BOUNDARY_KEYS.some((key) => nonEmpty(value[key]));
}

function nonEmpty(value) {
  return Array.isArray(value)
    ? value.length > 0
    : value && typeof value === 'object'
      ? Object.keys(value).length > 0
      : Boolean(clean(value, 2000));
}

export function normalizeEvidenceRefs(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 100)
    .map((item) =>
      typeof item === 'string'
        ? { section_id: clean(item, 200), quote: '' }
        : {
            section_id: clean(item?.section_id || item?.brief_section_id, 200),
            quote: clean(item?.quote || item?.evidence, 2000)
          }
    )
    .filter((item) => item.section_id);
}

export function normalizeRepositoryIntent(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return structuredClone(value).slice(0, 50);
  if (typeof value === 'object') return structuredClone(value);
  throw validationError('workflow_generation_repository_intent_invalid');
}

export function normalizeBriefCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, ids]) => [clean(key, 80), uniqueStrings(ids)])
      .filter(([key]) => key)
  );
}

export function finiteConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw validationError('workflow_generation_confidence_invalid');
  return number;
}

export function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 2000)).filter(Boolean))];
}

export function validPosition(value, index) {
  const x = Number(value?.x),
    y = Number(value?.y);
  return {
    x: Number.isFinite(x) ? Math.max(-10000, Math.min(10000, x)) : 100 + (index % 3) * 300,
    y: Number.isFinite(y) ? Math.max(-10000, Math.min(10000, y)) : 120 + Math.floor(index / 3) * 220
  };
}

export function required(value, code, max) {
  const result = clean(value, max);
  if (!result) throw validationError(code);
  return result;
}

export function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

export function validationError(code, details = {}) {
  const error = new HttpError(409, { error: code, ...details });
  error.code = code;
  error.details = details;
  return error;
}
