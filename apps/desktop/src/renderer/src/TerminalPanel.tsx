import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TerminalRefShape } from '../../shared/ipc.js'
import type { TerminalPanelState } from '../../shared/workspace-layout.js'
import { ConfirmKillTerminal } from './ConfirmKillTerminal.js'
import { TerminalView } from './TerminalView.js'

/** The bounds a drag is clamped to, and where a panel opens. */
export const TERMINAL_HEIGHT = { default: 240, min: 96, max: 720 } as const

export function clampTerminalHeight(value: number): number {
  return Math.min(TERMINAL_HEIGHT.max, Math.max(TERMINAL_HEIGHT.min, Math.round(value)))
}

export interface TerminalPanelProps {
  /** This panel's roster. `activeId` is non-null whenever it is open. */
  readonly panel: TerminalPanelState
  /** Builds a ref for one tab. The panel never constructs a scope itself. */
  readonly refFor: (id: string) => TerminalRefShape
  readonly title: string
  /** Called once on release, not per frame. See the drag below. */
  readonly onHeightChange: (height: number) => void
  readonly onClose: () => void
  readonly onFocusAway: () => void
  readonly onAddTerminal: () => void
  readonly onActivateTerminal: (id: string) => void
  /**
   * Drop a tab from the roster. **The shell is already dead by then** — the
   * panel awaits `terminal:kill` before calling this, so a failed kill leaves
   * the tab where it is rather than orphaning a running process behind a row
   * nothing can reach.
   */
  readonly onRemoveTerminal: (id: string) => void
  /**
   * Which scope this is, as a class the keyboard handler can find.
   *
   * `⌘J` is scoped to session terminals, so it has to be able to tell — from a
   * `document`-level capture handler that only knows `document.activeElement` —
   * whether the caret is in the global panel. A class is the cheapest honest
   * answer; the alternative is threading focus state back up through the store.
   */
  readonly variant: 'global' | 'session'
  /** The combo that toggles this panel, shown in its header. */
  readonly shortcut: string
}

/**
 * The resizable dock a terminal sits in.
 *
 * Shared by both scopes: a session's panel and the global one differ in where
 * they are mounted and what they are titled, not in how they behave.
 */
export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const shell = useRef<HTMLDivElement>(null)
  const focusTerminal = useRef<(() => void) | null>(null)
  /*
   * How each shell ended, by terminal id.
   *
   * Keyed, because this used to be one `number | null` for the whole panel — and
   * with a roster that would show terminal 1's exit code above terminal 2's live
   * shell, and never clear. The id is the only thing that makes the label belong
   * to a terminal rather than to the dock it sits in.
   *
   * **A `Map`, not an object literal**, and that is not a style preference. Ids
   * are `z.string()` at the boundary and come out of a file a person can edit, so
   * `constructor`, `toString` and `__proto__` are all reachable — and on a plain
   * object every one of them reads back truthy from `Object.prototype` before
   * anything has exited. A live terminal would draw as dead, once, for a tab
   * named the wrong thing. A `Map` has no inherited keys to find.
   */
  const [exited, setExited] = useState<ReadonlyMap<string, number>>(() => new Map())
  const { onHeightChange, panel } = props
  const activeId = panel.activeId
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  /*
   * A strip that scrolls can hold the active tab off screen — and with no cap on
   * how many terminals a panel holds (Q1), `+` eventually selects a shell whose
   * label is past the right edge. Same three lines as `PaneTabStrip`, for the
   * same reason one level out.
   */
  useEffect(() => {
    const index = panel.tabs.findIndex((tab) => tab.id === activeId)
    if (index < 0) return
    tabRefs.current[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, panel.tabs])

  /*
   * Roving focus, copied from `PaneTabStrip` because the pattern is the same and
   * having two answers to it would be worse than the duplication. One tab in the
   * sequential order, arrows to move between them.
   */
  const focusAt = (index: number): void => {
    const count = panel.tabs.length
    if (count === 0) return
    tabRefs.current[(index + count) % count]?.focus()
  }
  const onTabKeyDown = (index: number, event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      focusAt(index + (event.key === 'ArrowLeft' ? -1 : 1))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusAt(event.key === 'Home' ? 0 : panel.tabs.length - 1)
    }
  }

  /*
   * The terminal a confirmation is about, captured whole.
   *
   * The **ref**, not an index and not "whichever is active": a tab can be killed
   * or the roster re-ordered while the dialog is open, and an index would then
   * point at a different shell. `describe()` is read once, when the `×` is
   * pressed, and not re-checked on confirm — a second call would narrow the race
   * without closing it, and would suggest in the code that it had been handled.
   * Making kill atomic would take a single main-process operation, and the wrong
   * answer here is "you killed an idle shell you had asked to kill".
   */
  const [confirming, setConfirming] = useState<{ id: string; process: string } | null>(null)

  const onReady = useCallback((focus: () => void) => {
    focusTerminal.current = focus
  }, [])

  /*
   * Kill, then forget. Never the other way round.
   *
   * Removing the row first and firing the IPC after leaves an orphan on any
   * failure: a shell still running, still holding its cwd and its children, with
   * nothing on screen able to reach it and no way to end it short of quitting
   * Chorus. Awaiting means a failed kill leaves the tab where it is, which is
   * recoverable and legible.
   */
  const killAndForget = useCallback(
    (id: string) => {
      void window.chorus
        .killTerminal({ ref: props.refFor(id) })
        .then(() => {
          props.onRemoveTerminal(id)
        })
        .catch(() => {
          /* The tab stays. A row pointing at a live shell beats a hidden one. */
        })
    },
    [props]
  )

  /*
   * Ask only when there is something to lose.
   *
   * `describe()` has been wired from `TerminalService` to `window.chorus` since
   * the original plan's Phase 1 and called by nothing — it was built to answer
   * exactly this and needed a kill button to have a caller. A shell that has
   * already exited, or one sitting at its prompt, dies on the click.
   */
  const requestKill = useCallback(
    (id: string) => {
      void window.chorus
        .describeTerminal({ ref: props.refFor(id) })
        .then((described) => {
          if (described !== null && described.running && described.busy) {
            setConfirming({ id, process: described.foreground })
            return
          }
          killAndForget(id)
        })
        .catch(() => {
          // Main could not say. Treat an unanswerable question as "ask", since
          // the alternative is killing something on the strength of an error.
          setConfirming({ id, process: t('terminal.tabs') })
        })
    },
    [props, killAndForget, t]
  )

  /*
   * Closed over the id that was rendered, not read at call time.
   *
   * `TerminalView` is keyed by that id, so the instance calling this and the id
   * captured here cannot disagree: a different tab is a different component with
   * a different closure. Reading `panel.activeId` inside would be the version
   * that can file an exit under whichever tab you happened to switch to.
   */
  const onExit = useCallback(
    (code: number) => {
      if (activeId === null) return
      setExited((prev) => new Map(prev).set(activeId, code))
    },
    [activeId]
  )

  /*
   * The height is written straight to a custom property while the pointer moves
   * and only committed on release.
   *
   * The same trade `useSidebarResize` makes, and for the same reason: going
   * through React on every frame would re-render the transcript above this at
   * pointer rate to move one edge. It is *not* a fix for C-026 — `.score` is
   * observed directly, so its ResizeObserver still runs every frame — but it
   * keeps the cost to that one callback instead of a full re-render on top.
   */
  const onGrab = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = shell.current
      if (element === null) return
      event.preventDefault()
      const startY = event.clientY
      const startHeight = element.getBoundingClientRect().height
      let latest = startHeight

      const move = (moved: PointerEvent): void => {
        latest = clampTerminalHeight(startHeight - (moved.clientY - startY))
        element.style.setProperty('--terminal-height', `${String(latest)}px`)
      }
      const release = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', release)
        document.removeEventListener('pointercancel', release)
        document.body.style.userSelect = ''
        onHeightChange(latest)
      }
      document.body.style.userSelect = 'none'
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', release)
      document.addEventListener('pointercancel', release)
    },
    [onHeightChange]
  )

  const nudge = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const next = clampTerminalHeight(panel.height + (event.key === 'ArrowUp' ? 24 : -24))
      onHeightChange(next)
    },
    [panel.height, onHeightChange]
  )

  return (
    <div
      className={`terminal-panel terminal-panel--${props.variant}`}
      /*
       * Which shell is on screen, in the DOM.
       *
       * The roster lives in the store, which nothing outside the renderer can
       * read — so a probe wanting to name the terminal it is looking at had to
       * guess an id, and several did: they hardcoded the constant Phase 1 minted
       * and went on passing until Phase 2 replaced it with a real one, at which
       * point `describe()` answered `null` for a shell that was plainly running.
       * One attribute is cheaper than a store handle and is how
       * `data-workspace-pane` already works.
       */
      data-terminal-id={activeId ?? undefined}
      ref={shell}
      style={{ '--terminal-height': `${String(panel.height)}px` } as React.CSSProperties}
    >
      <div
        className="terminal-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('terminal.resize')}
        tabIndex={0}
        onPointerDown={onGrab}
        onKeyDown={nudge}
      />
      <div className="terminal-head">
        <span className="terminal-title">{props.title}</span>
        {/*
          The strip, and only once there is a choice to make.

          One terminal needs no tabs — VS Code hides its list in the same case,
          and it keeps the single-terminal panel looking exactly as it did before
          the roster existed, which is what most panels are. `+` is always here,
          because that is how the second one gets made.
        */}
        {panel.tabs.length > 1 && (
          <div className="terminal-tabs" role="tablist" aria-label={t('terminal.tabs')}>
            {panel.tabs.map((tab, index) => {
              const name = t('terminal.tabLabel', { n: index + 1 })
              const code = exited.get(tab.id)
              const selected = tab.id === activeId
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabRefs.current[index] = element
                  }}
                  type="button"
                  role="tab"
                  className="terminal-tab"
                  data-terminal-id={tab.id}
                  id={`terminal-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`terminal-surface-${tab.id}`}
                  /* Roving: one tab in the sequential order, arrows for the rest. */
                  tabIndex={selected ? 0 : -1}
                  data-exited={code === undefined ? undefined : 'true'}
                  title={code === undefined ? name : `${name} — ${t('terminal.exited', { code })}`}
                  onKeyDown={(event) => {
                    onTabKeyDown(index, event)
                  }}
                  onClick={() => {
                    props.onActivateTerminal(tab.id)
                  }}
                >
                  {name}
                  {code !== undefined && (
                    <span className="terminal-tab-exit" aria-hidden="true">
                      ⏻
                    </span>
                  )}
                  {/*
                    The tab's own `×` kills; the header's hides. Two destructive-
                    looking marks in one 38px strip is exactly the confusion this
                    phase is about, so the accessible names say which is which and
                    nothing relies on the glyph alone.

                    A `<span role="button">` rather than a nested `<button>`,
                    which is invalid HTML inside the tab and behaves differently
                    across browsers. Enter and Space are wired by hand because a
                    span does not get them for free.
                  */}
                  <span
                    role="button"
                    tabIndex={-1}
                    className="terminal-tab-kill"
                    aria-label={`${t('terminal.kill')} — ${name}`}
                    title={t('terminal.kill')}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestKill(tab.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      requestKill(tab.id)
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {activeId !== null && exited.get(activeId) !== undefined && (
          <span className="terminal-exited">
            {t('terminal.exited', { code: exited.get(activeId) })}
          </span>
        )}
        <button
          type="button"
          className="terminal-action"
          aria-label={t('terminal.add')}
          title={`${t('terminal.add')} (${t('terminal.shortcutNew')})`}
          onClick={props.onAddTerminal}
        >
          <span aria-hidden="true">+</span>
        </button>
        {/*
          Kill the terminal you are looking at, always reachable.

          The per-tab `×` is a shortcut for the ones you are *not* looking at,
          and it only exists while a strip is drawn — which is not the common
          case. With a single terminal there is no strip, so without this there
          was no way to end a shell at all short of typing `exit`: the panel's
          only control was Hide, which is precisely the complaint this whole plan
          started from. Found by driving it, after the probe killed down to one
          terminal and then had nothing left to click.

          A distinct glyph, not another `×`. Two identical marks in one 38px
          header, one of which ends a process and one of which hides a panel, is
          the confusion this phase exists to avoid.
        */}
        {activeId !== null && (
          <button
            type="button"
            className="terminal-action terminal-action--kill"
            aria-label={t('terminal.kill')}
            title={t('terminal.kill')}
            onClick={() => {
              requestKill(activeId)
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M6.5 2h3M2.5 4.5h11M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
            </svg>
          </button>
        )}
        {/*
          The shortcut, next to the control it duplicates.
        
          A person who reaches for Hide is the person who has not learned the
          key yet, so this is where it is worth saying — and saying it once, in
          the panel, rather than in a settings sheet nobody opens.
        */}
        <kbd className="terminal-shortcut" title={t('terminal.toggleHint')}>
          {props.shortcut}
        </kbd>
        {/*
          A mark rather than the word "Hide".

          The header is 38px of chrome above a shell, and a text button in it
          reads as another thing to consider. The chord beside it already says
          how to do this from the keyboard; the accessible name still says the
          word.
        */}
        <button
          type="button"
          className="terminal-action"
          aria-label={t('terminal.hide')}
          onClick={() => {
            props.onFocusAway()
            props.onClose()
          }}
          title={t('terminal.hide')}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {/*
        `key` on the terminal's id, so switching shells is a remount.

        `TerminalView`'s effect also depends on the id, so this is belt and
        braces — but the braces are the cheap half: without a key, React reuses
        one component instance across two different shells, and every piece of
        state that is not in the dependency array (the xterm instance, the
        attachment, the queued pushes) would have to be right by accident.
      */}
      {confirming !== null && (
        <ConfirmKillTerminal
          process={confirming.process}
          onConfirm={() => {
            killAndForget(confirming.id)
            setConfirming(null)
          }}
          onCancel={() => {
            setConfirming(null)
          }}
        />
      )}
      <TerminalView
        key={activeId ?? 'none'}
        terminal={props.refFor(activeId ?? '')}
        label={props.title}
        /*
          The other half of the tablist relationship, and only while there is a
          list: with one terminal the surface is a plain group, which is what it
          was before the roster and what it should stay.
        */
        surface={
          panel.tabs.length > 1 && activeId !== null
            ? { id: `terminal-surface-${activeId}`, labelledBy: `terminal-tab-${activeId}` }
            : undefined
        }
        onExit={onExit}
        onReady={onReady}
      />
    </div>
  )
}
