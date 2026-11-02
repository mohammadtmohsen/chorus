import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOGCAT_FILTER } from '../shared/ipc.js'
import { linesFrom, LogcatService, type LogcatChild } from './logcat.js'

class FakeLogcat implements LogcatChild {
  killed = false
  stopped = false
  refuseStop = false

  stop(): Promise<void> {
    this.kill()
    if (this.refuseStop) return Promise.reject(new Error('logcat child still running'))
    this.stopped = true
    return Promise.resolve()
  }
  private line: (line: string) => void = () => undefined
  private exit: (code: number | null) => void = () => undefined

  constructor(readonly filters: string) {}

  kill(): void {
    this.killed = true
  }
  onLine(listener: (line: string) => void): void {
    this.line = listener
  }
  onExit(listener: (code: number | null) => void): void {
    this.exit = listener
  }

  emit(line: string): void {
    this.line(line)
  }
  finish(code: number | null): void {
    this.exit(code)
  }
}

const build = () => {
  const spawned: FakeLogcat[] = []
  const service = new LogcatService({
    spawn: (filters) => {
      const child = new FakeLogcat(filters)
      spawned.push(child)
      return child
    },
  })
  return { service, spawned }
}

describe('LogcatService', () => {
  it('spawns nothing until it is started', () => {
    const { spawned } = build()
    expect(spawned).toHaveLength(0)
  })

  it('delivers lines and remembers the tag it started with', () => {
    const { service, spawned } = build()
    const seen: string[] = []
    service.subscribe((line) => seen.push(line))

    service.start(DEFAULT_LOGCAT_FILTER)
    spawned[0]?.emit('hello')
    spawned[0]?.emit('world')

    expect(seen).toEqual(['hello', 'world'])
    expect(service.state()).toEqual({
      running: true,
      filters: DEFAULT_LOGCAT_FILTER,
      exitCode: null,
    })
  })

  it('does not spawn a second child while one is running', () => {
    const { service, spawned } = build()
    service.start('a')
    service.start('b')

    expect(spawned).toHaveLength(1)
    expect(service.state().filters).toBe('a')
  })

  it('reports an exit and stops claiming to run', () => {
    const { service, spawned } = build()
    const codes: (number | null)[] = []
    service.onExit((code) => codes.push(code))

    service.start('a')
    spawned[0]?.finish(2)

    expect(codes).toEqual([2])
    expect(service.state()).toEqual({ running: false, filters: 'a', exitCode: 2 })
  })

  it('kills on stop and says so without waiting for the child', () => {
    const { service, spawned } = build()
    const codes: (number | null)[] = []
    service.onExit((code) => codes.push(code))

    service.start('a')
    service.stop()

    expect(spawned[0]?.killed).toBe(true)
    expect(codes).toEqual([null])
    expect(service.state().running).toBe(false)
  })

  it('ignores an exit from a child that has already been replaced', () => {
    const { service, spawned } = build()
    const codes: (number | null)[] = []
    service.onExit((code) => codes.push(code))

    service.start('a')
    service.stop()
    service.start('b')
    spawned[0]?.finish(9)

    expect(codes).toEqual([null])
    expect(service.state()).toEqual({ running: true, filters: 'b', exitCode: null })
  })

  it('stops delivering lines once a subscriber is released', () => {
    const { service, spawned } = build()
    const seen: string[] = []
    const stop = service.subscribe((line) => seen.push(line))

    service.start('a')
    spawned[0]?.emit('one')
    stop()
    spawned[0]?.emit('two')

    expect(seen).toEqual(['one'])
  })
})

describe('linesFrom', () => {
  it('reads complete lines off a stream and carries a split one', () => {
    const stream = new PassThrough()
    const seen: string[] = []
    linesFrom(stream, (line) => seen.push(line))

    stream.write('one\ntw')
    stream.write('o\n')

    expect(seen).toEqual(['one', 'two'])
  })
})

it('confirms retired project logcat processes without stopping another project', async () => {
  const { service, spawned } = build()
  service.start('a', 'project-a')
  service.stop()
  service.start('b', 'project-b')
  await service.stopConfirmed('project-a')
  expect(spawned[0]?.stopped).toBe(true)
  expect(spawned[1]?.killed).toBe(false)
  expect(service.state().running).toBe(true)
})

it('retains failed logcat cleanup for retry', async () => {
  const { service, spawned } = build()
  service.start('a', 'project-a')
  const child = spawned[0]
  if (child === undefined) throw new Error('Missing logcat child')
  child.refuseStop = true
  await expect(service.stopConfirmed('project-a')).rejects.toThrow(/could not be confirmed/)
  expect(service.state().running).toBe(true)
  child.refuseStop = false
  await service.stopConfirmed('project-a')
  expect(service.state().running).toBe(false)
})
