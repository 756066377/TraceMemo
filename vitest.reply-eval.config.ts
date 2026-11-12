import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'reply-evaluation',
    environment: 'node',
    include: ['tests/evaluation/reply-assistant-live.test.ts'],
    testTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1
  }
})
