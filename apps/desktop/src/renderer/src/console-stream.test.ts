import { describe, expect, it } from 'vitest'
import type {
  ConsoleEntry,
  ConsolePush,
  ConsoleResponse,
  ConsoleSnapshot,
} from '../../shared/console-ipc.js'
import { openConsoleLink, type ConsoleLinkApi, type ConsoleStream } from './console-stream.js'

const PROJECT = 'project-1'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function drain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function entry(seq: number, text: string): ConsoleEntry {
  return {
    id: `entry-${String(seq)}`,
    seq,
    at: 1_000 + seq,
    kind: 'console',
    level: 'log',
    method: 'log',
    actor: null,
    commandId: null,
    status: null,
    text,
    values: [],
    location: null,
    stack: [],
    url: null,
    cut: false,
  }
}

function snapshot(epoch: number, entries: ConsoleEntry[]): ConsoleSnapshot {
  return { projectId: PROJECT, epoch, entries, dropped: 0, history: [], sources: [] }
}

function fakeApi() {
  const listeners = new Set<(push: ConsolePush) => void>()
  const subscribes: Deferred<ConsoleResponse<'console:subscribe'>>[] = []
  const snapshots: {
    readonly subscriptionId: string
    readonly answer: Deferred<ConsoleResponse<'console:snapshot'>>
  }[] = []
  const acks: string[] = []
  const unsubscribed: string[] = []
  const api: ConsoleLinkApi = {
    subscribeConsole: () => {
      const answer = deferred<ConsoleResponse<'console:subscribe'>>()
      subscribes.push(answer)
      return answer.promise
    },
    unsubscribeConsole: ({ subscriptionId }) => {
      unsubscribed.push(subscriptionId)
      return Promise.resolve({ ok: true })
    },
    ackConsole: ({ subscriptionId }) => {
      acks.push(subscriptionId)
      return Promise.resolve({ ok: true })
    },
    snapshotConsole: ({ subscriptionId }) => {
      const answer = deferred<ConsoleResponse<'console:snapshot'>>()
      snapshots.push({ subscriptionId, answer })
      return answer.promise
    },
    onConsole: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const push = (value: ConsolePush): void => {
    for (const listener of [...listeners]) listener(value)
  }
  return { api, push, subscribes, snapshots, acks, unsubscribed }
}

function link(api: ConsoleLinkApi): {
  readonly streams: ConsoleStream[]
  readonly close: () => void
} {
  const streams: ConsoleStream[] = []
  const opened = openConsoleLink(api, PROJECT, {
    onStream: (stream) => {
      streams.push(stream)
    },
    onFailure: () => undefined,
  })
  return { streams, close: opened.close }
}

const texts = (streams: readonly ConsoleStream[]): string[] =>
  (streams.at(-1)?.entries ?? []).map((item) => item.text)

describe('openConsoleLink', () => {
  it('acknowledges the initial snapshot even when nothing was pushed', async () => {
    const fake = fakeApi()
    const { streams } = link(fake.api)
    fake.push({
      kind: 'entries',
      subscriptionId: 'someone-else',
      projectId: PROJECT,
      epoch: 1,
      entries: [entry(9, 'not mine')],
      dropped: 0,
    })
    fake.subscribes[0]?.resolve({ subscriptionId: 'sub-1', snapshot: snapshot(1, [entry(1, 'a')]) })
    await drain()
    expect(fake.acks).toEqual(['sub-1'])
    expect(texts(streams)).toEqual(['a'])
  })

  it('withholds the acknowledgement of a resync until the snapshot is applied', async () => {
    const fake = fakeApi()
    const { streams } = link(fake.api)
    fake.subscribes[0]?.resolve({ subscriptionId: 'sub-1', snapshot: snapshot(1, [entry(1, 'a')]) })
    await drain()
    fake.push({ kind: 'resync', subscriptionId: 'sub-1', projectId: PROJECT })
    expect(fake.acks).toEqual(['sub-1'])
    expect(fake.snapshots.map((call) => call.subscriptionId)).toEqual(['sub-1'])
    fake.snapshots[0]?.answer.resolve({ snapshot: snapshot(1, [entry(1, 'a'), entry(2, 'b')]) })
    await drain()
    expect(fake.acks).toEqual(['sub-1', 'sub-1'])
    fake.push({ kind: 'cleared', subscriptionId: 'sub-1', projectId: PROJECT, epoch: 2 })
    fake.push({
      kind: 'entries',
      subscriptionId: 'sub-1',
      projectId: PROJECT,
      epoch: 2,
      entries: [entry(3, 'after clear')],
      dropped: 0,
    })
    expect(texts(streams)).toEqual(['after clear'])
    expect(fake.acks).toHaveLength(4)
  })

  it('lets an old snapshot that answers after a remount change nothing', async () => {
    const fake = fakeApi()
    const first = link(fake.api)
    fake.subscribes[0]?.resolve({ subscriptionId: 'sub-1', snapshot: snapshot(1, []) })
    await drain()
    fake.push({ kind: 'resync', subscriptionId: 'sub-1', projectId: PROJECT })
    first.close()
    const second = link(fake.api)
    fake.subscribes[1]?.resolve({
      subscriptionId: 'sub-2',
      snapshot: snapshot(3, [entry(5, 'new')]),
    })
    await drain()
    const before = first.streams.length
    fake.snapshots[0]?.answer.resolve({ snapshot: snapshot(1, [entry(1, 'stale')]) })
    await drain()
    expect(first.streams).toHaveLength(before)
    expect(texts(second.streams)).toEqual(['new'])
    expect(fake.acks).toEqual(['sub-1', 'sub-2'])
    expect(fake.unsubscribed).toEqual(['sub-1'])
  })

  it('releases a subscription whose reply arrives after the view closed', async () => {
    const fake = fakeApi()
    const { streams, close } = link(fake.api)
    close()
    fake.subscribes[0]?.resolve({ subscriptionId: 'sub-1', snapshot: snapshot(1, [entry(1, 'a')]) })
    await drain()
    expect(fake.unsubscribed).toEqual(['sub-1'])
    expect(fake.acks).toEqual([])
    expect(texts(streams)).toEqual([])
  })
})
