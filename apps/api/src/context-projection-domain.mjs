export function leaseOwnedBy(job, holder) {
  return Boolean(job && job.status === 'running' && job.lease?.holder === holder);
}

export function nodeMatchesProjectionScope(node, { projectId, allowedProjects, allowedSystemNodes }) {
  if (projectId) return String(node.project_id || '') === String(projectId);
  if (!node.project_id) return !allowedSystemNodes || allowedSystemNodes.has(node.id);
  return !allowedProjects || allowedProjects.has(String(node.project_id));
}
