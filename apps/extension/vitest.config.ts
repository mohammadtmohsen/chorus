import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    name: 'extension',
    environment: 'node',
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    testTimeout: 10000,
  },
})
