import { defineModule } from '../define-module.mjs';

export default defineModule({
  id: 'terminal',
  dependencies: ['platform', 'project', 'assist'],
  tables: ['terminal_sessions', 'terminal_events'],
  commands: ['terminal.create', 'terminal.input', 'terminal.resize', 'terminal.signal', 'terminal.stop'],
  events: [
    'terminal.opened', 'terminal.started', 'terminal.output', 'terminal.resized',
    'terminal.signalled', 'terminal.orphaned', 'terminal.closed', 'terminal.failed'
  ]
});
