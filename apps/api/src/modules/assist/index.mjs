import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'assist',
  dependencies: ['platform', 'project', 'workflow', 'repository', 'context', 'operations'],
  sql_dependencies: ['project', 'workflow', 'repository', 'context'],
  tables: [
    'assist_sessions', 'assist_turns', 'assist_messages', 'assist_events',
    'assist_operations', 'assist_session_snapshots', 'assist_turn_snapshots', 'assist_session_heads',
    'assist_turn_heads', 'assist_operation_links', 'assist_event_cursors', 'assist_change_batches', 'assist_checkpoints', 'attachments',
    'runtime_approvals', 'runtime_user_inputs', 'ui_action_intents', 'file_changes'
  ],
  commands: [
    'assist_session.create', 'assist_turn.create', 'assist_session.transition', 'assist.turn.retry', 'assist.turn.cancel', 'assist.events.cursor',
    'change_batch.create', 'change_batch.apply', 'change_batch.rollback',
    'runtime_approval.create', 'runtime_approval.decide',
    'runtime_user_input.create', 'runtime_user_input.resolve',
    'ui_action_intent.create', 'ui_action_intent.resolve', 'attachment.create'
  ],
  events: [
    'assist.session.created', 'assist.turn.created', 'assist.turn.failed',
    'assist.goal', 'assist.plan', 'assist.message', 'assist.turn.queued', 'assist.turn.running', 'assist.turn.completed', 'assist.turn.cancelled', 'assist.session.cancel', 'assist.session.interrupt', 'assist.session.resume', 'assist.session.complete',
    'assist.change_batch.proposed', 'assist.change_batch.applied',
    'assist.change_batch.rolled_back', 'attachment.created',
    'runtime.approval.requested', 'runtime.approval.approved',
    'runtime.approval.rejected', 'runtime.user_input.requested',
    'runtime.user_input.answered'
  ]
});
