import { describe, expect, it } from 'vitest'
import {
  countStates,
  diagnosticLines,
  frameFields,
  frameSource,
  type ConnectionState,
  type WindowDiagnostics,
} from './diagnostics.js'
import type { RootReport } from './editor-context.js'

const ROOT = '/Users/someone/code/secret-project'

const editor = (source: 'current' | 'cached') => ({
  source,
  filePath: `${ROOT}/src/a.ts`,
  fileUrl: `file://${ROOT}/src/a.ts`,
  languageId: 'typescript',
  documentVersion: 1,
  isDirty: false,
  provenance: { kind: 'worktree' as const },
  selection: {
    start: { line: 11, character: 0 },
    end: { line: 13, character: 0 },
    isEmpty: false,
    selectedBytes: 42,
  },
})

const ready = (source: 'current' | 'cached' = 'current'): RootReport => ({
  root: ROOT,
  status: 'ready',
  editor: editor(source),
})

const bare = (status: RootReport['status']): RootReport => ({ root: ROOT, status, editor: null })

const window = (over: Partial<WindowDiagnostics> = {}): WindowDiagnostics => ({
  scheme: 'file',
  trusted: true,
  folderCount: 1,
  connections: countStates(['connected']),
  extensionVersion: '0.6.0',
  protocolVersion: 1,
  ...over,
})

describe('countStates', () => {
  it('counts each state separately', () => {
    const states: ConnectionState[] = ['connected', 'dialing', 'dialing', 'extensionOutdated']
    expect(countStates(states)).toEqual({
      found: 4,
      connected: 1,
      dialing: 2,
      extensionOutdated: 1,
      chorusOutdated: 0,
    })
  })
})

describe('frameSource', () => {
  it('reports where the selection came from', () => {
    expect(frameSource([ready('cached')])).toBe('cached')
    expect(frameSource([ready('current')])).toBe('current')
  })

  it('reports none when no root carries an editor', () => {
    expect(frameSource([bare('unmatched'), bare('unsupported')])).toBe('none')
  })
})

describe('frameFields', () => {
  it('names every root by index and status', () => {
    const fields = frameFields([bare('unsupported'), ready()], window())
    expect(fields['roots']).toEqual(['0:unsupported', '1:ready'])
    expect(fields['scheme']).toBe('file')
    expect(fields['source']).toBe('current')
  })

  it('says so when there is no active editor at all', () => {
    expect(frameFields([bare('unsupported')], window({ scheme: null }))['scheme']).toBe('none')
  })

  /*
   * The rule the whole module exists for. A trace line is pasted into a bug
   * report, so a path in one is a leak that survives in someone else's issue
   * tracker — and `filePath` is right there on every report it is handed.
   */
  it('never writes a path, however deep in the report it sits', () => {
    const serialized = JSON.stringify(frameFields([ready('cached')], window()))
    expect(serialized).not.toContain(ROOT)
    expect(serialized).not.toContain('a.ts')
  })
})

const chorus = (pid: number, reports: RootReport[], state: ConnectionState = 'connected') => ({
  pid,
  state,
  reports,
})

describe('diagnosticLines', () => {
  it('explains each root by index rather than by path', () => {
    const text = diagnosticLines([chorus(101, [bare('unmatched')])], window()).join('\n')
    expect(text).toContain('#0 unmatched')
    expect(text).not.toContain(ROOT)
  })

  it('distinguishes the two schemes of a diff by naming the active one', () => {
    const text = diagnosticLines(
      [chorus(101, [bare('unsupported')])],
      window({ scheme: 'git' })
    ).join('\n')
    expect(text).toContain('active document: git')
  })

  /*
   * The reason the roots moved onto the connection: two Chorus processes ask
   * about different projects, and a dump that flattened them would describe a
   * set neither of them named.
   */
  it('keeps each Chorus process and its roots apart', () => {
    const text = diagnosticLines(
      [chorus(101, [ready()]), chorus(202, [bare('unmatched')], 'dialing')],
      window({ connections: countStates(['connected', 'dialing']) })
    ).join('\n')
    expect(text).toContain('pid 101 (connected): 1 root(s)')
    expect(text).toContain('pid 202 (dialing): 1 root(s)')
    expect(text).toContain('#0 ready')
    expect(text).toContain('#0 unmatched')
  })

  /*
   * The failure the rest of the dump cannot describe: a refused handshake
   * publishes no roots, so every other line reads as if nothing were wrong.
   */
  it('calls out a protocol mismatch, which otherwise looks like an idle window', () => {
    const lines = diagnosticLines(
      [chorus(101, [], 'extensionOutdated')],
      window({ connections: countStates(['extensionOutdated']) })
    )
    expect(lines.join('\n')).toContain('update this extension')
    expect(lines.join('\n')).toContain('pid 101 (extensionOutdated): 0 root(s)')
  })

  it('tells the other direction apart', () => {
    const lines = diagnosticLines([], window({ connections: countStates(['chorusOutdated']) }))
    expect(lines.join('\n')).toContain('update Chorus')
  })

  it('reports a remembered selection as cached', () => {
    expect(diagnosticLines([chorus(101, [ready('cached')])], window()).join('\n')).toContain(
      'selection reported: cached'
    )
  })
})
