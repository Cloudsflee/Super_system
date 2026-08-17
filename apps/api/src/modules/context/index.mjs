import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'context',
  dependencies: ['platform', 'project', 'workflow', 'repository'],
  sql_dependencies: ['platform', 'project', 'workflow', 'repository'],
  tables: [
    'context_sources', 'context_packs', 'context_nodes', 'context_document_versions',
    'context_edges', 'context_selections', 'context_policies', 'context_policy_revisions',
    'context_policy_heads', 'context_selection_heads', 'context_projection_jobs',
    'context_projection_events', 'context_index_snapshots', 'context_index_heads', 'context_summaries'
  ],
  commands: ['context.source.create', 'context.pack.create', 'context.rebuild', 'context.selection.create', 'context.policy.update', 'context.projection.cancel', 'context.projection.retry'],
  events: [
    'context_source.created', 'context_pack.created', 'context.rebuilt',
    'context.selection.created', 'context.projection.queued',
    'context.projection.completed', 'context.projection.failed', 'context.projection.cancelled',
    'context.policy.updated'
  ]
});
