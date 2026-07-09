import { id, now } from './utils.mjs';

export function createDecisionRecord({ projectId, workspaceId = null, title, summary, rationale = '', evidenceRefs = [], actorId, status = 'accepted', tags = [] }) {
  return { id: id('dec'), project_id: projectId, workspace_id: workspaceId, title, summary, rationale, status, evidence_refs: evidenceRefs, tags, confirmed_by_user_id: actorId, created_by_user_id: actorId, created_at: now(), updated_at: now() };
}
