import fs from 'node:fs';
import path from 'node:path';
import { ASSIST_DIR } from './config.mjs';
import { HttpError } from './http.mjs';

export function readableProjectCwd(project) {
  const configured = String(project.repo_path || '').trim();
  if (configured && fs.existsSync(configured)) return path.resolve(configured);
  const projectId = String(project.id || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(projectId))
    throw new HttpError(409, { error: 'assist_workspace_unavailable' });
  return path.join(ASSIST_DIR, projectId);
}

export function assertAgentProjectReady(project) {
  if (project.status !== 'active') throw new HttpError(409, { error: 'project_not_active' });
  if (project.managed_workspace_state !== 'ready')
    throw new HttpError(409, {
      error: 'workspace_migration_required',
      state: project.managed_workspace_state || 'unknown'
    });
}

export function projectWriteUnavailableReason(project) {
  if (project?.status !== 'active') return 'project_not_active';
  if (project?.managed_workspace_state !== 'ready') return 'workspace_migration_required';
  return null;
}

export function isWritableTurn(turn, project) {
  return turn?.collaboration_mode !== 'plan' && turn?.mode !== 'plan' && !projectWriteUnavailableReason(project);
}
