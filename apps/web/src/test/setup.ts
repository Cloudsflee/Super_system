import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { queryClient } from '../query';

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

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
