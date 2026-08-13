export const PROJECT_ROUTES = Object.freeze([
  { method: 'GET', path: 'projects', query: 'projects.list' },
  { method: 'POST', path: 'projects', command: 'project.create', responseStatus: 201 },
  { method: 'GET', path: 'projects/:project_id', query: 'project.get' },
  { method: 'PATCH', path: 'projects/:project_id', command: 'project.update' },
  { method: 'GET', path: 'projects/:project_id/intakes', query: 'project.intakes.list' },
  { method: 'POST', path: 'projects/:project_id/intakes', command: 'intake.start', responseStatus: 202 },
  { method: 'GET', path: 'intakes/:intake_id', query: 'intake.get' },
  { method: 'POST', path: 'intakes/:intake_id/retry', command: 'intake.retry', responseStatus: 202 },
  { method: 'POST', path: 'intakes/:intake_id/cancel', command: 'intake.cancel', responseStatus: 202 },
  { method: 'POST', path: 'intakes/:intake_id/resume', command: 'intake.resume', responseStatus: 202 },
  { method: 'POST', path: 'intakes/:intake_id/upload', command: 'intake.upload', responseStatus: 202, multipart: true },
  { method: 'GET', path: 'projects/:project_id/briefs', query: 'project.briefs.list' },
  { method: 'POST', path: 'projects/:project_id/briefs', command: 'brief.create', responseStatus: 201 },
  { method: 'GET', path: 'briefs/:brief_revision', query: 'brief.get' },
  { method: 'POST', path: 'briefs/:brief_revision/confirm', command: 'brief.confirm' },
  { method: 'POST', path: 'projects/:project_id/briefs/:brief_revision/confirm', command: 'brief.confirm' },
  { method: 'POST', path: 'projects/:project_id/archive', command: 'project.archive', responseStatus: 202 },
  { method: 'POST', path: 'projects/:project_id/trash', command: 'project.trash', responseStatus: 202 },
  { method: 'POST', path: 'projects/:project_id/restore', command: 'project.restore', responseStatus: 202 },
  { method: 'POST', path: 'projects/:project_id/purge', command: 'project.purge', responseStatus: 202 }
]);

export function projectQueries(domain) {
  return [
    ['projects.list', () => domain.listProjects()],
    ['project.get', (input) => domain.getProject(input.project_id)],
    ['project.intakes.list', (input) => domain.listIntakes(input.project_id)],
    ['intake.get', (input) => domain.getIntake(input.intake_id)],
    ['project.briefs.list', (input) => domain.listBriefs(input.project_id)],
    ['brief.get', (input) => domain.getBrief(input.project_id, Number(input.brief_revision))]
  ];
}
