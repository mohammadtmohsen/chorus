import {
  CHANGES_HEIGHT,
  CHANGES_LIST,
  CHANGES_WIDTH,
  SIDEBAR_WIDTH,
  TERMINAL_HEIGHT,
  type ChangesPanelState,
  type TerminalPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WorkspaceSnapshot,
} from '../../../shared/workspace-layout.js'

/** Matches the panel grip's own clamp, so a stored height cannot open absurd. */
export function clampTerminalHeight(height: number): number {
  if (!Number.isFinite(height)) return TERMINAL_HEIGHT.default
  return Math.round(Math.min(TERMINAL_HEIGHT.max, Math.max(TERMINAL_HEIGHT.min, height)))
}

/** Keeps a persisted or dragged width inside what the shell can actually show. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))
}

/**
 * A fresh terminal id.
 *
 * A UUID rather than a counter, because the roster outlives the process: a
 * counter that restarts at 1 on relaunch reuses ids, and a reused id makes a
 * restored tab address a shell another tab is already attached to. The number
 * a person sees — "Terminal 2" — is a position in the roster, computed on
 * render and never stored, so killing the first tab renumbers the rest.
 */
export function newTerminalId(): string {
  return crypto.randomUUID()
}

/**
 * The one place a panel's roster is made to hold together.
 *
 * Four rules, and each is here rather than in the schema because a schema can
 * only *reject*, and rejecting a `WorkspaceSnapshot` costs every open
 * conversation (see its own warning):
 *
 * - **An open panel has at least one tab.** A panel written before the roster
 *   existed parses to `tabs: []`, which must mean "one terminal", not "an open
 *   panel showing nothing".
 * - **Ids are non-empty and unique within the panel.** Two tabs sharing an id
 *   address the **same PTY**, so killing one kills the other's shell and leaves
 *   its tab pointing at nothing.
 * - **`activeId` names a tab that is present**, or the first one.
 * - **The height is clamped**, so a hand-edited file cannot open a panel taller
 *   than the window.
 *
 * A **closed** panel keeps whatever roster it has and is not given one. Hiding a
 * panel does not kill its shells — that is the distinction the whole feature
 * rests on — so its tabs have to survive being out of sight.
 */
export function normalizeTerminalPanel(panel: TerminalPanelState): TerminalPanelState {
  const seen = new Set<string>()
  const kept = panel.tabs.filter((tab) => {
    if (tab.id === '' || seen.has(tab.id)) return false
    seen.add(tab.id)
    return true
  })
  const tabs = panel.open && kept.length === 0 ? [{ id: newTerminalId() }] : kept
  return {
    open: panel.open,
    height: clampTerminalHeight(panel.height),
    tabs,
    // `seen` holds only the ids that survived, so an `activeId` naming a
    // duplicate that was just dropped falls through to the first tab too.
    activeId:
      panel.activeId !== null && seen.has(panel.activeId) ? panel.activeId : (tabs[0]?.id ?? null),
  }
}

/**
 * The Changes panel's equivalent of `normalizeTerminalPanel`, and deliberately
 * much smaller.
 *
 * There is no roster to repair — a Changes panel holds one view of one
 * repository, not a list of live shells — so the only invariant that can be
 * broken by a hand-edited file is the height. `base` is *not* validated against
 * the repository here: this function is pure and synchronous, git is neither,
 * and a base that has since been deleted is a `problem` string the panel
 * displays rather than a state to repair silently.
 */
export function normalizeChangesPanel(panel: ChangesPanelState): ChangesPanelState {
  return {
    open: panel.open,
    height: clampChangesHeight(panel.height),
    width: clampChangesWidth(panel.width),
    base: panel.base === '' ? null : panel.base,
    committedOnly: panel.committedOnly,
    selectedPath: panel.selectedPath === '' ? null : panel.selectedPath,
    view: panel.view,
    listWidth: clampChangesList(panel.listWidth),
    column: panel.column,
    /*
     * Bounded and de-duplicated.
     *
     * Expanding directories is unbounded user action and this rides in the
     * persisted snapshot, so without a cap a long-lived session writes an
     * ever-growing array to disk on every layout change. 200 is far past any
     * tree anyone is actually reading.
     */
    expanded: [...new Set(panel.expanded.filter((path) => path !== ''))].slice(0, MAX_EXPANDED),
  }
}

/** Enough for a deep tree, few enough that the snapshot stays small. */
export const MAX_EXPANDED = 200

export function clampChangesHeight(height: number): number {
  if (!Number.isFinite(height)) return CHANGES_HEIGHT.default
  return Math.min(Math.max(height, CHANGES_HEIGHT.min), CHANGES_HEIGHT.max)
}

/** Same shape as the panel's own clamp — a dragged value is never trusted raw. */
export function clampChangesList(width: number): number {
  if (!Number.isFinite(width)) return CHANGES_LIST.default
  return Math.min(Math.max(Math.round(width), CHANGES_LIST.min), CHANGES_LIST.max)
}

export function clampChangesWidth(width: number): number {
  if (!Number.isFinite(width)) return CHANGES_WIDTH.default
  return Math.min(Math.max(width, CHANGES_WIDTH.min), CHANGES_WIDTH.max)
}

export type SplitDirection = 'left' | 'right' | 'up' | 'down'

/** Four readable editor groups; conversations beyond this remain available as tabs. */
export const MAX_PANES = 4

/*
 * A fresh install opens collapsed.
 *
 * The 60px rail is the primary state, not the fallback one: every session is
 * reachable from it in a stable place, and the drawer is opened to search or
 * manage and closed again. Starting with the drawer open would teach the
 * opposite on the one launch that teaches anything.
 */
export const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  layout: null,
  panes: {},
  focusedPaneId: null,
  sidebarHidden: true,
  sidebarWidth: SIDEBAR_WIDTH.default,
  terminals: {},
  globalTerminal: { open: false, height: TERMINAL_HEIGHT.default, tabs: [], activeId: null },
  changes: {},
}

interface NormalizedNode {
  node: WorkspaceLayoutNode
  size: number
}

function normalizedSizes(sizes: readonly number[], count: number): number[] {
  if (count === 0) return []
  const safe = Array.from({ length: count }, (_, index) => {
    const value = sizes[index]
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
  })
  const sum = safe.reduce((total, value) => total + value, 0)
  if (sum <= 0) return Array.from({ length: count }, () => 1 / count)
  return safe.map((value) => value / sum)
}

export function leafPaneIds(layout: WorkspaceLayoutNode | null): string[] {
  if (layout === null) return []
  if (layout.kind === 'leaf') return [layout.paneId]
  return layout.children.flatMap(leafPaneIds)
}

export function tabLocation(
  workspace: WorkspaceSnapshot,
  conversationId: string
): { paneId: string; index: number } | null {
  for (const paneId of leafPaneIds(workspace.layout)) {
    const index = workspace.panes[paneId]?.tabs.indexOf(conversationId) ?? -1
    if (index >= 0) return { paneId, index }
  }
  return null
}

/**
 * Repairs both persisted input and the result of structural actions.
 *
 * A conversation has one view at most. Enforcing that here means a malformed
 * saved layout cannot create two composers for the same live session.
 */
export function normalizeWorkspace(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  const oldOrder = leafPaneIds(workspace.layout)
  const oldFocusIndex =
    workspace.focusedPaneId === null ? -1 : oldOrder.indexOf(workspace.focusedPaneId)
  const seenPanes = new Set<string>()
  const seenTabs = new Set<string>()
  const panes: Record<string, WorkspacePane> = {}

  const visit = (node: WorkspaceLayoutNode, inheritedSize = 1): NormalizedNode | null => {
    if (node.kind === 'leaf') {
      if (seenPanes.has(node.paneId)) return null
      seenPanes.add(node.paneId)
      const source = workspace.panes[node.paneId]
      if (source === undefined) return null

      const activeIndex = source.activeTabId === null ? -1 : source.tabs.indexOf(source.activeTabId)
      const tabs = source.tabs.filter((id) => {
        if (seenTabs.has(id)) return false
        seenTabs.add(id)
        return true
      })
      if (tabs.length === 0) return null

      const activeTabId = tabs.includes(source.activeTabId ?? '')
        ? source.activeTabId
        : (tabs[Math.min(Math.max(activeIndex, 0), tabs.length - 1)] ?? tabs[0] ?? null)
      panes[node.paneId] = { id: node.paneId, tabs, activeTabId }
      return { node: { kind: 'leaf', paneId: node.paneId }, size: inheritedSize }
    }

    const sourceSizes = normalizedSizes(node.sizes, node.children.length)
    const children: NormalizedNode[] = []
    node.children.forEach((child, index) => {
      const normalized = visit(child, sourceSizes[index] ?? 0)
      if (normalized === null) return
      if (normalized.node.kind === 'branch' && normalized.node.orientation === node.orientation) {
        const branch = normalized.node
        branch.children.forEach((grandchild, grandchildIndex) => {
          children.push({
            node: grandchild,
            size: normalized.size * (branch.sizes[grandchildIndex] ?? 0),
          })
        })
      } else {
        children.push(normalized)
      }
    })

    if (children.length === 0) return null
    const only = children[0]
    if (children.length === 1 && only !== undefined) return { node: only.node, size: inheritedSize }
    return {
      node: {
        kind: 'branch',
        orientation: node.orientation,
        children: children.map(({ node: child }) => child),
        sizes: normalizedSizes(
          children.map(({ size }) => size),
          children.length
        ),
      },
      size: inheritedSize,
    }
  }

  const layout = workspace.layout === null ? null : (visit(workspace.layout)?.node ?? null)
  const nextOrder = leafPaneIds(layout)
  const focusedPaneId =
    workspace.focusedPaneId !== null && nextOrder.includes(workspace.focusedPaneId)
      ? workspace.focusedPaneId
      : (nextOrder[Math.min(Math.max(oldFocusIndex, 0), nextOrder.length - 1)] ?? null)

  return {
    layout,
    panes,
    focusedPaneId,
    sidebarHidden: workspace.sidebarHidden,
    sidebarWidth: clampSidebarWidth(workspace.sidebarWidth),
    /*
     * Every panel's roster repaired, both scopes, on the way through.
     *
     * This used to carry `terminals` untouched — "normalising is about panes and
     * tabs, and a terminal panel is neither" — while still clamping the global
     * panel's height, which already half-contradicted itself. Now a panel has a
     * roster with an invariant, and this is the funnel every persisted workspace
     * and every structural action passes through, so it is where the invariant
     * is made true rather than assumed.
     *
     * Pruning *by conversation* is still not here: `reconcileWorkspace` is the
     * only thing that knows which conversations still exist.
     */
    terminals: Object.fromEntries(
      Object.entries(workspace.terminals).map(([conversationId, panel]) => [
        conversationId,
        normalizeTerminalPanel(panel),
      ])
    ),
    globalTerminal: normalizeTerminalPanel(workspace.globalTerminal),
    // Repaired here for the same reason, and pruned by conversation in
    // `reconcileWorkspace` for the same reason too.
    changes: Object.fromEntries(
      Object.entries(workspace.changes).map(([conversationId, panel]) => [
        conversationId,
        normalizeChangesPanel(panel),
      ])
    ),
  }
}

function nextPaneId(workspace: WorkspaceSnapshot): string {
  let index = 1
  while (workspace.panes[`pane-${String(index)}`] !== undefined) index += 1
  return `pane-${String(index)}`
}

export function openSession(
  workspace: WorkspaceSnapshot,
  conversationId: string,
  requestedPaneId?: string
): WorkspaceSnapshot {
  const existing = tabLocation(workspace, conversationId)
  if (existing !== null) return activateTab(workspace, existing.paneId, conversationId)

  const order = leafPaneIds(workspace.layout)
  const paneId =
    requestedPaneId !== undefined && order.includes(requestedPaneId)
      ? requestedPaneId
      : workspace.focusedPaneId !== null && order.includes(workspace.focusedPaneId)
        ? workspace.focusedPaneId
        : order[0]

  if (paneId === undefined) {
    const created = nextPaneId(workspace)
    return {
      ...workspace,
      layout: { kind: 'leaf', paneId: created },
      panes: {
        ...workspace.panes,
        [created]: { id: created, tabs: [conversationId], activeTabId: conversationId },
      },
      focusedPaneId: created,
    }
  }

  const pane = workspace.panes[paneId]
  if (pane === undefined) return workspace
  return {
    ...workspace,
    panes: {
      ...workspace.panes,
      [paneId]: {
        ...pane,
        tabs: [...pane.tabs, conversationId],
        activeTabId: conversationId,
      },
    },
    focusedPaneId: paneId,
  }
}

export function activateTab(
  workspace: WorkspaceSnapshot,
  paneId: string,
  conversationId: string
): WorkspaceSnapshot {
  const pane = workspace.panes[paneId]
  if (!pane?.tabs.includes(conversationId)) return workspace
  if (workspace.focusedPaneId === paneId && pane.activeTabId === conversationId) return workspace
  return {
    ...workspace,
    panes: { ...workspace.panes, [paneId]: { ...pane, activeTabId: conversationId } },
    focusedPaneId: paneId,
  }
}

export function focusPane(workspace: WorkspaceSnapshot, paneId: string): WorkspaceSnapshot {
  if (!leafPaneIds(workspace.layout).includes(paneId) || workspace.focusedPaneId === paneId) {
    return workspace
  }
  return { ...workspace, focusedPaneId: paneId }
}

function withoutTab(pane: WorkspacePane, conversationId: string): WorkspacePane {
  const index = pane.tabs.indexOf(conversationId)
  if (index < 0) return pane
  const tabs = pane.tabs.filter((id) => id !== conversationId)
  const activeTabId =
    pane.activeTabId === conversationId
      ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
      : pane.activeTabId
  return { ...pane, tabs, activeTabId }
}

export function closeTab(
  workspace: WorkspaceSnapshot,
  paneId: string,
  conversationId: string
): WorkspaceSnapshot {
  const pane = workspace.panes[paneId]
  if (!pane?.tabs.includes(conversationId)) return workspace
  return normalizeWorkspace({
    ...workspace,
    panes: { ...workspace.panes, [paneId]: withoutTab(pane, conversationId) },
  })
}

function closeAllTabs(workspace: WorkspaceSnapshot, paneId: string): WorkspaceSnapshot {
  const pane = workspace.panes[paneId]
  if (pane === undefined) return workspace
  return normalizeWorkspace({
    ...workspace,
    panes: { ...workspace.panes, [paneId]: { ...pane, tabs: [], activeTabId: null } },
  })
}

/** Emptying a pane is what removes it: normalisation drops a leaf with no tabs. */
export function closePane(workspace: WorkspaceSnapshot, paneId: string): WorkspaceSnapshot {
  return closeAllTabs(workspace, paneId)
}

export function reorderTab(
  workspace: WorkspaceSnapshot,
  paneId: string,
  fromIndex: number,
  slotBefore: number
): WorkspaceSnapshot {
  const pane = workspace.panes[paneId]
  if (pane === undefined || fromIndex < 0 || fromIndex >= pane.tabs.length) return workspace
  const slot = Math.max(0, Math.min(slotBefore, pane.tabs.length))
  const tabs = [...pane.tabs]
  const [moved] = tabs.splice(fromIndex, 1)
  if (moved === undefined) return workspace
  const insertion = Math.max(0, Math.min(fromIndex < slot ? slot - 1 : slot, tabs.length))
  tabs.splice(insertion, 0, moved)
  if (tabs.every((id, index) => id === pane.tabs[index])) return workspace
  return { ...workspace, panes: { ...workspace.panes, [paneId]: { ...pane, tabs } } }
}

export function moveTab(
  workspace: WorkspaceSnapshot,
  conversationId: string,
  targetPaneId: string,
  slotBefore: number
): WorkspaceSnapshot {
  const source = tabLocation(workspace, conversationId)
  const target = workspace.panes[targetPaneId]
  if (source === null || target === undefined) return workspace
  if (source.paneId === targetPaneId) {
    return reorderTab(workspace, targetPaneId, source.index, slotBefore)
  }

  const sourcePane = workspace.panes[source.paneId]
  if (sourcePane === undefined) return workspace
  const targetTabs = [...target.tabs]
  targetTabs.splice(Math.max(0, Math.min(slotBefore, targetTabs.length)), 0, conversationId)
  return normalizeWorkspace({
    ...workspace,
    panes: {
      ...workspace.panes,
      [source.paneId]: withoutTab(sourcePane, conversationId),
      [targetPaneId]: { ...target, tabs: targetTabs, activeTabId: conversationId },
    },
    focusedPaneId: targetPaneId,
  })
}

function insertSplit(
  node: WorkspaceLayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection
): WorkspaceLayoutNode {
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node
    const orientation = direction === 'left' || direction === 'right' ? 'row' : 'column'
    const created: WorkspaceLayoutNode = { kind: 'leaf', paneId: newPaneId }
    const before = direction === 'left' || direction === 'up'
    return {
      kind: 'branch',
      orientation,
      children: before ? [created, node] : [node, created],
      sizes: [0.5, 0.5],
    }
  }
  return {
    ...node,
    children: node.children.map((child) => insertSplit(child, targetPaneId, newPaneId, direction)),
  }
}

/**
 * Moves one tab into a new editor group beside the target.
 *
 * Unlike VS Code documents, a live Chorus session cannot be shown twice. A
 * one-tab pane therefore cannot split itself: doing so would only move its sole
 * tab and normalization would collapse the empty source back away.
 */
export function splitTab(
  workspace: WorkspaceSnapshot,
  conversationId: string,
  targetPaneId: string,
  direction: SplitDirection,
  requestedNewPaneId?: string
): WorkspaceSnapshot {
  const source = tabLocation(workspace, conversationId)
  if (source === null || workspace.panes[targetPaneId] === undefined || workspace.layout === null) {
    return workspace
  }
  const sourcePane = workspace.panes[source.paneId]
  if (
    sourcePane === undefined ||
    (source.paneId === targetPaneId && sourcePane.tabs.length === 1)
  ) {
    return workspace
  }
  const paneCount = leafPaneIds(workspace.layout).length
  const sourceDisappears = sourcePane.tabs.length === 1
  if (paneCount + 1 - (sourceDisappears ? 1 : 0) > MAX_PANES) return workspace

  const newPaneId = requestedNewPaneId ?? nextPaneId(workspace)
  if (workspace.panes[newPaneId] !== undefined) return workspace
  return normalizeWorkspace({
    ...workspace,
    layout: insertSplit(workspace.layout, targetPaneId, newPaneId, direction),
    panes: {
      ...workspace.panes,
      [source.paneId]: withoutTab(sourcePane, conversationId),
      [newPaneId]: { id: newPaneId, tabs: [conversationId], activeTabId: conversationId },
    },
    focusedPaneId: newPaneId,
  })
}

/**
 * Put a session in a pane, whether or not it is already open.
 *
 * The rail and the drawer can drag a session that has no tab anywhere, which
 * `moveTab` cannot express — it starts by looking the tab up and gives up when
 * there isn't one. Splitting the difference at the call site would mean the
 * drag handler deciding which of two operations a drop is, and the invariant
 * that matters ("one live session appears once") would then live in a component.
 *
 * So it lives here. An open session moves; a closed one is inserted. Neither
 * path can produce two tabs for one conversation, because the moving path is
 * still `moveTab` and the inserting path only runs when there is no tab to find.
 */
export function placeSession(
  workspace: WorkspaceSnapshot,
  conversationId: string,
  targetPaneId: string,
  slotBefore: number
): WorkspaceSnapshot {
  if (tabLocation(workspace, conversationId) !== null) {
    return moveTab(workspace, conversationId, targetPaneId, slotBefore)
  }
  const target = workspace.panes[targetPaneId]
  if (target === undefined) return workspace
  const tabs = [...target.tabs]
  tabs.splice(Math.max(0, Math.min(slotBefore, tabs.length)), 0, conversationId)
  return {
    ...workspace,
    panes: {
      ...workspace.panes,
      [targetPaneId]: { ...target, tabs, activeTabId: conversationId },
    },
    focusedPaneId: targetPaneId,
  }
}

/**
 * Split a pane and put a session — open or not — in the new group.
 *
 * The four-pane ceiling is enforced here rather than by the caller, and the
 * arithmetic differs from `splitTab`'s: a closed session leaves no pane behind,
 * so nothing can disappear to make room. A fourth pane is therefore the last
 * one a rail drag can create, which is what the disabled drop target says.
 */
export function splitWithSession(
  workspace: WorkspaceSnapshot,
  conversationId: string,
  targetPaneId: string,
  direction: SplitDirection,
  requestedNewPaneId?: string
): WorkspaceSnapshot {
  if (tabLocation(workspace, conversationId) !== null) {
    return splitTab(workspace, conversationId, targetPaneId, direction, requestedNewPaneId)
  }
  if (workspace.panes[targetPaneId] === undefined || workspace.layout === null) return workspace
  if (leafPaneIds(workspace.layout).length + 1 > MAX_PANES) return workspace

  const newPaneId = requestedNewPaneId ?? nextPaneId(workspace)
  if (workspace.panes[newPaneId] !== undefined) return workspace
  return normalizeWorkspace({
    ...workspace,
    layout: insertSplit(workspace.layout, targetPaneId, newPaneId, direction),
    panes: {
      ...workspace.panes,
      [newPaneId]: { id: newPaneId, tabs: [conversationId], activeTabId: conversationId },
    },
    focusedPaneId: newPaneId,
  })
}

function updateBranch(
  node: WorkspaceLayoutNode,
  path: readonly number[],
  update: (branch: Extract<WorkspaceLayoutNode, { kind: 'branch' }>) => WorkspaceLayoutNode
): WorkspaceLayoutNode {
  if (path.length === 0) return node.kind === 'branch' ? update(node) : node
  if (node.kind !== 'branch') return node
  const [at, ...rest] = path
  if (at === undefined || node.children[at] === undefined) return node
  return {
    ...node,
    children: node.children.map((child, index) =>
      index === at ? updateBranch(child, rest, update) : child
    ),
  }
}

export function setBranchSizes(
  workspace: WorkspaceSnapshot,
  path: readonly number[],
  sizes: readonly number[]
): WorkspaceSnapshot {
  if (workspace.layout === null) return workspace
  return {
    ...workspace,
    layout: updateBranch(workspace.layout, path, (branch) =>
      sizes.length === branch.children.length
        ? { ...branch, sizes: normalizedSizes(sizes, sizes.length) }
        : branch
    ),
  }
}

export function equalizeBranch(
  workspace: WorkspaceSnapshot,
  path: readonly number[]
): WorkspaceSnapshot {
  if (workspace.layout === null) return workspace
  return {
    ...workspace,
    layout: updateBranch(workspace.layout, path, (branch) => ({
      ...branch,
      sizes: normalizedSizes([], branch.children.length),
    })),
  }
}

export function replaceSession(
  workspace: WorkspaceSnapshot,
  previousId: string,
  nextId: string
): WorkspaceSnapshot {
  const previous = tabLocation(workspace, previousId)
  if (previous === null || previousId === nextId) return workspace
  const alreadyOpen = tabLocation(workspace, nextId)
  if (alreadyOpen !== null) {
    return activateTab(closeTab(workspace, previous.paneId, previousId), alreadyOpen.paneId, nextId)
  }
  const pane = workspace.panes[previous.paneId]
  if (pane === undefined) return workspace
  return {
    ...workspace,
    panes: {
      ...workspace.panes,
      [pane.id]: {
        ...pane,
        tabs: pane.tabs.map((id) => (id === previousId ? nextId : id)),
        activeTabId: pane.activeTabId === previousId ? nextId : pane.activeTabId,
      },
    },
  }
}

/** Repairs a saved tree against the conversations the runtime actually restored. */
export function reconcileWorkspace(
  saved: WorkspaceSnapshot | null,
  conversationIds: readonly string[]
): WorkspaceSnapshot {
  const allowed = new Set(conversationIds)
  let workspace = normalizeWorkspace(saved ?? EMPTY_WORKSPACE)
  workspace = normalizeWorkspace({
    ...workspace,
    panes: Object.fromEntries(
      Object.entries(workspace.panes).map(([paneId, pane]) => [
        paneId,
        { ...pane, tabs: pane.tabs.filter((id) => allowed.has(id)) },
      ])
    ),
  })
  /*
   * Panels for conversations that no longer exist go too.
   *
   * Without this the map grows forever — every conversation ever ended leaves an
   * entry — and a new conversation that happened to reuse an id would inherit a
   * panel someone opened for a different one. The global panel is untouched by
   * any of this, which is the point of it being its own field.
   */
  workspace = {
    ...workspace,
    terminals: Object.fromEntries(
      Object.entries(workspace.terminals).filter(([conversationId]) => allowed.has(conversationId))
    ),
    // Changes panels are pruned on the same rule and for the same reason: the
    // map would otherwise keep an entry for every conversation ever ended.
    changes: Object.fromEntries(
      Object.entries(workspace.changes)
        .filter(([conversationId]) => allowed.has(conversationId))
        .map(([conversationId, panel]) => [conversationId, normalizeChangesPanel(panel)])
    ),
  }
  // A legacy file has no opinion about tabs, so preserve the old app's visible
  // launch by opening everything into one group. A v2 workspace does have an
  // opinion: a missing id is a deliberately closed view that must stay closed.
  if (saved === null) {
    for (const conversationId of conversationIds) workspace = openSession(workspace, conversationId)
  }
  return workspace
}
