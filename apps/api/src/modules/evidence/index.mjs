import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'evidence',
  dependencies: ['platform', 'project', 'repository'],
  tables: [
    'asset_versions', 'asset_blobs', 'asset_attestations', 'asset_relations',
    'traces', 'digests', 'code_changes', 'evidence_links', 'execution_diffs'
  ],
  commands: ['asset.create'],
  events: ['asset.created', 'asset.captured', 'asset.attested', 'deployment.verified']
});
