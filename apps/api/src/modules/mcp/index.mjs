import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'mcp',
  dependencies: ['platform', 'identity', 'project'],
  tables: ['mcp_clients', 'exchange_requests', 'exchange_grants'],
  commands: [
    'mcp_client.create', 'mcp_client.revoke', 'mcp_scope.request',
    'mcp_scope.grant', 'mcp_scope.revoke'
  ],
  events: [
    'mcp.tool.called', 'mcp_client.created', 'mcp_client.revoked',
    'mcp_scope.requested', 'mcp_scope.granted', 'mcp_scope.revoked'
  ]
});
