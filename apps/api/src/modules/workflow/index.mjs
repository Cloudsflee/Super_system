import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'workflow',
  dependencies: ['platform', 'project'],
  tables: [
    'workflow_revisions', 'workflow_heads', 'workflow_drafts', 'workflow_generations',
    'workflow_generation_events', 'node_contracts'
  ],
  commands: ['workflow.create', 'node_contract.create', 'workflow.generate'],
  events: [
    'workflow.created', 'workflow.revision.created', 'workflow.generation.completed',
    'workflow.generation.rejected', 'workflow.generation.failed', 'node_contract.created'
  ]
});
