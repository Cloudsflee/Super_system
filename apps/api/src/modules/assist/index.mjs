import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'assist',
  dependencies: ['platform', 'project', 'workflow', 'context'],
  tables: [
    'assist_sessions', 'assist_turns', 'assist_messages', 'assist_events',
    'assist_operations', 'assist_change_batches', 'assist_checkpoints', 'attachments',
    'runtime_approvals', 'runtime_user_inputs', 'ui_action_intents', 'file_changes'
  ],
  commands: [
    'assist_session.create', 'assist_turn.create', 'assist_session.transition',
    'change_batch.create', 'change_batch.apply', 'change_batch.rollback',
    'runtime_approval.create', 'runtime_approval.decide',
    'runtime_user_input.create', 'runtime_user_input.resolve',
    'ui_action_intent.create', 'ui_action_intent.resolve', 'attachment.create'
  ],
  events: [
    'assist.session.created', 'assist.turn.created', 'assist.turn.failed',
    'assist.goal', 'assist.plan', 'assist.message',
    'assist.change_batch.proposed', 'assist.change_batch.applied',
    'assist.change_batch.rolled_back', 'attachment.created',
    'runtime.approval.requested', 'runtime.approval.approved',
    'runtime.approval.rejected', 'runtime.user_input.requested',
    'runtime.user_input.answered'
  ]
});
