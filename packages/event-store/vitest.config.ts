import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'event-store', environment: 'node', include: ['src/**/*.test.ts'] },
})
