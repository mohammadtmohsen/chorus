/**
 * A counter that does not exist until something asks for it.
 *
 * Phase 4 of the readable-control-rail plan is written as a claim about render
 * counts — "row and shell render counts stay flat during an ordinary text
 * delta" — and there was no way to observe that from outside the app. React's
 * own profiler needs a profiling build, which this app does not ship and should
 * not start shipping to answer one question.
 *
 * So the seam is a global that the renderer never creates. `perf-rail.mjs`
 * installs `window.__chorusRenderCounts` over the debugger protocol before a
 * workload and reads it afterwards; in every other run the lookup fails and
 * this is one property read per render. Nothing is logged, nothing is retained,
 * and there is no flag to leave switched on by accident.
 */

interface CountingWindow {
  __chorusRenderCounts?: Record<string, number>
}

export function countRender(name: string): void {
  const counts = (window as unknown as CountingWindow).__chorusRenderCounts
  if (counts === undefined) return
  counts[name] = (counts[name] ?? 0) + 1
}
