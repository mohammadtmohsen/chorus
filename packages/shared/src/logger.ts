import { redactText } from './redact.js'

/**
 * Structured logging to a rotating JSONL file.
 *
 * The plan named pino. This is deliberately not pino: the volume here is a few
 * hundred lines per session, so none of what pino is good at applies, and a
 * hundred lines with no dependency is easier to audit — which matters, because
 * this file is the one thing a user is asked to attach to a bug report.
 *
 * Every message and every string field passes through the same redaction the
 * event log uses. A secret scrubbed from the transcript and left in the log is
 * not scrubbed.
 *
 * `console` is not an alternative: it bypasses redaction, and in a packaged app
 * nobody is watching stdout.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogEntry {
  readonly at: number
  readonly level: LogLevel
  readonly message: string
  readonly fields?: Record<string, unknown>
}

export interface LogSink {
  write(line: string): void
  /** Bytes written so far, for rotation. */
  size(): number
  rotate(): void
}

export interface LoggerOptions {
  readonly sink?: LogSink
  readonly minLevel?: LogLevel
  readonly maxBytes?: number
  /** Kept in memory for the in-app viewer, so it needs no file read. */
  readonly bufferSize?: number
  readonly now?: () => number
}

export class Logger {
  private readonly sink: LogSink | undefined
  private readonly minLevel: LogLevel
  private readonly maxBytes: number
  private readonly bufferSize: number
  private readonly now: () => number
  private readonly buffer: LogEntry[] = []

  constructor(options: LoggerOptions = {}) {
    this.sink = options.sink
    this.minLevel = options.minLevel ?? 'info'
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    this.bufferSize = options.bufferSize ?? 500
    this.now = options.now ?? (() => Date.now())
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields)
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields)
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields)
  }

  /** Errors carry the message and name, never the stack: stacks leak paths. */
  error(message: string, error?: unknown, fields?: Record<string, unknown>): void {
    this.log('error', message, {
      ...fields,
      ...(error === undefined
        ? {}
        : {
            error: describeError(error),
            errorName: error instanceof Error ? error.name : 'unknown',
          }),
    })
  }

  /** Most recent first — a reader looking at a log wants what just happened. */
  recent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit).reverse()
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) return

    const entry: LogEntry = {
      at: this.now(),
      level,
      message: redactText(message).text,
      ...(fields === undefined ? {} : { fields: redactFields(fields) }),
    }

    this.buffer.push(entry)
    if (this.buffer.length > this.bufferSize) this.buffer.shift()

    if (this.sink === undefined) return
    try {
      if (this.sink.size() > this.maxBytes) this.sink.rotate()
      this.sink.write(`${JSON.stringify(entry)}\n`)
    } catch {
      // A logger that throws takes down the thing it was meant to explain.
    }
  }
}

/** Never `String(value)` — an object would stringify to "[object Object]". */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  // Only objects are worth serialising; a function or symbol has nothing to say.
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      // Circular, or a throwing toJSON.
      return 'unserialisable error'
    }
  }
  return 'unknown error'
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === 'string' ? redactText(value).text : value
  }
  return out
}

/**
 * A diagnostics bundle the user can attach to a bug report.
 *
 * Returned as text rather than written here, so the caller decides where it
 * lands — and so this stays testable without a filesystem.
 */
export function buildDiagnostics(input: {
  entries: readonly LogEntry[]
  versions: Record<string, string>
  counts: Record<string, number>
  generatedAt: number
}): string {
  const lines = [
    '# Chorus diagnostics',
    '',
    `Generated: ${new Date(input.generatedAt).toISOString()}`,
    '',
    '## Versions',
    ...Object.entries(input.versions).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Counts',
    ...Object.entries(input.counts).map(([k, v]) => `- ${k}: ${String(v)}`),
    '',
    '## Recent log',
    '',
    // Already redacted on the way in; running it again would be theatre.
    ...input.entries.map(
      (e) =>
        `${new Date(e.at).toISOString()} ${e.level.padEnd(5)} ${e.message}` +
        (e.fields === undefined ? '' : ` ${JSON.stringify(e.fields)}`)
    ),
    '',
    '_Secrets are removed as the log is written, not as it is exported._',
  ]
  return lines.join('\n')
}
