import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'execution',
  dependencies: ['platform', 'workflow', 'context', 'runner', 'evidence'],
  tables: ['executions', 'task_attempts', 'execution_inputs', 'execution_stage_checkpoints', 'events'],
  commands: ['execution.create', 'execution.start', 'execution.cancel', 'execution.evidence.resolve'],
  events: [
    'execution.created', 'execution.started', 'execution.cancelled', 'execution.completed',
    'execution.failed', 'execution.stage.changed', 'task.ready', 'task.running',
    'task.completed', 'task.failed', 'task.awaiting_human'
  ]
});
