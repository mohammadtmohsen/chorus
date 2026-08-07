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
export function useTypewriter(text: string, startWhole: boolean): string {
  const [shown, setShown] = useState(startWhole ? text.length : 0)
  const position = useRef(shown)
  /** Fixed when new text arrives, so the tail does not crawl. */
  const perSecond = useRef(paceFor(text.length))

  useEffect(() => {
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
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [text])

  return text.slice(0, shown)
}
