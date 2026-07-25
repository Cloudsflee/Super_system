import fsp from 'node:fs/promises';
import { HttpError } from './http.mjs';
import { managedProjectRoot, managedRepoPath } from './managed-workspace.mjs';

export async function resolveWorkflowGenerationCwd(project) {
  if (!project?.id) throw new HttpError(400, { error: 'workflow_generation_project_required' });
  const root = managedProjectRoot(project.id),
    repo = managedRepoPath(project.id);
  await fsp.mkdir(root, { recursive: true });
  try {
    if ((await fsp.stat(repo)).isDirectory()) return repo;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return root;
}
