import { z } from 'zod'
import {
  CONVERSATION_NOTE_JOURNAL_MAX_LENGTH,
  ConversationNoteJournalResponse,
  type ConversationNoteJournalRequest,
} from './ipc.js'
import type { JournalAnswer, JournalBackend } from './note-journal.js'

const JournalRaw = z.string().max(CONVERSATION_NOTE_JOURNAL_MAX_LENGTH).nullable()

export const MirroredJournalSnapshot = z
  .object({
    acknowledged: JournalRaw,
    current: JournalRaw,
    pending: z.boolean(),
    conflicted: z.boolean().default(false),
  })
  .strict()
export type MirroredJournalSnapshot = z.infer<typeof MirroredJournalSnapshot>

export interface MirroredJournalRemote {
  read(): Promise<ConversationNoteJournalResponse>
  compare(expected: string | null, next: string | null): Promise<ConversationNoteJournalResponse>
}

export interface MirroredJournalOptions {
  readonly backup?: unknown
  readonly save?: (snapshot: MirroredJournalSnapshot) => void
}

interface JournalWrite {
  readonly expected: string | null
  readonly next: string | null
}

export class MirroredJournalBackend implements JournalBackend {
  private current: string | null = null
  private acknowledged: string | null = null
  private ready = false
  private conflict = false
  private failure: Error | null = null
  private blockedExpected: string | null | undefined
  private preparing: Promise<void> | null = null
  private running: Promise<void> | null = null
  private generation = 0
  private readonly queue: JournalWrite[] = []
  private readonly listeners = new Set<() => void>()
  private readonly backup: MirroredJournalSnapshot | null

  constructor(
    private readonly remote: MirroredJournalRemote,
    private readonly options: MirroredJournalOptions = {}
  ) {
    const parsed = MirroredJournalSnapshot.safeParse(options.backup)
    this.backup = parsed.success ? parsed.data : null
  }

  prepare(): Promise<void> {
    if (this.preparing !== null) return this.preparing
    if (this.ready && this.failure === null && !this.conflict) return Promise.resolve()
    const preparing = this.load()
    this.preparing = preparing
    void preparing.then(
      () => {
        this.preparing = null
        this.start()
        this.notify()
      },
      () => {
        this.preparing = null
      }
    )
    return preparing
  }

  read(): JournalAnswer {
    return this.ready ? { ok: true, matched: true, current: this.current } : { ok: false }
  }

  compare(expected: string | null, next: string | null): JournalAnswer {
    if (!JournalRaw.safeParse(expected).success || !JournalRaw.safeParse(next).success)
      return { ok: false }
    if (!this.ready) return { ok: false }
    if (this.failure !== null || this.preparing !== null) {
      this.retain(expected, next)
      return { ok: false }
    }
    if (this.conflict && expected !== this.acknowledged) {
      this.retain(expected, next)
      return { ok: true, matched: false, current: this.acknowledged }
    }
    const current = this.conflict ? this.acknowledged : this.current
    if (expected !== current) return { ok: true, matched: false, current }
    this.conflict = false
    this.blockedExpected = undefined
    this.current = next
    if (next !== current) this.queue.push({ expected: current, next })
    this.persist()
    this.start()
    return { ok: true, matched: true, current: next }
  }

  answer(request: ConversationNoteJournalRequest): ConversationNoteJournalResponse {
    const answer =
      request.op === 'read' ? this.read() : this.compare(request.expected, request.next)
    return answer.ok ? answer : { ok: false, error: this.failure?.message ?? '' }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): MirroredJournalSnapshot {
    return {
      acknowledged: this.acknowledged,
      current: this.current,
      pending: this.queue.length > 0 || this.conflict,
      conflicted: this.conflict,
    }
  }

  rebase(authoritative: string | null): void {
    JournalRaw.parse(authoritative)
    this.generation += 1
    this.acknowledged = authoritative
    this.queue.length = 0
    this.failure = null
    this.conflict = this.current !== authoritative
    this.persist()
    this.notify()
  }

  async flush(): Promise<void> {
    await this.preparing
    while (this.running !== null) await this.running
    if (this.failure !== null) throw this.failure
    if (!this.ready || this.conflict) throw new Error()
  }

  private async load(): Promise<void> {
    await this.running
    try {
      const answer = ConversationNoteJournalResponse.parse(await this.remote.read())
      if (!answer.ok) throw new Error(answer.error)
      const recovered = this.ready ? this.snapshot() : this.backup
      this.acknowledged = answer.current
      this.current = recovered?.pending ? recovered.current : answer.current
      this.queue.length = 0
      this.failure = null
      this.blockedExpected = undefined
      this.conflict = false
      this.ready = true
      if (this.current !== answer.current) {
        if (
          recovered?.pending &&
          !recovered.conflicted &&
          recovered.acknowledged === answer.current
        )
          this.queue.push({ expected: answer.current, next: this.current })
        else this.conflict = true
      }
      this.persist()
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error()
      this.notify()
      throw this.failure
    }
  }

  private retain(expected: string | null, next: string | null): void {
    if (expected !== this.current && expected !== this.blockedExpected) return
    this.blockedExpected ??= expected
    this.current = next
    if (this.queue.length === 0) this.conflict = true
    this.persist()
  }

  private start(): void {
    if (
      !this.ready ||
      this.running !== null ||
      this.preparing !== null ||
      this.failure !== null ||
      this.conflict ||
      this.queue.length === 0
    )
      return
    this.running = this.drain().then(() => {
      this.running = null
      this.start()
    })
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.failure === null && !this.conflict) {
      const write = this.queue[0]
      if (write === undefined) return
      const generation = this.generation
      try {
        const answer = ConversationNoteJournalResponse.parse(
          await this.remote.compare(write.expected, write.next)
        )
        if (generation !== this.generation) return
        if (!answer.ok) throw new Error(answer.error)
        if (!answer.matched && answer.current !== write.next) {
          this.rebase(answer.current)
          return
        }
        if (answer.current !== write.next) throw new Error()
        this.acknowledged = answer.current
        this.queue.shift()
        this.persist()
        this.notify()
      } catch (error) {
        if (generation !== this.generation) return
        this.failure = error instanceof Error ? error : new Error()
        this.persist()
        this.notify()
        return
      }
    }
  }

  private persist(): void {
    try {
      this.options.save?.(this.snapshot())
    } catch {
      return
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
