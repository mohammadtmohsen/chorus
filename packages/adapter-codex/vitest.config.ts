import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'adapter-codex', environment: 'node', include: ['src/**/*.test.ts'] },
})
