/**
 * Turning dropped and pasted things into paths.
 *
 * Chorus hands agents **paths**, not attachments. The filesystem is not scoped
 * (§4.4), so an agent opens a file the same way you would — which means a drop
 * needs no upload, no copy and no protocol change, and works for anything:
 * images, logs, a whole directory.
 *
 * A path is quoted only when it needs to be. Most do not, and a transcript full
 * of quotation marks around ordinary paths reads worse than it needs to.
 */

/** Anything a shell would take exception to. */
const NEEDS_QUOTES = /[\s"'`$&|;<>()*?[\]{}\\!#~]/

export function quotePath(path: string): string {
  if (!NEEDS_QUOTES.test(path)) return path
  return `'${path.replaceAll("'", `'\\''`)}'`
}

/**
 * Adds paths to a draft, on their own line.
 *
 * Appended rather than inserted at the caret: a drop lands wherever the pointer
 * was, which has nothing to do with where you were typing.
 */
export function withPaths(draft: string, paths: readonly string[]): string {
  if (paths.length === 0) return draft
  const added = paths.map(quotePath).join(' ')
  if (draft.trim() === '') return `${added} `
  return `${draft.replace(/\s+$/, '')} ${added} `
}
