/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';
import { NetworkOnly } from 'workbox-strategies';
import { registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision?: string }> };

precacheAndRoute(self.__WB_MANIFEST || []);

// Business data and protected binary material never enter Cache Storage.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/v2/')
    || url.pathname.startsWith('/api/v2')
    || url.pathname === '/livez'
    || url.pathname === '/readyz'
    || url.pathname.startsWith('/cas/')
    || url.pathname.startsWith('/downloads/'),
  new NetworkOnly()
);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
