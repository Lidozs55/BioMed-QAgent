import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],

    // 有界并发：本机默认 4 个 worker（threads 池足够，React/jsdom 测试无子进程），
    // CI（CI=true）才扩大到机器可用并行度。
    pool: 'threads',
    maxWorkers: process.env.CI ? '75%' : 4,
    maxConcurrency: process.env.CI ? 8 : 4,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
