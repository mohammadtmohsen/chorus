import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'workspace', environment: 'node', include: ['src/**/*.test.ts'] },
})
