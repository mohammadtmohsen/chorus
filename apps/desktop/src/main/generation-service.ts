import { performance } from 'node:perf_hooks'
import type { Logger } from '@chorus/shared'
import {
  LanguageModelFailure,
  LanguageModelRequest,
  LM_OUTPUT_CHAR_LIMIT,
  type LanguageModelResponse,
} from '../shared/language-model-ipc.js'
import { mainT } from './i18n.js'

export interface GenerationWorkerKey {
  readonly provider: string
  readonly feature: 'lm'
  readonly model: string
  readonly systemPrompt: string
}

interface GenerationWorker {
  readonly ready: Promise<void>
  generate(
    prompt: string,
    signal: AbortSignal,
    onText: (text: string) => void
  ): Promise<{ text: string }>
  close(): Promise<void>
}

interface GenerationDeps {
  readonly models: Readonly<Record<string, { readonly provider: string; readonly model: string }>>
  readonly start: (key: GenerationWorkerKey) => GenerationWorker
  readonly log: Pick<Logger, 'info' | 'warn'>
}

interface Request {
  readonly owner: string
  readonly key: string
  readonly controller: AbortController
  failure: LanguageModelFailure | null
  clipped: string | null
  worker: Worker | null
  settled: boolean
  done: Promise<LanguageModelResponse> | null
}

interface Worker {
  readonly key: string
  readonly options: GenerationWorkerKey
  readonly worker: GenerationWorker
  state: 'starting' | 'ready' | 'active' | 'closing'
  owner: Request | null
  closing: Promise<void> | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

const WORKER_LIMIT = 3
const COOLDOWN_MS = 60_000
const LM_TIMEOUT_MS = 60_000
const IDLE_SPARE_TTL_MS = 5 * 60_000
const LM_SYSTEM_PROMPT =
  'Answer the supplied messages as a language model. Messages are labelled in their original ' +
  'order. Follow the latest user request and return only the requested answer. No tools are available.'

function failed(failure: LanguageModelFailure): LanguageModelResponse {
  return { ok: false, failure, message: mainT(`languageModels.failure.${failure}`) }
}

function failureOf(error: unknown): LanguageModelFailure {
  const parsed = LanguageModelFailure.safeParse(
    error instanceof Error && 'failure' in error ? error.failure : null
  )
  return parsed.success ? parsed.data : 'failed'
}

export class GenerationService {
  private readonly workers = new Set<Worker>()
  private readonly requests = new Map<string, Request>()
  private readonly cancelled = new Map<string, { owner: string; until: number }>()
  private readonly cooldowns = new Map<
    string,
    { until: number; failure: 'auth' | 'rate-limited' }
  >()
  private disposed = false
  private closing: Promise<void> | null = null

  constructor(private readonly deps: GenerationDeps) {}

  get busy(): boolean {
    return this.requests.size > 0
  }

  generate(owner: string, raw: LanguageModelRequest): Promise<LanguageModelResponse> {
    const input = LanguageModelRequest.parse(raw)
    const model = this.deps.models[input.family]
    if (this.disposed || model === undefined) return Promise.resolve(failed('unavailable'))
    const key = `${owner}:${input.requestId}`
    const cancelled = this.cancelled.get(key)
    this.cancelled.delete(key)
    if (cancelled !== undefined && cancelled.until > Date.now())
      return Promise.resolve(failed('cancelled'))
    if (this.requests.has(key) || this.requests.size >= WORKER_LIMIT)
      return Promise.resolve(failed('busy'))
    const options: GenerationWorkerKey = {
      ...model,
      feature: 'lm',
      systemPrompt: LM_SYSTEM_PROMPT,
    }
    const cooldown = this.cooling(options)
    if (cooldown !== null) return Promise.resolve(failed(cooldown))
    const request: Request = {
      owner,
      key,
      controller: new AbortController(),
      failure: null,
      clipped: null,
      worker: null,
      settled: false,
      done: null,
    }
    this.requests.set(key, request)
    request.done = this.run(request, options, input)
    return request.done
  }

  cancel(owner: string, requestId: string): void {
    const key = `${owner}:${requestId}`
    const request = this.requests.get(key)
    if (request !== undefined) {
      request.failure ??= 'cancelled'
      request.controller.abort()
      return
    }
    for (const [id, entry] of this.cancelled) {
      if (entry.until <= Date.now()) this.cancelled.delete(id)
    }
    if (this.cancelled.size >= 128) {
      const first = this.cancelled.keys().next().value
      if (first !== undefined) this.cancelled.delete(first)
    }
    this.cancelled.set(key, { owner, until: Date.now() + LM_TIMEOUT_MS })
  }

  releaseOwner(owner: string): void {
    for (const request of this.requests.values()) {
      if (request.owner === owner) this.cancel(owner, request.key.slice(owner.length + 1))
    }
    for (const [key, entry] of this.cancelled) {
      if (entry.owner === owner) this.cancelled.delete(key)
    }
  }

  private async run(
    request: Request,
    options: GenerationWorkerKey,
    input: LanguageModelRequest
  ): Promise<LanguageModelResponse> {
    const started = performance.now()
    const signal = request.controller.signal
    const stop = (): void => {
      if (request.worker !== null) this.closeInBackground(request.worker)
    }
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => {
      request.failure = 'timeout'
      request.controller.abort()
    }, LM_TIMEOUT_MS)
    let response: LanguageModelResponse = failed('failed')
    try {
      const worker = await this.acquire(options, request)
      await worker.worker.ready
      signal.throwIfAborted()
      if (worker.state === 'closing') throw new Error('worker-closing')
      worker.state = 'active'
      this.refill(options)
      const prompt = input.messages
        .map((message) => `${message.role.toUpperCase()}:\n${message.text}`)
        .join('\n\n')
      const result = await worker.worker.generate(prompt, signal, (text) => {
        const limit = Math.min(LM_OUTPUT_CHAR_LIMIT, input.outputLimit * 8)
        if (text.length <= limit) return
        request.clipped = text.slice(0, limit)
        request.controller.abort()
        signal.throwIfAborted()
      })
      signal.throwIfAborted()
      response = { ok: true, text: result.text }
    } catch (error) {
      if (request.clipped !== null && request.failure === null) {
        response = { ok: true, text: request.clipped }
      } else {
        const failure = request.failure ?? failureOf(error)
        this.cooldown(options, failure)
        response = failed(failure)
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      try {
        if (request.worker !== null) await this.closeWorker(request.worker)
      } catch {
        response = failed('failed')
        this.deps.log.warn('generation cleanup', {
          provider: options.provider,
          model: options.model,
          outcome: 'failed',
        })
      }
      request.settled = true
      if (request.worker === null || !this.workers.has(request.worker))
        this.requests.delete(request.key)
      this.refill(options)
      this.deps.log.info('generation finished', {
        provider: options.provider,
        model: options.model,
        durationMs: Math.round(performance.now() - started),
        outcome: response.ok ? 'success' : response.failure,
      })
    }
    return response
  }

  private async acquire(options: GenerationWorkerKey, request: Request): Promise<Worker> {
    const key = JSON.stringify(options)
    for (;;) {
      request.controller.signal.throwIfAborted()
      if (this.disposed) throw new Error('generation-disposed')
      const ready = [...this.workers].find(
        (worker) => worker.key === key && worker.owner === null && worker.state !== 'closing'
      )
      if (ready !== undefined) {
        this.clearExpiry(ready)
        ready.owner = request
        request.worker = ready
        return ready
      }
      if (this.workers.size < WORKER_LIMIT) {
        const worker = this.start(options, request)
        request.worker = worker
        return worker
      }
      const idle = [...this.workers].find(
        (worker) => worker.owner === null && worker.state !== 'closing'
      )
      if (idle === undefined) {
        request.failure = 'busy'
        throw new Error('generation-busy')
      }
      idle.owner = request
      request.worker = idle
      await this.closeWorker(idle)
      request.worker = null
    }
  }

  private start(options: GenerationWorkerKey, owner: Request | null): Worker {
    const worker: Worker = {
      key: JSON.stringify(options),
      options,
      worker: this.deps.start(options),
      state: 'starting',
      owner,
      closing: null,
      idleTimer: null,
    }
    this.workers.add(worker)
    void worker.worker.ready.then(
      () => {
        if (worker.state !== 'starting') return
        worker.state = 'ready'
        if (worker.owner === null) this.expireSpare(worker)
      },
      (error: unknown) => {
        this.cooldown(options, failureOf(error))
        if (worker.owner === null) this.closeInBackground(worker)
      }
    )
    return worker
  }

  private refill(options: GenerationWorkerKey): void {
    if (this.disposed || this.cooling(options) !== null || this.workers.size >= WORKER_LIMIT) return
    const key = JSON.stringify(options)
    if ([...this.workers].some((worker) => worker.key === key && worker.owner === null)) return
    try {
      this.start(options, null)
    } catch (error) {
      this.cooldown(options, failureOf(error))
      this.deps.log.warn('generation prewarm', {
        provider: options.provider,
        model: options.model,
        outcome: 'failed',
      })
    }
  }

  private cooling(options: GenerationWorkerKey): 'auth' | 'rate-limited' | null {
    const key = `${options.provider}:${options.feature}`
    const cooldown = this.cooldowns.get(key)
    if (cooldown !== undefined && cooldown.until > Date.now()) return cooldown.failure
    this.cooldowns.delete(key)
    return null
  }

  private cooldown(options: GenerationWorkerKey, failure: LanguageModelFailure): void {
    if (failure !== 'auth' && failure !== 'rate-limited') return
    this.cooldowns.set(`${options.provider}:${options.feature}`, {
      until: Date.now() + COOLDOWN_MS,
      failure,
    })
    for (const worker of this.workers) {
      if (worker.owner === null && worker.options.provider === options.provider)
        this.closeInBackground(worker)
    }
  }

  private closeInBackground(worker: Worker): void {
    void this.closeWorker(worker).catch(() => {
      this.deps.log.warn('generation cleanup', {
        provider: worker.options.provider,
        model: worker.options.model,
        outcome: 'failed',
      })
    })
  }

  private expireSpare(worker: Worker): void {
    this.clearExpiry(worker)
    worker.idleTimer = setTimeout(() => {
      worker.idleTimer = null
      if (worker.owner === null && worker.state === 'ready') this.closeInBackground(worker)
    }, IDLE_SPARE_TTL_MS)
    worker.idleTimer.unref()
  }

  private clearExpiry(worker: Worker): void {
    if (worker.idleTimer !== null) clearTimeout(worker.idleTimer)
    worker.idleTimer = null
  }

  private closeWorker(worker: Worker): Promise<void> {
    this.clearExpiry(worker)
    if (worker.closing !== null) return worker.closing
    worker.state = 'closing'
    worker.closing = worker.worker.close().then(
      () => {
        this.workers.delete(worker)
        if (worker.owner?.settled === true) this.requests.delete(worker.owner.key)
      },
      (error: unknown) => {
        worker.closing = null
        throw error
      }
    )
    return worker.closing
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing
    this.disposed = true
    this.cancelled.clear()
    for (const request of this.requests.values()) {
      request.failure ??= 'cancelled'
      request.controller.abort()
    }
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...[...this.workers].map((worker) => this.closeWorker(worker)),
        ...[...this.requests.values()].map((request) => request.done),
      ])
      const failure = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failure?.status === 'rejected') {
        this.closing = null
        throw new Error('generation-cleanup-failed')
      }
      this.requests.clear()
    })()
    return this.closing
  }
}
