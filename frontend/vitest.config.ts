import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],

    // 有界并发：本地与 CI 都固定为 2，避免 React/jsdom worker 在共享 CPU 上争抢。
    pool: 'threads',
    maxWorkers: 2,
    maxConcurrency: 2,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
