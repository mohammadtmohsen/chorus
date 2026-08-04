import { describe, expect, it } from 'vitest'
import { buildDiagnostics, Logger, type LogSink } from './logger.js'

function memorySink(): LogSink & { lines: string[]; rotations: number } {
  const state = {
    lines: [] as string[],
    rotations: 0,
    write(line: string) {
      state.lines.push(line)
    },
    size: () => state.lines.join('').length,
    rotate() {
      state.rotations += 1
      state.lines.length = 0
    },
  }
  return state
}

describe('Logger', () => {
  it('writes one JSON object per line', () => {
    const sink = memorySink()
    new Logger({ sink, now: () => 1_000 }).info('started', { port: 9000 })

    expect(sink.lines).toHaveLength(1)
    expect(JSON.parse(sink.lines[0] ?? '{}')).toMatchObject({
      at: 1_000,
      level: 'info',
      message: 'started',
      fields: { port: 9000 },
    })
  })

  it('drops entries below the minimum level', () => {
    const sink = memorySink()
    const log = new Logger({ sink, minLevel: 'warn' })
    log.debug('noise')
    log.info('also noise')
    log.warn('this matters')
    expect(sink.lines).toHaveLength(1)
  })

  it('redacts the message', () => {
    // A secret scrubbed from the transcript and left in the log is not scrubbed.
    const sink = memorySink()
    new Logger({ sink }).info('using ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234')
    expect(sink.lines[0]).toContain('[redacted:github-token]')
    expect(sink.lines[0]).not.toContain('ghp_AbCdEf')
  })

  it('redacts string fields too', () => {
    const sink = memorySink()
    new Logger({ sink }).warn('auth failed', { header: 'Bearer abcdefghijklmnopqrstuvwxyz1' })
    expect(sink.lines[0]).not.toContain('abcdefghijklmnopqrstuvwxyz1')
  })

  it('records an error message without its stack', () => {
    // Stacks leak absolute paths, which is exactly what a shared bundle should
    // not carry.
    const sink = memorySink()
    new Logger({ sink }).error('adapter died', new Error('spawn ENOENT'))
    const entry = JSON.parse(sink.lines[0] ?? '{}') as { fields?: Record<string, unknown> }
    expect(entry.fields).toMatchObject({ error: 'spawn ENOENT', errorName: 'Error' })
    expect(sink.lines[0]).not.toContain('at Object')
  })

  it('rotates once the file grows past its limit', () => {
    const sink = memorySink()
    const log = new Logger({ sink, maxBytes: 200 })
    for (let i = 0; i < 20; i++) log.info(`entry number ${String(i)} with some padding text`)
    expect(sink.rotations).toBeGreaterThan(0)
  })

  it('never throws, even when the sink does', () => {
    // A logger that throws takes down the thing it was meant to explain.
    const broken: LogSink = {
      write() {
        throw new Error('disk full')
      },
      size: () => 0,
      rotate() {
        throw new Error('disk full')
      },
    }
    expect(() => {
      new Logger({ sink: broken }).error('something')
    }).not.toThrow()
  })

  it('keeps a bounded in-memory buffer, most recent first', () => {
    const log = new Logger({ bufferSize: 3 })
    for (const m of ['a', 'b', 'c', 'd']) log.info(m)
    expect(log.recent().map((e) => e.message)).toEqual(['d', 'c', 'b'])
  })

  it('works with no sink at all', () => {
    const log = new Logger()
    expect(() => {
      log.info('fine')
    }).not.toThrow()
    expect(log.recent()).toHaveLength(1)
  })
})

describe('buildDiagnostics', () => {
  it('includes versions, counts and the recent log', () => {
    const bundle = buildDiagnostics({
      generatedAt: 0,
      versions: { chorus: '0.0.0', codex: '0.146.0' },
      counts: { events: 42 },
      entries: [{ at: 0, level: 'warn', message: 'something happened' }],
    })
    expect(bundle).toContain('codex: 0.146.0')
    expect(bundle).toContain('events: 42')
    expect(bundle).toContain('something happened')
  })

  it('says plainly where redaction happened', () => {
    const bundle = buildDiagnostics({ generatedAt: 0, versions: {}, counts: {}, entries: [] })
    expect(bundle).toMatch(/removed as the log is written/)
  })
})
