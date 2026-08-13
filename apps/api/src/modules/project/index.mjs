import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'project',
  dependencies: ['platform', 'setup', 'repository'],
  tables: ['projects', 'project_intakes', 'brief_revisions', 'brief_heads'],
  commands: [
    'project.create', 'project.update', 'brief.create', 'brief.confirm',
    'intake.start', 'intake.retry', 'intake.cancel', 'intake.resume', 'intake.upload',
    'project.archive', 'project.trash', 'project.restore', 'project.purge'
  ],
  events: [
    'project.created', 'project.updated', 'brief.created', 'brief.confirmed',
    'project.intake.started', 'project.intake.ready', 'project.intake.failed',
    'project.intake.cancelled', 'project.archive', 'project.trash',
    'project.restore', 'project.purge'
  ]
});
