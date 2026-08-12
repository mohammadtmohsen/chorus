import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceLayoutNode } from '../../../shared/workspace-layout.js'
import { ALL_AGENTS, shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { ActivityBar } from './ActivityBar.js'
import { TerminalPanel } from '../TerminalPanel.js'
import type { TerminalRefShape } from '../../../shared/ipc.js'
import { compactTokens, money } from '../format.js'
import { SIDEBAR_WIDTH } from '../../../shared/workspace-layout.js'
import { clampSidebarWidth, leafPaneIds, type SplitDirection } from './layout.js'
import {
  useActiveConversationId,
  useAllPulses,
  usePane,
  useSessionPulse,
  useGlobalTerminal,
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
  /** The activity bar's gear opens the same panel the masthead's button does. */
  readonly onOpenSettings: () => void
  /** Opens the list of every conversation the log holds, not only the open ones. */
  readonly onOpenHistory: () => void
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
        direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
      if (primary <= 1) return []
      const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
      return [{ id, primary, cross }]
    }
  )
  candidates.sort((a, b) => a.primary + a.cross * 2 - (b.primary + b.cross * 2))
  return candidates[0]?.id ?? null
}

/** Stable, so `TerminalView`'s effect does not tear down on every render. */
const GLOBAL_TERMINAL: TerminalRefShape = { scope: 'global' }

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const { layout, focusedPaneId } = useWorkspaceLayout()
  const { moveTab, splitTab, closeTab, activateTab, focusPane, reorderTab } = useWorkspaceActions()
  const globalTerminal = useGlobalTerminal()
  const { setGlobalTerminalOpen, toggleGlobalTerminal, setGlobalTerminalHeight } =
    useWorkspaceActions()
  const sessions = useMemo(
    () => new Map(props.sessions.map((session) => [session.conversationId, session])),
    [props.sessions]
  )
  /*
   * Both of these are the *end* of a drag rather than a step in one, so they
   * write through instead of waiting on the 180ms debounce. That window exists
   * to coalesce a stream — a sash moving under the pointer — and a tab that has
   * been dropped is not a stream. Quitting inside it lost the arrangement.
   */
  const commit = props.onCommitLayout
  const insert = useCallback(
    (conversationId: string, paneId: string, slot: number) => {
      moveTab(conversationId, paneId, slot)
      commit()
    },
    [moveTab, commit]
  )
  const split = useCallback(
    (conversationId: string, paneId: string, direction: SplitDirection) => {
      splitTab(conversationId, paneId, direction)
      commit()
    },
    [splitTab, commit]
  )
  const drag = useTabDrag({ onInsert: insert, onSplit: split })
  const chordUntil = useRef(0)
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const state = useWorkspaceStore.getState()
      const paneId = state.focusedPaneId
      const pane = paneId === null ? undefined : state.panes[paneId]
      const activeId = pane?.activeTabId ?? null

      /*
       * Where the caret is, which two of the rules below depend on.
       *
       * The handler is `document`-level and in the capture phase, so it sees
       * every key before the element under the caret does. That is deliberate
       * for split and pane-focus, and wrong for a terminal: arrows are how you
       * reach shell history.
       */
      const inTerminal = document.activeElement?.closest('.terminal-panel') != null

      /*
       * `⌘J` toggles the focused pane's session terminal.
       *
       * Inert while the caret is in the global terminal. The handler resolves
       * "which session" from `focusedPaneId`, which still points at whatever
       * pane was focused last — so without this, typing `⌘J` in the global panel
       * would toggle a panel somewhere else entirely.
       */
      /*
       * `⌘⇧J` toggles the global terminal, and unlike `⌘J` it works from
       * anywhere — including from inside a terminal.
       *
       * There is nothing to resolve: `⌘J` has to answer "which session", which
       * is why it goes inert when the caret is somewhere that cannot answer.
       * This one names its target outright, so a person in the global terminal
       * can close it with the key that opened it.
       */
      if (event.metaKey && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        state.toggleGlobalTerminal()
        return
      }

      if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        if (document.activeElement?.closest('.terminal-panel--global') != null) return
        if (activeId === null) return
        state.toggleSessionTerminal(activeId)
        return
      }

      /*
       * The chord does not arm while a terminal has the caret, *and* an armed
       * chord does not consume an arrow there either.
       *
       * Guarding only the arming leaves the real case open: arm it from the
       * composer, click into the terminal, press ↑ — the window is still live
       * and the keystroke is still swallowed 1.5 seconds later.
       */
      if (
        event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k' &&
        !inTerminal
      ) {
        event.preventDefault()
        chordUntil.current = performance.now() + 1_500
        return
      }

      const direction = directionFromKey(event.key)
      if (direction !== null && performance.now() <= chordUntil.current && !inTerminal) {
        event.preventDefault()
        chordUntil.current = 0
        if (paneId === null || activeId === null) return
        if (event.shiftKey) {
          const targetPaneId = directionalPane(paneId, direction)
          const target = targetPaneId === null ? undefined : state.panes[targetPaneId]
          if (targetPaneId !== null && target !== undefined) {
            state.moveTab(activeId, targetPaneId, target.tabs.length)
            commitRef.current()
          }
        } else {
          state.splitTab(activeId, paneId, direction)
          commitRef.current()
        }
        return
      }
      if (performance.now() > chordUntil.current) chordUntil.current = 0

      if (event.metaKey && event.altKey && direction !== null && paneId !== null) {
        event.preventDefault()
        if (
          event.shiftKey &&
          (direction === 'left' || direction === 'right') &&
          pane !== undefined
        ) {
          const from = activeId === null ? -1 : pane.tabs.indexOf(activeId)
          if (from >= 0) state.reorderTab(paneId, from, from + (direction === 'left' ? -1 : 2))
          commitRef.current()
          return
        }
        const target = directionalPane(paneId, direction)
        if (target !== null) state.focusPane(target)
        return
      }

      if (event.metaKey && !event.altKey && !event.shiftKey && event.key === '\\') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.splitTab(activeId, paneId, 'right')
        commitRef.current()
        return
      }
      if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.closeTab(paneId, activeId)
        commitRef.current()
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

  /*
   * How many sessions each agent is working in.
   *
   * Read off the pulse rather than the mounted panes: the point of showing it
   * here is the sessions you are *not* looking at, and those have no pane.
   */
  const pulses = useAllPulses()
  const sidebarHidden = useSidebarHidden()
  const { setSidebarHidden } = useWorkspaceActions()
  const working = useMemo(
    () =>
      props.sessions.filter((session) => (pulses[session.conversationId]?.working.length ?? 0) > 0)
        .length,
    [props.sessions, pulses]
  )

  return (
    <div className="workspace-shell">
      <ActivityBar
        working={working}
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => {
          setSidebarHidden(!sidebarHidden)
          props.onCommitLayout()
        }}
        starting={props.starting}
        onNewSession={props.onNewSession}
        onOpenSettings={props.onOpenSettings}
        terminalOpen={globalTerminal.open}
        onToggleTerminal={toggleGlobalTerminal}
      />
      <WorkspaceSidebar
        onOpenHistory={props.onOpenHistory}
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
            onCommitLayout={props.onCommitLayout}
            renderSession={props.renderSession}
          />
        )}
        {/*
         * The global terminal, inside the editor area rather than the shell.
         *
         * Below every pane and beside the sidebar, which is where VS Code puts
         * it and the only arrangement where the sidebar keeps its full height.
         * It belongs to no conversation, so it is mounted here and not inside a
         * `Session` — nothing about a conversation ending should reach it.
         */}
        {globalTerminal.open && (
          <TerminalPanel
            terminal={GLOBAL_TERMINAL}
            title={t('terminal.globalTitle')}
            height={globalTerminal.height}
            onHeightChange={(height) => {
              setGlobalTerminalHeight(height)
              props.onCommitLayout()
            }}
            onClose={() => {
              setGlobalTerminalOpen(false)
            }}
            onFocusAway={() => undefined}
            variant="global"
            shortcut={t('terminal.shortcutGlobal')}
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
  onCommitLayout: () => void
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
              onCommitLayout={props.onCommitLayout}
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
  onCommitLayout: () => void
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
      /*
       * Letting go is the write.
       *
       * This is the one gesture in the workspace that really is a stream —
       * `setSizes` fires every frame the pointer moves — so the 180ms debounce
       * is the right tool for the middle of it and the wrong one for the end.
       * Quitting inside that window put the sashes back where they were.
       */
      props.onCommitLayout()
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
      /* Held arrows repeat, so the debounce still coalesces them; releasing is
         what settles the size, exactly as releasing the pointer does. */
      onKeyUp={props.onCommitLayout}
      onDoubleClick={() => {
        equalize(props.path)
        props.onCommitLayout()
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
                    props.onTabPointerDown(conversationId, session.title, props.paneId, event)
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
                  onKeyDown={(event) => {
                    onTabKeyDown(index, event)
                  }}
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

/**
 * Reading and reasoning, executing nothing.
 *
 * Per conversation rather than per message, which is how this app already
 * models what a room may do — the permission profile sits on this same card.
 * A mode that reset itself every turn would be a checkbox nobody could rely on.
 *
 * Not restored on relaunch: a mode belongs to a running session and a relaunch
 * is a new one. Showing it as still on would be a promise the CLI never heard.
 */
function PlanToggle(props: { conversationId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [planning, setPlanning] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      className="workspace-session-plan"
      aria-pressed={planning}
      disabled={busy}
      title={planning ? t('plan.leave') : t('plan.enter')}
      onClick={() => {
        setBusy(true)
        window.chorus
          .setPlanMode({ conversationId: props.conversationId, on: !planning })
          // The session's answer, not the click's intent: a mode that failed to
          // change must not leave a control claiming it did.
          .then((result) => {
            setPlanning(result.planning)
          })
          .catch(() => {
            // The card says what it knows. A failure here leaves the previous
            // state, which is the truthful one.
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      {t('plan.label')}
    </button>
  )
}

/**
 * Below this, the context figure is not worth the pixels.
 *
 * A number that reads 4% for an hour is one you stop seeing, and this one has to
 * still register at 80. Half the window is the point where "how much is left"
 * becomes a question someone is actually asking.
 */
const CONTEXT_NOTEWORTHY = 50

/** Where it stops being information and becomes a warning. */
const CONTEXT_NEAR_FULL = 80

/** The card floats this far off the window edge; `--step * 2` in the stylesheet. */
/**
 * The activity bar's width, read from the stylesheet that decides it.
 *
 * It was a constant here mirroring `--activity` there, which is two statements
 * of one fact and only correct while somebody keeps them equal. They already
 * disagreed once: the bar was widened and the constant was not, which put the
 * resize handle eighteen pixels inside the card and made the edge undraggable —
 * a bug whose cause is invisible at the place it shows up.
 *
 * Read per call rather than cached: it is one `getComputedStyle` on pointer
 * down, not per frame, and caching it would reintroduce the same staleness in a
 * different shape.
 */
function activityWidth(): number {
  const declared = getComputedStyle(document.documentElement).getPropertyValue('--activity')
  const parsed = Number.parseFloat(declared)
  // A stylesheet that has not loaded is the only way this is NaN, and falling
  // back to zero puts the handle at the window's edge rather than nowhere.
  return Number.isFinite(parsed) ? parsed : 0
}

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
        /*
         * Measured from where the column starts, not from the window's edge.
         *
         * The width is the column's own; `clientX` is a window coordinate.
         * Those were the same number until the activity bar took the first
         * 60px, after which every drag set a width that much larger than the
         * place the pointer was dropped. The 6px fudge that used to sit here
         * went with the card's margin — a flush panel's edge is its edge.
         */
        latest = fitSidebar(move.clientX - activityWidth())
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
  onOpenHistory: () => void
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
    const timer = setTimeout(() => {
      setQuery(queryDraft.trim().toLocaleLowerCase())
    }, 200)
    return () => {
      clearTimeout(timer)
    }
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
    closeTimer.current = setTimeout(() => {
      setPreviewing(false)
    }, 150)
  }

  return (
    <>
      <aside
        className="workspace-sidebar"
        data-hidden={hidden}
        data-previewing={previewing}
        aria-hidden={hidden && !previewing}
        inert={hidden && !previewing}
        onPointerEnter={beginPreview}
        onPointerLeave={endPreview}
      >
        <div className="workspace-sidebar-head">
          <label className="workspace-search">
            <span className="sr-only">{t('workspace.search')}</span>
            <input
              type="search"
              value={queryDraft}
              placeholder={t('workspace.search')}
              onChange={(event) => {
                setQueryDraft(event.target.value)
              }}
            />
          </label>
          {/*
           * Beside the search on purpose. The search filters what is open; this
           * reaches what is not, and the two are the same question asked of
           * different sets.
           */}
          <button
            type="button"
            className="workspace-history"
            aria-label={t('history.open')}
            title={t('history.open')}
            onClick={props.onOpenHistory}
          >
            {'\u25F4'}
          </button>
        </div>
        <div className="workspace-tree" data-reordering={reorder.draggingId !== null}>
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
              onOpenPanel={(panel) => {
                props.onOpenPanel(session.conversationId, panel)
              }}
              onRestart={() => {
                props.onRestart(session.conversationId)
              }}
              onEnd={() => {
                props.onEnd(session.conversationId)
              }}
              onPointerDown={(event) => {
                reorder.onPointerDown(session.conversationId, event)
              }}
              onOpen={() => {
                if (reorder.consumeSuppressedClick()) return
                openSession(session.conversationId)
                if (hidden) setHidden(false)
              }}
              onRenameStart={() => {
                setRenaming(session.conversationId)
              }}
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
  /*
   * The fullest participant, not an average.
   *
   * Two agents in one conversation keep separate contexts, and averaging them
   * would hide the one that is about to compact behind the one that just
   * joined. Null until some agent has finished a turn and said.
   */
  const contextValues = Object.values(pulse?.contextByActor ?? {})
  const contextPercent = contextValues.length === 0 ? null : Math.max(...contextValues)
  /*
   * Everything both agents left running, each still knowing whose it is.
   *
   * The count is the answer at rest — "something of yours is still going" — and
   * the list only appears when asked for. Nothing running is the ordinary state,
   * so there is no chip at all rather than a zero.
   *
   * The agent id is carried rather than flattened away because stopping one is
   * routed by it: a task id belongs to the provider that issued it and means
   * nothing to the other.
   */
  const running = Object.entries(pulse?.tasksByActor ?? {}).flatMap(([agentId, tasks]) =>
    tasks.map((task) => ({ ...task, agentId }))
  )
  const state = props.active ? 'active' : paneId === null ? 'offscreen' : 'open'
  /* Reset whenever the session stops working, so a warning cannot lie in wait. */
  const [armedEnd, setArmedEnd] = useState(false)
  /** Whether the running tasks are listed, or just counted. */
  const [showTasks, setShowTasks] = useState(false)
  /** Ids already asked to stop, so the button cannot be pressed twice. */
  const [stopping, setStopping] = useState<string[]>([])
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
  return (
    <div
      className="workspace-session-row"
      data-state={state}
      data-dragging={props.dragging}
      data-drop={props.drop}
      data-sidebar-conversation={props.session.conversationId}
      /*
       * The whole card is the grip.
       *
       * It was the head alone, which is a third of the card's height — so two
       * thirds of the thing you are trying to drag did nothing, and the way to
       * find that out was to try. The 5px threshold below is what keeps this
       * from stealing clicks: a press that never travels is still a press, and
       * the controls in the body get their click as usual.
       */
      onPointerDown={props.renaming ? undefined : props.onPointerDown}
    >
      {/*
        A wrapper rather than one button, because Restart and End live here now
        and a button cannot contain buttons. Same shape as a tab: one control
        that opens the thing, and its own controls beside it.
      */}
      {/*
        Renaming swaps the head, not the card.

        It used to replace the whole row with a bare field, so the thing you
        were naming vanished at the moment you named it — the cast, the folder
        and the rest went with it, and the list jumped by a card's height. The
        field stands in for the title alone. It cannot sit *inside* the head,
        because the head is a button and a button may not contain a text field.
      */}
      {props.renaming ? (
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
          onBlur={(event) => {
            props.onRenameEnd(event.currentTarget.value)
          }}
        />
      ) : (
        <button
          type="button"
          className="workspace-session-main"
          title={props.session.cwd}
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
      )}
      {/*
        Everything that acts, under everything that identifies.

        That split is the point of the card. The top half is a single target
        that opens the session — all of it, not only the words — and the bottom
        half is controls, none of which should open anything. Two halves means a
        pointer never has to guess which it is over, and the body can be dense
        without the name becoming so.
      */}
      {/*
        The lower half opens the session too, but does not advertise it.
        
        The head is the button — named, focusable, and pointer-cursored. Down
        here the click is a convenience on the gaps between controls: giving the
        whole panel a pointer would promise that every part of it does the same
        thing, when most of its area belongs to the folder, the profile and the
        rest. So the affordance stays with the things that have one.
      */}
      <div
        className="workspace-session-body"
        onClick={(event) => {
          // Only the gaps. Anything with its own job keeps it — and a drag that
          // ended here is not a click, which `onOpen` already knows.
          if (
            event.target instanceof Element &&
            event.target.closest('button, input, a') !== null
          ) {
            return
          }
          props.onOpen()
        }}
      >
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
              onClick={() => {
                void props.onChooseFolder()
              }}
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
                onClick={() => {
                  void props.onSetFolder('')
                }}
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
            onChange={(event) => {
              setEditingPath(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditingPath(null)
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                void props.onSetFolder(editingPath)
                setEditingPath(null)
              }
            }}
            /* Leaving is not agreeing: a half-typed path is what a stray click
               produces, which is the rule the composer's field used too. */
            onBlur={() => {
              setEditingPath(null)
            }}
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
                style={{
                  left: picking.x,
                  top: picking.y,
                  visibility: picking.placed ? 'visible' : 'hidden',
                }}
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
        <PlanToggle conversationId={props.session.conversationId} />
        {running.length > 0 && (
          <button
            type="button"
            className="workspace-session-tasks"
            aria-expanded={showTasks}
            title={running.map((task) => `${task.kind}: ${task.description}`).join('\n')}
            onClick={() => {
              setShowTasks(!showTasks)
            }}
          >
            {t('tasks.running', { count: running.length })}
          </button>
        )}
        <span className="workspace-session-output">
          <button
            type="button"
            className="workspace-session-output-button"
            title={t('summary.open')}
            onClick={() => {
              props.onOpenPanel('summary')
            }}
          >
            {t('summary.open')}
          </button>
          <button
            type="button"
            className="workspace-session-output-button"
            title={t('review.open')}
            onClick={() => {
              props.onOpenPanel('review')
            }}
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
          {/*
           * The fullest agent's context, because the question the number answers
           * is "is this conversation about to lose its memory" — and it is, as
           * soon as any one participant is. Shown only past a threshold: a
           * percentage that reads 4% all day is a number you learn to ignore,
           * and this one has to still mean something at 80.
           */}
          {contextPercent !== null && contextPercent >= CONTEXT_NOTEWORTHY && (
            <span
              className="workspace-session-context"
              data-near-full={contextPercent >= CONTEXT_NEAR_FULL ? 'true' : undefined}
              title={t('context.title', { percent: contextPercent })}
            >
              {t('context.short', { percent: contextPercent })}
            </span>
          )}
        </span>
        <span className="workspace-session-actions">
          <button
            type="button"
            className="workspace-session-action workspace-session-action--restart"
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
      {/*
        Below the body rather than inside it, because the body is a two-column
        grid and a task's description is a sentence rather than a cell.

        Only when asked for. A card that permanently listed every backgrounded
        command would be a log, and there is already one of those.
      */}
      {showTasks && running.length > 0 && (
        <ul className="workspace-session-task-list">
          {running.map((task) => (
            <li key={`${task.agentId}:${task.id}`}>
              <span className={`workspace-session-task-kind voice--${task.agentId}`}>
                {task.kind}
              </span>
              <span className="workspace-session-task-what" title={task.description}>
                {task.description}
              </span>
              <button
                type="button"
                className="workspace-session-task-stop"
                disabled={stopping.includes(task.id)}
                title={t('tasks.stop')}
                aria-label={t('tasks.stop')}
                onClick={() => {
                  /*
                   * Disabled on click and never re-enabled here. What re-renders
                   * this row is the provider's next snapshot, which is also the
                   * only thing that knows whether the task actually stopped —
                   * clearing the flag ourselves would say so without knowing.
                   */
                  setStopping([...stopping, task.id])
                  void window.chorus.stopTask({
                    conversationId: props.session.conversationId,
                    agentId: task.agentId === 'codex' ? 'codex' : 'claude',
                    taskId: task.id,
                  })
                }}
              >
                {t('tasks.stopShort')}
              </button>
            </li>
          ))}
        </ul>
      )}
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
    /* Snapshotted with the edges, and for the same reason: the rows move once
       the drag starts, so their resting geometry has to be taken before it. */
    rows: HTMLElement[]
    pitch: number
    from: number
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
      // Cleared here rather than on the element that ends the gesture: a
      // cancelled drag has to drop the offset too, or the card stays adrift.
      for (const row of document.querySelectorAll('[data-sidebar-conversation]')) {
        if (row instanceof HTMLElement) row.style.removeProperty('--drag-dy')
      }
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
        rows: [],
        pitch: 0,
        from: -1,
        slot: null,
      }
      const element = event.currentTarget

      const onMove = (move: PointerEvent): void => {
        const current = active.current
        if (current?.pointerId !== move.pointerId) return
        if (!current.dragging) {
          if (Math.abs(move.clientY - current.startY) <= ROW_DRAG_PX) return
          current.dragging = true
          const rows = [...document.querySelectorAll('[data-sidebar-conversation]')].filter(
            (row): row is HTMLElement => row instanceof HTMLElement
          )
          current.rows = rows
          current.edges = rows.map((row) => {
            const rect = row.getBoundingClientRect()
            return rect.top + rect.height / 2
          })
          current.from = rows.findIndex(
            (row) => row.dataset['sidebarConversation'] === current.conversationId
          )
          // One card's worth of travel, measured rather than assumed: it is the
          // card plus the list's gap, and both come from the stylesheet.
          const first = rows[0]?.getBoundingClientRect()
          const second = rows[1]?.getBoundingClientRect()
          current.pitch = first !== undefined && second !== undefined ? second.top - first.top : 0
          try {
            element.setPointerCapture(current.pointerId)
          } catch {
            // Document listeners still own cleanup.
          }
          document.body.style.userSelect = 'none'
          setDraggingId(current.conversationId)
        }
        /*
         * The card follows the pointer, written to the element rather than to
         * state: this fires every frame, and routing it through React would
         * re-render every card in the list to move one of them. The same reason
         * the sash writes its width straight to the custom property.
         */
        element.style.setProperty('--drag-dy', `${String(move.clientY - current.startY)}px`)
        const next = current.edges.filter((middle) => middle < move.clientY).length
        current.slot = next
        setSlot(next)

        /*
         * The list opens a gap as you go, rather than drawing a line where the
         * card would land.
         *
         * The rows are translated, not reordered: the drop index is read off
         * midpoints snapshotted at drag start, and actually moving the elements
         * would invalidate the measurement the drag is steering by. So the DOM
         * order is untouched until the drop commits — what moves is paint.
         */
        for (const [index, row] of current.rows.entries()) {
          if (index === current.from) continue
          const shifts =
            (index < current.from && index >= next) || (index > current.from && index < next)
          const by = index < current.from ? current.pitch : -current.pitch
          row.style.setProperty('--drag-dy', shifts ? `${String(by)}px` : '0px')
        }
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
