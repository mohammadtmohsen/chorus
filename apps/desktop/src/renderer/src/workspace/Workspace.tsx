import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId, SessionInfo } from '../Session.js'
import { QuickRail } from './QuickRail.js'
import type { NoteSize } from '../noteSize.js'
import { useShellOverlay } from './overlay.js'
import { createPreviewController, ProjectPreviewHost } from './SessionPreview.js'
import { TerminalPanel } from '../TerminalPanel.js'
import type { IpcRequest } from '../../../shared/ipc.js'
import { browserWebCommand } from '../../../shared/browser-ipc.js'
import { leafPaneIds, resizeBranch, topRightPaneId, type SplitDirection } from './layout.js'
import { useGlobalTerminal, useWebTabs, useWorkspaceActions, useWorkspaceLayout } from './hooks.js'
import { EditorPane, type LayoutViewProps } from './EditorPane.js'
import type { ProjectInfo } from './session-row.js'
import { countRender } from './render-count.js'
import { monogramOf, stepSlot } from './session-row.js'
import { useWorkspaceStore } from './store.js'
import { useTabDrag, type ActiveTabDrag } from './useTabDrag.js'
import {
  primaryAlt,
  primaryOnly,
  primaryShift,
  runningPlatform,
  shortcutLabel,
} from '../shortcuts.js'
import { WebTabStrip } from './WebTabStrip.js'
import { WebTabStage } from './WebTabStage.js'
import { runWebCommand, startWebPages } from './web-pages.js'

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
  /** Starts a conversation in one named project — the `+` inside a pane. */
  readonly onStartInProject: (projectId: string) => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onEnd: (conversationId: string) => void
  readonly onCloseProject: (projectId: string) => void
  readonly closingProjects: readonly string[]
  readonly onCommitLayout: () => void
  /** A card dropped at a new place in the rail's order. */
  readonly onReorderSessions: (conversationId: string, slot: number) => void
  /** Two rail tiles trading places. Written by main; nothing here is optimistic. */
  readonly onMoveProject: (projectId: string, beforeId: string | null) => void
  readonly onDetachProject: (projectId: string) => void
  readonly onOpenSettings: () => void
  /** Opens the list of every conversation the log holds, not only the open ones. */
  readonly onOpenHistory: () => void
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly projects: readonly ProjectInfo[]
  readonly onRenameProject: (projectId: string, name: string) => void
  readonly onSetProjectNotes: (projectId: string, notes: string) => void
  readonly onSetProjectNoteSize: (projectId: string, size: NoteSize) => void
  readonly onSendProjectNoteSelection: (conversationId: string, text: string) => void
  readonly onChooseProjectProfile: (projectId: string, profileId: string) => Promise<void>
  /** Both only offered on a project whose folder is missing. */
  readonly onRelocateProject: (projectId: string) => Promise<void>
  readonly onForgetProject: (projectId: string) => Promise<void>
  readonly onAddProject: () => Promise<void>
  readonly onAddRemoteProject: () => void
  /**
   * Switches to a project — the rail's tiles.
   *
   * It started a conversation once, which made a tile impossible to press
   * meaning "show me that project": clicking the one you were already in gave
   * you a second room. Starting one is `onStartInProject`, which the strip's `+`
   * calls and which names what it does.
   */
  readonly onOpenProject: (projectId: string) => void
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
function globalTerminalRef(id: string): IpcRequest<'terminal:kill'>['ref'] {
  return { scope: 'global', id }
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { t } = useTranslation()
  countRender('Workspace')
  const { layout, focusedPaneId } = useWorkspaceLayout()
  const webTabs = useWebTabs()
  const {
    placeSession,
    splitWithSession,
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
  const trafficTerminals = useMemo(
    () =>
      globalTerminal.tabs.map((tab, index) => ({
        ref: globalTerminalRef(tab.id),
        label: t('terminal.tabLabel', { n: index + 1 }),
      })),
    [globalTerminal.tabs, t]
  )
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
    onMoveProject: props.onMoveProject,
    onDropOutside: props.onDetachProject,
  })

  /*
   * A drag is an overlay, for the same reason a dialog is.
   *
   * The drop shading and the pane outlines are DOM, and a `WebContentsView` is
   * composited above the DOM — so every zone that mattered was drawn *underneath*
   * the editor it was pointing at, and the only visible ones were over Chorus.
   * There is no z-index that reaches a native view; hiding it is the only lever.
   *
   * This reuses the still-frame path, which is what makes it tolerable: main
   * captures each surface as it hides it and the frames paint that, so the editor
   * appears frozen for the length of the drag rather than blinking out. A drag
   * lasts long enough for the capture's round trip to be invisible, unlike the
   * hover card that path was written for.
   */
  useShellOverlay(drag.drag !== null)
  /*
   * A rail tile drags the **project**, which is what a pane tab is keyed by.
   *
   * It goes through the same `onPointerDown` as a tab, and that is correct even
   * though the parameter is still named `conversationId`: the drag module moves
   * whatever a tab holds, and a tab holds a project id. The name is the last of
   * the re-key residue and is being corrected with the drag module itself, not
   * here — renaming the parameter without reworking `onReorder`, which really
   * does want a conversation, would trade one wrong name for another.
   */
  const onProjectPointerDown = useCallback(
    (projectId: string, name: string, event: ReactPointerEvent<HTMLElement>) => {
      drag.onPointerDown(projectId, name, null, event)
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
  useEffect(() => {
    return startWebPages(() => {
      commitRef.current()
    })
  }, [])
  /*
   * The shortcut effect runs once, so anything it reads from props would be
   * frozen at the first render — a reorder computed against the session list as
   * it was at launch. The same reason `commitRef` exists directly above.
   */
  const sessionsRef = useRef(props.sessions)
  sessionsRef.current = props.sessions
  const closeProjectRef = useRef(props.onCloseProject)
  closeProjectRef.current = props.onCloseProject
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
      const command = browserWebCommand(
        {
          type: 'keyDown',
          key: event.key,
          meta: event.metaKey,
          control: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          isAutoRepeat: event.repeat,
          isComposing: event.isComposing,
        },
        runningPlatform()
      )
      if (
        command !== null &&
        (state.webTabs.showing || command === 'new-tab' || command === 'reopen-tab')
      ) {
        if (document.activeElement?.closest('.sheet-backdrop') != null) return
        event.preventDefault()
        runWebCommand(command)
        return
      }
      if (event.isComposing) return
      if (
        state.webTabs.showing &&
        event.repeat &&
        (primaryOnly(event) || primaryShift(event)) &&
        (event.key.toLowerCase() === 't' || event.key.toLowerCase() === 'w')
      ) {
        event.preventDefault()
        return
      }

      if (primaryShift(event) && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        state.toggleGlobalTerminal()
        return
      }
      /*
       * ⌘J used to open this session's own terminal and no longer exists.
       *
       * A project pane carries a workbench with its own terminal on the REH, so
       * the chord is left alone here rather than swallowed — the workbench binds
       * `⌃\`` for it, and a shell inside the editor should answer the editor's
       * key. ⌘⇧J still opens the global terminal, which belongs to no project
       * and is still a PTY in main.
       */

      /*
       * ⌘⇧G opened this session's Changes panel and is now unbound.
       *
       * The panel is gone: changes are read from git inside the workbench, which
       * has its own SCM view and its own bindings for it. Left unbound rather
       * than re-pointed at the workbench's view — a chord that reaches into the
       * editor from outside it is a second way to do something the editor
       * already does, and `activeId` is a *project* here anyway.
       */

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
      /*
       * Ctrl on *both* platforms, because it is VS Code's binding rather than a
       * primary-modifier chord. On Windows Ctrl is also the primary modifier,
       * so what keeps this distinct from `Ctrl+\`` is Shift plus the physical
       * key code — not the `!metaKey` guard, which there only means "the
       * Windows key is not held".
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
        if (state.webTabs.showing) return
        if (activeId === null) return
        state.addSessionTerminal(activeId)
        return
      }
      if (state.webTabs.showing) return
      if (primaryOnly(event) && event.key.toLowerCase() === 'k' && !inTerminal) {
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
        primaryAlt(event) &&
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
      if (primaryAlt(event) && direction !== null && paneId !== null) {
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
      if (primaryOnly(event) && event.key === '\\') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.splitTab(activeId, paneId, 'right')
        commitRef.current()
        return
      }
      if (primaryOnly(event) && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (activeId !== null) closeProjectRef.current(activeId)
        return
      }
      if (command === 'previous-tab' || command === 'next-tab') {
        event.preventDefault()
        if (paneId === null || pane === undefined || pane.tabs.length === 0) return
        const next =
          (Math.max(0, pane.tabs.indexOf(activeId ?? '')) +
            (command === 'previous-tab' ? -1 : 1) +
            pane.tabs.length) %
          pane.tabs.length
        const id = pane.tabs[next]
        if (id !== undefined) state.activateTab(paneId, id)
        return
      }
      if (primaryOnly(event) && /^[1-4]$/.test(event.key)) {
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
      <QuickRail
        sessions={props.sessions}
        starting={props.starting}
        preview={preview}
        onNewSession={props.onNewSession}
        projects={props.projects}
        onAddProject={props.onAddProject}
        onAddRemoteProject={props.onAddRemoteProject}
        onOpenProject={props.onOpenProject}
        onOpenSettings={props.onOpenSettings}
        onOpenHistory={props.onOpenHistory}
        terminalOpen={globalTerminal.open}
        onToggleTerminal={toggleGlobalTerminal}
        onProjectPointerDown={onProjectPointerDown}
        onReorderSessions={props.onReorderSessions}
        draggingId={drag.drag?.fromRail === true ? drag.drag.conversationId : null}
        /*
         * Where the tiles would land if you let go now.
         *
         * Passed as the move rather than as a reordered list, so the rail owns
         * one reading of it — the same `moveBefore` the store uses to write it.
         * Two places computing an order is how the preview and the result come to
         * disagree, and the preview is the one that gets believed.
         *
         * Null unless a rail drag is currently over a gap, which is also what
         * clears the offsets the moment the pointer leaves the rail.
         */
        pendingMove={
          drag.drag?.fromRail === true && drag.drag.target?.kind === 'rail-move'
            ? { projectId: drag.drag.conversationId, beforeId: drag.drag.target.beforeId }
            : null
        }
        consumeSuppressedClick={drag.consumeSuppressedClick}
      />
      <main className="workspace-editor" aria-label="Workspace">
        <div className="workspace-layout">
          {layout === null ? (
            <>
              <div className="workspace-tab-strip web-tab-strip-empty" role="tablist">
                <WebTabStrip />
              </div>
              <EmptyWorkspace />
            </>
          ) : (
            <LayoutView
              node={layout}
              path={[]}
              sessions={sessions}
              trafficTerminals={trafficTerminals}
              focusedPaneId={focusedPaneId}
              webTabsPaneId={topRightPaneId(layout)}
              webShowing={webTabs.showing}
              drag={drag.drag}
              onTabPointerDown={drag.onPointerDown}
              onStartInProject={props.onStartInProject}
              onEndConversation={props.onEnd}
              consumeSuppressedClick={drag.consumeSuppressedClick}
              onActivate={activateTab}
              onFocus={focusPane}
              onClose={(_paneId, projectId) => {
                props.onCloseProject(projectId)
              }}
              closingProjects={props.closingProjects}
              onReorder={reorderTab}
              onRename={props.onRename}
              projects={props.projects}
              onRenameProject={props.onRenameProject}
              onSetProjectNotes={props.onSetProjectNotes}
              onSetProjectNoteSize={props.onSetProjectNoteSize}
              onSendProjectNoteSelection={props.onSendProjectNoteSelection}
              onCommitLayout={props.onCommitLayout}
              renderSession={props.renderSession}
            />
          )}
          {webTabs.showing && webTabs.activeId !== null && (
            <WebTabStage key={webTabs.activeId} webTabId={webTabs.activeId} />
          )}
        </div>
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
            shortcut={shortcutLabel({ primary: true, shift: true, key: 'j' })}
          />
        )}
      </main>
      <DragFeedback drag={drag.drag} />
      {/*
          One preview for the app, beside the shell rather than inside the rail,
          and rendered last so it is not inside anything that clips.
        */}
      <ProjectPreviewHost
        controller={preview}
        projects={props.projects}
        sessions={props.sessions}
        profiles={props.profiles}
        home={props.home}
        installed={props.installed}
        onRename={props.onRenameProject}
        onChooseProfile={props.onChooseProjectProfile}
        onRelocate={props.onRelocateProject}
        onForget={props.onForgetProject}
      />
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
 * The floor a pane may not be dragged below is `resizeBranch`'s, shared with the
 * conversation divider so one gesture cannot mean two things.
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
    if (pair <= 0) return
    const pairPx = pair * axis
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
      const along = (before + (at - start) / axis) / pair
      setSizes(props.path, resizeBranch(props.sizes, props.index, along, pairPx))
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
    const branch = event.currentTarget.closest('.split-branch')
    if (branch === null) return
    const rect = branch.getBoundingClientRect()
    const axis = props.orientation === 'row' ? rect.width : rect.height
    const before = props.sizes[props.index]
    const after = props.sizes[props.index + 1]
    if (before === undefined || after === undefined) return
    const pair = before + after
    if (pair <= 0 || axis <= 0) return
    setSizes(
      props.path,
      resizeBranch(props.sizes, props.index, (before + delta) / pair, pair * axis)
    )
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

function DragFeedback({ drag }: { drag: ActiveTabDrag | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (drag === null) return null
  const target = drag.target
  const overlay =
    /* Every insertion draws a line rather than a wash, so none of the three
       takes the overlay branch. `rail-move` joined them when project tiles
       stopped swapping: a wash names the tile you would trade with, and there is
       no such tile any more — the gap is the answer. */
    target !== null &&
    target.kind !== 'insert' &&
    target.kind !== 'rail-insert' &&
    target.kind !== 'rail-move' ? (
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
    ) : target?.kind === 'rail-insert' || target?.kind === 'rail-move' ? (
      /* The same line turned on its side: a rail is a column, so the gap it
         marks is horizontal. Both rail kinds land here — the list they reorder
         differs, the gesture and the gap do not. */
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
