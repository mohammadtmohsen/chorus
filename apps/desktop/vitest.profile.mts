import { defineConfig } from 'vitest/config'

/**
 * A second config, for the measurements that must never join the fast suite.
 *
 * `profile/` opens a 272 MB copy of a real event store and reads whole
 * conversations through every stage of the transcript path. That takes tens of
 * seconds and needs a fixture no CI runner has, so it is deliberately outside
 * `src/**` — the include glob in `vitest.config.mts` cannot reach it, and
 * `pnpm check` stays a gate rather than a benchmark.
 *
 * Run it on purpose:
 *   pnpm --filter @chorus/desktop exec vitest run --config vitest.profile.mts
 */
export default defineConfig({
  test: {
    name: 'profile',
    environment: 'node',
    include: ['profile/**/*.profile.ts'],
    // One conversation at a time: two 15k-event reductions racing each other
    // would measure contention rather than either one.
    fileParallelism: false,
    testTimeout: 600_000,
  },
})
