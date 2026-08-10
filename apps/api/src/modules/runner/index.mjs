import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'runner',
  dependencies: ['platform', 'setup', 'repository'],
  tables: [],
  commands: [],
  events: ['runner.started', 'runner.completed']
});
