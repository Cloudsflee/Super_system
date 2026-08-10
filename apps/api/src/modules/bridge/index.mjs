import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'bridge',
  dependencies: ['platform', 'setup', 'repository'],
  tables: [],
  commands: [],
  events: ['bridge.paired', 'bridge.bundle.transferred']
});
