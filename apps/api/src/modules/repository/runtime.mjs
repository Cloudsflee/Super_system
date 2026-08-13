export const REPOSITORY_ROUTES = Object.freeze([
  { method: 'GET', path: 'projects/:project_id/repository-connections', query: 'repository.connections.list' },
  { method: 'POST', path: 'projects/:project_id/repository-connections', command: 'repository.connection.create', responseStatus: 201 },
  { method: 'GET', path: 'repository-connections/:connection_id', query: 'repository.connection.get' },
  { method: 'PATCH', path: 'repository-connections/:connection_id', command: 'repository.connection.update' },
  { method: 'DELETE', path: 'repository-connections/:connection_id', command: 'repository.connection.delete' },
  { method: 'GET', path: 'repository-connections/:connection_id/targets', query: 'repository.targets.list' },
  { method: 'POST', path: 'repository-connections/:connection_id/targets', command: 'repository.target.create', responseStatus: 201 },
  { method: 'GET', path: 'repository-targets/:target_id', query: 'repository.target.get' },
  { method: 'PATCH', path: 'repository-targets/:target_id', command: 'repository.target.update' },
  { method: 'DELETE', path: 'repository-targets/:target_id', command: 'repository.target.delete' },
  { method: 'GET', path: 'projects/:project_id/repository-lines', query: 'repository.lines.list' },
  { method: 'POST', path: 'projects/:project_id/repository-lines', command: 'repository.line.create', responseStatus: 201 },
  { method: 'GET', path: 'repository-lines/:line_id', query: 'repository.line.get' },
  { method: 'PATCH', path: 'repository-lines/:line_id', command: 'repository.line.update' },
  { method: 'DELETE', path: 'repository-lines/:line_id', command: 'repository.line.delete' },
  { method: 'POST', path: 'repository-lines/:line_id/probe', command: 'repository.line.probe', responseStatus: 202 },
  { method: 'POST', path: 'repository-lines/:line_id/recover', command: 'repository.line.recover', responseStatus: 202 },
  { method: 'POST', path: 'repository-lines/:line_id/sync', command: 'repository.line.sync', responseStatus: 202 },
  { method: 'POST', path: 'projects/:project_id/repository/archive', command: 'repository.archive', responseStatus: 202 }
]);

export function repositoryQueries(domain) {
  return [
    ['repository.connections.list', (input) => domain.listRepositoryConnections(input.project_id)],
    ['repository.connection.get', (input) => domain.getRepositoryConnection(input.connection_id)],
    ['repository.targets.list', (input) => domain.listRepositoryTargets(input.connection_id)],
    ['repository.target.get', (input) => domain.getRepositoryTarget(input.target_id)],
    ['repository.lines.list', (input) => domain.listRepositoryLines(input.project_id)],
    ['repository.line.get', (input) => domain.getRepositoryLine(input.line_id)]
  ];
}
