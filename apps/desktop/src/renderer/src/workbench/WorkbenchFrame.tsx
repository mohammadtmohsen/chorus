import type { WorkbenchGeometry } from '../host-views.js'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkbenchRect } from '../../../shared/workbench-ipc.js'
import { useWorkbenchStill } from '../workspace/overlay.js'

/**
 * How long a released surface waits before it is really closed.
 *
 * **A remount is not a close, and React offers no way to tell them apart.** The
 * cleanup that releases and the effect that re-acquires run in the same commit,
 * one straight after the other, so a surface parked here is adopted by the new
 * frame long before this elapses.
 *
 * This is what makes splitting a pane survivable. `LayoutView` renders a leaf as
 * `EditorPane` and a branch as a `div`, so splitting a pane turns a leaf into a
 * branch and React sees the element *type* at that position change — the whole
 * `EditorPane` subtree is torn down and rebuilt one level deeper. No key can
 * prevent that, because the nesting really did change depth. Without parking,
 * every split and every unsplit destroyed the target pane's `WebContents` and
 * booted a fresh workbench: open editors gone, terminals gone, and the new
 * extension host failing to activate against a server the old connection had
 * just dropped — reported as "splitting reloads the editor and extension
 * activation fails", which is exactly what it was.
 *
 * **Deliberately a few frames and not a second.** A released surface keeps its
 * last rectangle and stays visible until it is closed, so the grace is also how
 * long a genuinely closed project can hang over the layout that grew into its
 * place. Hiding it first would mean sending `setWorkbenchVisible`, and that
 * channel means "the Editor switch is off for this project" — main keys it by
 * root and remembers it across surfaces, so borrowing it to veil a corpse would
 * write the wrong thing about a project nobody had switched off. A hundred
 * milliseconds is far more than a commit needs and short enough that the stale
 * rectangle is not a thing anyone sees.
 */
const RELEASE_GRACE_MS = 100

/**
 * Surfaces released by an unmounted frame and not yet closed, by target.
 *
 * Module-level because the whole point is to outlive the component. At most one
 * entry per target: a second release for a key closes the first immediately
 * rather than letting two timers race over one slot.
 */
const parked = new Map<string, { readonly viewId: string; readonly timer: number }>()

const targetKey = (target: { readonly grant: string } | { readonly projectId: string }): string =>
  'grant' in target ? `grant:${target.grant}` : `project:${target.projectId}`

const measure = (element: HTMLElement): WorkbenchRect => {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export type { WorkbenchGeometry } from '../host-views.js'

const sameGeometry = (left: WorkbenchGeometry, right: WorkbenchGeometry): boolean =>
  left.layoutWidth === right.layoutWidth &&
  left.rect.x === right.rect.x &&
  left.rect.y === right.rect.y &&
  left.rect.width === right.rect.width &&
  left.rect.height === right.rect.height

const pin = (element: HTMLElement, rect: WorkbenchRect): void => {
  element.style.setProperty('--native-x', `${String(rect.x)}px`)
  element.style.setProperty('--native-y', `${String(rect.y)}px`)
  element.style.setProperty('--native-width', `${String(rect.width)}px`)
  element.style.setProperty('--native-height', `${String(rect.height)}px`)
}

/*
 * A close that fails has already got what it wanted, and the refusal is
 * deliberately unreadable.
 *
 * `closeSurface` throws for an id it does not hold, and it says the same thing
 * for "already gone" as for "not yours" — on purpose, so that nothing here can
 * learn whether an id exists. That makes the two cases indistinguishable to this
 * caller, and the only one it can actually reach is the first: main tears a
 * shell's surfaces down itself on reload and on window destruction, which races
 * the close that would come from here. Left unhandled, that race is an unhandled
 * promise rejection every time a shell reloads with a workbench open. It is not
 * reported either — `onFailed` is about a surface that would not open, and this
 * one is closed.
 */
const closeQuietly = (viewId: string): void => {
  window.chorus.closeWorkbench({ viewId }).catch(() => {
    /* the surface is gone, which is what the call was for */
  })
}

const release = (key: string, viewId: string): void => {
  const previous = parked.get(key)
  if (previous !== undefined) {
    window.clearTimeout(previous.timer)
    closeQuietly(previous.viewId)
  }
  parked.set(key, {
    viewId,
    timer: window.setTimeout(() => {
      parked.delete(key)
      closeQuietly(viewId)
    }, RELEASE_GRACE_MS),
  })
}

/** The surface parked for this target, claimed and disarmed, or `null`. */
const adopt = (key: string): string | null => {
  const entry = parked.get(key)
  if (entry === undefined) return null
  window.clearTimeout(entry.timer)
  parked.delete(key)
  return entry.viewId
}

/**
 * The shell's handle on one surface — and it contains nothing.
 *
 * The workbench is composited by the window, not by this subtree: the element
 * below is a placeholder whose only job is to have a rectangle, which main mirrors
 * onto a `WebContentsView` sitting over it. That is the cost preflight §4.1a
 * accepted when it chose the view over a frame, and it is why every layout bug
 * here is a two-process bug.
 *
 * This file must never pull a `@codingame/*` module into the outer bundle —
 * R1's 0.5 MB threshold is a leak detector for exactly that, not a budget. An
 * `import type` is erased before the bundler sees it, so it costs nothing and is
 * not the thing that rule guards; `workspace/overlay.ts` is forty lines of
 * React and imports nothing itself, which is the bar any future import here has
 * to clear. It used to say "nothing but React and a type", which read as a
 * stronger rule than the one that matters.
 *
 * It never sees a descriptor. It holds an opaque view id, which is useless if it
 * leaks because every operation it names is mediated by main and validated
 * against the project main opened it for.
 *
 * What it opens with is **never a path** — it is one of `WorkbenchTarget`'s two
 * arms, and both are things main can refuse. A **grant** is minted from the
 * native chooser and bound to this window, which is what a folder being adopted
 * for the first time produces. A **project id** names something already in the
 * registry, and `ProjectService.resolveRoot` refuses one nobody adopted; that arm
 * is what a project pane uses, because requiring a grant there would mean
 * re-choosing every project on every launch.
 *
 * `projectRoot` is here to be *displayed*, and nothing else reads it.
 */
export function WorkbenchFrame({
  target,
  projectRoot,
  hidden = false,
  geometry,
  onActivityBar,
  onRevealRow,
  onScrollRow,
  onFailed,
}: {
  readonly target: { readonly grant: string } | { readonly projectId: string }
  /** For the placeholder's label and its test hook. Never sent to main. */
  readonly projectRoot: string
  /**
   * **Not an unmount**, which is why this is a prop rather than the caller
   * simply not rendering the frame: unmounting runs the cleanup below, and that
   * closes the surface — a whole `WebContents` destroyed, every open file lost,
   * and a reload on the way back. Hidden instead means main makes the view
   * invisible and this stops reporting bounds, so the surface keeps its
   * rectangle and nothing inside it reflows.
   */
  readonly hidden?: boolean
  readonly geometry?: (host: HTMLElement) => WorkbenchGeometry | null
  readonly onActivityBar?: (width: number) => void
  readonly onRevealRow?: () => void
  readonly onScrollRow?: (delta: number) => void
  readonly onFailed: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const [viewId, setViewId] = useState<string | null>(null)
  const still = useWorkbenchStill(viewId)
  const latest = useRef({ geometry, onActivityBar, onRevealRow, onScrollRow })
  latest.current = { geometry, onActivityBar, onRevealRow, onScrollRow }
  const pinned = geometry !== undefined
  const tracksActivityBar = onActivityBar !== undefined
  const revealsRow = onRevealRow !== undefined
  const scrollsRow = onScrollRow !== undefined

  useEffect(() => {
    /*
     * `StrictMode` mounts, unmounts and mounts again in development, and the open
     * is asynchronous — so the cleanup can run before the id exists. Without the
     * flag the second mount's surface is the only one anybody closes and the
     * first leaks a whole `WebContents`, which is invisible until R11 counts
     * processes.
     */
    let live = true
    let opened: string | null = null
    const key = targetKey(target)

    /*
     * The surface the last frame on this target left behind, if it is still
     * within its grace — a split, an unsplit, or anything else that moves a pane
     * to a different depth in the layout tree. Adopting is synchronous and does
     * no IPC at all: the view is already open, already positioned and already
     * showing the person's files, so the remount is invisible.
     */
    const inherited = adopt(key)
    if (inherited !== null) {
      opened = inherited
      setViewId(inherited)
    } else {
      window.chorus
        .openWorkbench(target)
        .then(({ viewId: id }) => {
          opened = id
          /*
           * Closed rather than parked. Parking would let a remount adopt it, but
           * that remount has already run its own effect and found nothing to
           * adopt, so it opened a second surface — parking here would leak one of
           * the two. Nothing is lost by closing: a surface still opening has no
           * editors, no terminals and no activated extensions to preserve.
           */
          if (!live) {
            closeQuietly(id)
            return
          }
          setViewId(id)
        })
        .catch((error: unknown) => {
          if (live) onFailed(error instanceof Error ? error.message : String(error))
        })
    }

    return () => {
      live = false
      if (opened !== null) release(key, opened)
    }
    /*
     * Keyed on the target's own value, not the object. A parent that rebuilds
     * `{ projectId }` inline every render would otherwise close and reopen a
     * whole `WebContents` on each paint — and the surface is the single most
     * expensive thing this app creates.
     */
  }, ['grant' in target ? target.grant : target.projectId, onFailed])

  /*
   * Told once per change, and never as part of the bounds loop.
   *
   * Visibility is a state with two values and bounds are a stream, so folding
   * this into `report` would send a redundant call on every rectangle change and
   * — worse — make "is the editor off" depend on a loop this effect stops when
   * it is off. It is its own effect for the same reason it is its own channel.
   *
   * No cleanup that shows it again: the surface is closed on unmount by the
   * effect above, and asking main to reveal a view that is about to be destroyed
   * is a race with no winner.
   */
  useEffect(() => {
    if (viewId === null) return undefined
    /*
     * Reported, not swallowed — and the swallow is why the first version of this
     * took three attempts to diagnose.
     *
     * A rejected call here means the switch did nothing: the region leaves the
     * layout, Chorus grows into it, and the view goes on painting over the top
     * with no error anywhere. That is indistinguishable from a CSS bug from the
     * outside, which is exactly where the time went. The **lifecycle** decides
     * whether it matters, on the same rule the bounds effect below follows: after
     * cleanup the surface is closing and a lost race says nothing, but on a frame
     * that is still mounted the refusal is a defect and belongs on screen.
     */
    let live = true
    window.chorus.setWorkbenchVisible({ visible: !hidden, viewId }).catch((error: unknown) => {
      if (live) onFailed(error instanceof Error ? error.message : String(error))
    })
    return () => {
      live = false
    }
  }, [viewId, hidden, onFailed])

  useEffect(() => {
    if (viewId === null || !tracksActivityBar) return undefined
    let live = true
    let pushed = false
    const stop = window.chorus.onWorkbenchActivityBar((push) => {
      if (push.viewId !== viewId) return
      pushed = true
      latest.current.onActivityBar?.(push.width)
    })
    window.chorus
      .readWorkbenchActivityBar({ viewId })
      .then(({ width }) => {
        if (live && !pushed) latest.current.onActivityBar?.(width)
      })
      .catch((error: unknown) => {
        if (live) onFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      live = false
      stop()
    }
  }, [viewId, tracksActivityBar, onFailed])

  useEffect(() => {
    if (viewId === null || !revealsRow || hidden) return undefined
    return window.chorus.onWorkbenchRowReveal((push) => {
      if (push.viewId === viewId) latest.current.onRevealRow?.()
    })
  }, [viewId, revealsRow, hidden])

  useEffect(() => {
    if (viewId === null || !scrollsRow || hidden) return undefined
    return window.chorus.onWorkbenchRowScroll((push) => {
      if (push.viewId === viewId) latest.current.onScrollRow?.(push.delta)
    })
  }, [viewId, scrollsRow, hidden])

  useEffect(() => {
    const element = host.current
    /*
     * Nothing reported while the editor is off, and that is what keeps it from
     * reflowing. The region is `hidden`, so its rectangle is 0×0 — reporting
     * that would resize the view to nothing and the workbench would re-lay-out
     * to zero columns, losing scroll position and the editor group's layout on
     * the way back.
     */
    if (viewId === null || element === null || hidden) return undefined

    /*
     * The same race `closeQuietly` loses, and deliberately **not** the same
     * answer to it.
     *
     * `setSurfaceBounds` goes through `ownedSurface`, so it refuses an id main no
     * longer holds with the identical unreadable message — and a report in flight
     * when main tears the shell's surfaces down loses that race exactly as a
     * close does. Left as a bare `void` that is an unhandled rejection every time
     * a shell reloads with a workbench open, which is what this fixes.
     *
     * What it must not become is a second silent swallow. A close that fails has
     * already got what it wanted; a bounds call that fails has not. On a frame
     * that is still mounted the refusal means the surface is gone while this
     * component believes it is there — the view will never be moved again, and
     * the symptom is an overlay that quietly stops tracking rather than an error
     * anybody sees. So the **lifecycle** decides and never the error, because the
     * two cases are indistinguishable by message on purpose: after cleanup, the
     * losing report is expected and says nothing; before it, the same string is a
     * defect and goes to `onFailed` like any other.
     */
    let live = true

    /*
     * The rectangle is **measured every frame**, not subscribed to, and that is
     * the whole of E1.
     *
     * What stood here was a `ResizeObserver` on this element plus a `resize`
     * listener on the window — two subscriptions that between them cover *size*
     * and nothing else. An element moves without changing size constantly: a
     * sibling pane closing, a rail or a panel opening, an ancestor scrolling, a
     * tab strip reflowing, an animated layout settling. None of those is a resize
     * of anything either observer watched, so the view went on painting at its
     * old x/y over new content until something happened to resize it — not a
     * frame of lag, a permanently misplaced overlay.
     *
     * The answer is deliberately **not a third subscription**. Enumerating the
     * causes of movement fails silently by construction: the one case nobody
     * thought of produces no event, and a missing event looks exactly like a
     * stationary element. Measuring cannot miss a cause, because it never asks
     * what moved the element. The `IntersectionObserver` inset trick would be
     * cheaper at idle and buys the same silence at a higher price — its root
     * margins are subtle enough that arithmetic which is slightly wrong yields an
     * observer that quietly never fires.
     *
     * The cost is one `getBoundingClientRect` per frame per mounted surface, read
     * inside `requestAnimationFrame` — before style and layout, so it forces the
     * layout that frame was going to perform anyway, and nothing is written back,
     * which is what would make it thrash. The expensive part is the IPC, and that
     * is sent **only when the rectangle differs from the one last sent**, so an
     * idle workbench sends nothing at all after its opening report.
     *
     * Bounds are read in CSS pixels and sent as device-independent pixels, which
     * are the same number only while the zoom factor is 1. The conversion is real
     * and it happens on the other side of this boundary: `setSurfaceBounds`
     * multiplies by the current factor as it applies the rectangle. Main is where
     * that belongs — it is the process that holds the factor, `setBounds` is the
     * call that wants device pixels, and doing it here would put a second copy of
     * main's state inside a loop that runs on every frame.
     *
     * A zoom change still needs no report of its own, which is worth saying
     * because it looks like it should. `setZoomFactor` scales the CSS viewport by
     * the reciprocal, so every rectangle this loop measures changes with it and
     * the next frame reports — and the view keeps the physical rectangle it had,
     * because CSS pixels and the factor move in opposite directions.
     */
    let last: WorkbenchGeometry | null = null

    const report = (): void => {
      const read = latest.current.geometry
      const next =
        read === undefined ? { rect: measure(element), layoutWidth: undefined } : read(element)
      if (next === null || (last !== null && sameGeometry(last, next))) return
      last = next
      if (read !== undefined) pin(element, next.rect)
      window.chorus
        .setWorkbenchBounds(
          next.layoutWidth === undefined
            ? { viewId, rect: next.rect }
            : { viewId, rect: next.rect, layoutWidth: next.layoutWidth }
        )
        .catch((error: unknown) => {
          if (live) onFailed(error instanceof Error ? error.message : String(error))
        })
    }

    /*
     * Reports first and schedules second, so the opening report is synchronous
     * with the effect rather than a frame late — the surface must be positioned
     * before it is first composited, not after one frame in the wrong place.
     */
    let frame = 0
    const tick = (): void => {
      report()
      frame = window.requestAnimationFrame(tick)
    }
    tick()

    return () => {
      /*
       * First, and before the loop is cancelled: everything after this line is
       * the frame no longer being on screen, so a report that has already left is
       * one this component can no longer act on. Cancelling stops new reports; it
       * does nothing about the one already in flight, which is the only one that
       * can lose the race.
       */
      live = false
      window.cancelAnimationFrame(frame)
    }
  }, [viewId, hidden, onFailed])

  /*
   * The one thing this placeholder ever draws, and only while an overlay is up.
   *
   * The view is hidden for the life of that overlay so the shell's DOM can be
   * seen; this is the frame it was showing when it went down, so the region
   * still looks like an editor rather than a hole. See `workspace/overlay.ts`.
   *
   * `alt=""` and `aria-hidden`: it is a picture of something the person can
   * already see, and announcing it would put a second copy of the editor into
   * the reading order of a dialog whose whole job is to be the only thing there.
   */
  return (
    <div className="workbench-surface" ref={host} data-workbench-surface={projectRoot}>
      {still !== null && (
        <img
          className="workbench-still"
          src={still}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-native={pinned || undefined}
        />
      )}
      {/*
        Something to look at while the surface opens, and it is not decoration.

        Until the view exists this element is the whole of what the region draws,
        and what it drew was nothing — so the editor was a black rectangle for as
        long as the open took. On a first run that is a 76 MB download, a
        checksum over it, a 257 MB extraction, a server spawn and the workbench's
        own boot, and none of it is quick. Reported as "the editor did not
        appear", which is exactly what an empty region says.

        It is deliberately underneath the still rather than replacing it: an
        overlay opening mid-open must keep showing the frozen frame, not swap it
        for a spinner.

        No progress figure, because there is honestly none to give — main reports
        no stages, and a fake bar that sits at 90% is worse than a sentence that
        admits it does not know. If the stages ever are reported, this is where
        they land.
      */}
      {viewId === null && (
        <p className="workbench-pending" role="status">
          {t('workbench.opening')}
        </p>
      )}
    </div>
  )
}
