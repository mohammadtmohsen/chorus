import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { startup, type Query, type WarmQuery } from '@anthropic-ai/claude-agent-sdk'
import { ownProcessTree, type OwnedProcessTree } from '@chorus/shared/process-tree'
import type { ResolvedExecutable } from './claude-adapter.js'

const CLAUDE_GENERATION_OUTPUT_TOKENS = 8_192

export interface ClaudeGenerationOptions {
  readonly resolveExecutable: () => Promise<ResolvedExecutable | null>
  readonly cwd: string
  readonly model: string
  readonly systemPrompt: string
  readonly env?: () => Readonly<Record<string, string | undefined>>
  readonly timing: (fields: { firstTokenMs: number | null; durationMs: number }) => void
}

export class ClaudeGenerationError extends Error {
  constructor(readonly failure: 'unavailable' | 'auth' | 'rate-limited' | 'failed') {
    super(failure)
    this.name = 'ClaudeGenerationError'
  }
}

function generationError(error: unknown): ClaudeGenerationError {
  if (error instanceof ClaudeGenerationError) return error
  const text = error instanceof Error ? error.message : String(error)
  if (/authentication|oauth|unauthorized|not logged in|\b401\b|\b403\b/i.test(text))
    return new ClaudeGenerationError('auth')
  if (/rate.?limit|\b429\b|usage limit/i.test(text))
    return new ClaudeGenerationError('rate-limited')
  return new ClaudeGenerationError('failed')
}

export class ClaudeGenerationWorker {
  readonly ready: Promise<void>
  private readonly controller = new AbortController()
  private warm: WarmQuery | undefined
  private query: Query | undefined
  private tree: OwnedProcessTree | undefined
  private closing: Promise<void> | null = null
  private closed = false
  private cleaned = false
  private used = false

  constructor(private readonly options: ClaudeGenerationOptions) {
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    try {
      const executable = await this.options.resolveExecutable()
      this.controller.signal.throwIfAborted()
      if (executable?.sdkPath == null) throw new ClaudeGenerationError('unavailable')
      this.warm = await startup({
        initializeTimeoutMs: 30_000,
        options: {
          pathToClaudeCodeExecutable: executable.sdkPath,
          cwd: this.options.cwd,
          model: this.options.model,
          systemPrompt: this.options.systemPrompt,
          title: 'Chorus',
          tools: [],
          settingSources: [],
          skills: [],
          mcpServers: {},
          strictMcpConfig: true,
          plugins: [],
          hooks: {},
          settings: { disableAllHooks: true },
          persistSession: false,
          includePartialMessages: true,
          thinking: { type: 'disabled' },
          abortController: this.controller,
          env: {
            ...process.env,
            ...this.options.env?.(),
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(CLAUDE_GENERATION_OUTPUT_TOKENS),
          },
          spawnClaudeCodeProcess: (spec) => {
            this.controller.signal.throwIfAborted()
            const child = spawn(spec.command, spec.args, {
              ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
              env: spec.env,
              signal: spec.signal,
              stdio: ['pipe', 'pipe', 'pipe'],
              detached: process.platform !== 'win32',
              windowsHide: true,
            })
            const rootExited = new Promise<void>((resolve) => {
              child.once('exit', () => {
                resolve()
              })
              child.once('error', () => {
                resolve()
              })
            })
            if (child.pid !== undefined)
              this.tree = ownProcessTree(child.pid, {
                processGroup: process.platform !== 'win32',
                rootExited,
              })
            child.stderr.resume()
            child.stderr.on('error', () => undefined)
            return child
          },
        },
      })
      if (this.closed) this.warm.close()
      this.controller.signal.throwIfAborted()
    } catch (error) {
      if (this.controller.signal.aborted) throw this.controller.signal.reason
      throw generationError(error)
    }
  }

  async generate(
    prompt: string,
    signal: AbortSignal,
    onText: (text: string) => void
  ): Promise<{ text: string }> {
    await this.ready
    signal.throwIfAborted()
    this.controller.signal.throwIfAborted()
    if (this.used || this.warm === undefined) throw new ClaudeGenerationError('failed')
    this.used = true
    const started = performance.now()
    let firstTokenMs: number | null = null
    let text = ''
    const cancel = (): void => {
      this.controller.abort()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      this.query = this.warm.query(prompt)
      for await (const message of this.query) {
        signal.throwIfAborted()
        if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected')
          throw new ClaudeGenerationError('rate-limited')
        if (message.type === 'assistant') {
          if (message.error !== undefined) throw generationError(new Error(message.error))
          if (message.message.content.some((part) => part.type === 'tool_use'))
            throw new ClaudeGenerationError('failed')
        }
        if (
          message.type === 'stream_event' &&
          message.event.type === 'content_block_delta' &&
          message.event.delta.type === 'text_delta'
        ) {
          firstTokenMs ??= performance.now() - started
          text += message.event.delta.text
          onText(text)
        }
        if (message.type !== 'result') continue
        if (message.subtype !== 'success')
          throw generationError(new Error(message.errors.join('\n')))
        if (message.is_error) throw generationError(new Error(message.result))
        text = message.result
        if (text !== '') firstTokenMs ??= performance.now() - started
        onText(text)
        return { text }
      }
      throw new ClaudeGenerationError('failed')
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw generationError(error)
    } finally {
      signal.removeEventListener('abort', cancel)
      this.options.timing({ firstTokenMs, durationMs: performance.now() - started })
    }
  }

  close(): Promise<void> {
    if (this.cleaned) return Promise.resolve()
    if (this.closing !== null) return this.closing
    this.closed = true
    this.controller.abort()
    const graceful = (): void => {
      if (this.query !== undefined) this.query.close()
      else this.warm?.close()
    }
    const closing = (async () => {
      const stopped = this.tree?.stop(graceful)
      const outcomes = await Promise.allSettled([this.ready, stopped])
      const stop = outcomes[1]
      if (stop.status === 'rejected') throw stop.reason
      if (this.tree === undefined) graceful()
      else await this.tree.stop(graceful)
      this.cleaned = true
    })()
    this.closing = closing.catch((error: unknown) => {
      this.closing = null
      throw error
    })
    return this.closing
  }
}
