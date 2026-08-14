import { describe, expect, it } from 'vitest'
import { SIDEBAR_WIDTH, type WorkspaceSnapshot } from '../../../shared/workspace-layout.js'
import {
  clampSidebarWidth,
  closeTab,
  EMPTY_WORKSPACE,
  leafPaneIds,
  MAX_PANES,
  moveTab,
  normalizeWorkspace,
  openSession,
  placeSession,
  reconcileWorkspace,
  reorderTab,
  setBranchSizes,
  splitTab,
  splitWithSession,
  tabLocation,
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
    expect(reconcileWorkspace(null, ['a'])).toMatchObject({
      focusedPaneId: 'pane-1',
      panes: { 'pane-1': { tabs: ['a'] } },
    })
    expect(reconcileWorkspace(EMPTY_WORKSPACE, ['a'])).toEqual(EMPTY_WORKSPACE)
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
      ['a', 'b']
    )
    expect(Object.values(result.panes).flatMap((pane) => pane.tabs)).toEqual(['a'])
    expect(result.sidebarHidden).toBe(true)
  })

  it('opens legacy restored conversations when there is no saved workspace', () => {
    const result = reconcileWorkspace(null, ['a', 'b'])
    expect(Object.values(result.panes).flatMap((pane) => pane.tabs)).toEqual(['a', 'b'])
  })

  /*
   * A persisted width is not trusted. It comes from a file the user can edit,
   * and it survives a window being resized much narrower — either of which can
   * hand back a sidebar wider than the screen or too thin to read.
   */
  it('clamps the sidebar width, on the way in as well as during a drag', () => {
    expect(clampSidebarWidth(9_000)).toBe(SIDEBAR_WIDTH.max)
    expect(clampSidebarWidth(-40)).toBe(SIDEBAR_WIDTH.min)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default)
    // Rounded, not floored, and inside the range — 320 is the ceiling now that
    // the drawer is a temporary panel rather than the permanent column.
    expect(clampSidebarWidth(261.6)).toBe(262)
    expect(normalizeWorkspace({ ...onePane('a'), sidebarWidth: 9_000 }).sidebarWidth).toBe(
      SIDEBAR_WIDTH.max
    )
  })

  it('normalizes persisted branch sizes', () => {
    const workspace = splitTab(onePane('a', 'b'), 'b', 'pane-1', 'right', 'pane-2')
    const resized = setBranchSizes(workspace, [], [3, 1])
    expect(resized.layout).toMatchObject({ sizes: [0.75, 0.25] })
  })
})

describe('terminal panels across a restore', () => {
  const withPanels = (terminals: Record<string, { open: boolean; height: number }>) => ({
    ...EMPTY_WORKSPACE,
    layout: { kind: 'leaf' as const, paneId: 'pane-1' },
    panes: { 'pane-1': { id: 'pane-1', tabs: ['a'], activeTabId: 'a' } },
    focusedPaneId: 'pane-1',
    terminals,
  })

  it('keeps a panel whose conversation is still open', () => {
    const restored = reconcileWorkspace(withPanels({ a: { open: true, height: 300 } }), ['a'])
    expect(restored.terminals['a']).toEqual({ open: true, height: 300 })
  })

  /*
   * Without this the map grows forever — every conversation ever ended leaves an
   * entry behind — and an id that came round again would inherit a panel someone
   * opened for something else.
   */
  it('drops a panel whose conversation is gone', () => {
    const restored = reconcileWorkspace(
      withPanels({ a: { open: true, height: 300 }, ghost: { open: true, height: 300 } }),
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
    const saved = { ...withPanels({ ghost: { open: true, height: 300 } }) }
    const restored = reconcileWorkspace(
      { ...saved, globalTerminal: { open: true, height: 200 } },
      []
    )
    expect(restored.globalTerminal).toEqual({ open: true, height: 200 })
  })

  it('clamps a stored height that could not be dragged to', () => {
    const restored = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      globalTerminal: { open: true, height: 99_999 },
    })
    expect(restored.globalTerminal.height).toBeLessThanOrEqual(720)
  })

  it('survives a workspace that never had panels', () => {
    const restored = reconcileWorkspace(null, ['a'])
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
