import { defineModule } from '../define-module.mjs';

// Critic owns immutable decision receipts in the clean P3 boundary.  The
// module intentionally exposes no persistence or command surface here; the
// clean ProjectWorkflow service remains the only writer.
export default defineModule({
  id: 'critic',
  dependencies: ['platform', 'workflow'],
  tables: [],
  commands: [],
  events: ['critic.*']
});
