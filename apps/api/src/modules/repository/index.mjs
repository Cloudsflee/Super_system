import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'repository',
  dependencies: ['platform'],
  tables: [
    'repository_bindings', 'repository_worktrees', 'repository_connections',
    'repository_targets', 'repository_lines', 'repository_line_artifacts'
  ],
  commands: [
    'repository.connection.create', 'repository.connection.update', 'repository.connection.delete',
    'repository.target.create', 'repository.target.update', 'repository.target.delete',
    'repository.line.create', 'repository.line.update', 'repository.line.delete',
    'repository.line.probe', 'repository.line.recover', 'repository.line.sync',
    'repository.archive'
  ],
  events: ['repository.bound', 'worktree.created', 'repository.probe.completed', 'repository.line.fault', 'repository.line.recovered']
});
