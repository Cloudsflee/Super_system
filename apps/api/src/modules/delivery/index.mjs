import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'delivery',
  dependencies: ['platform', 'repository', 'execution', 'outcome'],
  tables: ['deliveries', 'pull_request_intents', 'delivery_policies', 'delivery_events'],
  commands: ['delivery.create', 'delivery.merge', 'delivery.retry'],
  events: ['delivery.created', 'delivery.submitted', 'delivery.merged', 'delivery.blocked']
});
