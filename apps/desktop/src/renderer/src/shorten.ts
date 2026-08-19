import { formatReference, shortSha, type EditorReference } from './editor-context.js'

/**
 * Long identifiers in your own message, cut down to what identifies them.
 *
 * Chorus writes references into the messages you send — the VS Code context
 * block is the worst of them — and they are written **for the agent**: the whole
 * relative path so it can open the file, the whole commit sha so `git show`
 * works. Both are load-bearing and neither may change.
 *
 * What they are not is readable. One context line put an eighty-character path
 * in three times and a forty-character sha twice, and a question that was six
 * words long drew as four wrapped lines of monospace with the question hidden
 * somewhere inside it.
 *
 * So this is the display side of the same rule the composer's pill already
 * follows — `markFor` has shown `shortSha` beside a filename since the pill
 * existed. The message keeps every character; only the transcript is shortened,
 * and the whole value is on the element's `title`.
 */

/**
 * Longer than this and a span is cut. Shorter and it is left exactly as typed.
 *
 * Around the width of a short sentence in the transcript's monospace, which is
 * the point at which a reference stops being read and starts being a wall. Well
 * above anything worth keeping whole — `src/App.tsx:12-18` is eighteen.
 */
export const MAX_CODE_SPAN = 44

/** Kept from the tail of a path, because the file name is the identifying part. */
const KEEP_SEGMENTS = 2

/**
 * A hex run long enough that nothing else is plausibly meant.
 *
 * Twenty-four rather than `shortSha`'s eight, because that function is applied
 * to a value already known to be a ref while this one runs over whatever a
 * message happens to contain. A full sha is forty; an abbreviated one is
 * already short enough to leave alone, and a word like `deadbeef` is eight.
 */
const LONG_HEX = /\b[0-9a-f]{24,}\b/gi

/**
 * Commits cut to seven wherever they appear, not only when they are the whole
 * span.
 *
 * The case that forced it: `git show <sha>:<path>` is one code span, and it is
 * neither a sha nor a path — so the length rules below middle-elided it into
 * `git show e81e4ca2b006…a31a7641e7b5abf1fa054`, which keeps twenty-one
 * characters of a number nobody reads and still wraps. Seven is what every git
 * UI shows and what `shortSha` has always given the composer's pill.
 */
function shortenShas(text: string): string {
  // Through `shortSha`, so the length that means "a commit, to a human" is
  // defined once and the composer's pill and the transcript cannot disagree.
  return text.replace(LONG_HEX, (sha) => shortSha(sha))
}

/**
 * One colon-separated part: a sha, a path, or something else entirely.
 *
 * Colons rather than the whole string, because the forms that actually appear
 * are `path:lines` and `sha:path`, and shortening either half in isolation is
 * both simpler and better than any rule over the pair.
 */
function shortenPart(part: string): string {
  if (part.length <= MAX_CODE_SPAN) return part

  const segments = part.split('/')
  if (segments.length > KEEP_SEGMENTS) {
    const tail = segments.slice(-KEEP_SEGMENTS).join('/')
    // One segment if two still do not fit — a file name alone beats a path so
    // wide it wraps, and the `title` is where the whole of it lives.
    return `…/${tail.length <= MAX_CODE_SPAN ? tail : (segments.at(-1) ?? tail)}`
  }

  // Not a path and not a sha: keep both ends, since whatever identifies it is
  // more likely to be at an edge than in the middle.
  const half = Math.floor((MAX_CODE_SPAN - 1) / 2)
  return `${part.slice(0, half)}…${part.slice(-half)}`
}

/**
 * The shortened form of an inline code span, or the span itself.
 *
 * Returns the input unchanged whenever there is nothing worth cutting, so a
 * caller can compare identity to decide whether a `title` is worth adding.
 */
/**
 * The composer pill's reference, in the three parts it has to be drawn in.
 *
 * The pill used to build its own `path:start-end` string and hand the whole
 * thing to one span with `text-overflow: ellipsis`. CSS elides from the *end*,
 * so the first thing thrown away was the line range — the one part of a
 * reference you cannot reconstruct by looking at the editor, and the reason the
 * pill is there at all. A real one read
 * `src/features/insurance-info/procedure-pricing/hcpc-pri…`: no file name, no
 * lines, and four directory names nobody needed.
 *
 * Two things fix it together, and both are needed. `shortenCodeSpan` cuts the
 * path at a directory boundary so the *text* is short enough to fit — the same
 * rule the transcript already uses, so a reference reads the same in both
 * places. Splitting `lines` off then guarantees the rest: the caller pins that
 * span against shrinking, so even in a pane too narrow for the shortened form
 * the range survives and it is a directory that goes.
 *
 * `full` is what belongs on `title`, because eliding text without keeping the
 * whole of it somewhere is just losing it.
 */
export interface PillReference {
  /** The complete reference, for `title`. */
  readonly full: string
  /** Shortened, and the part that may be elided further. */
  readonly path: string
  /** `:12-18`, including the colon, and never elided. Empty if there is none. */
  readonly lines: string
}

export function pillReference(reference: EditorReference): PillReference {
  const full = formatReference(reference)
  const shown = shortenCodeSpan(full)
  /*
   * The last colon, not the first: a path may contain one, and the line range
   * is always the tail. `formatReference` always writes at least `:12`, so the
   * empty case is unreachable through it — handled anyway rather than asserted,
   * because a caller passing something else should degrade to "all path".
   */
  const cut = shown.lastIndexOf(':')
  if (cut < 0) return { full, path: shown, lines: '' }
  return { full, path: shown.slice(0, cut), lines: shown.slice(cut) }
}

export function shortenCodeSpan(text: string): string {
  /*
   * Shas first, and unconditionally.
   *
   * A forty-character commit is under the length threshold, so a span that is
   * nothing but a sha would otherwise survive whole — which is the one case
   * where the short form is not a compromise but the form everybody already
   * uses. Doing it first also rescues the compound spans: `git show <sha>:<path>`
   * becomes short enough that the path rule below is all that is left to do.
   */
  const deshaed = shortenShas(text)
  if (deshaed.length <= MAX_CODE_SPAN) return deshaed
  // A line range is a part too — `4-31` is short and survives untouched.
  const shortened = deshaed.split(':').map(shortenPart).join(':')
  return shortened.length < text.length ? shortened : text
}
