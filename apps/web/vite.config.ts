import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', ws: true },
      '/livez': { target: 'http://127.0.0.1:4317' },
      '/readyz': { target: 'http://127.0.0.1:4317' }
    }
  },
  build: {
    manifest: true,
    rollupOptions: { output: { manualChunks: { 'vendor-react': ['react', 'react-dom'], 'vendor-icons': ['lucide-react'] } } }
  },
  test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', fileParallelism: false }
});
