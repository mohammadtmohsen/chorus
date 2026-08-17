/**
 * Turning what VS Code is showing into something an agent can act on.
 *
 * `attach.ts` sets the rule this follows: Chorus hands agents **paths**, not
 * attachments. So the reference comes first and is the load-bearing part — an
 * agent can open `src/a.ts:12-18`, read around it, and edit it. The quoted code
 * is for the transcript, and for the reader who is not going to open anything.
 *
 * Deliberately not `asQuote()` from `quote.ts`. That trims each line and the
 * block, which is right for prose and destructive for code: indentation is
 * syntax in most languages the user will be asking about, and a blockquote
 * cannot carry it faithfully.
 */

import type { IdeProvenanceShape } from '../../shared/ipc.js'

export interface EditorReference {
  /** Relative to the conversation's cwd, because that is where agents run. */
  readonly relativePath: string
  /** One-based and inclusive, already converted at the protocol boundary. */
  readonly startLine: number
  readonly endLine: number
  readonly isEmpty: boolean
}

export interface EditorBlock extends EditorReference {
  readonly text: string
  readonly languageId: string
  readonly isDirty: boolean
  /** Which version of the file these lines are. */
  readonly provenance: IdeProvenanceShape
}

/**
 * `src/a.ts:12-18`, or `src/a.ts:12` for a bare cursor.
 *
 * A single-line selection collapses to one number too: `12-12` reads like a
 * mistake.
 */
export function formatReference(reference: EditorReference): string {
  const { relativePath, startLine, endLine } = reference
  if (reference.isEmpty || startLine === endLine) return `${relativePath}:${String(startLine)}`
  return `${relativePath}:${String(startLine)}-${String(endLine)}`
}

/**
 * A fence longer than the longest backtick run inside the text.
 *
 * Selected code very often contains a Markdown sample, and a three-backtick
 * fence around text containing three backticks closes early — the agent then
 * receives half the selection as code and the rest as prose.
 */
export function fenceFor(text: string): string {
  let longest = 0
  let run = 0
  for (const char of text) {
    if (char === '`') {
      run += 1
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * A language id safe to write after a fence.
 *
 * The id comes from VS Code and lands in the message untouched otherwise. It is
 * restricted rather than escaped: an unknown id costs syntax highlighting,
 * while a newline in one would break out of the fence entirely.
 */
export function safeLanguageId(languageId: string): string {
  const cleaned = languageId.toLowerCase().replace(/[^a-z0-9+#._-]/g, '')
  return cleaned.slice(0, 24)
}

/**
 * The block that goes into the message.
 *
 * Normally this is the reference and nothing else. `attach.ts` sets the rule:
 * Chorus hands agents **paths**, not attachments — the agent opens
 * `src/a.ts:85` and reads it, with the surrounding context that no quotation
 * could have carried anyway. Pasting the lines as well is decoration, and for a
 * short selection it is a fenced block wrapped around a single bracket.
 *
 * The exception is an unsaved buffer, and it is not a preference. The agent
 * reads from disk; for a dirty file that is not what the user is looking at, so
 * the text is the only way it can see the version being asked about. Without it
 * the agent answers confidently about the wrong content, with nothing to
 * indicate it happened.
 *
 * An empty selection never contributes code either way: there is nothing
 * selected to be unsaved, and the cursor line is enough to point at.
 */
export function formatContextBlock(block: EditorBlock, labels: ContextLabels): string {
  const reference = formatReference(block)
  /*
   * Two different reasons the path is not enough, and they do not overlap. An
   * unsaved buffer is the right file with newer content; a diff pane is a
   * *different version* of it, and opening the path there shows lines that have
   * moved. `version` carries the second, already translated, because the
   * reducers have no translator.
   */
  const qualifier = labels.version === '' ? '' : ` (${labels.version})`
  const suffix = block.isDirty ? ` (${labels.unsaved})` : qualifier
  const head = `${labels.heading}: \`${reference}\`${suffix}`
  if (block.isEmpty || block.text === '') return head
  // The quoted lines are mandatory once the document is not the working tree:
  // there, the text is the only copy of what the user is actually looking at.
  if (!block.isDirty && block.provenance.kind === 'worktree') return head

  const fence = fenceFor(block.text)
  // No trimming anywhere: leading indentation is syntax, and a trailing newline
  // in the selection is part of what was selected.
  return `${head}\n\n${fence}${safeLanguageId(block.languageId)}\n${block.text}\n${fence}`
}

export interface ContextLabels {
  readonly heading: string
  readonly unsaved: string
  /**
   * Which version these lines are, translated by the caller, or `''` for the
   * working tree — where the path already says it.
   */
  readonly version: string
}

/**
 * A translation key and its parameters, for a caller that has a translator.
 *
 * The reducers do not, which is the standing rule here: events and payloads
 * carry keys and the renderer turns them into words. So the judgement — which
 * of these a provenance deserves, and what goes in the sentence — is decided by
 * the pure functions below and tested, while the words live in `en.json`.
 */
export interface Phrase {
  readonly key: string
  readonly params: Record<string, string>
}

/** Seven is what every git UI shows, and enough to `git show`. */
export function shortSha(sha: string): string {
  return /^[0-9a-f]{8,}$/i.test(sha) ? sha.slice(0, 7) : sha
}

/**
 * The pill's marker, or null when the path already says everything.
 *
 * Short: it sits beside a file name in a box the width of the composer.
 */
export function markFor(provenance: IdeProvenanceShape): Phrase | null {
  switch (provenance.kind) {
    case 'worktree':
      return null
    case 'ref':
      if (provenance.ref === 'HEAD') return { key: 'ide.mark.head', params: {} }
      // `~` is the git extension's name for the index, and means nothing to
      // anyone who has not read its source.
      if (provenance.ref === '~') return { key: 'ide.mark.index', params: {} }
      return { key: 'ide.mark.ref', params: { ref: shortSha(provenance.ref) } }
    case 'review':
      return { key: 'ide.mark.review', params: { commit: shortSha(provenance.commit) } }
  }
}

/**
 * The qualifier that goes into the message, or null for the working tree.
 *
 * This is the sentence that stops an agent reading the wrong lines. It names
 * the version *and* the command that reproduces it, because the alternative —
 * "these lines are from somewhere else, good luck" — leaves it with nothing to
 * do but open the file and be wrong.
 */
export function versionFor(provenance: IdeProvenanceShape, relativePath: string): Phrase | null {
  switch (provenance.kind) {
    case 'worktree':
      return null
    case 'ref':
      if (provenance.ref === 'HEAD')
        return { key: 'ide.version.head', params: { path: relativePath } }
      // No `git show` for the index: `:file` is the syntax, and putting a
      // colon-prefixed path in a sentence invites it being typed as a ref.
      if (provenance.ref === '~') return { key: 'ide.version.index', params: {} }
      return {
        key: 'ide.version.ref',
        params: { ref: provenance.ref, path: relativePath },
      }
    case 'review':
      return {
        key: 'ide.version.review',
        params: { commit: provenance.commit, path: relativePath },
      }
  }
}

/**
 * Add the block above the draft, leaving the caret under it.
 *
 * The same shape as `withQuote` and `withPaths`: context arrives from somewhere
 * that is not the keyboard, so it is appended as its own block rather than
 * inserted wherever the caret happened to be.
 */
/**
 * A problem sent from VS Code, as the lines that go into the composer.
 *
 * **Written for an agent to act on, not to admire.** The reference comes first,
 * for the reason `formatContextBlock` gives above and `attach.ts` sets: Chorus
 * hands agents paths, not attachments, so the file and line are the load-bearing
 * part and the rest is what a path cannot say. The message is quoted rather than
 * pasted bare, so a compiler's paragraph cannot be read as the user's own
 * instruction.
 *
 * The code is fenced with the document's language, and the fence is measured
 * against the text — a diagnostic about a markdown file can contain backticks.
 *
 * No instruction is added. What to *do* about a problem is the thing the user
 * came to type, and a composer that has already said "fix this" has answered the
 * only question it was there to ask.
 */
export function formatDiagnosticBlock(
  diagnostic: {
    readonly relativePath: string
    readonly startLine: number
    readonly endLine: number
    readonly languageId: string
    readonly message: string
    readonly source?: string | undefined
    readonly code?: string | undefined
    readonly text: string
  },
  labels: { readonly heading: string }
): string {
  const lines =
    diagnostic.startLine === diagnostic.endLine
      ? String(diagnostic.startLine)
      : `${String(diagnostic.startLine)}-${String(diagnostic.endLine)}`
  /* `eslint(no-shadow)` — the producer and its rule, when both are known, in the
     spelling every linter already prints. */
  const attribution =
    diagnostic.source === undefined
      ? diagnostic.code === undefined
        ? ''
        : ` (${diagnostic.code})`
      : diagnostic.code === undefined
        ? ` (${diagnostic.source})`
        : ` (${diagnostic.source}(${diagnostic.code}))`

  const quoted = diagnostic.message
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
    .join('\n')

  const head = `${labels.heading}: \`${diagnostic.relativePath}:${lines}\`${attribution}`
  if (diagnostic.text === '') return `${head}\n\n${quoted}`

  const fence = fenceFor(diagnostic.text)
  return `${head}\n\n${quoted}\n\n${fence}${safeLanguageId(diagnostic.languageId)}\n${diagnostic.text}\n${fence}`
}

export function withEditorContext(draft: string, block: string): string {
  if (block === '') return draft
  const body = draft.trimStart()
  return body === '' ? `${block}\n\n` : `${block}\n\n${body}`
}
