import { useHostCapabilities } from '../host-context.js'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { compactTokens, resetMoment } from '../format.js'
import type { SessionInfo } from '../Session.js'
import {
  useActiveProjectId,
  useOpenProjectKey,
  useProjectRowState,
  useProjectWeight,
} from './hooks.js'
import { StateMark } from './SessionRow.js'
import { countRender } from './render-count.js'
import { projectTile, type SessionPlacement } from './session-row.js'
import {
  previewContextMenuProps,
  previewTriggerProps,
  type PreviewController,
} from './SessionPreview.js'
import { moveBefore, tileOffsets } from './reorder.js'
import { useShellOverlay } from './overlay.js'
import { useUsage, type UsageReading } from './useUsage.js'

/**
 * The 60px column that runs the day.
 *
 * This is the primary state, not the fallback one. The drawer is opened to find
 * a name and closed again; everything the daily loop needs stays here — show or
 * hide the drawer, start a session, reach any session in its own stable place,
 * open a terminal, read both accounts' windows, and open settings.
 *
 * It replaced the activity bar rather than sitting beside it. Two thin strips
 * competing for the same edge — one with icons, one an invisible hover target
 * that slid the sidebar back — was two concepts for one column.
 */

export interface QuickRailProps {
  readonly sessions: readonly SessionInfo[]
  readonly brand?: React.ReactNode
  readonly starting: boolean
  readonly preview: PreviewController
  readonly onNewSession: () => void
  readonly projects: readonly {
    readonly id: string
    readonly name: string
    readonly root: string
    readonly openConversations: number
  }[]
  readonly onProjectPointerDown: (
    projectId: string,
    name: string,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  readonly onAddProject: () => Promise<void>
  readonly onAddRemoteProject: () => void
  /** Switches to the project. Deliberately does not start a conversation. */
  readonly onOpenProject: (projectId: string) => void
  readonly onOpenSettings: () => void
  /**
   * Opens the list of every conversation the log holds, not only the open ones.
   *
   * Restored after the control-rail redesign (`debaae0`) dropped it. The panel
   * itself was never removed — `App.tsx` still rendered `HistoryPanel` — but
   * nothing set `showingHistory` to true any more, so an ended conversation
   * could be found by nothing in the UI at all. The log keeps it forever and
   * there was no door.
   */
  readonly onOpenHistory: () => void
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
  /** A card moved by keyboard, in the same terms the drop uses. */
  readonly onReorderSessions: (conversationId: string, slot: number) => void
  /** The card currently being dragged, so it can dim while it is in flight. */
  readonly draggingId: string | null
  /**
   * Where a dragged project would land if the pointer were released now.
   *
   * The tiles it displaces slide out of the way while the drag is live, so the
   * arrangement is visible before it is committed rather than after. Null when no
   * rail drag is over a gap, which is what puts them back.
   */
  readonly pendingMove: { readonly projectId: string; readonly beforeId: string | null } | null
  readonly consumeSuppressedClick: () => boolean
}

export function QuickRail(props: QuickRailProps): React.JSX.Element {
  const capabilities = useHostCapabilities()
  const { t } = useTranslation()
  countRender('QuickRail')
  /*
   * The rail marks the session whose *project* is on screen in the focused
   * pane. A pane shows one conversation of one project, so "active" for a tile
   * is: my project is the one being looked at, and I am the conversation it is
   * showing.
   */
  const activeProjectId = useActiveProjectId()
  const openKey = useOpenProjectKey()
  /*
   * One tab stop for the whole list.
   *
   * Twenty shortcuts as twenty tab stops would put the settings gear twenty-two
   * presses from the top of the window. Arrows move within the group, Tab
   * leaves it — the roving pattern every toolbar uses.
   */
  /*
   * Held as a project id, not as an index.
   *
   * Reordering moves the tiles under the roving pointer: an index would leave
   * `tabIndex=0` on whatever tile happened to land in that position, so tabbing
   * into the rail after a move would focus a different project than the one you
   * moved.
   */
  const [roving, setRoving] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  /**
   * How far each tile has to slide to show where the drag would put things.
   *
   * **Offsets, not a reordered list, and that is what makes it animate.**
   * Re-rendering the rail in the previewed order moves the DOM nodes, and a node
   * that moves because its siblings changed has no property to interpolate — it
   * teleports. Leaving the nodes alone and translating them gives the browser one
   * transform to transition, and the tiles visibly make room.
   *
   * In whole tiles rather than pixels: every tile in the rail is the same height
   * and the same gap apart, so the multiplication is one CSS length and nothing
   * is measured on a pointer move.
   *
   * Empty and cheap when nothing is being dragged, which is almost always.
   */
  const offsets = useMemo(() => {
    if (props.pendingMove === null) return new Map<string, number>()
    const ids = props.projects.map((project) => project.id)
    return tileOffsets(
      ids,
      moveBefore(ids, props.pendingMove.projectId, props.pendingMove.beforeId)
    )
  }, [props.projects, props.pendingMove])

  const open = useMemo(() => new Set(openKey.split('\n')), [openKey])

  /*
   * Which conversations belong to each project, built once for the whole rail.
   *
   * Each tile needs its project's conversation ids to fold their pulses into one
   * badge, and building that per tile would be one pass over every session per
   * project — quadratic in the thing most likely to grow.
   */
  const byProject = useMemo(() => {
    const grouped = new Map<string, string[]>()
    for (const session of props.sessions) {
      const list = grouped.get(session.projectId)
      if (list === undefined) grouped.set(session.projectId, [session.conversationId])
      else list.push(session.conversationId)
    }
    return grouped
  }, [props.sessions])

  const focusAt = (index: number): void => {
    const count = props.projects.length
    if (count === 0) return
    const next = (index + count) % count
    const id = props.projects[next]?.id
    if (id === undefined) return
    setRoving(id)
    scroller.current?.querySelector<HTMLElement>(`[data-rail-project="${id}"]`)?.focus()
  }

  /*
   * There is still no keyboard reorder here, and the reason has changed.
   *
   * It used to be that there was nowhere to write: the order was
   * `last_opened_at DESC`, computed by main, so a move would have been lost on
   * the next `project:list` unless somebody added "a `sort_order` column nobody
   * has asked for". That column now exists, and dragging writes to it — so the
   * obstacle is gone and only the absence of a request remains. Keyboard reorder
   * was not asked for, and a shortcut invented alongside a drag is a second way
   * to do one thing, decided by whoever implemented it.
   *
   * What it would need, when it is asked for: `project:reorder` takes the tile
   * and the neighbour it lands before, so a keyboard move is "before the one
   * above me" or "after the one below" — one call per press, no new IPC.
   */

  return (
    <nav className="quick-rail" aria-label={t('rail.label')}>
      {/*
        No `+` here any more, and its absence is the point.

        It meant "another conversation in the most recent project", which was
        the only thing a rail of projects could express — it could not say which
        project, let alone which group inside one. The button moved into the
        conversation strip, where pressing it names both by where it is.
      */}

      {/*
        Add Project, above the list rather than below it.

        It sat under the projects, on the reasoning that "a tile that is not a
        project should not scroll away with them" — which is right about the
        scrolling and wrong about the position. Below a scrolling list its
        distance from the top grows with every project added, so the one control
        that is always in the same place moves further down the more the rail is
        used. Above it, it is where the pointer already is on an empty rail and
        stays put on a full one.

        Still outside `quick-rail-sessions`, which is what keeps it from
        scrolling away — that half of the original reasoning is unchanged.
      */}
      <ul className="quick-rail-group">
        {props.brand !== undefined && <li className="quick-rail-brand">{props.brand}</li>}
        <li>
          <button
            type="button"
            className="rail-item"
            data-rail-add-project
            aria-label={t('rail.addProject')}
            title={t('rail.addProject')}
            onClick={() => {
              void props.onAddProject()
            }}
          >
            <FolderIcon />
          </button>
        </li>
        <li>
          <button
            type="button"
            className="rail-item"
            data-rail-add-remote-project
            aria-label={t('rail.addRemoteProject')}
            title={t('rail.addRemoteProject')}
            onClick={props.onAddRemoteProject}
          >
            <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 5h16v10H4zM9 19h6M12 15v4" />
            </svg>
          </button>
        </li>
      </ul>

      {/*
        Projects, and **only** projects.

        The rail used to list every conversation as its own tile, which put four
        tiles on screen for one directory and made the column a list of rooms
        rather than a list of places. A Project owns the development environment
        and a Conversation belongs to exactly one Project, so the rail shows the
        thing that owns something and the conversations live inside the project's
        own pane.

        It scrolls on its own, so twenty projects cannot push the terminal, the
        account windows or settings off the bottom of the column.
      */}
      <div className="quick-rail-sessions" data-rail-scroll ref={scroller}>
        <ul className="quick-rail-group" aria-label={t('rail.projects')}>
          {props.projects.map((project, index) => (
            <RailProject
              key={project.id}
              project={project}
              conversationIds={byProject.get(project.id) ?? NO_CONVERSATIONS}
              placement={
                project.id === activeProjectId
                  ? 'active'
                  : open.has(project.id)
                    ? 'open'
                    : 'offscreen'
              }
              tabIndex={(roving ?? props.projects[0]?.id) === project.id ? 0 : -1}
              dragging={props.draggingId === project.id}
              offset={offsets.get(project.id) ?? 0}
              preview={props.preview}
              onFocusIndex={() => {
                setRoving(project.id)
              }}
              onStep={(delta) => {
                focusAt(index + delta)
              }}
              onJump={(to) => {
                focusAt(to === 'first' ? 0 : props.projects.length - 1)
              }}
              onOpen={() => {
                if (props.consumeSuppressedClick()) return
                props.preview.dismiss()
                props.onOpenProject(project.id)
              }}
              onPointerDown={(event) => {
                /*
                 * The secondary button is what opens the card, and `pointerdown`
                 * arrives before `contextmenu` — so dismissing here would close
                 * the card in the same gesture that asked for it, every time.
                 * The dismissal this line exists for is a drag starting, and a
                 * drag is the primary button.
                 */
                if (event.button === 0) props.preview.dismiss()
                props.onProjectPointerDown(project.id, project.name, event)
              }}
            />
          ))}
        </ul>
      </div>

      {/*
        The order the approved composition puts them in: what the account has
        left, then the two controls.

        The terminal used to sit above the usage block, which put a control
        between the sessions and the readings — so the column read as
        "sessions, a button, some numbers, another button" rather than as
        sessions, then how much is left, then the two things you press.
      */}
      <ul className="quick-rail-group quick-rail-group--foot">
        <RailUsage />
        {capabilities.globalTerminal && (
          <li>
            <button
              type="button"
              className="rail-item"
              data-rail-terminal
              aria-pressed={props.terminalOpen}
              aria-label={props.terminalOpen ? t('terminal.closeGlobal') : t('terminal.openGlobal')}
              title={props.terminalOpen ? t('terminal.closeGlobal') : t('terminal.openGlobal')}
              onClick={props.onToggleTerminal}
            >
              <TerminalIcon />
            </button>
          </li>
        )}
        <li>
          <button
            type="button"
            className="rail-item"
            data-rail-history
            aria-label={t('history.open')}
            title={t('history.open')}
            onClick={props.onOpenHistory}
          >
            <HistoryIcon />
          </button>
        </li>
        <li>
          <button
            type="button"
            className="rail-item"
            data-rail-settings
            aria-label={t('settings.open')}
            title={t('settings.open')}
            onClick={props.onOpenSettings}
          >
            <GearIcon />
          </button>
        </li>
      </ul>
    </nav>
  )
}

/** Stable identity, so a project with no conversations does not re-fold every render. */
const NO_CONVERSATIONS: readonly string[] = []

function RailProject(props: {
  readonly project: { readonly id: string; readonly name: string; readonly root: string }
  /** Every conversation in this project, folded into the tile's one badge. */
  readonly conversationIds: readonly string[]
  readonly placement: SessionPlacement
  /** In flight: the tile dims while its ghost follows the pointer. */
  readonly dragging: boolean
  readonly tabIndex: number
  readonly preview: PreviewController
  readonly onFocusIndex: () => void
  readonly onStep: (delta: number) => void
  readonly onJump: (to: 'first' | 'last') => void
  readonly onOpen: () => void
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  /**
   * How many tile-heights this one has to slide to make room for a drag.
   *
   * Zero for all of them except while a project is being dragged over the rail,
   * and zero is written as no inline transform at all — a style set on every
   * tile on every pointer move is a style the browser re-resolves on every tile
   * on every pointer move.
   */
  readonly offset: number
}): React.JSX.Element {
  const { t } = useTranslation()
  countRender('RailProject')
  const row = useProjectRowState(props.conversationIds)
  const facts = projectTile(row)
  const weight = useProjectWeight(props.conversationIds)
  const triggers = previewTriggerProps(props.preview, props.project.id)

  /*
   * The card shows the name; this is the name and everything around it.
   *
   * What the card still cannot show at 70px — the rest of a name too long to
   * fit, what state its conversations are in, how many things are waiting,
   * whether it is the one on screen — is here, because at this width the
   * accessible name is not a caption for the visual, it is the visual's only
   * complete form.
   *
   * "Working" is announced separately from the state rather than folded into it,
   * because at project scope the two are not exclusive: one conversation blocked
   * on an approval while another is mid-turn is the ordinary case, and a reader
   * who only hears "approval" is told the project has stopped when it has not.
   */
  const name = [
    props.project.name,
    t(`state.${facts.state}`),
    /* The count is named by the state it belongs to: "2 to approve" is an
       instruction, "2 waiting" was a number and a shrug. */
    facts.count > 0
      ? facts.state === 'approval'
        ? t('workspace.approvals', { count: facts.count })
        : facts.state === 'question'
          ? t('workspace.questions', { count: facts.count })
          : t('workspace.unread', { count: facts.count })
      : null,
    facts.state !== 'working' && facts.working.length > 0 ? t('state.working') : null,
    props.placement === 'active' ? t('state.active') : null,
  ]
    .filter((part) => part !== null)
    .join(' — ')

  /*
   * The folder, not the path.
   *
   * A 58px line at 9px holds about thirteen characters, and the segments a path
   * shares with every other project would take all of them — `/Users/…/code/` is
   * the same on every card here. The last segment is the part that differs.
   *
   * Split on both separators because the root is whatever the platform stored,
   * and this card is drawn on Windows too.
   */
  const folder = props.project.root.split(/[/\\]/).filter(Boolean).at(-1) ?? props.project.root

  return (
    /*
     * The offset rides the `li`, not the button.
     *
     * The button carries the drag ghost's own transforms and its pressed state;
     * putting a second transform on it would mean the two compose, and whichever
     * is written last wins. The list item has no transform of its own and is
     * exactly the box the rail lays out.
     *
     * No inline style at all when it is not moving — see `offset`.
     */
    <li
      className="rail-slot"
      {...(props.offset === 0
        ? {}
        : { style: { transform: `translateY(calc(var(--rail-step) * ${String(props.offset)}))` } })}
    >
      <button
        type="button"
        className="rail-item rail-session rail-project"
        data-rail-project={props.project.id}
        /*
         * Still no `data-reorder-id`, and its absence is still load-bearing.
         *
         * That attribute means *conversation* reorder to `useTabDrag`, writing
         * through `onReorderSessions` — a list of conversation ids the app keeps.
         * Putting it back on a project tile would claim the drop for the wrong
         * handler, which is the bug it was removed for: a project dragged across
         * the rail was silently swallowed instead of reaching a pane.
         *
         * Project reorder reads `data-rail-project` below instead, and resolves
         * to a `rail-swap` against the tile under the pointer. Two attributes
         * because they are two operations — one names a gap in the renderer's own
         * list, the other names two projects for main to swap in SQLite.
         */
        data-dragging={props.dragging ? 'true' : undefined}
        data-state={facts.state}
        {...(facts.voice !== null ? { 'data-voice': facts.voice } : {})}
        data-placement={props.placement}
        tabIndex={props.tabIndex}
        aria-label={name}
        aria-current={props.placement === 'active' ? 'true' : undefined}
        /*
         * No `title`, for the reason the usage button has none.
         *
         * The OS tooltip and the preview card opened from the same element on
         * the same hover and overlapped on screen — the tooltip drawn on top of
         * the card, saying a subset of what the card says. The card names the
         * project and shows its folder; a second surface repeating two of those
         * fields, in a style nothing else in the app uses, is not a fallback but
         * a competitor. `aria-label` still carries the whole name.
         */
        onPointerDown={props.onPointerDown}
        onClick={props.onOpen}
        /*
         * **Right-click opens the card; hover no longer does.** A project tile
         * is dragged to reorder and clicked to open, so a card that appears on
         * dwell is in the way of both — and the pointer crosses the whole rail
         * on its way to anything under it. Focus still opens it, because a
         * keyboard user has no other way to reach it and no drag to protect.
         */
        {...previewContextMenuProps(props.preview, props.project.id)}
        onFocus={(event) => {
          props.onFocusIndex()
          /*
           * **Keyboard focus only, and a drag is why.**
           *
           * Pressing a tile to drag it focuses the button, so this opened the
           * card 200ms into every grab — the reorder gesture and the card that
           * describes the tile fighting over the same press. `onPointerDown`
           * dismisses first and focus simply re-opened it.
           *
           * `:focus-visible` is exactly the distinction needed: the browser
           * already decides whether focus arrived by keyboard or by pointer, and
           * a card that appears on Tab and stays out of the way of the mouse is
           * what the right-click trigger was for. Reading it off the element
           * rather than tracking the last input type ourselves means it agrees
           * with the focus ring the person can see.
           */
          if (event.currentTarget.matches(':focus-visible')) triggers.onFocus(event)
        }}
        onBlur={triggers.onBlur}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            props.onStep(1)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            props.onStep(-1)
          } else if (event.key === 'Home') {
            event.preventDefault()
            props.onJump('first')
          } else if (event.key === 'End') {
            event.preventDefault()
            props.onJump('last')
          }
        }}
      >
        <span className="rail-project-name" aria-hidden="true">
          {props.project.name}
        </span>
        <span className="rail-project-folder" aria-hidden="true">
          {folder}
        </span>
        <span className="rail-box" aria-hidden="true">
          <span className="rail-box-row">
            <MessageIcon />
            {row.unread > 0 && row.unread}
          </span>
          <span className="rail-box-row">
            <TokensIcon />
            {weight.tokens === 0 ? '—' : compactTokens(weight.tokens)}
          </span>
          <span className="rail-box-row">
            <ContextIcon />
            {weight.percent === null ? '—' : `${String(weight.percent)}%`}
          </span>
          <span className="rail-box-row">
            <CompactIcon />
            {weight.markPercent === null ? '—' : `${String(weight.markPercent)}%`}
          </span>
        </span>
        <span
          className="rail-project-meter"
          data-spent={weight.percent !== null && weight.percent >= 90 ? 'nearly' : undefined}
          aria-hidden="true"
        >
          <i style={{ width: `${String(weight.percent ?? 0)}%` }} />
        </span>
        <StateMark state={facts.state} voice={facts.voice} />
      </button>
    </li>
  )
}

/**
 * Four readings, not one worst case.
 *
 * Codex 5-hour, Codex weekly, Claude 5-hour, Claude weekly — each with the
 * provider's own window label and its percentage. A single worst-case figure
 * answers "am I about to be cut off" and nothing else: not which account, not
 * which window, not whether the wait is an hour or a week.
 *
 * One control rather than four, because these are read rather than pressed. The
 * full reset countdown is in the popover that hover or keyboard focus opens.
 *
 * **Always four, and always mounted.** It used to return `null` until something
 * had been pushed, so the rail's foot rearranged itself a few seconds after
 * launch and the readings arrived one at a time in whatever order the providers
 * answered. A slot with nothing in it shows an em dash and says "not reported
 * yet" in words; it never shows `0%`, which would claim an empty account.
 */
function RailUsage(): React.JSX.Element {
  const capabilities = useHostCapabilities()
  const { t } = useTranslation()
  const readings = useUsage()
  const [refreshing, setRefreshing] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<
    { top: number; left: number } | { top: number; right: number } | null
  >(null)
  /**
   * Whether the tip has been measured and moved to where it fits.
   *
   * It is drawn hidden for the one commit that takes. The position it opens at
   * is the anchor's own top, which is right whenever the card fits below it and
   * off the bottom of the window when it does not — and a card that appears
   * clipped and then jumps is worse than one that appears once, in place.
   */
  const [placed, setPlaced] = useState(false)

  /**
   * Slide it up by however much it overflows, and no further.
   *
   * The card opened at the anchor's top and grew downward, with nothing
   * checking the window. Two accounts of two windows each is about 400px of
   * card, so the last reading sat under the status bar and `runs out 16h 39m
   * early` — the line the panel exists to show — was the one cut off.
   *
   * **Clamped rather than flipped.** Flipping to open upward is the usual
   * answer and it is wrong for this anchor: the usage button is near the *top*
   * of the rail, so bottom-anchoring it would push the card a few hundred
   * pixels off the top of the window to save twenty at the bottom. Sliding it
   * up by the overflow keeps it where it is pointing and adapts to a taller
   * card — a third agent, longer reset text.
   *
   * A card taller than the window still clips at the bottom, deliberately: the
   * `Math.max` floor keeps its top on screen, because a panel you can see the
   * start of is readable and one scrolled off the top is not.
   *
   * The same arithmetic as `fitCard`'s last line, not a call to it —
   * `fitCard` centres horizontally on the anchor, which is right for a card
   * hanging off a text selection and wrong for a flyout beside a 60px rail.
   */
  useLayoutEffect(() => {
    if (detail === null) return
    const element = tip.current
    if (element === null) return
    const margin = 8
    const { height } = element.getBoundingClientRect()
    const top = Math.max(margin, Math.min(detail.top, window.innerHeight - height - margin))
    // Guarded, or this sets state on every commit and re-runs itself forever.
    if (top !== detail.top) setDetail({ ...detail, top })
    else setPlaced(true)
  }, [detail])

  /* The tip opens to the right of a 60px rail, which is to say directly over the
     workbench — and a native view is composited above the DOM, so it was drawn
     over the tip entirely. See `workspace/overlay.ts`. */
  useShellOverlay(detail !== null)

  /*
   * The pointer can leave this button without ever saying so, and while `detail`
   * is set this component is hiding **every editor in the window**.
   *
   * That is how the editor region went black about a minute after launch and
   * stayed black: `pointerleave` is not delivered when the window loses focus
   * with the pointer still over the button, and — the case that makes this rail
   * special — the thing most likely to be clicked next is the workbench, which is
   * a `WebContentsView` and not part of this document at all. Clicking into it
   * ends no pointer sequence here, so the tip stayed open, the overlay stayed
   * counted, and the views stayed hidden.
   *
   * `blur` on the window covers both of those. `pointercancel` on the button
   * below covers the gesture being taken away by the OS. Neither replaces main's
   * deadline — they close the path that was actually hit, and the deadline covers
   * the ones nobody has found yet.
   */
  useEffect(() => {
    if (detail === null) return undefined
    const dismiss = (): void => {
      setDetail(null)
    }
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('blur', dismiss)
    }
  }, [detail])

  /*
   * The same four readings, grouped for the two rotated account labels. Grouped
   * from the reading order rather than from a second list of agents, so the
   * column can only ever draw what `useUsage` decided.
   */
  const accounts = [...new Set(readings.map((reading) => reading.agentId))].map((agentId) => ({
    agentId,
    windows: readings.filter((reading) => reading.agentId === agentId),
  }))

  /*
   * One reading in words, for the hover title and for the screen-reader line.
   *
   * The two said the same sentence from two copies of the same expression, and
   * the pace clause has to reach both: the tick and the red are `aria-hidden`
   * decoration, so a reader that only ever hears "63%, in 1d 3h" is told the
   * figure and not the thing the figure now means.
   */
  const say = (reading: UsageReading): string => {
    if (reading.percent === null) {
      return t('activity.usageUnreported', { agent: reading.agentId, window: reading.label })
    }
    const said = t('activity.usage', {
      agent: reading.agentId,
      percent: reading.percent,
      window: reading.label,
      reset: reading.reset,
    })
    /*
     * Semicolon, not a space. The two clauses run together as "resets 14h 57m
     * runs out 14h 57m early", which a screen reader reads as one breathless
     * sentence with two durations in it; the readings themselves are joined with
     * a full stop, so this keeps the two levels apart.
     */
    return reading.dryMinutes !== null && reading.dryMinutes > 0
      ? `${said}; ${t('limits.runsOutEarly', { time: reading.dry })}`
      : said
  }

  /**
   * Escape, and a click anywhere that is not this panel or its button.
   *
   * Mounted only while it is open, so nothing listens on the document for a
   * panel that is almost never up. The anchor is excluded because its own click
   * is the toggle: without that test the document listener would close the panel
   * in the same gesture that opened it, and the button would look dead.
   *
   * `pointerdown` rather than `click`, so a drag that begins outside dismisses
   * on the way down instead of on release somewhere else entirely.
   */
  useEffect(() => {
    if (detail === null) return undefined
    const dismiss = (event: Event): void => {
      const target = event.target as Node | null
      if (
        target !== null &&
        (anchor.current?.contains(target) === true || tip.current?.contains(target) === true)
      )
        return
      setDetail(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDetail(null)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [detail])

  const toggle = (): void => {
    if (detail !== null) {
      setDetail(null)
      return
    }
    const box = anchor.current?.getBoundingClientRect()
    if (box === undefined) return
    // Measured at open, not tracked: the rail does not move while a pointer is
    // over it, and a listener that followed it would run on every scroll for a
    // panel that is almost never up.
    //
    // Unplaced until the effect above has measured the card against the window.
    // Reset here rather than on close, so reopening after a reading changed —
    // which changes the card's height — is measured again rather than trusting
    // the last open's answer.
    setPlaced(false)
    setDetail(
      capabilities.railOnRight
        ? { top: Math.round(box.top), right: Math.round(window.innerWidth - box.left + 8) }
        : { top: Math.round(box.top), left: Math.round(box.right + 8) }
    )
  }

  return (
    <li className="rail-usage-slot">
      <button
        type="button"
        className="rail-usage"
        data-rail-usage
        ref={anchor}
        data-refreshing={refreshing ? 'true' : undefined}
        /*
         * No `title`, and that is the fix rather than an omission.
         *
         * The native tooltip and the panel used to open on the same hover, from
         * the same element, saying different things — the OS one named the
         * action while the panel gave the readings, so what appeared under the
         * pointer depended on where it settled. Reported as the tooltip not
         * matching the panel. The panel is the one surface this control has, and
         * it now names its own action as a button rather than as a caption.
         */
        aria-haspopup="dialog"
        aria-expanded={detail !== null}
        /*
         * **Click, not hover.** It opened on `pointerenter` and closed on
         * `pointerleave`, which put a 400px panel over the workbench every time
         * the pointer crossed the rail on its way somewhere else, and made the
         * readings unreachable without holding the mouse still. Not
         * `disabled` while refreshing any more either: refreshing is the
         * panel's job now, and a button that cannot be pressed is a panel that
         * cannot be closed.
         */
        onClick={toggle}
      >
        {/*
          The whole visual is hidden from the accessible name and said in words
          below it. Left readable it contributed "codex 5h 42% 1w 18%" — four
          figures run together, with nothing saying which window each belongs to
          or that an em dash means "not reported".
        */}
        {accounts.map((account) => (
          <span
            key={account.agentId}
            className="rail-account"
            data-agent={account.agentId}
            aria-hidden="true"
          >
            {/*
              Whose account this is, the right way up.

              The windows belong to an account, not to the app, and with two
              agents installed there are two sets of them — unlabelled, the four
              figures read as one account's. It used to be set on its side to
              save width, which saved the width and cost the reading.
            */}
            <span className="rail-account-name">{account.agentId}</span>
            {account.windows.map((reading) => {
              /*
               * The bar is cut at the tick, not at the figure.
               *
               * `used` past `elapsed` is spending faster than the window refills,
               * and the stretch between them is drawn in the alarm colour because
               * its *length* is the answer: it is exactly how long the account
               * will be shut before the reset. Where no pace could be worked out
               * the fill is the whole figure and there is no tick, which is the
               * bar this rail has always drawn.
               */
              const used = reading.percent ?? 0
              const elapsed = reading.elapsedPercent
              const over = elapsed === null ? 0 : Math.max(used - elapsed, 0)
              const fill = elapsed === null ? used : Math.min(used, elapsed)
              return (
                <span
                  key={reading.kind}
                  className="rail-window"
                  data-agent={reading.agentId}
                  data-window={reading.kind}
                  data-reported={reading.reported}
                  data-spent={
                    reading.percent !== null && reading.percent >= 90 ? 'nearly' : undefined
                  }
                >
                  <span className="rail-window-row">
                    <span className="rail-window-label">
                      {/*
                    The provider's own duration, in the word it is usually
                    called by. `describeWindow` says `1w` for a seven-day window,
                    which is right in a popover of exact figures and reads as a
                    unit rather than a period on a rail — so the long slot says
                    "Week". Derived from the reported minutes either way; nothing
                    here invents a window the provider did not report.
                  */}
                      {reading.kind === 'long' && reading.label === '1w'
                        ? t('activity.week')
                        : reading.label}
                    </span>
                    <span
                      className="rail-window-percent"
                      /*
                       * The em dash explains itself on hover.
                       *
                       * This machine's Codex account reports no windows, so its two
                       * slots are dashes — and a dash with no explanation reads as a
                       * bug in Chorus rather than as silence from the provider. The
                       * screen-reader line below has said so all along; this is the
                       * same sentence for everyone else.
                       */
                      title={say(reading)}
                    >
                      {/*
                    An em dash, not `0%`. Zero says the account is empty; this
                    says nobody has answered yet, and they are different facts.
                  */}
                      {reading.percent === null ? '—' : `${String(reading.percent)}%`}
                    </span>
                  </span>
                  {/*
                  When the window turns over, under the figure it belongs to.

                  Nothing new is computed: `reading.reset` has existed all along
                  and was only reachable by hovering, which is a poor place for
                  the half of the reading that decides what you do next. "96%"
                  answers whether you can keep working; "in 3h" answers whether
                  to wait or to switch agent, and that was the question the rail
                  could not answer without a mouse.

                  Only when a moment was actually reported. `reset` is an em dash
                  otherwise, and a second dash under the first says nothing the
                  first has not — the percentage is already the em dash that
                  means "nobody answered".

                  Between the figure and its bar rather than after it: a line of
                  type under the bar would sit nearer the next window than to
                  this one, which is the drift `.rail-window`'s tight gap exists
                  to prevent. It is quiet enough to read as an annotation of the
                  figure rather than as a divider.
                */}
                  {reading.resetsAt !== null && (
                    <span className="rail-window-reset">
                      {t('activity.resetsIn', { time: reading.reset })}
                    </span>
                  )}
                  {/*
                  Each window's own bar, directly under the figure it belongs to.

                  There used to be one bar per account, drawing the short window
                  only, sitting under both rows — so the long window had a number
                  and no shape, and the bar that was there appeared to belong to
                  whichever row you read last. Two readings, two meters, each
                  touching its own figure.

                  Empty at 0% rather than absent when a window is unreported: a
                  missing track would make the two accounts different heights and
                  read as a layout fault rather than as silence from a provider.
                  The em dash above already says nobody answered.
                */}
                  <span className="rail-meter-wrap">
                    <span className="rail-meter">
                      <i style={{ width: `${String(fill)}%` }} />
                      {over > 0 && (
                        <i
                          className="rail-meter-over"
                          style={{
                            left: `${String(elapsed ?? 0)}%`,
                            width: `${String(over)}%`,
                          }}
                        />
                      )}
                    </span>
                    {/*
                    How much of the window has gone, as one mark on the same axis.

                    Outside the track rather than in it: the track clips its
                    overflow to keep the fill's ends rounded, and a mark the same
                    height as a 4px bar is a mark you have to look for. It stands
                    3px proud at either end with a halo of the rail's own surface,
                    which is what makes it legible over the fill and over the
                    empty track in both themes.
                  */}
                    {elapsed !== null && (
                      <span className="rail-meter-pace" style={{ left: `${String(elapsed)}%` }} />
                    )}
                  </span>
                </span>
              )
            })}
          </span>
        ))}
        {/*
          The readings, then what pressing this does.
          
          A button's name has to say its action, and this one read out four
          figures and stopped — so the only control in the rail that does
          anything announced itself as a status line. The `title` used to carry
          the action and has gone with the duplicate tooltip above.
        */}
        <span className="sr-only">{`${readings.map(say).join('. ')}. ${t('activity.refresh')}`}</span>
      </button>
      {/*
        The full reading, on hover or focus.

        The column has room for a number and not for what it means — which
        window, how long until it comes back. Portalled to the body because the
        shell clips its overflow, and a panel that renders inside the rail is a
        panel with 60px to live in.
      */}
      {detail !== null &&
        createPortal(
          <div
            ref={tip}
            className="usage-tip"
            style={{
              ...detail,
              /*
               * Hidden for the one commit it takes to measure, the same way the
               * composer's mention menu is. `visibility` rather than not
               * rendering, because the thing being measured has to be in the
               * document to have a height.
               */
              ...(placed ? {} : { visibility: 'hidden' as const }),
            }}
            /*
             * A dialog, not a tooltip. A tooltip is what appears while you point
             * at something and holds nothing you can press; this is opened by a
             * click, dismissed by Escape, and has a button in it. `role` is what
             * tells a screen reader which of those it is about to enter.
             */
            role="dialog"
            aria-label={t('activity.usageHeading')}
          >
            <ul className="limits">
              {accounts.map((account) => (
                <Fragment key={account.agentId}>
                  {/*
                    Whose windows these are, for the same reason the rail names
                    them: two agents installed means two sets of readings, and
                    unlabelled the four figures read as one account's. The rail
                    learned that and the panel it opens had not — a colour dot
                    is a distinction you can see and not one you can name.
                  */}
                  <li className={`limit-account voice--${account.agentId}`}>{account.agentId}</li>
                  {account.windows.map((reading) => (
                    <li
                      key={`${reading.agentId}:${reading.kind}`}
                      className={`limit voice--${reading.agentId}`}
                      data-agent={reading.agentId}
                      data-window={reading.kind}
                      data-reported={reading.reported}
                    >
                      {/*
                        Three lines per window, in the order they are read.

                        The bar shares its line with the label that names it and
                        the figure it draws — `5h ———— 56%` — and takes whatever
                        width those two leave. Under it, when it comes back; under
                        that, the moment itself.
                      */}
                      <span className="limit-head">
                        <span className="voice-dot" aria-hidden="true" />
                        <span className="limit-window">{reading.label}</span>
                        {reading.percent === null ? (
                          <span className="limit-unreported">{t('activity.notReported')}</span>
                        ) : (
                          <>
                            <span className="limit-meter rail-meter-wrap" aria-hidden="true">
                              {/*
                                The rail's own meter: the fill is the spend
                                keeping pace, the alarm segment is the spend past
                                the clock, and the tick is how much of the window
                                has gone.
                              */}
                              <span className="rail-meter">
                                <i
                                  style={{
                                    width: `${String(
                                      reading.elapsedPercent === null
                                        ? reading.percent
                                        : Math.min(reading.percent, reading.elapsedPercent)
                                    )}%`,
                                  }}
                                />
                                {reading.elapsedPercent !== null &&
                                  reading.percent > reading.elapsedPercent && (
                                    <i
                                      className="rail-meter-over"
                                      style={{
                                        left: `${String(reading.elapsedPercent)}%`,
                                        width: `${String(
                                          reading.percent - reading.elapsedPercent
                                        )}%`,
                                      }}
                                    />
                                  )}
                              </span>
                              {reading.elapsedPercent !== null && (
                                <span
                                  className="rail-meter-pace"
                                  style={{ left: `${String(reading.elapsedPercent)}%` }}
                                />
                              )}
                            </span>
                            <span className="limit-percent">{reading.percent}%</span>
                          </>
                        )}
                      </span>

                      {reading.percent !== null && (
                        <span
                          className="limit-reset"
                          data-resets-at={reading.resetsAt ?? undefined}
                        >
                          {t('limits.resets', { time: reading.full })}
                        </span>
                      )}
                      {reading.percent !== null && reading.resetsAt !== null && (
                        <span className="limit-when">
                          {t('limits.resetsOn', { when: resetMoment(reading.resetsAt) })}
                        </span>
                      )}
                      {reading.dryMinutes !== null && reading.dryMinutes > 0 && (
                        <span className="limit-pace">
                          {t('limits.runsOutEarly', { time: reading.dry })}
                        </span>
                      )}
                    </li>
                  ))}
                </Fragment>
              ))}
            </ul>
            {/*
              What pressing it does, under the readings it would refresh.
              
              This is where the `title` went. Muted and last, because it is the
              only line here that is not a number: the panel is opened to read
              the windows, and the action is what you learn on the way past.
            */}
            {/*
              The action, as a control rather than as a caption.

              It read `Re-check account usage` under the readings, describing
              what clicking the rail button did — which was true while the panel
              opened on hover and became a lie the moment click opened the panel
              instead. Same string, same place, now the thing it names.

              Disabled while it runs, which is where the busy state belongs: the
              rail button used to carry it and cannot any more, because that
              button is what closes this.
            */}
            <button
              type="button"
              className="usage-tip-action"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true)
                window.chorus
                  .refreshLimits()
                  .catch(() => undefined)
                  .finally(() => {
                    // Held briefly: the read usually returns faster than a frame,
                    // and a spinner nobody sees is a click that looks like it did
                    // nothing.
                    setTimeout(() => {
                      setRefreshing(false)
                    }, 450)
                  })
              }}
            >
              {t('activity.refresh')}
            </button>
          </div>,
          document.body
        )}
    </li>
  )
}

/*
 * Drawn rather than typed.
 *
 * A glyph from the text font is sized by that font's metrics and sits on its
 * baseline, so it lands off-centre next to a stroked icon and changes size with
 * the type scale rather than with the button.
 */
/**
 * The drawer control, as the direction it will move in.
 *
 * Two stacked rectangles said "sessions", which is what the drawer contains
 * rather than what the button does — and at the top of a column of session
 * tiles, a mark meaning "sessions" is the least distinguishing thing it could
 * be. A double chevron says which way the panel goes and turns round when it
 * has gone that way.
 */
function FolderIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function MessageIcon(): React.JSX.Element {
  return (
    <svg className="rail-box-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-6 4z" />
    </svg>
  )
}

function TokensIcon(): React.JSX.Element {
  return (
    <svg className="rail-box-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z" />
      <path d="M4 9.5v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5c-1.7 1.4-4.6 2.2-8 2.2S5.7 10.9 4 9.5z" />
    </svg>
  )
}

function ContextIcon(): React.JSX.Element {
  return (
    <svg className="rail-box-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a9 9 0 1 1-9 9h9z" />
    </svg>
  )
}

function CompactIcon(): React.JSX.Element {
  return (
    <svg className="rail-box-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 4h18l-9 7zM3 20h18l-9-7z" />
    </svg>
  )
}

function TerminalIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* A prompt: the chevron and the line you type on. */}
      <path d="M5 7l4 4-4 4M12 15h7" />
    </svg>
  )
}

/**
 * A clock turned back — the same glyph the drawer's button used before the
 * redesign, drawn rather than typeset so it sits with the rail's other icons.
 */
function HistoryIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4.8a7.2 7.2 0 1 1-6.8 9.6" />
      <path d="M4.8 8.85V5.1m0 3.75h3.75" />
      <path d="M12 8.4V12l2.7 1.65" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* Teeth, not rays: eight spokes radiating from a circle reads as a sun. */}
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
