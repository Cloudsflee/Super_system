import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'identity',
  dependencies: ['platform'],
  tables: ['users', 'sessions', 'connected_accounts'],
  commands: ['account.update', 'session.create', 'session.revoke'],
  events: ['account.updated', 'session.created', 'session.revoked']
});
