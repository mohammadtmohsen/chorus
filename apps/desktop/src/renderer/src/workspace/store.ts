import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { TranscriptEvent } from '../../../shared/ipc.js'
import type { WorkspaceSnapshot } from '../../../shared/workspace-layout.js'
import {
  activateTab,
  clampSidebarWidth,
  closePane,
  closeTab,
  EMPTY_WORKSPACE,
  equalizeBranch,
  focusPane,
  moveTab,
  openSession,
  reconcileWorkspace,
  reorderTab,
  replaceSession,
  setBranchSizes,
  splitTab,
  tabLocation,
  type SplitDirection,
} from './layout.js'

export interface SessionPulse {
  readonly lastSeq: number
  readonly unread: number
  readonly working: readonly TranscriptEvent['actor'][]
  readonly approvalIds: readonly string[]
  readonly questionIds: readonly string[]
}

/** Drops one key without `delete`, which the lint rules forbid on a computed key. */
function without(
  pulses: Readonly<Record<string, SessionPulse>>,
  conversationId: string
): Record<string, SessionPulse> {
  return Object.fromEntries(Object.entries(pulses).filter(([id]) => id !== conversationId))
}

const EMPTY_PULSE: SessionPulse = {
  lastSeq: 0,
  unread: 0,
  working: [],
  approvalIds: [],
  questionIds: [],
}

/**
 * The store's non-layout state, kept apart from the actions below so that
 * `WorkspaceActions` is callables and nothing else. `hooks.ts` hands that type
 * out wholesale; if state leaked into it, a component could read a snapshot it
 * never subscribed to and render a value that has since moved on.
 */
export interface WorkspaceRuntime {
  readonly hydrated: boolean
  readonly pulses: Readonly<Record<string, SessionPulse>>
}

export interface WorkspaceActions {
  hydrate: (saved: WorkspaceSnapshot | null, conversationIds: readonly string[]) => void
  openSession: (conversationId: string, paneId?: string) => void
  activateTab: (paneId: string, conversationId: string) => void
  focusPane: (paneId: string) => void
  closeTab: (paneId: string, conversationId: string) => void
  closePane: (paneId: string) => void
  reorderTab: (paneId: string, fromIndex: number, slotBefore: number) => void
  moveTab: (conversationId: string, targetPaneId: string, slotBefore: number) => void
  splitTab: (
    conversationId: string,
    targetPaneId: string,
    direction: SplitDirection
  ) => void
  setBranchSizes: (path: readonly number[], sizes: readonly number[]) => void
  equalizeBranch: (path: readonly number[]) => void
  replaceSession: (previousId: string, nextId: string) => void
  removeSession: (conversationId: string) => void
  setSidebarHidden: (hidden: boolean) => void
  /** Committed on drop, not on every pointer move; see `useSidebarResize`. */
  setSidebarWidth: (width: number) => void
  ingestEvents: (events: readonly TranscriptEvent[]) => void
}

export type WorkspaceStore = WorkspaceSnapshot & WorkspaceRuntime & WorkspaceActions

function snapshot(state: WorkspaceStore): WorkspaceSnapshot {
  return {
    layout: state.layout,
    panes: state.panes,
    focusedPaneId: state.focusedPaneId,
    sidebarHidden: state.sidebarHidden,
    sidebarWidth: state.sidebarWidth,
  }
}

function pulseKey(event: TranscriptEvent, field: string): string {
  const value = event.payload[field]
  return typeof value === 'string' && value !== '' ? value : event.id
}

function reducePulse(
  pulse: SessionPulse,
  event: TranscriptEvent,
  visible: boolean
): SessionPulse {
  if (event.seq <= pulse.lastSeq) return pulse
  let working = [...pulse.working]
  let approvalIds = [...pulse.approvalIds]
  let questionIds = [...pulse.questionIds]
  let unread = visible ? 0 : pulse.unread

  if (event.type === 'turn.started' && !working.includes(event.actor)) working.push(event.actor)
  if (event.type === 'turn.completed') working = working.filter((actor) => actor !== event.actor)
  if (event.type === 'approval.requested') {
    const id = pulseKey(event, 'approvalId')
    if (!approvalIds.includes(id)) approvalIds.push(id)
  }
  if (event.type === 'approval.decided') {
    const id = pulseKey(event, 'approvalId')
    approvalIds = approvalIds.filter((candidate) => candidate !== id)
  }
  if (event.type === 'userinput.requested') {
    const id = pulseKey(event, 'userInputId')
    if (!questionIds.includes(id)) questionIds.push(id)
  }
  if (event.type === 'userinput.answered') {
    const id = pulseKey(event, 'userInputId')
    questionIds = questionIds.filter((candidate) => candidate !== id)
  }
  if (
    !visible &&
    (event.type === 'agent.message.completed' ||
      event.type === 'error.raised' ||
      event.type === 'handoff.created')
  ) {
    unread += 1
  }
  return { lastSeq: event.seq, unread, working, approvalIds, questionIds }
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  subscribeWithSelector((set) => {
    const update = (change: (current: WorkspaceSnapshot) => WorkspaceSnapshot): void => {
      set((state) => change(snapshot(state)))
    }
    const clearUnread = (conversationId: string): void => {
      set((state) => {
        const pulse = state.pulses[conversationId]
        if (pulse === undefined || pulse.unread === 0) return state
        return {
          pulses: { ...state.pulses, [conversationId]: { ...pulse, unread: 0 } },
        }
      })
    }

    return {
      ...EMPTY_WORKSPACE,
      hydrated: false,
      pulses: {},
      hydrate: (saved, conversationIds) => {
        const repaired = reconcileWorkspace(saved, conversationIds)
        set({
          ...repaired,
          hydrated: true,
          pulses: Object.fromEntries(conversationIds.map((id) => [id, EMPTY_PULSE])),
        })
      },
      openSession: (conversationId, paneId) => {
        update((current) => openSession(current, conversationId, paneId))
        clearUnread(conversationId)
      },
      activateTab: (paneId, conversationId) => {
        update((current) => activateTab(current, paneId, conversationId))
        clearUnread(conversationId)
      },
      focusPane: (paneId) => { update((current) => focusPane(current, paneId)); },
      closeTab: (paneId, conversationId) =>
        { update((current) => closeTab(current, paneId, conversationId)); },
      closePane: (paneId) => { update((current) => closePane(current, paneId)); },
      reorderTab: (paneId, fromIndex, slotBefore) =>
        { update((current) => reorderTab(current, paneId, fromIndex, slotBefore)); },
      moveTab: (conversationId, targetPaneId, slotBefore) => {
        update((current) => moveTab(current, conversationId, targetPaneId, slotBefore))
        clearUnread(conversationId)
      },
      splitTab: (conversationId, targetPaneId, direction) => {
        update((current) => splitTab(current, conversationId, targetPaneId, direction))
        clearUnread(conversationId)
      },
      setBranchSizes: (path, sizes) =>
        { update((current) => setBranchSizes(current, path, sizes)); },
      equalizeBranch: (path) => { update((current) => equalizeBranch(current, path)); },
      replaceSession: (previousId, nextId) => {
        set((state) => {
          const next = replaceSession(snapshot(state), previousId, nextId)
          // The restarted room inherits the old one's pulse, so a badge earned
          // before the restart does not survive it as a phantom.
          const previousPulse = state.pulses[previousId]
          const pulses = { ...without(state.pulses, previousId), [nextId]: previousPulse ?? EMPTY_PULSE }
          return { ...next, pulses }
        })
      },
      removeSession: (conversationId) => {
        set((state) => {
          const location = tabLocation(state, conversationId)
          const next =
            location === null ? snapshot(state) : closeTab(state, location.paneId, conversationId)
          return { ...next, pulses: without(state.pulses, conversationId) }
        })
      },
      setSidebarHidden: (sidebarHidden) => { set({ sidebarHidden }); },
      setSidebarWidth: (width) => { set({ sidebarWidth: clampSidebarWidth(width) }); },
      ingestEvents: (events) => {
        if (events.length === 0) return
        set((state) => {
          let changed = false
          const pulses = { ...state.pulses }
          for (const event of events) {
            const location = tabLocation(state, event.conversationId)
            const pane = location === null ? undefined : state.panes[location.paneId]
            const visible = pane?.activeTabId === event.conversationId
            const current = pulses[event.conversationId] ?? EMPTY_PULSE
            const next = reducePulse(current, event, visible)
            if (next !== current) {
              pulses[event.conversationId] = next
              changed = true
            }
          }
          return changed ? { pulses } : state
        })
      },
    }
  })
)

/**
 * The persistence seam. Not a hook: `App` subscribes to it outside the render
 * path to write layout through IPC, and a component that wanted this would be
 * re-rendering on every pane change to no purpose.
 */
export const workspaceSnapshot = (state: WorkspaceStore): WorkspaceSnapshot => snapshot(state)
