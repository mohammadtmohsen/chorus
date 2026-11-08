import type { IdeContextPush } from '../../../shared/ipc.js'
import type { RunState } from '../../../shared/run-ipc.js'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isAgentId, type AgentId } from '@chorus/shared'
import { withBackgroundWork, type SessionRowState } from './session-row.js'
import {
  CLOSED_TERMINAL_PANEL,
  CONSOLE_WIDTH,
  type ConversationArrangement,
  type DevtoolsPanelState,
  type ProjectTerminalPaneState,
  type TerminalPanelState,
  type TrafficPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WebTabsState,
} from '../../../shared/workspace-layout.js'
import {
  CLOSED_TRAFFIC,
  DEFAULT_DEVTOOLS,
  DEFAULT_PROJECT_TERMINAL,
  leafPaneIds,
  tabLocation,
} from './layout.js'
import {
  useWorkspaceStore,
  pulseWorking,
  type SessionPulse,
  type WorkspaceActions,
  type WorkspaceStore,
} from './store.js'

/**
 * The seam between the store and the views.
 *
 * No component subscribes to `useWorkspaceStore` directly during render; it
 * comes through one of these instead. Two things buy that indirection:
 *
 * - **Cost.** A whole-store subscription re-renders on every streamed pulse,
 *   and with a live transcript mounted in the tree that is the most expensive
 *   re-render in the app. Each hook here subscribes to the narrowest slice its
 *   caller actually reads.
 * - **Reach.** The store's shape stays free to change without a sweep through
 *   the views.
 *
 * Imperative reads inside event handlers — `useWorkspaceStore.getState()` — are
 * a different thing and stay where they are. They subscribe to nothing, so they
 * cost nothing and cannot go stale: the read happens when the handler fires.
 */

/*
 * Actions are referentially stable — the initialiser defines them once and no
 * `set` call replaces them — so this shallow compare never reports a change and
 * the subscription never re-renders anyone. Selecting them as a group rather
 * than capturing the object once at module load keeps that an optimisation
 * rather than an assumption: if an action ever did get recreated, this notices.
 */
function selectActions(state: WorkspaceStore): WorkspaceActions {
  const {
    hydrate,
    addWebTab,
    insertWebTab,
    closeWebTab,
    moveWebTab,
    activateWebTab,
    showProjects,
    openProject,
    clearConversationUnread,
    seedPendingDecisions,
    showConversation,
    showConversationIn,
    focusConversationGroup,
    adoptConversation,
    replaceConversation,
    setEditorWidthFraction,
    setConsoleWidth,
    setDevtoolsWidth,
    setDevtoolsCollapsed,
    setTrafficWidth,
    setTrafficHiddenPathPrefix,
    setProjectTerminalWidth,
    setTrafficCollapsed,
    setProjectTerminalCollapsed,
    setBrowserCollapsed,
    setWebsiteCollapsed,
    addProjectShell,
    removeProjectShell,
    setRowScroll,
    moveConversationBox,
    setConversationWidths,
    resetProjectWidths,
    setConversationSizes,
    equalizeConversationBranch,
    activateTab,
    focusPane,
    closeTab,
    closePane,
    reorderTab,
    moveTab,
    splitTab,
    placeSession,
    splitWithSession,
    setPlanning,
    markProjectStarted,
    markDetached,
    clearDetached,
    setDetached,
    setBranchSizes,
    equalizeBranch,
    removeSession,
    removeProject,
    setSidebarHidden,
    setSidebarWidth,
    toggleGlobalTerminal,
    setGlobalTerminalOpen,
    setGlobalTerminalHeight,
    toggleSessionTerminal,
    setSessionTerminalHeight,
    addGlobalTerminal,
    addSessionTerminal,
    removeGlobalTerminalTab,
    removeSessionTerminalTab,
    activateGlobalTerminal,
    activateSessionTerminal,
    ingestEvents,
    ingestContextUsage,
    ingestTasks,
    ingestActivity,
    ingestIdeContext,
  } = state
  return {
    hydrate,
    addWebTab,
    insertWebTab,
    closeWebTab,
    moveWebTab,
    activateWebTab,
    showProjects,
    openProject,
    clearConversationUnread,
    seedPendingDecisions,
    showConversation,
    showConversationIn,
    focusConversationGroup,
    adoptConversation,
    replaceConversation,
    setEditorWidthFraction,
    setConsoleWidth,
    setDevtoolsWidth,
    setDevtoolsCollapsed,
    setTrafficWidth,
    setTrafficHiddenPathPrefix,
    setProjectTerminalWidth,
    setTrafficCollapsed,
    setProjectTerminalCollapsed,
    setBrowserCollapsed,
    setWebsiteCollapsed,
    addProjectShell,
    removeProjectShell,
    setRowScroll,
    moveConversationBox,
    setConversationWidths,
    resetProjectWidths,
    setConversationSizes,
    equalizeConversationBranch,
    activateTab,
    focusPane,
    closeTab,
    closePane,
    reorderTab,
    moveTab,
    splitTab,
    placeSession,
    splitWithSession,
    setPlanning,
    markProjectStarted,
    markDetached,
    clearDetached,
    setDetached,
    setBranchSizes,
    equalizeBranch,
    removeSession,
    removeProject,
    setSidebarHidden,
    setSidebarWidth,
    toggleGlobalTerminal,
    setGlobalTerminalOpen,
    setGlobalTerminalHeight,
    toggleSessionTerminal,
    setSessionTerminalHeight,
    addGlobalTerminal,
    addSessionTerminal,
    removeGlobalTerminalTab,
    removeSessionTerminalTab,
    activateGlobalTerminal,
    activateSessionTerminal,
    ingestEvents,
    ingestContextUsage,
    ingestTasks,
    ingestActivity,
    ingestIdeContext,
  }
}

export function useWorkspaceActions(): WorkspaceActions {
  return useWorkspaceStore(useShallow(selectActions))
}

export interface WorkspaceLayoutView {
  readonly layout: WorkspaceLayoutNode | null
  readonly focusedPaneId: string | null
}

/**
 * The tree and which pane owns the caret — everything the shell needs to draw
 * the arrangement, and nothing about what is inside it.
 */
export function useWorkspaceLayout(): WorkspaceLayoutView {
  return useWorkspaceStore(
    useShallow((state: WorkspaceStore) => ({
      layout: state.layout,
      focusedPaneId: state.focusedPaneId,
    }))
  )
}

/**
 * One pane's tabs. Undefined once the pane has been normalised away, which a
 * caller mid-render can still be holding an id for.
 */
export function usePane(paneId: string): WorkspacePane | undefined {
  return useWorkspaceStore((state) => state.panes[paneId])
}

/**
 * The global terminal panel's visibility and height.
 *
 * A narrow selector like every other hook here: subscribing to the whole store
 * would re-render the workspace on every transcript delta, which is the reason
 * this file exists at all.
 */
export function useGlobalTerminal(): TerminalPanelState {
  return useWorkspaceStore((state) => state.globalTerminal)
}

export function useWebTabs(): WebTabsState {
  return useWorkspaceStore((state) => state.webTabs)
}

export function useWebShowing(): boolean {
  return useWorkspaceStore((state) => state.webTabs.showing)
}

/**
 * One conversation's panel.
 *
 * `CLOSED_TERMINAL_PANEL` is a module constant rather than an object literal in the
 * selector: returning a fresh object each call would make the selector never
 * equal itself and re-render the pane on every store change.
 */
export function useSessionTerminal(conversationId: string): TerminalPanelState {
  return useWorkspaceStore((state) => state.terminals[conversationId] ?? CLOSED_TERMINAL_PANEL)
}

/**
 * One project's conversation arrangement, or undefined when it has none.
 *
 * Undefined is a real answer — a project with no conversations has no
 * arrangement at all — and the column renders nothing rather than inventing a
 * group. See the schema's own note on why absent differs from empty.
 */
export function useConversationGroups(
  projectId: string | null
): ConversationArrangement | undefined {
  return useWorkspaceStore((state) =>
    projectId === null ? undefined : state.conversationGroups[projectId]
  )
}

export function useSidebarHidden(): boolean {
  return useWorkspaceStore((state) => state.sidebarHidden)
}

export function useSidebarWidth(): number {
  return useWorkspaceStore((state) => state.sidebarWidth)
}

export function useTrafficPanel(projectId: string | null): TrafficPanelState {
  return useWorkspaceStore((state) =>
    projectId === null ? CLOSED_TRAFFIC : (state.trafficPanels[projectId] ?? CLOSED_TRAFFIC)
  )
}

export function useDevtoolsPanel(projectId: string | null): DevtoolsPanelState {
  return useWorkspaceStore((state) =>
    projectId === null ? DEFAULT_DEVTOOLS : (state.devtoolsPanels[projectId] ?? DEFAULT_DEVTOOLS)
  )
}

export function useCollapsedBrowsers(): Readonly<Record<string, boolean>> {
  return useWorkspaceStore((state) => state.collapsedBrowsers)
}

export function useEditorWidthFraction(projectId: string | null): number | undefined {
  return useWorkspaceStore((state) =>
    projectId === null ? undefined : state.editorWidthFractions[projectId]
  )
}

export function useConsoleWidth(projectId: string | null): number {
  return useWorkspaceStore((state) =>
    projectId === null
      ? CONSOLE_WIDTH.default
      : (state.consoleWidths[projectId] ?? CONSOLE_WIDTH.default)
  )
}

export function useRowScrollOffset(projectId: string | null): number {
  return useWorkspaceStore((state) => (projectId === null ? 0 : (state.rowScroll[projectId] ?? 0)))
}

export function useProjectTerminalPane(projectId: string | null): ProjectTerminalPaneState {
  return useWorkspaceStore((state) =>
    projectId === null
      ? DEFAULT_PROJECT_TERMINAL
      : (state.projectTerminals[projectId] ?? DEFAULT_PROJECT_TERMINAL)
  )
}

export function useProjectRun(projectId: string | null): RunState | null {
  const [run, setRun] = useState<{ readonly projectId: string; readonly state: RunState } | null>(
    null
  )
  useEffect(() => {
    if (projectId === null) return undefined
    let mounted = true
    let pushed = false
    const stop = window.chorus.onRun((push) => {
      if (push.projectId !== projectId) return
      pushed = true
      setRun({ projectId, state: push })
    })
    void window.chorus
      .readRunState({ projectId })
      .then((read) => {
        if (mounted && !pushed) setRun({ projectId, state: read })
      })
      .catch(() => undefined)
    return () => {
      mounted = false
      stop()
    }
  }, [projectId])
  return run !== null && run.projectId === projectId ? run.state : null
}

const GESTURES = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const

interface RowRestore {
  readonly projectId: string
  readonly target: number
  applied: number
  touched: boolean
  settled: boolean
}

export function useRowScroll(
  scroller: RefObject<HTMLElement | null>,
  projectId: string | null,
  settled: boolean,
  mounted: boolean,
  origin = 0
): (projectId: string) => void {
  const restoring = useRef<RowRestore | null>(null)
  useLayoutEffect(() => {
    const row = scroller.current
    if (row === null || projectId === null) return undefined
    const store = useWorkspaceStore.getState()
    const target = Math.max(0, origin + (store.rowScroll[projectId] ?? 0))
    row.scrollLeft = target
    const plan: RowRestore = {
      projectId,
      target,
      applied: row.scrollLeft,
      touched: false,
      settled: false,
    }
    restoring.current = plan
    const touch = (): void => {
      plan.touched = true
    }
    const save = (): void => {
      const pending = restoring.current === plan && !plan.touched
      if (pending && (!plan.settled || row.scrollLeft === plan.applied)) return
      if (restoring.current === plan) restoring.current = null
      store.setRowScroll(projectId, row.scrollLeft - origin)
    }
    for (const gesture of GESTURES) {
      row.addEventListener(gesture, touch, { capture: true, passive: true })
    }
    row.addEventListener('scroll', save, { passive: true })
    return () => {
      for (const gesture of GESTURES) row.removeEventListener(gesture, touch, { capture: true })
      row.removeEventListener('scroll', save)
      if (restoring.current === plan) restoring.current = null
    }
  }, [scroller, projectId, mounted, origin])
  useLayoutEffect(() => {
    const row = scroller.current
    const plan = restoring.current
    if (!settled || row === null || plan === null) return
    if (plan.projectId !== projectId || plan.settled) return
    if (!plan.touched) {
      row.scrollLeft = plan.target
      plan.applied = row.scrollLeft
    }
    plan.settled = true
  }, [scroller, projectId, settled, mounted, origin])
  return useCallback((id: string): void => {
    const plan = restoring.current
    if (plan !== null && plan.projectId === id) plan.touched = true
  }, [])
}

export function useTrafficLive(projectId: string | null): boolean {
  const [live, setLive] = useState<readonly string[]>([])
  useEffect(() => {
    let mounted = true
    let pushed = false
    const stop = window.chorus.onTrafficLive((push) => {
      pushed = true
      setLive(push.projectIds)
    })
    void window.chorus.readTrafficLive({}).then((read) => {
      if (mounted && !pushed) setLive(read.projectIds)
    })
    return () => {
      mounted = false
      stop()
    }
  }, [])
  return projectId !== null && live.includes(projectId)
}

/**
 * The **project** showing in the focused pane.
 *
 * Renamed from `useActiveConversationId`, which is what it was called while a
 * tab was a conversation. Phase 3 re-keyed `activeTabId` to a project id and
 * left the name, so the one caller — the rail, comparing it against
 * `session.conversationId` to mark the active tile — silently stopped matching
 * anything. A wrong name survives a re-key in a way a wrong type does not.
 */
export function useActiveProjectId(): string | null {
  return useWorkspaceStore((state) =>
    state.focusedPaneId === null ? null : (state.panes[state.focusedPaneId]?.activeTabId ?? null)
  )
}

/**
 * The one conversation the person is looking at, anywhere in the window.
 *
 * `Workspace.tsx` derives the same thing per pane, because a pane's own note
 * asks about that pane. The global note belongs to no pane, so it has to walk
 * the whole chain: focused pane, its active tab's project, that project's
 * focused group, that group's active tab. Every link can be absent — a window
 * with no project open, a project with no conversations — and each returns null
 * rather than reaching past it, since "no conversation to send to" is a state
 * the panel draws rather than an error.
 */
export function useFocusedConversationId(): string | null {
  return useWorkspaceStore((state) => {
    if (state.focusedPaneId === null) return null
    const projectId = state.panes[state.focusedPaneId]?.activeTabId ?? null
    if (projectId === null) return null
    const arrangement = state.conversationGroups[projectId]
    const groupId = arrangement?.focusedPaneId ?? null
    if (groupId === null) return null
    return arrangement?.panes[groupId]?.activeTabId ?? null
  })
}

/** Which pane holds a session's tab, or null when it is running off screen. */
export function useTabPaneId(conversationId: string): string | null {
  return useWorkspaceStore((state) => tabLocation(state, conversationId)?.paneId ?? null)
}

export function useSessionPulse(conversationId: string): SessionPulse | undefined {
  return useWorkspaceStore((state) => state.pulses[conversationId])
}

/**
 * What each agent in one conversation says it is doing, and nothing else.
 *
 * Narrow on purpose, for the reason `useWorkingSessionCount` was written down
 * the file: subscribing a mounted transcript to its whole pulse would re-render
 * it on every streamed delta. This changes only when a provider changes its
 * mind about what it is doing, which is a few times a turn.
 *
 * A string rather than the record, so the comparison is by value — a fresh
 * object would compare unequal on every push and defeat the point.
 */
export function useSessionActivity(conversationId: string): string {
  return useWorkspaceStore((state) =>
    Object.entries(state.pulses[conversationId]?.activityByActor ?? {})
      // `null` is a real value on this channel — the agent saying it stopped
      // doing the thing it named — and it belongs out of the string rather than
      // in it, because an absent entry is what the row reads as "no word".
      .filter(([, activity]) => activity !== null)
      .map(([agentId, activity]) => `${agentId}:${String(activity)}`)
      .sort()
      .join(',')
  )
}

export function useBackgroundAgents(conversationId: string): string {
  return useWorkspaceStore((state) =>
    withBackgroundWork([], state.pulses[conversationId]?.tasksByActor ?? {}).join(',')
  )
}

/**
 * How many sessions have an agent working in them, and nothing else.
 *
 * This replaced `useAllPulses()` in the shell. The old hook returned the whole
 * pulse map, so *every* streamed delta changed the object it was compared
 * against and re-rendered the workspace — which renders every mounted pane, and
 * therefore every live transcript. A number cannot do that: a delta that does
 * not change the count compares equal and nobody re-renders.
 */
export function useWorkingSessionCount(): number {
  return useWorkspaceStore(
    (state) => Object.values(state.pulses).filter((pulse) => pulseWorking(pulse).length > 0).length
  )
}

/**
 * What a rail shortcut or a drawer row actually draws.
 *
 * Deliberately not `useSessionPulse`. That returns the whole pulse including
 * `lastSeq`, which changes on every event — so a row re-rendered on each token
 * of a reply it was not showing a single character of. This omits `lastSeq`,
 * the usage totals, the context map and the task list; a shallow compare over
 * the four fields left is what makes an ordinary text delta cost nothing.
 *
 * `working` is a new array each time the store folds an event, so the shallow
 * compare would still report a change — `useShallow` compares one level, and
 * one level down is the array's identity. Joining it into a string is what
 * makes the comparison actually about the value.
 */
export function useSessionRowState(conversationId: string): SessionRowState {
  const flat = useWorkspaceStore(
    useShallow((state: WorkspaceStore) => {
      const pulse = state.pulses[conversationId]
      return {
        approvals: pulse?.approvalIds.length ?? 0,
        questions: pulse?.questionIds.length ?? 0,
        working: withBackgroundWork(
          pulseWorking(pulse).filter(isAgentId),
          pulse?.tasksByActor ?? {}
        ).join(','),
        unread: pulse?.unread ?? 0,
        failed: pulse?.failed ?? false,
      }
    })
  )
  return useMemo(
    () => ({
      approvals: flat.approvals,
      questions: flat.questions,
      working: flat.working === '' ? [] : (flat.working.split(',') as AgentId[]),
      unread: flat.unread,
      failed: flat.failed,
    }),
    [flat.approvals, flat.questions, flat.working, flat.unread, flat.failed]
  )
}

/**
 * Every pulse in a project, folded into one row.
 *
 * **One subscription per project, not one per conversation.** A project with six
 * conversations rendering six `useSessionRowState` calls would be six store
 * subscriptions to produce one 44px tile, and the rules of hooks make it
 * impossible anyway: the count changes as conversations open and close.
 *
 * `ids` is joined into a string before it is closed over, for the reason the
 * comment above `useSessionRowState` gives — the caller builds a new array every
 * render, and a dependency on its identity would defeat the memo. `useShallow`
 * compares the flattened result, so the selector re-running is free.
 *
 * The fold is a sum for the counts and a *union* for `working`: two agents
 * working in two different conversations of one project is two voices, and the
 * tile's dot needs to know it cannot name one of them.
 */
export function useProjectRowState(conversationIds: readonly string[]): SessionRowState {
  const key = conversationIds.join(',')
  const flat = useWorkspaceStore(
    useShallow((state: WorkspaceStore) => {
      let approvals = 0
      let questions = 0
      let unread = 0
      let failed = false
      const working = new Set<string>()
      for (const id of key === '' ? [] : key.split(',')) {
        const pulse = state.pulses[id]
        if (pulse === undefined) continue
        approvals += pulse.approvalIds.length
        questions += pulse.questionIds.length
        unread += pulse.unread
        failed = failed || pulse.failed
        const agents = withBackgroundWork(pulseWorking(pulse).filter(isAgentId), pulse.tasksByActor)
        for (const agentId of agents) working.add(agentId)
      }
      return { approvals, questions, unread, failed, working: [...working].sort().join(',') }
    })
  )
  return useMemo(
    () => ({
      approvals: flat.approvals,
      questions: flat.questions,
      working: flat.working === '' ? [] : (flat.working.split(',') as AgentId[]),
      unread: flat.unread,
      failed: flat.failed,
    }),
    [flat.approvals, flat.questions, flat.working, flat.unread, flat.failed]
  )
}

/**
 * Which **projects** have a tab somewhere, as one comparable string.
 *
 * It was `useOpenConversationKey` and the name outlived the truth: `pane.tabs`
 * holds project ids since the re-key, so this has been answering a different
 * question than it claimed for as long as tabs have been projects. Renamed
 * rather than left, because a wrong name is the one kind of error that survives
 * a re-key — nothing about a string of ids fails to compile when the ids change
 * meaning.
 *
 * The rail needs this to mark tiles "open elsewhere", and it needs it once
 * rather than once per tile — twenty tiles each walking the layout tree is
 * twenty subscriptions to a value that is the same for all of them. A `Set` would be a
 * new object on every store change and never compare equal, so the selector
 * returns the primitive and the caller rebuilds the set behind a `useMemo`.
 */
export function useOpenProjectKey(): string {
  return useWorkspaceStore((state) =>
    leafPaneIds(state.layout)
      .flatMap((paneId) => state.panes[paneId]?.tabs ?? [])
      .join('\n')
  )
}

/** What the project card reports across all of a project's conversations. */
export interface ProjectFacts {
  readonly tokens: number
  readonly costUsd: number | null
  /** The fullest context window in the project, or null if nobody has reported. */
  readonly contextPercent: number | null
  readonly contextMarkPercent: number | null
  readonly tasks: readonly {
    readonly id: string
    readonly kind: string
    readonly description: string
    readonly agentId: string
    readonly conversationId: string
  }[]
}

/**
 * The card's figures, summed over a project rather than read from one room.
 *
 * Spend adds up, because each conversation's total is already the sum of its
 * agents' latest reports. Context does **not**: it is a percentage of a window,
 * and adding two of them produces a number that means nothing. The fullest one
 * is the answer to the question the figure exists for — "is anything about to
 * run out of room".
 *
 * Serialised through JSON so the memo compares by value. The join-a-string trick
 * the hooks above use does not reach a task list, and returning a fresh array
 * from the selector would re-render the card on every store change. The list is
 * a handful of short objects; this is cheaper than the render it prevents.
 */
export function useProjectFacts(conversationIds: readonly string[]): ProjectFacts {
  const key = conversationIds.join(',')
  const encoded = useWorkspaceStore((state) => {
    let tokens = 0
    let cost: number | null = null
    let context: number | null = null
    let mark: number | null = null
    const tasks: ProjectFacts['tasks'][number][] = []
    for (const conversationId of key === '' ? [] : key.split(',')) {
      const pulse = state.pulses[conversationId]
      if (pulse === undefined) continue
      tokens += pulse.tokens
      if (pulse.costUsd != null) cost = (cost ?? 0) + pulse.costUsd
      for (const reading of Object.values(pulse.contextByActor)) {
        context = context === null ? reading.percent : Math.max(context, reading.percent)
        if (reading.markPercent === null) continue
        mark = mark === null ? reading.markPercent : Math.max(mark, reading.markPercent)
      }
      for (const [agentId, list] of Object.entries(pulse.tasksByActor)) {
        for (const task of list) {
          tasks.push({
            id: task.id,
            kind: task.kind,
            description: task.description,
            agentId,
            conversationId,
          })
        }
      }
    }
    return JSON.stringify({
      tokens,
      costUsd: cost,
      contextPercent: context,
      contextMarkPercent: mark,
      tasks,
    })
  })
  return useMemo(() => JSON.parse(encoded) as ProjectFacts, [encoded])
}

export interface ProjectWeight {
  readonly tokens: number
  readonly percent: number | null
  readonly markPercent: number | null
}

export function useProjectWeight(conversationIds: readonly string[]): ProjectWeight {
  const key = conversationIds.join(',')
  return useWorkspaceStore(
    useShallow((state: WorkspaceStore) => {
      let tokens = 0
      let percent: number | null = null
      let markPercent: number | null = null
      for (const id of key === '' ? [] : key.split(',')) {
        const pulse = state.pulses[id]
        if (pulse === undefined) continue
        tokens += pulse.tokens
        for (const reading of Object.values(pulse.contextByActor)) {
          percent = percent === null ? reading.percent : Math.max(percent, reading.percent)
          if (reading.markPercent === null) continue
          markPercent =
            markPercent === null ? reading.markPercent : Math.max(markPercent, reading.markPercent)
        }
      }
      return { tokens, percent, markPercent }
    })
  )
}

/**
 * Whether **every** conversation in a project is planning.
 *
 * One subscription reading the whole `planning` record, not one per session:
 * the list's length changes as conversations open and close, so a loop of
 * `usePlanning` calls would break the rules of hooks the first time it did.
 *
 * Empty is false rather than vacuously true. A project with nothing running is
 * not in plan mode; it is in no mode, and a control reading On over an empty
 * project would claim a restraint that is restraining nothing.
 */
export function useEveryPlanning(conversationIds: readonly string[]): boolean {
  const key = conversationIds.join(',')
  return useWorkspaceStore((state) => {
    if (key === '') return false
    return key.split(',').every((id) => state.planning[id] === true)
  })
}

/** Reading and reasoning only. Runtime state; it never survives a relaunch. */
export function usePlanning(conversationId: string): boolean {
  return useWorkspaceStore((state) => state.planning[conversationId] ?? false)
}

/**
 * What a conversation's editor is showing, preferring the embedded workbench.
 *
 * The preference is not a tie-break between equals: the workbench is the editor
 * in this window, and "the embedded editor has no file open" is a better answer
 * than "an editor that may not be running is unavailable". A workbench
 * `unavailable` never reaches here — the store clears the slot on it, because it
 * means the surface has gone.
 */
export function useIdeContext(conversationId: string): IdeContextPush | null {
  return useWorkspaceStore((state) => {
    const entry = state.ideByConversation[conversationId]
    return entry?.workbench ?? entry?.external ?? null
  })
}
