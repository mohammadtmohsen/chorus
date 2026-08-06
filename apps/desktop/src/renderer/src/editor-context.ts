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
  const suffix = block.isDirty ? ` (${labels.unsaved})` : ''
  const head = `${labels.heading}: \`${reference}\`${suffix}`
  if (block.isEmpty || block.text === '') return head
  if (!block.isDirty) return head

  const fence = fenceFor(block.text)
  // No trimming anywhere: leading indentation is syntax, and a trailing newline
  // in the selection is part of what was selected.
  return `${head}\n\n${fence}${safeLanguageId(block.languageId)}\n${block.text}\n${fence}`
}

export interface ContextLabels {
  readonly heading: string
  readonly unsaved: string
}

/**
 * Add the block above the draft, leaving the caret under it.
 *
 * The same shape as `withQuote` and `withPaths`: context arrives from somewhere
 * that is not the keyboard, so it is appended as its own block rather than
 * inserted wherever the caret happened to be.
 */
export function withEditorContext(draft: string, block: string): string {
  if (block === '') return draft
  const body = draft.trimStart()
  return body === '' ? `${block}\n\n` : `${block}\n\n${body}`
}
