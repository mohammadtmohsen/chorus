import {
  SIDEBAR_WIDTH,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WorkspaceSnapshot,
} from '../../../shared/workspace-layout.js'

/** Keeps a persisted or dragged width inside what the shell can actually show. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))
}

export type SplitDirection = 'left' | 'right' | 'up' | 'down'

/** Four readable editor groups; conversations beyond this remain available as tabs. */
export const MAX_PANES = 4

export const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  layout: null,
  panes: {},
  focusedPaneId: null,
  sidebarHidden: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
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

      const activeIndex =
        source.activeTabId === null ? -1 : source.tabs.indexOf(source.activeTabId)
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
  return { ...node, children: node.children.map((child) => insertSplit(child, targetPaneId, newPaneId, direction)) }
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
  if (sourcePane === undefined || (source.paneId === targetPaneId && sourcePane.tabs.length === 1)) {
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
  // A legacy file has no opinion about tabs, so preserve the old app's visible
  // launch by opening everything into one group. A v2 workspace does have an
  // opinion: a missing id is a deliberately closed view that must stay closed.
  if (saved === null) {
    for (const conversationId of conversationIds) workspace = openSession(workspace, conversationId)
  }
  return workspace
}
