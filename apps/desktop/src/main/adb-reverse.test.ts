import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AdbReverse,
  parseDeviceLists,
  rememberDevices,
  reverseArgs,
  reverseCommands,
  type AdbReverseOptions,
  type AdbTracker,
} from './adb-reverse.js'

const PHONE = '192.168.1.17:5555'

const frame = (body: string): string => body.length.toString(16).padStart(4, '0') + body

class FakeTracker implements AdbTracker {
  killed = false
  private data: (chunk: string) => void = () => undefined
  private exit: (missing: boolean) => void = () => undefined

  kill(): void {
    this.killed = true
  }
  stop(): Promise<void> {
    this.kill()
    return Promise.resolve()
  }
  onData(listener: (chunk: string) => void): void {
    this.data = listener
  }
  onExit(listener: (missing: boolean) => void): void {
    this.exit = listener
  }
  devices(...lines: string[]): void {
    this.data(frame(lines.map((line) => `${line}\n`).join('')))
  }
  end(missing: boolean): void {
    this.exit(missing)
  }
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

const harness = (
  options: AdbReverseOptions = {}
): {
  reverse: AdbReverse
  trackers: FakeTracker[]
  ran: string[][]
  warned: string[]
  connected: string[]
  saved: string[][]
} => {
  const trackers: FakeTracker[] = []
  const ran: string[][] = []
  const warned: string[] = []
  const connected: string[] = []
  const saved: string[][] = []
  const reverse = new AdbReverse({
    track: () => {
      const tracker = new FakeTracker()
      trackers.push(tracker)
      return tracker
    },
    run: (args) => {
      ran.push([...args])
      return Promise.resolve()
    },
    connect: (address) => {
      connected.push(address)
      return Promise.resolve()
    },
    load: () => [],
    save: (addresses) => {
      saved.push([...addresses])
    },
    warn: (message) => {
      warned.push(message)
    },
    retryMs: 60_000,
    reconnectMs: 10_000,
    ...options,
  })
  return { reverse, trackers, ran, warned, connected, saved }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseDeviceLists', () => {
  it('reads one length-prefixed list as adb prints it', () => {
    expect(parseDeviceLists('0013R58TC1151DM\tdevice\n')).toEqual({
      lists: [[{ serial: 'R58TC1151DM', state: 'device' }]],
      rest: '',
    })
  })

  it('reads an empty list as no devices', () => {
    expect(parseDeviceLists('0000')).toEqual({ lists: [[]], rest: '' })
  })

  it('keeps a frame split across chunks until the rest arrives', () => {
    const whole = frame('emulator-5554\tdevice\n')
    const first = parseDeviceLists(whole.slice(0, 9))
    expect(first.lists).toEqual([])
    const second = parseDeviceLists(first.rest + whole.slice(9))
    expect(second.lists).toEqual([[{ serial: 'emulator-5554', state: 'device' }]])
    expect(second.rest).toBe('')
  })

  it('reads two frames that arrive in one chunk', () => {
    const read = parseDeviceLists(frame('A\tunauthorized\n') + frame('A\tdevice\nB\tdevice\n'))
    expect(read.lists).toEqual([
      [{ serial: 'A', state: 'unauthorized' }],
      [
        { serial: 'A', state: 'device' },
        { serial: 'B', state: 'device' },
      ],
    ])
  })

  it('drops the buffer when the length prefix is not hex', () => {
    expect(parseDeviceLists('zzzzA\tdevice\n')).toEqual({ lists: [], rest: '' })
  })
})

describe('reverseCommands', () => {
  it('adds every wanted port to a device that has none', () => {
    expect(reverseCommands(new Map(), ['A'], new Set([30_100, 30_101]))).toEqual([
      { serial: 'A', port: 30_100, add: true },
      { serial: 'A', port: 30_101, add: true },
    ])
  })

  it('removes a port that is no longer wanted and leaves a satisfied one', () => {
    const applied = new Map([['A', new Set([30_100, 30_101])]])
    expect(reverseCommands(applied, ['A'], new Set([30_100]))).toEqual([
      { serial: 'A', port: 30_101, add: false },
    ])
  })

  it('covers every attached device', () => {
    const applied = new Map([['A', new Set([30_100])]])
    expect(reverseCommands(applied, ['A', 'B'], new Set([30_100]))).toEqual([
      { serial: 'B', port: 30_100, add: true },
    ])
  })
})

describe('rememberDevices', () => {
  it('keeps Wi-Fi devices only, most recently seen first', () => {
    const devices = [
      { serial: 'R58TC1151DM', state: 'device' },
      { serial: PHONE, state: 'device' },
      { serial: '192.168.1.40:5555', state: 'unauthorized' },
      { serial: 'emulator-5554', state: 'device' },
    ]
    expect(rememberDevices(['10.0.0.9:5555', PHONE], devices)).toEqual([PHONE, '10.0.0.9:5555'])
  })

  it('keeps at most the limit', () => {
    const previous = ['a:1', 'b:1', 'c:1', 'd:1', 'e:1']
    expect(rememberDevices(previous, [{ serial: 'f:1', state: 'device' }])).toEqual([
      'f:1',
      'a:1',
      'b:1',
      'c:1',
      'd:1',
    ])
  })
})

describe('reverseArgs', () => {
  it('names the device and the same port on both sides', () => {
    expect(reverseArgs({ serial: 'A', port: 30_100, add: true })).toEqual([
      '-s',
      'A',
      'reverse',
      'tcp:30100',
      'tcp:30100',
    ])
    expect(reverseArgs({ serial: 'A', port: 30_100, add: false })).toEqual([
      '-s',
      'A',
      'reverse',
      '--remove',
      'tcp:30100',
    ])
  })
})

describe('AdbReverse', () => {
  it('starts no tracker while nothing is capturing', () => {
    const { reverse, trackers } = harness()
    reverse.sync(new Set())
    expect(trackers).toHaveLength(0)
  })

  it('forwards a capturing port to an attached device and counts it', async () => {
    const { reverse, trackers, ran } = harness()
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices('A\tdevice')
    await settle()
    expect(ran).toEqual([['-s', 'A', 'reverse', 'tcp:30100', 'tcp:30100']])
    expect(reverse.forwarded(30_100)).toBe(1)
  })

  it('waits for an unauthorized device to be approved', async () => {
    const { reverse, trackers, ran } = harness()
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices('A\tunauthorized')
    await settle()
    expect(ran).toEqual([])
    trackers[0]?.devices('A\tdevice')
    await settle()
    expect(ran).toHaveLength(1)
  })

  it('forwards again after a replug', async () => {
    const { reverse, trackers, ran } = harness()
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices('A\tdevice')
    await settle()
    trackers[0]?.devices()
    expect(reverse.forwarded(30_100)).toBe(0)
    trackers[0]?.devices('A\tdevice')
    await settle()
    expect(ran).toHaveLength(2)
    expect(reverse.forwarded(30_100)).toBe(1)
  })

  it('removes the rule and stops tracking when capture stops', async () => {
    const { reverse, trackers, ran } = harness()
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices('A\tdevice')
    await settle()
    reverse.sync(new Set())
    await settle()
    expect(ran[1]).toEqual(['-s', 'A', 'reverse', '--remove', 'tcp:30100'])
    expect(trackers[0]?.killed).toBe(true)
    expect(reverse.forwarded(30_100)).toBe(0)
  })

  it('waits for a late add, its removal, and tracker exit before confirming the last port closed', async () => {
    const tracker = new FakeTracker()
    let added: () => void = () => undefined
    let removed: () => void = () => undefined
    let exited: () => void = () => undefined
    const exit = new Promise<void>((resolve) => {
      exited = resolve
    })
    vi.spyOn(tracker, 'stop').mockImplementation(() => {
      tracker.kill()
      return exit
    })
    const ran: string[][] = []
    const { reverse } = harness({
      track: () => tracker,
      run: (args) => {
        ran.push([...args])
        return new Promise<void>((resolve) => {
          if (args.includes('--remove')) removed = resolve
          else added = resolve
        })
      },
    })
    reverse.sync(new Set([30_100]))
    tracker.devices('A\tdevice')
    await settle()
    let confirmed = false
    const closing = reverse.syncConfirmed(new Set()).then(() => {
      confirmed = true
    })
    added()
    await settle()
    expect(ran.at(-1)).toEqual(['-s', 'A', 'reverse', '--remove', 'tcp:30100'])
    expect(confirmed).toBe(false)
    removed()
    await settle()
    expect(confirmed).toBe(false)
    exited()
    await closing
    expect(confirmed).toBe(true)
    expect(tracker.killed).toBe(true)
  })

  it('retries a failed removed-port command while keeping another project forwarded', async () => {
    let refuseRemoval = true
    const removals: string[][] = []
    const { reverse, trackers } = harness({
      run: (args) => {
        if (!args.includes('--remove')) return Promise.resolve()
        removals.push([...args])
        return refuseRemoval ? Promise.reject(new Error('device busy')) : Promise.resolve()
      },
    })
    reverse.sync(new Set([30_100, 30_101]))
    trackers[0]?.devices('A\tdevice')
    await settle()
    await expect(reverse.syncConfirmed(new Set([30_101]))).rejects.toThrow(
      'Android forwarding shutdown could not be confirmed'
    )
    expect(trackers[0]?.killed).toBe(false)
    expect(reverse.forwarded(30_101)).toBe(1)
    refuseRemoval = false
    await reverse.syncConfirmed(new Set([30_101]))
    expect(removals).toHaveLength(2)
    expect(reverse.forwarded(30_101)).toBe(1)
    reverse.close()
  })

  it('tells its listener when the forwarded count changes', async () => {
    const { reverse, trackers } = harness()
    let changes = 0
    reverse.onChange(() => {
      changes += 1
    })
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices('A\tdevice')
    await settle()
    expect(changes).toBe(1)
  })

  it('warns when adb is missing and tries again only when the ports change', () => {
    const { reverse, trackers, warned } = harness()
    reverse.sync(new Set([30_100]))
    trackers[0]?.end(true)
    reverse.sync(new Set([30_100]))
    expect(trackers).toHaveLength(1)
    reverse.sync(new Set([30_100, 30_101]))
    expect(trackers).toHaveLength(2)
    expect(warned).toEqual(['adb was not found, so Android devices are not forwarded'])
  })

  it('remembers a Wi-Fi device and saves the list once', () => {
    const { reverse, trackers, saved } = harness()
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices(`${PHONE}\tdevice`, 'R58TC1151DM\tdevice')
    trackers[0]?.devices(`${PHONE}\tdevice`, 'R58TC1151DM\tdevice')
    expect(saved).toEqual([[PHONE]])
  })

  it('reconnects a remembered device missing from the first list', () => {
    const { reverse, trackers, connected } = harness({ load: () => [PHONE] })
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices()
    expect(connected).toEqual([PHONE])
  })

  it('leaves a remembered device alone while it is attached', () => {
    const { reverse, trackers, connected } = harness({ load: () => [PHONE] })
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices(`${PHONE}\tdevice`)
    expect(connected).toEqual([])
  })

  it('tries again on every interval while capturing, and stops with capture', async () => {
    vi.useFakeTimers()
    const { reverse, trackers, connected } = harness({ load: () => [PHONE] })
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connected).toEqual([PHONE, PHONE])
    reverse.sync(new Set())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connected).toEqual([PHONE, PHONE])
  })

  it('does not start a second connect while one is still running', async () => {
    vi.useFakeTimers()
    const connected: string[] = []
    const { reverse, trackers } = harness({
      load: () => [PHONE],
      connect: (address) => {
        connected.push(address)
        return new Promise<void>(() => undefined)
      },
    })
    reverse.sync(new Set([30_100]))
    trackers[0]?.devices()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connected).toEqual([PHONE])
  })

  it('does not record an add that fails', async () => {
    const warned: string[] = []
    const tracker = new FakeTracker()
    const reverse = new AdbReverse({
      track: () => tracker,
      run: () => Promise.reject(new Error('device offline')),
      warn: (message) => {
        warned.push(message)
      },
    })
    reverse.sync(new Set([30_100]))
    tracker.devices('A\tdevice')
    await settle()
    expect(reverse.forwarded(30_100)).toBe(0)
    expect(warned).toEqual(['adb reverse failed'])
  })
})
