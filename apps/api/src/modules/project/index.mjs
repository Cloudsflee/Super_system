import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'project',
  dependencies: ['platform', 'setup'],
  tables: ['projects', 'project_intakes', 'brief_revisions', 'brief_heads'],
  commands: ['project.create', 'project.update', 'brief.create'],
  events: ['project.created', 'project.updated', 'brief.created']
});
