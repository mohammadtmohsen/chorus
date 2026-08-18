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

/**
 * A quoted path, or a bare absolute one, at the end of a message.
 *
 * Anchored to the end because that is where `withPaths` puts them, and only
 * there: a path named *inside* a sentence is something the person is talking
 * about, and replacing it with a picture would edit what they said.
 */
/*
 * The leading boundary is load-bearing: without it the bare arm matches from
 * any slash, so `see src/App.tsx` ends in a "path" of `/App.tsx` and the words
 * lose their last token to a tile that is not there. Caught by its own test.
 */
const TRAILING_PATH = /(?:^|\s)(?:'((?:'\\''|[^'])+)'|(\/[^\s'"]+))\s*$/

/** Undoes `quotePath` for the one escape it produces. */
function unquote(quoted: string): string {
  return quoted.replaceAll("'\\''", "'")
}

/**
 * The paths a message ends with, and the words in front of them.
 *
 * The inverse of `withPaths`, for drawing a sent message: what the agent gets is
 * still the text with the paths in it — that has not changed and must not — but
 * a person re-reading their own message should see the picture they attached,
 * not forty characters of `/Users/…/1787054491497-3-image.png`.
 *
 * **It only proposes.** A path here is a candidate: the caller asks main for a
 * preview and draws a tile only for the ones that turn out to be showable
 * images, so a message ending in a path that is a directory, a log, or nothing
 * at all keeps its text exactly as typed. That is why this cannot be wrong in
 * a way anyone sees — the worst case is the message it already draws.
 *
 * Paths come back in the order they appear, and `body` keeps its own trailing
 * whitespace trimmed so the words do not end in the gap the paths left.
 */
export function splitTrailingPaths(text: string): { body: string; paths: string[] } {
  const paths: string[] = []
  let body = text
  // From the end, because that is the only place they are recognised, and a
  // message may carry several.
  for (;;) {
    const found = TRAILING_PATH.exec(body)
    if (found === null) break
    const [whole, quoted, bare] = found
    const path = quoted === undefined ? bare : unquote(quoted)
    if (path === undefined || path === '') break
    paths.unshift(path)
    body = body.slice(0, body.length - whole.length)
  }
  return { body: body.replace(/\s+$/, ''), paths }
}
