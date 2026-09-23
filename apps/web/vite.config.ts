import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// @ts-expect-error The Web package intentionally omits Node typings; Vite loads this in Node.
import { Agent } from 'node:http';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const runtimeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
  const target = runtimeEnv.AIWS_WEB_API_TARGET || env.AIWS_WEB_API_TARGET || 'http://127.0.0.1:4317';
  const proxyAgent = new Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  return {
    plugins: [react(), VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      registerType: 'prompt',
      manifest: {
        name: 'AIWS 3.0',
        short_name: 'AIWS',
        start_url: '/',
        display: 'standalone',
        theme_color: '#f5f7f5',
        background_color: '#f5f7f5',
        icons: []
      },
      workbox: { navigateFallback: null }
    })],
    server: {
      proxy: {
        '/api': { target, ws: true, agent: proxyAgent },
        '/health': { target, agent: proxyAgent },
        '/readyz': { target, agent: proxyAgent }
      }
    },
    build: {
      manifest: true,
      rollupOptions: { output: { manualChunks: { 'vendor-react': ['react', 'react-dom'], 'vendor-icons': ['lucide-react'] } } }
    },
    test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', fileParallelism: false }
  };
});
