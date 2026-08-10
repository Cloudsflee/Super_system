import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'platform',
  dependencies: [],
  tables: ['schema_migrations', 'idempotency_keys', 'audit_events', 'config_revisions'],
  commands: [],
  events: ['migration.applied', 'recovery.governance.receipt']
});
