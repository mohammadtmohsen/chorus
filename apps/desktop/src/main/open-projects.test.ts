import { describe, expect, it } from 'vitest'
import { NO_WEB_TABS, SIDEBAR_WIDTH, TERMINAL_HEIGHT } from '../shared/workspace-layout.js'
import { parseOpenProjects } from './open-projects.js'

/*
 * Ported from `open-sessions.test.ts`, which went with the file it tested.
 *
 * Most of what is here was never about sessions. It is the guard on
 * `WorkspaceSnapshot` defaulting, and the failure it catches is silent and
 * total: make one field required and an envelope written before that field
 * existed stops parsing, so the whole list is dropped and every open
 * conversation is lost with no error anywhere. Only a fixture written before
 * the field catches it, so those fixtures are carried over exactly.
 *
 * One test did not survive, deliberately: the bare-array legacy shape. There is
 * no legacy reader — a v1 entry carries a `cwd` and no project id, and adopting
 * it would mean inventing a project per path at read time, which is the
 * migration Phase 2 decided not to build.
 */

const conversation = {
  conversationId: 'conversation-1',
  agents: ['codex'] as const,
  profileId: 'read-only',
  title: 'project',
  sessionRefs: { codex: 'thread-1' },
}

const PROJECT_ID = '0192f3c4-5d6e-7f80-9abc-def012345678'

/** The envelope, with whatever workspace a case is about. */
const file = (workspace: unknown, conversations: unknown[] = [conversation]) => ({
  version: 1,
  projects: [{ projectId: PROJECT_ID, conversations }],
  workspace,
})

const paneLayout = {
  layout: { kind: 'leaf' as const, paneId: 'pane-1' },
  panes: {
    'pane-1': { id: 'pane-1', tabs: ['conversation-1'], activeTabId: 'conversation-1' },
  },
  focusedPaneId: 'pane-1',
}

describe('open project persistence', () => {
  it('reads the envelope and defaults everything added since', () => {
    const workspace = { ...paneLayout, sidebarHidden: true }
    expect(parseOpenProjects(file(workspace))).toEqual({
      projects: [
        {
          projectId: PROJECT_ID,
          conversations: [{ ...conversation, lastSeenSeq: 0, draft: '' }],
        },
      ],
      workspace: {
        ...workspace,
        sidebarWidth: SIDEBAR_WIDTH.default,
        terminals: {},
        /*
         * The Phase 9 slice of this list, and the reason it is spelled out
         * rather than spread from a helper: this test's whole job is to fail
         * when the schema gains or loses a field, so each one is named here on
         * purpose. `changes` left with the Changes panel.
         */
        conversationGroups: {},
        globalTerminal: { open: false, height: TERMINAL_HEIGHT.default, tabs: [], activeId: null },
        trafficPanels: {},
        devtoolsPanels: {},
        projectTerminals: {},
        collapsedBrowsers: {},
        collapsedWebsites: {},
        rowScroll: {},
        editorWidthFractions: {},
        consoleWidths: {},
        webTabs: NO_WEB_TABS,
      },
    })
  })

  it('keeps every conversation in a snapshot written before web tabs existed', () => {
    const conversations = [
      conversation,
      { ...conversation, conversationId: 'conversation-2', title: 'second' },
    ]
    const parsed = parseOpenProjects(
      file(
        {
          ...paneLayout,
          conversationGroups: {},
          projectTerminals: {},
          rowScroll: { 'conversation-1': 320 },
        },
        conversations
      )
    )
    expect(parsed.projects[0]?.conversations.map((item) => item.conversationId)).toEqual([
      'conversation-1',
      'conversation-2',
    ])
    expect(parsed.workspace?.panes).toEqual(paneLayout.panes)
    expect(parsed.workspace?.rowScroll).toEqual({ 'conversation-1': 320 })
    expect(parsed.workspace?.webTabs).toEqual(NO_WEB_TABS)
    expect(parsed.workspace?.editorWidthFractions).toEqual({})
  })

  it('keeps a web roster intact and leaves invalid ids for renderer repair', () => {
    const webTabs = {
      tabs: [{ id: 'web-1' }, { id: '' }, { id: 'web-1' }, { id: 'bad/id' }],
      activeId: 'missing',
      showing: true,
    }
    const parsed = parseOpenProjects(file({ ...paneLayout, webTabs }))
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
    expect(parsed.workspace?.webTabs).toEqual(webTabs)
  })

  it('keeps every conversation when web tabs contain fields from a newer snapshot', () => {
    const conversations = [
      conversation,
      { ...conversation, conversationId: 'conversation-2', title: 'second' },
    ]
    const parsed = parseOpenProjects(
      file(
        {
          ...paneLayout,
          webTabs: {
            tabs: [{ id: 'web-1', pinned: true }],
            activeId: 'web-1',
            showing: true,
            group: 'saved',
          },
        },
        conversations
      )
    )
    expect(parsed.projects[0]?.conversations.map((item) => item.conversationId)).toEqual([
      'conversation-1',
      'conversation-2',
    ])
    expect(parsed.workspace?.panes).toEqual(paneLayout.panes)
    expect(parsed.workspace?.webTabs).toEqual({
      tabs: [{ id: 'web-1' }],
      activeId: 'web-1',
      showing: true,
    })
  })

  it('still restores the conversations from a workspace written before the run terminal pane', () => {
    const parsed = parseOpenProjects(
      file({
        ...paneLayout,
        sidebarHidden: false,
        trafficPanels: { a: { open: true, width: 960 } },
        rowScroll: { a: 320 },
      })
    )
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
    expect(parsed.workspace?.projectTerminals).toEqual({})
    expect(parsed.workspace?.trafficPanels).toEqual({ a: { open: true, width: 960 } })
    expect(parsed.workspace?.rowScroll).toEqual({ a: 320 })
  })

  it('keeps the conversations when a pane predates shells or holds a broken roster', () => {
    const parsed = parseOpenProjects(
      file({
        ...paneLayout,
        projectTerminals: {
          a: { width: 700 },
          b: { width: 700, shells: [] },
          c: { width: 700, shells: [{ id: '' }, { id: 's2' }, { id: 's2' }] },
        },
      })
    )
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
    expect(parsed.workspace?.projectTerminals).toEqual({
      a: { width: 700, shells: [{ id: 'main' }] },
      b: { width: 700, shells: [] },
      c: { width: 700, shells: [{ id: '' }, { id: 's2' }, { id: 's2' }] },
    })
  })

  /*
   * The conversation is recorded with no directory at all, which is the shape
   * change this file exists for. A `cwd` here would be a second copy of a fact
   * the registry owns, and the two would part company the first time a project
   * was relocated.
   */
  it('records no directory anywhere', () => {
    const parsed = parseOpenProjects(file(null))
    expect(parsed.projects[0]?.conversations[0]).not.toHaveProperty('cwd')
    expect(JSON.stringify(parsed)).not.toContain('/tmp/project')
  })

  it('still restores the conversations from a workspace written before terminals existed', () => {
    const parsed = parseOpenProjects(
      file({ ...paneLayout, sidebarHidden: false, sidebarWidth: 400 })
    )
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
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
   * The same guard one field later. Asserted narrowly on purpose: this applies
   * **schema defaults only** and hands the workspace back untouched. The backfill
   * — an open panel with no tabs getting one — happens in the renderer's
   * `normalizeTerminalPanel`, and asking for it here would assert a behaviour
   * main does not have.
   */
  it('still restores the conversations from a workspace written before the roster existed', () => {
    const parsed = parseOpenProjects(
      file({
        ...paneLayout,
        sidebarHidden: false,
        sidebarWidth: 248,
        terminals: { 'conversation-1': { open: true, height: 310 } },
        globalTerminal: { open: true, height: 180 },
      })
    )
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
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
   * rejection costs the conversations, not the roster. Duplicates, blanks and a
   * dangling `activeId` all parse, and the renderer repairs them.
   */
  it('parses a roster it will have to repair rather than refusing it', () => {
    const parsed = parseOpenProjects(
      file({
        ...paneLayout,
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
      })
    )
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
    expect(parsed.workspace?.terminals['conversation-1']?.tabs).toHaveLength(3)
  })

  it('keeps a stored roster intact when there is nothing to repair', () => {
    const parsed = parseOpenProjects(
      file({
        ...paneLayout,
        sidebarHidden: false,
        sidebarWidth: 248,
        terminals: {},
        globalTerminal: {
          open: true,
          height: 300,
          tabs: [{ id: 'g1' }, { id: 'g2' }],
          activeId: 'g2',
        },
      })
    )
    expect(parsed.workspace?.globalTerminal).toEqual({
      open: true,
      height: 300,
      tabs: [{ id: 'g1' }, { id: 'g2' }],
      activeId: 'g2',
    })
  })

  it('keeps each project’s row offset', () => {
    const parsed = parseOpenProjects(
      file({ ...paneLayout, sidebarHidden: false, rowScroll: { a: 640, b: 0 } })
    )
    expect(parsed.projects[0]?.conversations).toHaveLength(1)
    expect(parsed.workspace?.rowScroll).toEqual({ a: 640, b: 0 })
  })

  it('keeps a draft that was never sent', () => {
    // The one thing in this file that is the user's own writing rather than a
    // note about where they were, and the only part not recoverable by clicking.
    const parsed = parseOpenProjects(
      file(null, [{ ...conversation, draft: 'half a question about the' }])
    )
    expect(parsed.projects[0]?.conversations[0]?.draft).toBe('half a question about the')
  })

  it('keeps a read watermark that was written down', () => {
    const parsed = parseOpenProjects(file(null, [{ ...conversation, lastSeenSeq: 4_321 }]))
    expect(parsed.projects[0]?.conversations[0]?.lastSeenSeq).toBe(4_321)
  })

  it('refuses a watermark that could not have come from the log', () => {
    // Sequence numbers count up from zero. A negative one would make
    // `unreadSince` count the entire database as news.
    expect(parseOpenProjects(file(null, [{ ...conversation, lastSeenSeq: -1 }]))).toEqual({
      projects: [],
      workspace: null,
    })
  })

  it('refuses a project with no id rather than reopening a conversation nowhere', () => {
    expect(
      parseOpenProjects({
        version: 1,
        projects: [{ conversations: [conversation] }],
        workspace: null,
      })
    ).toEqual({ projects: [], workspace: null })
  })

  it('falls back safely when the note is malformed', () => {
    expect(parseOpenProjects({ version: 1, projects: 'nope' })).toEqual({
      projects: [],
      workspace: null,
    })
  })

  it('refuses the previous product’s file rather than half-reading it', () => {
    // A v2 `open-sessions.json` handed to this parser is not a downgrade path,
    // it is a different document. Returning nothing is the clean start; picking
    // fields out of it would be the migration this phase declined to write.
    expect(
      parseOpenProjects({
        version: 2,
        sessions: [{ ...conversation, cwd: '/tmp/project' }],
        workspace: null,
      })
    ).toEqual({ projects: [], workspace: null })
  })
})
