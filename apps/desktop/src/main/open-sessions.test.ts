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
    expect(parseOpenSessions([session])).toEqual({ sessions: [session], workspace: null })
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
      sessions: [session],
      // The width is defaulted in, not required: this envelope was written
      // before the sidebar could be resized, and it must still open — at the
      // width it always had rather than at zero.
      workspace: { ...workspace, sidebarWidth: SIDEBAR_WIDTH.default },
    })
  })

  it('falls back safely when the note is malformed', () => {
    expect(parseOpenSessions({ version: 2, sessions: 'nope' })).toEqual({
      sessions: [],
      workspace: null,
    })
  })
})
