/// <reference types="vitest" />
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiDevPlugin } from './dev-api-plugin';

export default defineConfig(({ mode }) => {
  // api/chat.ts and api/exec.ts read process.env.GROQ_API_KEY etc. directly
  // (that's how Vercel injects env vars in production for both Edge and
  // Node functions) — Vite's own env loading only exposes vars to `import.meta.env`
  // by default, so mirror .env.local into process.env for the dev-api-plugin's
  // in-process handlers to see the same values.
  const env = loadEnv(mode, '.', '');
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-lucide': ['lucide-react'],
            'vendor-zustand': ['zustand']
          }
        }
      }
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./setupTests.ts'],
      globals: true,
    },
    plugins: [react(), tailwindcss(), apiDevPlugin()],
    worker: {
      format: 'es',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
