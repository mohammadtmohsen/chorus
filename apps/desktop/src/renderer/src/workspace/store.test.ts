import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../../shared/ipc.js'
import {
  CLOSED_TERMINAL_PANEL,
  WorkspaceSnapshot,
  type TerminalPanelState,
} from '../../../shared/workspace-layout.js'
import { EMPTY_WORKSPACE } from './layout.js'
import {
  reducePulse,
  sameWorkspaceSnapshot,
  useWorkspaceStore,
  type SessionPulse,
} from './store.js'

const PULSE: SessionPulse = {
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
  activityByActor: {},
  failed: false,
}

function event(type: string, payload: Record<string, unknown> = {}): TranscriptEvent {
  return {
    seq: 1,
    id: 'e1',
    conversationId: 'c1',
    actor: 'claude',
    type,
    payload,
    createdAt: 1,
  }
}

describe('reducePulse', () => {
  /*
   * The one real hazard in carrying context fill on the pulse.
   *
   * Nothing in the log reports it — it arrives on its own push channel — so a
   * reducer that rebuilds the pulse from an event must copy it forward. Rebuilt
   * without it, every message the agent sent would silently reset the figure to
   * empty and the sidebar would flicker back to showing nothing.
   */
  it('does not let a logged event erase pushed context fill', () => {
    const withContext: SessionPulse = { ...PULSE, contextByActor: { claude: 72 } }
    const next = reducePulse(withContext, event('agent.message.completed', { text: 'hi' }), true)
    expect(next.contextByActor).toEqual({ claude: 72 })
  })

  /* The same hazard, for the same reason: nothing in the log reports it. */
  it('does not let a logged event erase pushed background tasks', () => {
    const withTasks: SessionPulse = {
      ...PULSE,
      tasksByActor: { claude: [{ id: 't1', kind: 'shell', description: 'sleep 60' }] },
    }
    const next = reducePulse(withTasks, event('agent.message.completed', { text: 'hi' }), true)
    expect(next.tasksByActor).toEqual({
      claude: [{ id: 't1', kind: 'shell', description: 'sleep 60' }],
    })
  })

  it('still folds what the log does report', () => {
    const next = reducePulse(PULSE, event('turn.started', { turnRef: 't1' }), true)
    expect(next.working).toContain('claude')
  })

  it('counts an unread only while the conversation is off screen', () => {
    const seen = reducePulse(PULSE, event('agent.message.completed', { text: 'a' }), true)
    const unseen = reducePulse(PULSE, event('agent.message.completed', { text: 'a' }), false)
    expect(seen.unread).toBe(0)
    expect(unseen.unread).toBe(1)
  })

  /*
   * The fourth row state, and the only one folded from a payload field rather
   * than counted. A row that could not tell a failed turn from an idle session
   * would leave the worst outcome looking like the ordinary one.
   */
  it('marks a session failed when a turn ends that way', () => {
    const next = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    expect(next.failed).toBe(true)
  })

  it('does not call a stopped turn a failure', () => {
    const next = reducePulse(PULSE, event('turn.completed', { status: 'interrupted' }), true)
    expect(next.failed).toBe(false)
  })

  it('clears a failure when the next turn starts', () => {
    const failed = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    const next = reducePulse(failed, { ...event('turn.started'), seq: 2 }, true)
    expect(next.failed).toBe(false)
  })

  /*
   * A conversation has two agents in it, and they finish separately.
   *
   * This was an assignment — `failed = status === 'failed'` — so the *last*
   * completion in a turn decided the flag for the whole session. Codex failing
   * and Claude finishing normally a second later left a row reading idle, which
   * is the one case where the state matters most: the answer never came and
   * nothing on the rail said so. Only `turn.started` may clear it.
   */
  it('does not let one agent finishing erase another agent’s failure', () => {
    const failed = reducePulse(
      PULSE,
      { ...event('turn.completed', { status: 'failed' }), actor: 'codex' },
      true
    )
    expect(failed.failed).toBe(true)
    const alsoDone = reducePulse(
      failed,
      { ...event('turn.completed', { status: 'completed' }), actor: 'claude', seq: 2 },
      true
    )
    expect(alsoDone.failed).toBe(true)
  })

  it('does not let a stop after a failure erase it either', () => {
    const failed = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    const stopped = reducePulse(
      failed,
      { ...event('turn.completed', { status: 'interrupted' }), seq: 2 },
      true
    )
    expect(stopped.failed).toBe(true)
  })
})

describe('sameWorkspaceSnapshot', () => {
  /*
   * The bug this exists for, and it shipped.
   *
   * `App`'s persistence subscription compared six hand-written fields. When
   * terminals were added to the snapshot they were not added to that list, so a
   * change to a terminal panel compared *equal*, the debounced listener never
   * fired, and nothing reached disk. Opening a terminal and resizing it did not
   * survive a relaunch.
   *
   * It read as working because `reorder` and `commitLayout` both send the whole
   * snapshot, so a terminal panel persisted as a side effect of the next
   * unrelated layout change. The failure was "sometimes it saves", which is the
   * kind nobody files.
   */
  it('sees a terminal panel opening', () => {
    const opened: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      globalTerminal: { ...CLOSED_TERMINAL_PANEL, open: true },
    }
    expect(sameWorkspaceSnapshot(EMPTY_WORKSPACE, opened)).toBe(false)
  })

  it('sees a session terminal being resized', () => {
    const before: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      terminals: { 'conversation-1': { ...CLOSED_TERMINAL_PANEL, open: true } },
    }
    const after: WorkspaceSnapshot = {
      ...before,
      terminals: { 'conversation-1': { ...CLOSED_TERMINAL_PANEL, open: true, height: 310 } },
    }
    expect(sameWorkspaceSnapshot(before, after)).toBe(false)
  })

  it('still says nothing changed when nothing did', () => {
    expect(sameWorkspaceSnapshot(EMPTY_WORKSPACE, { ...EMPTY_WORKSPACE })).toBe(true)
  })

  /*
   * The guard that actually holds the line, rather than the two above.
   *
   * Cases for `terminals` and `globalTerminal` only prove today's bug is fixed;
   * they say nothing about the next field added to `WorkspaceSnapshot`, which is
   * exactly how this happened the first time. Walking the schema's own keys
   * means a field that the comparison does not reach fails here on the day it is
   * added, with no one having to remember this file exists.
   *
   * A distinct sentinel per key, so the assertion cannot pass because two fields
   * happened to hold the same value.
   */
  it('notices a change to any field the snapshot carries', () => {
    for (const key of Object.keys(WorkspaceSnapshot.shape)) {
      const changed = { ...EMPTY_WORKSPACE, [key]: { sentinel: key } }
      expect(
        sameWorkspaceSnapshot(EMPTY_WORKSPACE, changed),
        `${key} is not compared, so a change to it would never be persisted`
      ).toBe(false)
    }
  })
})

describe('the terminal roster, through the store', () => {
  const reset = (): void => {
    useWorkspaceStore.setState({ terminals: {}, globalTerminal: CLOSED_TERMINAL_PANEL })
  }
  const session = (): TerminalPanelState =>
    useWorkspaceStore.getState().terminals['c1'] ?? CLOSED_TERMINAL_PANEL
  const globalPanel = (): TerminalPanelState => useWorkspaceStore.getState().globalTerminal

  /*
   * The invariant nothing has to remember. `toggleSessionTerminal` only flips
   * `open`; the tab arrives because every write goes through
   * `normalizeTerminalPanel`. If these actions ever stop routing through it, an
   * open panel renders against `id: ''` and attaches to a shell that is not
   * there.
   */
  it('gives a panel its first terminal just by being opened', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    expect(session().open).toBe(true)
    expect(session().tabs).toHaveLength(1)
    expect(session().activeId).toBe(session().tabs[0]?.id)
  })

  it('does the same for the global panel', () => {
    reset()
    useWorkspaceStore.getState().toggleGlobalTerminal()
    expect(globalPanel().tabs).toHaveLength(1)
    expect(globalPanel().activeId).not.toBeNull()
  })

  it('appends a terminal and selects it', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    const first = session().activeId
    useWorkspaceStore.getState().addSessionTerminal('c1')
    expect(session().tabs).toHaveLength(2)
    expect(session().activeId).not.toBe(first)
    expect(session().activeId).toBe(session().tabs[1]?.id)
  })

  it('opens a hidden panel when a terminal is added to it', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    expect(session().open).toBe(true)
    expect(session().tabs).toHaveLength(1)
  })

  it('never mints the same id twice, even across panels', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addGlobalTerminal()
    const ids = [...session().tabs, ...globalPanel().tabs].map((tab) => tab.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('activates a tab it holds and ignores one it does not', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addSessionTerminal('c1')
    const first = session().tabs[0]?.id ?? ''
    useWorkspaceStore.getState().activateSessionTerminal('c1', first)
    expect(session().activeId).toBe(first)
    useWorkspaceStore.getState().activateSessionTerminal('c1', 'not-a-tab')
    expect(session().activeId).toBe(first)
  })

  /*
   * Closing the tab you are looking at lands on its neighbour, the same rule
   * `normalizeWorkspace` already applies to a pane's `activeTabId`. Falling back
   * to the first would jump you across the strip for no reason.
   */
  it('lands on the neighbour when the selected tab is removed', () => {
    reset()
    for (let n = 0; n < 3; n += 1) useWorkspaceStore.getState().addSessionTerminal('c1')
    const [a, b, c] = session().tabs.map((tab) => tab.id)
    useWorkspaceStore.getState().activateSessionTerminal('c1', b ?? '')
    useWorkspaceStore.getState().removeSessionTerminalTab('c1', b ?? '')
    expect(session().tabs.map((tab) => tab.id)).toEqual([a, c])
    expect(session().activeId).toBe(c)
  })

  it('leaves the selection alone when some other tab is removed', () => {
    reset()
    for (let n = 0; n < 3; n += 1) useWorkspaceStore.getState().addSessionTerminal('c1')
    const [a, , c] = session().tabs.map((tab) => tab.id)
    useWorkspaceStore.getState().activateSessionTerminal('c1', c ?? '')
    useWorkspaceStore.getState().removeSessionTerminalTab('c1', a ?? '')
    expect(session().activeId).toBe(c)
  })

  /*
   * The one that would otherwise be an infinite loop of terminals: removing the
   * last tab has to *close* the panel, because `normalizeTerminalPanel` mints a
   * replacement for any open panel with none. Killing your last terminal would
   * silently open a new one.
   */
  it('closes the panel when its last terminal goes, rather than minting another', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    const only = session().activeId ?? ''
    useWorkspaceStore.getState().removeSessionTerminalTab('c1', only)
    expect(session().open).toBe(false)
    expect(session().tabs).toEqual([])
    expect(session().activeId).toBeNull()
  })

  /*
   * Hiding a panel is not killing its shells — that distinction is what the whole
   * feature rests on — so the roster has to survive being out of sight.
   */
  it('keeps the roster when the panel is hidden', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addSessionTerminal('c1')
    const ids = session().tabs.map((tab) => tab.id)
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    expect(session().open).toBe(false)
    expect(session().tabs.map((tab) => tab.id)).toEqual(ids)
  })

  /* Two panels, no leakage: the global one is a separate field for this reason. */
  it('adds to one scope without touching the other', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    expect(globalPanel().tabs).toEqual([])
    useWorkspaceStore.getState().addGlobalTerminal()
    expect(session().tabs).toHaveLength(1)
    expect(globalPanel().tabs).toHaveLength(1)
  })
})
