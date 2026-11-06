import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { ShellClient } from '../../desktop/src/main/shell-client.js'
import type { TerminalRef } from '../../desktop/src/main/terminal.js'
import {
  EVENTS_PUSH_CHANNEL,
  EventsPush,
  type TranscriptEvent,
} from '../../desktop/src/shared/ipc.js'
import { PERSON_PACED_HOST_METHODS, type Hello, type ServerMessage } from './protocol.js'
import { encodeFrame } from './wire.js'
import type { ClientState } from './state.js'

export class EnginePeer implements ShellClient {
  readonly id: string
  readonly projectIds = new Set<string>()
  readonly terminals = new Map<string, { ref: TerminalRef; epoch: number }>()
  readonly completions = new Map<string, AbortController>()
  focusedAt = 0
  attentive = false
  focusedProjectId: string | null = null
  ready = false
  lastSeq: number
  private readonly gone = new Set<() => void>()
  private replaying: TranscriptEvent[] | null = null
  private replayBytes = 0
  private replayQueue: Promise<void> = Promise.resolve()
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout> | undefined
    }
  >()

  constructor(
    readonly socket: Socket,
    readonly hello: Hello,
    readonly state: ClientState
  ) {
    this.id = randomUUID()
    this.lastSeq = hello.lastSeq
    socket.once('close', () => {
      for (const listener of this.gone) listener()
      this.gone.clear()
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('host-disconnected'))
      }
      this.pending.clear()
    })
  }

  isGone(): boolean {
    return this.socket.destroyed
  }
  onGone(listener: () => void): () => void {
    this.gone.add(listener)
    return () => {
      this.gone.delete(listener)
    }
  }
  send(channel: string, payload: unknown): void {
    if (channel === EVENTS_PUSH_CHANNEL && this.replaying !== null) {
      const events = EventsPush.parse(payload)
      this.replayBytes += Buffer.byteLength(JSON.stringify(events))
      if (this.replayBytes > 64 * 1024 * 1024) this.socket.destroy()
      else this.replaying.push(...events)
      return
    }
    this.write({ kind: 'push', channel, payload })
  }
  replay(
    throughSeq: number,
    conversationIds: ReadonlySet<string>,
    batches: () => AsyncIterable<TranscriptEvent[]> | Iterable<TranscriptEvent[]>
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.isGone()) return
      this.replaying = []
      this.replayBytes = 0
      try {
        for await (const payload of batches()) {
          if (this.isGone()) return
          await this.writeAsync({ kind: 'push', channel: EVENTS_PUSH_CHANNEL, payload })
        }
      } finally {
        const pending = this.replaying
        this.replaying = null
        this.replayBytes = 0
        const events = pending.filter(
          (event) => !conversationIds.has(event.conversationId) || event.seq > throughSeq
        )
        for (const event of events) this.send(EVENTS_PUSH_CHANNEL, [event])
      }
    }
    const result = this.replayQueue.then(run)
    this.replayQueue = result.catch(() => undefined)
    return result
  }
  private writeAsync(message: ServerMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isGone()) {
        resolve()
        return
      }
      const close = (): void => {
        resolve()
      }
      this.socket.once('close', close)
      this.socket.write(encodeFrame(message), (error) => {
        this.socket.off('close', close)
        if (error !== null && error !== undefined) reject(error)
        else resolve()
      })
    })
  }
  write(message: ServerMessage): void {
    if (this.isGone()) return
    if (this.socket.writableLength > 64 * 1024 * 1024) {
      this.socket.destroy()
      return
    }
    this.socket.write(encodeFrame(message))
  }
  requestHost(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      if (this.isGone()) {
        reject(new Error('host-disconnected'))
        return
      }
      const timer = PERSON_PACED_HOST_METHODS.has(method)
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id)
            reject(new Error('host-timeout'))
          }, 300_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ kind: 'hostCall', id, method, params })
    })
  }
  answerHost(id: string, ok: boolean, value: unknown, error?: string): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (ok) pending.resolve(value)
    else pending.reject(new Error(error ?? 'host-request-failed'))
  }
}

export class PeerRegistry {
  readonly peers = new Set<EnginePeer>()
  readonly context = new AsyncLocalStorage<EnginePeer>()
  private focusClock = 0
  clients(): EnginePeer[] {
    return [...this.peers].filter((peer) => peer.ready && !peer.isGone())
  }
  focused(): EnginePeer | null {
    return this.clients().find((peer) => peer.attentive) ?? null
  }
  choose(projectId?: string): EnginePeer | null {
    const current = this.context.getStore()
    if (current?.ready === true && !current.isGone()) return current
    return (
      this.clients()
        .filter((peer) => projectId === undefined || peer.projectIds.has(projectId))
        .sort((a, b) => b.focusedAt - a.focusedAt)[0] ?? null
    )
  }
  focus(
    peer: EnginePeer,
    focused: boolean,
    projectIds: string[],
    lastSeq: number,
    focusedProjectId: string | null = null,
    attentive = false
  ): void {
    if (focused) peer.focusedAt = ++this.focusClock
    peer.attentive = attentive
    peer.projectIds.clear()
    for (const projectId of projectIds) peer.projectIds.add(projectId)
    peer.focusedProjectId =
      focusedProjectId !== null && peer.projectIds.has(focusedProjectId) ? focusedProjectId : null
    peer.lastSeq = lastSeq
  }
  request(method: string, params: unknown, projectId?: string): Promise<unknown> {
    const peer = this.choose(projectId)
    if (peer === null) return Promise.reject(new Error('no-connected-window'))
    return peer.requestHost(method, params)
  }
}
