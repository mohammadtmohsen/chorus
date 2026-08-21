import { describe, expect, it } from 'vitest'
import { SIDEBAR_WIDTH, TERMINAL_HEIGHT } from '../shared/workspace-layout.js'
import { parseOpenSessions } from './open-sessions.js'

const session = {
  conversationId: 'conversation-1',
  agents: ['codex'] as const,
  cwd: '/tmp/project',
  profileId: 'read-only',
  title: 'project',
  sessionRefs: { codex: 'thread-1' },
}

describe('open session persistence', () => {
  it('migrates the original array-shaped file without losing sessions', () => {
    // `lastSeenSeq` is defaulted in rather than required, so a file written
    // before unread was persisted still opens — at zero unread rather than
    // refusing to parse and losing the whole list.
    expect(parseOpenSessions([session])).toEqual({
      sessions: [{ ...session, lastSeenSeq: 0, draft: '' }],
      workspace: null,
    })
  })

  it('reads the versioned workspace envelope', () => {
    const workspace = {
      layout: { kind: 'leaf' as const, paneId: 'pane-1' },
      panes: {
        'pane-1': {
          id: 'pane-1',
          tabs: ['conversation-1'],
          activeTabId: 'conversation-1',
        },
      },
      focusedPaneId: 'pane-1',
      sidebarHidden: true,
    }
    expect(parseOpenSessions({ version: 2, sessions: [session], workspace })).toEqual({
      sessions: [{ ...session, lastSeenSeq: 0, draft: '' }],
      // Everything added since is defaulted in, not required: this envelope was
      // written before the sidebar could be resized, before terminals existed
      // and before the Changes panel did, and it must still open — at the width
      // it always had rather than at zero, with no panels rather than none at
      // all.
      workspace: {
        ...workspace,
        sidebarWidth: SIDEBAR_WIDTH.default,
        terminals: {},
        changes: {},
        globalTerminal: {
          open: false,
          height: TERMINAL_HEIGHT.default,
          tabs: [],
          activeId: null,
        },
      },
    })
  })

  /*
   * The failure this guards is silent and total.
   *
   * `parseOpenSessions` falls through to a legacy bare-array parse when the v2
   * schema fails, and that fails too — so a required field added to
   * `WorkspaceSnapshot` returns `{ sessions: [] }` and **every open conversation
   * is lost**, not merely the layout, with no error anywhere. A fixture written
   * before terminals existed is the only thing that catches it.
   */
  it('still restores the sessions from a workspace written before terminals existed', () => {
    const beforeTerminals = {
      version: 2,
      sessions: [session],
      workspace: {
        layout: { kind: 'leaf' as const, paneId: 'pane-1' },
        panes: {
          'pane-1': { id: 'pane-1', tabs: ['conversation-1'], activeTabId: 'conversation-1' },
        },
        focusedPaneId: 'pane-1',
        sidebarHidden: false,
        sidebarWidth: 400,
      },
    }
    const parsed = parseOpenSessions(beforeTerminals)
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.workspace).not.toBeNull()
    expect(parsed.workspace?.sidebarWidth).toBe(400)
    expect(parsed.workspace?.globalTerminal).toEqual({
      open: false,
      height: TERMINAL_HEIGHT.default,
      tabs: [],
      activeId: null,
    })
    expect(parsed.workspace?.terminals).toEqual({})
  })

  /*
   * The same guard, one field later, and the failure is identical: making `tabs`
   * or `activeId` required sends this envelope down the legacy bare-array parse,
   * which also fails, and returns `{ sessions: [] }` — every open conversation
   * gone, once, silently.
   *
   * What it asserts is deliberately narrow. `parseOpenSessions` applies **schema
   * defaults only**; it hands back `current.data.workspace` untouched. The
   * backfill — an open panel with no tabs getting one — happens in the
   * renderer's `normalizeTerminalPanel`, and asking for it here would be
   * asserting a behaviour main does not have.
   */
  it('still restores the sessions from a workspace written before the roster existed', () => {
    const beforeRoster = {
      version: 2,
      sessions: [session],
      workspace: {
        layout: { kind: 'leaf' as const, paneId: 'pane-1' },
        panes: {
          'pane-1': { id: 'pane-1', tabs: ['conversation-1'], activeTabId: 'conversation-1' },
        },
        focusedPaneId: 'pane-1',
        sidebarHidden: false,
        sidebarWidth: 248,
        terminals: { 'conversation-1': { open: true, height: 310 } },
        globalTerminal: { open: true, height: 180 },
      },
    }
    const parsed = parseOpenSessions(beforeRoster)
    expect(parsed.sessions).toHaveLength(1)
    // The panel itself survives, at the height it was left.
    expect(parsed.workspace?.terminals['conversation-1']).toEqual({
      open: true,
      height: 310,
      tabs: [],
      activeId: null,
    })
    expect(parsed.workspace?.globalTerminal).toEqual({
      open: true,
      height: 180,
      tabs: [],
      activeId: null,
    })
  })

  /*
   * A hand-edited or corrupted roster must not be refused, for the reason above:
   * rejection here costs the conversations, not the roster. Duplicates, blanks
   * and a dangling `activeId` all parse, and the renderer repairs them.
   */
  it('parses a roster it will have to repair rather than refusing it', () => {
    const parsed = parseOpenSessions({
      version: 2,
      sessions: [session],
      workspace: {
        layout: { kind: 'leaf' as const, paneId: 'pane-1' },
        panes: {
          'pane-1': { id: 'pane-1', tabs: ['conversation-1'], activeTabId: 'conversation-1' },
        },
        focusedPaneId: 'pane-1',
        sidebarHidden: false,
        sidebarWidth: 248,
        terminals: {
          'conversation-1': {
            open: true,
            height: 212,
            tabs: [{ id: 'a' }, { id: 'a' }, { id: '' }],
            activeId: 'nothing-by-this-name',
          },
        },
        globalTerminal: { open: false, height: 212 },
      },
    })
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.workspace?.terminals['conversation-1']?.tabs).toHaveLength(3)
  })

  it('keeps a stored roster intact when there is nothing to repair', () => {
    const parsed = parseOpenSessions({
      version: 2,
      sessions: [session],
      workspace: {
        layout: { kind: 'leaf' as const, paneId: 'pane-1' },
        panes: {
          'pane-1': { id: 'pane-1', tabs: ['conversation-1'], activeTabId: 'conversation-1' },
        },
        focusedPaneId: 'pane-1',
        sidebarHidden: false,
        sidebarWidth: 248,
        terminals: {},
        globalTerminal: {
          open: true,
          height: 300,
          tabs: [{ id: 'g1' }, { id: 'g2' }],
          activeId: 'g2',
        },
      },
    })
    expect(parsed.workspace?.globalTerminal).toEqual({
      open: true,
      height: 300,
      tabs: [{ id: 'g1' }, { id: 'g2' }],
      activeId: 'g2',
    })
  })

  it('keeps a stored panel rather than defaulting over it', () => {
    const parsed = parseOpenSessions({
      version: 2,
      sessions: [session],
      workspace: {
        layout: { kind: 'leaf' as const, paneId: 'pane-1' },
        panes: {
          'pane-1': { id: 'pane-1', tabs: ['conversation-1'], activeTabId: 'conversation-1' },
        },
        focusedPaneId: 'pane-1',
        sidebarHidden: false,
        sidebarWidth: 336,
        terminals: { 'conversation-1': { open: true, height: 310 } },
        globalTerminal: { open: true, height: 180 },
      },
    })
    expect(parsed.workspace?.terminals['conversation-1']).toEqual({
      open: true,
      height: 310,
      tabs: [],
      activeId: null,
    })
    expect(parsed.workspace?.globalTerminal).toEqual({
      open: true,
      height: 180,
      tabs: [],
      activeId: null,
    })
  })

  it('keeps a draft that was never sent', () => {
    // The one thing in this file that is the user's own writing rather than a
    // note about where they were, and the only part not recoverable by clicking.
    const parsed = parseOpenSessions({
      version: 2,
      sessions: [{ ...session, draft: 'half a question about the' }],
      workspace: null,
    })
    expect(parsed.sessions[0]?.draft).toBe('half a question about the')
  })

  it('keeps a read watermark that was written down', () => {
    // The whole point of persisting it: after a relaunch the card can say what
    // was missed instead of starting over at nothing.
    const parsed = parseOpenSessions({
      version: 2,
      sessions: [{ ...session, lastSeenSeq: 4_321 }],
      workspace: null,
    })
    expect(parsed.sessions[0]?.lastSeenSeq).toBe(4_321)
  })

  it('refuses a watermark that could not have come from the log', () => {
    // Sequence numbers count up from zero. A negative one would make
    // `unreadSince` count the entire database as news.
    const parsed = parseOpenSessions({
      version: 2,
      sessions: [{ ...session, lastSeenSeq: -1 }],
      workspace: null,
    })
    expect(parsed.sessions).toEqual([])
  })

  it('falls back safely when the note is malformed', () => {
    expect(parseOpenSessions({ version: 2, sessions: 'nope' })).toEqual({
      sessions: [],
      workspace: null,
    })
  })
})
