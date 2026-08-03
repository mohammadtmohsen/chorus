import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'adapter-claude', environment: 'node', include: ['src/**/*.test.ts'] },
})
