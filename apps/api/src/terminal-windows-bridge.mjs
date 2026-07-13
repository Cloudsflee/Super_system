import { HttpError } from './http.mjs';
import { hostBridgeCapability, openHostBridgeTerminal } from './host-bridge-service.mjs';

export async function createWindowsBridgeProcess({ session, worktree, profile }) {
  const capability = await hostBridgeCapability();
  if (!capability.available) throw new HttpError(409, { error: capability.reason, action: capability.reason === 'windows_bridge_not_paired' ? 'install_bridge' : 'check_bridge' });
  const queued = [], handlers = { data: null, exit: null }, dispatch = (frame) => {
    if (frame.type === 'terminal_output') {
      if (handlers.data) handlers.data(String(frame.data || '')); else queued.push(frame);
    } else if (frame.type === 'terminal_exit' || frame.type === 'error') {
      const value = { exitCode: frame.type === 'terminal_exit' ? Number(frame.exit_code || 0) : 1, signal: frame.error || null };
      if (handlers.exit) handlers.exit(value); else queued.push({ type: 'exit', value });
    }
  };
  const controller = await openHostBridgeTerminal({
    deviceId: session.host_bridge_device_id || capability.device_id, sessionId: session.id, worktree,
    model: session.model || profile.model, reasoning: session.reasoning || profile.reasoning, cols: session.cols, rows: session.rows,
    onFrame: dispatch
  });
  const flush = () => { for (const frame of queued.splice(0)) frame.type === 'terminal_output' ? handlers.data?.(String(frame.data || '')) : frame.type === 'exit' ? handlers.exit?.(frame.value) : undefined; };
  return {
    pid: null,
    onData(handler) { handlers.data = handler; flush(); },
    onExit(handler) { handlers.exit = handler; flush(); },
    write(data) { void controller.input(data).catch(() => undefined); },
    resize(cols, rows) { void controller.resize(cols, rows).catch(() => undefined); },
    kill() { void controller.stop().catch(() => undefined); }
  };
}
