import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'workflow',
  dependencies: ['platform', 'project'],
  tables: [
    'workflow_revisions', 'workflow_heads', 'workflow_drafts', 'workflow_generations',
    'workflow_generation_events', 'workflow_layout_revisions', 'workflow_critic_receipts',
    'node_contracts', 'node_contract_revisions', 'workflow_generation_proposals'
  ],
  commands: ['workflow.create', 'node_contract.create', 'node_contract.update', 'workflow.generate', 'workflow.draft.update',
    'workflow.layout.create', 'workflow.generation.retry', 'workflow.generation.cancel',
    'workflow.generation.apply', 'workflow.replan', 'workflow.proposal.apply', 'workflow.proposal.reject'],
  events: [
    'workflow.created', 'workflow.revision.created', 'workflow.generation.completed',
    'workflow.generation.rejected', 'workflow.generation.failed', 'workflow.generation.cancelled',
    'workflow.generation.critic_pending', 'workflow.generation.proposal_created', 'workflow.generation.applied',
    'workflow.layout.created', 'workflow.proposal.applied', 'workflow.proposal.rejected', 'node_contract.created', 'node_contract.updated'
  ]
});
