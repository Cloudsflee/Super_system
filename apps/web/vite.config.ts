import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const runtimeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
  const target = runtimeEnv.AIWS_WEB_API_TARGET || env.AIWS_WEB_API_TARGET || 'http://127.0.0.1:4317';
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target, ws: true },
        '/health': { target },
        '/readyz': { target }
      }
    },
    build: {
      manifest: true,
      rollupOptions: { output: { manualChunks: { 'vendor-react': ['react', 'react-dom'], 'vendor-icons': ['lucide-react'] } } }
    },
    test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', fileParallelism: false }
  };
});
