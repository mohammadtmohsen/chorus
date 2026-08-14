import { useSyncExternalStore } from 'react'

/**
 * A value two siblings share without their parent knowing about it.
 *
 * The rail and the drawer both need to know which session's preview is open and
 * whether the list is in Arrange mode. The obvious home for that is `Workspace`,
 * and it is the wrong one: `Workspace` renders every mounted pane, so putting
 * hover state there would re-render four live transcripts every time a pointer
 * crossed a row. That is the exact failure Phase 4 of the plan is about, so it
 * would be an odd thing to introduce in Phase 2.
 *
 * The store is the wrong home too. This is transient — it does not survive a
 * relaunch, nothing persists it, and a `WorkspaceSnapshot` field for "which row
 * is being hovered" would be written to disk.
 *
 * So: a value with subscribers, created once by `Workspace` in a ref and passed
 * down as a stable prop. Only the components that call `useSignal` re-render.
 */
export interface Signal<T> {
  get: () => T
  set: (next: T) => void
  subscribe: (listener: () => void) => () => void
}

export function createSignal<T>(initial: T): Signal<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.get, signal.get)
}
