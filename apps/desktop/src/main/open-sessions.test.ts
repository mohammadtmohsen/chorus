import { describe, expect, it } from 'vitest'
import { SIDEBAR_WIDTH } from '../shared/workspace-layout.js'
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
      // The width is defaulted in, not required: this envelope was written
      // before the sidebar could be resized, and it must still open — at the
      // width it always had rather than at zero.
      workspace: { ...workspace, sidebarWidth: SIDEBAR_WIDTH.default },
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
