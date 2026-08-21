/**
 * Timestamps along the transcript path, recorded only when something asks.
 *
 * **Why this is in the app rather than in the harness.** Three of the five
 * boundaries worth measuring are not observable from outside the renderer: the
 * moment the transcript response resolves, the moment the reduction finishes,
 * and the commit that follows. A debugger can time an `invoke` and it can watch
 * the DOM, but between those two there is a reduction over thousands of events
 * and a React render, and attributing that gap to either side is guessing.
 *
 * **It is inert unless armed.** `window.__chorusProfile` is undefined in every
 * normal run, so each call is one property read and a return. The harness sets
 * it to `{}` before opening a conversation and reads it afterwards. Nothing here
 * allocates, logs, or touches the log.
 *
 * **`painted` is an approximation and is named as one.** Two animation frames
 * after commit is the conventional stand-in: the first frame is the one the
 * commit scheduled, and by the callback of the second the compositor has had the
 * first. It is not a compositor timestamp and must never be reported as one — a
 * `MutationObserver` firing is even further from paint, and reporting either as
 * "paint" is the kind of number that survives into a decision unchallenged.
 */
type ProfileSink = Record<string, number>

declare global {
  interface Window {
    __chorusProfile?: ProfileSink
  }
}

/** Records `name` at the current time, unless it is already set. */
export function profileMark(name: string): void {
  const sink = window.__chorusProfile
  if (sink === undefined) return
  // First write wins: a transcript can be re-read on reconnect, and the
  // measurement is about the first open rather than the latest one.
  if (name in sink) return
  sink[name] = performance.now()
}

/** True when a mark has been taken, so a caller can fire something once. */
export function profileHas(name: string): boolean {
  const sink = window.__chorusProfile
  return sink !== undefined && name in sink
}

/**
 * Marks `name` two animation frames from now.
 *
 * Two, not one: the frame a commit schedules is the one that carries it, so a
 * callback on that frame runs *before* the compositor has drawn it. Waiting for
 * the following frame's callback means the previous frame has been handed over.
 */
export function profileMarkAfterPaint(name: string): void {
  if (window.__chorusProfile === undefined) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      profileMark(name)
    })
  })
}
