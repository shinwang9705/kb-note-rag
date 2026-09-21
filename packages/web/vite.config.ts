import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 开发态直接指向 shared 源码，避免要求 shared 先构建
      '@kb/shared': path.resolve(root, '../shared/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // 保持 /api 前缀
        rewrite: (p) => p,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
