import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'ide-protocol', environment: 'node', include: ['src/**/*.test.ts'] },
})
