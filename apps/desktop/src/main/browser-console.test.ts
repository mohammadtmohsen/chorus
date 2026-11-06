import { electronBrowserSource, electronBrowserSourceOf } from './electron-browser-source.js'
import { electronShellClient } from './electron-shell-client.js'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserConsoles,
  CONSOLE_AGENT_BYTES,
  CONSOLE_AGENT_ROW_MAX,
  CONSOLE_PAGE_RATE,
  CONSOLE_PENDING_MAX,
  type ConsoleServiceEvent,
} from './browser-console.js'

type Reply = (params: unknown) => unknown

const ROOT_FRAME = 'frame-root'

class FakeDebugger extends EventEmitter {
  attached = false
  readonly sent: { readonly method: string; readonly params: unknown }[] = []
  readonly replies = new Map<string, Reply>()

  attach(): void {
    this.attached = true
  }

  isAttached(): boolean {
    return this.attached
  }

  detach(): void {
    this.attached = false
  }

  sendCommand(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params })
    const reply = this.replies.get(method)
    return Promise.resolve(reply === undefined ? {} : reply(params))
  }
}

class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  destroyed = false
  devtools = false
  url = 'http://localhost:5173/'

  constructor() {
    super()
    this.debugger.replies.set('Page.getFrameTree', () => ({
      frameTree: { frame: { id: ROOT_FRAME } },
    }))
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isDevToolsOpened(): boolean {
    return this.devtools
  }

  getURL(): string {
    return this.url
  }
}

interface Deferred {
  readonly promise: Promise<unknown>
  readonly resolve: (value: unknown) => void
}

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function asContents(value: object): WebContents {
  return value as unknown as WebContents
}

function emit(contents: FakeContents, method: string, params: unknown): void {
  contents.debugger.emit('message', {}, method, params, '')
}

function context(contents: FakeContents, id: number, frameId: string): void {
  emit(contents, 'Runtime.executionContextCreated', {
    context: { id, uniqueId: `unique-${String(id)}`, auxData: { isDefault: true, frameId } },
  })
}

function log(
  contents: FakeContents,
  text: string,
  timestamp: number,
  objectId?: string,
  contextId?: number
): void {
  const args: unknown[] = [{ type: 'string', value: text }]
  if (objectId !== undefined) {
    args.push({ type: 'object', objectId, className: 'Object', description: 'Object' })
  }
  emit(contents, 'Runtime.consoleAPICalled', {
    type: 'log',
    args,
    timestamp,
    ...(contextId === undefined ? {} : { executionContextId: contextId }),
  })
}

function methods(contents: FakeContents): string[] {
  return contents.debugger.sent.map((command) => command.method)
}

function evaluated(contents: FakeContents): unknown[] {
  return contents.debugger.sent
    .filter((command) => command.method === 'Runtime.evaluate')
    .map((command) => command.params)
}

const PROJECT = 'project-1'

async function setup(): Promise<{
  readonly consoles: BrowserConsoles
  readonly contents: FakeContents
  readonly owner: WebContents
  readonly events: ConsoleServiceEvent[]
  readonly prefer: (owner: WebContents | null) => void
}> {
  const owner = asContents({ id: 1 })
  const contents = new FakeContents()
  let preferred: WebContents | null = owner
  const consoles = new BrowserConsoles({
    preferredOwner: () => (preferred === null ? null : electronShellClient(preferred)),
    now: () => 5_000,
  })
  const events: ConsoleServiceEvent[] = []
  consoles.subscribe((event) => {
    events.push(event)
  })
  consoles.mount(
    electronBrowserSource({
      browserId: 'browser-1',
      projectId: PROJECT,
      owner,
      contents: asContents(contents),
    })
  )
  await drain()
  context(contents, 1, ROOT_FRAME)
  await drain()
  return {
    consoles,
    contents,
    owner,
    events,
    prefer: (next) => {
      preferred = next
    },
  }
}

function human(owner: WebContents, expression: string) {
  return {
    projectId: PROJECT,
    browserId: 'browser-1',
    owner: electronShellClient(owner),
    expression,
    actor: 'user' as const,
    timeoutMs: 30_000,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserConsoles capture', () => {
  it('captures formatted output with an opaque handle instead of a raw object id', async () => {
    const { consoles, contents } = await setup()
    emit(contents, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [
        { type: 'string', value: 'count %d' },
        { type: 'number', value: 3.7, description: '3.7' },
        {
          type: 'object',
          objectId: 'raw-object-1',
          className: 'Object',
          description: 'Object',
          preview: {
            type: 'object',
            overflow: false,
            properties: [{ name: 'a', type: 'number', value: '1' }],
          },
        },
      ],
      timestamp: 1_000,
      stackTrace: {
        callFrames: [
          {
            functionName: 'main',
            url: 'http://localhost:5173/app.js',
            lineNumber: 9,
            columnNumber: 4,
          },
        ],
      },
    })
    const snapshot = consoles.snapshot(PROJECT)
    const entry = snapshot.entries[0]
    expect(snapshot.entries).toHaveLength(1)
    expect(entry?.text).toBe('count 3 {a: 1}')
    expect(entry?.location).toEqual({ url: 'http://localhost:5173/app.js', line: 10, column: 5 })
    expect(entry?.values[2]?.handle).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry?.cut).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('raw-object-1')
  })

  it('counts output beyond the page rate as dropped instead of storing it', async () => {
    const { consoles, contents } = await setup()
    for (let index = 0; index < CONSOLE_PAGE_RATE + 10; index += 1) {
      log(contents, `line ${String(index)}`, 1_000 + index)
    }
    const snapshot = consoles.snapshot(PROJECT)
    expect(snapshot.entries).toHaveLength(CONSOLE_PAGE_RATE)
    expect(snapshot.dropped).toBe(10)
  })
})

describe('BrowserConsoles evaluation', () => {
  it('waits for the root frame’s default context and always pins evaluation to it', async () => {
    const owner = asContents({ id: 1 })
    const contents = new FakeContents()
    const consoles = new BrowserConsoles({
      preferredOwner: () => electronShellClient(owner),
      now: () => 5_000,
    })
    consoles.mount(
      electronBrowserSource({
        browserId: 'browser-1',
        projectId: PROJECT,
        owner,
        contents: asContents(contents),
      })
    )
    await drain()
    context(contents, 7, 'frame-child')
    await drain()
    expect(consoles.evaluate(human(owner, '1 + 1')).status).toBe('connecting')
    expect(evaluated(contents)).toEqual([])
    context(contents, 1, ROOT_FRAME)
    await drain()
    expect(consoles.evaluate(human(owner, '1 + 1')).status).toBe('started')
    expect(evaluated(contents)).toEqual([
      expect.objectContaining({ uniqueContextId: 'unique-1', replMode: true }),
    ])
  })

  it('does not let a reply that arrives after Clear repopulate the console', async () => {
    const { consoles, contents, owner } = await setup()
    log(contents, 'before clear', 1_000)
    const before = consoles.snapshot(PROJECT).epoch
    const evaluation = deferred()
    contents.debugger.replies.set('Runtime.evaluate', () => evaluation.promise)
    const launch = consoles.evaluate(human(owner, 'await later()'))
    expect(launch.status).toBe('started')
    consoles.clear(PROJECT)
    const outcome = await launch.done
    expect(outcome?.status).toBe('cleared')
    evaluation.resolve({ result: { type: 'object', objectId: 'late-1', description: 'Object' } })
    await drain()
    const snapshot = consoles.snapshot(PROJECT)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.epoch).toBeGreaterThan(before)
    expect(methods(contents)).toContain('Runtime.discardConsoleEntries')
    const group = `chorus-${launch.commandId ?? ''}`
    const releases = contents.debugger.sent.filter(
      (command) =>
        command.method === 'Runtime.releaseObjectGroup' &&
        JSON.stringify(command.params).includes(group)
    )
    expect(releases.length).toBeGreaterThanOrEqual(2)
  })

  it('interrupts pending work and expires handles when the document is replaced', async () => {
    const { consoles, contents, owner } = await setup()
    log(contents, 'value', 1_000, 'raw-object-2', 1)
    const handle = consoles.snapshot(PROJECT).entries[0]?.values[1]?.handle ?? ''
    expect(handle).not.toBe('')
    contents.debugger.replies.set('Runtime.evaluate', () => deferred().promise)
    const launch = consoles.evaluate(human(owner, 'location.reload()'))
    emit(contents, 'Runtime.executionContextsCleared', {})
    const outcome = await launch.done
    expect(outcome?.status).toBe('interrupted')
    expect(await consoles.expand(PROJECT, handle)).toEqual({ status: 'gone' })
    const results = consoles.snapshot(PROJECT).entries.filter((entry) => entry.kind === 'result')
    expect(results.map((entry) => entry.status)).toEqual(['interrupted'])
    expect(methods(contents)).not.toContain('Runtime.getProperties')
  })

  it('survives an iframe context ending and interrupts when the root context ends', async () => {
    const { consoles, contents, owner } = await setup()
    context(contents, 9, 'frame-child')
    log(contents, 'from frame', 1_000, 'frame-object', 9)
    log(contents, 'from page', 1_001, 'page-object', 1)
    const [frameEntry, pageEntry] = consoles.snapshot(PROJECT).entries
    contents.debugger.replies.set('Runtime.evaluate', () => deferred().promise)
    const launch = consoles.evaluate(human(owner, 'await never()'))
    emit(contents, 'Runtime.executionContextDestroyed', { executionContextId: 9 })
    await drain()
    expect(await consoles.expand(PROJECT, frameEntry?.values[1]?.handle ?? '')).toEqual({
      status: 'gone',
    })
    expect(consoles.page(PROJECT)?.state).toBe('ready')
    emit(contents, 'Runtime.executionContextDestroyed', { executionContextId: 1 })
    const outcome = await launch.done
    expect(outcome?.status).toBe('interrupted')
    expect(await consoles.expand(PROJECT, pageEntry?.values[1]?.handle ?? '')).toEqual({
      status: 'gone',
    })
    expect(consoles.page(PROJECT)?.state).toBe('connecting')
  })

  it('refuses a human command aimed at another window or project', async () => {
    const { consoles, contents, owner } = await setup()
    expect(
      consoles.evaluate({
        ...human(owner, '1 + 1'),
        owner: electronShellClient(asContents({ id: 2 })),
      })
    ).toEqual({
      commandId: null,
      status: 'no-page',
      done: null,
    })
    expect(consoles.evaluate({ ...human(owner, '1 + 1'), projectId: 'project-2' })).toEqual({
      commandId: null,
      status: 'no-page',
      done: null,
    })
    expect(evaluated(contents)).toEqual([])
  })

  it('sends agent commands to the page in the window that owns the project', async () => {
    const { consoles, contents, prefer } = await setup()
    const detachedOwner = asContents({ id: 3 })
    const detached = new FakeContents()
    consoles.mount(
      electronBrowserSource({
        browserId: 'browser-2',
        projectId: PROJECT,
        owner: detachedOwner,
        contents: asContents(detached),
      })
    )
    await drain()
    context(detached, 1, ROOT_FRAME)
    await drain()
    prefer(detachedOwner)
    await consoles.run(PROJECT, { expression: 'document.title', timeoutMs: 1_000, actor: 'codex' })
    expect(evaluated(detached)).toHaveLength(1)
    expect(evaluated(contents)).toEqual([])
  })
})

describe('BrowserConsoles lifecycle', () => {
  it('pauses while DevTools holds the debugger and skips replayed messages on return', async () => {
    const { consoles, contents } = await setup()
    log(contents, 'first', 1_000)
    contents.devtools = true
    contents.debugger.attached = false
    contents.debugger.emit('detach', {}, 'replaced')
    expect(consoles.page(PROJECT)?.state).toBe('paused')
    contents.devtools = false
    contents.debugger.replies.set('Runtime.enable', () => {
      context(contents, 2, ROOT_FRAME)
      log(contents, 'first', 1_000)
      log(contents, 'second', 2_000)
      return {}
    })
    contents.emit('devtools-closed')
    await drain()
    expect(consoles.page(PROJECT)?.state).toBe('ready')
    expect(consoles.snapshot(PROJECT).entries.map((entry) => entry.text)).toEqual([
      'first',
      'second',
    ])
  })

  it('disposes a project completely so late page events cannot recreate it', async () => {
    const { consoles, contents, events } = await setup()
    log(contents, 'kept until disposal', 1_000, 'raw-object-3', 1)
    const handle = consoles.snapshot(PROJECT).entries[0]?.values[1]?.handle ?? ''
    consoles.dispose(PROJECT)
    expect(contents.debugger.attached).toBe(false)
    expect(contents.debugger.listenerCount('message')).toBe(0)
    expect(contents.listenerCount('did-navigate')).toBe(0)
    expect(await consoles.expand(PROJECT, handle)).toEqual({ status: 'gone' })
    events.length = 0
    log(contents, 'too late', 2_000)
    contents.emit('did-navigate', {}, 'http://localhost:5173/next')
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([])
    expect(consoles.page(PROJECT)).toBeNull()
  })

  it('keeps output when a project page is remounted', async () => {
    const { consoles, contents, owner } = await setup()
    log(contents, 'before remount', 1_000)
    consoles.release(electronBrowserSourceOf(asContents(contents)))
    const next = new FakeContents()
    consoles.mount(
      electronBrowserSource({
        browserId: 'browser-3',
        projectId: PROJECT,
        owner,
        contents: asContents(next),
      })
    )
    expect(consoles.snapshot(PROJECT).entries.map((entry) => entry.text)).toEqual([
      'before remount',
    ])
  })
})

describe('BrowserConsoles inspection and agent reads', () => {
  it('shows the first indexed values of a long array without invoking getters', async () => {
    const { consoles, contents, owner } = await setup()
    contents.debugger.replies.set('Runtime.evaluate', () => ({
      result: {
        type: 'object',
        subtype: 'array',
        className: 'Array',
        description: 'Array(500)',
        objectId: 'array-1',
      },
    }))
    const launch = consoles.evaluate(human(owner, 'big'))
    await launch.done
    const handle =
      consoles.snapshot(PROJECT).entries.find((entry) => entry.kind === 'result')?.values[0]
        ?.handle ?? ''
    contents.debugger.replies.set('Runtime.getProperties', () => ({
      result: [
        ...Array.from({ length: 500 }, (_, index) => ({
          name: String(index),
          value: { type: 'number', value: index, description: String(index) },
          enumerable: true,
        })),
        { name: 'length', value: { type: 'number', value: 500, description: '500' } },
        { name: 'size', get: { type: 'function', objectId: 'getter-1', description: 'get size' } },
      ],
      internalProperties: [
        {
          name: '[[Prototype]]',
          value: { type: 'object', objectId: 'proto', description: 'Array' },
        },
      ],
    }))
    const expansion = await consoles.expand(PROJECT, handle)
    expect(expansion.status).toBe('ok')
    if (expansion.status !== 'ok') return
    const names = expansion.properties.map((property) => property.name)
    expect(names[0]).toBe('0')
    expect(names).toContain('length')
    expect(names).toContain('[[Prototype]]')
    expect(expansion.properties.find((property) => property.name === 'size')?.value.type).toBe(
      'accessor'
    )
    expect(expansion.total).toBe(503)
    expect(expansion.omittedIndexed).toBe(500 - (expansion.properties.length - 3))
    const options = contents.debugger.sent.find(
      (command) => command.method === 'Runtime.getProperties'
    )?.params
    expect(options).toEqual(expect.objectContaining({ ownProperties: true }))
    expect(options).not.toEqual(expect.objectContaining({ nonIndexedPropertiesOnly: true }))
  })

  it('reports truncated rows in an agent read', async () => {
    const { consoles, contents } = await setup()
    log(contents, 'x'.repeat(CONSOLE_AGENT_ROW_MAX + 50), 1_000)
    const read = JSON.parse(consoles.read(PROJECT, { count: 10, skip: 0 })) as {
      readonly cut: boolean
      readonly omitted: number
      readonly page: { readonly state: string } | null
      readonly rows: readonly { readonly cut: boolean }[]
    }
    expect(read.cut).toBe(true)
    expect(read.omitted).toBe(0)
    expect(read.rows[0]?.cut).toBe(true)
    expect(read.page?.state).toBe('ready')
  })

  it('keeps a full agent read within its byte budget and says what it left out', async () => {
    const { consoles, contents } = await setup()
    for (let index = 0; index < 40; index += 1) {
      log(contents, 'y'.repeat(4_000), 1_000 + index)
    }
    const text = consoles.read(PROJECT, { count: 200, skip: 0 })
    const read = JSON.parse(text) as {
      readonly cut: boolean
      readonly omitted: number
      readonly page: unknown
    }
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(CONSOLE_AGENT_BYTES)
    expect(read.omitted).toBeGreaterThan(0)
    expect(read.cut).toBe(true)
    expect(read.page).not.toBeNull()
  })

  it('marks an entry cut when a value preview is shortened', async () => {
    const { consoles, contents } = await setup()
    log(contents, 'z'.repeat(3_000), 1_000)
    const entry = consoles.snapshot(PROJECT).entries[0]
    expect(entry?.text).toHaveLength(3_000)
    expect(entry?.cut).toBe(true)
  })
})

describe('BrowserConsoles protocol requests', () => {
  it('counts unanswered evaluations against the limit after their callers time out', async () => {
    const { consoles, contents, owner } = await setup()
    const answers: Deferred[] = []
    contents.debugger.replies.set('Runtime.evaluate', () => {
      const answer = deferred()
      answers.push(answer)
      return answer.promise
    })
    const launches = Array.from({ length: CONSOLE_PENDING_MAX }, () =>
      consoles.evaluate({ ...human(owner, 'await new Promise(() => {})'), timeoutMs: 100 })
    )
    expect(launches.map((launch) => launch.status)).toEqual(
      Array.from({ length: CONSOLE_PENDING_MAX }, () => 'started')
    )
    await vi.advanceTimersByTimeAsync(100)
    for (const launch of launches) expect((await launch.done)?.status).toBe('timeout')
    expect(consoles.evaluate(human(owner, '1')).status).toBe('busy')
    answers[0]?.resolve({ result: { type: 'undefined' } })
    await drain()
    expect(consoles.evaluate(human(owner, '1')).status).toBe('started')
    expect(consoles.evaluate(human(owner, '2')).status).toBe('busy')
  })

  it('frees the limit when the debugger session that held the requests is replaced', async () => {
    const { consoles, contents, owner } = await setup()
    contents.debugger.replies.set('Runtime.evaluate', () => deferred().promise)
    for (let index = 0; index < CONSOLE_PENDING_MAX; index += 1) {
      consoles.evaluate({ ...human(owner, 'await never()'), timeoutMs: 100 })
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(consoles.evaluate(human(owner, '1')).status).toBe('busy')
    contents.debugger.attached = false
    contents.debugger.emit('detach', {}, 'target closed')
    contents.emit('devtools-closed')
    await drain()
    context(contents, 3, ROOT_FRAME)
    await drain()
    expect(consoles.evaluate(human(owner, '1')).status).toBe('started')
  })

  it('refuses to evaluate when the root frame cannot be identified', async () => {
    const owner = asContents({ id: 1 })
    const contents = new FakeContents()
    contents.debugger.replies.set('Page.getFrameTree', () =>
      Promise.reject(new Error('not available'))
    )
    const consoles = new BrowserConsoles({
      preferredOwner: () => electronShellClient(owner),
      now: () => 5_000,
    })
    consoles.mount(
      electronBrowserSource({
        browserId: 'browser-1',
        projectId: PROJECT,
        owner,
        contents: asContents(contents),
      })
    )
    await drain()
    context(contents, 1, ROOT_FRAME)
    await drain()
    expect(consoles.page(PROJECT)?.state).toBe('unavailable')
    expect(consoles.evaluate(human(owner, '1')).status).toBe('unavailable')
    expect(evaluated(contents)).toEqual([])
    expect(methods(contents)).not.toContain('Target.getTargetInfo')
  })
})
