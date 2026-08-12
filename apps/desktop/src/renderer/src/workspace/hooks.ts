import { useShallow } from 'zustand/react/shallow'
import {
  TERMINAL_HEIGHT,
  type TerminalPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
} from '../../../shared/workspace-layout.js'

/** Stable identity, so a selector returning it compares equal to itself. */
const CLOSED_PANEL: TerminalPanelState = { open: false, height: TERMINAL_HEIGHT.default }
import { tabLocation } from './layout.js'
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
 * Every pulse at once, for the things that count across sessions.
 *
 * Returns the store's own object rather than deriving one, so the identity is
 * stable between unrelated renders and a consumer's `useMemo` actually holds.
 */
export function useAllPulses(): Readonly<Record<string, SessionPulse>> {
  return useWorkspaceStore((state) => state.pulses)
}
