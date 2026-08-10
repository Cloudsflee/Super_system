import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'identity',
  dependencies: ['platform'],
  tables: ['users', 'sessions', 'connected_accounts'],
  commands: ['session.create', 'session.revoke'],
  events: ['audit.account', 'session.created', 'session.revoked']
});
