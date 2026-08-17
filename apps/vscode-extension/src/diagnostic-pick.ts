import {
  MAX_DIAGNOSTIC_MESSAGE,
  MAX_DIAGNOSTIC_TEXT,
  isInside,
  type DiagnosticParams,
  type DiagnosticSeverity,
  type Provenance,
} from '@chorus/ide-protocol'

/**
 * Choosing which problem the user meant, and what may be said about it.
 *
 * Free of any `vscode` import, like `editor-context.ts` and for the same reason:
 * the judgement is testable and the editor is not. `extension.ts` fills in the
 * shapes; everything that decides lives here.
 *
 * **A diagnostic is source text that Chorus did not ask for.** Every other frame
 * this extension sends is a handshake, or metadata carrying no text, or an
 * answer to a request. So the rules below are narrow on purpose: one problem,
 * the one under the cursor, from a document that belongs to a root Chorus asked
 * about, with the code it is about bounded.
 */

/** The parts of a `vscode.Diagnostic` this needs, flattened. */
export interface DiagnosticLike {
  readonly severity: DiagnosticSeverity
  readonly message: string
  /** `eslint`, `ts`, `react-compiler` — absent when the producer said nothing. */
  readonly source?: string | undefined
  /** A rule id or an error number; both spellings exist, so both are strings. */
  readonly code?: string | undefined
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
}

export interface DiagnosticDocument {
  readonly filePath: string
  readonly languageId: string
  readonly provenance: Provenance | null
  /** Where the caret is, so "the one you are looking at" has a meaning. */
  readonly cursor: { readonly line: number; readonly character: number }
  /** Every problem the editor holds for this document, in its own order. */
  readonly diagnostics: readonly DiagnosticLike[]
  /** Reads the document's own lines, one-based-exclusive like a range. */
  readonly linesOf: (startLine: number, endLine: number) => string
}

/**
 * The problem under the cursor, or `null` when the cursor is not on one.
 *
 * **Most specific wins.** Ranges nest — a type error on an expression sits
 * inside one on the statement — and the narrower is the one the user is pointing
 * at. Ties break on severity, because an error and a hint on the same span is a
 * question with an obvious answer.
 *
 * A cursor merely *near* a problem is not on it. Widening to "the nearest
 * diagnostic in the file" would make the command send something the user did not
 * choose, which is the one thing a gesture that ships source must not do.
 */
export function diagnosticAt(document: DiagnosticDocument): DiagnosticLike | null {
  const covering = document.diagnostics.filter((d) => covers(d.range, document.cursor))
  if (covering.length === 0) return null

  const rank: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3,
  }
  /*
   * `reduce` rather than sort-and-take-first: the list is non-empty by the
   * guard above, and this is the shape that says so to the compiler without an
   * assertion claiming knowledge the type does not carry.
   */
  return covering.reduce((best, candidate) => {
    const bySpan = span(candidate.range) - span(best.range)
    if (bySpan !== 0) return bySpan < 0 ? candidate : best
    return rank[candidate.severity] < rank[best.severity] ? candidate : best
  })
}

/** Half-open at the end, which is how VS Code's own ranges compare. */
function covers(
  range: DiagnosticLike['range'],
  at: { readonly line: number; readonly character: number }
): boolean {
  const afterStart =
    at.line > range.start.line ||
    (at.line === range.start.line && at.character >= range.start.character)
  const beforeEnd =
    at.line < range.end.line || (at.line === range.end.line && at.character <= range.end.character)
  return afterStart && beforeEnd
}

/** Lines first, characters only to break a tie within one line. */
function span(range: DiagnosticLike['range']): number {
  const lines = range.end.line - range.start.line
  return lines > 0 ? lines * 1_000 : range.end.character - range.start.character
}

/**
 * How many lines of code travel with the message.
 *
 * The range itself, plus one either side. A compiler underlines an expression,
 * and an expression on its own reads as a fragment — the line above is usually
 * the declaration that names it. Not more, because this is a report of one
 * problem rather than a way to send a file.
 */
const CONTEXT_LINES = 1

export type Refusal = 'no-diagnostic' | 'unsupported-document' | 'outside-roots' | 'untrusted'

/**
 * The frame to send, or why there is nothing to send.
 *
 * `roots` is what Chorus asked about, and a document outside all of them is
 * refused here — the extension filters to minimize disclosure, though main
 * re-checks anyway because main is the security boundary. `provenance: null` is
 * a document that cannot be referenced at all (an output pane, a settings
 * editor), which has nothing to say about a project's code.
 */
export function diagnosticFrame(
  document: DiagnosticDocument,
  roots: readonly string[],
  isTrusted = true
): { ok: true; params: DiagnosticParams } | { ok: false; reason: Refusal } {
  /*
   * A restricted workspace sends nothing, which is the rule this extension
   * already states in its own manifest: _"In a restricted workspace Chorus
   * reports that the window exists, but sends no file path, range, or text."_
   * A diagnostic is all three at once, so it is refused rather than trimmed —
   * `reportFor` does the same with `bare('untrusted')`.
   */
  if (!isTrusted) return { ok: false, reason: 'untrusted' }
  if (document.provenance === null) return { ok: false, reason: 'unsupported-document' }

  const root = roots.find((r) => isInside(r, document.filePath))
  if (root === undefined) return { ok: false, reason: 'outside-roots' }

  const found = diagnosticAt(document)
  if (found === null) return { ok: false, reason: 'no-diagnostic' }

  const text = document.linesOf(
    Math.max(0, found.range.start.line - CONTEXT_LINES),
    found.range.end.line + CONTEXT_LINES + 1
  )

  return {
    ok: true,
    params: {
      root,
      filePath: document.filePath,
      languageId: document.languageId,
      provenance: document.provenance,
      severity: found.severity,
      ...(found.source === undefined || found.source === '' ? {} : { source: found.source }),
      ...(found.code === undefined || found.code === '' ? {} : { code: found.code }),
      /*
       * Truncated rather than refused, unlike a selection.
       *
       * A selection that will not fit is a *different* selection if it is cut,
       * so `MAX_SELECTED_BYTES` refuses instead. A diagnostic is a report: the
       * first four kilobytes of a compiler's essay says what it objects to, and
       * a refusal here would mean the longest messages — the ones most worth
       * asking about — are the ones you cannot send.
       */
      message: found.message.slice(0, MAX_DIAGNOSTIC_MESSAGE),
      range: {
        start: { line: found.range.start.line, character: found.range.start.character },
        end: { line: found.range.end.line, character: found.range.end.character },
      },
      text: text.slice(0, MAX_DIAGNOSTIC_TEXT),
    },
  }
}
