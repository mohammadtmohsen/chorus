import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceLayoutNode } from '../../../shared/workspace-layout.js'
import { ALL_AGENTS, shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { compactTokens, money } from '../format.js'
import { SIDEBAR_WIDTH } from '../../../shared/workspace-layout.js'
import { clampSidebarWidth, leafPaneIds, type SplitDirection } from './layout.js'
import {
  useActiveConversationId,
  usePane,
  useSessionPulse,
  useSidebarHidden,
  useSidebarWidth,
  useTabPaneId,
  useWorkspaceActions,
  useWorkspaceLayout,
} from './hooks.js'
import { useWorkspaceStore } from './store.js'
import { useTabDrag, type ActiveTabDrag } from './useTabDrag.js'

interface WorkspaceProps {
  readonly sessions: readonly SessionInfo[]
  readonly starting: boolean
  readonly onNewSession: () => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onRestart: (conversationId: string) => void
  readonly onEnd: (conversationId: string) => void
  /** The sidebar's own order, which is the `order` half of `conversation:layout`. */
  readonly onReorderSessions: (order: readonly string[]) => void
  /** So a session's `profileId` can be shown as the name the chip uses. */
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  /** Which agents exist on this machine; an absent one cannot be seated. */
  readonly installed: readonly AgentId[]
  readonly onToggleAgent: (
    conversationId: string,
    agentId: AgentId,
    present: boolean
  ) => Promise<void>
  /** Opens the picker and re-points the conversation at what comes back. */
  readonly onChooseFolder: (conversationId: string) => Promise<void>
  readonly onSetFolder: (conversationId: string, cwd: string) => Promise<void>
  /** Where an unset folder resolves to, so a card can name that state. */
  readonly home: string
  readonly onChooseProfile: (conversationId: string, profileId: string) => Promise<void>
  /** Opens a panel the pane owns, activating the session on the way. */
  readonly onOpenPanel: (conversationId: string, panel: 'review' | 'summary') => void
  /** Persists the arrangement immediately, for changes that end on pointer-up. */
  readonly onCommitLayout: () => void
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.JSX.Element
}

function directionFromKey(key: string): SplitDirection | null {
  if (key === 'ArrowLeft') return 'left'
  if (key === 'ArrowRight') return 'right'
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  return null
}

function directionalPane(paneId: string, direction: SplitDirection): string | null {
  const source = document.querySelector<HTMLElement>(`[data-workspace-pane="${paneId}"]`)
  if (source === null) return null
  const sourceRect = source.getBoundingClientRect()
  const sx = sourceRect.left + sourceRect.width / 2
  const sy = sourceRect.top + sourceRect.height / 2
  const candidates = [...document.querySelectorAll<HTMLElement>('[data-workspace-pane]')].flatMap(
    (pane): { id: string; primary: number; cross: number }[] => {
      const id = pane.dataset['workspacePane']
      if (id === undefined || id === paneId) return []
      const rect = pane.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const dx = x - sx
      const dy = y - sy
      const primary =
        direction === 'left'
          ? -dx
          : direction === 'right'
            ? dx
            : direction === 'up'
              ? -dy
              : dy
      if (primary <= 1) return []
      const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
      return [{ id, primary, cross }]
    }
  )
  candidates.sort((a, b) => a.primary + a.cross * 2 - (b.primary + b.cross * 2))
  return candidates[0]?.id ?? null
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { layout, focusedPaneId } = useWorkspaceLayout()
  const { moveTab, splitTab, closeTab, activateTab, focusPane, reorderTab } = useWorkspaceActions()
  const sessions = useMemo(
    () => new Map(props.sessions.map((session) => [session.conversationId, session])),
    [props.sessions]
  )
  const insert = useCallback(
    (conversationId: string, paneId: string, slot: number) => {
      moveTab(conversationId, paneId, slot)
    },
    [moveTab]
  )
  const split = useCallback(
    (conversationId: string, paneId: string, direction: SplitDirection) => {
      splitTab(conversationId, paneId, direction)
    },
    [splitTab]
  )
  const drag = useTabDrag({ onInsert: insert, onSplit: split })
  const chordUntil = useRef(0)

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const state = useWorkspaceStore.getState()
      const paneId = state.focusedPaneId
      const pane = paneId === null ? undefined : state.panes[paneId]
      const activeId = pane?.activeTabId ?? null

      if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        chordUntil.current = performance.now() + 1_500
        return
      }

      const direction = directionFromKey(event.key)
      if (direction !== null && performance.now() <= chordUntil.current) {
        event.preventDefault()
        chordUntil.current = 0
        if (paneId === null || activeId === null) return
        if (event.shiftKey) {
          const targetPaneId = directionalPane(paneId, direction)
          const target = targetPaneId === null ? undefined : state.panes[targetPaneId]
          if (targetPaneId !== null && target !== undefined) {
            state.moveTab(activeId, targetPaneId, target.tabs.length)
          }
        } else {
          state.splitTab(activeId, paneId, direction)
        }
        return
      }
      if (performance.now() > chordUntil.current) chordUntil.current = 0

      if (event.metaKey && event.altKey && direction !== null && paneId !== null) {
        event.preventDefault()
        if (event.shiftKey && (direction === 'left' || direction === 'right') && pane !== undefined) {
          const from = activeId === null ? -1 : pane.tabs.indexOf(activeId)
          if (from >= 0) state.reorderTab(paneId, from, from + (direction === 'left' ? -1 : 2))
          return
        }
        const target = directionalPane(paneId, direction)
        if (target !== null) state.focusPane(target)
        return
      }

      if (event.metaKey && !event.altKey && !event.shiftKey && event.key === '\\') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.splitTab(activeId, paneId, 'right')
        return
      }
      if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.closeTab(paneId, activeId)
        return
      }
      if (event.metaKey && event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        if (paneId === null || pane === undefined || pane.tabs.length === 0) return
        const from = Math.max(0, pane.tabs.indexOf(activeId ?? ''))
        const delta = event.key === '[' ? -1 : 1
        const next = (from + delta + pane.tabs.length) % pane.tabs.length
        const id = pane.tabs[next]
        if (id !== undefined) state.activateTab(paneId, id)
        return
      }
      if (event.metaKey && !event.altKey && !event.shiftKey && /^[1-4]$/.test(event.key)) {
        const target = leafPaneIds(state.layout)[Number(event.key) - 1]
        if (target !== undefined) {
          event.preventDefault()
          state.focusPane(target)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar
        sessions={props.sessions}
        starting={props.starting}
        onNewSession={props.onNewSession}
        onRename={props.onRename}
        onReorderSessions={props.onReorderSessions}
        onCommitLayout={props.onCommitLayout}
        profiles={props.profiles}
        installed={props.installed}
        onToggleAgent={props.onToggleAgent}
        onChooseFolder={props.onChooseFolder}
        onSetFolder={props.onSetFolder}
        home={props.home}
        onChooseProfile={props.onChooseProfile}
        onOpenPanel={props.onOpenPanel}
        onRestart={props.onRestart}
        onEnd={props.onEnd}
      />
      <main className="workspace-editor" aria-label="Workspace">
        {layout === null ? (
          <EmptyWorkspace />
        ) : (
          <LayoutView
            node={layout}
            path={[]}
            sessions={sessions}
            focusedPaneId={focusedPaneId}
            drag={drag.drag}
            onTabPointerDown={drag.onPointerDown}
            consumeSuppressedClick={drag.consumeSuppressedClick}
            onActivate={activateTab}
            onFocus={focusPane}
            onClose={closeTab}
            onReorder={reorderTab}
            onRename={props.onRename}
            onRestart={props.onRestart}
            onEnd={props.onEnd}
            renderSession={props.renderSession}
          />
        )}
      </main>
      <DragFeedback drag={drag.drag} />
    </div>
  )
}

function EmptyWorkspace(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="workspace-empty">
      <span>{t('workspace.empty')}</span>
      <small>{t('workspace.emptyHint')}</small>
    </div>
  )
}

function LayoutView(props: {
  node: WorkspaceLayoutNode
  path: readonly number[]
  sessions: ReadonlyMap<string, SessionInfo>
  focusedPaneId: string | null
  drag: ActiveTabDrag | null
  onTabPointerDown: (
    conversationId: string,
    title: string,
    paneId: string,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  consumeSuppressedClick: () => boolean
  onActivate: (paneId: string, conversationId: string) => void
  onFocus: (paneId: string) => void
  onClose: (paneId: string, conversationId: string) => void
  onReorder: (paneId: string, fromIndex: number, slotBefore: number) => void
  onRename: (conversationId: string, title: string) => void
  onRestart: (conversationId: string) => void
  onEnd: (conversationId: string) => void
  renderSession: (session: SessionInfo, focused: boolean, paneId: string) => React.JSX.Element
}): React.JSX.Element {
  if (props.node.kind === 'leaf') {
    return <EditorPane {...props} paneId={props.node.paneId} />
  }
  const branch = props.node
  return (
    <div className="split-branch" data-orientation={branch.orientation}>
      {branch.children.map((child, index) => (
        <div
          className="split-child"
          style={{ flexGrow: branch.sizes[index] }}
          key={child.kind === 'leaf' ? child.paneId : `branch-${[...props.path, index].join('-')}`}
        >
          <LayoutView {...props} node={child} path={[...props.path, index]} />
          {index < branch.children.length - 1 && (
            <Sash
              orientation={branch.orientation}
              path={props.path}
              index={index}
              sizes={branch.sizes}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function Sash(props: {
  orientation: 'row' | 'column'
  path: readonly number[]
  index: number
  sizes: readonly number[]
}): React.JSX.Element {
  const { setBranchSizes: setSizes, equalizeBranch: equalize } = useWorkspaceActions()
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const element = event.currentTarget
    const branch = element.closest<HTMLElement>('.split-branch')
    if (branch === null) return
    const rect = branch.getBoundingClientRect()
    const axis = props.orientation === 'row' ? rect.width : rect.height
    if (axis <= 0) return
    const start = props.orientation === 'row' ? event.clientX : event.clientY
    const before = props.sizes[props.index]
    const after = props.sizes[props.index + 1]
    if (before === undefined || after === undefined) return
    const pair = before + after
    const minimum = Math.min(240 / axis, pair / 2)
    const pointerId = event.pointerId
    try {
      element.setPointerCapture(pointerId)
    } catch {
      // Document listeners still own cleanup.
    }
    document.body.style.userSelect = 'none'
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return
      const at = props.orientation === 'row' ? move.clientX : move.clientY
      const nextBefore = Math.max(minimum, Math.min(pair - minimum, before + (at - start) / axis))
      const sizes = [...props.sizes]
      sizes[props.index] = nextBefore
      sizes[props.index + 1] = pair - nextBefore
      setSizes(props.path, sizes)
    }
    const stop = (end: PointerEvent): void => {
      if (end.pointerId !== pointerId) return
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      document.body.style.removeProperty('user-select')
      try {
        element.releasePointerCapture(pointerId)
      } catch {
        // It may have been released by a pointer cancellation.
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  }
  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta =
      props.orientation === 'row'
        ? event.key === 'ArrowLeft'
          ? -0.02
          : event.key === 'ArrowRight'
            ? 0.02
            : 0
        : event.key === 'ArrowUp'
          ? -0.02
          : event.key === 'ArrowDown'
            ? 0.02
            : 0
    if (delta === 0) return
    event.preventDefault()
    const before = props.sizes[props.index]
    const after = props.sizes[props.index + 1]
    if (before === undefined || after === undefined) return
    const pair = before + after
    const nextBefore = Math.max(0.08, Math.min(pair - 0.08, before + delta))
    const sizes = [...props.sizes]
    sizes[props.index] = nextBefore
    sizes[props.index + 1] = pair - nextBefore
    setSizes(props.path, sizes)
  }
  return (
    <div
      className="workspace-sash"
      data-orientation={props.orientation}
      role="separator"
      tabIndex={0}
      aria-orientation={props.orientation === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={startResize}
      onKeyDown={keyboardResize}
      onDoubleClick={() => {
        equalize(props.path)
      }}
    />
  )
}

function EditorPane(
  props: Omit<Parameters<typeof LayoutView>[0], 'node'> & { paneId: string }
): React.JSX.Element {
  const pane = usePane(props.paneId)
  if (pane === undefined) return <div />
  const active = pane.activeTabId === null ? undefined : props.sessions.get(pane.activeTabId)
  const focused = props.focusedPaneId === props.paneId
  return (
    <section
      className="workspace-pane"
      data-workspace-pane={props.paneId}
      data-focused={focused}
      onPointerDown={() => {
        props.onFocus(props.paneId)
      }}
    >
      <PaneTabStrip {...props} pane={pane} />
      <div
        className="workspace-pane-content"
        data-pane-content
        id={active === undefined ? undefined : `panel-${props.paneId}-${active.conversationId}`}
        role="tabpanel"
        aria-labelledby={
          active === undefined ? undefined : `tab-${props.paneId}-${active.conversationId}`
        }
      >
        {active !== undefined && props.renderSession(active, focused, props.paneId)}
      </div>
    </section>
  )
}

function PaneTabStrip(
  props: Omit<Parameters<typeof EditorPane>[0], 'paneId'> & {
    paneId: string
    pane: { tabs: string[]; activeTabId: string | null }
  }
): React.JSX.Element {
  const { t } = useTranslation()
  const { closePane } = useWorkspaceActions()
  const [renaming, setRenaming] = useState<string | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])


  /*
   * A strip that scrolls can hold the active tab off screen.
   *
   * Every way of changing tabs except clicking one is now able to select
   * something you cannot see — `⌘⇧[`/`]`, opening from the sidenav, a restart,
   * the pane falling back after a close. Without this the caret lands in a
   * transcript whose tab is somewhere off to the right.
   */
  useEffect(() => {
    const index = props.pane.tabs.indexOf(props.pane.activeTabId ?? '')
    if (index < 0) return
    tabRefs.current[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.pane.activeTabId, props.pane.tabs])

  const focusAt = (index: number): void => {
    const count = props.pane.tabs.length
    if (count === 0) return
    tabRefs.current[(index + count) % count]?.focus()
  }
  const onTabKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      focusAt(index + (event.key === 'ArrowLeft' ? -1 : 1))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusAt(event.key === 'Home' ? 0 : props.pane.tabs.length - 1)
    }
  }

  return (
    <div className="workspace-tab-strip" data-tab-strip role="tablist">
      <div className="workspace-tabs">
        {props.pane.tabs.flatMap((conversationId, index) => {
          const session = props.sessions.get(conversationId)
          if (session === undefined) return []
          const active = props.pane.activeTabId === conversationId
          return [
            <div
              className="workspace-tab"
              data-active={active}
              data-dragging={props.drag?.conversationId === conversationId}
              key={conversationId}
            >
              {renaming === conversationId ? (
                <input
                  className="workspace-tab-rename"
                  defaultValue={session.title}
                  autoFocus
                  aria-label={t('conversation.renameTitle')}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(null)
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      props.onRename(conversationId, event.currentTarget.value)
                      setRenaming(null)
                    }
                  }}
                  onBlur={() => {
                    setRenaming(null)
                  }}
                />
              ) : (
                <button
                  ref={(element) => {
                    tabRefs.current[index] = element
                  }}
                  type="button"
                  className="workspace-tab-main"
                  data-workspace-tab={conversationId}
                  id={`tab-${props.paneId}-${conversationId}`}
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-controls={`panel-${props.paneId}-${conversationId}`}
                  title={session.title}
                  onPointerDown={(event) => {
                    props.onTabPointerDown(
                      conversationId,
                      session.title,
                      props.paneId,
                      event
                    )
                  }}
                  onClick={() => {
                    if (props.consumeSuppressedClick()) return
                    props.onActivate(props.paneId, conversationId)
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) props.onClose(props.paneId, conversationId)
                  }}
                  onDoubleClick={() => {
                    setRenaming(conversationId)
                  }}
                  onKeyDown={(event) => { onTabKeyDown(index, event); }}
                >
                  <span className="workspace-tab-title">{session.title}</span>
                  <span className="workspace-tab-voices" aria-hidden="true">
                    {session.participants.map((agent) => (
                      <span className={`voice-dot voice--${agent}`} key={agent} />
                    ))}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={t('workspace.closeTab', { title: session.title })}
                title={t('workspace.closeTab', { title: session.title })}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onClose(props.paneId, conversationId)
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>,
          ]
        })}
      </div>
      <button
        type="button"
        className="workspace-pane-close"
        title={t('workspace.closePane')}
        aria-label={t('workspace.closePane')}
        onClick={() => {
          closePane(props.paneId)
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}

/** How far a row must move before it is a reorder rather than a click. */
const ROW_DRAG_PX = 5

/** The card floats this far off the window edge; `--step * 2` in the stylesheet. */
const SIDEBAR_GAP = 6

/**
 * The stored width, fitted to the window actually showing it.
 *
 * `clampSidebarWidth` bounds the value on its own terms; this bounds it against
 * the space there is. A 640px sidebar remembered from a maximised window and
 * reopened at 640px wide covered the editor completely — the card is fixed, so
 * it sits *on top* rather than pushing anything aside, and the workspace was
 * simply gone until you found the collapse button.
 *
 * Half the window, never below the minimum. Deliberately not written back to
 * the store: the width the user chose is theirs, and it should return intact
 * when the window is wide enough to hold it again. Only the display is fitted.
 */
function fitSidebar(width: number): number {
  const ceiling = Math.max(SIDEBAR_WIDTH.min, Math.round(window.innerWidth / 2))
  return Math.min(clampSidebarWidth(width), ceiling)
}

/**
 * Drag the card's right edge.
 *
 * The width is written straight to `--sidebar` on the document element while
 * the pointer moves, and only committed to the store on release. Going through
 * the store on every frame would re-render every mounted transcript sixty times
 * a second to move one edge — and the three rules that read the width are CSS,
 * so CSS is where the live value belongs. The store still owns the value that
 * gets persisted.
 */
function useSidebarResize(
  width: number,
  commit: (next: number) => void,
  persist: () => void
): (event: ReactPointerEvent<HTMLElement>) => void {
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.style.setProperty('--sidebar', `${String(fitSidebar(width))}px`)
    }
    apply()
    // Re-fitted as the window changes, so dragging the window narrow cannot
    // leave the sidebar covering everything.
    window.addEventListener('resize', apply)
    return () => {
      window.removeEventListener('resize', apply)
    }
  }, [width])

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const root = document.documentElement
      const element = event.currentTarget
      const pointerId = event.pointerId
      let latest = width
      try {
        element.setPointerCapture(pointerId)
      } catch {
        // Document listeners still own cleanup.
      }
      // Kills the 300ms width transitions for the duration, or the edge lags
      // the pointer by a third of a second the whole way.
      root.dataset['sidebarResizing'] = 'true'
      document.body.style.userSelect = 'none'

      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== pointerId) return
        // Fitted here too, so the edge cannot be dragged past half the window.
        latest = fitSidebar(move.clientX + SIDEBAR_GAP)
        root.style.setProperty('--sidebar', `${String(latest)}px`)
      }
      const stop = (end: PointerEvent): void => {
        if (end.pointerId !== pointerId) return
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', stop)
        document.removeEventListener('pointercancel', stop)
        root.removeAttribute('data-sidebar-resizing')
        document.body.style.removeProperty('user-select')
        try {
          element.releasePointerCapture(pointerId)
        } catch {
          // It may have been released by a pointer cancellation.
        }
        commit(latest)
        persist()
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', stop)
      document.addEventListener('pointercancel', stop)
    },
    [width, commit, persist]
  )
}

function WorkspaceSidebar(props: {
  sessions: readonly SessionInfo[]
  starting: boolean
  onNewSession: () => void
  onRename: (conversationId: string, title: string) => void
  onReorderSessions: (order: readonly string[]) => void
  onCommitLayout: () => void
  profiles: readonly { readonly id: string; readonly name: string; readonly summary: string }[]
  installed: readonly AgentId[]
  onToggleAgent: (conversationId: string, agentId: AgentId, present: boolean) => Promise<void>
  onChooseFolder: (conversationId: string) => Promise<void>
  onSetFolder: (conversationId: string, cwd: string) => Promise<void>
  home: string
  onChooseProfile: (conversationId: string, profileId: string) => Promise<void>
  onOpenPanel: (conversationId: string, panel: 'review' | 'summary') => void
  onRestart: (conversationId: string) => void
  onEnd: (conversationId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const hidden = useSidebarHidden()
  const width = useSidebarWidth()
  const { setSidebarHidden: setHidden, setSidebarWidth, openSession } = useWorkspaceActions()
  const activeId = useActiveConversationId()
  const beginResize = useSidebarResize(width, setSidebarWidth, props.onCommitLayout)
  const [previewing, setPreviewing] = useState(false)
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(queryDraft.trim().toLocaleLowerCase()); }, 200)
    return () => { clearTimeout(timer); }
  }, [queryDraft])

  useEffect(() => {
    if (activeId === null) return
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-sidebar-conversation="${activeId}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }, [activeId])

  /*
   * Flat, in the order the user put them in.
   *
   * Grouping by `cwd` was doing very little work: a session's title defaults to
   * its folder's name, so the group header usually repeated the only row under
   * it. A flat list is also what makes a manual order meaningful — inside
   * groups there was nowhere for a dragged row to go.
   */
  const visible = useMemo(
    () =>
      query === ''
        ? props.sessions
        : props.sessions.filter(
            (session) =>
              session.title.toLocaleLowerCase().includes(query) ||
              session.cwd.toLocaleLowerCase().includes(query)
          ),
    [props.sessions, query]
  )

  const reorder = useRowReorder(visible, props.onReorderSessions, query === '')

  const beginPreview = (): void => {
    if (!hidden) return
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    setPreviewing(true)
  }
  const endPreview = (): void => {
    if (!hidden) return
    closeTimer.current = setTimeout(() => { setPreviewing(false); }, 150)
  }

  return (
    <>
      <div className="workspace-sidebar-spacer" data-hidden={hidden} aria-hidden="true" />
      <aside
        className="workspace-sidebar"
        data-hidden={hidden}
        data-previewing={previewing}
        aria-hidden={hidden && !previewing}
        inert={hidden && !previewing}
        onPointerEnter={beginPreview}
        onPointerLeave={endPreview}
      >
        <header className="workspace-sidebar-head">
          <strong>{t('workspace.sessions')}</strong>
          <span className="workspace-sidebar-actions">
            <button
              type="button"
              className="workspace-icon-button"
              disabled={props.starting}
              title={t('conversation.newSession')}
              aria-label={t('conversation.newSession')}
              onClick={props.onNewSession}
            >
              <span aria-hidden="true">＋</span>
            </button>
            <button
              type="button"
              className="workspace-icon-button"
              title={t('workspace.hideSidebar')}
              aria-label={t('workspace.hideSidebar')}
              onClick={() => {
                setPreviewing(false)
                setHidden(true)
              }}
            >
              <span aria-hidden="true">‹</span>
            </button>
          </span>
        </header>
        <label className="workspace-search">
          <span className="sr-only">{t('workspace.search')}</span>
          <input
            type="search"
            value={queryDraft}
            placeholder={t('workspace.search')}
            onChange={(event) => { setQueryDraft(event.target.value); }}
          />
        </label>
        <div className="workspace-tree">
          {visible.map((session, index) => (
            <SidebarSession
              session={session}
              active={session.conversationId === activeId}
              renaming={renaming === session.conversationId}
              dragging={reorder.draggingId === session.conversationId}
              drop={reorder.dropEdge(index, visible.length)}
              key={session.conversationId}
              profileName={
                props.profiles.find((p) => p.id === session.profileId)?.name ?? session.profileId
              }
              installed={props.installed}
              onToggleAgent={(agentId, present) =>
                props.onToggleAgent(session.conversationId, agentId, present)
              }
              onChooseFolder={() => props.onChooseFolder(session.conversationId)}
              onSetFolder={(cwd) => props.onSetFolder(session.conversationId, cwd)}
              home={props.home}
              profiles={props.profiles}
              onChooseProfile={(profileId) =>
                props.onChooseProfile(session.conversationId, profileId)
              }
              onOpenPanel={(panel) => { props.onOpenPanel(session.conversationId, panel); }}
              onRestart={() => { props.onRestart(session.conversationId); }}
              onEnd={() => { props.onEnd(session.conversationId); }}
              onPointerDown={(event) => { reorder.onPointerDown(session.conversationId, event); }}
              onOpen={() => {
                if (reorder.consumeSuppressedClick()) return
                openSession(session.conversationId)
                if (hidden) setHidden(false)
              }}
              onRenameStart={() => { setRenaming(session.conversationId); }}
              onRenameEnd={(title) => {
                if (title !== null) props.onRename(session.conversationId, title)
                setRenaming(null)
              }}
            />
          ))}
        </div>
      </aside>
      {!hidden && (
        <div
          className="workspace-sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workspace.resizeSidebar')}
          title={t('workspace.resizeSidebar')}
          tabIndex={0}
          onPointerDown={beginResize}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_WIDTH.default)
            props.onCommitLayout()
          }}
          onKeyDown={(event) => {
            const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
            if (delta === 0) return
            event.preventDefault()
            setSidebarWidth(width + delta)
            props.onCommitLayout()
          }}
        />
      )}
      {hidden && (
        <button
          type="button"
          className="workspace-sidebar-edge"
          aria-label={t('workspace.showSidebar')}
          title={t('workspace.showSidebar')}
          onPointerEnter={beginPreview}
          onFocus={beginPreview}
          onClick={() => {
            setPreviewing(false)
            setHidden(false)
          }}
        />
      )}
      {hidden && previewing && <div className="workspace-sidebar-scrim" aria-hidden="true" />}
    </>
  )
}

function SidebarSession(props: {
  session: SessionInfo
  active: boolean
  renaming: boolean
  dragging: boolean
  drop: 'before' | 'after' | undefined
  profileName: string
  installed: readonly AgentId[]
  onToggleAgent: (agentId: AgentId, present: boolean) => Promise<void>
  onChooseFolder: () => Promise<void>
  onSetFolder: (cwd: string) => Promise<void>
  home: string
  profiles: readonly { readonly id: string; readonly name: string; readonly summary: string }[]
  onChooseProfile: (profileId: string) => Promise<void>
  onOpenPanel: (panel: 'review' | 'summary') => void
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onOpen: () => void
  onRenameStart: () => void
  onRenameEnd: (title: string | null) => void
  onRestart: () => void
  onEnd: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const paneId = useTabPaneId(props.session.conversationId)
  const pulse = useSessionPulse(props.session.conversationId)
  const waiting = (pulse?.approvalIds.length ?? 0) + (pulse?.questionIds.length ?? 0)
  const working = (pulse?.working.length ?? 0) > 0
  const tokens = pulse?.tokens ?? 0
  const state = props.active ? 'active' : paneId === null ? 'offscreen' : 'open'
  /* Reset whenever the session stops working, so a warning cannot lie in wait. */
  const [armedEnd, setArmedEnd] = useState(false)
  /** Which agent is mid-flight, so the pair disables rather than double-fires. */
  const [moving, setMoving] = useState<string | null>(null)
  /** Where the menu sits, and whether that has been checked against the window. */
  /** Non-null while the folder is being typed; holds the draft, not the truth. */
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [picking, setPicking] = useState<{
    x: number
    y: number
    chipTop: number
    placed: boolean
  } | null>(null)
  const picker = useRef<HTMLDivElement | null>(null)
  const menu = useRef<HTMLUListElement | null>(null)

  /*
   * Closes on anything that is not this menu.
   *
   * By asking whether the click landed inside *this* picker rather than by
   * stopping the event at the picker's edge: stopping it meant another card's
   * chip never reached this listener, so opening a second menu left the first
   * one hanging open behind it.
   */
  useEffect(() => {
    if (picking === null) return
    const close = (event: Event): void => {
      const target = event.target as Node
      // The menu is portalled, so it is not inside the picker any more — both
      // have to be asked, or pressing an option closes the menu on pointerdown
      // and the click lands on whatever the list scrolled under it.
      if (picker.current?.contains(target) === true) return
      if (menu.current?.contains(target) === true) return
      setPicking(null)
    }
    const key = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setPicking(null)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
    }
  }, [picking])

  /*
   * Flips it above the chip, or pulls it back from the edge, once it is real.
   *
   * Measured rather than predicted: the menu's height is three summaries of
   * whatever length the profiles happen to have, and a card near the foot of a
   * long list would otherwise open a menu into the space below the window.
   * Runs once per opening — `placed` is what stops it chasing itself.
   */
  useLayoutEffect(() => {
    if (picking === null || picking.placed || menu.current === null) return
    const box = menu.current.getBoundingClientRect()
    const margin = 8
    const belowOverflows = box.bottom > window.innerHeight - margin
    setPicking({
      ...picking,
      placed: true,
      y: belowOverflows ? Math.max(margin, picking.chipTop - box.height - 4) : picking.y,
      x: Math.min(picking.x, Math.max(margin, window.innerWidth - box.width - margin)),
    })
  }, [picking])
  useEffect(() => {
    if (!working) setArmedEnd(false)
  }, [working])

  /*
   * Renaming replaces the row rather than nesting a field inside it: the row is
   * a button, and a text input inside a button is both invalid and unusable —
   * the button swallows the clicks that would place a caret. The tab strip
   * solves it the same way.
   */
  if (props.renaming) {
    return (
      <input
        className="workspace-session-rename"
        defaultValue={props.session.title}
        autoFocus
        aria-label={t('conversation.renameTitle')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onRenameEnd(null)
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            props.onRenameEnd(event.currentTarget.value)
          }
        }}
        onBlur={(event) => { props.onRenameEnd(event.currentTarget.value); }}
      />
    )
  }

  return (
    <div
      className="workspace-session-row"
      data-state={state}
      data-dragging={props.dragging}
      data-drop={props.drop}
      data-sidebar-conversation={props.session.conversationId}
    >
      {/*
        A wrapper rather than one button, because Restart and End live here now
        and a button cannot contain buttons. Same shape as a tab: one control
        that opens the thing, and its own controls beside it.
      */}
      <button
        type="button"
        className="workspace-session-main"
        title={props.session.cwd}
        onPointerDown={props.onPointerDown}
        onClick={props.onOpen}
        onDoubleClick={props.onRenameStart}
      >
        <span className="workspace-session-line">
          <span className="workspace-session-title">{props.session.title}</span>
          {waiting > 0 ? (
            <span className="workspace-session-status" data-waiting="true">
              {t('workspace.waiting', { count: waiting })}
            </span>
          ) : working ? (
            /*
             * Coloured by whoever is working, using the voice vocabulary the
             * dots and the rail already use — so "something is happening" and
             * "who is doing it" arrive together rather than as two lookups.
             * Two at once falls back to bone: no single voice owns it.
             */
            <span
              className={`workspace-session-status${
                pulse?.working.length === 1 ? ` voice--${String(pulse.working[0])}` : ''
              }`}
              data-working="true"
            >
              <span className="workspace-session-pip" aria-hidden="true" />
              {t('workspace.working')}
            </span>
          ) : (pulse?.unread ?? 0) > 0 ? (
            <span
              className="workspace-session-badge"
              aria-label={t('workspace.unread', { count: pulse?.unread })}
            >
              {pulse?.unread}
            </span>
          ) : null}
        </span>
        {/*
          What the composer's own footer says about a session, for the sessions
          you are not looking at: who is in it, where it is pointed, and what it
          may do there.

          Named rather than the bare dots this line replaced. A colour answers
          "how many and which" only once you already know the mapping, and the
          sidenav is where you look at sessions you have not opened — the one
          place that knowledge cannot be assumed. The composer keeps the cast as
          switches; these say who is here, they do not change it.
        */}
      </button>
      {/*
        Everything that acts, under everything that identifies.

        That split is the point of the card. The top half is a single target
        that opens the session — all of it, not only the words — and the bottom
        half is controls, none of which should open anything. Two halves means a
        pointer never has to guess which it is over, and the body can be dense
        without the name becoming so.
      */}
      <div className="workspace-session-body">
        <ul className="workspace-session-agents">
          {ALL_AGENTS.map((agent) => {
            const here = props.session.participants.includes(agent)
            const available = props.installed.includes(agent)
            return (
              <li key={agent}>
                <button
                  type="button"
                  className={`voice voice--${agent}`}
                  data-on={here}
                  data-live={pulse?.working.includes(agent) === true}
                  aria-pressed={here}
                  disabled={moving !== null || (!here && !available)}
                  title={
                    available
                      ? t(here ? 'conversation.removeAgent' : 'conversation.addAgent', {
                          agent,
                        })
                      : t('agents.notFound', { agent })
                  }
                  onClick={() => {
                    setMoving(agent)
                    void props.onToggleAgent(agent, here).finally(() => {
                      setMoving(null)
                    })
                  }}
                >
                  <span className="voice-dot" aria-hidden="true" />
                  {agent}
                </button>
              </li>
              )
            })}
          </ul>
        {/*
          The folder: click to pick one, double-click to type one.

          Both, because they answer different needs — a dialog to go looking, a
          field when the path is already known. Clearing the field is how a
          session goes back to no folder at all, which the runtime has always
          allowed and the UI had no way to say.
        */}
        {editingPath === null ? (
          <span className="workspace-session-folder">
            <button
              type="button"
              className="path path--button workspace-session-path"
              data-empty={props.session.cwd === props.home}
              title={t('conversation.choosePath')}
              onClick={() => { void props.onChooseFolder(); }}
              onDoubleClick={() => {
                setEditingPath(props.session.cwd === props.home ? '' : props.session.cwd)
              }}
            >
              {props.session.cwd === props.home
                ? t('conversation.noFolder')
                : shortenPath(props.session.cwd)}
            </button>
            {/*
              Only when there is one to drop, and beside the path rather than in
              the actions column — proximity is what keeps it from reading as
              the End button, which is the other ✕ on this card and ends the
              session rather than a setting.

              It exists because clearing the field was the only way back to no
              folder, and "double-click, select all, delete, Enter" is a gesture
              nobody finds.
            */}
            {props.session.cwd !== props.home && (
              <button
                type="button"
                className="workspace-session-folder-clear"
                aria-label={t('conversation.clearFolder')}
                title={t('conversation.clearFolder')}
                onClick={() => { void props.onSetFolder(''); }}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </span>
        ) : (
          <input
            className="path path--input workspace-session-path"
            value={editingPath}
            autoFocus
            aria-label={t('conversation.choosePath')}
            placeholder={t('conversation.noFolder')}
            onChange={(event) => { setEditingPath(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditingPath(null)
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                void props.onSetFolder(editingPath)
                setEditingPath(null)
              }
            }}
            /* Leaving is not agreeing: a half-typed path is what a stray click
               produces, which is the rule the composer's field used too. */
            onBlur={() => { setEditingPath(null); }}
          />
        )}
        {/*
          The profile, as the picker it is in the composer — same classes, same
          menu, so what a session may do is changed the same way from the list
          as from the room.
        */}
        <div className="profile-picker workspace-session-profile" ref={picker}>
          <button
            type="button"
            className="profile-chip"
            aria-haspopup="listbox"
            aria-expanded={picking !== null}
            onClick={(event) => {
              const at = event.currentTarget.getBoundingClientRect()
              setPicking(
                picking === null
                  ? { x: at.left, y: at.bottom + 4, chipTop: at.top, placed: false }
                  : null
              )
            }}
          >
            {props.profileName}
          </button>
          {picking !== null &&
            /*
             * Portalled to the body, and placed from the chip's own box.
             *
             * `position: fixed` is not enough here: the sidebar carries a
             * `transform` for its slide, and a transformed ancestor becomes the
             * containing block for fixed descendants — so the menu was being
             * positioned against the sidebar and clipped by its `overflow`.
             * Only leaving the subtree escapes both that and the list's own
             * scroll clipping.
             */
            createPortal(
              <ul
              ref={menu}
              className="profile-menu workspace-session-profile-menu"
              role="listbox"
              /* Hidden for the frame it takes to measure, or it is seen in the
                 wrong place first. */
              style={{ left: picking.x, top: picking.y, visibility: picking.placed ? 'visible' : 'hidden' }}
            >
              {props.profiles.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.id === props.session.profileId}
                    data-on={option.id === props.session.profileId}
                    className="profile-option"
                    onClick={() => {
                      setPicking(null)
                      if (option.id === props.session.profileId) return
                      void props.onChooseProfile(option.id)
                    }}
                  >
                    <span className="profile-option-name">{option.name}</span>
                    <span className="profile-option-summary">{option.summary}</span>
                  </button>
                </li>
              ))}
              </ul>,
              document.body
            )}
        </div>
        {/*
          What it has produced, and the two ways to read it.

          The spend comes from the pulse rather than the transcript: the
          transcript belongs to a mounted pane and half these cards do not have
          one. The panels do live in the pane, so these buttons activate the
          session on the way — wanting a session's diff is a reason to be in it.
        */}
        <span className="workspace-session-output">
          <button
            type="button"
            className="workspace-session-output-button"
            title={t('summary.open')}
            onClick={() => { props.onOpenPanel('summary'); }}
          >
            {t('summary.open')}
          </button>
          <button
            type="button"
            className="workspace-session-output-button"
            title={t('review.open')}
            onClick={() => { props.onOpenPanel('review'); }}
          >
            {t('review.openShort')}
          </button>
          {tokens > 0 && (
            <span className="workspace-session-spend">
              {compactTokens(tokens)}
              {pulse?.costUsd != null && (
                <span className="spend-cost">{` · ${money(pulse.costUsd)}`}</span>
              )}
            </span>
          )}
        </span>
        <span className="workspace-session-actions">
          <button
            type="button"
            className="workspace-session-action"
            aria-label={t('conversation.restartLabel')}
            title={t('conversation.restartLabel')}
            onClick={props.onRestart}
          >
            <span aria-hidden="true">↻</span>
          </button>
          <button
            type="button"
            className="workspace-session-action workspace-session-action--end"
            data-armed={armedEnd}
            aria-label={armedEnd ? t('conversation.endConfirm') : t('conversation.endLabel')}
            title={armedEnd ? t('conversation.endConfirm') : t('conversation.endLabel')}
            onClick={() => {
              // Asks twice only while an agent is working — the one moment
              // there is anything to lose.
              if (working && !armedEnd) {
                setArmedEnd(true)
                return
              }
              props.onEnd()
            }}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </span>
      </div>
    </div>
  )
}

interface RowReorder {
  readonly draggingId: string | null
  readonly onPointerDown: (conversationId: string, event: ReactPointerEvent<HTMLElement>) => void
  readonly dropEdge: (index: number, count: number) => 'before' | 'after' | undefined
  readonly consumeSuppressedClick: () => boolean
}

/**
 * Drag a row to reorder the list.
 *
 * Pointer events rather than HTML5 drag, for the same reasons the tab strip
 * uses them: the row rects are snapshotted once at drag start, so a list that
 * is animating underneath cannot feed the hit test the position a row is
 * moving *from*.
 *
 * Refused while a search is running. The visible rows are a subset then, so a
 * gap index between two of them does not describe a position in the real list,
 * and committing one would shuffle rows the user cannot see.
 */
function useRowReorder(
  visible: readonly SessionInfo[],
  onReorder: (order: readonly string[]) => void,
  enabled: boolean
): RowReorder {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const active = useRef<{
    conversationId: string
    pointerId: number
    startY: number
    dragging: boolean
    edges: number[]
    /*
     * The committed slot lives here rather than in `slot` below, which exists
     * only to draw the line. Reading the state at drop time made the commit
     * depend on React having rendered between the last `pointermove` and the
     * `pointerup` — true whenever a human is dragging, false for a flick fast
     * enough to land both in one frame, which then reordered nothing.
     */
    slot: number | null
  } | null>(null)
  const suppressClick = useRef(false)

  const finish = useCallback(
    (commit: boolean) => {
      const current = active.current
      active.current = null
      document.body.style.removeProperty('user-select')
      setDraggingId(null)
      setSlot(null)
      if (current?.dragging !== true) return
      suppressClick.current = true
      if (!commit) return
      const from = visible.findIndex((s) => s.conversationId === current.conversationId)
      const target = current.slot
      if (from < 0 || target === null) return
      // A gap index, so dropping after your own position has to discount the
      // hole you left behind — the same rule the tab strip reorders by.
      const to = from < target ? target - 1 : target
      if (to === from) return
      const ids = visible.map((s) => s.conversationId)
      const [moved] = ids.splice(from, 1)
      if (moved === undefined) return
      ids.splice(to, 0, moved)
      onReorder(ids)
    },
    [visible, onReorder]
  )

  useEffect(() => {
    return () => {
      document.body.style.removeProperty('user-select')
    }
  }, [])

  const onPointerDown = useCallback(
    (conversationId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return
      active.current = {
        conversationId,
        pointerId: event.pointerId,
        startY: event.clientY,
        dragging: false,
        edges: [],
        slot: null,
      }
      const element = event.currentTarget

      const onMove = (move: PointerEvent): void => {
        const current = active.current
        if (current?.pointerId !== move.pointerId) return
        if (!current.dragging) {
          if (Math.abs(move.clientY - current.startY) <= ROW_DRAG_PX) return
          current.dragging = true
          current.edges = [...document.querySelectorAll('[data-sidebar-conversation]')].map(
            (row) => {
              const rect = row.getBoundingClientRect()
              return rect.top + rect.height / 2
            }
          )
          try {
            element.setPointerCapture(current.pointerId)
          } catch {
            // Document listeners still own cleanup.
          }
          document.body.style.userSelect = 'none'
          setDraggingId(current.conversationId)
        }
        const next = current.edges.filter((middle) => middle < move.clientY).length
        current.slot = next
        setSlot(next)
      }
      const onUp = (end: PointerEvent): void => {
        if (active.current !== null && end.pointerId !== active.current.pointerId) return
        detach()
        finish(true)
      }
      const onCancel = (end: PointerEvent): void => {
        if (active.current !== null && end.pointerId !== active.current.pointerId) return
        detach()
        finish(false)
      }
      function detach(): void {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onCancel)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onCancel)
    },
    [enabled, finish]
  )

  return {
    draggingId,
    onPointerDown,
    dropEdge: (index, count) => {
      if (slot === null) return undefined
      if (slot === index) return 'before'
      if (slot === count && index === count - 1) return 'after'
      return undefined
    },
    consumeSuppressedClick: () => {
      const was = suppressClick.current
      suppressClick.current = false
      return was
    },
  }
}

function DragFeedback({ drag }: { drag: ActiveTabDrag | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (drag === null) return null
  const target = drag.target
  const overlay =
    target !== null && target.kind !== 'insert' ? (
      <div
        className="workspace-drop-overlay"
        data-disabled={target.disabled}
        style={{
          left: target.rect.left,
          top: target.rect.top,
          width: target.rect.width,
          height: target.rect.height,
        }}
      >
        <span>
          {target.kind === 'move'
            ? t('workspace.moveHere')
            : t(`workspace.dropSplit.${target.direction}`)}
        </span>
      </div>
    ) : null
  const insertion =
    target?.kind === 'insert' ? (
      <div
        className="workspace-drop-line"
        style={{ left: target.line.left, top: target.line.top, height: target.line.height }}
      />
    ) : null
  const ghostStyle: CSSProperties = { left: drag.x + 12, top: drag.y + 12 }
  return (
    <>
      {overlay}
      {insertion}
      <div className="workspace-drag-ghost" style={ghostStyle}>
        {drag.title}
      </div>
    </>
  )
}
