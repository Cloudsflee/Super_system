import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'context',
  dependencies: ['platform', 'project'],
  tables: [
    'context_sources', 'context_packs', 'context_nodes', 'context_document_versions',
    'context_edges', 'context_selections', 'context_policies', 'context_projection_jobs',
    'context_summaries'
  ],
  commands: ['context.source.create', 'context.pack.create', 'context.rebuild', 'context.selection.create'],
  events: [
    'context_source.created', 'context_pack.created', 'context.rebuilt',
    'context.selection.created', 'context.projection.queued',
    'context.projection.completed', 'context.projection.failed'
  ]
});
