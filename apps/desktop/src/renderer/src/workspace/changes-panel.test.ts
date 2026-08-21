import { describe, expect, it } from 'vitest'
import {
  CHANGES_HEIGHT,
  CHANGES_WIDTH,
  CLOSED_CHANGES_PANEL,
  WorkspaceSnapshot,
} from '../../../shared/workspace-layout.js'
import {
  EMPTY_WORKSPACE,
  normalizeChangesPanel,
  normalizeWorkspace,
  reconcileWorkspace,
} from './layout.js'
import { useWorkspaceStore, workspaceSnapshot } from './store.js'

/**
 * The Changes panel's state, at the two layers that can lose it.
 *
 * The schema half matters more than it looks: a *required* field on
 * `ChangesPanelState` sends `parseOpenSessions` down a legacy path that also
 * fails, and every open conversation disappears — the warning
 * `workspace-layout.ts` carries, which `terminals` earned the hard way. The
 * store half is the other end of the same rope: `snapshot()` is hand-written, so
 * a field it forgets is never persisted at all.
 */

function reset(): void {
  useWorkspaceStore.setState({ ...EMPTY_WORKSPACE, pulses: {}, planning: {}, hydrated: true })
}

describe('ChangesPanelState schema', () => {
  it('parses a workspace written before the panel existed', () => {
    // The upgrade case. If this ever fails, everyone's open conversations go.
    const legacy = {
      layout: null,
      panes: {},
      focusedPaneId: null,
    }
    const parsed = WorkspaceSnapshot.safeParse(legacy)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.changes).toEqual({})
  })

  it('defaults every field of a panel, so a partial entry cannot reject', () => {
    const parsed = WorkspaceSnapshot.safeParse({
      layout: null,
      panes: {},
      focusedPaneId: null,
      changes: { 'conv-1': {} },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.changes['conv-1']).toEqual(CLOSED_CHANGES_PANEL)
  })
})

describe('normalizeChangesPanel', () => {
  it('clamps a height a hand-edited file could hold', () => {
    expect(normalizeChangesPanel({ ...CLOSED_CHANGES_PANEL, height: 5000 }).height).toBe(
      CHANGES_HEIGHT.max
    )
    expect(normalizeChangesPanel({ ...CLOSED_CHANGES_PANEL, height: 1 }).height).toBe(
      CHANGES_HEIGHT.min
    )
    expect(normalizeChangesPanel({ ...CLOSED_CHANGES_PANEL, height: Number.NaN }).height).toBe(
      CHANGES_HEIGHT.default
    )
  })

  it('reads an empty base as the working tree rather than a branch named ""', () => {
    expect(normalizeChangesPanel({ ...CLOSED_CHANGES_PANEL, base: '' }).base).toBeNull()
    expect(
      normalizeChangesPanel({ ...CLOSED_CHANGES_PANEL, selectedPath: '' }).selectedPath
    ).toBeNull()
  })

  it('leaves a base it cannot check alone', () => {
    // Deliberately not validated against the repository: this is pure and git is
    // not. A deleted branch surfaces as a `problem` the panel shows.
    const panel = normalizeChangesPanel({ ...CLOSED_CHANGES_PANEL, base: 'origin/gone' })
    expect(panel.base).toBe('origin/gone')
  })

  it('repairs panels on the way through normalizeWorkspace', () => {
    const repaired = normalizeWorkspace({
      ...EMPTY_WORKSPACE,
      changes: { 'conv-1': { ...CLOSED_CHANGES_PANEL, height: 9999 } },
    })
    expect(repaired.changes['conv-1']?.height).toBe(CHANGES_HEIGHT.max)
  })
})

describe('reconcileWorkspace', () => {
  it('drops panels for conversations that no longer exist', () => {
    // Or the map grows for the life of the install, and a reused id inherits a
    // panel someone opened for a different conversation.
    const saved: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      changes: {
        alive: { ...CLOSED_CHANGES_PANEL, open: true },
        gone: { ...CLOSED_CHANGES_PANEL, open: true },
      },
    }
    const result = reconcileWorkspace(saved, ['alive'])
    expect(Object.keys(result.changes)).toEqual(['alive'])
  })
})

describe('store actions', () => {
  it('toggles one conversation and leaves the others alone', () => {
    reset()
    const { toggleSessionChanges } = useWorkspaceStore.getState()
    toggleSessionChanges('conv-1')
    expect(useWorkspaceStore.getState().changes['conv-1']?.open).toBe(true)
    expect(useWorkspaceStore.getState().changes['conv-2']).toBeUndefined()
    toggleSessionChanges('conv-1')
    expect(useWorkspaceStore.getState().changes['conv-1']?.open).toBe(false)
  })

  it('clears the selection when the base changes', () => {
    // The old selection belongs to the old comparison: a file that changed
    // against `develop` need not appear at all against `main`.
    reset()
    const store = useWorkspaceStore.getState()
    store.toggleSessionChanges('conv-1')
    store.setSessionChangesSelection('conv-1', 'src/a.ts')
    expect(useWorkspaceStore.getState().changes['conv-1']?.selectedPath).toBe('src/a.ts')

    store.setSessionChangesBase('conv-1', 'origin/develop')
    expect(useWorkspaceStore.getState().changes['conv-1']?.base).toBe('origin/develop')
    expect(useWorkspaceStore.getState().changes['conv-1']?.selectedPath).toBeNull()
  })

  it('clears the selection when committed-only changes', () => {
    reset()
    const store = useWorkspaceStore.getState()
    store.setSessionChangesSelection('conv-1', 'src/a.ts')
    store.setSessionChangesCommittedOnly('conv-1', true)
    expect(useWorkspaceStore.getState().changes['conv-1']?.committedOnly).toBe(true)
    expect(useWorkspaceStore.getState().changes['conv-1']?.selectedPath).toBeNull()
  })

  it('clamps a height through the normalizer, like every other panel edit', () => {
    reset()
    useWorkspaceStore.getState().setSessionChangesHeight('conv-1', 100_000)
    expect(useWorkspaceStore.getState().changes['conv-1']?.height).toBe(CHANGES_HEIGHT.max)
  })

  it('clamps a width the same way', () => {
    reset()
    useWorkspaceStore.getState().setSessionChangesWidth('conv-1', 100_000)
    expect(useWorkspaceStore.getState().changes['conv-1']?.width).toBe(CHANGES_WIDTH.max)
    useWorkspaceStore.getState().setSessionChangesWidth('conv-1', 10)
    expect(useWorkspaceStore.getState().changes['conv-1']?.width).toBe(CHANGES_WIDTH.min)
  })

  /**
   * The two sizes are independent, and that is the point of storing both.
   *
   * One number reused across the layouts would mean widening the panel beside
   * the transcript and finding the stacked layout had silently changed height —
   * a setting altered by a gesture that was never about it.
   */
  it('keeps the height and the width apart', () => {
    reset()
    const store = useWorkspaceStore.getState()
    store.setSessionChangesHeight('conv-1', 500)
    store.setSessionChangesWidth('conv-1', 600)
    expect(useWorkspaceStore.getState().changes['conv-1']?.height).toBe(500)
    expect(useWorkspaceStore.getState().changes['conv-1']?.width).toBe(600)
  })

  it('drops the panel when the conversation ends', () => {
    reset()
    const store = useWorkspaceStore.getState()
    store.toggleSessionChanges('conv-1')
    store.removeSession('conv-1')
    expect(useWorkspaceStore.getState().changes['conv-1']).toBeUndefined()
  })

  /**
   * The persistence half, and the reason this test exists at all.
   *
   * `snapshot()` in the store is hand-written while `SNAPSHOT_KEYS` is derived
   * from the schema — so a field added to one and not the other is written
   * nowhere, silently, and only shows up as "my panel does not survive a
   * relaunch". `terminals` shipped with exactly that bug once.
   */
  it('carries the panel into the persisted snapshot', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionChanges('conv-1')
    const persisted = workspaceSnapshot(useWorkspaceStore.getState())
    expect(persisted.changes['conv-1']?.open).toBe(true)
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(WorkspaceSnapshot.shape).sort())
  })
})
