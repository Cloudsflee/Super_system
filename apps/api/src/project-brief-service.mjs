import { HttpError } from './http.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { normalizeBriefContentV2, normalizeBriefSection, withDerivedFields } from './brief-workflow-domain.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
import { safeHttpsReferenceUrl } from './safe-reference-url.mjs';

const TEMPLATE_APPENDIX_MARKDOWN = '以下内容来自应用模板前的项目简报，未与模板区块自动匹配。';

export function patchBriefInState(state, projectId, briefId, body, actorId) {
  const project = requireProject(state, projectId), brief = requireBrief(state, projectId, briefId);
  requireRevision(body.expected_revision, brief.revision, 'project_brief_revision_conflict');
  if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 100) throw new HttpError(400, { error: 'brief_operations_required' });
  let content = normalizeBriefContentV2(brief.content, { briefId: brief.id, title: `${project.title}简报` });
  for (const operation of body.operations) content = applyBriefOperation(content, operation, brief.id);
  content = withDerivedFields(content);
  Object.assign(brief, { content, revision: brief.revision + 1, updated_at: now(), updated_by_user_id: actorId });
  if (brief.status !== 'superseded') Object.assign(project, { goal: content.goal || project.goal, updated_at: now() });
  return brief;
}

export function createBriefTemplateInState(state, body, actorId) {
  if (body.confirmed !== true) throw new HttpError(409, { error: 'brief_template_adoption_confirmation_required' });
  const title = clean(body.title, 200);
  if (!title) throw new HttpError(400, { error: 'brief_template_title_required' });
  const templateKey = clean(body.template_key, 120) || id('btk');
  const prior = state.brief_templates.filter((item) => item.template_key === templateKey).sort((a, b) => b.version - a.version)[0];
  const templateId = id('btp'), at = now();
  const sources = normalizeSources(state, body.sources || body.source_urls);
  const materialReferences = normalizeSources(state, body.material_references || []);
  const content = normalizeBriefContentV2({ schema_version: 2, title, sections: body.sections || body.content?.sections || [], template_ref: null, material_references: materialReferences }, { briefId: templateId, title });
  const template = {
    id: templateId, template_key: templateKey, version: Number(prior?.version || 0) + 1, status: 'active', title,
    domain: clean(body.domain, 120) || 'general', content,
    sources, publisher: clean(body.publisher, 200) || null,
    retrieved_at: validDate(body.retrieved_at) || at, applicability: clean(body.applicability, 4000) || null,
    limitations: clean(body.limitations, 4000) || null, created_by_user_id: actorId, created_at: at, updated_at: at
  };
  state.brief_templates.push(template);
  return template;
}

export function applyBriefTemplateInState(state, projectId, briefId, templateId, body, actorId) {
  const brief = requireBrief(state, projectId, briefId), template = state.brief_templates.find((item) => item.id === templateId && item.status !== 'deleted');
  if (!template) throw new HttpError(404, { error: 'brief_template_not_found' });
  requireRevision(body.expected_revision, brief.revision, 'project_brief_revision_conflict');
  const project = requireProject(state, projectId);
  const current = normalizeBriefContentV2(brief.content, { briefId: brief.id, title: `${project.title}简报` });
  const source = normalizeBriefContentV2(template.content, { briefId: template.id, title: template.title });
  const unmatched = [...current.sections];
  const appendixIndex = unmatched.findIndex(isTemplateAppendix), appendix = appendixIndex >= 0 ? unmatched.splice(appendixIndex, 1)[0] : null;
  const merged = [];
  for (const templateSection of source.sections) {
    const index = unmatched.findIndex((section) => (templateSection.semantic_key && section.semantic_key === templateSection.semantic_key) || section.title.toLowerCase() === templateSection.title.toLowerCase());
    if (index < 0) {
      merged.push(normalizeBriefSection({ ...templateSection, id: id('brs') }, { briefId: brief.id }));
      continue;
    }
    const existing = unmatched.splice(index, 1)[0];
    if (body.overwrite === true) {
      if (body.confirmed_overwrite !== true) throw new HttpError(409, { error: 'brief_template_overwrite_confirmation_required', section_id: existing.id });
      merged.push(normalizeBriefSection({ ...templateSection, id: existing.id }, { briefId: brief.id }));
    } else merged.push(isSectionEmpty(existing) ? normalizeBriefSection({ ...templateSection, id: existing.id }, { briefId: brief.id }) : existing);
  }
  if (unmatched.length) {
    merged.push(appendix || normalizeBriefSection({ id: id('brs'), semantic_key: 'template_appendix', title: '附录', type: 'markdown', markdown: TEMPLATE_APPENDIX_MARKDOWN }, { briefId: brief.id }));
    merged.push(...unmatched.map((section) => ({ ...section, title: section.title.startsWith('附录 · ') ? section.title : `附录 · ${section.title}` })));
  }
  const content = withDerivedFields({ ...current, title: current.title || source.title, sections: merged, template_ref: { template_id: template.id, version: template.version } });
  Object.assign(brief, { content, revision: brief.revision + 1, updated_at: now(), updated_by_user_id: actorId });
  Object.assign(project, { goal: content.goal || project.goal, updated_at: now() });
  return brief;
}

function applyBriefOperation(content, operation, briefId) {
  if (!operation || typeof operation !== 'object') throw new HttpError(400, { error: 'brief_operation_invalid' });
  const sections = [...content.sections], type = String(operation.type || operation.op || '');
  if (type === 'set_title') return { ...content, title: requiredText(operation.title ?? operation.value, 'brief_title_required', 200) };
  if (type === 'add_section') {
    const section = normalizeBriefSection({ ...(operation.section || {}), id: operation.section?.id || id('brs') }, { briefId });
    if (sections.some((item) => item.id === section.id)) throw new HttpError(409, { error: 'brief_section_id_conflict', section_id: section.id });
    sections.splice(targetIndex(operation, sections.length), 0, section); return { ...content, sections };
  }
  const sectionId = clean(operation.section_id || operation.id, 120), index = sections.findIndex((section) => section.id === sectionId);
  if (index < 0) throw new HttpError(404, { error: 'brief_section_not_found', section_id: sectionId });
  if (type === 'rename_section') sections[index] = { ...sections[index], title: requiredText(operation.title ?? operation.value, 'brief_section_title_required', 200) };
  else if (type === 'update_section') sections[index] = normalizeBriefSection({ ...sections[index], ...(operation.patch || operation.section || {}), id: sections[index].id }, { briefId });
  else if (type === 'delete_section') sections.splice(index, 1);
  else if (type === 'duplicate_section') { const copy = normalizeBriefSection({ ...structuredClone(sections[index]), id: id('brs'), title: clean(operation.title, 200) || `${sections[index].title} 副本` }, { briefId }); sections.splice(index + 1, 0, copy); }
  else if (type === 'move_section') { const [section] = sections.splice(index, 1); sections.splice(targetIndex(operation, sections.length), 0, section); }
  else throw new HttpError(400, { error: 'brief_operation_unsupported', operation: type });
  return { ...content, sections };
}

function requireProject(state, projectId) { const project = state.projects.find((item) => item.id === projectId && !item.deleted_at); if (!project) throw new HttpError(404, { error: 'project_not_found' }); return assertProjectLifecycleIdle(project); }
function requireBrief(state, projectId, briefId) { const brief = state.project_briefs.find((item) => item.id === briefId && item.project_id === projectId); if (!brief) throw new HttpError(404, { error: 'project_brief_not_found' }); return brief; }
function requireRevision(expected, current, code) { if (!Number.isInteger(expected)) throw new HttpError(400, { error: 'expected_revision_required', current_revision: current }); if (expected !== current) throw new HttpError(409, { error: code, expected_revision: expected, current_revision: current }); }
function targetIndex(operation, length) { const value = Number(operation.to_index ?? operation.index ?? length); return Number.isInteger(value) ? Math.max(0, Math.min(length, value)) : length; }
function isSectionEmpty(section) { if (section.type === 'markdown') return !section.markdown?.trim(); if (section.type === 'list') return !section.items?.length; if (section.type === 'key_value') return !section.entries?.some((item) => item.key || item.value); return !section.rows?.length; }
function isTemplateAppendix(section) { return section.semantic_key === 'template_appendix' || section.title === '附录' && section.type === 'markdown' && section.markdown === TEMPLATE_APPENDIX_MARKDOWN; }
function normalizeSources(state, value) {
  return (Array.isArray(value) ? value : value ? [value] : []).slice(0, 20).map((item) => {
    const source = typeof item === 'string' ? { url: item } : item || {};
    const rawUrl = clean(source.url, 4000), attachmentId = clean(source.attachment_id, 120) || null;
    const url = rawUrl ? safeHttpsReferenceUrl(rawUrl, 'unsafe_brief_template_source_url') : null;
    const attachment = attachmentId ? (state.attachments || []).find((candidate) => candidate.id === attachmentId && !candidate.deleted_at && !candidate.content_deleted_at && candidate.storage_status !== 'deleted' && !['failed', 'deleted'].includes(candidate.status)) : null;
    if (attachmentId && !attachment) throw new HttpError(404, { error: 'brief_template_source_attachment_not_found', attachment_id: attachmentId });
    return { url, attachment_id: attachmentId, label: clean(source.label, 200) || clean(attachment?.title || attachment?.original_filename, 200) || null };
  }).filter((item) => item.url || item.attachment_id);
}
function validDate(value) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : null; }
function requiredText(value, code, max) { const result = clean(value, max); if (!result) throw new HttpError(400, { error: code }); return result; }
function clean(value, max) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
