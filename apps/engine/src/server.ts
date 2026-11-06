import { readSettings } from '../../desktop/src/main/settings.js'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { z } from 'zod'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentAdapter } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { ChorusRuntime } from '../../desktop/src/main/runtime.js'
import { TrafficIpc } from '../../desktop/src/main/traffic-ipc.js'
import { RunIpc } from '../../desktop/src/main/run-ipc.js'
import { ConsoleIpc } from '../../desktop/src/main/console-ipc.js'
import { BrowserIpc } from '../../desktop/src/main/browser-ipc.js'
import { BrowserConsoles } from '../../desktop/src/main/browser-console.js'
import { detectScripts } from '../../desktop/src/main/project-scripts.js'
import type { IpcRegistrar, ShellRequest } from '../../desktop/src/main/shell-client.js'
import { IPC_CONTRACT, type IpcChannel } from '../../desktop/src/shared/ipc.js'
import { CONSOLE_CONTRACT } from '../../desktop/src/shared/console-ipc.js'
import { CONVERSATIONS_PUSH_CHANNEL } from '../../desktop/src/shared/detached-window-ipc.js'
import { WorkspaceSnapshot } from '../../desktop/src/shared/workspace-layout.js'
import {
  answerConversationNoteJournal,
  buildHandlers,
  dispatch,
  forwardEventsToRenderer,
  forwardLimitsToRenderer,
  forwardContextUsageToRenderer,
  forwardTasksToRenderer,
  forwardConversationNotesToRenderer,
  forwardActivityToRenderer,
  forwardAttentionToRenderer,
  forwardTerminalToRenderer,
  forwardWorkbenchContextToRenderer,
} from '../../desktop/src/main/ipc-handlers.js'
import { EngineHost } from './host.js'
import {
  ATTENTION_ROOMS_CHANNEL,
  ClientMessage,
  PROTOCOL_VERSION,
  type EngineDescriptor,
  type ServerMessage,
} from './protocol.js'
import { acquireDirectoryLock, socketPathFor } from './lock.js'
import { ClientState } from './state.js'
import { removeDescriptor, writeDescriptor } from './descriptor.js'
import { EnginePeer, PeerRegistry } from './peers.js'
import { FrameReader } from './wire.js'
import { replayEvents } from './replay.js'
import { EngineBrowsers } from './browser-surfaces.js'
import { CompletionClient, isCompletionPayload } from '../../desktop/src/main/completion-core.js'

export interface ServeOptions {
  readonly dataDirectory: string
  readonly build: string
  readonly log?: Logger
  readonly adapters?: Map<AgentId, AgentAdapter>
  readonly idleTimeoutMs?: number
  readonly runtimeVersion?: string
  readonly beforeOpen?: () => Promise<void>
}

export async function serveEngine(
  options: ServeOptions
): Promise<{ runtime: ChorusRuntime; descriptor: EngineDescriptor; close(): Promise<void> }> {
  const acquired = acquireDirectoryLock(options.dataDirectory)
  if (acquired === null) throw new Error('engine-lock-held')
  const lock = acquired
  const log = options.log ?? new Logger()
  const registry = new PeerRegistry()
  const host = new EngineHost(options.dataDirectory, registry)
  let runtime: ChorusRuntime
  try {
    await options.beforeOpen?.()
    runtime = ChorusRuntime.open(host, log, options.adapters, { deferRestoredAgents: true })
    host.attach(runtime)
    await runtime.restoreOpenConversations()
  } catch (error) {
    lock.release()
    throw error
  }
  const handlers = buildHandlers(runtime, host)
  const completion = new CompletionClient(
    options.dataDirectory,
    (_directory, id) => host.secrets.read(id),
    log
  )
  host.onCompletionInvalidated(() => {
    completion.invalidate()
  })
  const registered = new Map<string, (event: ShellRequest, raw: unknown) => Promise<unknown>>()
  const registrar: IpcRegistrar = {
    handle: (channel, handler) => {
      if (registered.has(channel)) throw new Error('duplicate-channel')
      registered.set(channel, handler)
    },
    removeHandler: (channel) => {
      registered.delete(channel)
    },
  }
  for (const channel of Object.keys(IPC_CONTRACT) as IpcChannel[])
    registrar.handle(channel, (_event, raw) => dispatch(handlers, channel, raw))
  const traffic = new TrafficIpc(
    {
      registry: runtime.trafficRegistry(),
      isAdopted: (id) => runtime.projects.get(id) !== null,
      legacy: () => runtime.legacyTraffic(),
      decideLegacy: (keep) => {
        runtime.decideLegacyTraffic(keep)
      },
      capture: (id, change) => runtime.projectRunner().captureOnly(id, change),
    },
    registrar
  )
  const run = new RunIpc(
    {
      runner: runtime.projectRunner(),
      project: (id) => runtime.projects.get(id),
      isAdopted: (id) => runtime.projects.get(id) !== null,
      setCommands: (id, commands) => {
        runtime.setRunCommands(id, commands)
      },
      detect: detectScripts,
      platform: process.platform,
    },
    registrar
  )
  const consoles = new BrowserConsoles({ preferredOwner: (id) => registry.choose(id) })
  runtime.attachBrowserConsoles(consoles)
  const consoleIpc = new ConsoleIpc(
    { consoles, isAdopted: (id) => runtime.projects.get(id) !== null },
    registrar
  )
  const browserSources = new EngineBrowsers(
    options.dataDirectory,
    consoles,
    (id) => runtime.projects.get(id) !== null,
    log
  )
  const browser = new BrowserIpc(
    {
      isAdopted: (id) => runtime.projects.get(id) !== null,
      downloads: { list: () => [], act: () => null },
      surfaces: browserSources.port,
      streams: browserSources.streams,
    },
    registrar
  )
  const stops = [
    forwardEventsToRenderer(runtime, host),
    forwardConversationNotesToRenderer(runtime, host),
    forwardTerminalToRenderer(runtime, host),
    forwardWorkbenchContextToRenderer(runtime, host),
  ]
  forwardLimitsToRenderer(runtime, host)
  forwardContextUsageToRenderer(runtime, host)
  forwardTasksToRenderer(runtime, host)
  forwardActivityToRenderer(runtime, host)
  forwardAttentionToRenderer(runtime, {
    focused: () => registry.focused(),
    clients: () => {
      if (!readSettings(options.dataDirectory).notifications) return []
      const chosen = registry.choose()
      return chosen === null ? [] : [chosen]
    },
  })
  let attentionTimer: ReturnType<typeof setTimeout> | null = null
  const publishAttention = (): void => {
    if (attentionTimer !== null) return
    attentionTimer = setTimeout(() => {
      attentionTimer = null
      const rooms = runtime.attentionRooms()
      for (const peer of registry.clients()) peer.send(ATTENTION_ROOMS_CHANNEL, rooms)
    }, 200)
    attentionTimer.unref()
  }
  stops.push(runtime.subscribe(publishAttention), () => {
    if (attentionTimer !== null) clearTimeout(attentionTimer)
    attentionTimer = null
  })
  runtime.onConversationsChanged(() => {
    publishAttention()
    for (const peer of registry.clients()) peer.send(CONVERSATIONS_PUSH_CHANNEL, {})
  })
  runtime.syncLegacyTraffic()
  const socketPath = socketPathFor(options.dataDirectory)
  if (process.platform !== 'win32' && existsSync(socketPath)) unlinkSync(socketPath)
  const descriptor: EngineDescriptor = {
    protocol: PROTOCOL_VERSION,
    build: options.build,
    runtimeVersion: options.runtimeVersion ?? process.versions.node,
    generation: lock.generation,
    token: randomBytes(32).toString('hex'),
    socketPath,
    pid: process.pid,
  }
  const ledger = new Map<string, Promise<Extract<ServerMessage, { kind: 'answer' }>>>()
  const completed: string[] = []
  const states = new Map<string, ClientState>()
  let closing: Promise<void> | null = null
  let idleSince: number | null = Date.now()
  const connections = new Set<Socket>()

  const answer = (peer: EnginePeer, id: string, work: () => Promise<unknown>): void => {
    const key = `${peer.hello.workspaceKey}:${peer.hello.clientId}:${id}`
    let result = ledger.get(key)
    if (result === undefined) {
      result = registry.context.run(peer, async () => {
        try {
          return { kind: 'answer' as const, id, ok: true, value: await work() }
        } catch (error) {
          return {
            kind: 'answer' as const,
            id,
            ok: false,
            error: error instanceof Error ? error.message : 'request-failed',
          }
        }
      })
      ledger.set(key, result)
      void result.then(() => {
        completed.push(key)
        while (completed.length > 512) {
          const oldest = completed.shift()
          if (oldest !== undefined) ledger.delete(oldest)
        }
      })
    }
    void result.then((message) => {
      peer.write(message)
    })
  }

  const invoke = async (peer: EnginePeer, channel: string, raw: unknown): Promise<unknown> => {
    const handler = registered.get(channel)
    if (handler === undefined) throw new Error('channel-refused')
    if (channel === 'conversation:layout') {
      const request = IPC_CONTRACT['conversation:layout'].request.parse(raw)
      peer.state.workspace = WorkspaceSnapshot.parse(request.workspace)
      for (const id of request.order) peer.state.conversationIds.add(id)
      peer.state.remember(runtime)
      return { ok: true }
    }
    if (channel === 'conversation:restore') {
      await handler({ sender: peer, isMainFrame: true }, raw)
      return {
        sessions: runtime
          .activeSessions()
          .filter((session) => peer.state.conversationIds.has(session.conversationId)),
        workspace: peer.state.workspace,
      }
    }
    if (channel === 'conversation:active')
      return {
        sessions: runtime
          .activeSessions()
          .filter((session) => peer.state.conversationIds.has(session.conversationId)),
      }
    const request =
      channel === 'console:evaluate'
        ? CONSOLE_CONTRACT['console:evaluate'].request.parse(raw)
        : null
    const result = await handler(
      { sender: peer, isMainFrame: true },
      request === null
        ? raw
        : { ...request, browserId: await browserSources.consoleBrowser(peer, request.browserId) }
    )
    if (channel === 'terminal:attach') {
      const request = IPC_CONTRACT['terminal:attach'].request.parse(raw)
      const attached = IPC_CONTRACT['terminal:attach'].response.parse(result)
      if (attached !== null)
        peer.terminals.set(JSON.stringify(request.ref), { ref: request.ref, epoch: attached.epoch })
    }
    if (channel === 'terminal:detach' || channel === 'terminal:dispose') {
      const request = IPC_CONTRACT['terminal:detach'].request.parse(raw)
      peer.terminals.delete(JSON.stringify(request.ref))
    }
    if (channel === 'settings:write') await host.flushSecrets()
    if (
      channel === 'conversation:begin' ||
      channel === 'conversation:start' ||
      channel === 'conversation:reopen' ||
      channel === 'aside:promote'
    ) {
      const parsed = z
        .object({ conversationId: z.string(), projectId: z.string() })
        .safeParse(result)
      if (parsed.success) {
        peer.state.conversationIds.add(parsed.data.conversationId)
        peer.projectIds.add(parsed.data.projectId)
      }
    }
    if (channel === 'conversation:close') {
      const request = IPC_CONTRACT['conversation:close'].request.parse(raw)
      peer.state.conversationIds.delete(request.conversationId)
    }
    if (
      channel === 'conversation:begin' ||
      channel === 'conversation:start' ||
      channel === 'conversation:reopen' ||
      channel === 'aside:promote' ||
      channel === 'conversation:awaitStart' ||
      channel === 'conversation:close' ||
      channel === 'project:close' ||
      channel === 'project:forget'
    )
      peer.state.remember(runtime)
    return result
  }

  const server = createServer((socket) => {
    connections.add(socket)
    let peer: EnginePeer | null = null
    const helloDeadline = setTimeout(() => {
      socket.destroy()
    }, 10_000)
    const reader = new FrameReader((raw) => {
      const parsed = ClientMessage.safeParse(raw)
      if (!parsed.success) {
        socket.destroy()
        return
      }
      const message = parsed.data
      if (peer === null) {
        if (
          message.kind !== 'hello' ||
          !message.trusted ||
          message.token.length !== descriptor.token.length ||
          !timingSafeEqual(Buffer.from(message.token), Buffer.from(descriptor.token))
        ) {
          socket.destroy()
          return
        }
        clearTimeout(helloDeadline)
        let state = states.get(message.workspaceKey)
        if (state === undefined) {
          state = new ClientState(options.dataDirectory, message.workspaceKey)
          states.set(message.workspaceKey, state)
        }
        peer = new EnginePeer(socket, message, state)
        if (
          message.protocol !== descriptor.protocol ||
          message.build !== descriptor.build ||
          message.runtimeVersion !== descriptor.runtimeVersion
        ) {
          const { token: _token, ...publicDescriptor } = descriptor
          const activity = runtime.activeWork()
          peer.write({ kind: 'restartRequired', descriptor: publicDescriptor, activity })
          if (!activity.busy || message.protocol !== descriptor.protocol) return
        }
        for (const previous of registry.peers)
          if (
            previous.hello.clientId === message.clientId &&
            previous.hello.workspaceKey === message.workspaceKey
          )
            previous.socket.destroy()
        peer.ready = true
        registry.peers.add(peer)
        host.loadSecrets(message.secrets)
        traffic.registerShell(peer, { kind: 'main' })
        run.registerShell(peer, { kind: 'main' })
        consoleIpc.registerShell(peer, { kind: 'main' })
        browser.registerShell(peer, { kind: 'main' })
        peer.write({
          kind: 'welcome',
          generation: descriptor.generation,
          throughSeq: runtime.logPosition(),
          activity: runtime.activeWork(),
          storage: state.storage,
        })
        peer.send(ATTENTION_ROOMS_CHANNEL, runtime.attentionRooms())
        if (!message.cold)
          void replayEvents(runtime, peer, message.lastSeq).catch(() => {
            socket.destroy()
          })
        return
      }
      const current = peer
      if (message.kind === 'status') {
        answer(current, message.id, () => Promise.resolve(runtime.activeWork()))
        return
      }
      if (message.kind === 'shutdown') {
        answer(current, message.id, () => {
          if (runtime.activeWork().busy) return Promise.reject(new Error('engine-busy'))
          setTimeout(() => {
            void close()
          }, 50)
          return Promise.resolve({ ok: true })
        })
        return
      }
      if (!current.ready) return
      switch (message.kind) {
        case 'hello':
          socket.destroy()
          break
        case 'hostAnswer':
          current.answerHost(message.id, message.ok, message.value, message.error)
          break
        case 'focus':
          {
            const previous = new Set(current.projectIds)
            browserSources.viewVisibility(current, message.viewVisible)
            registry.focus(
              current,
              message.focused,
              message.projectIds,
              message.lastSeq,
              message.focusedProjectId,
              message.attentive
            )
            host.projectVisibilityChanged(previous)
          }
          break
        case 'secret':
          host.loadSecrets({ [message.secretId]: message.value })
          host.invalidateCompletionCredential()
          break
        case 'editorContext':
          host.reportContext(message.report)
          break
        case 'diagnostic':
          answer(current, message.id, () =>
            Promise.resolve(host.diagnostic(message.projectId, message.params))
          )
          break
        case 'completionConfigured':
          answer(current, message.id, () =>
            Promise.resolve({ configured: completion.configured() })
          )
          break
        case 'completion':
          answer(current, message.id, async () => {
            if (!isCompletionPayload(message.payload)) throw new Error('invalid-completion-payload')
            const controller = new AbortController()
            current.completions.get(message.requestId)?.abort()
            current.completions.set(message.requestId, controller)
            try {
              return await completion.request(message.requestId, message.payload, controller.signal)
            } finally {
              if (current.completions.get(message.requestId) === controller)
                current.completions.delete(message.requestId)
            }
          })
          break
        case 'completionCancel':
          current.completions.get(message.requestId)?.abort()
          break
        case 'replay':
          answer(current, message.id, async () => {
            await replayEvents(runtime, current, message.afterSeq)
            return { ok: true }
          })
          break
        case 'invoke':
          answer(current, message.id, () => invoke(current, message.channel, message.request))
          break
        case 'adoptFolder':
          answer(current, message.id, () => {
            const { project, created } = runtime.projects.adopt(message.path)
            current.projectIds.add(project.id)
            return Promise.resolve({
              project: { id: project.id, name: project.name, root: project.root, created },
            })
          })
          break
        case 'journal':
          answer(current, message.id, () =>
            Promise.resolve(answerConversationNoteJournal(runtime, true, message.request))
          )
          break
        case 'storage':
          answer(current, message.id, () => {
            if (message.value !== undefined) current.state.setStorage(message.key, message.value)
            return Promise.resolve({ value: current.state.storage[message.key] ?? null })
          })
          break
      }
    })
    socket.on('data', (chunk) => {
      try {
        reader.push(chunk)
      } catch {
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.once('close', () => {
      clearTimeout(helloDeadline)
      connections.delete(socket)
      if (peer?.ready === true) {
        for (const controller of peer.completions.values()) controller.abort()
        peer.completions.clear()
        const previousProjects = new Set(peer.projectIds)
        if (closing === null) {
          for (const { ref, epoch } of peer.terminals.values()) runtime.detachTerminal(ref, epoch)
          peer.state.remember(runtime)
        }
        peer.terminals.clear()
        registry.peers.delete(peer)
        if (closing === null) host.projectVisibilityChanged(previousProjects)
        traffic.releaseShell(peer)
        run.releaseShell(peer)
        consoleIpc.releaseShell(peer)
        browser.releaseShell(peer)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  }).catch(async (error: unknown) => {
    await runtime.close()
    lock.release()
    throw error
  })
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600)
  writeDescriptor(options.dataDirectory, descriptor)
  const idleTimeout = options.idleTimeoutMs ?? 300_000
  const idle = setInterval(
    () => {
      if (registry.clients().length > 0 || runtime.activeWork().busy) {
        idleSince = null
        return
      }
      idleSince ??= Date.now()
      if (Date.now() - idleSince >= idleTimeout) void close()
    },
    Math.min(1000, Math.max(20, idleTimeout / 2))
  )
  idle.unref()
  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(idle)
      for (const state of states.values()) state.remember(runtime)
      for (const stop of stops) stop()
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      traffic.close()
      run.close()
      consoleIpc.close()
      await browser.close()
      consoles.close()
      await runtime.close()
      removeDescriptor(options.dataDirectory, descriptor.generation)
      lock.release()
    })()
    return closing
  }
  return { runtime, descriptor, close }
}
