import { describe, expect, it } from 'vitest'
import {
  BOX_WIDTH,
  CLOSED_TERMINAL_PANEL,
  PROJECT_TERMINAL_WIDTH,
  SIDEBAR_WIDTH,
  TERMINAL_HEIGHT,
  TRAFFIC_WIDTH,
  type ConversationArrangement,
  type TerminalPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  WorkspaceSnapshot,
} from '../../../shared/workspace-layout.js'
import {
  applyDetachedEntries,
  browserViewport,
  clampActivityBar,
  clampBoxWidth,
  clampEditorWidth,
  clampProjectTerminalWidth,
  clampSidebarWidth,
  clampTrafficWidth,
  CLOSED_TRAFFIC,
  closeTab,
  columnsOf,
  columnWidths,
  DEFAULT_PROJECT_TERMINAL,
  detachedSnapshot,
  detachTab,
  editorViewport,
  editorWidthIn,
  EMPTY_WORKSPACE,
  leafPaneIds,
  MAX_PANES,
  mergeSlice,
  moveBox,
  moveTab,
  newTerminalId,
  normalizeProjectShells,
  normalizeTerminalPanel,
  normalizeWorkspace,
  onScreenConversations,
  openBox,
  openSession,
  placeSession,
  projectTerminalMinimum,
  projectTerminalWidth,
  pushDivider,
  reconcileConversationGroups,
  reconcileWorkspace,
  reorderTab,
  replaceSession,
  resetBoxes,
  returnTab,
  ROW_EDGE_INSET,
  ROW_SCROLLBAR_STRIP,
  setBranchSizes,
  sliceOf,
  splitTab,
  splitWithSession,
  tabLocation,
  topRightPaneId,
  virtualIndex,
  withColumnWidths,
  withDetachedReturned,
  type MeasuredBox,
} from './layout.js'

function onePane(...tabs: string[]): WorkspaceSnapshot {
  return {
    ...EMPTY_WORKSPACE,
    layout: { kind: 'leaf', paneId: 'pane-1' },
    panes: { 'pane-1': { id: 'pane-1', tabs, activeTabId: tabs[0] ?? null } },
    focusedPaneId: 'pane-1',
    sidebarWidth: SIDEBAR_WIDTH.default,
  }
}

const leaf = (paneId: string): WorkspaceLayoutNode => ({ kind: 'leaf', paneId })

const row = (...ids: string[]): WorkspaceLayoutNode => ({
  kind: 'branch',
  orientation: 'row',
  children: ids.map(leaf),
  sizes: ids.map(() => 1),
})

const column = (...ids: string[]): WorkspaceLayoutNode => ({
  kind: 'branch',
  orientation: 'column',
  children: ids.map(leaf),
  sizes: ids.map(() => 1),
})

const box = (id: string, ...tabs: string[]): WorkspacePane => ({
  id,
  tabs: [...tabs],
  activeTabId: tabs[0] ?? null,
})

function arrangement(
  layout: WorkspaceLayoutNode | null,
  panes: readonly WorkspacePane[],
  focusedPaneId: string | null = panes[0]?.id ?? null
): ConversationArrangement {
  return {
    layout,
    panes: Object.fromEntries(panes.map((pane) => [pane.id, pane])),
    focusedPaneId,
  }
}

/** Same pane, but able to say which tab holds the caret. */
function withActive(tabs: string[], activeTabId: string | null): WorkspaceSnapshot {
  return {
    ...EMPTY_WORKSPACE,
    layout: { kind: 'leaf', paneId: 'pane-1' },
    panes: { 'pane-1': { id: 'pane-1', tabs, activeTabId } },
    focusedPaneId: 'pane-1',
    sidebarWidth: SIDEBAR_WIDTH.default,
  }
}

describe('web tab placement and coverage', () => {
  it('selects the top-right leaf through rows, columns and nested branches', () => {
    expect(topRightPaneId(null)).toBeNull()
    expect(topRightPaneId(leaf('single'))).toBe('single')
    expect(topRightPaneId(row('left', 'right'))).toBe('right')
    expect(topRightPaneId(column('top', 'bottom'))).toBe('top')
    expect(
      topRightPaneId({
        kind: 'branch',
        orientation: 'row',
        sizes: [1, 1],
        children: [
          leaf('left'),
          {
            kind: 'branch',
            orientation: 'column',
            sizes: [1, 1],
            children: [row('top-left', 'top-right'), leaf('bottom')],
          },
        ],
      })
    ).toBe('top-right')
  })

  it('keeps detached reports and excludes covered pane conversations', () => {
    const state: WorkspaceSnapshot = {
      ...onePane('project'),
      conversationGroups: { project: arrangement(leaf('group'), [box('group', 'conversation')]) },
      webTabs: { tabs: [{ id: 'web' }], activeId: 'web', showing: true },
    }
    expect([...onScreenConversations(state, ['detached'])]).toEqual(['detached'])
    expect([
      ...onScreenConversations({ ...state, webTabs: { ...state.webTabs, showing: false } }, [
        'detached',
      ]),
    ]).toEqual(['detached', 'conversation'])
  })
})

describe('workspace layout', () => {
  it('can have running conversations without a visible pane', () => {
    expect(closeTab(onePane('a'), 'pane-1', 'a')).toEqual(EMPTY_WORKSPACE)
  })

  /*
   * The two empties mean different things, and the difference is the whole
   * feature: no saved workspace is a file written by a version that had no
   * opinion about tabs, so everything opens; a saved empty workspace is a user
   * who closed every tab, and re-opening them would undo that on each launch.
   */
  it('opens everything only when no workspace was ever saved', () => {
    expect(reconcileWorkspace(null, ['a'], ['a'])).toMatchObject({
      focusedPaneId: 'pane-1',
      panes: { 'pane-1': { tabs: ['a'] } },
    })
    expect(reconcileWorkspace(EMPTY_WORKSPACE, ['a'], ['a'])).toEqual(EMPTY_WORKSPACE)
  })

  it('opens an existing conversation by focusing it instead of duplicating it', () => {
    const split = splitTab(onePane('a', 'b'), 'b', 'pane-1', 'right', 'pane-2')
    const reopened = openSession(split, 'b', 'pane-1')
    expect(tabLocation(reopened, 'b')).toEqual({ paneId: 'pane-2', index: 0 })
    expect(reopened.focusedPaneId).toBe('pane-2')
  })

  it('does not split a pane whose active session is its only tab', () => {
    const before = onePane('a')
    expect(splitTab(before, 'a', 'pane-1', 'right', 'pane-2')).toBe(before)
  })

  it('moves a tab into a new pane on split', () => {
    const result = splitTab(onePane('a', 'b'), 'b', 'pane-1', 'right', 'pane-2')
    expect(leafPaneIds(result.layout)).toEqual(['pane-1', 'pane-2'])
    expect(result.panes['pane-1']?.tabs).toEqual(['a'])
    expect(result.panes['pane-2']?.tabs).toEqual(['b'])
  })

  /*
   * All four, because the orientation and the child order are decided by two
   * separate expressions in `insertSplit` and only `right` was ever exercised.
   * A swapped pair there renders a plausible grid that splits the wrong way.
   */
  it('splits in all four directions, with the new pane on the side asked for', () => {
    const cases = [
      ['right', 'row', ['pane-1', 'pane-2']],
      ['left', 'row', ['pane-2', 'pane-1']],
      ['down', 'column', ['pane-1', 'pane-2']],
      ['up', 'column', ['pane-2', 'pane-1']],
    ] as const
    for (const [direction, orientation, order] of cases) {
      const result = splitTab(onePane('a', 'b'), 'b', 'pane-1', direction, 'pane-2')
      expect(result.layout).toMatchObject({ kind: 'branch', orientation })
      expect(leafPaneIds(result.layout)).toEqual(order)
      expect(result.focusedPaneId).toBe('pane-2')
    }
  })

  /*
   * The rule is "the tab that slid into that index", not "the previous tab" and
   * not most-recently-used. Both of those are what a reader expects, which is
   * why the real rule needs pinning down.
   */
  it('gives the caret to the tab that slid into the closed one’s index', () => {
    expect(closeTab(withActive(['a', 'b', 'c'], 'b'), 'pane-1', 'b').panes['pane-1']).toMatchObject(
      {
        tabs: ['a', 'c'],
        activeTabId: 'c',
      }
    )
    // Closing the last tab has nothing to its right, so the index clamps back.
    expect(closeTab(withActive(['a', 'b', 'c'], 'c'), 'pane-1', 'c').panes['pane-1']).toMatchObject(
      {
        tabs: ['a', 'b'],
        activeTabId: 'b',
      }
    )
    // Closing a background tab must not move the caret at all.
    expect(closeTab(withActive(['a', 'b', 'c'], 'a'), 'pane-1', 'b').panes['pane-1']).toMatchObject(
      {
        tabs: ['a', 'c'],
        activeTabId: 'a',
      }
    )
  })

  it('flattens same-orientation branches and scales their sizes', () => {
    const result = normalizeWorkspace({
      ...onePane('a'),
      layout: {
        kind: 'branch',
        orientation: 'row',
        sizes: [0.4, 0.6],
        children: [
          { kind: 'leaf', paneId: 'a' },
          {
            kind: 'branch',
            orientation: 'row',
            sizes: [0.25, 0.75],
            children: [
              { kind: 'leaf', paneId: 'b' },
              { kind: 'leaf', paneId: 'c' },
            ],
          },
        ],
      },
      panes: {
        a: { id: 'a', tabs: ['a'], activeTabId: 'a' },
        b: { id: 'b', tabs: ['b'], activeTabId: 'b' },
        c: { id: 'c', tabs: ['c'], activeTabId: 'c' },
      },
      focusedPaneId: 'c',
    })
    expect(result.layout).toMatchObject({ kind: 'branch', orientation: 'row' })
    if (result.layout?.kind !== 'branch') throw new Error('expected a branch')
    expect(result.layout.sizes[0]).toBeCloseTo(0.4)
    expect(result.layout.sizes[1]).toBeCloseTo(0.15)
    expect(result.layout.sizes[2]).toBeCloseTo(0.45)
  })

  it('moves a sole tab legally and removes its old pane', () => {
    const split = splitTab(onePane('a', 'b'), 'b', 'pane-1', 'right', 'pane-2')
    const moved = moveTab(split, 'a', 'pane-2', 1)
    expect(leafPaneIds(moved.layout)).toEqual(['pane-2'])
    expect(moved.panes['pane-2']?.tabs).toEqual(['b', 'a'])
  })

  it('uses gap indexes when reordering', () => {
    const result = reorderTab(onePane('a', 'b', 'c'), 'pane-1', 0, 3)
    expect(result.panes['pane-1']?.tabs).toEqual(['b', 'c', 'a'])
  })

  it('caps visible panes while allowing a move that replaces its source pane', () => {
    let workspace = onePane('a', 'b', 'c', 'd', 'e')
    for (const [id, direction, pane] of [
      ['b', 'right', 'pane-1'],
      ['c', 'down', 'pane-1'],
      ['d', 'down', 'pane-2'],
    ] as const) {
      workspace = splitTab(workspace, id, pane, direction)
    }
    expect(leafPaneIds(workspace.layout)).toHaveLength(MAX_PANES)
    expect(splitTab(workspace, 'e', 'pane-1', 'left')).toBe(workspace)
  })

  it('reconciles duplicates and unknown tabs without reopening closed sessions', () => {
    const result = reconcileWorkspace(
      {
        ...EMPTY_WORKSPACE,
        layout: {
          kind: 'branch',
          orientation: 'row',
          sizes: [1, 1],
          children: [
            { kind: 'leaf', paneId: 'left' },
            { kind: 'leaf', paneId: 'right' },
          ],
        },
        panes: {
          left: { id: 'left', tabs: ['a', 'gone'], activeTabId: 'gone' },
          right: { id: 'right', tabs: ['a'], activeTabId: 'a' },
        },
        focusedPaneId: 'right',
        sidebarHidden: true,
        sidebarWidth: SIDEBAR_WIDTH.default,
      },
      ['a', 'b'],
      ['a', 'b']
    )
    expect(Object.values(result.panes).flatMap((pane) => pane.tabs)).toEqual(['a'])
    expect(result.sidebarHidden).toBe(true)
  })

  it('opens legacy restored conversations when there is no saved workspace', () => {
    const result = reconcileWorkspace(null, ['a', 'b'], ['a', 'b'])
    expect(Object.values(result.panes).flatMap((pane) => pane.tabs)).toEqual(['a', 'b'])
  })

  /*
   * A persisted width is not trusted. It comes from a file the user can edit,
   * and it survives a window being resized much narrower — either of which can
   * hand back a sidebar too thin to read. Wide is allowed; there is no ceiling.
   */
  it('clamps the sidebar width, on the way in as well as during a drag', () => {
    expect(clampSidebarWidth(9_000)).toBe(9_000)
    expect(clampSidebarWidth(-40)).toBe(SIDEBAR_WIDTH.min)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default)
    // Rounded, not floored.
    expect(clampSidebarWidth(261.6)).toBe(262)
    expect(normalizeWorkspace({ ...onePane('a'), sidebarWidth: 9_000 }).sidebarWidth).toBe(9_000)
  })

  it('normalizes persisted branch sizes', () => {
    const workspace = splitTab(onePane('a', 'b'), 'b', 'pane-1', 'right', 'pane-2')
    const resized = setBranchSizes(workspace, [], [3, 1])
    expect(resized.layout).toMatchObject({ sizes: [0.75, 0.25] })
  })
})

describe('terminal panels across a restore', () => {
  const withPanels = (terminals: Record<string, TerminalPanelState>) => ({
    ...EMPTY_WORKSPACE,
    layout: { kind: 'leaf' as const, paneId: 'pane-1' },
    panes: { 'pane-1': { id: 'pane-1', tabs: ['a'], activeTabId: 'a' } },
    focusedPaneId: 'pane-1',
    terminals,
  })

  /** A panel literal with the roster fields filled in, so a fixture stays short. */
  const panel = (over: Partial<TerminalPanelState>): TerminalPanelState => ({
    ...CLOSED_TERMINAL_PANEL,
    ...over,
  })

  it('keeps a panel whose conversation is still open', () => {
    const restored = reconcileWorkspace(
      withPanels({ a: panel({ open: true, height: 300 }) }),
      ['a'],
      ['a']
    )
    expect(restored.terminals['a']?.open).toBe(true)
    expect(restored.terminals['a']?.height).toBe(300)
  })

  /*
   * Without this the map grows forever — every conversation ever ended leaves an
   * entry behind — and an id that came round again would inherit a panel someone
   * opened for something else.
   */
  it('drops a panel whose conversation is gone', () => {
    const restored = reconcileWorkspace(
      withPanels({
        a: panel({ open: true, height: 300 }),
        ghost: panel({ open: true, height: 300 }),
      }),
      ['a'],
      ['a']
    )
    expect(restored.terminals['ghost']).toBeUndefined()
    expect(restored.terminals['a']).toBeDefined()
  })

  /*
   * The global panel is its own field precisely so that pruning by conversation
   * cannot reach it. A keyed map would lose it the first time anything tidied up.
   */
  it('never prunes the global panel, whatever happens to conversations', () => {
    const saved = { ...withPanels({ ghost: panel({ open: true, height: 300 }) }) }
    const restored = reconcileWorkspace(
      {
        ...saved,
        globalTerminal: panel({ open: true, height: 200, tabs: [{ id: 'g1' }], activeId: 'g1' }),
      },
      [],
      []
    )
    expect(restored.globalTerminal).toEqual({
      open: true,
      height: 200,
      tabs: [{ id: 'g1' }],
      activeId: 'g1',
    })
  })

  it('clamps a stored height that could not be dragged to', () => {
    const restored = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      globalTerminal: panel({ open: true, height: 4 }),
    })
    expect(restored.globalTerminal.height).toBe(TERMINAL_HEIGHT.min)
  })

  it('survives a workspace that never had panels', () => {
    const restored = reconcileWorkspace(null, ['a'], ['a'])
    expect(restored.terminals).toEqual({})
    expect(restored.globalTerminal.open).toBe(false)
  })

  /*
   * Dropping a session from the rail into the workspace.
   *
   * These are the operations the drag lands on, and the invariant they exist to
   * hold is that a live session appears once — the reason splitting is not
   * "copy the tab into a new pane" anywhere in this file.
   */
  describe('placing a session that is not open', () => {
    it('inserts a closed session at the slot it was dropped on', () => {
      const placed = placeSession(onePane('a', 'b'), 'c', 'pane-1', 1)
      expect(placed.panes['pane-1']?.tabs).toEqual(['a', 'c', 'b'])
      expect(placed.panes['pane-1']?.activeTabId).toBe('c')
      expect(placed.focusedPaneId).toBe('pane-1')
    })

    it('moves an already-open session rather than duplicating it', () => {
      const split = splitTab(onePane('a', 'b'), 'b', 'pane-1', 'right')
      const moved = placeSession(split, 'b', 'pane-1', 0)
      expect(leafPaneIds(moved.layout)).toEqual(['pane-1'])
      expect(moved.panes['pane-1']?.tabs).toEqual(['b', 'a'])
      expect(tabLocation(moved, 'b')).toEqual({ paneId: 'pane-1', index: 0 })
    })

    it('splits into a new group for a closed session', () => {
      const split = splitWithSession(onePane('a'), 'b', 'pane-1', 'right')
      expect(leafPaneIds(split.layout)).toHaveLength(2)
      expect(split.panes['pane-1']?.tabs).toEqual(['a'])
      expect(split.panes[leafPaneIds(split.layout)[1] ?? '']?.tabs).toEqual(['b'])
    })

    /*
     * A one-tab pane cannot split *itself*, because the tab would only move and
     * normalisation would collapse the source back away. A closed session
     * dropped on that same pane is a different question and must be allowed.
     */
    it('lets a closed session split a pane holding a single tab', () => {
      const split = splitWithSession(onePane('a'), 'b', 'pane-1', 'down')
      expect(leafPaneIds(split.layout)).toHaveLength(2)
      expect(splitTab(onePane('a'), 'a', 'pane-1', 'down')).toEqual(onePane('a'))
    })

    it('refuses a fifth pane', () => {
      let workspace = onePane('a', 'b', 'c', 'd')
      workspace = splitWithSession(workspace, 'b', 'pane-1', 'right')
      workspace = splitWithSession(workspace, 'c', 'pane-1', 'down')
      workspace = splitWithSession(workspace, 'd', 'pane-1', 'up')
      expect(leafPaneIds(workspace.layout)).toHaveLength(MAX_PANES)
      const refused = splitWithSession(workspace, 'e', 'pane-1', 'right')
      expect(leafPaneIds(refused.layout)).toHaveLength(MAX_PANES)
      expect(tabLocation(refused, 'e')).toBeNull()
    })

    it('ignores a pane that is not there', () => {
      const workspace = onePane('a')
      expect(placeSession(workspace, 'b', 'pane-9', 0)).toBe(workspace)
      expect(splitWithSession(workspace, 'b', 'pane-9', 'right')).toBe(workspace)
    })
  })
})

describe('normalizeTerminalPanel', () => {
  const panel = (over: Partial<TerminalPanelState>): TerminalPanelState => ({
    ...CLOSED_TERMINAL_PANEL,
    ...over,
  })

  /*
   * The migration. A panel written before the roster existed parses — via the
   * schema's defaults, in main — to `tabs: []`, and an *open* one has to mean
   * "one terminal", not "a panel showing nothing". Main does not repair; this is
   * the only thing that does.
   */
  it('backfills a tab for an open panel that has none', () => {
    const repaired = normalizeTerminalPanel(panel({ open: true, height: 310 }))
    expect(repaired.tabs).toHaveLength(1)
    expect(repaired.activeId).toBe(repaired.tabs[0]?.id)
    expect(repaired.height).toBe(310)
  })

  /*
   * A closed panel is not an empty one. Hiding a panel does not kill its shells —
   * that distinction is what the whole feature rests on — so its roster has to
   * survive being out of sight, and it must not be handed a terminal nobody
   * asked for.
   */
  it('leaves a closed panel alone rather than giving it a terminal', () => {
    expect(normalizeTerminalPanel(panel({ open: false })).tabs).toEqual([])
    expect(normalizeTerminalPanel(panel({ open: false })).activeId).toBeNull()
  })

  it('keeps a hidden panel’s roster, because its shells are still running', () => {
    const hidden = normalizeTerminalPanel(
      panel({ open: false, tabs: [{ id: 'a' }, { id: 'b' }], activeId: 'b' })
    )
    expect(hidden.tabs).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(hidden.activeId).toBe('b')
  })

  /*
   * Two tabs sharing an id address the **same PTY**: killing one would kill the
   * other's shell and leave its tab pointing at nothing. Repaired rather than
   * rejected, because a stricter schema does not lose the roster — it loses
   * every open conversation.
   */
  it('drops a duplicate id rather than addressing one shell twice', () => {
    const repaired = normalizeTerminalPanel(
      panel({ open: true, tabs: [{ id: 'a' }, { id: 'a' }, { id: 'b' }], activeId: 'b' })
    )
    expect(repaired.tabs).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(repaired.activeId).toBe('b')
  })

  it('drops an empty id, which names no shell at all', () => {
    const repaired = normalizeTerminalPanel(panel({ open: true, tabs: [{ id: '' }, { id: 'a' }] }))
    expect(repaired.tabs).toEqual([{ id: 'a' }])
  })

  it('mints a replacement when every id was unusable', () => {
    const repaired = normalizeTerminalPanel(panel({ open: true, tabs: [{ id: '' }, { id: '' }] }))
    expect(repaired.tabs).toHaveLength(1)
    expect(repaired.tabs[0]?.id).not.toBe('')
    expect(repaired.activeId).toBe(repaired.tabs[0]?.id)
  })

  it('repairs an activeId that names no tab', () => {
    const repaired = normalizeTerminalPanel(
      panel({ open: true, tabs: [{ id: 'a' }, { id: 'b' }], activeId: 'gone' })
    )
    expect(repaired.activeId).toBe('a')
  })

  /*
   * The subtle one: the `activeId` pointed at the *duplicate* that was just
   * dropped. Checking it against the surviving ids rather than the input is what
   * makes this fall through to the first tab instead of naming a tab that is no
   * longer there.
   */
  it('repairs an activeId that named a duplicate it just removed', () => {
    const repaired = normalizeTerminalPanel(
      panel({ open: true, tabs: [{ id: 'a' }, { id: 'a' }], activeId: 'a' })
    )
    expect(repaired.tabs).toEqual([{ id: 'a' }])
    expect(repaired.activeId).toBe('a')
  })

  /*
   * Why `TerminalPanel` keys its exit state on a `Map`.
   *
   * `id` is `z.string()` at the boundary and rides through a file a person can
   * edit, so `constructor`, `toString` and `__proto__` are all reachable ids —
   * and this function deliberately keeps them, because the alternative is
   * rejecting a workspace and losing every open conversation. Anything indexing
   * a plain object by one of these reads a truthy value off `Object.prototype`
   * before the shell has done anything, and draws a live terminal as dead.
   */
  it('keeps an id that would be inherited from Object.prototype', () => {
    const repaired = normalizeTerminalPanel(
      panel({
        open: true,
        tabs: [{ id: 'constructor' }, { id: '__proto__' }],
        activeId: 'toString',
      })
    )
    expect(repaired.tabs).toEqual([{ id: 'constructor' }, { id: '__proto__' }])
    // `toString` is not in the roster, so it is repaired to the first tab.
    expect(repaired.activeId).toBe('constructor')
  })

  it('leaves a roster that is already sound exactly as it is', () => {
    const sound = panel({ open: true, tabs: [{ id: 'a' }, { id: 'b' }], activeId: 'b' })
    expect(normalizeTerminalPanel(sound)).toEqual(sound)
  })

  /*
   * A floor and no ceiling, which is the shape `clampSidebarWidth` and
   * `clampChorusWidth` already have: the panel takes whatever it is dragged to,
   * and squeezing the transcript is the person's call to make. The ceiling was
   * real — `TERMINAL_HEIGHT` carried a `max: 720` — and went with the same
   * change that moved the floor from 96 to 100. Asserting the huge value comes
   * back untouched is what stops a ceiling being reinstated by accident.
   */
  it('repairs a height no grip could have produced, and imposes no ceiling', () => {
    expect(normalizeTerminalPanel(panel({ open: true, height: 99_999 })).height).toBe(99_999)
    expect(normalizeTerminalPanel(panel({ open: true, height: -5 })).height).toBe(
      TERMINAL_HEIGHT.min
    )
  })

  /* Every panel in a workspace goes through it, not just the global one. */
  it('is applied to session panels too, not only the global one', () => {
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      terminals: { a: panel({ open: true, tabs: [{ id: 'x' }, { id: 'x' }] }) },
      globalTerminal: panel({ open: true }),
    })
    expect(repaired.terminals['a']?.tabs).toEqual([{ id: 'x' }])
    expect(repaired.globalTerminal.tabs).toHaveLength(1)
  })
})

describe('reconcileConversationGroups', () => {
  const arranged = (tabs: readonly string[], activeTabId: string | null) => ({
    layout: { kind: 'leaf' as const, paneId: 'g1' },
    panes: { g1: { id: 'g1', tabs: [...tabs], activeTabId } },
    focusedPaneId: 'g1',
  })

  it('drops a saved tab no live conversation confirms, caret included', () => {
    const next = reconcileConversationGroups(arranged(['c1', 'gone'], 'gone'), ['c1'])
    expect(next?.panes['g1']?.tabs).toEqual(['c1'])
    expect(next?.panes['g1']?.activeTabId).toBe('c1')
  })

  it('gives every conversation no box holds one of its own', () => {
    const saved = arrangement(leaf('g1'), [box('g1', 'c1')])
    const next = reconcileConversationGroups(saved, ['c1', 'c2', 'c3'])
    const boxes = leafPaneIds(next?.layout ?? null).map((id) => next?.panes[id]?.tabs[0])
    expect(boxes).toEqual(['c1', 'c2', 'c3'])
  })

  it('puts the caret back where it was rather than on the newest box', () => {
    const saved = arrangement(row('g1', 'g2'), [box('g1', 'c1'), box('g2', 'c2')], 'g2')
    const next = reconcileConversationGroups(saved, ['c1', 'c2', 'c3'])
    expect(next?.focusedPaneId).toBe('g2')
    expect(leafPaneIds(next?.layout ?? null)).toHaveLength(3)
  })

  it('keeps a width the saved arrangement carried', () => {
    const saved = { ...arrangement(leaf('g1'), [box('g1', 'c1')]), widths: { g1: 720 } }
    expect(reconcileConversationGroups(saved, ['c1', 'c2'])?.widths?.['g1']).toBe(720)
  })

  it('still reports nothing for a project with no arrangement to keep', () => {
    expect(reconcileConversationGroups(undefined, [])).toBeNull()
    expect(reconcileConversationGroups(arranged(['c1'], 'c1'), [])).toBeNull()
  })
})

describe('one chat per box', () => {
  const three = arrangement(
    row('a', 'b', 'c'),
    [box('a', 'c1'), box('b', 'c2'), box('c', 'c3')],
    'a'
  )

  it('opens a new box as a column right of the focused one', () => {
    const next = openBox(arrangement(leaf('a'), [box('a', 'c1')]), 'c2', 'b')
    expect(leafPaneIds(next.layout)).toEqual(['a', 'b'])
    expect(next.focusedPaneId).toBe('b')
    expect(next.panes['b']?.tabs).toEqual(['c2'])
  })

  it('opens beside a stacked box as a new column, never inside the stack', () => {
    const stacked = arrangement(column('a', 'b'), [box('a', 'c1'), box('b', 'c2')], 'a')
    const columns = columnsOf(openBox(stacked, 'c3', 'c').layout)
    expect(columns).toHaveLength(2)
    expect(leafPaneIds(columns[1] ?? null)).toEqual(['c'])
  })

  it('focuses the box already holding the tab instead of opening a second', () => {
    const next = openBox(three, 'c1', 'fresh')
    expect(leafPaneIds(next.layout)).toEqual(['a', 'b', 'c'])
    expect(next.panes['fresh']).toBeUndefined()
    expect(next.focusedPaneId).toBe('a')
  })

  it('reorders a whole column and leaves its width alone', () => {
    const next = moveBox(three, 'c', 'a', 'left')
    expect(leafPaneIds(next.layout)).toEqual(['c', 'a', 'b'])
  })

  it('stacks a box below another, splitting that box in two', () => {
    const next = moveBox(three, 'c', 'b', 'down')
    expect(leafPaneIds(next.layout)).toEqual(['a', 'b', 'c'])
    const columns = columnsOf(next.layout)
    expect(columns).toHaveLength(2)
    expect(leafPaneIds(columns[1] ?? null)).toEqual(['b', 'c'])
  })

  it('pulls a box out of a stack into its own column', () => {
    const stacked = arrangement(column('a', 'b'), [box('a', 'c1'), box('b', 'c2')], 'a')
    const next = moveBox(stacked, 'b', 'a', 'right')
    expect(columnsOf(next.layout)).toHaveLength(2)
    expect(leafPaneIds(next.layout)).toEqual(['a', 'b'])
  })

  it('refuses a destination outside the source project without lifting its chat', () => {
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      expect(moveBox(three, 'a', 'another-project', direction)).toBe(three)
    }
  })

  it('ignores a drop on the box being dragged, or on one that is gone', () => {
    expect(moveBox(three, 'a', 'a', 'up')).toBe(three)
    expect(moveBox(three, 'gone', 'a', 'up')).toBe(three)
  })
})

describe('box widths', () => {
  const three = arrangement(
    row('a', 'b', 'c'),
    [box('a', 'c1'), box('b', 'c2'), box('c', 'c3')],
    'a'
  )
  const withWidths: ConversationArrangement = { ...three, widths: { a: 700, b: 500, c: 620 } }

  it('opens a new box at the floor', () => {
    const next = openBox(arrangement(leaf('a'), [box('a', 'c1')]), 'c2', 'b')
    expect(columnWidths(next)).toEqual([BOX_WIDTH.default, BOX_WIDTH.default])
  })

  it('keeps a box moved left or right at its own width', () => {
    expect(columnWidths(moveBox(withWidths, 'c', 'a', 'left'))).toEqual([620, 700, 500])
  })

  it('gives a box stacked into a column that column width', () => {
    const next = moveBox(withWidths, 'c', 'b', 'down')
    expect(columnWidths(next)).toEqual([700, 500])
    expect(next.widths?.['c']).toBe(500)
  })

  it('writes one width to every box in a column and drops stale entries', () => {
    const stacked: ConversationArrangement = {
      ...arrangement(column('a', 'b'), [box('a', 'c1'), box('b', 'c2')], 'a'),
      widths: { a: 500, b: 500, stale: 999 },
    }
    expect(withColumnWidths(stacked, [820]).widths).toEqual({ a: 820, b: 820 })
  })

  it('ignores a widths list that does not match the columns', () => {
    expect(withColumnWidths(three, [700])).toBe(three)
  })

  it('clamps a stored width up to the floor', () => {
    const tiny: ConversationArrangement = {
      ...arrangement(leaf('a'), [box('a', 'c1')]),
      widths: { a: 120 },
    }
    expect(columnWidths(tiny)).toEqual([BOX_WIDTH.default])
    expect(clampBoxWidth(Number.NaN)).toBe(BOX_WIDTH.default)
  })
})

describe('replacing a chat in its own box', () => {
  const resized: ConversationArrangement = {
    layout: {
      kind: 'branch',
      orientation: 'row',
      children: [
        leaf('a'),
        {
          kind: 'branch',
          orientation: 'column',
          children: [leaf('b'), leaf('c')],
          sizes: [0.3, 0.7],
        },
      ],
      sizes: [0.6, 0.4],
    },
    panes: { a: box('a', 'c1'), b: box('b', 'c2'), c: box('c', 'c3') },
    focusedPaneId: 'a',
    widths: { a: 820, b: 640, c: 640 },
  }

  it('puts the new chat in the old one’s box in a resized row', () => {
    const next = replaceSession(resized, 'c1', 'n1')
    expect(next.panes['a']).toEqual({ id: 'a', tabs: ['n1'], activeTabId: 'n1' })
    expect(next.layout).toBe(resized.layout)
    expect(next.widths).toBe(resized.widths)
    expect(columnWidths(next)).toEqual(columnWidths(resized))
    expect(next.focusedPaneId).toBe('a')
    expect(next.panes['b']).toBe(resized.panes['b'])
    expect(next.panes['c']).toBe(resized.panes['c'])
  })

  it('does the same inside a resized vertical split, without moving the caret', () => {
    const next = replaceSession(resized, 'c3', 'n3')
    expect(next.panes['c']).toEqual({ id: 'c', tabs: ['n3'], activeTabId: 'n3' })
    expect(next.layout).toBe(resized.layout)
    expect(leafPaneIds(next.layout)).toEqual(['a', 'b', 'c'])
    expect(next.focusedPaneId).toBe('a')
    expect(next.panes['a']).toBe(resized.panes['a'])
    expect(next.panes['b']).toBe(resized.panes['b'])
  })

  it('leaves the tree alone when the chat being replaced has no box', () => {
    expect(replaceSession(resized, 'gone', 'n1')).toBe(resized)
  })

  it('closes the old box when the new chat already has one', () => {
    const next = replaceSession(resized, 'c1', 'c2')
    expect(tabLocation(next, 'c1')).toBeNull()
    expect(leafPaneIds(next.layout)).toEqual(['b', 'c'])
    expect(next.focusedPaneId).toBe('b')
  })
})

describe('pushDivider', () => {
  const widths = [500, 500, 500]

  it('dragging right widens the item on the left and nothing else', () => {
    expect(pushDivider(widths, 1, 60)).toEqual({ widths: [560, 500, 500], scroll: 0 })
  })

  it('dragging left shrinks the item on the left first, and nothing else moves', () => {
    expect(pushDivider([800, 500, 500], 1, -200)).toEqual({
      widths: [600, 500, 500],
      scroll: 0,
    })
  })

  it('dragging left past the floor widens the item on the right by the rest and scrolls it', () => {
    expect(pushDivider([600, 500, 500], 1, -250)).toEqual({
      widths: [500, 650, 500],
      scroll: 150,
    })
  })

  it('dragging left from the floor widens the item on the right straight away', () => {
    expect(pushDivider(widths, 1, -60)).toEqual({ widths: [500, 560, 500], scroll: 60 })
  })

  it('reversing mid-drag measures from the start, so it undoes on the way back', () => {
    expect(pushDivider([700, 500], 1, -300).widths).toEqual([500, 600])
    expect(pushDivider([700, 500], 1, -100).widths).toEqual([600, 500])
    expect(pushDivider([700, 500], 1, 0).widths).toEqual([700, 500])
  })

  it('leaves every width alone for a divider that divides nothing', () => {
    expect(pushDivider([500], 0, 40)).toEqual({ widths: [500], scroll: 0 })
  })

  it('stops the item on the left at its own minimum rather than the box floor', () => {
    expect(pushDivider([600, 500, 800], 1, -300, [352, 500, 800])).toEqual({
      widths: [352, 552, 800],
      scroll: 52,
    })
  })

  it('only ever widens the item on the right, so Traffic never drops below its floor', () => {
    expect(pushDivider([500, 800], 1, -120, [500, 800])).toEqual({
      widths: [500, 920],
      scroll: 120,
    })
  })
})

describe('editor width', () => {
  it('reserves a 500px chat and its divider by default, respecting the editor minimum', () => {
    expect(editorWidthIn(1_000)).toBe(500)
    expect(editorWidthIn(2_000)).toBe(1_491)
    expect(editorWidthIn(500)).toBe(500)
    expect(editorWidthIn(999)).toBe(500)
  })

  it('reserves the chat inside the measured pane while retaining full-window manual widths', () => {
    expect(editorWidthIn(2_000, undefined, 1_880)).toBe(1_371)
    expect(editorWidthIn(2_000, undefined, 1_480)).toBe(971)
    expect(editorWidthIn(2_000, 1, 1_880)).toBe(2_000)
    expect(editorWidthIn(2_000, 0.75, 1_880)).toBe(1_500)
  })

  it('keeps manual widths within the window when it shrinks', () => {
    expect(editorWidthIn(2_000, 1)).toBe(2_000)
    expect(editorWidthIn(1_000, 1)).toBe(1_000)
    expect(editorWidthIn(360, 1)).toBe(360)
    expect(editorWidthIn(1_000, 1.4)).toBe(1_000)
    expect(editorWidthIn(1_000, 0.25)).toBe(500)
    expect(clampEditorWidth(4_000, 1_000)).toBe(1_000)
    expect(clampEditorWidth(100, 1_000)).toBe(500)
    expect(clampEditorWidth(500, 360)).toBe(360)
  })

  it('repairs saved fractions and drops invalid overrides', () => {
    const saved = {
      ...EMPTY_WORKSPACE,
      editorWidthFractions: { p1: 0.75, p2: 1.4, zero: 0, negative: -1, bad: Number.NaN },
    }
    expect(normalizeWorkspace(saved).editorWidthFractions).toEqual({ p1: 0.75, p2: 1 })
    expect(editorWidthIn(2_000, Number.NaN)).toBe(1_491)
  })

  it('carries a manual width through detach and return, and removes only a missing slice', () => {
    const saved = { ...EMPTY_WORKSPACE, editorWidthFractions: { p1: 0.9, p2: 0.7 } }
    const slice = sliceOf(saved, 'p1')
    expect(slice.editorWidthFraction).toBe(0.9)
    expect(detachedSnapshot('p1', slice).editorWidthFractions).toEqual({ p1: 0.9 })
    expect(mergeSlice(saved, 'p1', {}).editorWidthFractions).toEqual({ p2: 0.7 })
    expect(mergeSlice(EMPTY_WORKSPACE, 'p1', slice).editorWidthFractions).toEqual({ p1: 0.9 })
  })

  it('ignores saved editor overrides without losing the rest of an old snapshot', () => {
    const saved = { ...EMPTY_WORKSPACE, editorWidths: { p1: 1_900 } }
    expect(WorkspaceSnapshot.parse(saved)).toEqual(EMPTY_WORKSPACE)
  })
})

describe('the activity bar gutter', () => {
  it('keeps the width the editor reported', () => {
    expect(clampActivityBar(48, 800, 1_300)).toBe(48)
    expect(clampActivityBar(36, 800, 1_300)).toBe(36)
    expect(clampActivityBar(47.6, 800, 1_300)).toBe(48)
  })

  it('cannot be made wider than half the editor or half the pane', () => {
    expect(clampActivityBar(10_000, 800, 1_300)).toBe(400)
    expect(clampActivityBar(10_000, 800, 300)).toBe(150)
  })

  it('reserves nothing for a report that is negative or not a number', () => {
    expect(clampActivityBar(-3, 800, 1_300)).toBe(0)
    expect(clampActivityBar(Number.NaN, 800, 1_300)).toBe(0)
    expect(clampActivityBar(48, 800, 0)).toBe(0)
  })
})

describe('the rectangle the native browser is given', () => {
  const box = (left: number, width: number, top = 40, height = 600): MeasuredBox => ({
    left,
    top,
    width,
    height,
  })
  const scroller = box(151, 1_000)
  const body = (left: number): MeasuredBox => box(left, 1_000, 80, 557)

  it('is live only when the whole panel sits inside the row', () => {
    expect(browserViewport(box(151, 1_000), body(151), scroller)).toEqual({
      rect: {
        x: 151,
        y: 80,
        width: 1_000 - ROW_EDGE_INSET,
        height: 640 - ROW_SCROLLBAR_STRIP - 80,
      },
      fullyVisible: true,
    })
    expect(browserViewport(box(-600, 1_000), body(-600), scroller).fullyVisible).toBe(false)
    expect(browserViewport(box(400, 1_000), body(400), scroller).fullyVisible).toBe(false)
  })

  it('tolerates sub-pixel placement but not a visible crop', () => {
    expect(browserViewport(box(151.6, 999.6), body(151.6), scroller).fullyVisible).toBe(true)
    expect(browserViewport(box(153, 1_000), body(153), scroller).fullyVisible).toBe(false)
  })

  it('is never live without a body to show', () => {
    const empty = browserViewport(box(151, 1_000), box(151, 1_000, 700, 0), scroller)
    expect(empty.rect.height).toBe(0)
    expect(empty.fullyVisible).toBe(false)
  })
})

describe('the rectangle the native editor is given', () => {
  const box = (left: number, width: number, top = 43, height = 594): MeasuredBox => ({
    left,
    top,
    width,
    height,
  })
  const bar = box(103, 48)
  const overlayScroller = box(151, 1_000, 40, 600)
  const classicScroller = box(151, 1_000, 40, 611)

  it('covers the bar and the whole body at rest, and lays out at that width', () => {
    expect(editorViewport(bar, box(151, 741), overlayScroller)).toEqual({
      rect: { x: 103, y: 43, width: 789, height: 585 },
      layoutWidth: 789,
    })
  })

  it('shrinks the logical width with the visible editor above 500', () => {
    expect(editorViewport(bar, box(-49, 741), overlayScroller)).toEqual({
      rect: { x: 103, y: 43, width: 589, height: 585 },
      layoutWidth: 589,
    })
  })

  it('crops from the right and floors the logical width at 500', () => {
    expect(editorViewport(bar, box(-149, 741), overlayScroller)).toEqual({
      rect: { x: 103, y: 43, width: 489, height: 585 },
      layoutWidth: 500,
    })
  })

  it('keeps the bar on screen once the body has scrolled out entirely', () => {
    expect(editorViewport(bar, box(-800, 741), overlayScroller).rect).toEqual({
      x: 103,
      y: 43,
      width: 48,
      height: 585,
    })
  })

  it('lays out at 500 when the editor slot and bar are narrower', () => {
    expect(editorViewport(bar, box(151, 352), overlayScroller)).toEqual({
      rect: { x: 103, y: 43, width: 400, height: 585 },
      layoutWidth: 500,
    })
  })

  it('stops short of the pane edge for an editor wider than it, and lays out to fit', () => {
    const { rect, layoutWidth } = editorViewport(bar, box(151, 1_600), overlayScroller)
    expect(rect).toEqual({ x: 103, y: 43, width: 1_045, height: 585 })
    expect(rect.x + rect.width).toBe(151 + 1_000 - ROW_EDGE_INSET)
    expect(layoutWidth).toBe(1_045)
  })

  it('leaves an overlay scrollbar its strip at the bottom of the row', () => {
    const { rect } = editorViewport(bar, box(151, 741), overlayScroller)
    expect(rect.y + rect.height).toBe(40 + 600 - ROW_SCROLLBAR_STRIP)
  })

  it('needs no more room than a classic scrollbar already takes below the body', () => {
    expect(editorViewport(bar, box(151, 741), classicScroller).rect).toEqual({
      x: 103,
      y: 43,
      width: 789,
      height: 594,
    })
  })

  it('gives a hidden bar no width of its own', () => {
    const none = box(103, 0)
    const scroller = box(103, 1_048, 40, 600)
    expect(editorViewport(none, box(-800, 741), scroller).rect.width).toBe(0)
    expect(editorViewport(none, box(103, 741), scroller).rect.width).toBe(741)
  })

  it('rounds sub-pixel geometry, and has no layout width for a pane with no room', () => {
    expect(editorViewport(box(103.4, 47.6), box(151.2, 740.6), overlayScroller).rect).toEqual({
      x: 103,
      y: 43,
      width: 789,
      height: 585,
    })
    expect(editorViewport(bar, box(151, 741), box(103, 0)).layoutWidth).toBeUndefined()
  })
})

describe('resetBoxes', () => {
  it('clears every width and evens every stack', () => {
    const uneven: ConversationArrangement = {
      layout: column('a', 'b'),
      panes: { a: box('a', 'c1'), b: box('b', 'c2') },
      focusedPaneId: 'a',
      widths: { a: 900, b: 900 },
    }
    const next = resetBoxes(uneven)
    expect(next.widths).toEqual({})
    expect(next.layout).toEqual({
      kind: 'branch',
      orientation: 'column',
      children: [leaf('a'), leaf('b')],
      sizes: [0.5, 0.5],
    })
  })
})

describe('run terminal pane width', () => {
  const MAIN = [{ id: 'main' }]
  const SPLIT = [{ id: 'main' }, { id: 's2' }]

  it('opens at 500 with one shell, and never below its 480 floor', () => {
    expect(DEFAULT_PROJECT_TERMINAL).toEqual({ width: 500, shells: MAIN })
    expect(PROJECT_TERMINAL_WIDTH).toEqual({ default: 500, min: 480, run: 480, slot: 320 })
    expect(clampProjectTerminalWidth(Number.NaN)).toBe(500)
    expect(clampProjectTerminalWidth(120)).toBe(480)
    expect(clampProjectTerminalWidth(720.6)).toBe(721)
  })

  it('uses the same column width for stacked Run and shell rows', () => {
    expect(projectTerminalMinimum(1)).toBe(480)
    expect(projectTerminalMinimum(3)).toBe(480)
    expect(projectTerminalWidth({ width: 500, shells: MAIN })).toBe(500)
    expect(projectTerminalWidth({ width: 500, shells: [...SPLIT, { id: 's3' }] })).toBe(500)
    expect(projectTerminalWidth({ width: 2_000, shells: SPLIT })).toBe(2_000)
  })

  it('repairs a stored width on the way through without touching Traffic or the shells', () => {
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      trafficPanels: { p1: { open: true, width: 1_200, widthCustomized: true } },
      projectTerminals: { p1: { width: 40, shells: SPLIT }, p2: { width: 900, shells: MAIN } },
    })
    expect(repaired.projectTerminals).toEqual({
      p1: { width: 480, shells: SPLIT },
      p2: { width: 900, shells: MAIN },
    })
    expect(repaired.trafficPanels).toEqual({
      p1: { open: true, width: 1_200, widthCustomized: true },
    })
  })

  it('travels with the project and its shells through a detach and back', () => {
    const workspace: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      projectTerminals: { p1: { width: 760, shells: SPLIT }, p2: { width: 500, shells: MAIN } },
    }
    const slice = sliceOf(workspace, 'p1')
    expect(slice.projectTerminal).toEqual({ width: 760, shells: SPLIT })
    expect(detachedSnapshot('p1', slice).projectTerminals).toEqual({
      p1: { width: 760, shells: SPLIT },
    })
    const elsewhere = { ...workspace, projectTerminals: { p2: { width: 500, shells: MAIN } } }
    const returned = mergeSlice(elsewhere, 'p1', slice)
    expect(returned.projectTerminals).toEqual({
      p2: { width: 500, shells: MAIN },
      p1: { width: 760, shells: SPLIT },
    })
    expect(mergeSlice(workspace, 'p1', {}).projectTerminals).toEqual({
      p2: { width: 500, shells: MAIN },
    })
  })

  it('repairs a blank, duplicated or empty roster into a usable one', () => {
    expect(normalizeProjectShells([])).toEqual(MAIN)
    expect(normalizeProjectShells([{ id: '' }])).toEqual(MAIN)
    const messy = [{ id: 's2' }, { id: '' }, { id: 's2' }, { id: 's3' }]
    expect(normalizeProjectShells(messy)).toEqual([{ id: 's2' }, { id: 's3' }])
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      projectTerminals: { p1: { width: 640, shells: [] } },
    })
    expect(repaired.projectTerminals['p1']?.shells).toEqual(MAIN)
  })

  it('defaults an older pane to one shell, and parses an empty roster', () => {
    const parsed = WorkspaceSnapshot.parse({
      layout: { kind: 'leaf', paneId: 'pane-1' },
      panes: { 'pane-1': { id: 'pane-1', tabs: ['p1'], activeTabId: 'p1' } },
      focusedPaneId: 'pane-1',
      projectTerminals: { p1: { width: 700 }, p2: { width: 700, shells: [] } },
    })
    expect(parsed.projectTerminals).toEqual({
      p1: { width: 700, shells: MAIN },
      p2: { width: 700, shells: [] },
    })
    expect(parsed.panes['pane-1']?.tabs).toEqual(['p1'])
  })

  it('parses a snapshot written before the pane, keeping its panes and widths', () => {
    const parsed = WorkspaceSnapshot.parse({
      layout: { kind: 'leaf', paneId: 'pane-1' },
      panes: { 'pane-1': { id: 'pane-1', tabs: ['p1'], activeTabId: 'p1' } },
      focusedPaneId: 'pane-1',
      trafficPanels: { p1: { open: true, width: 960 } },
    })
    expect(parsed.projectTerminals).toEqual({})
    expect(parsed.panes['pane-1']?.tabs).toEqual(['p1'])
    expect(parsed.trafficPanels).toEqual({ p1: { open: true, width: 960 } })
  })
})

describe('traffic panel', () => {
  it('opens at 700px by default', () => {
    expect(CLOSED_TRAFFIC).toEqual({ open: false, width: 700 })
    expect(clampTrafficWidth(Number.NaN)).toBe(700)
  })

  it('clamps a stored width up to the floor', () => {
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      trafficPanels: { p1: { open: true, width: 40, widthCustomized: true } },
    })
    expect(repaired.trafficPanels['p1']).toEqual({
      open: true,
      width: TRAFFIC_WIDTH.min,
      widthCustomized: true,
    })
  })

  it('resets older widths to 700 while keeping conversations and collapsed state', () => {
    const saved = WorkspaceSnapshot.parse({
      layout: { kind: 'leaf', paneId: 'pane-1' },
      panes: { 'pane-1': { id: 'pane-1', tabs: ['p1', 'p2'], activeTabId: 'p1' } },
      focusedPaneId: 'pane-1',
      trafficPanels: {
        p1: { open: true, width: 800 },
        p2: { open: false, width: 1_200, collapsed: true },
      },
    })
    const repaired = normalizeWorkspace(saved)
    expect(repaired.trafficPanels).toEqual({
      p1: { open: true, width: 700 },
      p2: { open: false, width: 700, collapsed: true },
    })
    expect(repaired.panes['pane-1']?.tabs).toEqual(['p1', 'p2'])
  })

  it('preserves customized widths and their open state across reloads', () => {
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      trafficPanels: {
        p1: { open: false, width: BOX_WIDTH.default, widthCustomized: true },
        p2: { open: true, width: 800, widthCustomized: true },
      },
    })
    expect(repaired.trafficPanels).toEqual({
      p1: { open: false, width: TRAFFIC_WIDTH.min, widthCustomized: true },
      p2: { open: true, width: 800, widthCustomized: true },
    })
    expect(normalizeWorkspace(WorkspaceSnapshot.parse(repaired)).trafficPanels).toEqual(
      repaired.trafficPanels
    )
  })

  it('carries the panel through a slice and back, and drops it when absent', () => {
    const workspace: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      trafficPanels: { p1: { open: true, width: 640, widthCustomized: true } },
    }
    const slice = sliceOf(workspace, 'p1')
    expect(slice.trafficPanel).toEqual({ open: true, width: 640, widthCustomized: true })
    expect(mergeSlice(EMPTY_WORKSPACE, 'p1', slice).trafficPanels['p1']).toEqual({
      open: true,
      width: 640,
      widthCustomized: true,
    })
    expect(mergeSlice(workspace, 'p1', {}).trafficPanels['p1']).toBeUndefined()
  })

  it('resets an older detached panel when its slice returns', () => {
    const returned = mergeSlice(EMPTY_WORKSPACE, 'p1', {
      trafficPanel: { open: true, width: 800, collapsed: true },
    })
    expect(returned.trafficPanels['p1']).toEqual({ open: true, width: 700, collapsed: true })
  })
})

describe('row scroll', () => {
  it('moves one project’s offset through a slice without touching another’s', () => {
    const workspace: WorkspaceSnapshot = { ...EMPTY_WORKSPACE, rowScroll: { a: -500, b: 120 } }
    const slice = sliceOf(workspace, 'a')
    expect(slice.rowScroll).toBe(-500)
    const merged = mergeSlice({ ...EMPTY_WORKSPACE, rowScroll: { b: 90 } }, 'a', slice)
    expect(merged.rowScroll).toEqual({ a: -500, b: 90 })
  })

  it('drops an offset the slice does not carry', () => {
    const workspace: WorkspaceSnapshot = { ...EMPTY_WORKSPACE, rowScroll: { a: 640, b: 120 } }
    expect(sliceOf(EMPTY_WORKSPACE, 'a').rowScroll).toBeUndefined()
    expect(mergeSlice(workspace, 'a', {}).rowScroll).toEqual({ b: 120 })
  })

  it('opens a detached window at its offset and brings the latest one back', () => {
    expect(detachedSnapshot('a', { rowScroll: 640 }).rowScroll).toEqual({ a: 640 })
    const applied = applyDetachedEntries({ ...onePane('a', 'b'), rowScroll: { a: 640, b: 120 } }, [
      { projectId: 'a', slice: { rowScroll: 320 } },
    ])
    expect(applied.rowScroll).toEqual({ a: 320, b: 120 })
  })

  it('keeps signed editor offsets and removes non-finite values', () => {
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      rowScroll: { a: 640, b: 0, c: -40, d: Number.NaN, e: Number.POSITIVE_INFINITY },
    })
    expect(repaired.rowScroll).toEqual({ a: 640, b: 0, c: -40 })
  })

  it('restores each project’s offset at launch', () => {
    const restored = reconcileWorkspace(
      { ...onePane('a', 'b'), rowScroll: { a: 640, b: 120 } },
      ['c1', 'c2'],
      ['a', 'b'],
      { a: ['c1'], b: ['c2'] }
    )
    expect(restored.rowScroll).toEqual({ a: 640, b: 120 })
  })
})

describe('newTerminalId', () => {
  /*
   * A UUID rather than a counter, because the roster outlives the process: a
   * counter restarting at 1 on relaunch reuses ids, and a reused id makes a
   * restored tab address a shell another tab already holds.
   */
  it('never repeats itself', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTerminalId()))
    expect(ids.size).toBe(500)
  })

  it('is never empty, since an empty id is the thing normalization drops', () => {
    expect(newTerminalId()).not.toBe('')
  })
})

describe('detached projects', () => {
  const detach = (
    workspace: WorkspaceSnapshot,
    projectId: string,
    detached: Parameters<typeof detachTab>[2]
  ): NonNullable<ReturnType<typeof detachTab>> => {
    const result = detachTab(workspace, projectId, detached)
    if (result === null) throw new Error(`${projectId} is not open`)
    return result
  }

  it('returns two projects from one pane in the order they were detached', () => {
    const first = detach(onePane('a', 'b', 'c', 'd'), 'b', {})
    const second = detach(first.workspace, 'c', { b: first.slot })
    expect(second.workspace.panes['pane-1']?.tabs).toEqual(['a', 'd'])

    const withB = returnTab(second.workspace, 'b', first.slot, { b: first.slot, c: second.slot })
    const withBoth = returnTab(withB, 'c', second.slot, { c: second.slot })
    expect(withBoth.panes['pane-1']?.tabs).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns them to the same places in the other order', () => {
    const first = detach(onePane('a', 'b', 'c', 'd'), 'b', {})
    const second = detach(first.workspace, 'c', { b: first.slot })

    const withC = returnTab(second.workspace, 'c', second.slot, { b: first.slot, c: second.slot })
    const withBoth = returnTab(withC, 'b', first.slot, { b: first.slot })
    expect(withBoth.panes['pane-1']?.tabs).toEqual(['a', 'b', 'c', 'd'])
  })

  it('writes both back into their places while both are still detached', () => {
    const first = detach(onePane('a', 'b', 'c', 'd'), 'b', {})
    const second = detach(first.workspace, 'c', { b: first.slot })
    const saved = withDetachedReturned(second.workspace, { b: first.slot, c: second.slot })
    expect(saved.panes['pane-1']?.tabs).toEqual(['a', 'b', 'c', 'd'])
    expect(saved.panes['pane-1']?.activeTabId).toBe('a')
  })

  it('returns to the end of the focused pane when its own pane is gone', () => {
    const returned = returnTab(onePane('x', 'y'), 'p', { paneId: 'gone', index: 0 }, {})
    expect(returned.panes['pane-1']?.tabs).toEqual(['x', 'y', 'p'])
  })

  it('takes a detached project out of the panes and keeps its slice', () => {
    const applied = applyDetachedEntries(onePane('a', 'b'), [
      {
        projectId: 'b',
        slice: { trafficPanel: { open: true, width: 900, widthCustomized: true } },
      },
    ])
    expect(applied.panes['pane-1']?.tabs).toEqual(['a'])
    expect(applied.trafficPanels['b']).toEqual({
      open: true,
      width: 900,
      widthCustomized: true,
    })
  })

  it('gives a dropped tab a slot that returns it where it was dropped', () => {
    const first = detach(onePane('a', 'b', 'c', 'd'), 'b', {})
    const second = detach(first.workspace, 'c', { b: first.slot })
    const detached = { b: first.slot, c: second.slot }
    const slot = { paneId: 'pane-1', index: virtualIndex('pane-1', 1, detached) }
    const returned = returnTab(second.workspace, 'x', slot, { ...detached, x: slot })
    expect(returned.panes['pane-1']?.tabs).toEqual(['a', 'x', 'd'])
  })
})
