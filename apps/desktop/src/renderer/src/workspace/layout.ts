import type { WorkbenchRect } from '../../../shared/workbench-ipc.js'
import { BrowserWebTabId } from '../../../shared/browser-ipc.js'
import {
  BOX_WIDTH,
  CONSOLE_WIDTH,
  EDITOR_WIDTH,
  MAIN_PROJECT_SHELL,
  NO_WEB_TABS,
  PROJECT_TERMINAL_WIDTH,
  SIDEBAR_WIDTH,
  TERMINAL_HEIGHT,
  TRAFFIC_WIDTH,
  WEB_TABS_MAX,
  type ConversationArrangement,
  type ProjectLayoutSlice,
  type ProjectTerminalPaneState,
  type ReturnSlot,
  type TerminalPanelState,
  type TerminalTab,
  type TrafficPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WorkspaceSnapshot,
  type WebTabsState,
} from '../../../shared/workspace-layout.js'

/** Matches the panel grip's own clamp: a floor only, no ceiling. */
export function clampTerminalHeight(height: number): number {
  if (!Number.isFinite(height)) return TERMINAL_HEIGHT.default
  return Math.round(Math.max(TERMINAL_HEIGHT.min, height))
}

/** Keeps a persisted or dragged width off the floor. There is no ceiling. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default
  return Math.round(Math.max(SIDEBAR_WIDTH.min, width))
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

export function normalizeWebTabs(webTabs: WebTabsState): WebTabsState {
  const seen = new Set<string>()
  const tabs = webTabs.tabs.filter((tab) => {
    if (
      seen.size >= WEB_TABS_MAX ||
      seen.has(tab.id) ||
      !BrowserWebTabId.safeParse(tab.id).success
    ) {
      return false
    }
    seen.add(tab.id)
    return true
  })
  const activeId =
    webTabs.activeId !== null && seen.has(webTabs.activeId)
      ? webTabs.activeId
      : (tabs[0]?.id ?? null)
  const showing = webTabs.showing && activeId !== null
  if (
    tabs.length === webTabs.tabs.length &&
    activeId === webTabs.activeId &&
    showing === webTabs.showing
  ) {
    return webTabs
  }
  return { tabs, activeId, showing }
}

export function topRightPaneId(node: WorkspaceLayoutNode | null): string | null {
  if (node === null) return null
  if (node.kind === 'leaf') return node.paneId
  const child = node.orientation === 'row' ? node.children.at(-1) : node.children.at(0)
  return child === undefined ? null : topRightPaneId(child)
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

export function normalizeProjectShells(shells: readonly TerminalTab[]): TerminalTab[] {
  const seen = new Set<string>()
  const kept = shells.filter((shell) => {
    if (shell.id === '' || seen.has(shell.id)) return false
    seen.add(shell.id)
    return true
  })
  return kept.length === 0 ? [{ id: MAIN_PROJECT_SHELL }] : kept
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
  // Empty means no project has been arranged; reconcile builds each from the
  // live conversation list. See the field's own note in the schema.
  conversationGroups: {},
  panes: {},
  focusedPaneId: null,
  sidebarHidden: true,
  sidebarWidth: SIDEBAR_WIDTH.default,
  terminals: {},
  globalTerminal: { open: false, height: TERMINAL_HEIGHT.default, tabs: [], activeId: null },
  trafficPanels: {},
  projectTerminals: {},
  collapsedBrowsers: {},
  collapsedWebsites: {},
  rowScroll: {},
  editorWidthFractions: {},
  consoleWidths: {},
  webTabs: NO_WEB_TABS,
}

export const DETACHED_PANE_ID = 'detached'

function withEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T | undefined
): Record<string, T> {
  const rest = Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key))
  return value === undefined ? rest : { ...rest, [key]: value }
}

export function sliceOf(workspace: WorkspaceSnapshot, projectId: string): ProjectLayoutSlice {
  return {
    conversationGroups: workspace.conversationGroups[projectId],
    trafficPanel: workspace.trafficPanels[projectId],
    projectTerminal: workspace.projectTerminals[projectId],
    browserCollapsed: workspace.collapsedBrowsers[projectId],
    websiteCollapsed: workspace.collapsedWebsites[projectId],
    rowScroll: workspace.rowScroll[projectId],
    editorWidthFraction: workspace.editorWidthFractions[projectId],
    consoleWidth: workspace.consoleWidths[projectId],
  }
}

export function mergeSlice(
  workspace: WorkspaceSnapshot,
  projectId: string,
  slice: ProjectLayoutSlice
): WorkspaceSnapshot {
  return {
    ...workspace,
    conversationGroups: withEntry(
      workspace.conversationGroups,
      projectId,
      slice.conversationGroups
    ),
    trafficPanels: withEntry(
      workspace.trafficPanels,
      projectId,
      slice.trafficPanel === undefined ? undefined : normalizeTrafficPanel(slice.trafficPanel)
    ),
    projectTerminals: withEntry(workspace.projectTerminals, projectId, slice.projectTerminal),
    collapsedBrowsers: withEntry(workspace.collapsedBrowsers, projectId, slice.browserCollapsed),
    collapsedWebsites: withEntry(workspace.collapsedWebsites, projectId, slice.websiteCollapsed),
    rowScroll: withEntry(workspace.rowScroll, projectId, slice.rowScroll),
    editorWidthFractions: withEntry(
      workspace.editorWidthFractions,
      projectId,
      slice.editorWidthFraction
    ),
    consoleWidths: withEntry(workspace.consoleWidths, projectId, slice.consoleWidth),
  }
}

export function detachedSnapshot(projectId: string, slice: ProjectLayoutSlice): WorkspaceSnapshot {
  return mergeSlice(
    {
      ...EMPTY_WORKSPACE,
      layout: { kind: 'leaf', paneId: DETACHED_PANE_ID },
      panes: {
        [DETACHED_PANE_ID]: { id: DETACHED_PANE_ID, tabs: [projectId], activeTabId: projectId },
      },
      focusedPaneId: DETACHED_PANE_ID,
    },
    projectId,
    slice
  )
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

export const PANE_MIN_PX = 320

export function resizeBranch(
  sizes: readonly number[],
  index: number,
  along: number,
  pairPx: number
): number[] {
  const shares = normalizedSizes(sizes, sizes.length)
  const before = shares[index]
  const after = shares[index + 1]
  if (before === undefined || after === undefined) return shares
  const pair = before + after
  if (pair <= 0) return shares
  const floor = pairPx > 0 ? Math.min(PANE_MIN_PX / pairPx, 0.5) : 0.5
  const first = pair * Math.min(Math.max(along, floor), 1 - floor)
  const next = [...shares]
  next[index] = first
  next[index + 1] = pair - first
  return next
}

export function leafPaneIds(layout: WorkspaceLayoutNode | null): string[] {
  if (layout === null) return []
  if (layout.kind === 'leaf') return [layout.paneId]
  return layout.children.flatMap(leafPaneIds)
}

export function tabLocation(
  workspace: PaneTree,
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
/**
 * A tree of panes, at either level.
 *
 * The workspace is one — panes holding project tabs — and a project's
 * conversation arrangement is another, holding conversation tabs. They were two
 * separate implementations for about an hour, and the instruction that ended
 * that was "exactly the same as project level": the only way to guarantee two
 * behaviours are the same is for them to be one behaviour, so every operation
 * below takes a `PaneTree` and returns the same object type it was given.
 *
 * **"Pane" therefore means "a container of tabs in a tree", not "one quarter of
 * the window".** At the inner level a pane is a conversation group. That is the
 * same word VS Code uses for both, and it is why nothing here is renamed: a
 * function that splits a tree does not care what the leaves hold.
 */
export interface PaneTree {
  readonly layout: WorkspaceLayoutNode | null
  readonly panes: Record<string, WorkspacePane>
  readonly focusedPaneId: string | null
}

/**
 * The tree half of `normalizeWorkspace`, which is all either level shares.
 *
 * Prunes panes the layout does not reach, drops duplicate tabs, collapses
 * branches with one child, merges same-orientation nesting and repairs sizes —
 * everything that is true of a tree regardless of what its tabs name. The
 * snapshot's own repairs (widths, terminal rosters) stay in
 * `normalizeWorkspace`, because a conversation arrangement has none of them.
 */
export function normalizeTree<T extends PaneTree>(workspace: T): T {
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

  /*
   * Spread, so every field this function knows nothing about survives it. That
   * is what lets one implementation serve both levels: the workspace keeps its
   * widths and rosters, a conversation arrangement keeps whatever it grows, and
   * neither has to be listed here.
   */
  return { ...workspace, layout, panes, focusedPaneId }
}

/** The workspace's own repairs, on top of the tree's. */
export function normalizeWorkspace(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  const tree = normalizeTree(workspace)
  return {
    ...tree,
    sidebarWidth: clampSidebarWidth(workspace.sidebarWidth),
    editorWidthFractions: Object.fromEntries(
      Object.entries(workspace.editorWidthFractions).flatMap<[string, number]>(
        ([projectId, value]) => {
          const fraction = clampEditorWidthFraction(value)
          return fraction === undefined ? [] : [[projectId, fraction]]
        }
      )
    ),
    consoleWidths: Object.fromEntries(
      Object.entries(workspace.consoleWidths).map(([projectId, width]) => [
        projectId,
        clampConsoleWidth(width),
      ])
    ),
    /*
     * Clamped on the way through, per project. A snapshot edited by hand or
     * written by an older build can hold anything, and an out-of-range width
     * here is a pane that cannot be dragged back.
     */
    trafficPanels: Object.fromEntries(
      Object.entries(workspace.trafficPanels).map(([projectId, panel]) => [
        projectId,
        normalizeTrafficPanel(panel),
      ])
    ),
    projectTerminals: Object.fromEntries(
      Object.entries(workspace.projectTerminals).map(([projectId, pane]) => [
        projectId,
        {
          ...pane,
          width: clampProjectTerminalWidth(pane.width),
          shells: normalizeProjectShells(pane.shells),
        },
      ])
    ),
    rowScroll: Object.fromEntries(
      Object.entries(workspace.rowScroll).filter(([, left]) => isRowScroll(left))
    ),
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
    webTabs: normalizeWebTabs(workspace.webTabs),
    // Repaired here for the same reason, and pruned by conversation in
    // `reconcileWorkspace` for the same reason too.
  }
}

function nextPaneId(workspace: PaneTree): string {
  let index = 1
  while (workspace.panes[`pane-${String(index)}`] !== undefined) index += 1
  return `pane-${String(index)}`
}

export function openSession<T extends PaneTree>(
  workspace: T,
  conversationId: string,
  requestedPaneId?: string
): T {
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

export function activateTab<T extends PaneTree>(
  workspace: T,
  paneId: string,
  conversationId: string
): T {
  const pane = workspace.panes[paneId]
  if (!pane?.tabs.includes(conversationId)) return workspace
  if (workspace.focusedPaneId === paneId && pane.activeTabId === conversationId) return workspace
  return {
    ...workspace,
    panes: { ...workspace.panes, [paneId]: { ...pane, activeTabId: conversationId } },
    focusedPaneId: paneId,
  }
}

export function focusPane<T extends PaneTree>(workspace: T, paneId: string): T {
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

export function closeTab<T extends PaneTree>(
  workspace: T,
  paneId: string,
  conversationId: string
): T {
  const pane = workspace.panes[paneId]
  if (!pane?.tabs.includes(conversationId)) return workspace
  return normalizeTree({
    ...workspace,
    panes: { ...workspace.panes, [paneId]: withoutTab(pane, conversationId) },
  })
}

function closeAllTabs<T extends PaneTree>(workspace: T, paneId: string): T {
  const pane = workspace.panes[paneId]
  if (pane === undefined) return workspace
  return normalizeTree({
    ...workspace,
    panes: { ...workspace.panes, [paneId]: { ...pane, tabs: [], activeTabId: null } },
  })
}

/** Emptying a pane is what removes it: normalisation drops a leaf with no tabs. */
export function closePane<T extends PaneTree>(workspace: T, paneId: string): T {
  return closeAllTabs(workspace, paneId)
}

export function reorderTab<T extends PaneTree>(
  workspace: T,
  paneId: string,
  fromIndex: number,
  slotBefore: number
): T {
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

export function moveTab<T extends PaneTree>(
  workspace: T,
  conversationId: string,
  targetPaneId: string,
  slotBefore: number
): T {
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
  return normalizeTree({
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
export function splitTab<T extends PaneTree>(
  workspace: T,
  conversationId: string,
  targetPaneId: string,
  direction: SplitDirection,
  requestedNewPaneId?: string
): T {
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
  return normalizeTree({
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
export function placeSession<T extends PaneTree>(
  workspace: T,
  conversationId: string,
  targetPaneId: string,
  slotBefore: number
): T {
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
export function splitWithSession<T extends PaneTree>(
  workspace: T,
  conversationId: string,
  targetPaneId: string,
  direction: SplitDirection,
  requestedNewPaneId?: string
): T {
  if (tabLocation(workspace, conversationId) !== null) {
    return splitTab(workspace, conversationId, targetPaneId, direction, requestedNewPaneId)
  }
  if (workspace.panes[targetPaneId] === undefined || workspace.layout === null) return workspace
  if (leafPaneIds(workspace.layout).length + 1 > MAX_PANES) return workspace

  const newPaneId = requestedNewPaneId ?? nextPaneId(workspace)
  if (workspace.panes[newPaneId] !== undefined) return workspace
  return normalizeTree({
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

export function setBranchSizes<T extends PaneTree>(
  workspace: T,
  path: readonly number[],
  sizes: readonly number[]
): T {
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

export function equalizeBranch<T extends PaneTree>(workspace: T, path: readonly number[]): T {
  if (workspace.layout === null) return workspace
  return {
    ...workspace,
    layout: updateBranch(workspace.layout, path, (branch) => ({
      ...branch,
      sizes: normalizedSizes([], branch.children.length),
    })),
  }
}

export function replaceSession<T extends PaneTree>(
  workspace: T,
  previousId: string,
  nextId: string
): T {
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
/**
 * A project's conversation groups, healed against what is actually running.
 *
 * The stored arrangement is a *preference*, never a source of truth about which
 * conversations exist. Sessions end while the app is closed, start from the
 * rail, and are restarted under new ids, so every entry here is a claim the live
 * list has to confirm. Two repairs, and the second is the one that matters:
 *
 *  1. **Drop what is gone**, then let `normalizeTree` do the rest — it already
 *     prunes leaves whose pane vanished, collapses single-child branches and
 *     repairs sizes, at both levels, because it is the same function.
 *  2. **Adopt what is new.** Anything running that no box holds gets a box of
 *     its own, beside the one with the caret — otherwise a conversation would
 *     exist with no way to reach it, which is the silent-loss failure the outer
 *     reconcile also guards.
 *
 * Returns `null` when the project has no conversations at all, so the caller can
 * omit the entry rather than persist an empty arrangement — absent means "never
 * arranged", and an empty record would claim otherwise.
 */
export function reconcileConversationGroups(
  saved: ConversationArrangement | undefined,
  conversationIds: readonly string[]
): ConversationArrangement | null {
  if (conversationIds.length === 0) return null
  const live = new Set(conversationIds)

  /*
   * `== null` rather than `=== null`, and it is the one place in this file that
   * wants loose equality: it has to catch both "no saved arrangement at all"
   * and "saved, but with no layout", which is exactly the pair `== null` means.
   * Writing `?.layout === null` instead would silently take the *else* branch
   * for an absent `saved` and read `panes` off nothing.
   */
  const seed: ConversationArrangement =
    saved?.layout == null
      ? EMPTY_ARRANGEMENT
      : {
          ...saved,
          panes: Object.fromEntries(
            Object.entries(saved.panes).map(([paneId, pane]) => [
              paneId,
              { ...pane, tabs: pane.tabs.filter((id) => live.has(id)) },
            ])
          ),
        }

  /*
   * Normalised *before* adoption, not after. Normalising drops panes whose tabs
   * have all gone, so doing it second would adopt new conversations into a box
   * that is about to be deleted and lose them — the arrangement would come back
   * with a conversation running and no tab anywhere.
   */
  let arrangement = normalizeTree(seed)
  const focus = arrangement.focusedPaneId
  const held = new Set(Object.values(arrangement.panes).flatMap((pane) => pane.tabs))
  for (const id of conversationIds) {
    if (held.has(id)) continue
    arrangement = openBox(arrangement, id, newGroupId())
    held.add(id)
  }

  return focus === null ? arrangement : normalizeTree({ ...arrangement, focusedPaneId: focus })
}

/**
 * The conversations on screen in this window, and **the only answer to that**.
 *
 * There were two, and they disagreed — which is the whole reason this exists.
 * The unread count asked `tabLocation` over the *outer* pane record and compared
 * the tab it found to a conversation id. That record's `activeTabId` names a
 * **project**, so the comparison could never be true: a conversation being read
 * counted as unseen for as long as the re-key that made a tab a project, and its
 * badge climbed while it was open. The notice path asked the inner level and got
 * it right. Two implementations of "what is on screen" is the defect; the
 * disagreement is only how it showed.
 *
 * **Both levels are required.** A conversation is on screen when its project is
 * the active tab of an outer pane *and* it is the active tab of one of that
 * project's groups. Either half alone overcounts: a conversation can be its
 * group's active tab while its project sits behind another tab, and a project
 * can be showing while its group is on a different conversation.
 *
 * Every pane counts rather than only the focused one, because every pane is
 * drawn.
 *
 * `reported` is what *another* window says it is showing. A detached window
 * renders one project in its own process and its own store answers for itself by
 * calling this with its own state; the window that owns the rail merges what
 * that one reports, so a conversation being read over there is not counted
 * unread over here.
 */
export function onScreenConversations(
  state: {
    readonly panes: Record<string, WorkspacePane>
    readonly conversationGroups: Record<string, ConversationArrangement>
    readonly webTabs: WebTabsState
  },
  reported: readonly string[] = []
): ReadonlySet<string> {
  const showing = new Set(reported)
  if (state.webTabs.showing) return showing
  for (const pane of Object.values(state.panes)) {
    const projectId = pane.activeTabId
    if (projectId === null) continue
    const arrangement = state.conversationGroups[projectId]
    if (arrangement === undefined) continue
    for (const group of Object.values(arrangement.panes)) {
      const active = group.activeTabId
      if (active !== null) showing.add(active)
    }
  }
  return showing
}

export const EMPTY_ARRANGEMENT: ConversationArrangement = {
  layout: null,
  panes: {},
  focusedPaneId: null,
}

export const CLOSED_TRAFFIC: TrafficPanelState = { open: false, width: TRAFFIC_WIDTH.default }

export function clampBoxWidth(width: number): number {
  if (!Number.isFinite(width)) return BOX_WIDTH.default
  return Math.round(Math.max(BOX_WIDTH.min, width))
}

export function clampTrafficWidth(width: number): number {
  if (!Number.isFinite(width)) return TRAFFIC_WIDTH.default
  return Math.round(Math.max(TRAFFIC_WIDTH.min, width))
}

export function clampConsoleWidth(width: number): number {
  if (!Number.isFinite(width)) return CONSOLE_WIDTH.default
  return Math.round(Math.max(CONSOLE_WIDTH.min, width))
}

export function normalizeTrafficPanel(panel: TrafficPanelState): TrafficPanelState {
  return {
    ...panel,
    width: panel.widthCustomized === true ? clampTrafficWidth(panel.width) : TRAFFIC_WIDTH.default,
  }
}

export const DEFAULT_PROJECT_TERMINAL: ProjectTerminalPaneState = {
  width: PROJECT_TERMINAL_WIDTH.default,
  shells: [{ id: MAIN_PROJECT_SHELL }],
}

export function clampProjectTerminalWidth(width: number): number {
  if (!Number.isFinite(width)) return PROJECT_TERMINAL_WIDTH.default
  return Math.round(Math.max(PROJECT_TERMINAL_WIDTH.min, width))
}

export function projectTerminalMinimum(shells: number): number {
  return Math.max(PROJECT_TERMINAL_WIDTH.run, shells > 0 ? PROJECT_TERMINAL_WIDTH.slot : 0)
}

export function projectTerminalWidth(pane: ProjectTerminalPaneState): number {
  return Math.max(pane.width, projectTerminalMinimum(pane.shells.length))
}

export function trafficColumnMinimum(terminalShells: number | null): number {
  return terminalShells === null
    ? TRAFFIC_WIDTH.min
    : Math.max(TRAFFIC_WIDTH.min, projectTerminalMinimum(terminalShells))
}

export function isRowScroll(left: number): boolean {
  return Number.isFinite(left)
}

export function clampEditorWidthFraction(fraction: number): number | undefined {
  return Number.isFinite(fraction) && fraction > 0
    ? Math.min(fraction, EDITOR_WIDTH.maxFraction)
    : undefined
}

export function clampEditorWidth(width: number, windowWidth: number): number {
  const maximum = Number.isFinite(windowWidth)
    ? Math.max(0, Math.floor(windowWidth * EDITOR_WIDTH.maxFraction))
    : 0
  const wanted = Number.isFinite(width) ? Math.round(width) : maximum - EDITOR_WIDTH.defaultOffset
  return Math.min(maximum, Math.max(EDITOR_WIDTH.min, wanted))
}

export function editorWidthIn(
  windowWidth: number,
  fraction?: number,
  paneWidth = windowWidth
): number {
  const saved = fraction === undefined ? undefined : clampEditorWidthFraction(fraction)
  const wanted =
    saved === undefined
      ? paneWidth - EDITOR_WIDTH.defaultOffset - ROW_DIVIDER_WIDTH
      : windowWidth * saved
  return clampEditorWidth(wanted, windowWidth)
}

export function clampActivityBar(reported: number, editorWidth: number, paneWidth: number): number {
  if (!Number.isFinite(reported)) return 0
  const available = Math.floor(Math.min(editorWidth, paneWidth) / 2)
  return Math.max(0, Math.min(Math.round(reported), available))
}

export const ROW_EDGE_INSET = 3

export const ROW_DIVIDER_WIDTH = 9

export const ROW_SCROLLBAR_STRIP = 12

export interface MeasuredBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export function editorViewport(
  bar: MeasuredBox,
  surface: MeasuredBox,
  scroller: MeasuredBox
): { readonly rect: WorkbenchRect; readonly layoutWidth: number | undefined } {
  const x = Math.round(bar.left)
  const y = Math.round(surface.top)
  const limit = Math.round(scroller.left + scroller.width) - ROW_EDGE_INSET
  const floor = Math.round(scroller.top + scroller.height) - ROW_SCROLLBAR_STRIP
  const barRight = Math.min(Math.round(bar.left + bar.width), limit)
  const right = Math.max(barRight, Math.min(Math.round(surface.left + surface.width), limit))
  const bottom = Math.min(Math.round(surface.top + surface.height), floor)
  const layoutWidth = Math.max(EDITOR_WIDTH.min, Math.max(0, right - x))
  return {
    rect: {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    },
    layoutWidth: limit - x >= 1 ? layoutWidth : undefined,
  }
}

export const BROWSER_FIT_TOLERANCE = 1

export function browserViewport(
  panel: MeasuredBox,
  body: MeasuredBox,
  scroller: MeasuredBox
): { readonly rect: WorkbenchRect; readonly fullyVisible: boolean } {
  const left = Math.round(scroller.left)
  const limit = Math.round(scroller.left + scroller.width) - ROW_EDGE_INSET
  const floor = Math.round(scroller.top + scroller.height) - ROW_SCROLLBAR_STRIP
  const x = Math.max(Math.round(body.left), left)
  const y = Math.round(body.top)
  const width = Math.max(0, Math.min(Math.round(body.left + body.width), limit) - x)
  const height = Math.max(0, Math.min(Math.round(body.top + body.height), floor) - y)
  const fits =
    panel.left >= scroller.left - BROWSER_FIT_TOLERANCE &&
    panel.left + panel.width <= scroller.left + scroller.width + BROWSER_FIT_TOLERANCE
  return { rect: { x, y, width, height }, fullyVisible: fits && width > 0 && height > 0 }
}

export function columnsOf(layout: WorkspaceLayoutNode | null): WorkspaceLayoutNode[] {
  if (layout === null) return []
  return layout.kind === 'branch' && layout.orientation === 'row' ? layout.children : [layout]
}

function columnIndexOf(layout: WorkspaceLayoutNode, paneId: string): number {
  return columnsOf(layout).findIndex((column) => leafPaneIds(column).includes(paneId))
}

function withColumn(
  layout: WorkspaceLayoutNode,
  column: WorkspaceLayoutNode,
  at: number
): WorkspaceLayoutNode {
  const children = [...columnsOf(layout)]
  children.splice(at, 0, column)
  return { kind: 'branch', orientation: 'row', children, sizes: children.map(() => 1) }
}

function placeBox<T extends PaneTree>(
  tree: T,
  box: WorkspacePane,
  targetPaneId: string,
  direction: SplitDirection
): T {
  if (tree.layout === null) return tree
  const panes = { ...tree.panes, [box.id]: box }
  if (direction === 'up' || direction === 'down') {
    return normalizeTree({
      ...tree,
      layout: insertSplit(tree.layout, targetPaneId, box.id, direction),
      panes,
      focusedPaneId: box.id,
    })
  }
  const at = columnIndexOf(tree.layout, targetPaneId)
  if (at < 0) return tree
  return normalizeTree({
    ...tree,
    layout: withColumn(
      tree.layout,
      { kind: 'leaf', paneId: box.id },
      direction === 'left' ? at : at + 1
    ),
    panes,
    focusedPaneId: box.id,
  })
}

export function openBox<T extends PaneTree>(tree: T, tabId: string, boxId: string): T {
  const existing = tabLocation(tree, tabId)
  if (existing !== null) return focusPane(tree, existing.paneId)
  const box: WorkspacePane = { id: boxId, tabs: [tabId], activeTabId: tabId }
  const leaves = leafPaneIds(tree.layout)
  const beside = leaves.find((id) => id === tree.focusedPaneId) ?? leaves.at(-1)
  if (tree.layout === null || beside === undefined) {
    return {
      ...tree,
      layout: { kind: 'leaf', paneId: boxId },
      panes: { [boxId]: box },
      focusedPaneId: boxId,
    }
  }
  return placeBox(tree, box, beside, 'right')
}

export function moveBox(
  arrangement: ConversationArrangement,
  boxId: string,
  targetPaneId: string,
  direction: SplitDirection
): ConversationArrangement {
  const box = arrangement.panes[boxId]
  if (box === undefined || boxId === targetPaneId || arrangement.layout === null) return arrangement
  if (
    arrangement.panes[targetPaneId] === undefined ||
    !leafPaneIds(arrangement.layout).includes(targetPaneId)
  )
    return arrangement
  const lifted = normalizeTree({
    ...arrangement,
    panes: { ...arrangement.panes, [boxId]: { ...box, tabs: [] } },
  })
  if (lifted.layout === null) return arrangement
  if (direction === 'left' || direction === 'right') {
    return placeBox(lifted, box, targetPaneId, direction)
  }
  return placeBox(
    { ...lifted, widths: withEntry(lifted.widths ?? {}, boxId, lifted.widths?.[targetPaneId]) },
    box,
    targetPaneId,
    direction
  )
}

export function columnWidths(arrangement: ConversationArrangement): number[] {
  return columnsOf(arrangement.layout).map((column) => {
    const first = leafPaneIds(column)[0]
    const stored = first === undefined ? undefined : arrangement.widths?.[first]
    return clampBoxWidth(stored ?? BOX_WIDTH.default)
  })
}

export function withColumnWidths(
  arrangement: ConversationArrangement,
  widths: readonly number[]
): ConversationArrangement {
  const columns = columnsOf(arrangement.layout)
  if (widths.length !== columns.length) return arrangement
  return {
    ...arrangement,
    widths: Object.fromEntries(
      columns.flatMap((column, index) =>
        leafPaneIds(column).map((id) => [id, clampBoxWidth(widths[index] ?? BOX_WIDTH.default)])
      )
    ),
  }
}

export function pushDivider(
  widths: readonly number[],
  index: number,
  delta: number,
  minimums: readonly number[] = widths.map(() => BOX_WIDTH.min)
): { widths: number[]; scroll: number } {
  const left = widths[index - 1]
  const right = widths[index]
  const next = [...widths]
  if (left === undefined || right === undefined) return { widths: next, scroll: 0 }
  if (delta >= 0) {
    next[index - 1] = left + delta
    return { widths: next, scroll: 0 }
  }
  const floor = minimums[index - 1] ?? BOX_WIDTH.min
  const shrunk = Math.min(-delta, Math.max(0, left - floor))
  const grown = -delta - shrunk
  next[index - 1] = left - shrunk
  next[index] = right + grown
  return { widths: next, scroll: grown }
}

function evened(node: WorkspaceLayoutNode): WorkspaceLayoutNode {
  if (node.kind === 'leaf') return node
  return {
    ...node,
    children: node.children.map(evened),
    sizes: node.children.map(() => 1 / node.children.length),
  }
}

export function resetBoxes(arrangement: ConversationArrangement): ConversationArrangement {
  return {
    ...arrangement,
    layout: arrangement.layout === null ? null : evened(arrangement.layout),
    widths: {},
  }
}

/**
 * A fresh group id. A UUID rather than a counter, for the reason `newTerminalId`
 * gives: the arrangement outlives the process, and a counter restarting at 1
 * reuses ids across a relaunch.
 */
export function newGroupId(): string {
  return crypto.randomUUID()
}

export function reconcileWorkspace(
  saved: WorkspaceSnapshot | null,
  conversationIds: readonly string[],
  projectIds: readonly string[],
  /**
   * Which conversations each project holds, which the two flat lists above
   * cannot express. Defaulted so the many existing callers and tests that only
   * care about panes keep compiling; the cost of omitting it is that every
   * project's column is rebuilt empty, which is exactly right for a caller that
   * has no conversations to place.
   */
  conversationsByProject: Readonly<Record<string, readonly string[]>> = {}
): WorkspaceSnapshot {
  /*
   * Two sets, because this function reconciles two different things and they
   * stopped being the same list when tabs were re-keyed.
   *
   * **Tabs are projects; panels are conversations.** Filtering tabs against
   * conversation ids discarded every tab on every launch — a saved layout could
   * not survive a restart — and seeding from conversation ids gave one tab per
   * conversation, so three conversations in one project opened as three
   * identical tabs. Both were silent: the app came up, looked plausible, and
   * had simply thrown the layout away.
   */
  const allowed = new Set(conversationIds)
  const allowedProjects = new Set(projectIds)
  let workspace = normalizeWorkspace(saved ?? EMPTY_WORKSPACE)
  workspace = normalizeWorkspace({
    ...workspace,
    panes: Object.fromEntries(
      Object.entries(workspace.panes).map(([paneId, pane]) => [
        paneId,
        { ...pane, tabs: pane.tabs.filter((id) => allowedProjects.has(id)) },
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
    editorWidthFractions: Object.fromEntries(
      Object.entries(workspace.editorWidthFractions).filter(([projectId]) =>
        allowedProjects.has(projectId)
      )
    ),
    consoleWidths: Object.fromEntries(
      Object.entries(workspace.consoleWidths).filter(([projectId]) =>
        allowedProjects.has(projectId)
      )
    ),
  }
  /*
   * A workspace with no saved opinion opens every **project** into one group.
   * One tab per project, however many conversations each holds — the dock is
   * what reaches the others. A saved workspace does have an opinion, and a
   * missing id there is a deliberately closed view that must stay closed.
   */
  if (saved === null) {
    for (const projectId of projectIds) workspace = openSession(workspace, projectId)
  }
  /*
   * Every project's conversation groups, rebuilt from the live list.
   *
   * Done last, and for **every** project rather than only the arranged ones: a
   * project with no stored arrangement still needs one built, because that is
   * what says which conversation its column shows. A project that has vanished
   * from `conversationsByProject` drops out here rather than being pruned
   * separately — `reconcileConversationGroups` returns null for an empty list
   * and the entry is simply not written.
   */
  const groups: Record<string, ConversationArrangement> = {}
  for (const projectId of new Set([
    ...Object.keys(conversationsByProject),
    ...Object.keys(workspace.conversationGroups),
  ])) {
    const arranged = reconcileConversationGroups(
      workspace.conversationGroups[projectId],
      conversationsByProject[projectId] ?? []
    )
    if (arranged !== null) groups[projectId] = arranged
  }
  return { ...workspace, conversationGroups: groups }
}

function insertTab(pane: WorkspacePane, tabId: string, index: number): WorkspacePane {
  const tabs = pane.tabs.filter((id) => id !== tabId)
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tabId)
  return { ...pane, tabs, activeTabId: pane.activeTabId ?? tabId }
}

function fallbackPane(workspace: WorkspaceSnapshot): WorkspacePane | undefined {
  return [workspace.focusedPaneId, ...leafPaneIds(workspace.layout)]
    .map((id) => (id === null ? undefined : workspace.panes[id]))
    .find((pane) => pane !== undefined)
}

function soleTab(workspace: WorkspaceSnapshot, paneId: string, tabId: string): WorkspaceSnapshot {
  return {
    ...workspace,
    layout: { kind: 'leaf', paneId },
    panes: { [paneId]: { id: paneId, tabs: [tabId], activeTabId: tabId } },
    focusedPaneId: paneId,
  }
}

export function withDetachedReturned(
  workspace: WorkspaceSnapshot,
  detached: Readonly<Record<string, ReturnSlot>>
): WorkspaceSnapshot {
  return Object.entries(detached)
    .sort(([, left], [, right]) => left.index - right.index)
    .reduce<WorkspaceSnapshot>((current, [projectId, slot]) => {
      const target = current.panes[slot.paneId] ?? fallbackPane(current)
      if (target === undefined) return soleTab(current, slot.paneId, projectId)
      const index = target.id === slot.paneId ? slot.index : target.tabs.length
      return {
        ...current,
        panes: { ...current.panes, [target.id]: insertTab(target, projectId, index) },
      }
    }, workspace)
}

export function detachTab(
  workspace: WorkspaceSnapshot,
  projectId: string,
  detached: Readonly<Record<string, ReturnSlot>>
): { readonly workspace: WorkspaceSnapshot; readonly slot: ReturnSlot } | null {
  const full = withDetachedReturned(workspace, detached)
  const pane = Object.values(full.panes).find((candidate) => candidate.tabs.includes(projectId))
  if (pane === undefined) return null
  return {
    workspace: closeTab(workspace, pane.id, projectId),
    slot: { paneId: pane.id, index: pane.tabs.indexOf(projectId) },
  }
}

export function returnTab(
  workspace: WorkspaceSnapshot,
  projectId: string,
  slot: ReturnSlot,
  detached: Readonly<Record<string, ReturnSlot>>
): WorkspaceSnapshot {
  if (workspace.panes[slot.paneId] !== undefined) {
    const before = Object.entries(detached).filter(
      ([id, other]) => id !== projectId && other.paneId === slot.paneId && other.index < slot.index
    ).length
    return placeSession(workspace, projectId, slot.paneId, slot.index - before)
  }
  const target = fallbackPane(workspace)
  if (target === undefined) return soleTab(workspace, slot.paneId, projectId)
  return placeSession(workspace, projectId, target.id, target.tabs.length)
}

export function applyDetachedEntries(
  workspace: WorkspaceSnapshot,
  entries: readonly { readonly projectId: string; readonly slice: ProjectLayoutSlice }[]
): WorkspaceSnapshot {
  return entries.reduce<WorkspaceSnapshot>((current, entry) => {
    const closed = Object.values(current.panes)
      .filter((pane) => pane.tabs.includes(entry.projectId))
      .reduce((next, pane) => closeTab(next, pane.id, entry.projectId), current)
    return mergeSlice(closed, entry.projectId, entry.slice)
  }, workspace)
}

export function virtualIndex(
  paneId: string,
  realIndex: number,
  detached: Readonly<Record<string, ReturnSlot>>
): number {
  return Object.values(detached)
    .filter((slot) => slot.paneId === paneId)
    .map((slot) => slot.index)
    .sort((left, right) => left - right)
    .reduce((index, taken) => (taken <= index ? index + 1 : index), realIndex)
}
