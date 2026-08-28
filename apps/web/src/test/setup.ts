import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// React Router's data router receives jsdom AbortSignals while Node's Undici
// Request validates against its own realm. Browser builds use the native pair.
const NativeRequest = globalThis.Request;
if (NativeRequest) {
  globalThis.Request = class CompatibleRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init: RequestInit = {}) {
      const { signal: _signal, ...compatible } = init;
      super(input, compatible);
    }
  } as typeof Request;
}
