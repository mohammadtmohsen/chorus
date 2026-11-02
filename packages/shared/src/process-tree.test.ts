import { describe, expect, it, vi } from 'vitest'
import { ownProcessTree, ProcessCleanupError, type ProcessIdentity } from './process-tree.js'
import { parsePosixProcesses } from './process-table.js'

const processOf = (
  pid: number,
  parentPid: number,
  groupId = 100,
  startedAt = '100'
): ProcessIdentity => ({ pid, parentPid, groupId, startedAt, state: 'S' })

function harness(initial: ProcessIdentity[], processGroup = true) {
  let rows = initial
  let clock = 0
  let inspectionError: Error | null = null
  let onSignal = (_pid: number, _signal: NodeJS.Signals): void => undefined
  const signals: [number, NodeJS.Signals][] = []
  const inspect = (): Promise<ProcessIdentity[]> => {
    if (inspectionError !== null) return Promise.reject(inspectionError)
    return Promise.resolve(rows.map((row) => ({ ...row })))
  }
  const tree = ownProcessTree(100, {
    processGroup,
    platform: 'linux',
    inspect,
    signal: (pid, signal) => {
      signals.push([pid, signal])
      onSignal(pid, signal)
      return Promise.resolve()
    },
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    now: () => clock,
    gracefulMs: 0,
    termMs: 10,
    killMs: 10,
    pollMs: 5,
  })
  return {
    tree,
    signals,
    rows: () => rows,
    replace: (next: ProcessIdentity[]) => {
      rows = next
    },
    failInspection: (error: Error | null) => {
      inspectionError = error
    },
    onSignal: (handler: typeof onSignal) => {
      onSignal = handler
    },
  }
}

describe('owned process shutdown', () => {
  it('captures descendants before disconnect and confirms group and detached survivors exited', async () => {
    const unrelated = processOf(900, 1, 900)
    const target = harness([
      processOf(100, 50),
      processOf(101, 100),
      processOf(102, 101, 102),
      unrelated,
    ])
    await target.tree.capture()
    target.onSignal((pid, signal) => {
      if (signal !== 'SIGKILL') return
      target.replace(
        target.rows().filter((row) => (pid < 0 ? row.groupId !== -pid : row.pid !== pid))
      )
    })
    await target.tree.stop(() => {
      target.replace([processOf(101, 1), processOf(102, 1, 102), unrelated])
    })
    expect(target.signals).toEqual([
      [-100, 'SIGTERM'],
      [102, 'SIGTERM'],
      [-100, 'SIGKILL'],
      [102, 'SIGKILL'],
    ])
    expect(target.rows()).toEqual([unrelated])
  })

  it('does not signal a captured PID after it has been reused', async () => {
    const target = harness([processOf(100, 50), processOf(102, 100, 102)])
    await target.tree.capture()
    const reused = processOf(102, 1, 900, '200')
    await target.tree.stop(() => {
      target.replace([reused])
    })
    expect(target.signals).toEqual([])
    expect(target.rows()).toEqual([reused])
  })

  it('rejects incomplete cleanup, shares an in-flight stop and allows a later retry', async () => {
    const target = harness([processOf(100, 50), processOf(101, 100)])
    await target.tree.capture()
    const stopping = target.tree.stop()
    expect(target.tree.stop()).toBe(stopping)
    const failure: unknown = await stopping.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProcessCleanupError)
    if (!(failure instanceof ProcessCleanupError))
      throw new Error('Missing retryable cleanup error')
    expect(failure.message).toContain('Owned processes did not exit')
    target.onSignal(() => {
      target.replace([])
    })
    await expect(failure.retry()).resolves.toBeUndefined()
  })

  it('does not disconnect or signal when ownership cannot be inspected', async () => {
    const target = harness([processOf(100, 50)])
    await target.tree.capture()
    target.failInspection(new Error('Inspection denied'))
    const graceful = vi.fn()
    await expect(target.tree.stop(graceful)).rejects.toThrow('Inspection denied')
    expect(graceful).not.toHaveBeenCalled()
    expect(target.signals).toEqual([])
    target.failInspection(null)
    target.onSignal(() => {
      target.replace([])
    })
    await target.tree.stop(graceful)
    expect(graceful).toHaveBeenCalledTimes(1)
  })

  it('refuses to signal a process group the root does not own', async () => {
    const target = harness([processOf(100, 50, 50)])
    const graceful = vi.fn()
    await expect(target.tree.stop(graceful)).rejects.toThrow('does not own its process group')
    expect(graceful).not.toHaveBeenCalled()
    expect(target.signals).toEqual([])
  })

  it('limits an adopted editor root to its descendants and preserves its shared ancestor', async () => {
    let rows = [
      processOf(100, 500, 500),
      processOf(101, 100, 500),
      processOf(500, 1, 500),
      processOf(600, 500, 500),
    ]
    const signalled: number[] = []
    const tree = ownProcessTree(100, {
      expectedAncestorPid: 500,
      inspect: () => Promise.resolve(rows),
      signal: (pid) => {
        signalled.push(pid)
        rows = rows.filter((row) => row.pid !== pid)
        return Promise.resolve()
      },
      gracefulMs: 0,
      termMs: 0,
      killMs: 0,
    })
    await tree.capture()
    await tree.stop()
    expect(signalled).toEqual([101, 100])
    expect(rows.map((row) => row.pid)).toEqual([500, 600])
  })

  it('rejects an editor PID outside its expected ancestor tree', async () => {
    const signal = vi.fn(() => Promise.resolve())
    const tree = ownProcessTree(100, {
      expectedAncestorPid: 500,
      inspect: () => Promise.resolve([processOf(100, 900), processOf(500, 1, 500)]),
      signal,
    })
    await expect(tree.capture()).rejects.toThrow('is not a child of its expected owner')
    expect(signal).not.toHaveBeenCalled()
  })

  it('refuses success when a Windows child first appears after its owned parent exited', async () => {
    let rows = [processOf(100, 50)]
    const signal = vi.fn(() => Promise.resolve())
    const tree = ownProcessTree(100, {
      platform: 'win32',
      inspect: () => Promise.resolve(rows),
      signal,
    })
    await tree.capture()
    rows = [processOf(101, 100, 101, '200')]
    await expect(tree.stop()).rejects.toThrow('outlived an owned parent')
    expect(signal).not.toHaveBeenCalled()
    rows = []
    await expect(tree.stop()).resolves.toBeUndefined()
  })

  it('does not adopt an older Windows process whose stale parent PID was reused', async () => {
    let rows = [processOf(100, 50, 100, '200'), processOf(101, 100, 101, '100')]
    const signalled: number[] = []
    const tree = ownProcessTree(100, {
      platform: 'win32',
      inspect: () => Promise.resolve(rows),
      signal: (pid) => {
        signalled.push(pid)
        rows = rows.filter((row) => row.pid !== pid)
        return Promise.resolve()
      },
      termMs: 0,
      killMs: 0,
    })
    await tree.capture()
    await tree.stop()
    expect(signalled).toEqual([100])
    expect(rows.map((row) => row.pid)).toEqual([101])
  })

  it('fails closed on an unsupported process-inspection platform', async () => {
    const tree = ownProcessTree(100, { platform: 'aix' })
    await expect(tree.stop()).rejects.toThrow('inspection is unsupported')
  })

  it('parses process births without capturing command lines', () => {
    expect(parsePosixProcesses('100 50 100 Sun Oct 18 12:00:00 2026 S\n')).toEqual([
      { pid: 100, parentPid: 50, groupId: 100, startedAt: 'Sun Oct 18 12:00:00 2026', state: 'S' },
    ])
    expect(() => parsePosixProcesses('100 missing birth')).toThrow('Could not inspect')
  })
})
