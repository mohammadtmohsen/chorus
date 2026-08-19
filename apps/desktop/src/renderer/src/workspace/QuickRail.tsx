import { Fragment, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { resetMoment } from '../format.js'
import type { SessionInfo } from '../Session.js'
import {
  useActiveConversationId,
  useOpenConversationKey,
  useSessionRowState,
  useWorkspaceActions,
} from './hooks.js'
import { countRender } from './render-count.js'
import { projectRow, monogramsFor, stepSlot, type SessionPlacement } from './session-row.js'
import { previewTriggerProps, type PreviewController } from './SessionPreview.js'
import { StateMark } from './SessionRow.js'
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
  readonly starting: boolean
  readonly preview: PreviewController
  readonly onNewSession: () => void
  readonly onOpenSettings: () => void
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
  /** A card moved by keyboard, in the same terms the drop uses. */
  readonly onReorderSessions: (conversationId: string, slot: number) => void
  /** The card currently being dragged, so it can dim while it is in flight. */
  readonly draggingId: string | null
  readonly onSessionPointerDown: (
    conversationId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  readonly consumeSuppressedClick: () => boolean
}

export function QuickRail(props: QuickRailProps): React.JSX.Element {
  const { t } = useTranslation()
  countRender('QuickRail')
  const activeId = useActiveConversationId()
  const openKey = useOpenConversationKey()
  const { openSession } = useWorkspaceActions()
  /*
   * One tab stop for the whole list.
   *
   * Twenty shortcuts as twenty tab stops would put the settings gear twenty-two
   * presses from the top of the window. Arrows move within the group, Tab
   * leaves it — the roving pattern every toolbar uses.
   */
  /*
   * Held as a conversation id, not as an index.
   *
   * Reordering moves the cards under the roving pointer: an index would leave
   * `tabIndex=0` on whatever card happened to land in that position, so tabbing
   * into the rail after a move would focus a different session than the one you
   * moved.
   */
  const [roving, setRoving] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  const open = useMemo(() => new Set(openKey.split('\n')), [openKey])
  const monograms = useMemo(() => monogramsFor(props.sessions), [props.sessions])

  const focusAt = (index: number): void => {
    const count = props.sessions.length
    if (count === 0) return
    const next = (index + count) % count
    const id = props.sessions[next]?.conversationId
    if (id === undefined) return
    setRoving(id)
    scroller.current?.querySelector<HTMLElement>(`[data-rail-session="${id}"]`)?.focus()
  }

  /*
   * Moving a card without a pointer.
   *
   * `⌘⌥⇧↑/↓`, which is the convention the panes already use for `⌘⌥⇧←/→` moving
   * a tab within its strip — the same gesture, one axis round.
   */
  const moveBy = (conversationId: string, direction: 'up' | 'down'): void => {
    const order = props.sessions.map((session) => session.conversationId)
    const slot = stepSlot(order, conversationId, direction)
    if (slot === null) return
    props.onReorderSessions(conversationId, slot)
    setRoving(conversationId)
    requestAnimationFrame(() => {
      scroller.current
        ?.querySelector<HTMLElement>(`[data-rail-session="${conversationId}"]`)
        ?.focus()
    })
  }

  return (
    <nav className="quick-rail" aria-label={t('rail.label')}>
      <ul className="quick-rail-group">
        <li>
          <button
            type="button"
            className="rail-item"
            data-rail-new
            disabled={props.starting}
            aria-label={t('conversation.newSession')}
            title={t('conversation.newSession')}
            onClick={props.onNewSession}
          >
            <PlusIcon />
          </button>
        </li>
      </ul>

      {/*
        The middle scrolls on its own, so twenty sessions cannot push the
        terminal, the account windows or settings off the bottom of the column.
      */}
      <div className="quick-rail-sessions" data-rail-scroll ref={scroller}>
        <ul className="quick-rail-group" aria-label={t('workspace.sessions')}>
          {props.sessions.map((session, index) => (
            <RailShortcut
              key={session.conversationId}
              session={session}
              monogram={monograms.get(session.conversationId) ?? ''}
              placement={
                session.conversationId === activeId
                  ? 'active'
                  : open.has(session.conversationId)
                    ? 'open'
                    : 'offscreen'
              }
              tabIndex={
                (roving ?? props.sessions[0]?.conversationId) === session.conversationId ? 0 : -1
              }
              dragging={props.draggingId === session.conversationId}
              onMove={(direction) => {
                moveBy(session.conversationId, direction)
              }}
              preview={props.preview}
              onFocusIndex={() => {
                setRoving(session.conversationId)
              }}
              onStep={(delta) => {
                focusAt(index + delta)
              }}
              onJump={(to) => {
                focusAt(to === 'first' ? 0 : props.sessions.length - 1)
              }}
              onOpen={() => {
                if (props.consumeSuppressedClick()) return
                props.preview.dismiss()
                openSession(session.conversationId)
              }}
              onPointerDown={(event) => {
                props.preview.dismiss()
                props.onSessionPointerDown(session.conversationId, session.title, event)
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

function RailShortcut(props: {
  readonly session: SessionInfo
  readonly monogram: string
  readonly placement: SessionPlacement
  /** In flight: the tile dims while its ghost follows the pointer. */
  readonly dragging: boolean
  readonly onMove: (direction: 'up' | 'down') => void
  readonly tabIndex: number
  readonly preview: PreviewController
  readonly onFocusIndex: () => void
  readonly onStep: (delta: number) => void
  readonly onJump: (to: 'first' | 'last') => void
  readonly onOpen: () => void
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  countRender('RailShortcut')
  const row = useSessionRowState(props.session.conversationId)
  const facts = projectRow(props.session, row, props.placement, props.monogram)
  const triggers = previewTriggerProps(props.preview, props.session.conversationId)

  /*
   * The monogram is two letters; the name is the whole sentence.
   *
   * Everything the shortcut cannot show at 44px — which session this is, what
   * state it is in, how many things are waiting, whether it is the one on
   * screen — is here, because at this width the accessible name is not a
   * caption for the visual, it is the visual's only complete form.
   */
  const name = [
    props.session.title,
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
    props.placement === 'active' ? t('state.active') : null,
  ]
    .filter((part) => part !== null)
    .join(' — ')

  return (
    <li>
      <button
        type="button"
        className="rail-item rail-session"
        data-rail-session={props.session.conversationId}
        data-reorder-id={props.session.conversationId}
        data-dragging={props.dragging ? 'true' : undefined}
        data-state={facts.state}
        {...(facts.state === 'working' && facts.voice !== null
          ? { 'data-voice': facts.voice }
          : {})}
        data-placement={facts.placement}
        tabIndex={props.tabIndex}
        aria-label={name}
        aria-current={props.placement === 'active' ? 'true' : undefined}
        title={props.session.title}
        onPointerDown={props.onPointerDown}
        onClick={props.onOpen}
        onFocus={(event) => {
          props.onFocusIndex()
          triggers.onFocus(event)
        }}
        onBlur={triggers.onBlur}
        onPointerEnter={triggers.onPointerEnter}
        onPointerLeave={triggers.onPointerLeave}
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
        <span className="rail-session-monogram" aria-hidden="true">
          {props.monogram}
        </span>
        <StateMark state={facts.state} voice={facts.voice} />
        {facts.count > 0 && (
          <span className="rail-badge" data-state={facts.state} aria-hidden="true">
            {facts.count}
          </span>
        )}
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
  const { t } = useTranslation()
  const readings = useUsage()
  const [refreshing, setRefreshing] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const [detail, setDetail] = useState<{ top: number; left: number } | null>(null)

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

  const show = (): void => {
    const box = anchor.current?.getBoundingClientRect()
    if (box === undefined) return
    // Measured at open, not tracked: the rail does not move while a pointer is
    // over it, and a listener that followed it would run on every scroll for a
    // panel that is almost never up.
    setDetail({ top: Math.round(box.top), left: Math.round(box.right + 8) })
  }

  return (
    <li className="rail-usage-slot">
      <button
        type="button"
        className="rail-usage"
        data-rail-usage
        ref={anchor}
        data-refreshing={refreshing ? 'true' : undefined}
        disabled={refreshing}
        /*
         * No `title`, and that is the fix rather than an omission.
         *
         * The native tooltip and the popover below open on the same hover, from
         * the same element, saying different things — the OS one named the
         * action while the panel gave the readings, so the thing that appeared
         * under the pointer depended on where it settled. Reported as the
         * tooltip not matching the panel. The action is named inside the panel
         * now, which is the one surface this control has.
         */
        onPointerEnter={show}
        onPointerLeave={() => {
          setDetail(null)
        }}
        onFocus={show}
        onBlur={() => {
          setDetail(null)
        }}
        onClick={() => {
          setRefreshing(true)
          window.chorus
            .refreshLimits()
            .catch(() => undefined)
            .finally(() => {
              // Held briefly: the read usually returns faster than a frame, and
              // a spinner nobody sees is a click that looks like it did nothing.
              setTimeout(() => {
                setRefreshing(false)
              }, 450)
            })
        }}
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
          <div className="usage-tip" style={{ top: detail.top, left: detail.left }} role="tooltip">
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
            <p className="usage-tip-action">{t('activity.refresh')}</p>
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
function PlusIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
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

function GearIcon(): React.JSX.Element {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      {/* Teeth, not rays: eight spokes radiating from a circle reads as a sun. */}
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
