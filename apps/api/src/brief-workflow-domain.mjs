import { createHash } from 'node:crypto';
import { id } from '../../../packages/shared/index.mjs';
import { normalizeWorkflowHierarchyNodes } from './workflow-hierarchy-domain.mjs';

export const BRIEF_SECTION_TYPES = Object.freeze(['markdown', 'list', 'key_value', 'table']);
export const WORKFLOW_NODE_TYPES = Object.freeze(['goal_definition', 'research', 'analysis', 'execution', 'retrospective']);
export const MAX_WORKFLOW_DRAFT_NODES = 156;

const legacySections = Object.freeze([
  ['goal', '核心目标', 'markdown'],
  ['users', '目标用户', 'list'],
  ['scope_in', '范围内', 'list'],
  ['scope_out', '范围外', 'list'],
  ['constraints', '约束', 'list'],
  ['milestones', '里程碑', 'list'],
  ['acceptance_criteria', '验收标准', 'list'],
  ['risks', '风险', 'list'],
  ['open_questions', '开放问题', 'list']
]);

export function createBriefContentV2({ briefId, title, answers = {}, projectGoal = '', materialReferences = [] }) {
  const goal = cleanText(answers.goal || projectGoal, 4000);
  const features = cleanList(answers.features || answers.scope_in || (goal ? [goal] : []));
  const legacy = {
    goal,
    users: cleanList(answers.users || answers.target_users),
    scope: { in: features, out: cleanList(answers.scope_out) },
    features,
    constraints: cleanList(answers.constraints),
    milestones: cleanList(answers.milestones || ['完成项目工作流并通过验收']),
    acceptance_criteria: cleanList(answers.acceptance_criteria || (goal ? [`交付结果能够验证：${goal}`] : [])),
    risks: cleanList(answers.risks),
    open_questions: cleanList(answers.open_questions)
  };
  return legacyBriefToV2(legacy, { briefId, title, materialReferences });
}

export function legacyBriefToV2(source = {}, { briefId = 'brief', title = '项目简报', materialReferences = [] } = {}) {
  const legacy = {
    goal: cleanText(source.goal, 4000),
    users: cleanList(source.users || source.target_users),
    scope: { in: cleanList(source.scope?.in || source.features || source.scope_in), out: cleanList(source.scope?.out || source.scope_out) },
    features: cleanList(source.features || source.scope?.in || source.scope_in),
    constraints: cleanList(source.constraints),
    milestones: cleanList(source.milestones),
    acceptance_criteria: cleanList(source.acceptance_criteria),
    risks: cleanList(source.risks),
    open_questions: cleanList(source.open_questions)
  };
  if (!legacy.features.length) legacy.features = [...legacy.scope.in];
  if (!legacy.scope.in.length) legacy.scope.in = [...legacy.features];
  const values = {
    goal: legacy.goal,
    users: legacy.users,
    scope_in: legacy.scope.in,
    scope_out: legacy.scope.out,
    constraints: legacy.constraints,
    milestones: legacy.milestones,
    acceptance_criteria: legacy.acceptance_criteria,
    risks: legacy.risks,
    open_questions: legacy.open_questions
  };
  const sections = legacySections.map(([semanticKey, sectionTitle, type]) => normalizeBriefSection({
    id: stableId('brs', briefId, semanticKey), semantic_key: semanticKey, title: sectionTitle, type,
    ...(type === 'markdown' ? { markdown: values[semanticKey] } : { items: values[semanticKey] })
  }, { briefId, fallbackKey: semanticKey }));
  const known = new Set(['goal', 'users', 'target_users', 'scope', 'scope_in', 'scope_out', 'features', 'constraints', 'milestones', 'acceptance_criteria', 'risks', 'open_questions']);
  const legacyFields = Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)));
  return withDerivedFields({
    schema_version: 2,
    title: cleanText(title || source.title || '项目简报', 200),
    summary: deriveSummary(legacy),
    sections,
    template_ref: null,
    material_references: normalizeMaterialReferences(materialReferences),
    ...(Object.keys(legacyFields).length ? { legacy_fields: structuredClone(legacyFields) } : {})
  });
}

export function normalizeBriefContentV2(content, options = {}) {
  if (content?.schema_version !== 2) return legacyBriefToV2(content, options);
  const briefId = options.briefId || 'brief';
  const normalized = {
    ...structuredClone(content),
    schema_version: 2,
    title: cleanText(content.title || options.title || '项目简报', 200),
    sections: (Array.isArray(content.sections) ? content.sections : []).map((section, index) => normalizeBriefSection(section, { briefId, fallbackKey: `section-${index}` })),
    template_ref: normalizeTemplateRef(content.template_ref),
    material_references: normalizeMaterialReferences(content.material_references || options.materialReferences)
  };
  return withDerivedFields(normalized);
}

export function normalizeBriefSection(section = {}, { briefId = 'brief', fallbackKey = 'section' } = {}) {
  const type = BRIEF_SECTION_TYPES.includes(section.type) ? section.type : 'markdown';
  const semanticKey = cleanText(section.semantic_key, 80) || null;
  const base = {
    id: cleanText(section.id, 120) || stableId('brs', briefId, semanticKey || fallbackKey),
    semantic_key: semanticKey,
    title: cleanText(section.title || '未命名区块', 200),
    type
  };
  if (type === 'list') return { ...base, items: cleanList(section.items) };
  if (type === 'key_value') return { ...base, entries: normalizeEntries(section.entries, base.id) };
  if (type === 'table') return { ...base, ...normalizeTable(section, base.id) };
  return { ...base, markdown: cleanText(section.markdown ?? section.content, 100000, false) };
}

export function withDerivedFields(content) {
  const derived = deriveBriefFields(content.sections || []);
  return {
    ...content,
    summary: deriveSummary(derived),
    derived,
    goal: derived.goal,
    users: derived.users,
    scope: derived.scope,
    features: derived.features,
    constraints: derived.constraints,
    milestones: derived.milestones,
    acceptance_criteria: derived.acceptance_criteria,
    risks: derived.risks,
    open_questions: derived.open_questions
  };
}

export function deriveBriefFields(sections = []) {
  const byKey = new Map(sections.filter((section) => section?.semantic_key).map((section) => [section.semantic_key, section]));
  const value = (key) => sectionStrings(byKey.get(key));
  const goal = value('goal').join('\n').trim();
  const features = value('scope_in');
  return {
    goal,
    users: value('users'),
    scope: { in: features, out: value('scope_out') },
    features,
    constraints: value('constraints'),
    milestones: value('milestones'),
    acceptance_criteria: value('acceptance_criteria'),
    risks: value('risks'),
    open_questions: value('open_questions')
  };
}

export function createWorkflowDraft({ project, brief, timestamp = new Date().toISOString(), idFactory = id, deterministic = false }) {
  const makeId = (prefix, key) => deterministic ? stableId(prefix, project.id, key) : idFactory(prefix);
  return {
    id: makeId('wfd', 'draft'), project_id: project.id, revision: 1, status: 'draft', user_modified_at: null,
    nodes: [], generation_status: 'not_started', generation_id: null,
    source_brief_id: brief?.id || null, source_brief_revision: brief?.revision || null,
    created_at: timestamp, updated_at: timestamp
  };
}

export function suggestedWorkflowNodes(brief, { makeId = (prefix) => id(prefix) } = {}) {
  void brief; void makeId;
  return [];
}

export function normalizeWorkflowNodes(nodes, { idFactory = id } = {}) {
  return normalizeWorkflowHierarchyNodes(nodes, { idFactory }).map((node) => ({ ...node, order: node.order_index }));
}

export function assertWorkflowAcyclic(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set(), visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw domainError('workflow_draft_cycle');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependencyId of byId.get(nodeId)?.dependency_ids || []) visit(dependencyId);
    visiting.delete(nodeId); visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
  return nodes;
}

export function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}

function sectionStrings(section) {
  if (!section) return [];
  if (section.type === 'list') return cleanList(section.items);
  if (section.type === 'markdown') return cleanText(section.markdown, 100000, false) ? [cleanText(section.markdown, 100000, false)] : [];
  if (section.type === 'key_value') return (section.entries || []).map((entry) => [entry.key, entry.value].filter(Boolean).join('：')).filter(Boolean);
  if (section.type === 'table') return (section.rows || []).map((row) => (section.columns || []).map((column) => row.cells?.[column.id] || '').filter(Boolean).join(' / ')).filter(Boolean);
  return [];
}

function deriveSummary(value) {
  const goal = cleanText(value?.goal, 4000).replace(/\s+/g, ' ');
  if (!goal) return '尚未形成项目摘要';
  return goal.length > 240 ? `${goal.slice(0, 237)}...` : goal;
}

function normalizeEntries(entries, sectionId) {
  return (Array.isArray(entries) ? entries : []).slice(0, 100).map((entry, index) => ({
    id: cleanText(entry?.id, 120) || stableId('bre', sectionId, index),
    key: cleanText(entry?.key, 200), value: cleanText(entry?.value, 10000, false)
  }));
}

function normalizeTable(section, sectionId) {
  const columns = (Array.isArray(section.columns) ? section.columns : []).slice(0, 20).map((column, index) => ({
    id: cleanText(typeof column === 'string' ? '' : column?.id, 120) || stableId('brc', sectionId, index),
    label: cleanText(typeof column === 'string' ? column : column?.label, 200) || `列 ${index + 1}`
  }));
  const rows = (Array.isArray(section.rows) ? section.rows : []).slice(0, 200).map((row, index) => {
    const source = Array.isArray(row) ? Object.fromEntries(columns.map((column, columnIndex) => [column.id, row[columnIndex]])) : row?.cells || row || {};
    return { id: cleanText(row?.id, 120) || stableId('brr', sectionId, index), cells: Object.fromEntries(columns.map((column) => [column.id, cleanText(source[column.id], 10000, false)])) };
  });
  return { columns, rows };
}

function normalizeTemplateRef(value) {
  if (!value || typeof value !== 'object') return null;
  const templateId = cleanText(value.template_id || value.id, 120);
  return templateId ? { template_id: templateId, version: Math.max(1, Number(value.version) || 1) } : null;
}

function normalizeMaterialReferences(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((item, index) => ({
    id: cleanText(item?.id, 120) || stableId('bmr', item?.attachment_id || item?.url || item?.label || index),
    attachment_id: cleanText(item?.attachment_id, 120) || null,
    url: cleanText(item?.url, 4000) || null,
    label: cleanText(item?.label || item?.title || item?.url || `材料 ${index + 1}`, 200),
    kind: cleanText(item?.kind || item?.type || (item?.url ? 'url' : 'attachment'), 80)
  }));
}

function cleanIdList(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 120)).filter(Boolean))]; }
function cleanList(value) { return (Array.isArray(value) ? value : value ? [value] : []).map((item) => cleanText(item, 1000)).filter(Boolean).slice(0, 100); }
function cleanText(value, max, trim = true) { const text = String(value ?? '').replace(/\0/g, ''); return (trim ? text.trim() : text).slice(0, max); }
function validPosition(value, index) { return { x: clamp(value?.x, -10000, 10000, 80 + index * 310), y: clamp(value?.y, -10000, 10000, 120) }; }
function clamp(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback; }
function domainError(code) { const error = new Error(code); error.code = code; return error; }
