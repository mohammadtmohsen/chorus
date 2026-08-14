/**
 * A deliberately small markdown parser producing a typed tree.
 *
 * Agent output is untrusted input. Rather than render HTML and sanitize it, this
 * parses to a structure that the renderer turns into React elements — so there
 * is no HTML string anywhere in the pipeline and injection is impossible by
 * construction, not by filtering. That is a stronger guarantee than a sanitizer,
 * and it is why this exists instead of a markdown dependency (plan §4.4).
 *
 * It covers what agents actually emit, which is more than it once did: fenced
 * and indented code, ATX and setext headings, thematic breaks, GFM pipe tables,
 * nested and task lists, block quotes containing any of the above, paragraphs,
 * and inline code / emphasis / strikethrough / links / autolinks / images.
 * Anything unrecognised degrades to plain text, which is the safe direction to
 * fail.
 *
 * Tables were the gap that prompted the rest: a pipe table used to fall through
 * to the paragraph case and render as one run-together line with the `|---|`
 * delimiter row visible in the middle of it.
 */

import { linkifyIssues } from './issue-links.js'

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly content: readonly Inline[] }
  | { readonly kind: 'em'; readonly content: readonly Inline[] }
  | { readonly kind: 'del'; readonly content: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly content: readonly Inline[] }
  | { readonly kind: 'image'; readonly href: string; readonly alt: string }

/** One table cell's inline content. */
export type Cell = readonly Inline[]
export type Row = readonly Cell[]
/** `null` is "no alignment given", which the renderer leaves to the stylesheet. */
export type Align = 'left' | 'center' | 'right' | null

/**
 * A list item's own text, plus whatever blocks were nested under it.
 *
 * `content` is the item's first paragraph and `children` everything after —
 * nested lists, code blocks, further paragraphs. Splitting them this way lets
 * the renderer keep a one-line item as a plain `<li>` with no paragraph margin,
 * which is what a tight list should look like, while still rendering a
 * multi-block item correctly.
 */
export interface ListItem {
  readonly content: readonly Inline[]
  /** `null` when the item is not a task item; otherwise its checkbox state. */
  readonly checked: boolean | null
  readonly children: readonly Block[]
}

export type Block =
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly content: readonly Inline[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly text: string }
  | {
      readonly kind: 'list'
      readonly ordered: boolean
      /** The first marker's number, so `3.` does not restart the list at one. */
      readonly start: number
      readonly items: readonly ListItem[]
    }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | {
      readonly kind: 'table'
      readonly align: readonly Align[]
      readonly head: Row
      readonly rows: readonly Row[]
    }
  | { readonly kind: 'rule' }

/** Up to three leading spaces are indentation noise everywhere in markdown. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const SETEXT_ONE = /^ {0,3}=+[ \t]*$/
const SETEXT_TWO = /^ {0,3}-+[ \t]*$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const INDENTED_CODE = /^ {4}/
const DELIMITER_CELL = /^:?-+:?$/

/**
 * Recursion caps.
 *
 * Both parsers recurse on model output, and `>>>>>…` repeated ten thousand times
 * is a two-byte-per-level stack overflow that takes the whole renderer down.
 * Past the cap the construct degrades to text, which is the same failure mode as
 * any other unrecognised syntax.
 */
const MAX_BLOCK_DEPTH = 8
const MAX_INLINE_DEPTH = 6

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n/g, '\n').split('\n').map(expandLeadingTabs))
}

/**
 * Indentation is measured in spaces everywhere below, so a leading tab has to
 * become spaces before anything counts it. Only *leading* whitespace is
 * touched — a tab inside a line is content, including inside a code fence,
 * where the four-space expansion is the one visible cost of this.
 */
function expandLeadingTabs(line: string): string {
  const indent = /^[ \t]+/.exec(line)?.[0]
  return indent === undefined ? line : indent.replace(/\t/g, '    ') + line.slice(indent.length)
}

function parseBlocks(lines: readonly string[], depth = 0): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join('\n')) })
    paragraph = []
  }

  if (depth > MAX_BLOCK_DEPTH) {
    return lines.join('\n').trim() === ''
      ? []
      : [{ kind: 'paragraph', content: parseInline(lines.join('\n')) }]
  }

  let i = 0
  // Every branch leaves `i` on the first line it did not consume.
  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = FENCE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[1] ?? '```'
      const language = fence[2] === undefined || fence[2] === '' ? null : fence[2]
      // A fence closes on a run of its own character at least as long as itself,
      // so a shorter run inside a ```` ```` ```` block stays content.
      const closing = new RegExp(
        String.raw`^ {0,3}${marker.startsWith('`') ? '`' : '~'}{${String(marker.length)},}[ \t]*$`
      )
      const body: string[] = []
      i++
      // An unterminated fence runs to the end — which is what a stream that was
      // interrupted mid-code-block looks like, and it must still render.
      while (i < lines.length && !closing.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i++
      }
      if (i < lines.length) i++
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      i++
      continue
    }

    /*
     * An indented code block, but only where one can legally start.
     *
     * Four spaces under an open paragraph is a continuation line, not code —
     * agents wrap and indent prose constantly, and reading that as code would
     * turn ordinary sentences into grey monospace boxes.
     */
    if (paragraph.length === 0 && INDENTED_CODE.test(line)) {
      const body: string[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        if (INDENTED_CODE.test(current)) {
          body.push(current.slice(4))
          i++
          continue
        }
        if (current.trim() !== '') break
        // A blank line stays inside the block only if indented code resumes.
        let ahead = i
        while (ahead < lines.length && (lines[ahead] ?? '').trim() === '') ahead++
        if (ahead >= lines.length || !INDENTED_CODE.test(lines[ahead] ?? '')) break
        for (; i < ahead; i++) body.push('')
      }
      blocks.push({ kind: 'code', language: null, text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = Math.min(3, heading[1]?.length ?? 1) as 1 | 2 | 3
      // A trailing `###` is a closing sequence, not part of the text.
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
      blocks.push({ kind: 'heading', level, content: parseInline(text) })
      i++
      continue
    }

    /*
     * A table, which may start directly under a paragraph line.
     *
     * Checked before the setext and rule cases because `|---|---|` matches
     * neither, and before the paragraph fallback because that is the bug this
     * whole case exists to fix.
     */
    if (line.includes('|')) {
      const table = parseTable(lines, i)
      if (table !== null) {
        flushParagraph()
        blocks.push(table.block)
        i = table.next
        continue
      }
    }

    /*
     * Setext headings, which are the text above plus this underline.
     *
     * Checked before `RULE` because `---` under a paragraph is a heading in
     * GFM, not a thematic break — and after `parseTable`, so a delimiter row is
     * never mistaken for one.
     */
    if (paragraph.length > 0 && (SETEXT_ONE.test(line) || SETEXT_TWO.test(line))) {
      const content = parseInline(paragraph.join('\n'))
      paragraph = []
      blocks.push({ kind: 'heading', level: SETEXT_ONE.test(line) ? 1 : 2, content })
      i++
      continue
    }

    if (RULE.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flushParagraph()
      const body = [quote[1] ?? '']
      i++
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const marked = QUOTE.exec(current)
        if (marked !== null) {
          body.push(marked[1] ?? '')
          i++
          continue
        }
        // A lazy continuation line belongs to the quote's paragraph; anything
        // that opens a block of its own ends the quote.
        if (current.trim() === '' || startsBlock(current) || matchListItem(current) !== null) break
        body.push(current)
        i++
      }
      // Recursive, so a list, a code block or a nested quote inside a quote
      // renders as itself rather than as flattened text.
      blocks.push({ kind: 'quote', blocks: parseBlocks(body, depth + 1) })
      continue
    }

    const marker = matchListItem(line)
    if (marker !== null && marker.indent <= 3) {
      flushParagraph()
      const items: ListItem[] = []
      while (i < lines.length) {
        const current = matchListItem(lines[i] ?? '')
        // A different marker type starts a different list, as does a marker
        // indented far enough to belong to the item above.
        if (current === null || current.indent > 3 || current.ordered !== marker.ordered) break

        const body: string[] = [current.text]
        i++
        while (i < lines.length) {
          const next = lines[i] ?? ''
          if (next.trim() === '') {
            const ahead = nextContentLine(lines, i)
            // A blank line only stays inside the item if indented content
            // follows it — that is what makes a loose or multi-block item.
            if (ahead === null || leadingWidth(lines[ahead] ?? '') < current.contentIndent) break
            body.push('')
            i++
            continue
          }
          if (leadingWidth(next) >= current.contentIndent) {
            body.push(next.slice(current.contentIndent))
            i++
            continue
          }
          if (matchListItem(next) !== null || startsBlock(next)) break
          body.push(next.trim())
          i++
        }
        items.push(buildListItem(body, depth))
      }
      blocks.push({ kind: 'list', ordered: marker.ordered, start: marker.number, items })
      continue
    }

    paragraph.push(line)
    i++
  }

  flushParagraph()
  return blocks
}

/** The constructs that end a lazy continuation line. */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
}

function leadingWidth(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0
}

function nextContentLine(lines: readonly string[], from: number): number | null {
  for (let i = from; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') return i
  }
  return null
}

interface Marker {
  readonly indent: number
  readonly ordered: boolean
  readonly number: number
  /** The column the item's content starts at, used to dedent its body. */
  readonly contentIndent: number
  readonly text: string
}

function matchListItem(line: string): Marker | null {
  const match = /^( *)([-*+]|\d{1,9}[.)])( *)(.*)$/.exec(line)
  if (match === null) return null
  const [, pad = '', marker = '', gap = '', text = ''] = match
  // A marker has to be followed by space, or be the whole line: `*bold*` and
  // `1.5x faster` are emphasis and prose, not bullets.
  if (gap.length === 0 && text !== '') return null
  const ordered = /\d/.test(marker)
  return {
    indent: pad.length,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 1,
    // An empty item still opens one column of content, hence the floor of one.
    contentIndent: pad.length + marker.length + Math.max(gap.length, 1),
    text,
  }
}

const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/

function buildListItem(body: readonly string[], depth: number): ListItem {
  const task = TASK.exec(body[0] ?? '')
  const checked = task === null ? null : (task[1] ?? ' ').toLowerCase() === 'x'
  const lines = task === null ? body : [task[2] ?? '', ...body.slice(1)]

  const [first, ...rest] = parseBlocks(lines, depth + 1)
  // The leading paragraph becomes the item's own inline content so a tight item
  // renders without a paragraph's margins; anything else stays a child block.
  return first?.kind === 'paragraph'
    ? { content: first.content, checked, children: rest }
    : { content: [], checked, children: first === undefined ? [] : [first, ...rest] }
}

/**
 * A GFM pipe table, or `null` if this is not one.
 *
 * The delimiter row is what makes a table a table: without it these are just
 * lines containing pipes, and a prose sentence with a pipe in it must not turn
 * into a one-cell table. The cell counts of the header and delimiter rows have
 * to agree for the same reason.
 */
function parseTable(
  lines: readonly string[],
  start: number
): { block: Block; next: number } | null {
  const delimiter = lines[start + 1]
  if (delimiter === undefined) return null

  const head = splitRow(lines[start] ?? '')
  const cells = splitRow(delimiter)
  if (cells.length !== head.length) return null
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null

  const align = cells.map(alignOf)
  const rows: Row[] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || !line.includes('|')) break
    if (startsBlock(line)) break
    const row = splitRow(line)
    // Short rows are padded and long ones truncated, so the table stays
    // rectangular no matter how carelessly the model counted its pipes.
    rows.push(head.map((_, column) => parseInline(row[column] ?? '')))
    i++
  }

  return {
    block: { kind: 'table', align, head: head.map((cell) => parseInline(cell)), rows },
    next: i,
  }
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/**
 * Splits one table row into cells.
 *
 * Pipe-aware in the two ways that matter in agent output: `\|` is a literal
 * pipe, and a pipe inside a code span belongs to the code, not to the table —
 * `` `a|b` `` is one cell.
 */
function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)

  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < row.length; i++) {
    const char = row[i] ?? ''
    if (char === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (char === '`') inCode = !inCode
    if (char === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

/** Every ASCII punctuation mark can be backslash-escaped, per GFM. */
const ESCAPABLE = /^[!-/:-@[-`{-~]$/
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i
/*
 * A bare url, stopping before trailing punctuation.
 *
 * Agents write "see https://example.com/x." and the full stop is the sentence's,
 * not the url's — so the last character may not be one.
 */
const BARE_URL = /^https?:\/\/[^\s<>[\]()]*[^\s<>[\]().,;:!?'"]/i
const LINK = /^\[((?:[^[\]\\]|\\.)*)\]\([ \t]*(<[^<>]*>|[^\s)]*)[ \t]*(?:"[^"]*"|'[^']*')?[ \t]*\)/
const IMAGE = new RegExp(`^!${LINK.source.slice(1)}`)

export function parseInline(source: string): Inline[] {
  return decorate(scanInline(source, 0))
}

function scanInline(source: string, depth: number): Inline[] {
  const out: Inline[] = []
  let pending = ''

  const flush = (): void => {
    if (pending === '') return
    out.push({ kind: 'text', text: pending })
    pending = ''
  }

  let i = 0
  while (i < source.length) {
    const char = source[i] ?? ''

    if (char === '\\') {
      const next = source[i + 1] ?? ''
      if (ESCAPABLE.test(next)) {
        pending += next
        i += 2
        continue
      }
    }

    if (char === '`') {
      const span = matchCodeSpan(source, i)
      if (span !== null) {
        flush()
        out.push({ kind: 'code', text: span.text })
        i = span.next
        continue
      }
    }

    if (char === '!' && source[i + 1] === '[') {
      const image = IMAGE.exec(source.slice(i))
      if (image !== null) {
        const href = stripAngles(image[2] ?? '')
        flush()
        out.push(
          isSafeHref(href)
            ? { kind: 'image', href, alt: image[1] ?? '' }
            : { kind: 'text', text: image[0] }
        )
        i += image[0].length
        continue
      }
    }

    if (char === '[') {
      const link = LINK.exec(source.slice(i))
      if (link !== null) {
        const href = stripAngles(link[2] ?? '')
        flush()
        // Only safe schemes become links. A `javascript:` or `data:` url would
        // be a live exploit path handed to us by the model; rendering it as text
        // shows the user exactly what was attempted instead of hiding it.
        out.push(
          isSafeHref(href)
            ? { kind: 'link', href, content: scanInline(link[1] ?? '', depth + 1) }
            : { kind: 'text', text: link[0] }
        )
        i += link[0].length
        continue
      }
    }

    if (char === '<') {
      const autolink = AUTOLINK.exec(source.slice(i))
      if (autolink !== null) {
        const href = autolink[1] ?? ''
        flush()
        out.push({ kind: 'link', href, content: [{ kind: 'text', text: href }] })
        i += autolink[0].length
        continue
      }
    }

    if ((char === 'h' || char === 'H') && !isWordChar(source[i - 1])) {
      const url = BARE_URL.exec(source.slice(i))
      if (url !== null) {
        flush()
        out.push({ kind: 'link', href: url[0], content: [{ kind: 'text', text: url[0] }] })
        i += url[0].length
        continue
      }
    }

    if (depth < MAX_INLINE_DEPTH && (char === '*' || char === '_' || char === '~')) {
      const emphasis = matchEmphasis(source, i, depth)
      if (emphasis !== null) {
        flush()
        out.push(emphasis.node)
        i = emphasis.next
        continue
      }
    }

    pending += char
    i++
  }

  flush()
  return out
}

/**
 * A code span, honouring GFM's variable-length backtick runs.
 *
 * `` ``a `b` c`` `` is one span containing backticks, which matters because
 * agents quote markdown at us constantly. The closing run must be the same
 * length as the opening one, so a longer run inside is content.
 */
function matchCodeSpan(source: string, at: number): { text: string; next: number } | null {
  const open = /^`+/.exec(source.slice(at))?.[0]
  if (open === undefined) return null

  let from = at + open.length
  while (from <= source.length) {
    const found = source.indexOf(open, from)
    if (found === -1) return null
    let end = found + open.length
    if (source[end] === '`') {
      // Part of a longer run: not a closer.
      while (source[end] === '`') end++
      from = end
      continue
    }
    let text = source.slice(at + open.length, found)
    // GFM strips one space from each end so `` ` `` can be written as `` ` ``.
    if (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') text = text.slice(1, -1)
    return { text, next: found + open.length }
  }
  return null
}

function matchEmphasis(
  source: string,
  at: number,
  depth: number
): { node: Inline; next: number } | null {
  const char = source[at] ?? ''
  // Longest run first, so `***both***` nests rather than leaving a stray star.
  const delimiters = char === '~' ? ['~~', '~'] : [char.repeat(3), char.repeat(2), char]

  for (const delimiter of delimiters) {
    if (!source.startsWith(delimiter, at)) continue
    const close = findCloser(source, at + delimiter.length, delimiter)
    if (close === null) continue

    const inner = source.slice(at + delimiter.length, close)
    // No empty span, and no leading or trailing space — otherwise `2 * 3 * 4`
    // and a line of `* * *` become emphasis, which is how arithmetic in an
    // agent's explanation used to turn italic.
    if (inner === '' || /^\s/.test(inner) || /\s$/.test(inner)) continue
    /*
     * Underscores never emphasise inside a word, which is GFM's rule and the one
     * that matters most here: `snake_case_name` is an identifier, and a
     * transcript of coding agents is full of them. Asterisks keep GFM's
     * intraword behaviour, because `a*b*c` really is emphasis there.
     */
    if (
      char === '_' &&
      (isWordChar(source[at - 1]) || isWordChar(source[close + delimiter.length]))
    )
      continue

    const content = scanInline(inner, depth + 1)
    const next = close + delimiter.length
    if (char === '~') return { node: { kind: 'del', content }, next }
    if (delimiter.length === 3) {
      return { node: { kind: 'strong', content: [{ kind: 'em', content }] }, next }
    }
    return { node: { kind: delimiter.length === 2 ? 'strong' : 'em', content }, next }
  }
  return null
}

/** Finds a closing delimiter, stepping over escapes and code spans. */
function findCloser(source: string, from: number, delimiter: string): number | null {
  let i = from
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '`') {
      const span = matchCodeSpan(source, i)
      if (span !== null) {
        i = span.next
        continue
      }
    }
    if (source.startsWith(delimiter, i)) return i
    i++
  }
  return null
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\w]/.test(char)
}

function stripAngles(href: string): string {
  return href.startsWith('<') && href.endsWith('>') ? href.slice(1, -1) : href
}

/**
 * Coalesces text and turns issue keys into links, all the way down.
 *
 * Recursive so a key inside `**bold**` still links. Link content is left alone:
 * a key the model already linked keeps the href it chose.
 */
function decorate(nodes: readonly Inline[]): Inline[] {
  return linkifyIssues(coalesceText(nodes)).map((node) =>
    node.kind === 'strong' || node.kind === 'em' || node.kind === 'del'
      ? { ...node, content: decorate(node.content) }
      : node
  )
}

/**
 * Merges neighbouring text nodes.
 *
 * A rejected link leaves its literal characters split across several nodes;
 * joining them keeps the rendered output identical to what the model wrote, and
 * lets an issue key split by that rejection still match.
 */
function coalesceText(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    const previous = out.at(-1)
    if (node.kind === 'text' && previous?.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: previous.text + node.text }
    } else {
      out.push(node)
    }
  }
  return out
}

export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href)
}

/**
 * Splits a source into raw block sources, fence-aware.
 *
 * Re-parsing a whole message on every streamed delta is quadratic in its
 * length — measured at 17% dropped frames on a 25k-character reply. Splitting
 * first lets the renderer memoise each block on its own text, so a message that
 * grows only re-parses the block currently being written.
 *
 * The split is a pure performance detail and must never change what renders, so
 * it only ever errs towards keeping lines together: inside a fence, and across
 * the blank line in a loose list or a quote, where splitting would break one
 * construct into two.
 */
export function splitBlocks(source: string): string[] {
  const lines = source.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let insideFence = false

  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) insideFence = !insideFence
    if (!insideFence && line.trim() === '') {
      if (continuesBlock(current[0], lines, i)) {
        current.push(line)
        continue
      }
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}

/** Whether the blank line at `at` sits inside the list or quote already open. */
function continuesBlock(opener: string | undefined, lines: readonly string[], at: number): boolean {
  if (opener === undefined) return false
  const ahead = nextContentLine(lines, at + 1)
  if (ahead === null) return false
  const next = lines[ahead] ?? ''

  if (QUOTE.test(opener)) return QUOTE.test(next)
  const marker = matchListItem(expandLeadingTabs(opener))
  if (marker === null || marker.indent > 3) return false
  // Either the next item, or content indented under the item above it.
  return (
    matchListItem(expandLeadingTabs(next)) !== null || leadingWidth(expandLeadingTabs(next)) >= 2
  )
}

/**
 * A trailing `## Summary` section, lifted out of a reply.
 *
 * The approved composition draws a `Summary` card under an agent's answer, and
 * nothing in the event log can produce one: `SummaryPanel`'s own comment says
 * the log cannot answer "was the work any good, what is missing, what next".
 * So the card is a **convention** — an agent that ends its reply with a
 * `Summary` heading and a bullet list gets one — rather than a contract the app
 * can enforce. Most turns will have none, and that is the honest cost of not
 * inventing an event.
 *
 * Three rules, and each exists because a looser one is wrong:
 *
 * - **The heading is at column zero.** `HEADING` allows three leading spaces,
 *   and an indented heading is a child of the list item above it — so
 *   `- Example:` / `  ## Summary` / `  - not a summary` would be lifted out of a
 *   list. A scanner cannot establish "top level" by looking at the tail, and
 *   requiring column zero is what makes the tail's parse trustworthy.
 * - **Fences are matched, not toggled.** The opening marker's character and
 *   length are remembered, so a longer or different fence inside a block does
 *   not close it early and leave the rest read as prose.
 * - **The tail must parse as exactly a heading and an unordered list.** That
 *   rejects a heading with prose after it, a numbered list (a different thing,
 *   which should stay in the body), and `> ## Summary`, which parses as a quote
 *   and never as a heading.
 *
 * Returns the **cut offset** rather than a rebuilt body: the caller keeps
 * `source.slice(0, cut)`, an exact prefix of what the agent wrote, so nothing is
 * re-serialized and no blank line can be lost.
 */
export function trailingSummary(source: string): { cut: number; items: string[] } | null {
  const lines = source.split('\n')
  let offset = 0
  let fence: { char: string; length: number } | null = null
  let candidate: number | null = null

  for (const line of lines) {
    const opener = FENCE.exec(line)
    if (opener !== null) {
      const marker = opener[1] ?? ''
      const char = marker[0] ?? ''
      if (fence === null) fence = { char, length: marker.length }
      else if (char === fence.char && marker.length >= fence.length) fence = null
    } else if (fence === null && SUMMARY_HEADING.test(line)) {
      candidate = offset
    }
    offset += line.length + 1
  }
  if (candidate === null) return null

  const blocks = parseMarkdown(source.slice(candidate))
  const [heading, list, ...rest] = blocks
  if (heading?.kind !== 'heading' || list?.kind !== 'list' || rest.length > 0) return null
  if (list.ordered) return null

  return { cut: candidate, items: list.items.map((item) => inlineText(item.content)) }
}

/** A heading whose text is exactly "Summary", starting in column zero. */
const SUMMARY_HEADING = /^#{1,6}[ \t]+summary[ \t]*$/i

/**
 * Inline content as plain text.
 *
 * A bullet in the card is a line, not a document: it is drawn as text rather
 * than re-parsed, so emphasis inside one is flattened to the words it wrapped.
 * That is a deliberate limit — carrying the tree would mean the card renders
 * arbitrary agent markup in a second place, and the words are the whole content
 * of a summary line.
 */
function inlineText(content: readonly Inline[]): string {
  return content
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text
        case 'image':
          return node.alt
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return inlineText(node.content)
      }
    })
    .join('')
}
