import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * `node` stays the default, and that is the point.
 *
 * Almost everything worth testing here is a pure function — `reduceEvents`,
 * `reducePulse`, `noticesFrom`, `mayTakeCaret` — and a DOM those tests never
 * touch is a second environment to boot for nothing.
 *
 * The exception is a bug that *is* a lifecycle: `useDialog` re-running its
 * effect on every render of the caller has no pure part to extract, because the
 * defect is the dependency array itself. Those files opt in per file with
 * `@vitest-environment jsdom` rather than the project opting in globally, so the
 * convention is still "pure unless there is a reason".
 *
 * `.tsx` is included because such a test needs a component to render; the React
 * plugin is here to compile it.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
