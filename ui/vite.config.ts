/// <reference types="vitest" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/dashboard/' : '/',
  plugins: [react()],
  server: {
    port: 3002,
    // Proxy all backend API routes to the Koa server in dev
    proxy: {
      '/info': 'http://localhost:3000',
      '/status': 'http://localhost:3000',
      '/peers': 'http://localhost:3000',
      '/config': 'http://localhost:3000',
      '/logs': 'http://localhost:3000',
      '/restart': 'http://localhost:3000',
      '/gift-wallet': 'http://localhost:3000',
      '/swap': 'http://localhost:3000',
      '/redeem': 'http://localhost:3000',
      '/withdraw': 'http://localhost:3000',
      '/feed-update': 'http://localhost:3000',
      '/buy-stamp': 'http://localhost:3000',
      // Bee node API — proxied to avoid CORS issues in dev
      '/bee-api': {
        target: 'http://localhost:1633',
        rewrite: (path: string) => path.replace(/^\/bee-api/, ''),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'build',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
