import { useEffect, useRef, useState } from 'react'
import { nextShown, paceFor } from './typewriter.js'

/**
 * The visible prefix of `text`, catching up frame by frame.
 *
 * Only what is on screen changes; `text` is always the whole of what has
 * arrived, so nothing is lost if this is interrupted, unmounted, or turned off.
 *
 * `startWhole` is for messages that were never watched being written — history
 * replayed at launch, a transcript restored into a reopened pane. Typing those
 * out would be a performance of something that already happened.
 */
/**
 * How long without a frame counts as nobody watching.
 *
 * Comfortably longer than a dropped frame or two on a busy machine, and short
 * enough that revealing the window shows the answer rather than the tail of an
 * animation for something that finished while it was hidden.
 */
const STALL_MS = 1_000

/**
 * @param complete The message has finished arriving, so there is nothing left
 *   to smooth. The authoritative text is shown at once rather than paced out:
 *   a reveal that continues after the agent has stopped is the app saying it is
 *   behind, and it is behind *nothing* — the text is already here. This is the
 *   half of the contract that used to be missing, and `DRAIN_MS` was carrying
 *   it by being small rather than by being right.
 */
export function useTypewriter(text: string, startWhole: boolean, complete = false): string {
  const [shown, setShown] = useState(startWhole ? text.length : 0)
  const position = useRef(shown)
  /** Fixed when new text arrives, so the tail does not crawl. */
  const perSecond = useRef(paceFor(text.length))

  useEffect(() => {
    if (complete && position.current < text.length) {
      position.current = text.length
      setShown(text.length)
      return
    }
    if (position.current >= text.length) {
      // Nothing new, or the message was replaced by a shorter one.
      position.current = Math.min(position.current, text.length)
      return
    }

    // Motion nobody asked for, in a thing they are trying to read.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      position.current = text.length
      setShown(text.length)
      return
    }

    perSecond.current = paceFor(text.length - position.current)
    let frame = 0
    let last = performance.now()

    /** Everything, at once, because there is no longer any point pacing it. */
    const finish = (): void => {
      position.current = text.length
      setShown(text.length)
    }

    const tick = (now: number): void => {
      const next = nextShown(position.current, text.length, now - last, perSecond.current)
      last = now
      /*
       * The position is fractional and stays that way; only what is drawn is
       * whole. Re-rendering is the expensive half of this — a growing markdown
       * string is reparsed each time — so the state only moves when the visible
       * character count actually changes, rather than on every frame.
       */
      const wasVisible = Math.floor(position.current)
      position.current = next
      const visible = Math.floor(next)
      if (visible !== wasVisible) setShown(visible)
      if (next < text.length) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)

    /*
     * The frames stopping is not the same as the message being empty.
     *
     * `shown` starts at zero and only ever advances inside `requestAnimationFrame`,
     * so a window the compositor has stopped asking to paint — minimised, on
     * another Space, occluded by something else — leaves the visible prefix at
     * zero characters. The reply is in the log, in the view and in the DOM's own
     * data, and the transcript renders an empty bubble anyway.
     *
     * Found from an e2e test that failed about one run in four: the event log
     * held `agent.message.completed` with the full text, every event reached the
     * reducer in order, and `.said` was still empty. Relaunching the app showed
     * the answer, because replayed history starts whole.
     *
     * A watchdog rather than a check of `document.hidden`, because occlusion
     * starves the frame callback without ever marking the document hidden. If no
     * frame has run for a second, nobody is watching the animation, so the point
     * of the animation is gone and only its cost remains.
     */
    const watchdog = setInterval(() => {
      if (performance.now() - last < STALL_MS) return
      clearInterval(watchdog)
      cancelAnimationFrame(frame)
      finish()
    }, STALL_MS / 2)

    return () => {
      cancelAnimationFrame(frame)
      clearInterval(watchdog)
    }
  }, [text, complete])

  return text.slice(0, shown)
}
