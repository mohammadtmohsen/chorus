import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@chorus/shared'
import type { SessionRowState } from './session-row.js'
import {
  TERMINAL_HEIGHT,
  type TerminalPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
} from '../../../shared/workspace-layout.js'

/** Stable identity, so a selector returning it compares equal to itself. */
const CLOSED_PANEL: TerminalPanelState = { open: false, height: TERMINAL_HEIGHT.default }
import { leafPaneIds, tabLocation } from './layout.js'
import {
  useWorkspaceStore,
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
    openSession,
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
    setBranchSizes,
    equalizeBranch,
    replaceSession,
    removeSession,
    setSidebarHidden,
    setSidebarWidth,
    toggleGlobalTerminal,
    setGlobalTerminalOpen,
    setGlobalTerminalHeight,
    toggleSessionTerminal,
    setSessionTerminalHeight,
    ingestEvents,
    ingestContextUsage,
    ingestTasks,
  } = state
  return {
    hydrate,
    openSession,
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
    setBranchSizes,
    equalizeBranch,
    replaceSession,
    removeSession,
    setSidebarHidden,
    setSidebarWidth,
    toggleGlobalTerminal,
    setGlobalTerminalOpen,
    setGlobalTerminalHeight,
    toggleSessionTerminal,
    setSessionTerminalHeight,
    ingestEvents,
    ingestContextUsage,
    ingestTasks,
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

/**
 * One conversation's panel.
 *
 * `CLOSED_PANEL` is a module constant rather than an object literal in the
 * selector: returning a fresh object each call would make the selector never
 * equal itself and re-render the pane on every store change.
 */
export function useSessionTerminal(conversationId: string): TerminalPanelState {
  return useWorkspaceStore((state) => state.terminals[conversationId] ?? CLOSED_PANEL)
}

export function useSidebarHidden(): boolean {
  return useWorkspaceStore((state) => state.sidebarHidden)
}

export function useSidebarWidth(): number {
  return useWorkspaceStore((state) => state.sidebarWidth)
}

/**
 * The conversation showing in the focused pane — the one the sidebar marks
 * active, and the only one of the three leaf states that is about focus rather
 * than about being on screen at all.
 */
export function useActiveConversationId(): string | null {
  return useWorkspaceStore((state) =>
    state.focusedPaneId === null ? null : (state.panes[state.focusedPaneId]?.activeTabId ?? null)
  )
}

/** Which pane holds a session's tab, or null when it is running off screen. */
export function useTabPaneId(conversationId: string): string | null {
  return useWorkspaceStore((state) => tabLocation(state, conversationId)?.paneId ?? null)
}

export function useSessionPulse(conversationId: string): SessionPulse | undefined {
  return useWorkspaceStore((state) => state.pulses[conversationId])
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
    (state) => Object.values(state.pulses).filter((pulse) => pulse.working.length > 0).length
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
        working: (pulse?.working ?? []).join(','),
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
 * Which conversations have a tab somewhere, as one comparable string.
 *
 * The list needs this to mark rows "open elsewhere", and it needs it once
 * rather than once per row — twenty rows each walking the layout tree is twenty
 * subscriptions to a value that is the same for all of them. A `Set` would be a
 * new object on every store change and never compare equal, so the selector
 * returns the primitive and the caller rebuilds the set behind a `useMemo`.
 */
export function useOpenConversationKey(): string {
  return useWorkspaceStore((state) =>
    leafPaneIds(state.layout)
      .flatMap((paneId) => state.panes[paneId]?.tabs ?? [])
      .join('\n')
  )
}

/** Reading and reasoning only. Runtime state; it never survives a relaunch. */
export function usePlanning(conversationId: string): boolean {
  return useWorkspaceStore((state) => state.planning[conversationId] ?? false)
}
