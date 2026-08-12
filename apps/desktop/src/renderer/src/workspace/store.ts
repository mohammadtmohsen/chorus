import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ContextUsagePush, TasksPush, TranscriptEvent } from '../../../shared/ipc.js'
import { countsAsUnread } from '../../../shared/unread.js'
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
  /*
   * What the conversation has spent, reduced here as well as in the transcript.
   *
   * The transcript's copy belongs to a mounted `Session`, and the sidenav shows
   * every session including the ones that are not — so the number a card needs
   * cannot come from there. Same rule as the transcript's: each agent reports
   * its own running total, so the latest wins per agent and the conversation is
   * their sum. Adding reports up would count the same tokens again each time.
   */
  readonly usageByActor: Readonly<
    Record<string, { input: number; output: number; cost: number | null }>
  >
  readonly tokens: number
  readonly costUsd: number | null
  /*
   * How full each agent has filled its context window, 0-100.
   *
   * Not reduced from events like everything else above: this is state the agent
   * reports about itself, pushed on its own channel and never written to the
   * log, so there is nothing to replay. Per actor because two agents in one
   * conversation keep separate contexts — that is the product's premise, and a
   * single number would flatten it.
   *
   * Empty until a turn finishes. Absent is the honest answer before then, and
   * different from zero, which would claim an empty context.
   */
  readonly contextByActor: Readonly<Record<string, number>>
  /**
   * What each agent has left running, as last pushed.
   *
   * Same category as `contextByActor` and carried the same way: no event
   * reports it, so folding the log must not be able to erase it. Replaced
   * wholesale per actor, including with an empty list — under the provider's
   * replace semantics that is the only thing that says the last task finished.
   */
  readonly tasksByActor: Readonly<Record<string, readonly BackgroundTaskView[]>>
}

/** One background task, as a card needs to draw it. */
export interface BackgroundTaskView {
  readonly id: string
  readonly kind: string
  readonly description: string
}

/** Drops one key without `delete`, which the lint rules forbid on a computed key. */
/** Drop one conversation's entry from a by-conversation map, whatever it holds. */
function without<T>(
  entries: Readonly<Record<string, T>>,
  conversationId: string
): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([id]) => id !== conversationId))
}

const EMPTY_PULSE: SessionPulse = {
  lastSeq: 0,
  unread: 0,
  working: [],
  approvalIds: [],
  questionIds: [],
  usageByActor: {},
  tokens: 0,
  costUsd: null,
  contextByActor: {},
  tasksByActor: {},
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
  /**
   * Which terminal panels are on screen.
   *
   * Two fields rather than one keyed map, matching `TerminalService` in main and
   * for the same reason: the global terminal belongs to no conversation, and
   * anything that iterates sessions must be incapable of reaching it. A
   * `Record<string, boolean>` with `'global'` as a key would close every
   * terminal the first time something tidied up after a closed conversation.
   *
   * Visibility only. The shell itself lives in main and outlives all of this —
   * hiding a panel detaches a view, it does not kill anything.
   */
  readonly globalTerminalOpen: boolean
  readonly sessionTerminalsOpen: Readonly<Record<string, boolean>>
}

export interface WorkspaceActions {
  hydrate: (
    saved: WorkspaceSnapshot | null,
    conversationIds: readonly string[],
    /** What the log says was missed while the app was closed, per conversation. */
    unreadByConversation?: Readonly<Record<string, number>>
  ) => void
  openSession: (conversationId: string, paneId?: string) => void
  activateTab: (paneId: string, conversationId: string) => void
  focusPane: (paneId: string) => void
  closeTab: (paneId: string, conversationId: string) => void
  closePane: (paneId: string) => void
  reorderTab: (paneId: string, fromIndex: number, slotBefore: number) => void
  moveTab: (conversationId: string, targetPaneId: string, slotBefore: number) => void
  splitTab: (conversationId: string, targetPaneId: string, direction: SplitDirection) => void
  setBranchSizes: (path: readonly number[], sizes: readonly number[]) => void
  equalizeBranch: (path: readonly number[]) => void
  replaceSession: (previousId: string, nextId: string) => void
  removeSession: (conversationId: string) => void
  setSidebarHidden: (hidden: boolean) => void
  toggleGlobalTerminal: () => void
  setGlobalTerminalOpen: (open: boolean) => void
  /** Toggles one conversation's panel, leaving every other one alone. */
  toggleSessionTerminal: (conversationId: string) => void
  /** Committed on drop, not on every pointer move; see `useSidebarResize`. */
  setSidebarWidth: (width: number) => void
  ingestEvents: (events: readonly TranscriptEvent[]) => void
  /** Pushed state, not a logged event — see the action for why it is separate. */
  ingestContextUsage: (usage: ContextUsagePush) => void
  ingestTasks: (push: TasksPush) => void
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

/** Exported for tests, like the transcript's reducer, because it is pure. */
export function reducePulse(
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
  let usageByActor = pulse.usageByActor
  let tokens = pulse.tokens
  let costUsd = pulse.costUsd
  if (event.type === 'usage.updated') {
    const num = (key: string): number =>
      typeof event.payload[key] === 'number' ? event.payload[key] : 0
    const cost = event.payload['costUsd']
    usageByActor = {
      ...usageByActor,
      [event.actor]: {
        input: num('inputTokens'),
        output: num('outputTokens'),
        cost: typeof cost === 'number' ? cost : null,
      },
    }
    const totals = Object.values(usageByActor)
    const priced = totals.filter((t) => t.cost !== null)
    tokens = totals.reduce((sum, t) => sum + t.input + t.output, 0)
    // Null until an agent actually reports a price: a zero would be a claim
    // that cannot be made, and Codex does not always report one.
    costUsd = priced.length === 0 ? null : priced.reduce((sum, t) => sum + (t.cost ?? 0), 0)
  }

  // The list is shared with the main process, which counts the same events back
  // out of the log at launch to restore this number.
  if (!visible && countsAsUnread(event.type)) {
    unread += 1
  }
  return {
    lastSeq: event.seq,
    unread,
    working,
    approvalIds,
    questionIds,
    usageByActor,
    tokens,
    costUsd,
    // Carried through untouched: no event reports it, so folding the log must
    // not be able to erase what the context channel pushed.
    contextByActor: pulse.contextByActor,
    tasksByActor: pulse.tasksByActor,
  }
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
      globalTerminalOpen: false,
      sessionTerminalsOpen: {},
      hydrate: (saved, conversationIds, unreadByConversation = {}) => {
        const repaired = reconcileWorkspace(saved, conversationIds)
        set({
          ...repaired,
          hydrated: true,
          /*
           * Seeded with what happened while the app was closed.
           *
           * Every other field starts empty on purpose — they describe a live
           * agent, and nothing is live yet. Unread is the exception because it
           * describes the *log*, which outlived the process, and starting it at
           * zero is what used to make every relaunch claim nothing had happened.
           */
          pulses: Object.fromEntries(
            conversationIds.map((id) => [
              id,
              { ...EMPTY_PULSE, unread: unreadByConversation[id] ?? 0 },
            ])
          ),
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
      focusPane: (paneId) => {
        update((current) => focusPane(current, paneId))
      },
      closeTab: (paneId, conversationId) => {
        update((current) => closeTab(current, paneId, conversationId))
      },
      closePane: (paneId) => {
        update((current) => closePane(current, paneId))
      },
      reorderTab: (paneId, fromIndex, slotBefore) => {
        update((current) => reorderTab(current, paneId, fromIndex, slotBefore))
      },
      moveTab: (conversationId, targetPaneId, slotBefore) => {
        update((current) => moveTab(current, conversationId, targetPaneId, slotBefore))
        clearUnread(conversationId)
      },
      splitTab: (conversationId, targetPaneId, direction) => {
        update((current) => splitTab(current, conversationId, targetPaneId, direction))
        clearUnread(conversationId)
      },
      setBranchSizes: (path, sizes) => {
        update((current) => setBranchSizes(current, path, sizes))
      },
      equalizeBranch: (path) => {
        update((current) => equalizeBranch(current, path))
      },
      replaceSession: (previousId, nextId) => {
        set((state) => {
          const next = replaceSession(snapshot(state), previousId, nextId)
          // The restarted room inherits the old one's pulse, so a badge earned
          // before the restart does not survive it as a phantom.
          const previousPulse = state.pulses[previousId]
          const pulses = {
            ...without(state.pulses, previousId),
            [nextId]: previousPulse ?? EMPTY_PULSE,
          }
          return { ...next, pulses }
        })
      },
      removeSession: (conversationId) => {
        set((state) => {
          const location = tabLocation(state, conversationId)
          const next =
            location === null ? snapshot(state) : closeTab(state, location.paneId, conversationId)
          /*
           * Its panel's visibility goes too. A conversation that ends and is
           * later replaced by one that reuses nothing should not inherit a panel
           * someone opened for the old one.
           */
          return {
            ...next,
            pulses: without(state.pulses, conversationId),
            sessionTerminalsOpen: without(state.sessionTerminalsOpen, conversationId),
          }
        })
      },
      toggleGlobalTerminal: () => {
        set((state) => ({ globalTerminalOpen: !state.globalTerminalOpen }))
      },
      setGlobalTerminalOpen: (globalTerminalOpen) => {
        set({ globalTerminalOpen })
      },
      toggleSessionTerminal: (conversationId) => {
        set((state) => ({
          sessionTerminalsOpen: {
            ...state.sessionTerminalsOpen,
            [conversationId]: state.sessionTerminalsOpen[conversationId] !== true,
          },
        }))
      },
      setSidebarHidden: (sidebarHidden) => {
        set({ sidebarHidden })
      },
      setSidebarWidth: (width) => {
        set({ sidebarWidth: clampSidebarWidth(width) })
      },
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
      /*
       * Its own action rather than a case in `reducePulse`.
       *
       * That reducer folds the event log, and this never enters the log — it
       * arrives on a separate push because it is the agent's current state, not
       * conversation history. Routing it through the same function would mean
       * inventing a synthetic event and a `seq` that nothing ordered.
       *
       * A report for a conversation the store has never seen is dropped: the
       * sidebar draws sessions it knows about, and a pulse conjured here would
       * be one with no card to sit on.
       */
      /*
       * Replaced rather than merged, and never skipped when empty — an empty
       * list is how the last task's ending arrives.
       */
      ingestTasks: (push) => {
        set((state) => {
          const current = state.pulses[push.conversationId]
          if (current === undefined) return state
          return {
            pulses: {
              ...state.pulses,
              [push.conversationId]: {
                ...current,
                tasksByActor: { ...current.tasksByActor, [push.agentId]: push.tasks },
              },
            },
          }
        })
      },
      ingestContextUsage: (usage) => {
        set((state) => {
          const current = state.pulses[usage.conversationId]
          if (current === undefined) return state
          if (current.contextByActor[usage.agentId] === usage.percentUsed) return state
          return {
            pulses: {
              ...state.pulses,
              [usage.conversationId]: {
                ...current,
                contextByActor: {
                  ...current.contextByActor,
                  [usage.agentId]: usage.percentUsed,
                },
              },
            },
          }
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
