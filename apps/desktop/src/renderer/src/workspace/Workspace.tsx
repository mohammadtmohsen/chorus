import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceLayoutNode } from '../../../shared/workspace-layout.js'
import type { AgentId, SessionInfo } from '../Session.js'
import { QuickRail } from './QuickRail.js'
import { SessionMenu, type MenuTarget } from './SessionMenu.js'
import { SessionMenuContext } from './session-menu-context.js'
import { createPreviewController, SessionPreviewHost } from './SessionPreview.js'
import { TerminalPanel } from '../TerminalPanel.js'
import type { TerminalRefShape } from '../../../shared/ipc.js'
import { leafPaneIds, type SplitDirection } from './layout.js'
import { usePane, useGlobalTerminal, useWorkspaceActions, useWorkspaceLayout } from './hooks.js'
import { countRender } from './render-count.js'
import { monogramOf, stepSlot } from './session-row.js'
import { useWorkspaceStore } from './store.js'
import { useTabDrag, type ActiveTabDrag } from './useTabDrag.js'

/**
 * The shell: a rail of sessions on the left, panes filling the rest.
 *
 * **Reconstructed on 2026-08-14, and the reason belongs here.** A `git checkout`
 * of this file — run against a working tree where the rail work had never been
 * committed — reverted it to a version predating all of it. What follows was
 * rebuilt from the last production bundle, which is unminified and keeps its
 * region markers, so the *code* came back exactly. The comments did not: a build
 * strips them. Everything explanatory in this file was therefore written fresh,
 * and where a decision is not evident from the code it is now unrecorded rather
 * than wrong.
 *
 * The drawer went in the same pass, deliberately: `SessionList`, its resize
 * handle, the sidebar width, search, history and Arrange mode. Sessions are the
 * rail's tiles; what a session can do lives in its composer, in the card that
 * opens on hover, and — for the cast, the folder and permissions — in the menu
 * the composer's settings control opens.
 */

interface WorkspaceProps {
  readonly sessions: readonly SessionInfo[]
  readonly starting: boolean
  readonly onNewSession: () => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onOpenPanel: (conversationId: string, panel: 'review' | 'summary') => void
  readonly onRestart: (conversationId: string) => void
  readonly onEnd: (conversationId: string) => void
  readonly onCommitLayout: () => void
  /** A card dropped at a new place in the rail's order. */
  readonly onReorderSessions: (conversationId: string, slot: number) => void
  readonly onOpenSettings: () => void
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly onToggleAgent: (
    conversationId: string,
    agentId: AgentId,
    present: boolean
  ) => Promise<void>
  readonly onChooseFolder: (conversationId: string) => Promise<void>
  readonly onSetFolder: (conversationId: string, cwd: string) => Promise<void>
  readonly home: string
  readonly onChooseProfile: (conversationId: string, profileId: string) => Promise<void>
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}

function directionFromKey(key: string): SplitDirection | null {
  if (key === 'ArrowLeft') return 'left'
  if (key === 'ArrowRight') return 'right'
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  return null
}

/**
 * The nearest pane in a direction, by where the panes actually are.
 *
 * Geometry rather than tree order: the layout is a tree of splits, and "the pane
 * to the right" is a question about the screen, not about which branch a node
 * happens to sit in. Cross-axis distance counts double, so a pane directly
 * beside wins over one further along but off to the side.
 */
function directionalPane(paneId: string, direction: SplitDirection): string | null {
  const source = document.querySelector(`[data-workspace-pane="${paneId}"]`)
  if (source === null) return null
  const sourceRect = source.getBoundingClientRect()
  const sx = sourceRect.left + sourceRect.width / 2
  const sy = sourceRect.top + sourceRect.height / 2
  const candidates = [...document.querySelectorAll('[data-workspace-pane]')].flatMap((pane) => {
    const id = (pane as HTMLElement).dataset['workspacePane']
    if (id === undefined || id === paneId) return []
    const rect = pane.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const dx = x - sx
    const dy = y - sy
    const primary =
      direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    if (primary <= 1) return []
    return [
      {
        id,
        primary,
        cross: direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx),
      },
    ]
  })
  candidates.sort((a, b) => a.primary + a.cross * 2 - (b.primary + b.cross * 2))
  return candidates[0]?.id ?? null
}

/**
 * How the global panel names one of its shells.
 *
 * The panel holds the roster and asks for a ref per tab, so scope construction
 * stays out here — `TerminalPanel` is shared by both scopes and must not learn
 * to build either. This replaced a module constant that existed to keep
 * `TerminalView`'s effect from tearing down; that reason expired when the effect
 * started depending on the ref's *parts* rather than on the object.
 */
function globalTerminalRef(id: string): TerminalRefShape {
  return { scope: 'global', id }
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { t } = useTranslation()
  countRender('Workspace')
  const { layout, focusedPaneId } = useWorkspaceLayout()
  const {
    placeSession,
    splitWithSession,
    closeTab,
    activateTab,
    focusPane,
    reorderTab,
    setGlobalTerminalOpen,
    toggleGlobalTerminal,
    setGlobalTerminalHeight,
    addGlobalTerminal,
    activateGlobalTerminal,
    removeGlobalTerminalTab,
  } = useWorkspaceActions()
  const globalTerminal = useGlobalTerminal()
  const sessions = useMemo(
    () => new Map(props.sessions.map((session) => [session.conversationId, session])),
    [props.sessions]
  )
  const preview = useRef(createPreviewController()).current
  const commit = props.onCommitLayout
  const drag = useTabDrag({
    onInsert: useCallback(
      (conversationId: string, paneId: string, slot: number) => {
        placeSession(conversationId, paneId, slot)
        commit()
      },
      [placeSession, commit]
    ),
    onSplit: useCallback(
      (conversationId: string, paneId: string, direction: SplitDirection) => {
        splitWithSession(conversationId, paneId, direction)
        commit()
      },
      [splitWithSession, commit]
    ),
    onReorder: props.onReorderSessions,
  })
  const onSessionPointerDown = useCallback(
    (conversationId: string, title: string, event: ReactPointerEvent<HTMLElement>) => {
      drag.onPointerDown(conversationId, title, null, event)
    },
    [drag]
  )

  /*
   * The shortcuts, on the document in the capture phase.
   *
   * Capture, because a pane's own handlers would otherwise swallow them, and
   * `defaultPrevented` is checked first so anything that has already claimed a
   * key keeps it. `⌘K` opens a 1.5-second chord: the arrow that follows splits
   * the focused pane, or moves the tab into the neighbouring one with Shift.
   */
  const chordUntil = useRef(0)
  const commitRef = useRef(commit)
  commitRef.current = commit
  /*
   * The shortcut effect runs once, so anything it reads from props would be
   * frozen at the first render — a reorder computed against the session list as
   * it was at launch. The same reason `commitRef` exists directly above.
   */
  const sessionsRef = useRef(props.sessions)
  sessionsRef.current = props.sessions
  const reorderRef = useRef(props.onReorderSessions)
  reorderRef.current = props.onReorderSessions
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const state = useWorkspaceStore.getState()
      const paneId = state.focusedPaneId
      const pane = paneId === null ? undefined : state.panes[paneId]
      const activeId = pane?.activeTabId ?? null
      const inTerminal = document.activeElement?.closest('.terminal-panel') != null

      if (event.metaKey && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        state.toggleGlobalTerminal()
        return
      }
      if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        // The global terminal answers its own ⌘J; a session's must not take it.
        if (document.activeElement?.closest('.terminal-panel--global') != null) return
        if (activeId === null) return
        state.toggleSessionTerminal(activeId)
        return
      }

      /*
       * ⌃⇧` — another terminal in whichever panel you are in. VS Code's binding.
       *
       * **`event.code`, not `event.key`**, and it is the one place in this
       * handler where that matters. Every other chord here reads
       * `event.key.toLowerCase()`, which is right for a letter and wrong for
       * this one: with Shift held, `key` is `~`. Copying the surrounding style
       * produces a shortcut that silently never fires.
       *
       * **`event.repeat` is rejected**, because this creates a *process*. No
       * other chord here does, so no other chord needs the guard — holding this
       * one would otherwise spawn shells at the OS key-repeat rate, which is the
       * only way a person reaches forty terminals by accident.
       */
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.metaKey &&
        !event.altKey &&
        event.code === 'Backquote'
      ) {
        /*
         * Not from inside a sheet, and this one spawns a process.
         *
         * `useDialog` traps Tab and claims Escape and nothing else, so every
         * other key reaches this handler while Settings, History or a
         * confirmation is on screen. Most chords here rearrange panes, which is
         * merely surprising behind an overlay; this one starts a **shell** in
         * whichever session was last focused, out of sight, and the person who
         * pressed it has no way to know. `preventDefault` comes after the guard
         * so a sheet that grows its own use for the chord still gets it.
         */
        if (document.activeElement?.closest('.sheet-backdrop') != null) return
        event.preventDefault()
        if (event.repeat) return
        // Same "which panel" question as ⌘J, answered the same way.
        if (document.activeElement?.closest('.terminal-panel--global') != null) {
          state.addGlobalTerminal()
          return
        }
        if (activeId === null) return
        state.addSessionTerminal(activeId)
        return
      }
      if (
        event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k' &&
        !inTerminal
      ) {
        event.preventDefault()
        chordUntil.current = performance.now() + 1500
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

      /*
       * `⌘⌥⇧↑/↓` moves the focused session in the rail — the same gesture as
       * `⌘⌥⇧←/→` moving a tab in its strip, one axis round. Handled before the
       * pane-focus arm below, which would otherwise take the arrow.
       */
      if (
        event.metaKey &&
        event.altKey &&
        event.shiftKey &&
        (direction === 'up' || direction === 'down') &&
        activeId !== null
      ) {
        event.preventDefault()
        const order = sessionsRef.current.map((session) => session.conversationId)
        const slot = stepSlot(order, activeId, direction)
        if (slot !== null) reorderRef.current(activeId, slot)
        return
      }
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
        const next =
          (Math.max(0, pane.tabs.indexOf(activeId ?? '')) +
            (event.key === '[' ? -1 : 1) +
            pane.tabs.length) %
          pane.tabs.length
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
   * The session menu is owned here.
   *
   * It is opened from the composer's own controls, which sit inside a pane —
   * several components away, with `App` as the only common ancestor. The context
   * carries the opener down; this component already holds every callback the
   * menu needs.
   */
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const openMenu = useCallback((target: MenuTarget) => {
    setMenu(target)
  }, [])
  const menuSession =
    menu === null
      ? undefined
      : props.sessions.find((session) => session.conversationId === menu.conversationId)

  return (
    <SessionMenuContext.Provider value={openMenu}>
      <div className="workspace-shell">
        <QuickRail
          sessions={props.sessions}
          starting={props.starting}
          preview={preview}
          onNewSession={props.onNewSession}
          onOpenSettings={props.onOpenSettings}
          terminalOpen={globalTerminal.open}
          onToggleTerminal={toggleGlobalTerminal}
          onSessionPointerDown={onSessionPointerDown}
          onReorderSessions={props.onReorderSessions}
          draggingId={drag.drag?.fromRail === true ? drag.drag.conversationId : null}
          consumeSuppressedClick={drag.consumeSuppressedClick}
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
              onCommitLayout={props.onCommitLayout}
              renderSession={props.renderSession}
            />
          )}
          {/*
            The global terminal, inside the editor area rather than the shell.

            Below every pane and beside the rail, which is the only arrangement
            where the panes keep their full height. It belongs to no
            conversation, so it is mounted here and not inside a `Session` —
            nothing about a conversation ending should reach it.
          */}
          {globalTerminal.open && (
            <TerminalPanel
              panel={globalTerminal}
              refFor={globalTerminalRef}
              title={t('terminal.globalTitle')}
              onHeightChange={(height) => {
                setGlobalTerminalHeight(height)
                props.onCommitLayout()
              }}
              onClose={() => {
                setGlobalTerminalOpen(false)
              }}
              onAddTerminal={addGlobalTerminal}
              onActivateTerminal={activateGlobalTerminal}
              onRemoveTerminal={removeGlobalTerminalTab}
              onFocusAway={() => undefined}
              variant="global"
              shortcut={t('terminal.shortcutGlobal')}
            />
          )}
        </main>
        <DragFeedback drag={drag.drag} />
        {/*
          One preview for the app, beside the shell rather than inside the rail,
          and rendered last so it is not inside anything that clips.
        */}
        <SessionPreviewHost
          controller={preview}
          sessions={props.sessions}
          profiles={props.profiles}
          home={props.home}
          installed={props.installed}
          onRestart={props.onRestart}
          onEnd={props.onEnd}
          onRename={props.onRename}
          onOpenPanel={props.onOpenPanel}
          onToggleAgent={props.onToggleAgent}
          onChooseFolder={props.onChooseFolder}
          onSetFolder={props.onSetFolder}
          onChooseProfile={props.onChooseProfile}
        />

        {menu !== null && menuSession !== undefined && (
          <SessionMenu
            target={menu}
            session={menuSession}
            home={props.home}
            profiles={props.profiles}
            installed={props.installed}
            onClose={() => {
              setMenu(null)
            }}
            onToggleAgent={(agentId, present) =>
              props.onToggleAgent(menu.conversationId, agentId, present)
            }
            onChooseFolder={() => props.onChooseFolder(menu.conversationId)}
            onSetFolder={(cwd) => props.onSetFolder(menu.conversationId, cwd)}
            onChooseProfile={(profileId) => props.onChooseProfile(menu.conversationId, profileId)}
          />
        )}
      </div>
    </SessionMenuContext.Provider>
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

interface LayoutViewProps {
  readonly node: WorkspaceLayoutNode
  readonly path: readonly number[]
  readonly sessions: ReadonlyMap<string, SessionInfo>
  readonly focusedPaneId: string | null
  readonly drag: ActiveTabDrag | null
  readonly onTabPointerDown: (
    conversationId: string,
    title: string,
    paneId: string | null,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  readonly consumeSuppressedClick: () => boolean
  readonly onActivate: (paneId: string, conversationId: string) => void
  readonly onFocus: (paneId: string) => void
  readonly onClose: (paneId: string, conversationId: string) => void
  readonly onReorder: (paneId: string, fromIndex: number, slotBefore: number) => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onCommitLayout: () => void
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}

function LayoutView(props: LayoutViewProps): React.JSX.Element {
  if (props.node.kind === 'leaf') return <EditorPane {...props} paneId={props.node.paneId} />
  const branch = props.node
  return (
    <div className="split-branch" data-orientation={branch.orientation}>
      {branch.children.map((child, index) => (
        <div
          key={child.kind === 'leaf' ? child.paneId : `branch-${[...props.path, index].join('-')}`}
          className="split-child"
          style={{ flexGrow: branch.sizes[index] }}
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

/**
 * The divider between two panes of one branch.
 *
 * Sizes go to the store as the pointer moves — a split is a handful of panes,
 * not a transcript per frame — and the layout is persisted only on release.
 * 240px is the floor a pane may not be dragged below, expressed as a fraction of
 * the branch so it holds at any window width.
 */
function Sash(props: {
  readonly orientation: 'row' | 'column'
  readonly path: readonly number[]
  readonly index: number
  readonly sizes: readonly number[]
  readonly onCommitLayout: () => void
}): React.JSX.Element {
  const { setBranchSizes: setSizes, equalizeBranch: equalize } = useWorkspaceActions()

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const element = event.currentTarget
    const branch = element.closest('.split-branch')
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
      /* Capture is an optimisation; losing it costs a less smooth drag. */
    }
    document.body.style.userSelect = 'none'

    const onMove = (move: globalThis.PointerEvent): void => {
      if (move.pointerId !== pointerId) return
      const at = props.orientation === 'row' ? move.clientX : move.clientY
      const nextBefore = Math.max(minimum, Math.min(pair - minimum, before + (at - start) / axis))
      const sizes = [...props.sizes]
      sizes[props.index] = nextBefore
      sizes[props.index + 1] = pair - nextBefore
      setSizes(props.path, sizes)
    }
    const stop = (end: globalThis.PointerEvent): void => {
      if (end.pointerId !== pointerId) return
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      document.body.style.removeProperty('user-select')
      try {
        element.releasePointerCapture(pointerId)
      } catch {
        /* Already released — the pointer left the window mid-drag. */
      }
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
      onKeyUp={props.onCommitLayout}
      onDoubleClick={() => {
        equalize(props.path)
        props.onCommitLayout()
      }}
    />
  )
}

function EditorPane(props: LayoutViewProps & { readonly paneId: string }): React.JSX.Element {
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
  props: LayoutViewProps & {
    readonly paneId: string
    readonly pane: { tabs: string[]; activeTabId: string | null }
  }
): React.JSX.Element {
  const { t } = useTranslation()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  /* A strip that scrolls can hold the active tab off screen. */
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
              key={conversationId}
              className="workspace-tab"
              data-active={active}
              data-dragging={props.drag?.conversationId === conversationId}
            >
              {active && <TabJoin />}
              {/*
                No rename here any more; it lives on the hover card's title.

                A tab is 160px of truncated name in a strip whose single click
                switches panes — so renaming was a double-click on the one
                control whose click already means something else, editing a title
                in a box too narrow to show it. The card shows the whole name and
                is already where you go to ask about a session.
              */}
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
                onKeyDown={(event) => {
                  onTabKeyDown(index, event)
                }}
              >
                <svg className="workspace-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 12a8 8 0 0 1-8 8H5l-1.5 2v-4.5A8 8 0 1 1 20 12Z" />
                </svg>
                <span className="workspace-tab-title">{session.title}</span>
                <span className="workspace-tab-voices" aria-hidden="true">
                  {session.participants.map((agent) => (
                    <span className={`voice-dot voice--${agent}`} key={agent} />
                  ))}
                </span>
              </button>
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
    </div>
  )
}

/*
 * A split target paints the pane it will make, at the size it will be.
 *
 * This drew a 52px strip along the edge until 2026-08-14 — `SPLIT_STRIP_PX` and
 * a `stripFor` helper, both gone — on the argument that a translucent slab over
 * half a transcript reads as "this half is selected" rather than as "a pane will
 * open here". Reversed on request, and the request is the better reading: what a
 * person wants from a drop target is *where the thing lands*, and a strip makes
 * them infer that from a seam. Half a pane is not a selection when it is wearing
 * a "Split right" chip.
 *
 * Nothing about the geometry moved. `target.rect` was always the real
 * destination and the hit area was always the full half — only the paint was a
 * strip. So a two-way split now shows a half and a split of an already-split
 * pane shows a quarter, with no arithmetic here: whatever the resolver says the
 * drop makes is what gets drawn.
 *
 * The dashed edge survives and matters more now. It marks the seam the split
 * opens along, which is the one thing a filled rectangle cannot say by itself.
 */

function DragFeedback({ drag }: { drag: ActiveTabDrag | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (drag === null) return null
  const target = drag.target
  const overlay =
    /* Both insert kinds draw a line rather than a wash, so neither takes the
       overlay branch. */
    target !== null && target.kind !== 'insert' && target.kind !== 'rail-insert' ? (
      <div
        className="workspace-drop-overlay"
        data-disabled={target.disabled}
        data-kind={target.kind}
        data-direction={target.kind === 'split' ? target.direction : undefined}
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
    ) : target?.kind === 'rail-insert' ? (
      /* The same line turned on its side: a rail is a column, so the gap it
         marks is horizontal. */
      <div
        className="workspace-drop-line workspace-drop-line--across"
        style={{ left: target.line.left, top: target.line.top, width: target.line.width }}
      />
    ) : null

  /*
   * A rail drag carries a tile; a tab drag carries a name. The ghost is kept
   * inside the window by its own width, which differs between the two.
   */
  const fromRail = drag.fromRail
  const ghostStyle: CSSProperties = {
    left: Math.min(drag.x + 12, window.innerWidth - (fromRail ? 58 : 254)),
    top: Math.min(drag.y + 12, window.innerHeight - 58),
  }
  return (
    <>
      {overlay}
      {insertion}
      <div
        className="workspace-drag-ghost"
        data-shape={fromRail ? 'tile' : 'label'}
        style={ghostStyle}
      >
        {fromRail ? monogramOf(drag.title) : drag.title}
      </div>
    </>
  )
}

/**
 * The curve that joins the active tab to the pane below it.
 *
 * Ported from `example-app`'s `TabStrip`, which solves this the way browsers do:
 * the tab and the panel are one surface, and where the tab's rounded top meets
 * the panel's flat edge there is a *concave* quarter-round turning outward on
 * each side. Without it a tab is a rounded rectangle sitting on a line — which
 * is what Chorus drew, and why the join read as two shapes touching rather than
 * one shape with a tab on it.
 *
 * Three layers, and each is load-bearing:
 *
 *  - **the bridge**, a 1px bar running from one curve's outer edge to the
 *    other's, painting over the pane body's top border for the tab's whole
 *    width plus both curves. Chorus already erased that border under the tab
 *    itself with `border-bottom-color`; the curves widen the erasure and this is
 *    what keeps it continuous across them.
 *  - **two curves**, each an SVG rather than a CSS pseudo-element, because the
 *    corner needs a *fill* — the pane's surface, flooding into the notch — and a
 *    *stroke* on the same arc, in the tab's border colour. A `border-radius`
 *    trick gives one or the other, not both, which is why the original reached
 *    for SVG too.
 *
 * Authored at 11px with a radius of 8 rather than scaling their 14px artwork:
 * their tab is `rounded-t-xl` with a 2px border and Chorus's is 9px with a 1px
 * one, so a scaled copy would have arrived with a 1.4px stroke that renders
 * soft. The control points are the usual quarter-arc constant — 8 × 0.5523 — so
 * the arc meets both straight edges tangentially.
 *
 * **11px and half-pixel coordinates, because 10px left visible breaks.** A 1px
 * stroke is centred on its path, so a path along the box's own edge renders half
 * outside it. The box is one pixel wider than the curve to hold that half, the
 * arc sits on `x = 10.5` — the centre of the tab's 1px border, not its inside
 * face — and the path carries a straight segment at each end that runs *into*
 * the lines it joins rather than stopping at them. Butting two strokes end to
 * end leaves a hairline at any fractional device-pixel offset; overlapping them
 * cannot.
 *
 * `currentColor` on the stroke and `--bg-pane-active` on the fill, so the curve
 * follows the tab it belongs to rather than restating either value.
 */
function TabJoin(): React.JSX.Element {
  return (
    <>
      <span className="workspace-tab-bridge" aria-hidden="true" />
      <svg
        className="workspace-tab-curve workspace-tab-curve--left"
        viewBox="0 0 11 11"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M11 0H10.5V2.5C10.5 6.92 6.92 10.5 2.5 10.5H0V11H11Z" fill="var(--tab-join)" />
        <path
          className="workspace-tab-curve-line"
          d="M10.5 0V2.5C10.5 6.92 6.92 10.5 2.5 10.5H0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
      <svg
        className="workspace-tab-curve workspace-tab-curve--right"
        viewBox="0 0 11 11"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M0 0H0.5V2.5C0.5 6.92 4.08 10.5 8.5 10.5H11V11H0Z" fill="var(--tab-join)" />
        <path
          className="workspace-tab-curve-line"
          d="M0.5 0V2.5C0.5 6.92 4.08 10.5 8.5 10.5H11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    </>
  )
}
