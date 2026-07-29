import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4318', ws: true, rewrite: (value) => value.replace(/^\/api/, '') }
    }
  },
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-flow': ['@xyflow/react'],
          'vendor-state': ['@tanstack/react-query', 'zustand']
        }
      }
    }
  },
  test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', fileParallelism: false }
});
