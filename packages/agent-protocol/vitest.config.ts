import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'agent-protocol', environment: 'node', include: ['src/**/*.test.ts'] },
})
