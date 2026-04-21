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
      '/info': 'http://localhost:3054',
      '/status': 'http://localhost:3054',
      '/peers': 'http://localhost:3054',
      '/config': 'http://localhost:3054',
      '/logs': 'http://localhost:3054',
      '/restart': 'http://localhost:3054',
      '/swap': 'http://localhost:3054',
      '/redeem': 'http://localhost:3054',
      '/withdraw': 'http://localhost:3054',
      '/feed-update': 'http://localhost:3054',
      '/feed-read': 'http://localhost:3054',
      '/upload-bytes': 'http://localhost:3054',
      '/buy-stamp': 'http://localhost:3054',
      '/act': 'http://localhost:3054',
      '/grantee': 'http://localhost:3054',
      '/chequebook-withdraw': 'http://localhost:3054',
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
