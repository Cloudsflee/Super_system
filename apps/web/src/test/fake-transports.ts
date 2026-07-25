export class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen?: () => void;
  onerror?: () => void;
  listeners = new Map<string, (event: Event) => void>();
  constructor(_url: string) {
    FakeEventSource.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }
  close() {}
  emit(type: string, value: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(value) } as unknown as Event);
  }
}

export class FakeWebSocket {
  static OPEN = 1;
  static last: FakeWebSocket | null = null;
  readyState = 1;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
