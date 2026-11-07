import { describe, expect, it } from 'vitest'
import { diagnosticAt, diagnosticFrame, type DiagnosticDocument } from './diagnostic-pick.js'

/**
 * Which problem the user meant, and what leaves the editor with it.
 *
 * The rules are narrow because this is the one gesture that ships source Chorus
 * did not ask for: one problem, the one under the cursor, from a document inside
 * a root Chorus named.
 */

const at = (line: number, character = 0) => ({ line, character })

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: at(sl, sc),
  end: at(el, ec),
})

const doc = (over: Partial<DiagnosticDocument> = {}): DiagnosticDocument => ({
  filePath: '/p/a/src/rate.ts',
  languageId: 'typescript',
  provenance: { kind: 'worktree' },
  cursor: at(10, 5),
  diagnostics: [],
  linesOf: (start, end) =>
    Array.from({ length: end - start }, (_, i) => `line ${String(start + i)}`).join('\n'),
  ...over,
})

describe('diagnosticAt', () => {
  it('finds nothing when the cursor is not on a problem', () => {
    expect(
      diagnosticAt(
        doc({
          cursor: at(2),
          diagnostics: [{ severity: 'error', message: 'boom', range: range(10, 0, 10, 5) }],
        })
      )
    ).toBeNull()
  })

  /*
   * Ranges nest: a type error on an expression sits inside one on the statement.
   * The narrower is what the cursor is pointing at.
   */
  it('prefers the narrower of two problems that both cover the cursor', () => {
    const found = diagnosticAt(
      doc({
        cursor: at(10, 5),
        diagnostics: [
          { severity: 'error', message: 'the whole statement', range: range(8, 0, 14, 0) },
          { severity: 'error', message: 'this expression', range: range(10, 0, 10, 40) },
        ],
      })
    )
    expect(found?.message).toBe('this expression')
  })

  it('breaks a tie on severity, because an error beats a hint on the same span', () => {
    const found = diagnosticAt(
      doc({
        diagnostics: [
          { severity: 'hint', message: 'consider', range: range(10, 0, 10, 40) },
          { severity: 'error', message: 'broken', range: range(10, 0, 10, 40) },
        ],
      })
    )
    expect(found?.message).toBe('broken')
  })

  it('counts the end of a range as covered, as VS Code does', () => {
    expect(
      diagnosticAt(
        doc({
          cursor: at(10, 40),
          diagnostics: [{ severity: 'error', message: 'x', range: range(10, 0, 10, 40) }],
        })
      )
    ).not.toBeNull()
  })
})

describe('diagnosticFrame', () => {
  const ROOTS = ['/p/a']

  it('carries the message, its producer and where it is', () => {
    const frame = diagnosticFrame(
      doc({
        diagnostics: [
          {
            severity: 'error',
            source: 'react-compiler',
            code: 'memoization',
            message: 'Existing memoization could not be preserved',
            range: range(54, 4, 54, 60),
          },
        ],
        cursor: at(54, 10),
      }),
      ROOTS
    )
    expect(frame).toMatchObject({
      ok: true,
      params: {
        root: '/p/a',
        severity: 'error',
        source: 'react-compiler',
        code: 'memoization',
        message: 'Existing memoization could not be preserved',
      },
    })
  })

  /* A line either side: an underlined expression on its own reads as a
     fragment, and the line above is usually what names it. */
  it('takes a line either side of the range, and no more', () => {
    const frame = diagnosticFrame(
      doc({
        diagnostics: [{ severity: 'error', message: 'x', range: range(54, 4, 54, 60) }],
        cursor: at(54, 10),
      }),
      ROOTS
    )
    expect(frame.ok && frame.params.text).toBe('line 53\nline 54\nline 55')
  })

  it('refuses a document outside every root Chorus asked about', () => {
    const frame = diagnosticFrame(
      doc({
        filePath: '/p/b/src/other.ts',
        diagnostics: [{ severity: 'error', message: 'x', range: range(10, 0, 10, 4) }],
      }),
      ROOTS
    )
    expect(frame).toEqual({ ok: false, reason: 'outside-roots' })
  })

  it('is not fooled by a root whose name merely starts the same', () => {
    const frame = diagnosticFrame(
      doc({
        filePath: '/p/a-old/src/rate.ts',
        diagnostics: [{ severity: 'error', message: 'x', range: range(10, 0, 10, 4) }],
      }),
      ROOTS
    )
    expect(frame).toEqual({ ok: false, reason: 'outside-roots' })
  })

  it('refuses a document that cannot be referenced at all', () => {
    // An output pane or a settings editor: `provenance` is null, and there is
    // no project code for a problem in one to be about.
    const frame = diagnosticFrame(
      doc({
        provenance: null,
        diagnostics: [{ severity: 'error', message: 'x', range: range(10, 0, 10, 4) }],
      }),
      ROOTS
    )
    expect(frame).toEqual({ ok: false, reason: 'unsupported-document' })
  })

  it('sends nothing at all from a restricted workspace', () => {
    // The manifest already promises this for editor context: "no file path,
    // range, or text". A diagnostic is all three, so it is refused whole.
    const frame = diagnosticFrame(
      doc({
        diagnostics: [{ severity: 'error', message: 'x', range: range(10, 0, 10, 4) }],
        cursor: at(10, 1),
      }),
      ROOTS,
      false
    )
    expect(frame).toEqual({ ok: false, reason: 'untrusted' })
  })

  it('says so when the cursor is on nothing, rather than sending the nearest', () => {
    const frame = diagnosticFrame(
      doc({
        cursor: at(2),
        diagnostics: [{ severity: 'error', message: 'x', range: range(10, 0, 10, 4) }],
      }),
      ROOTS
    )
    expect(frame).toEqual({ ok: false, reason: 'no-diagnostic' })
  })

  /*
   * Truncated where a selection would be refused. A cut selection means
   * something different from what was selected; a cut message is still the first
   * four kilobytes of what the compiler objects to, and refusing would make the
   * longest messages the ones you cannot ask about.
   */
  it('truncates a message rather than refusing it', () => {
    const frame = diagnosticFrame(
      doc({
        diagnostics: [
          { severity: 'error', message: 'x'.repeat(9_000), range: range(10, 0, 10, 4) },
        ],
        cursor: at(10, 1),
      }),
      ROOTS
    )
    expect(frame.ok).toBe(true)
    expect(frame.ok && frame.params.message.length).toBe(4 * 1024)
  })
})
