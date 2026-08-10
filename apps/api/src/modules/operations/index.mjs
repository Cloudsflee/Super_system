import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'operations',
  dependencies: ['platform'],
  tables: [],
  commands: [],
  events: ['release.gate']
});
