import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  ActivityPush,
  ContextUsagePush,
  IdeContextPush,
  TasksPush,
  TranscriptEvent,
} from '../../../shared/ipc.js'
import { countsAsUnread } from '../../../shared/unread.js'
import type {
  ConversationArrangement,
  ReturnSlot,
  TerminalPanelState,
} from '../../../shared/workspace-layout.js'
// `WorkspaceSnapshot` is imported as a value, not a type: `SNAPSHOT_KEYS` below
// reads its keys off the schema so the list cannot drift from the shape.
import {
  CLOSED_TERMINAL_PANEL,
  DEVTOOLS_WIDTH,
  GIT_WIDTH,
  PROJECT_TERMINAL_WIDTH,
  TRAFFIC_WIDTH,
  WEB_TABS_MAX,
  WorkspaceSnapshot,
} from '../../../shared/workspace-layout.js'
import {
  activateTab,
  clampConsoleWidth,
  clampDevtoolsWidth,
  clampEditorWidthFraction,
  clampGitWidth,
  clampProjectTerminalWidth,
  clampSidebarWidth,
  clampTrafficWidth,
  CLOSED_TRAFFIC,
  DEFAULT_DEVTOOLS,
  DEFAULT_GIT,
  DEFAULT_PROJECT_TERMINAL,
  closePane,
  closeTab,
  EMPTY_ARRANGEMENT,
  EMPTY_WORKSPACE,
  equalizeBranch,
  focusPane,
  isRowScroll,
  leafPaneIds,
  moveBox,
  moveTab,
  newGroupId,
  onScreenConversations,
  openBox,
  openSession,
  placeSession,
  projectTerminalMinimum,
  reconcileWorkspace,
  newTerminalId,
  normalizeTerminalPanel,
  normalizeWebTabs,
  reorderTab,
  replaceSession,
  resetBoxes,
  setBranchSizes,
  splitTab,
  splitWithSession,
  tabLocation,
  withColumnWidths,
  type SplitDirection,
} from './layout.js'

export interface SessionPulse {
  readonly lastSeq: number
  readonly unread: number
  readonly working: readonly TranscriptEvent['actor'][]
  readonly replies?: Readonly<Record<string, TranscriptEvent['actor']>>
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
   * How full each agent has filled its context window, and where its ceiling is.
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
  readonly contextByActor: Readonly<Record<string, ContextReading>>
  /**
   * What each agent has left running, as last pushed.
   *
   * Same category as `contextByActor` and carried the same way: no event
   * reports it, so folding the log must not be able to erase it. Replaced
   * wholesale per actor, including with an empty list — under the provider's
   * replace semantics that is the only thing that says the last task finished.
   */
  readonly tasksByActor: Readonly<Record<string, readonly BackgroundTaskView[]>>
  /**
   * What each agent says it is doing right now, as last pushed.
   *
   * The same category again, and the one that changes fastest — several times a
   * turn. A key rather than a phrase: nothing in this file has a translator, and
   * the working line is what turns it into a word.
   *
   * `null` is a value with meaning. It says the agent has stopped doing the
   * thing it named and is back to working at nothing in particular, which is
   * most of a turn; treating it as absent would leave `compacting` on screen
   * long after the compaction finished.
   */
  readonly activityByActor: Readonly<Record<string, ActivityPush['activity']>>
  /**
   * The last turn in this conversation ended badly.
   *
   * One of the four states a row draws, and the only one with no other source:
   * waiting is a count of approvals, working is a list of actors, idle is the
   * absence of both. `turn.completed` carries `status`, so this is folded from
   * the log like the rest of the pulse rather than pushed.
   *
   * Cleared when a turn starts, not when the row is seen. A failure that
   * disappeared because a pointer crossed it would be a state you could miss by
   * looking at it.
   */
  readonly failed: boolean
}

/** One background task, as a card needs to draw it. */
export interface BackgroundTaskView {
  readonly id: string
  readonly kind: string
  readonly description: string
}

export interface ContextReading {
  readonly percent: number
  readonly markPercent: number | null
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
  replies: {},
  approvalIds: [],
  questionIds: [],
  usageByActor: {},
  tokens: 0,
  costUsd: null,
  contextByActor: {},
  tasksByActor: {},
  activityByActor: {},
  failed: false,
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
   * What each conversation's editor is showing, by source — Phase 6.
   *
   * **Here rather than in `Session`, and that is the whole point.** Only the
   * active tab of each group is mounted, so a `Session` holding this in its own
   * `useState` lost it on every switch: the remount initialised both slots to
   * `null`, and any push that arrived while it was unmounted had nowhere to
   * land. `runtime.subscribe` in main does not fire because a React component
   * mounted, so nothing ever put it back — and `ideAttached` was false again for
   * a reason that had nothing to do with the editor.
   *
   * It is state, not history: held in memory, never logged, and rebuilt from the
   * next push. `CLAUDE.md`'s own rule — everything a session needs to survive
   * unmounting has to live outside the component.
   */
  readonly ideByConversation: Readonly<
    Record<string, { workbench: IdeContextPush | null; external: IdeContextPush | null }>
  >
  /**
   * Which conversations are reading and reasoning only.
   *
   * It used to live inside the toggle that set it, which was fine while the
   * toggle was the only thing that showed it. The preview shows it now, and the
   * toggle is in a menu that unmounts — so a control's own `useState` would
   * forget the mode every time the menu closed.
   *
   * Runtime rather than snapshot: a mode belongs to a running session, and a
   * relaunch is a new one. Nothing here is persisted.
   */
  readonly planning: Readonly<Record<string, boolean>>
  readonly startedProjects: Readonly<Record<string, true>>
  readonly detached: Readonly<Record<string, ReturnSlot>>
}

export interface WorkspaceActions {
  addWebTab: (show: boolean) => string
  insertWebTab: (id: string, index: number, show: boolean) => void
  closeWebTab: (id: string) => void
  moveWebTab: (id: string, toIndex: number) => void
  activateWebTab: (id: string) => void
  showProjects: () => void
  hydrate: (
    saved: WorkspaceSnapshot | null,
    conversationIds: readonly string[],
    /** Which projects have a conversation open — what the tabs are keyed by. */
    projectIds: readonly string[],
    /** What the log says was missed while the app was closed, per conversation. */
    unreadByConversation?: Readonly<Record<string, number>>,
    /** Which conversations each project holds — what the inner columns are built from. */
    conversationsByProject?: Readonly<Record<string, readonly string[]>>,
    /**
     * Decisions still outstanding when the app last closed, per conversation.
     *
     * Real ids rather than counts, because `approval.decided` clears by id — a
     * seeded placeholder would never match and the mark would stick on a
     * question that had been answered.
     */
    pendingByConversation?: Readonly<
      Record<
        string,
        { readonly approvalIds: readonly string[]; readonly questionIds: readonly string[] }
      >
    >
  ) => void
  /** Opens a **project** tab. Conversations live inside one; they are not tabs. */
  openProject: (projectId: string, paneId?: string) => void
  activateTab: (paneId: string, projectId: string) => void
  /** Marks one conversation read. Separate from the tab actions on purpose. */
  clearConversationUnread: (conversationId: string) => void
  /**
   * Seeds one conversation's outstanding decisions — what `hydrate` does at
   * launch, for a conversation that arrives afterwards.
   *
   * Reopening from history is the case: the room may have been left with an
   * approval nobody answered, and the pulse only folds events pushed since the
   * app started, so its tab would read idle beside a transcript drawing the
   * card. Replaces rather than merges, because main has just read the
   * projection and its answer is the whole truth.
   */
  seedPendingDecisions: (
    conversationId: string,
    pending: { readonly approvalIds: readonly string[]; readonly questionIds: readonly string[] }
  ) => void
  /**
   * Puts one of a project's conversations on screen — what the dock does.
   *
   * Takes both ids because the pane is keyed by the project and the content by
   * the conversation, and deriving one from the other would mean the store
   * holding a session list it has no other reason to know about.
   */
  showConversation: (projectId: string, conversationId: string) => void
  focusPane: (paneId: string) => void
  closeTab: (paneId: string, projectId: string) => void
  closePane: (paneId: string) => void
  reorderTab: (paneId: string, fromIndex: number, slotBefore: number) => void
  moveTab: (conversationId: string, targetPaneId: string, slotBefore: number) => void
  splitTab: (conversationId: string, targetPaneId: string, direction: SplitDirection) => void
  /** Move an open session, or open a closed one, into a pane at a slot. */
  placeSession: (conversationId: string, targetPaneId: string, slotBefore: number) => void
  /** The same, into a new group beside the target. Refuses a fifth pane. */
  splitWithSession: (
    conversationId: string,
    targetPaneId: string,
    direction: SplitDirection
  ) => void
  /** What plan mode actually became, as the session reported it. */
  setPlanning: (conversationId: string, planning: boolean) => void
  markProjectStarted: (projectId: string) => void
  markDetached: (projectId: string, slot: ReturnSlot) => void
  clearDetached: (projectId: string) => void
  setDetached: (detached: Readonly<Record<string, ReturnSlot>>) => void
  setBranchSizes: (path: readonly number[], sizes: readonly number[]) => void
  equalizeBranch: (path: readonly number[]) => void
  /** Forgets one conversation's state. Leaves the project's tab alone. */
  removeSession: (conversationId: string) => void
  /** Closes a project's tab. Call when its last conversation has gone. */
  removeProject: (projectId: string) => void
  setSidebarHidden: (hidden: boolean) => void
  toggleGlobalTerminal: () => void
  setGlobalTerminalOpen: (open: boolean) => void
  /** Committed on release, not per frame — same trade as the sidebar's width. */
  setGlobalTerminalHeight: (height: number) => void
  /** Toggles one conversation's panel, leaving every other one alone. */
  toggleSessionTerminal: (conversationId: string) => void
  setSessionTerminalHeight: (conversationId: string, height: number) => void
  /** Append a terminal to a panel's roster and select it. Opens the panel. */
  addGlobalTerminal: () => void
  addSessionTerminal: (conversationId: string) => void
  /**
   * Drop a tab from the roster. **Kills nothing** — the shell is in main, and
   * the caller awaits `terminal:kill` first. Removing the last tab hides the
   * panel rather than leaving it open with nothing in it.
   */
  removeGlobalTerminalTab: (id: string) => void
  removeSessionTerminalTab: (conversationId: string, id: string) => void
  activateGlobalTerminal: (id: string) => void
  activateSessionTerminal: (conversationId: string, id: string) => void
  /** Committed on drop, not on every pointer move; see `useSidebarResize`. */
  setSidebarWidth: (width: number) => void
  /**
   * Puts a conversation on screen in the group that holds it.
   *
   * Distinct from `showConversation`, which searches every group: this names
   * one, because a conversation open in a strip is being clicked in a *place*.
   */
  showConversationIn: (projectId: string, groupId: string, conversationId: string) => void
  /** Which group a new conversation joins and the keyboard acts on. */
  focusConversationGroup: (projectId: string, groupId: string) => void
  /**
   * Gives a newly created conversation a tab, in the focused group.
   *
   * **Required, not a convenience.** `reconcileConversationGroups` is the only
   * other thing that places a conversation, and it runs at hydrate — so without
   * this a conversation started while the app is open exists, streams, and has
   * no tab anywhere until the next relaunch. Idempotent, so every path that can
   * produce a conversation may call it without checking first.
   */
  adoptConversation: (projectId: string, conversationId: string) => void
  replaceConversation: (projectId: string, previousId: string, nextId: string) => boolean
  setEditorWidthFraction: (projectId: string, fraction: number) => void
  setConsoleWidth: (projectId: string, width: number) => void
  setDevtoolsWidth: (projectId: string, width: number) => void
  setDevtoolsCollapsed: (projectId: string, collapsed: boolean) => void
  setGitWidth: (projectId: string, width: number) => void
  setGitCollapsed: (projectId: string, collapsed: boolean) => void
  setTrafficWidth: (projectId: string, width: number) => void
  setTrafficHiddenPathPrefix: (projectId: string, hiddenPathPrefix: string) => void
  setProjectTerminalWidth: (projectId: string, width: number) => void
  setTrafficCollapsed: (projectId: string, collapsed: boolean) => void
  setProjectTerminalCollapsed: (projectId: string, collapsed: boolean) => void
  setBrowserCollapsed: (projectId: string, collapsed: boolean) => void
  setWebsiteCollapsed: (projectId: string, collapsed: boolean) => void
  addProjectShell: (projectId: string) => string
  removeProjectShell: (projectId: string, id: string) => void
  setRowScroll: (projectId: string, left: number) => void
  moveConversationBox: (
    projectId: string,
    boxId: string,
    targetBoxId: string,
    direction: SplitDirection
  ) => void
  setConversationWidths: (projectId: string, widths: readonly number[]) => void
  resetProjectWidths: (projectId: string) => void
  /** How a branch of the conversation tree divides, by path. */
  setConversationSizes: (
    projectId: string,
    path: readonly number[],
    sizes: readonly number[]
  ) => void
  /**
   * Give every group in one branch the same share — the inner `equalizeBranch`.
   *
   * The same function the pane tree's divider calls, not a second one that
   * agrees with it: `equalizeBranch` is generic over `PaneTree`, so "double-click
   * a divider to even things up" is one behaviour at both levels rather than two
   * that happen to match today.
   */
  equalizeConversationBranch: (projectId: string, path: readonly number[]) => void
  /**
   * Fold a batch of logged events into the pulses.
   *
   * `reported` is what another window says it is showing — see
   * `onScreenConversations`, whose answer this is. Passed in rather than read
   * from a store field because a detached window's visibility lives in the shell
   * that received the push, and a store that grew a second copy of it would be
   * the drift this whole change is about.
   */
  ingestEvents: (events: readonly TranscriptEvent[], reported?: readonly string[]) => void
  /** Pushed state, not a logged event — see the action for why it is separate. */
  ingestContextUsage: (usage: ContextUsagePush) => void
  ingestTasks: (push: TasksPush) => void
  ingestActivity: (push: ActivityPush) => void
  ingestIdeContext: (push: IdeContextPush) => void
}

export type WorkspaceStore = WorkspaceSnapshot & WorkspaceRuntime & WorkspaceActions

/*
 * Every terminal-panel edit goes through `normalizeTerminalPanel`.
 *
 * Not a style choice. The panel invariant — an open panel has at least one tab,
 * ids are unique, `activeId` names one of them — is what lets `Session` and
 * `Workspace` render a ref without a null check, and these actions are the only
 * things besides a persisted file that can break it. Routing them through the
 * same repair the loader uses means "opening a panel mints its first terminal"
 * is not a rule anyone has to remember: `toggleSessionTerminal` flips `open` and
 * the normalizer supplies the tab.
 *
 * The two helpers stay scope-explicit — `editGlobal` and `editSession`, not one
 * function taking a nullable conversation id — for the reason the whole feature
 * keeps repeating: the global panel belongs to no conversation, and a nullable
 * id is how it ends up reached by something walking sessions.
 */
function editGlobal(
  state: WorkspaceStore,
  change: (panel: TerminalPanelState) => TerminalPanelState
): Pick<WorkspaceSnapshot, 'globalTerminal'> {
  return { globalTerminal: normalizeTerminalPanel(change(state.globalTerminal)) }
}

function editSession(
  state: WorkspaceStore,
  conversationId: string,
  change: (panel: TerminalPanelState) => TerminalPanelState
): Pick<WorkspaceSnapshot, 'terminals'> {
  const current = state.terminals[conversationId] ?? CLOSED_TERMINAL_PANEL
  return {
    terminals: {
      ...state.terminals,
      [conversationId]: normalizeTerminalPanel(change(current)),
    },
  }
}

/**
 * Edit one project's conversation arrangement, or do nothing.
 *
 * **A project with no entry is left alone**, deliberately. Absent means "never
 * arranged", and every one of these actions names a group that a non-existent
 * arrangement cannot contain — so inventing one here would be inventing a group
 * id the caller did not mean. `reconcileConversationGroups` is the only thing
 * that creates an arrangement, because it is the only thing that knows which
 * conversations are live.
 */
function editArrangement(
  state: WorkspaceStore,
  projectId: string,
  change: (arrangement: ConversationArrangement) => ConversationArrangement
): Record<string, ConversationArrangement> {
  const current = state.conversationGroups[projectId]
  if (current === undefined) return state.conversationGroups
  return { ...state.conversationGroups, [projectId]: change(current) }
}

/** A new terminal, appended and selected. Opens the panel if it was hidden. */
function addTab(panel: TerminalPanelState): TerminalPanelState {
  const id = newTerminalId()
  return { ...panel, open: true, tabs: [...panel.tabs, { id }], activeId: id }
}

/**
 * Drop one tab from the roster.
 *
 * **This does not kill anything** — the PTY is in main, and the caller awaits
 * `terminal:kill` before calling this. The name says so: a `killTerminal` here
 * would read at the call site as though the store had done the killing, which is
 * the same confusion `detach`-versus-`dispose` cost a section of the original
 * plan.
 *
 * Removing the last tab closes the panel, because an open panel with no tabs
 * violates the invariant and there is nothing to show. `normalizeTerminalPanel`
 * would otherwise mint a replacement — killing the last terminal would silently
 * open a new one.
 */
function removeTab(panel: TerminalPanelState, id: string): TerminalPanelState {
  const tabs = panel.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return { ...panel, open: false, tabs: [], activeId: null }
  /*
   * The neighbour, not the first. Closing the tab you are looking at should land
   * on the one beside it — the same rule `normalizeWorkspace` already applies to
   * a pane's `activeTabId`, and the reason it clamps an index rather than
   * resetting.
   */
  const removedAt = panel.tabs.findIndex((tab) => tab.id === id)
  const next = panel.activeId === id ? tabs[Math.min(removedAt, tabs.length - 1)] : undefined
  return { ...panel, tabs, activeId: next?.id ?? panel.activeId }
}

/** Select a tab, ignoring an id this panel does not hold. */
function activateTerminalTab(panel: TerminalPanelState, id: string): TerminalPanelState {
  if (!panel.tabs.some((tab) => tab.id === id)) return panel
  return { ...panel, activeId: id }
}

function snapshot(state: WorkspaceStore): WorkspaceSnapshot {
  return {
    layout: state.layout,
    panes: state.panes,
    focusedPaneId: state.focusedPaneId,
    sidebarHidden: state.sidebarHidden,
    sidebarWidth: state.sidebarWidth,
    conversationGroups: state.conversationGroups,
    trafficPanels: state.trafficPanels,
    devtoolsPanels: state.devtoolsPanels,
    gitPanels: state.gitPanels,
    projectTerminals: state.projectTerminals,
    collapsedBrowsers: state.collapsedBrowsers,
    collapsedWebsites: state.collapsedWebsites,
    rowScroll: state.rowScroll,
    editorWidthFractions: state.editorWidthFractions,
    consoleWidths: state.consoleWidths,
    terminals: state.terminals,
    globalTerminal: state.globalTerminal,
    webTabs: state.webTabs,
    /*
     * Hand-written, unlike `SNAPSHOT_KEYS` below which reads the schema. A field
     * added to `WorkspaceSnapshot` and forgotten *here* is dropped on every
     * persist — which is the same class of bug the comment on `SNAPSHOT_KEYS`
     * records, from the other end.
     */
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
  let replies = { ...pulse.replies }
  let approvalIds = [...pulse.approvalIds]
  let questionIds = [...pulse.questionIds]
  let unread = visible ? 0 : pulse.unread

  let failed = pulse.failed
  if (event.type === 'reply.status') {
    const requestId = pulseKey(event, 'requestId')
    const phase = pulseKey(event, 'phase')
    if (phase === 'waiting' || phase === 'thinking' || phase === 'replying') {
      replies[requestId] = event.actor
      if (phase === 'waiting') failed = false
    } else {
      replies = Object.fromEntries(Object.entries(replies).filter(([id]) => id !== requestId))
      if (phase === 'error') failed = true
    }
  }
  const sessionAgent =
    event.type === 'session.started' || event.type === 'session.ended'
      ? pulseKey(event, 'agentId')
      : null
  if (sessionAgent !== null) working = working.filter((actor) => actor !== sessionAgent)
  if (event.type === 'turn.started') {
    if (!working.includes(event.actor)) working.push(event.actor)
    failed = false
  }
  if (event.type === 'turn.completed') {
    working = working.filter((actor) => actor !== event.actor)
    /*
     * Set, never cleared here.
     *
     * `interrupted` is not a failure: it is what stopping an agent looks like
     * from the log's side, and marking the row failed for it would turn a
     * deliberate Stop into an alarm. But this was an assignment, so *any*
     * completion decided the flag — and a conversation has two agents in it. One
     * failing and the other finishing normally a second later left a row that
     * said idle, which is the one case where the state matters most: the reply
     * you are waiting for never came and nothing on the rail says so.
     *
     * `turn.started` is the only thing that clears it, which is what the field's
     * own comment already promised: a failure survives until the next turn.
     */
    if (event.payload['status'] === 'failed') failed = true
  }
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
  const quieted =
    event.type === 'turn.started' || event.type === 'turn.completed' ? event.actor : sessionAgent
  const activityByActor =
    quieted === null || (pulse.activityByActor[quieted] ?? null) === null
      ? pulse.activityByActor
      : { ...pulse.activityByActor, [quieted]: null }
  return {
    lastSeq: event.seq,
    unread,
    working,
    replies,
    approvalIds,
    questionIds,
    usageByActor,
    tokens,
    costUsd,
    activityByActor,
    // Carried through untouched: no event reports it, so folding the log must
    // not be able to erase what the context channel pushed.
    contextByActor: pulse.contextByActor,
    tasksByActor: pulse.tasksByActor,
    failed,
  }
}

export function pulseWorking(pulse: SessionPulse | undefined): TranscriptEvent['actor'][] {
  return [...new Set([...(pulse?.working ?? []), ...Object.values(pulse?.replies ?? {})])]
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  subscribeWithSelector((set, get) => {
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
      ideByConversation: {},
      planning: {},
      startedProjects: {},
      detached: {},
      addWebTab: (show) => {
        if (get().webTabs.tabs.length >= WEB_TABS_MAX) return ''
        const id = crypto.randomUUID()
        get().insertWebTab(id, get().webTabs.tabs.length, show)
        return id
      },
      insertWebTab: (id, index, show) => {
        set((state) => {
          const current = state.webTabs
          if (current.tabs.length >= WEB_TABS_MAX || current.tabs.some((tab) => tab.id === id)) {
            return state
          }
          const tabs = [...current.tabs]
          tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, { id })
          return {
            webTabs: normalizeWebTabs({
              tabs,
              activeId: show ? id : current.activeId,
              showing: show || current.showing,
            }),
          }
        })
      },
      closeWebTab: (id) => {
        set((state) => {
          const current = state.webTabs
          const index = current.tabs.findIndex((tab) => tab.id === id)
          if (index < 0) return state
          const tabs = current.tabs.filter((tab) => tab.id !== id)
          const activeId =
            current.activeId === id
              ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
              : current.activeId
          return { webTabs: { tabs, activeId, showing: current.showing && activeId !== null } }
        })
      },
      moveWebTab: (id, toIndex) => {
        set((state) => {
          const current = state.webTabs
          const from = current.tabs.findIndex((tab) => tab.id === id)
          if (from < 0 || Number.isNaN(toIndex)) return state
          const to = Math.max(0, Math.min(Math.trunc(toIndex), current.tabs.length - 1))
          if (from === to) return state
          const tabs = [...current.tabs]
          const moved = tabs.splice(from, 1)[0]
          if (moved === undefined) return state
          tabs.splice(to, 0, moved)
          return { webTabs: { ...current, tabs } }
        })
      },
      activateWebTab: (id) => {
        set((state) =>
          state.webTabs.tabs.some((tab) => tab.id === id)
            ? { webTabs: { ...state.webTabs, activeId: id, showing: true } }
            : state
        )
      },
      showProjects: () => {
        set((state) =>
          state.webTabs.showing ? { webTabs: { ...state.webTabs, showing: false } } : state
        )
      },
      hydrate: (
        saved,
        conversationIds,
        projectIds,
        unreadByConversation = {},
        conversationsByProject = {},
        pendingByConversation = {}
      ) => {
        const repaired = reconcileWorkspace(
          saved,
          conversationIds,
          projectIds,
          conversationsByProject
        )
        set({
          ...repaired,
          hydrated: true,
          // Restored sessions start out of plan mode, and the caller seeds the
          // ones the runtime says are in it. Carrying a stale map through a
          // second hydrate would claim a mode nothing had asked for.
          planning: {},
          /*
           * Seeded with what happened while the app was closed.
           *
           * Most fields start empty on purpose — they describe a live agent, and
           * nothing is live yet. Unread was the first exception, because it
           * describes the *log*, which outlived the process, and starting it at
           * zero is what used to make every relaunch claim nothing happened.
           *
           * **An outstanding decision is the same kind of fact**, and leaving it
           * out was the other half of "the flag does not always show". A pending
           * approval is a row in the store with no outcome, so it survives a
           * relaunch and the transcript draws its card the moment the
           * conversation is mounted — while the tab, folding only events pushed
           * since launch, went on saying idle. The two now agree, which is the
           * rule the mark exists to keep.
           */
          pulses: Object.fromEntries(
            conversationIds.map((id) => [
              id,
              {
                ...EMPTY_PULSE,
                unread: unreadByConversation[id] ?? 0,
                approvalIds: [...(pendingByConversation[id]?.approvalIds ?? [])],
                questionIds: [...(pendingByConversation[id]?.questionIds ?? [])],
              },
            ])
          ),
        })
      },
      /*
       * The tab actions take **project** ids now, and `clearUnread` no longer
       * rides along with them.
       *
       * Unread is a property of a conversation, and a tab is a project — which
       * may hold several. Clearing on tab activation would have marked every
       * conversation in a project read the moment one of them was shown, and
       * clearing "the project's unread" is not a thing that exists. The caller
       * clears the conversation it actually put on screen.
       *
       * The layout functions underneath are unchanged: they were always generic
       * over an opaque tab id, which is the reason this re-key is a change of
       * what goes in rather than a rewrite of the algebra.
       */
      openProject: (projectId, paneId) => {
        if (get().detached[projectId] !== undefined) {
          get().showProjects()
          void window.chorus.focusProjectWindow({ projectId })
          return
        }
        update((current) =>
          openSession(
            {
              ...current,
              webTabs: current.webTabs.showing
                ? { ...current.webTabs, showing: false }
                : current.webTabs,
            },
            projectId,
            paneId
          )
        )
      },
      activateTab: (paneId, projectId) => {
        update((current) =>
          activateTab(
            {
              ...current,
              webTabs: current.webTabs.showing
                ? { ...current.webTabs, showing: false }
                : current.webTabs,
            },
            paneId,
            projectId
          )
        )
      },
      clearConversationUnread: (conversationId) => {
        clearUnread(conversationId)
      },
      seedPendingDecisions: (conversationId, pending) => {
        set((state) => {
          const current = state.pulses[conversationId] ?? EMPTY_PULSE
          return {
            pulses: {
              ...state.pulses,
              [conversationId]: {
                ...current,
                approvalIds: [...pending.approvalIds],
                questionIds: [...pending.questionIds],
              },
            },
          }
        })
      },
      /*
       * Reveal, rather than a pointer write.
       *
       * This used to set `activeConversation[projectId]` — one conversation per
       * project, which stopped being expressible the moment a project's column
       * could hold two groups. The group that already holds the conversation
       * owns the answer now, so this finds it, makes it that group's active tab
       * and focuses the group. A conversation in no group is left alone: only
       * `reconcileConversationGroups` places conversations, because only it knows
       * which are live.
       */
      showConversation: (projectId, conversationId) => {
        set((state) => ({
          webTabs: state.webTabs.showing ? { ...state.webTabs, showing: false } : state.webTabs,
          conversationGroups: editArrangement(state, projectId, (arrangement) => {
            /*
             * Reveal, rather than a pointer write. This used to set
             * `activeConversation[projectId]` — one conversation per project,
             * which stopped being expressible the moment a project's column
             * became a tree. The group holding it owns the answer now.
             */
            const found = tabLocation(arrangement, conversationId)
            if (found === null) return arrangement
            return activateTab(focusPane(arrangement, found.paneId), found.paneId, conversationId)
          }),
        }))
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
      placeSession: (conversationId, targetPaneId, slotBefore) => {
        update((current) => placeSession(current, conversationId, targetPaneId, slotBefore))
        clearUnread(conversationId)
      },
      splitWithSession: (conversationId, targetPaneId, direction) => {
        update((current) => splitWithSession(current, conversationId, targetPaneId, direction))
        clearUnread(conversationId)
      },
      setPlanning: (conversationId, planning) => {
        set((state) =>
          state.planning[conversationId] === planning
            ? state
            : { planning: { ...state.planning, [conversationId]: planning } }
        )
      },
      markProjectStarted: (projectId) => {
        set((state) =>
          state.startedProjects[projectId] === true
            ? state
            : { startedProjects: { ...state.startedProjects, [projectId]: true } }
        )
      },
      markDetached: (projectId, slot) => {
        set((state) => ({ detached: { ...state.detached, [projectId]: slot } }))
      },
      clearDetached: (projectId) => {
        set((state) =>
          state.detached[projectId] === undefined
            ? state
            : { detached: without(state.detached, projectId) }
        )
      },
      setDetached: (detached) => {
        set({ detached })
      },
      setBranchSizes: (path, sizes) => {
        update((current) => setBranchSizes(current, path, sizes))
      },
      equalizeBranch: (path) => {
        update((current) => equalizeBranch(current, path))
      },
      /** Closes a project's tab everywhere. Call when its last conversation has gone. */
      removeProject: (projectId) => {
        update((current) => {
          let next = current
          for (const paneId of leafPaneIds(next.layout)) {
            next = closeTab(next, paneId, projectId)
          }
          return next
        })
      },
      removeSession: (conversationId) => {
        set((state) => {
          /*
           * **Its tab is in the project's tree, not in a pane.**
           *
           * This used to call `closeTab` on the pane holding it, which was right
           * while a pane tab *was* a conversation. Since the re-key a pane tab is
           * a project, so the lookup found nothing and the conversation's tab was
           * simply left behind: ending the last conversation in a group left an
           * empty bordered box with a `+` in it, and ending one in a split left a
           * dead half that never collapsed.
           *
           * Going through `closeTab` on the *arrangement* is what fixes both,
           * because that is the same function the pane tree uses — an emptied
           * leaf is pruned and its branch merged by `normalizeTree`, so the
           * surviving group takes the space with no merge logic written here.
           */
          const groups: Record<string, ConversationArrangement> = {}
          for (const [projectId, arrangement] of Object.entries(state.conversationGroups)) {
            const found = tabLocation(arrangement, conversationId)
            const pruned =
              found === null ? arrangement : closeTab(arrangement, found.paneId, conversationId)
            /*
             * A project left with no conversations loses its entry entirely
             * rather than keeping one empty group. Absent is what `EditorPane`
             * reads to draw the "no conversations" state, and it is what
             * `reconcileConversationGroups` would have produced anyway.
             */
            const empty = Object.values(pruned.panes).every((pane) => pane.tabs.length === 0)
            if (!empty) groups[projectId] = pruned
          }
          /*
           * Its panel's visibility goes too. A conversation that ends and is
           * later replaced by one that reuses nothing should not inherit a panel
           * someone opened for the old one.
           */
          return {
            conversationGroups: groups,
            pulses: without(state.pulses, conversationId),
            planning: without(state.planning, conversationId),
            terminals: without(state.terminals, conversationId),
          }
        })
      },
      toggleGlobalTerminal: () => {
        set((state) => editGlobal(state, (panel) => ({ ...panel, open: !panel.open })))
      },
      setGlobalTerminalOpen: (open) => {
        set((state) => editGlobal(state, (panel) => ({ ...panel, open })))
      },
      setGlobalTerminalHeight: (height) => {
        set((state) => editGlobal(state, (panel) => ({ ...panel, height })))
      },
      toggleSessionTerminal: (conversationId) => {
        set((state) =>
          editSession(state, conversationId, (panel) => ({ ...panel, open: !panel.open }))
        )
      },
      setSessionTerminalHeight: (conversationId, height) => {
        set((state) => editSession(state, conversationId, (panel) => ({ ...panel, height })))
      },
      addGlobalTerminal: () => {
        set((state) => editGlobal(state, addTab))
      },
      addSessionTerminal: (conversationId) => {
        set((state) => editSession(state, conversationId, addTab))
      },
      removeGlobalTerminalTab: (id) => {
        set((state) => editGlobal(state, (panel) => removeTab(panel, id)))
      },
      removeSessionTerminalTab: (conversationId, id) => {
        set((state) => editSession(state, conversationId, (panel) => removeTab(panel, id)))
      },
      activateGlobalTerminal: (id) => {
        set((state) => editGlobal(state, (panel) => activateTerminalTab(panel, id)))
      },
      activateSessionTerminal: (conversationId, id) => {
        set((state) =>
          editSession(state, conversationId, (panel) => activateTerminalTab(panel, id))
        )
      },
      setSidebarHidden: (sidebarHidden) => {
        set({ sidebarHidden })
      },
      setSidebarWidth: (width) => {
        set({ sidebarWidth: clampSidebarWidth(width) })
      },
      showConversationIn: (projectId, groupId, conversationId) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            activateTab(focusPane(arrangement, groupId), groupId, conversationId)
          ),
        }))
        clearUnread(conversationId)
      },
      adoptConversation: (projectId, conversationId) => {
        set((state) => {
          const current = state.conversationGroups[projectId]
          if (current !== undefined && tabLocation(current, conversationId) !== null) return {}
          return {
            conversationGroups: {
              ...state.conversationGroups,
              [projectId]: openBox(current ?? EMPTY_ARRANGEMENT, conversationId, newGroupId()),
            },
          }
        })
      },
      replaceConversation: (projectId, previousId, nextId) => {
        const current = get().conversationGroups[projectId]
        if (current === undefined || tabLocation(current, previousId) === null) return false
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            replaceSession(arrangement, previousId, nextId)
          ),
        }))
        return true
      },
      focusConversationGroup: (projectId, groupId) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            focusPane(arrangement, groupId)
          ),
        }))
      },
      setConversationSizes: (projectId, path, sizes) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            setBranchSizes(arrangement, path, sizes)
          ),
        }))
      },
      equalizeConversationBranch: (projectId, path) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            equalizeBranch(arrangement, path)
          ),
        }))
      },
      setEditorWidthFraction: (projectId, value) => {
        const fraction = clampEditorWidthFraction(value)
        if (fraction === undefined || get().editorWidthFractions[projectId] === fraction) return
        set((state) => ({
          editorWidthFractions: { ...state.editorWidthFractions, [projectId]: fraction },
        }))
      },
      setConsoleWidth: (projectId, value) => {
        const width = clampConsoleWidth(value)
        if (get().consoleWidths[projectId] === width) return
        set((state) => ({ consoleWidths: { ...state.consoleWidths, [projectId]: width } }))
      },
      setDevtoolsWidth: (projectId, value) => {
        set((state) => {
          const current = state.devtoolsPanels[projectId] ?? DEFAULT_DEVTOOLS
          const width = clampDevtoolsWidth(value)
          if (current.width === width) return state
          return {
            devtoolsPanels: { ...state.devtoolsPanels, [projectId]: { ...current, width } },
          }
        })
      },
      setDevtoolsCollapsed: (projectId, collapsed) => {
        set((state) => {
          const current = state.devtoolsPanels[projectId] ?? DEFAULT_DEVTOOLS
          if (current.collapsed === collapsed) return state
          return {
            devtoolsPanels: { ...state.devtoolsPanels, [projectId]: { ...current, collapsed } },
          }
        })
      },
      setTrafficWidth: (projectId, width) => {
        set((state) => {
          const current = state.trafficPanels[projectId] ?? CLOSED_TRAFFIC
          const nextWidth = clampTrafficWidth(width)
          if (nextWidth === current.width) return state
          return {
            trafficPanels: {
              ...state.trafficPanels,
              [projectId]: { ...current, width: nextWidth, widthCustomized: true },
            },
          }
        })
      },
      setGitWidth: (projectId, value) => {
        set((state) => {
          const current = state.gitPanels[projectId] ?? DEFAULT_GIT
          const width = clampGitWidth(value)
          if (current.width === width) return state
          return {
            gitPanels: { ...state.gitPanels, [projectId]: { ...current, width } },
          }
        })
      },
      setGitCollapsed: (projectId, collapsed) => {
        set((state) => {
          const current = state.gitPanels[projectId] ?? DEFAULT_GIT
          if (current.collapsed === collapsed) return state
          return {
            gitPanels: { ...state.gitPanels, [projectId]: { ...current, collapsed } },
          }
        })
      },
      setTrafficHiddenPathPrefix: (projectId, hiddenPathPrefix) => {
        set((state) => {
          const current = state.trafficPanels[projectId] ?? CLOSED_TRAFFIC
          if ((current.hiddenPathPrefix ?? '') === hiddenPathPrefix) return state
          return {
            trafficPanels: {
              ...state.trafficPanels,
              [projectId]: { ...current, hiddenPathPrefix },
            },
          }
        })
      },
      setProjectTerminalWidth: (projectId, width) => {
        set((state) => {
          const current = state.projectTerminals[projectId] ?? DEFAULT_PROJECT_TERMINAL
          return {
            projectTerminals: {
              ...state.projectTerminals,
              [projectId]: { ...current, width: clampProjectTerminalWidth(width) },
            },
          }
        })
      },
      setTrafficCollapsed: (projectId, collapsed) => {
        set((state) => {
          const current = state.trafficPanels[projectId] ?? CLOSED_TRAFFIC
          return {
            trafficPanels: { ...state.trafficPanels, [projectId]: { ...current, collapsed } },
          }
        })
      },
      setProjectTerminalCollapsed: (projectId, collapsed) => {
        set((state) => {
          const current = state.projectTerminals[projectId] ?? DEFAULT_PROJECT_TERMINAL
          return {
            projectTerminals: { ...state.projectTerminals, [projectId]: { ...current, collapsed } },
          }
        })
      },
      setBrowserCollapsed: (projectId, collapsed) => {
        set((state) => ({
          collapsedBrowsers: { ...state.collapsedBrowsers, [projectId]: collapsed },
        }))
      },
      setWebsiteCollapsed: (projectId, collapsed) => {
        set((state) => ({
          collapsedWebsites: { ...state.collapsedWebsites, [projectId]: collapsed },
        }))
      },
      addProjectShell: (projectId) => {
        const id = newTerminalId()
        set((state) => {
          const current = state.projectTerminals[projectId] ?? DEFAULT_PROJECT_TERMINAL
          const shells = [...current.shells, { id }]
          const width = Math.max(
            clampProjectTerminalWidth(current.width),
            projectTerminalMinimum(shells.length)
          )
          return {
            projectTerminals: {
              ...state.projectTerminals,
              [projectId]: { ...current, width, shells },
            },
          }
        })
        return id
      },
      removeProjectShell: (projectId, id) => {
        set((state) => {
          const current = state.projectTerminals[projectId]
          if (current === undefined) return state
          const shells = current.shells.filter((shell) => shell.id !== id)
          if (shells.length === 0 || shells.length === current.shells.length) return state
          return {
            projectTerminals: { ...state.projectTerminals, [projectId]: { ...current, shells } },
          }
        })
      },
      setRowScroll: (projectId, left) => {
        set((state) =>
          !isRowScroll(left) || state.rowScroll[projectId] === left
            ? state
            : { rowScroll: { ...state.rowScroll, [projectId]: left } }
        )
      },
      moveConversationBox: (projectId, boxId, targetBoxId, direction) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            moveBox(arrangement, boxId, targetBoxId, direction)
          ),
        }))
      },
      setConversationWidths: (projectId, widths) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            withColumnWidths(arrangement, widths)
          ),
        }))
      },
      resetProjectWidths: (projectId) => {
        set((state) => {
          const traffic = state.trafficPanels[projectId] ?? CLOSED_TRAFFIC
          const terminal = state.projectTerminals[projectId] ?? DEFAULT_PROJECT_TERMINAL
          const devtools = state.devtoolsPanels[projectId] ?? DEFAULT_DEVTOOLS
          const git = state.gitPanels[projectId] ?? DEFAULT_GIT
          return {
            conversationGroups: editArrangement(state, projectId, resetBoxes),
            editorWidthFractions: Object.fromEntries(
              Object.entries(state.editorWidthFractions).filter(([id]) => id !== projectId)
            ),
            consoleWidths: Object.fromEntries(
              Object.entries(state.consoleWidths).filter(([id]) => id !== projectId)
            ),
            trafficPanels: {
              ...state.trafficPanels,
              [projectId]: { ...traffic, width: TRAFFIC_WIDTH.default, widthCustomized: false },
            },
            devtoolsPanels: {
              ...state.devtoolsPanels,
              [projectId]: { ...devtools, width: DEVTOOLS_WIDTH.default },
            },
            gitPanels: {
              ...state.gitPanels,
              [projectId]: { ...git, width: GIT_WIDTH.default },
            },
            projectTerminals: {
              ...state.projectTerminals,
              [projectId]: { ...terminal, width: PROJECT_TERMINAL_WIDTH.default },
            },
          }
        })
      },
      ingestEvents: (events, reported) => {
        if (events.length === 0) return
        set((state) => {
          let changed = false
          const pulses = { ...state.pulses }
          /*
           * Once for the batch, not once per event. The answer is a property of
           * the layout, and a streaming turn delivers hundreds of events through
           * this loop between two renders.
           */
          const onScreen = onScreenConversations(state, reported)
          for (const event of events) {
            const visible = onScreen.has(event.conversationId)
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
      /*
       * Ignored when the agent is saying the same thing again, which it does
       * often: a thinking tick can arrive several times a second, and every one
       * of them would otherwise be a store write and a re-render of every pane.
       */
      /*
       * Kept per source. Two forwarders write to one channel — the embedded
       * workbench and the external VS Code bridge — and the external one reports
       * `unavailable` for every conversation on every runtime event when no VS
       * Code is connected. Folded together, that overwrote a live workbench
       * context within milliseconds of it arriving.
       *
       * A workbench `unavailable` clears the slot instead of filling it: it means
       * the surface has gone, and holding it would keep the external bridge
       * suppressed behind an editor that no longer exists.
       */
      ingestIdeContext: (push) => {
        set((state) => {
          const current = state.ideByConversation[push.conversationId] ?? {
            workbench: null,
            external: null,
          }
          const next =
            push.editor === 'workbench'
              ? { ...current, workbench: push.status === 'unavailable' ? null : push }
              : { ...current, external: push }
          if (next.workbench === current.workbench && next.external === current.external) {
            return state
          }
          return {
            ideByConversation: { ...state.ideByConversation, [push.conversationId]: next },
          }
        })
      },

      ingestActivity: (push) => {
        set((state) => {
          const current = state.pulses[push.conversationId]
          if (current === undefined) return state
          if (current.activityByActor[push.agentId] === push.activity) return state
          return {
            pulses: {
              ...state.pulses,
              [push.conversationId]: {
                ...current,
                activityByActor: {
                  ...current.activityByActor,
                  [push.agentId]: push.activity,
                },
              },
            },
          }
        })
      },
      ingestContextUsage: (usage) => {
        set((state) => {
          const current = state.pulses[usage.conversationId]
          if (current === undefined) return state
          const previous = current.contextByActor[usage.agentId]
          if (
            previous?.percent === usage.percentUsed &&
            previous.markPercent === usage.autoCompactPercent
          ) {
            return state
          }
          return {
            pulses: {
              ...state.pulses,
              [usage.conversationId]: {
                ...current,
                contextByActor: {
                  ...current.contextByActor,
                  [usage.agentId]: {
                    percent: usage.percentUsed,
                    markPercent: usage.autoCompactPercent,
                  },
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

/**
 * Every field of the snapshot, taken from the schema rather than typed out.
 *
 * Derived on purpose. `App`'s persistence subscription used to compare a
 * hand-written list of six fields, and `terminals` and `globalTerminal` were
 * added to the snapshot above without ever being added to that list — so a
 * change to either compared *equal*, the listener never fired, and nothing was
 * written. Opening a terminal panel and resizing it did not survive a relaunch.
 *
 * It looked like it worked because the two other write paths — `reorder` and
 * `commitLayout` — send the whole snapshot, so a terminal panel was saved as a
 * side effect of the next unrelated layout change. "Sometimes it persists" is
 * why nobody caught it.
 *
 * Reading the keys off the schema means the next field added cannot be
 * forgotten here, because there is nothing to remember.
 */
const SNAPSHOT_KEYS = Object.keys(WorkspaceSnapshot.shape) as (keyof WorkspaceSnapshot)[]

/**
 * Whether two snapshots hold the same thing, by reference, field by field.
 *
 * Reference equality is sound because every action builds a new object for the
 * field it touches — that is what the existing `layout` and `panes` comparisons
 * already relied on.
 */
export function sameWorkspaceSnapshot(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key) => left[key] === right[key])
}
