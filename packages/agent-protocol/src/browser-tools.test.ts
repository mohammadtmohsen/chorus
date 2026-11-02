import { describe, expect, it } from 'vitest'
import {
  BROWSER_EXPRESSION_MAX,
  BROWSER_OUTPUT_BYTES,
  BROWSER_OUTPUT_WITHHELD,
  BROWSER_READ_ONLY,
  BROWSER_READ_TOOL_NAME,
  BROWSER_RUN_TIMEOUT_MS,
  browserToolNames,
  readOnlyBrowser,
  runBrowserTool,
  type BrowserConsoleAccess,
  type BrowserConsoleRead,
  type BrowserConsoleRun,
} from './browser-tools.js'

function recording(): {
  readonly access: BrowserConsoleAccess
  readonly reads: BrowserConsoleRead[]
  readonly runs: BrowserConsoleRun[]
} {
  const reads: BrowserConsoleRead[] = []
  const runs: BrowserConsoleRun[] = []
  return {
    reads,
    runs,
    access: {
      read: (request) => {
        reads.push(request)
        return Promise.resolve('{"rows":[]}')
      },
      run: (request) => {
        runs.push(request)
        return Promise.resolve('{"status":"ok"}')
      },
    },
  }
}

describe('read_console', () => {
  it('fills the documented defaults and passes levels through', async () => {
    const { access, reads } = recording()
    expect((await runBrowserTool(access, 'read_console', {})).ok).toBe(true)
    expect(await runBrowserTool(access, 'read_console', { levels: ['error'] })).toEqual({
      ok: true,
      text: '{"rows":[]}',
    })
    expect(reads).toEqual([
      { count: 50, skip: 0 },
      { count: 50, skip: 0, levels: ['error'] },
    ])
  })

  it('rejects out-of-range, unknown and extra arguments without reading', async () => {
    const { access, reads } = recording()
    const rejected = [{ count: 0 }, { count: 201 }, { skip: -1 }, { levels: ['fatal'] }, { x: 1 }]
    for (const args of rejected) {
      const result = await runBrowserTool(access, 'read_console', args)
      expect(result.ok).toBe(false)
      expect(result.text).toMatch(/^Invalid arguments/)
    }
    expect(reads).toEqual([])
  })
})

describe('run_javascript', () => {
  it('defaults the timeout and validates the expression bounds', async () => {
    const { access, runs } = recording()
    const result = await runBrowserTool(access, 'run_javascript', { expression: 'document.title' })
    expect(result.ok).toBe(true)
    expect(runs).toEqual([
      { expression: 'document.title', timeoutMs: BROWSER_RUN_TIMEOUT_MS.fallback },
    ])
    for (const args of [
      { expression: '' },
      { expression: 'x'.repeat(BROWSER_EXPRESSION_MAX + 1) },
      { expression: '1', timeoutMs: 99 },
      { expression: '1', timeoutMs: 30_001 },
      {},
    ]) {
      expect((await runBrowserTool(access, 'run_javascript', args)).ok).toBe(false)
    }
    expect(runs).toHaveLength(1)
  })

  it('refuses to run through read-only access, even when the tool is called by name', async () => {
    const { access, runs } = recording()
    const readable = readOnlyBrowser(access)
    expect(browserToolNames(readable)).toEqual([BROWSER_READ_TOOL_NAME])
    expect(await runBrowserTool(readable, 'run_javascript', { expression: 'alert(1)' })).toEqual({
      ok: false,
      text: BROWSER_READ_ONLY,
    })
    expect(runs).toEqual([])
  })

  it('reports a refusal from the access as a failed call', async () => {
    const access: BrowserConsoleAccess = {
      read: () => Promise.reject(new Error('closed')),
      run: () => Promise.reject(new Error('read-only')),
    }
    expect(await runBrowserTool(access, 'run_javascript', { expression: '1' })).toEqual({
      ok: false,
      text: 'read-only',
    })
    expect(await runBrowserTool(access, 'read_console', {})).toEqual({ ok: false, text: 'closed' })
  })

  it('withholds an answer larger than the output bound', async () => {
    const access: BrowserConsoleAccess = {
      read: () => Promise.resolve('x'.repeat(BROWSER_OUTPUT_BYTES + 1)),
    }
    expect(await runBrowserTool(access, 'read_console', {})).toEqual({
      ok: false,
      text: BROWSER_OUTPUT_WITHHELD,
    })
  })
})
