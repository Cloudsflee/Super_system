import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { api, json, websocketUrl } from '../../api/client';
import type { TerminalSession } from '../../api/types';

export type TerminalConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
type TerminalCallbacks = {
  onSession: (value: TerminalSession) => void;
  onError: (message: string) => void;
  onConnection: (state: TerminalConnectionState) => void;
};

export class TerminalRuntime {
  #session: TerminalSession;
  #callbacks: TerminalCallbacks;
  #socket: WebSocket | null = null;
  #terminal: XtermTerminal | null = null;
  #fit: XtermFitAddon | null = null;
  #observer: ResizeObserver | null = null;
  #reconnectTimer: number | null = null;
  #disposed = false;
  #ended = false;
  #attempts = 0;

  constructor(
    private readonly host: HTMLElement,
    session: TerminalSession,
    callbacks: TerminalCallbacks
  ) {
    this.#session = session;
    this.#callbacks = callbacks;
    this.#ended = isTerminalSessionEnded(session.status);
    callbacks.onConnection(this.#ended ? 'closed' : 'connecting');
  }

  update(session: TerminalSession, callbacks: TerminalCallbacks) {
    this.#session = session;
    this.#callbacks = callbacks;
  }

  async start() {
    try {
      const [xterm, addon] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (this.#disposed) return;
      const terminal = new xterm.Terminal({
          convertEol: true,
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"Cascadia Code", Consolas, monospace',
          theme: { background: '#171b1d', foreground: '#dce3e6', cursor: '#7bc5ad' },
          scrollback: 10_000
        }),
        fit = new addon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(this.host);
      this.#terminal = terminal;
      this.#fit = fit;
      terminal.onData((data) => this.send({ type: 'input', data }));
      terminal.attachCustomKeyEventHandler((event) => this.#handleKey(event));
      this.#observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
      this.#observer?.observe(this.host);
      window.setTimeout(() => {
        this.resize();
        this.#connect();
      }, 0);
    } catch (error) {
      this.#callbacks.onError((error as Error).message);
    }
  }

  dispose() {
    this.#disposed = true;
    this.#ended = true;
    if (this.#reconnectTimer) window.clearTimeout(this.#reconnectTimer);
    this.#observer?.disconnect();
    this.#socket?.close();
    this.#terminal?.dispose();
    this.#socket = null;
    this.#terminal = null;
  }

  send(value: Record<string, unknown>) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(value));
  }

  reconnect() {
    this.#ended = false;
    this.#attempts = 0;
    this.#connect();
  }

  async stop() {
    try {
      const value = await api<TerminalSession>(
        `/assist/v3/terminal-sessions/${this.#session.id}/stop`,
        json('POST', undefined, '停止终端会话')
      );
      this.#ended = true;
      this.#callbacks.onSession(value);
      this.#socket?.close();
      this.#callbacks.onConnection('closed');
    } catch (error) {
      this.#callbacks.onError((error as Error).message);
    }
  }

  #connect() {
    if (this.#ended || this.#disposed) return;
    if (this.#socket) {
      this.#socket.onclose = null;
      this.#socket.close();
    }
    this.#callbacks.onConnection(this.#attempts ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(websocketUrl(`/assist/v3/terminal-sessions/${this.#session.id}/ws`));
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempts = 0;
      this.#callbacks.onConnection('connected');
      this.resize();
    };
    socket.onmessage = (event) => this.#handleMessage(event);
    socket.onerror = () => this.#callbacks.onConnection('reconnecting');
    socket.onclose = (event) => this.#handleClose(event);
  }

  #handleMessage(event: MessageEvent) {
    const message = JSON.parse(String(event.data)) as {
      type: string;
      data?: string;
      replay?: boolean;
      session?: TerminalSession;
    };
    if (message.type === 'output' && message.data) {
      if (message.replay) this.#terminal?.reset();
      this.#terminal?.write(message.data);
    }
    if (message.type === 'status' && message.session) {
      if (isTerminalSessionEnded(message.session.status)) this.#markEnded();
      this.#callbacks.onSession(message.session);
    }
    if (message.type === 'exit' && message.session) {
      this.#markEnded();
      this.#callbacks.onSession(message.session);
    }
  }

  #handleClose(event: CloseEvent) {
    if (this.#ended || (event.code === 1000 && isTerminalSessionEnded(this.#session.status))) {
      this.#callbacks.onConnection('closed');
      return;
    }
    this.#attempts += 1;
    if (this.#attempts > 6) {
      this.#callbacks.onConnection('closed');
      this.#callbacks.onError('终端连接重连失败');
      return;
    }
    this.#reconnectTimer = window.setTimeout(() => this.#connect(), Math.min(5_000, 400 * 2 ** this.#attempts));
  }

  #handleKey(event: KeyboardEvent) {
    if (event.ctrlKey && event.key.toLowerCase() === 'c' && event.type === 'keydown') {
      this.send({ type: 'signal', signal: 'SIGINT' });
      return false;
    }
    return true;
  }

  #markEnded() {
    this.#ended = true;
    this.#callbacks.onConnection('closed');
  }

  private resize() {
    try {
      this.#fit?.fit();
      if (this.#terminal) this.send({ type: 'resize', cols: this.#terminal.cols, rows: this.#terminal.rows });
    } catch {
      // The host may be temporarily hidden while switching Assist views.
    }
  }
}

export function isTerminalSessionEnded(value: string) {
  return ['exited', 'failed', 'stopped', 'interrupted'].includes(value);
}
