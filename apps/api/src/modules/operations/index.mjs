import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'operations',
  dependencies: ['platform'],
  tables: ['operations', 'operation_events'],
  commands: ['operation.cancel'],
  events: [
    'operation.pending', 'operation.running', 'operation.completed', 'operation.failed',
    'operation.cancelled', 'operation.resumed', 'release.gate'
  ]
});
