import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // Domain packages must be unit-testable in milliseconds (plan §3.2). A slow
    // suite is a suite that stops being run.
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // The policy engine is the security boundary — plan §8 sets its bar at 90%.
      thresholds: {
        'packages/orchestrator/src/policy/**': {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
})
