import { describe, expect, it } from 'vitest'
import {
  chorusMessage,
  currentContextResult,
  decodeFrame,
  editorMetadata,
  editorSnapshot,
  encodeFrame,
  ERROR_CODES,
  extensionMessage,
  MAX_FRAME_BYTES,
  MAX_SELECTED_BYTES,
  PROTOCOL_VERSION,
  toDisplayRange,
  utf8ByteLength,
} from './protocol.js'

const range = {
  start: { line: 10, character: 0 },
  end: { line: 12, character: 4 },
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'current',
    filePath: '/p/src/a.ts',
    fileUrl: 'file:///p/src/a.ts',
    languageId: 'typescript',
    documentVersion: 3,
    isDirty: false,
    provenance: { kind: 'worktree' },
    selection: { ...range, isEmpty: false, selectedBytes: 12 },
    ...overrides,
  }
}

describe('utf8ByteLength', () => {
  it('counts ascii, multibyte, and astral characters', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('中')).toBe(3)
    // One code point of four bytes, not two surrogates of three.
    expect(utf8ByteLength('😀')).toBe(4)
  })
})

describe('editorMetadata', () => {
  it('accepts a live frame', () => {
    expect(editorMetadata.safeParse(metadata()).success).toBe(true)
  })

  /* The §4 invariant. A live frame must not be able to carry source text. */
  it('rejects a live frame that smuggles text into the selection', () => {
    const smuggled = metadata({
      selection: { ...range, isEmpty: false, selectedBytes: 12, text: 'const a = 1' },
    })
    expect(editorMetadata.safeParse(smuggled).success).toBe(false)
  })

  it('rejects unknown top-level fields', () => {
    expect(editorMetadata.safeParse(metadata({ extra: 1 })).success).toBe(false)
  })

  /* Reporting an oversized selection is how the pill reaches `tooLarge`, so
     the live frame must not cap the byte count. */
  it('allows selectedBytes above the snapshot cap', () => {
    const big = metadata({
      selection: { ...range, isEmpty: false, selectedBytes: MAX_SELECTED_BYTES * 4 },
    })
    expect(editorMetadata.safeParse(big).success).toBe(true)
  })
})

describe('editorSnapshot', () => {
  it('accepts a snapshot whose byte count matches its text', () => {
    const snapshot = metadata({
      selection: { ...range, isEmpty: false, selectedBytes: 3, text: 'abc' },
    })
    expect(editorSnapshot.safeParse(snapshot).success).toBe(true)
  })

  /* A client must not be able to declare a small selection and deliver a
     large one. */
  it('rejects a snapshot whose byte count disagrees with its text', () => {
    const lying = metadata({
      selection: { ...range, isEmpty: false, selectedBytes: 3, text: 'a'.repeat(9000) },
    })
    expect(editorSnapshot.safeParse(lying).success).toBe(false)
  })

  it('counts multibyte text by bytes, not characters', () => {
    const multibyte = metadata({
      selection: { ...range, isEmpty: false, selectedBytes: 3, text: '中' },
    })
    expect(editorSnapshot.safeParse(multibyte).success).toBe(true)
  })

  it('rejects a selection over the cap', () => {
    const over = MAX_SELECTED_BYTES + 1
    const huge = metadata({
      selection: { ...range, isEmpty: false, selectedBytes: over, text: 'a'.repeat(over) },
    })
    expect(editorSnapshot.safeParse(huge).success).toBe(false)
  })
})

describe('stateChanged root states', () => {
  function frame(status: string, editor: unknown): unknown {
    return {
      jsonrpc: '2.0',
      method: 'stateChanged',
      params: {
        windowId: 'w1',
        focused: true,
        roots: [{ root: '/p', status, editor }],
      },
    }
  }

  it('accepts ready with an editor', () => {
    expect(extensionMessage.safeParse(frame('ready', metadata())).success).toBe(true)
  })

  it('accepts tooLarge with an editor', () => {
    expect(extensionMessage.safeParse(frame('tooLarge', metadata())).success).toBe(true)
  })

  it('rejects ready without an editor', () => {
    expect(extensionMessage.safeParse(frame('ready', null)).success).toBe(false)
  })

  it('rejects unmatched that carries an editor', () => {
    expect(extensionMessage.safeParse(frame('unmatched', metadata())).success).toBe(false)
  })

  it('accepts unmatched with no editor', () => {
    expect(extensionMessage.safeParse(frame('unmatched', null)).success).toBe(true)
  })
})

describe('direction separation', () => {
  const setRoots = {
    jsonrpc: '2.0',
    method: 'setRoots',
    params: { roots: ['/p'] },
  }

  it('accepts a Chorus message on the Chorus schema', () => {
    expect(chorusMessage.safeParse(setRoots).success).toBe(true)
  })

  /* A broker parses extension messages only; it cannot accidentally accept
     one of its own. */
  it('rejects a Chorus message on the extension schema', () => {
    expect(extensionMessage.safeParse(setRoots).success).toBe(false)
  })

  it('rejects an initialize that carries workspace paths', () => {
    const leaky = {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'initialize',
      params: {
        token: 't',
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: '0.4.0',
        windowId: 'w1',
        ideName: 'Visual Studio Code',
        isTrusted: true,
        focused: true,
        workspaceFolders: ['/somewhere/else'],
      },
    }
    expect(extensionMessage.safeParse(leaky).success).toBe(false)
  })
})

describe('currentContextResult', () => {
  it('accepts each outcome', () => {
    expect(
      currentContextResult.safeParse({
        outcome: 'ok',
        snapshot: metadata({
          selection: { ...range, isEmpty: false, selectedBytes: 3, text: 'abc' },
        }),
      }).success
    ).toBe(true)
    expect(
      currentContextResult.safeParse({ outcome: 'unavailable', reason: 'unmatched' }).success
    ).toBe(true)
    expect(currentContextResult.safeParse({ outcome: 'tooLarge', selectedBytes: 99 }).success).toBe(
      true
    )
  })

  it('rejects an unknown status as a reason', () => {
    expect(
      currentContextResult.safeParse({ outcome: 'unavailable', reason: 'connected' }).success
    ).toBe(false)
  })
})

describe('decodeFrame', () => {
  it('round-trips through encodeFrame', () => {
    const line = encodeFrame({ jsonrpc: '2.0', method: 'setRoots', params: { roots: ['/p'] } })
    expect(line.endsWith('\n')).toBe(true)
    const decoded = decodeFrame(line.trimEnd(), chorusMessage)
    expect(decoded.ok).toBe(true)
    // Assert the decoded payload, not just the flag: an earlier draft read the
    // wrong field off zod's success result and returned `undefined` here, which
    // a bare `ok` check happily passed.
    if (decoded.ok) {
      expect(decoded.value).toEqual({
        jsonrpc: '2.0',
        method: 'setRoots',
        params: { roots: ['/p'] },
      })
    }
  })

  /* A multi-line selection must still occupy exactly one wire line. */
  it('keeps a multi-line payload on one line', () => {
    const line = encodeFrame({ text: 'a\nb\nc' })
    expect(line.split('\n')).toHaveLength(2)
  })

  it('reports invalid JSON without throwing', () => {
    const decoded = decodeFrame('{not json', chorusMessage)
    expect(decoded).toMatchObject({ ok: false, code: ERROR_CODES.parse })
  })

  it('rejects an oversized frame before parsing it', () => {
    const decoded = decodeFrame('x'.repeat(MAX_FRAME_BYTES + 1), chorusMessage)
    expect(decoded).toMatchObject({ ok: false, code: ERROR_CODES.frameTooLarge })
  })

  /* Diagnostics record reason codes, never values — a rejection message must
     not echo a path or source text back into the log. */
  it('does not echo the offending value in the reason', () => {
    const secret = '/Users/someone/private/thing.ts'
    const decoded = decodeFrame(
      JSON.stringify({ jsonrpc: '2.0', method: 'setRoots', params: { roots: [{ secret }] } }),
      chorusMessage
    )
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).not.toContain(secret)
  })
})

describe('toDisplayRange', () => {
  it('converts zero-based to one-based', () => {
    expect(
      toDisplayRange({ start: { line: 0, character: 0 }, end: { line: 0, character: 5 } })
    ).toEqual({ startLine: 1, endLine: 1 })
  })

  it('matches the reference in the plan', () => {
    expect(
      toDisplayRange({ start: { line: 411, character: 0 }, end: { line: 417, character: 9 } })
    ).toEqual({ startLine: 412, endLine: 418 })
  })

  /* Dragging to the start of the next line selects none of it, so that line
     must not appear in the range. */
  it('excludes a trailing line the selection only touches', () => {
    expect(
      toDisplayRange({ start: { line: 10, character: 0 }, end: { line: 13, character: 0 } })
    ).toEqual({ startLine: 11, endLine: 13 })
  })

  it('never returns an end before the start', () => {
    const r = toDisplayRange({ start: { line: 5, character: 2 }, end: { line: 5, character: 2 } })
    expect(r).toEqual({ startLine: 6, endLine: 6 })
  })
})
