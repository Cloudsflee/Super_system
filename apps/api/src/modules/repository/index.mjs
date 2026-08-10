import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'repository',
  dependencies: ['platform', 'project'],
  tables: [
    'repository_bindings', 'repository_worktrees', 'repository_connections',
    'repository_targets', 'repository_lines'
  ],
  commands: [],
  events: ['repository.bound', 'worktree.created']
});
