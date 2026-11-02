import {
  CONSOLE_ENTRIES_MAX,
  CONSOLE_HISTORY_MAX,
  type ConsoleApi,
  type ConsoleEntry,
  type ConsoleLevel,
  type ConsolePush,
  type ConsoleSnapshot,
  type ConsoleSource,
  type ConsoleState,
} from '../../shared/console-ipc.js'

export interface ConsoleStream {
  readonly subscriptionId: string
  readonly epoch: number
  readonly lastSeq: number
  readonly entries: readonly ConsoleEntry[]
  readonly dropped: number
  readonly history: readonly string[]
  readonly sources: readonly ConsoleSource[]
  readonly needsSnapshot: boolean
}

export const EMPTY_CONSOLE: ConsoleStream = {
  subscriptionId: '',
  epoch: 0,
  lastSeq: 0,
  entries: [],
  dropped: 0,
  history: [],
  sources: [],
  needsSnapshot: false,
}

const windowed = (entries: readonly ConsoleEntry[]): readonly ConsoleEntry[] =>
  entries.length <= CONSOLE_ENTRIES_MAX
    ? entries
    : entries.slice(entries.length - CONSOLE_ENTRIES_MAX)

const remembered = (history: readonly string[], entries: readonly ConsoleEntry[]): string[] => {
  const next = [...history]
  for (const entry of entries) {
    if (entry.kind !== 'command' || entry.actor !== 'user' || entry.text === '') continue
    if (next.at(-1) !== entry.text) next.push(entry.text)
  }
  return next.length <= CONSOLE_HISTORY_MAX ? next : next.slice(next.length - CONSOLE_HISTORY_MAX)
}

export function fromSnapshot(subscriptionId: string, snapshot: ConsoleSnapshot): ConsoleStream {
  const entries = windowed(snapshot.entries)
  return {
    subscriptionId,
    epoch: snapshot.epoch,
    lastSeq: entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0),
    entries,
    dropped: snapshot.dropped,
    history: snapshot.history,
    sources: snapshot.sources,
    needsSnapshot: false,
  }
}

export function reduceConsole(state: ConsoleStream, push: ConsolePush): ConsoleStream {
  if (state.subscriptionId === '' || push.subscriptionId !== state.subscriptionId) return state
  switch (push.kind) {
    case 'resync':
      return { ...state, needsSnapshot: true }
    case 'cleared':
      if (push.epoch < state.epoch) return state
      return { ...state, epoch: push.epoch, entries: [], dropped: 0 }
    case 'state':
      return { ...state, sources: push.sources, dropped: push.dropped }
    case 'entries': {
      if (push.epoch < state.epoch) return state
      if (push.epoch > state.epoch) return { ...state, needsSnapshot: true }
      const fresh = push.entries.filter((entry) => entry.seq > state.lastSeq)
      if (fresh.length === 0) return { ...state, dropped: push.dropped }
      return {
        ...state,
        lastSeq: fresh.reduce((highest, entry) => Math.max(highest, entry.seq), state.lastSeq),
        entries: windowed([...state.entries, ...fresh]),
        dropped: push.dropped,
        history: remembered(state.history, fresh),
      }
    }
  }
}

export type ConsoleLinkApi = Pick<
  ConsoleApi,
  'subscribeConsole' | 'unsubscribeConsole' | 'ackConsole' | 'snapshotConsole' | 'onConsole'
>

export interface ConsoleLinkHandlers {
  readonly onStream: (stream: ConsoleStream) => void
  readonly onFailure: (failed: boolean) => void
}

export function openConsoleLink(
  api: ConsoleLinkApi,
  projectId: string,
  handlers: ConsoleLinkHandlers
): { readonly close: () => void } {
  let open = true
  let subscriptionId: string | null = null
  let latest = EMPTY_CONSOLE
  let snapshotting = false
  const apply = (next: ConsoleStream): void => {
    latest = next
    handlers.onStream(next)
  }
  const acknowledge = (id: string): void => {
    api.ackConsole({ subscriptionId: id }).catch(() => undefined)
  }
  const resnapshot = (id: string): void => {
    if (snapshotting) return
    snapshotting = true
    api
      .snapshotConsole({ subscriptionId: id })
      .then((reply) => {
        snapshotting = false
        if (!open || subscriptionId !== id) return
        apply(fromSnapshot(id, reply.snapshot))
        acknowledge(id)
      })
      .catch(() => {
        snapshotting = false
        if (open && subscriptionId === id) handlers.onFailure(true)
      })
  }
  const stop = api.onConsole((push) => {
    if (!open || subscriptionId === null || push.subscriptionId !== subscriptionId) return
    if (snapshotting) return
    const next = reduceConsole(latest, push)
    apply(next)
    if (next.needsSnapshot) resnapshot(subscriptionId)
    else acknowledge(subscriptionId)
  })
  apply(EMPTY_CONSOLE)
  handlers.onFailure(false)
  api
    .subscribeConsole({ projectId })
    .then((reply) => {
      if (!open) {
        api.unsubscribeConsole({ subscriptionId: reply.subscriptionId }).catch(() => undefined)
        return
      }
      subscriptionId = reply.subscriptionId
      apply(fromSnapshot(reply.subscriptionId, reply.snapshot))
      acknowledge(reply.subscriptionId)
    })
    .catch(() => {
      if (open) handlers.onFailure(true)
    })
  return {
    close: () => {
      open = false
      stop()
      if (subscriptionId === null) return
      api.unsubscribeConsole({ subscriptionId }).catch(() => undefined)
    },
  }
}

export function sourceState(stream: ConsoleStream, browserId: string | null): ConsoleState {
  if (browserId === null) return 'no-page'
  return stream.sources.find((source) => source.browserId === browserId)?.state ?? 'no-page'
}

export function pendingCommands(entries: readonly ConsoleEntry[]): ReadonlySet<string> {
  const pending = new Set<string>()
  for (const entry of entries) {
    if (entry.commandId === null) continue
    if (entry.kind === 'command') pending.add(entry.commandId)
    else if (entry.kind === 'result') pending.delete(entry.commandId)
  }
  return pending
}

export function visibleEntries(
  entries: readonly ConsoleEntry[],
  levels: ReadonlySet<ConsoleLevel>,
  text: string
): readonly ConsoleEntry[] {
  const needle = text.trim().toLowerCase()
  return entries.filter(
    (entry) =>
      levels.has(entry.level) && (needle === '' || entry.text.toLowerCase().includes(needle))
  )
}

export function recall(
  history: readonly string[],
  index: number | null,
  direction: -1 | 1
): { readonly index: number | null; readonly text: string | null } {
  if (history.length === 0) return { index, text: null }
  if (direction < 0) {
    const next = index === null ? history.length - 1 : Math.max(0, index - 1)
    return { index: next, text: history[next] ?? null }
  }
  if (index === null) return { index: null, text: null }
  const next = index + 1
  return next >= history.length
    ? { index: null, text: '' }
    : { index: next, text: history[next] ?? null }
}

export function clockOf(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => pad(part, 2))
    .join(':')
  return `${clock}.${pad(date.getMilliseconds(), 3)}`
}

export function placeOf(url: string, line: number, column: number): string {
  let name: string
  try {
    const parsed = new URL(url)
    name =
      parsed.pathname
        .split('/')
        .filter((part) => part !== '')
        .at(-1) ?? parsed.host
  } catch {
    name = url
  }
  return `${name === '' ? '(anonymous)' : name}:${String(line)}:${String(column)}`
}
