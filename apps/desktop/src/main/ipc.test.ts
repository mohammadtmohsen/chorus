import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC_CONTRACT } from '../shared/ipc.js'
import type { IpcHost } from './ipc-host.js'
import type { ChorusRuntime } from './runtime.js'

const showOpenDialog = vi.fn()

class FakeNotification {
  static readonly instances: FakeNotification[] = []
  static readonly isSupported = (): boolean => true

  readonly options: Record<string, unknown>
  readonly listeners = new Map<string, () => void>()
  shown = false

  constructor(options: Record<string, unknown>) {
    this.options = options
    FakeNotification.instances.push(this)
  }

  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener)
    return this
  }

  show(): void {
    this.shown = true
  }
}
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp/chorus-test' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: FakeNotification,
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  // `settings:write` applies the appearance as it writes, because
  // `themeSource` is what `prefers-color-scheme` answers from. A plain object
  // is enough: the assignment is the whole behaviour.
  nativeTheme: { themeSource: 'system' },
  /*
   * A keychain that works, so the secret store takes its real path rather than
   * its refuse-to-store one. Base64 stands in for encryption: what is asserted
   * below is that the value never crosses back to a renderer, and a reversible
   * stand-in makes a leak *easier* to detect, not harder.
   */
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

vi.mock('./detached-windows.js', () => ({ raise: vi.fn(), detachedWindowOf: vi.fn() }))

const { answerConversationNoteJournal, buildHandlers } = await import('./ipc-handlers.js')
const { app, dialog } = await import('electron')
const { EngineHost } = await import('../../../engine/src/host.js')
const { PeerRegistry } = await import('../../../engine/src/peers.js')
const { agentKeyIsSet, clearAgentKey, readAgentKey, writeAgentKey } =
  await import('./agent-secrets.js')
const { showDesktopNotification } = await import('./desktop-ipc-host.js')
const { electronShellClient } = await import('./electron-shell-client.js')
const windowHelpers = await import('./shell-windows.js')
const { applyTheme } = await import('./theme.js')
const workbench = await import('./workbench-surface.js')
const { detachedWindowOf, raise } = await import('./detached-windows.js')

function testHost(mainWindow: () => BrowserWindow | null): IpcHost {
  const userData = app.getPath('userData')
  return Object.assign(new EngineHost(userData, new PeerRegistry()), {
    getPath: (name: 'userData' | 'desktop') => app.getPath(name),
    secrets: {
      read: (id) => readAgentKey(userData, id),
      isSet: (id) => agentKeyIsSet(userData, id),
      write: (id, value) => {
        writeAgentKey(userData, id, value)
      },
      clear: (id) => {
        clearAgentKey(userData, id)
      },
    } satisfies IpcHost['secrets'],
    clients: () =>
      windowHelpers
        .shellWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => electronShellClient(window.webContents)),
    notify: (request: Parameters<IpcHost['notify']>[0]) => {
      showDesktopNotification(request, () => detachedWindowOf(request.projectId) ?? mainWindow())
    },
    pickDirectory: (options: Parameters<IpcHost['pickDirectory']>[0]) =>
      dialog.showOpenDialog(options),
    prepareProjectClose: workbench.prepareWorkbenchProjectClose,
    closeProject: workbench.closeWorkbenchProject,
    reveal: workbench.requestWorkbenchReveal,
    applyTheme,
  })
}

/**
 * Which paths a transcript row may open, decided in main.
 *
 * The path comes off agent output by way of the renderer, and is about to be
 * handed to `code -g`. `isInside` is segment-wise on purpose — `/p/a-old` is not
 * inside `/p/a` — and these are the cases that would otherwise be found by a
 * user opening someone else's file.
 */
describe('ide:openFile', () => {
  const open = async (cwd: string, path: string) => {
    const runtime = { agentDirectory: () => cwd } as unknown as ChorusRuntime
    return (await (
      buildHandlers(
        runtime,
        testHost(() => null)
      )['ide:openFile'] as (r: unknown) => Promise<unknown>
    )({
      conversationId: 'c1',
      path,
    })) as { ok: boolean; reason: string | null }
  }

  /*
   * `toMatchObject`, not `toEqual`: the refusal now carries the path it refused
   * and the folder it measured against, so the message can name them. What these
   * guard is the *reason*, which is unchanged.
   */
  it('refuses a path outside the project', async () => {
    expect(await open('/p/a', '/p/b/secret.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses a sibling whose name merely starts the same', async () => {
    expect(await open('/p/a', '/p/a-old/rate.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses an escape through ..', async () => {
    expect(await open('/p/a', '../b/secret.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses everything when the conversation has no project folder', async () => {
    expect(await open('', '/p/a/rate.ts')).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  it('refuses when the conversation is no longer open', async () => {
    const runtime = {
      agentDirectory: () => {
        throw new Error('Conversation "c1" is not active')
      },
    } as unknown as ChorusRuntime
    const result = await (
      buildHandlers(
        runtime,
        testHost(() => null)
      )['ide:openFile'] as (r: unknown) => Promise<unknown>
    )({ conversationId: 'c1', path: '/p/a/rate.ts' })
    expect(result).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  /*
   * **Only refusals are asserted here, deliberately.** A contained path reaches
   * `code -g` for real — there is no seam between this handler and
   * `extensionDeps()` — so a "lets it through" test spawns VS Code on whoever
   * runs `pnpm check`. It did, twice, before this comment replaced it.
   *
   * Nothing is lost that matters. The refusals are the half with teeth, the
   * segment-wise comparison behind them has its own tests in
   * `ide-protocol/src/paths.test.ts`, and the positive path is what driving the
   * app checks.
   */
})

/*
 * `conversation:chooseCwd` had five tests here and they are gone with the
 * channel. They asserted that picking a folder repointed a conversation, which
 * is the operation Phase 2 removed: a Conversation belongs to exactly one
 * Project, and moving a project moves every conversation in it at once.
 *
 * What replaces them tests the two halves of that: a conversation starts inside
 * a project it is given, and the channels that could move a room no longer
 * exist.
 *
 * **These three used to assert the opposite, and were left behind by Phase 9.**
 * They required `conversation:start` to route through `startConversationIn` and
 * carry a `cwd`, adopting the directory on the way past — with a comment calling
 * the projectId route "the bug this routing exists to prevent". That was true
 * while a conversation was the thing a person created first. Phase 9 made the
 * Project the unit: `project:adopt` above turns a folder into a project, and a
 * conversation is then started *inside* one and can no longer name a directory
 * at all. So the old assertion had inverted into a test demanding the behaviour
 * the architecture forbids — and because the fake runtime only carried the
 * method the test expected, it failed as `startConversation is not a function`
 * rather than as a disagreement about the contract.
 */
describe('conversation:start', () => {
  const started = {
    conversationId: 'c1',
    participants: ['claude'] as const,
    profileId: 'read-only',
    cwd: '/tmp/repo',
    title: 'repo',
  }

  const startWith = async (request: unknown) => {
    const startConversation = vi.fn((_options: Record<string, unknown>) => Promise.resolve(started))
    const runtime = { startConversation } as unknown as ChorusRuntime
    await (
      buildHandlers(
        runtime,
        testHost(() => null)
      )['conversation:start'] as (r: unknown) => Promise<unknown>
    )(request)
    return startConversation
  }

  it('starts inside the project it was given, and passes no directory', async () => {
    /*
     * The Phase 9 invariant at the IPC boundary. `project:adopt` is the only
     * thing that turns a folder into a project, so by the time this channel is
     * reached the id exists and the room is being placed inside it. A `cwd`
     * arriving here would mean a conversation choosing its own directory, which
     * is precisely what the Project-as-unit hierarchy removes.
     */
    const startConversation = await startWith({ projectId: 'p1' })
    expect(startConversation).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(Object.keys(startConversation.mock.calls[0]?.[0] ?? {})).not.toContain('cwd')
  })

  it('passes no cast, even when one is sent', async () => {
    /*
     * The cast is main's, and this is the channel where it stopped being the
     * renderer's. It used to forward `agents` — filled from `settings.json` —
     * so a new conversation opened with whatever that file held and a project
     * showing three agents got two. Asserted by sending one anyway: dropping
     * the field from the schema is not the same as the handler ignoring it,
     * and only the second is what makes the cast un-gettable-wrong.
     */
    const startConversation = await startWith({ agents: ['claude'], projectId: 'p1' })
    expect(Object.keys(startConversation.mock.calls[0]?.[0] ?? {})).not.toContain('agents')
  })

  it('omits an absent profile rather than passing undefined through', async () => {
    const startConversation = await startWith({ projectId: 'p1' })
    expect(Object.keys(startConversation.mock.calls[0]?.[0] ?? {})).not.toContain('profileId')
  })

  it('passes a profile when one is given', async () => {
    const startConversation = await startWith({
      projectId: 'p1',
      profileId: 'trusted',
    })
    expect(startConversation).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'trusted' })
    )
  })

  it('passes the selected source and task to the runtime', async () => {
    const request = { projectId: 'p1', continueFrom: 'c0', objective: 'Fix API retries' }
    expect(await startWith(request)).toHaveBeenCalledWith(request)
  })
})

describe('conversation:begin and conversation:awaitStart', () => {
  const begun = {
    conversationId: 'c1',
    participants: [],
    profileId: 'read-only',
    projectId: 'p1',
    cwd: '/tmp/repo',
    title: 'repo',
  }

  type Channel = 'conversation:begin' | 'conversation:awaitStart'
  const handler = (runtime: unknown, channel: Channel) => {
    const handlers = buildHandlers(
      runtime as ChorusRuntime,
      testHost(() => null)
    )
    return handlers[channel] as (r: unknown) => Promise<unknown>
  }

  it('begins inside the project it was given, with no directory and no cast', async () => {
    const beginConversation = vi.fn((_options: Record<string, unknown>) => begun)
    const begin = handler({ beginConversation }, 'conversation:begin')
    const answer = await begin({
      projectId: 'p1',
      agents: ['claude'],
      continueFrom: 'c0',
      objective: 'Fix API retries',
    })

    expect(answer).toEqual(begun)
    expect(beginConversation).toHaveBeenCalledWith({
      projectId: 'p1',
      continueFrom: 'c0',
      objective: 'Fix API retries',
    })
    expect(Object.keys(beginConversation.mock.calls[0]?.[0] ?? {})).not.toContain('profileId')
  })

  it('passes a profile when one is given', async () => {
    const beginConversation = vi.fn((_options: Record<string, unknown>) => begun)
    const begin = handler({ beginConversation }, 'conversation:begin')
    await begin({ projectId: 'p1', profileId: 't' })

    expect(beginConversation).toHaveBeenCalledWith({ projectId: 'p1', profileId: 't' })
  })

  it('asks for the outcome of the conversation it names', async () => {
    const outcome = { status: 'failed', message: 'claude fell over' }
    const awaitStart = vi.fn((_conversationId: string) => Promise.resolve(outcome))
    const wait = handler({ awaitStart }, 'conversation:awaitStart')
    const answer = await wait({ conversationId: 'c1' })

    expect(answer).toBe(outcome)
    expect(awaitStart).toHaveBeenCalledWith('c1')
  })
})

describe('the channels that could move a conversation', () => {
  /*
   * A guard rather than a formality. The renderer's controls are gone, but a
   * live handler would let anything with the preload bridge repoint a room —
   * and the whole invariant is that this is not expressible, not that nothing
   * currently asks for it.
   */
  it('are not registered at all', () => {
    const handlers = buildHandlers(
      {} as unknown as ChorusRuntime,
      testHost(() => null)
    ) as Record<string, unknown>
    expect(handlers['conversation:setCwd']).toBeUndefined()
    expect(handlers['conversation:chooseCwd']).toBeUndefined()
  })
})

/**
 * The credential goes in and never comes out.
 *
 * This is the whole reason `agent-secrets.ts` exists as its own module rather
 * than reusing `workbench-secrets.ts`: that store is reachable by name from any
 * workbench surface through a generic `readSecret(key)`. Nothing asserts the
 * absence of a channel, so what is asserted here is the property that channel
 * would break — the key is not in anything main hands back.
 */
describe('the DeepSeek key', () => {
  const KEY = 'sk-do-not-echo-this-anywhere'

  const handlers = () =>
    buildHandlers(
      {} as unknown as ChorusRuntime,
      testHost(() => null)
    )
  const write = async (patch: unknown): Promise<Record<string, unknown>> =>
    (handlers()['settings:write'] as unknown as (r: unknown) => Promise<Record<string, unknown>>)(
      patch
    )
  const read = async (): Promise<Record<string, unknown>> =>
    (handlers()['settings:read'] as unknown as () => Promise<Record<string, unknown>>)()

  it('is never in the answer to the write that set it', async () => {
    const after = await write({ deepseekApiKey: KEY })
    expect(after['deepseekKeySet']).toBe(true)
    expect(after['deepseekApiKey']).toBeUndefined()
    // The whole payload, not just the fields we thought to name.
    expect(JSON.stringify(after)).not.toContain(KEY)
  })

  it('is never in a later read either', async () => {
    await write({ deepseekApiKey: KEY })
    const settings = await read()
    expect(settings['deepseekKeySet']).toBe(true)
    expect(JSON.stringify(settings)).not.toContain(KEY)
  })

  /*
   * The control. Without it the two assertions above pass on a store that never
   * saved anything — "the key is not in the payload" is trivially true of a key
   * that was dropped on the floor.
   */
  it('reports no key once it is cleared, and reports one while it is set', async () => {
    await write({ deepseekApiKey: KEY })
    expect((await read())['deepseekKeySet']).toBe(true)
    const cleared = await write({ deepseekApiKey: '' })
    expect(cleared['deepseekKeySet']).toBe(false)
    expect((await read())['deepseekKeySet']).toBe(false)
  })

  it('leaves a stored key alone when the patch does not mention it', async () => {
    await write({ deepseekApiKey: KEY })
    const after = await write({ cwd: '/tmp/elsewhere' })
    expect(after['deepseekKeySet']).toBe(true)
  })
})

describe('settings:write and the per-agent maps', () => {
  const write = async (patch: unknown): Promise<{ models: Record<string, string> }> => {
    const handler = buildHandlers(
      {} as unknown as ChorusRuntime,
      testHost(() => null)
    )['settings:write'] as unknown as (r: unknown) => Promise<{ models: Record<string, string> }>
    return handler(patch)
  }

  it('keeps the other agent’s model when only one is sent', async () => {
    /*
     * The shape of the bug: `{ ...current, ...request }` is shallow, so a patch
     * naming one agent replaces the whole map and clears the other's value —
     * with nothing on screen to show it had happened.
     */
    await write({ models: { claude: 'opus' } })
    await write({ models: { codex: 'gpt-5.6-sol' } })
    const after = await write({})
    expect(after.models).toEqual({ claude: 'opus', codex: 'gpt-5.6-sol', deepseek: '' })
  })

  it('keeps the other agent’s effort too', async () => {
    await write({ efforts: { claude: 'high' } })
    const after = await write({ efforts: { codex: 'ultra' } })
    expect(after).toMatchObject({ efforts: { claude: 'high', codex: 'ultra' } })
  })
})

/**
 * The transcript read, and the one ordering that makes it correct.
 *
 * `throughSeq` is taken **before** the rows are read. That is not incidental: it
 * is the value the renderer advances `lastSeq` to, and it is what stops a
 * conversation whose newest events are all ignored types from re-querying the
 * same range on every push, forever.
 *
 * Taking it *after* the read would be the tempting simplification and is wrong
 * in the other direction — it would claim to have covered an event appended
 * during the read that the read did not return, and that event would then never
 * be fetched. Before-the-read can only ever under-claim, and under-claiming
 * costs one redundant query rather than a missing message.
 */
describe('conversation:transcript', () => {
  const EVENTS = [
    {
      seq: 1,
      id: 'e1',
      conversationId: 'c1',
      actor: 'claude',
      type: 'user.message',
      payload: {},
      createdAt: 1,
    },
    {
      seq: 2,
      id: 'e2',
      conversationId: 'c1',
      actor: 'claude',
      type: 'agent.message.completed',
      payload: {},
      createdAt: 2,
    },
  ]

  const EMPTY_STATE = { approvals: [], questions: [], working: [], replies: [], usageByActor: {} }

  function runtimeFor(lastSeq: number) {
    const calls: {
      kind: 'history' | 'page'
      conversationId: string
      afterSeq?: number
      beforeSeq?: number
      limit?: number
      at: number
    }[] = []
    let position = lastSeq
    const runtime = {
      // Reading moves the log on, so a handler that asked for the position
      // afterwards would get a different — and wrong — answer.
      transcriptHistory: (conversationId: string, afterSeq?: number) => {
        calls.push({
          kind: 'history',
          conversationId,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          at: position,
        })
        position += 5
        return EVENTS
      },
      transcriptPage: (conversationId: string, limit: number, beforeSeq?: number) => {
        calls.push({
          kind: 'page',
          conversationId,
          limit,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          at: position,
        })
        position += 5
        return EVENTS
      },
      transcriptState: () => EMPTY_STATE,
      logPosition: () => position,
    } as unknown as ChorusRuntime
    return { runtime, calls }
  }

  const read = async (runtime: ChorusRuntime, request: unknown) =>
    (await (
      buildHandlers(
        runtime,
        testHost(() => null)
      )['conversation:transcript'] as (r: unknown) => Promise<unknown>
    )(request)) as { events: { seq: number }[]; throughSeq: number }

  it('reports the log position from before the read, not after', async () => {
    const { runtime } = runtimeFor(42)
    const result = await read(runtime, { conversationId: 'c1' })
    // 42, not 47: the read moved the log on and the mark predates it.
    expect(result.throughSeq).toBe(42)
  })

  it('returns the conversation the caller asked for', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c9', afterSeq: 3 })
    expect(calls).toEqual([{ kind: 'history', conversationId: 'c9', afterSeq: 3, at: 10 }])
  })

  it('omits afterSeq entirely on a first read rather than sending zero', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1' })
    expect(calls[0]).not.toHaveProperty('afterSeq')
  })

  /*
   * Three questions on one channel, and they must not blur into each other.
   * `afterSeq` is "what has happened since"; `limit` is "the newest page";
   * neither is "the whole conversation", which is what no `limit` still means.
   */
  it('reads a page when asked for one, not the whole conversation', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1', limit: 400 })
    expect(calls).toEqual([{ kind: 'page', conversationId: 'c1', limit: 400, at: 10 }])
  })

  it('walks backwards with beforeSeq', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1', beforeSeq: 900, limit: 400 })
    expect(calls[0]).toMatchObject({ kind: 'page', beforeSeq: 900, limit: 400 })
  })

  it('sends state on a cold read, because a page cannot contain it', async () => {
    const { runtime } = runtimeFor(10)
    const result = (await read(runtime, { conversationId: 'c1', limit: 400 })) as unknown as {
      state?: unknown
    }
    expect(result.state).toEqual(EMPTY_STATE)
  })

  it('withholds state from a catch-up, which would overwrite live cards', async () => {
    /*
     * An incremental read is folded into a view that already holds the state,
     * and the queried snapshot is from a moment ago — re-applying it would put
     * back an approval the user has just decided.
     */
    const { runtime } = runtimeFor(10)
    const result = (await read(runtime, { conversationId: 'c1', afterSeq: 3 })) as unknown as {
      state?: unknown
    }
    expect(result.state).toBeUndefined()
  })

  it('sends state with a catch-up only when a returning pane asks for its live state', async () => {
    const request = { conversationId: 'c1', afterSeq: 3, live: true }
    expect(IPC_CONTRACT['conversation:transcript'].request.safeParse(request).success).toBe(true)
    const { runtime, calls } = runtimeFor(10)
    const result = (await read(runtime, request)) as unknown as { state?: unknown }
    expect(calls).toEqual([{ kind: 'history', conversationId: 'c1', afterSeq: 3, at: 10 }])
    expect(result.state).toEqual(EMPTY_STATE)
  })

  it('carries the live snapshot through the state copy instead of dropping it', async () => {
    const live = {
      work: [{ agentId: 'claude', generation: 7, startedAt: 70, evidenceAt: 90 }],
      chat: [
        { requestId: 'discussion:s:codex:0', agentId: 'codex', startedAt: 80, evidenceAt: 85 },
      ],
      operations: [
        {
          agentId: 'claude',
          requestId: null,
          generation: 7,
          itemRef: 'r1',
          kind: 'tool',
          name: 'Read',
          detail: null,
          startedAt: 75,
        },
      ],
      handoffs: [
        {
          handoffId: 'h1',
          from: 'claude',
          to: 'codex',
          sourceEventIds: ['e1'],
          createdAt: null,
          outcome: 'cancelled',
          outcomeAt: 60,
        },
      ],
    }
    const withLive = {
      transcriptPage: () => EVENTS,
      transcriptState: () => ({ ...EMPTY_STATE, live }),
      logPosition: () => 10,
    } as unknown as ChorusRuntime
    const result = await read(withLive, { conversationId: 'c1', limit: 400 })
    expect((result as unknown as { state?: { live?: unknown } }).state?.live).toEqual(live)
    expect(IPC_CONTRACT['conversation:transcript'].response.safeParse(result).success).toBe(true)
  })

  it('flattens the rows the renderer draws', async () => {
    const { runtime } = runtimeFor(10)
    const result = await read(runtime, { conversationId: 'c1' })
    expect(result.events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('carries the forwarded-work marking through the state copy, or omits it', async () => {
    const assignment = { linked: true, boundTaskId: 'task-b' }
    const { runtime } = runtimeFor(10)
    const marked = {
      transcriptPage: () => EVENTS,
      transcriptState: () => ({ ...EMPTY_STATE, assignment }),
      logPosition: () => 10,
    } as unknown as ChorusRuntime
    const result = (await read(marked, { conversationId: 'c1', limit: 400 })) as unknown as {
      state?: { assignment?: unknown }
    }
    expect(result.state?.assignment).toEqual(assignment)
    expect(IPC_CONTRACT['conversation:transcript'].response.safeParse(result).success).toBe(true)

    const plain = (await read(runtime, { conversationId: 'c1', limit: 400 })) as unknown as {
      state?: object
    }
    expect(plain.state).not.toHaveProperty('assignment')
    expect(IPC_CONTRACT['conversation:transcript'].response.safeParse(plain).success).toBe(true)
  })
})

describe('task:bindAssignment', () => {
  const outcomes = {
    bound: {
      outcome: 'bound',
      taskId: 't1',
      previousTaskId: null,
      ref: { seq: 1, eventId: 'e', at: 1 },
    },
    unchanged: { outcome: 'unchanged', taskId: 't1', ref: { seq: 1, eventId: 'e', at: 1 } },
    refused: { outcome: 'refused', reason: 'not-latest' },
  } as const

  const bind = async (outcome: keyof typeof outcomes) => {
    const asked: [string, string][] = []
    const runtime = {
      bindAssignment: (conversationId: string, taskId: string) => {
        asked.push([conversationId, taskId])
        return outcomes[outcome]
      },
    } as unknown as ChorusRuntime
    const handler = buildHandlers(
      runtime,
      testHost(() => null)
    )['task:bindAssignment'] as (r: unknown) => Promise<unknown>
    const result = await handler({ conversationId: 'child-1', taskId: 'task-b' })
    return { asked, result }
  }

  it('asks the runtime for exactly the task shown, and reports a recorded mark', async () => {
    for (const outcome of ['bound', 'unchanged'] as const) {
      const { asked, result } = await bind(outcome)
      expect(asked).toEqual([['child-1', 'task-b']])
      expect(result).toEqual({ bound: true })
      expect(IPC_CONTRACT['task:bindAssignment'].response.safeParse(result).success).toBe(true)
    }
  })

  it('reports a refusal as not bound', async () => {
    const { result } = await bind('refused')
    expect(result).toEqual({ bound: false })
  })

  it('refuses a missing, empty or oversized task id at the boundary', () => {
    const schema = IPC_CONTRACT['task:bindAssignment'].request
    expect(schema.safeParse({ conversationId: 'c1', taskId: 'task-b' }).success).toBe(true)
    for (const request of [
      { conversationId: 'c1' },
      { conversationId: 'c1', taskId: '' },
      { conversationId: 'c1', taskId: 'x'.repeat(65) },
      { taskId: 'task-b' },
    ]) {
      expect(schema.safeParse(request).success, JSON.stringify(request)).toBe(false)
    }
  })
})

describe('project:adoptRemote', () => {
  const ROOT = 'C:/TPA-MEDEXA/MasterTPABackend'
  const adopted = { id: 'p1', name: 'MasterTPABackend', root: ROOT }

  const handlerWith = (): {
    readonly adoptRemote: ReturnType<typeof vi.fn>
    readonly adopt: (request: unknown) => Promise<unknown>
  } => {
    showOpenDialog.mockReset()
    const adoptRemote = vi.fn(() => ({ project: adopted, created: true }))
    const runtime = { projects: { adoptRemote } } as unknown as ChorusRuntime
    const adopt = buildHandlers(
      runtime,
      testHost(() => null)
    )['project:adoptRemote'] as (r: unknown) => Promise<unknown>
    return { adoptRemote, adopt }
  }

  it('asks where the agents run, then adopts the remote root with that folder', async () => {
    const { adoptRemote, adopt } = handlerWith()
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/me/tpa-be'] })

    await expect(adopt({ host: 'TPA-BE', root: ROOT })).resolves.toEqual({
      project: { ...adopted, created: true },
    })
    expect(adoptRemote).toHaveBeenCalledWith({
      host: 'tpa-be',
      root: ROOT,
      agentCwd: '/Users/me/tpa-be',
    })
  })

  it('adopts nothing when the folder dialog is cancelled', async () => {
    const { adoptRemote, adopt } = handlerWith()
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    await expect(adopt({ host: 'tpa-be', root: ROOT })).resolves.toEqual({ project: null })
    expect(adoptRemote).not.toHaveBeenCalled()
  })

  it('refuses a bad host or an unanchored root before any dialog opens', async () => {
    const { adoptRemote, adopt } = handlerWith()

    await expect(adopt({ host: '', root: ROOT })).rejects.toThrow('Not a usable remote host')
    await expect(adopt({ host: '-oProxyCommand=x', root: ROOT })).rejects.toThrow(
      'Not a usable remote host'
    )
    await expect(adopt({ host: 'tpa-be', root: 'MasterTPABackend' })).rejects.toThrow(
      'A remote project root must be an absolute path'
    )
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(adoptRemote).not.toHaveBeenCalled()
  })
})

describe('project:checkRemoteHost', () => {
  it('refuses the host string itself before any ssh runs', async () => {
    const handlers = buildHandlers(
      {} as unknown as ChorusRuntime,
      testHost(() => null)
    )
    const check = handlers['project:checkRemoteHost'] as (r: unknown) => Promise<unknown>
    await expect(check({ host: '' })).rejects.toThrow('Not a usable remote host')
    await expect(check({ host: '-oProxyCommand=x' })).rejects.toThrow('Not a usable remote host')
  })
})

describe('app:notify', () => {
  const fakeMain = { id: 'main' } as unknown as BrowserWindow
  const fakeDetached = { id: 'detached' } as unknown as BrowserWindow

  const write = async (patch: unknown): Promise<void> => {
    const handler = buildHandlers(
      {} as unknown as ChorusRuntime,
      testHost(() => null)
    )['settings:write'] as unknown as (r: unknown) => Promise<unknown>
    await handler(patch)
  }

  const notify = async (request: unknown): Promise<unknown> => {
    const handler = buildHandlers(
      {} as unknown as ChorusRuntime,
      testHost(() => fakeMain)
    )['app:notify'] as unknown as (r: unknown) => Promise<unknown>
    return handler(request)
  }

  const click = (): void => {
    FakeNotification.instances[0]?.listeners.get('click')?.()
  }

  beforeEach(async () => {
    await write({ notifications: true })
  })

  afterEach(() => {
    FakeNotification.instances.length = 0
    vi.mocked(raise).mockReset()
    vi.mocked(detachedWindowOf).mockReset()
  })

  it('raises one silent notification carrying the request', async () => {
    await notify({ title: 'claude needs a decision', body: 'Fix the leak', projectId: 'p1' })

    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.options).toEqual({
      title: 'claude needs a decision',
      body: 'Fix the leak',
      silent: true,
    })
    expect(FakeNotification.instances[0]?.shown).toBe(true)
  })

  it('raises nothing while the switch is off', async () => {
    await write({ notifications: false })
    try {
      await notify({ title: 't', body: 'b', projectId: 'p1' })
      expect(FakeNotification.instances).toHaveLength(0)
    } finally {
      await write({ notifications: true })
    }
  })

  it('a click raises the detached window holding the project', async () => {
    vi.mocked(detachedWindowOf).mockReturnValue(fakeDetached)
    await notify({ title: 't', body: 'b', projectId: 'p1' })

    click()

    expect(vi.mocked(detachedWindowOf)).toHaveBeenCalledWith('p1')
    expect(vi.mocked(raise)).toHaveBeenCalledWith(fakeDetached)
  })

  it('a click falls back to the main window when the project is not detached', async () => {
    vi.mocked(detachedWindowOf).mockReturnValue(null)
    await notify({ title: 't', body: 'b', projectId: 'p2' })

    click()

    expect(vi.mocked(raise)).toHaveBeenCalledWith(fakeMain)
  })
})

describe('the note recovery journal', () => {
  const journalRuntime = () => ({
    readConversationNoteJournal: vi.fn((): string | null => 'J'),
    compareConversationNoteJournal: vi.fn((): { matched: boolean; current: string | null } => ({
      matched: false,
      current: 'B',
    })),
  })

  it('refuses a sender that is not a Chorus window, without touching the store', () => {
    const runtime = journalRuntime()
    const reply = answerConversationNoteJournal(runtime, false, {
      op: 'read',
      conversationId: 'c1',
    })
    expect(reply.ok).toBe(false)
    expect(runtime.readConversationNoteJournal).not.toHaveBeenCalled()
  })

  it('refuses malformed and oversized requests', () => {
    const runtime = journalRuntime()
    const refused: unknown[] = [
      undefined,
      { op: 'read' },
      { op: 'delete', conversationId: 'c1' },
      { op: 'read', conversationId: 'c1', extra: true },
      { op: 'compare', conversationId: 'c1', expected: null },
      { op: 'compare', conversationId: 'c1', expected: null, next: 'x'.repeat(30_000) },
      { op: 'read', conversationId: 'x'.repeat(200) },
    ]
    for (const request of refused) {
      expect(answerConversationNoteJournal(runtime, true, request).ok).toBe(false)
    }
    expect(runtime.readConversationNoteJournal).not.toHaveBeenCalled()
    expect(runtime.compareConversationNoteJournal).not.toHaveBeenCalled()
  })

  it('answers a read and an atomic compare with the store’s own result', () => {
    const runtime = journalRuntime()
    const read = answerConversationNoteJournal(runtime, true, { op: 'read', conversationId: 'c1' })
    expect(read).toEqual({ ok: true, matched: true, current: 'J' })
    expect(
      answerConversationNoteJournal(runtime, true, {
        op: 'compare',
        conversationId: 'c1',
        expected: 'A',
        next: null,
      })
    ).toEqual({ ok: true, matched: false, current: 'B' })
    expect(runtime.compareConversationNoteJournal).toHaveBeenCalledWith('c1', 'A', null)
  })

  it('turns a store failure into a bounded failure instead of throwing', () => {
    const runtime = journalRuntime()
    runtime.compareConversationNoteJournal.mockImplementation(() => {
      throw new Error('x'.repeat(5_000))
    })
    const reply = answerConversationNoteJournal(runtime, true, {
      op: 'compare',
      conversationId: 'c1',
      expected: null,
      next: 'J',
    })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error.length).toBeLessThanOrEqual(512)
  })
})

describe('project:close', () => {
  const held = () => {
    let resolve = (): void => undefined
    const promise = new Promise<void>((yes) => {
      resolve = yes
    })
    return { promise, resolve }
  }

  it('prepares the editor before stopping agents and waits for cleanup before confirming closure', async () => {
    const workbench = await import('./workbench-surface.js')
    const windows = await import('./shell-windows.js')
    const preparation = held()
    const agents = held()
    const editor = held()
    const send = vi.fn()
    const target = { host: 'local', root: '/tmp/repo' }
    const prepareEditor = vi
      .spyOn(workbench, 'prepareWorkbenchProjectClose')
      .mockReturnValue(preparation.promise)
    const closeEditor = vi.spyOn(workbench, 'closeWorkbenchProject').mockReturnValue(editor.promise)
    const listed = vi.spyOn(windows, 'shellWindows').mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { id: 1, isDestroyed: () => false, send },
      } as unknown as BrowserWindow,
    ])
    const closeProject = vi.fn((_id: string, cleanup: () => Promise<void>) =>
      Promise.all([agents.promise, cleanup()]).then(() => undefined)
    )
    const runtime = {
      projects: { get: () => ({ host: target.host, canonicalRoot: target.root }) },
      closeProject,
    } as unknown as ChorusRuntime
    try {
      const handler = buildHandlers(
        runtime,
        testHost(() => null)
      )['project:close'] as (request: unknown) => Promise<unknown>
      const closing = handler({ projectId: 'p1' })
      expect(prepareEditor).toHaveBeenCalledWith(target)
      expect(closeProject).not.toHaveBeenCalled()
      expect(closeEditor).not.toHaveBeenCalled()
      preparation.resolve()
      await Promise.resolve()
      expect(closeProject).toHaveBeenCalledWith('p1', expect.any(Function))
      expect(closeEditor).toHaveBeenCalledWith(target)
      agents.resolve()
      await Promise.resolve()
      expect(send).not.toHaveBeenCalled()
      editor.resolve()
      await expect(closing).resolves.toEqual({ ok: true })
      expect(send).toHaveBeenCalledWith('project:closed', { projectId: 'p1' })
    } finally {
      preparation.resolve()
      agents.resolve()
      editor.resolve()
      prepareEditor.mockRestore()
      closeEditor.mockRestore()
      listed.mockRestore()
    }
  })

  it('attempts both cleanup paths and keeps the project open if either fails', async () => {
    const workbench = await import('./workbench-surface.js')
    const windows = await import('./shell-windows.js')
    const editor = held()
    const send = vi.fn()
    const prepareEditor = vi
      .spyOn(workbench, 'prepareWorkbenchProjectClose')
      .mockResolvedValue(undefined)
    const closeEditor = vi.spyOn(workbench, 'closeWorkbenchProject').mockReturnValue(editor.promise)
    const listed = vi.spyOn(windows, 'shellWindows').mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { id: 1, isDestroyed: () => false, send },
      } as unknown as BrowserWindow,
    ])
    const runtime = {
      projects: { get: () => ({ host: 'local', canonicalRoot: '/tmp/repo' }) },
      closeProject: async (_id: string, cleanup: () => Promise<void>) => {
        await cleanup()
        throw new Error('An agent is still running')
      },
    } as unknown as ChorusRuntime
    try {
      const handler = buildHandlers(
        runtime,
        testHost(() => null)
      )['project:close'] as (request: unknown) => Promise<unknown>
      const closing = handler({ projectId: 'p1' })
      const failed = expect(closing).rejects.toThrow('An agent is still running')
      await Promise.resolve()
      expect(closeEditor).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      editor.resolve()
      await failed
      expect(send).not.toHaveBeenCalled()
    } finally {
      editor.resolve()
      prepareEditor.mockRestore()
      closeEditor.mockRestore()
      listed.mockRestore()
    }
  })
})
