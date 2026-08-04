/**
 * A deliberately small markdown parser producing a typed tree.
 *
 * Agent output is untrusted input. Rather than render HTML and sanitize it, this
 * parses to a structure that the renderer turns into React elements — so there
 * is no HTML string anywhere in the pipeline and injection is impossible by
 * construction, not by filtering. That is a stronger guarantee than a sanitizer,
 * and it is why this exists instead of a markdown dependency (plan §4.4).
 *
 * It covers what agents actually emit: fenced code, headings, lists, block
 * quotes, paragraphs, and inline code/emphasis/links. Anything unrecognised
 * degrades to plain text, which is the safe direction to fail.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

export type Block =
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly content: readonly Inline[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly text: string }
  | {
      readonly kind: 'list'
      readonly ordered: boolean
      readonly items: readonly (readonly Inline[])[]
    }
  | { readonly kind: 'quote'; readonly content: readonly Inline[] }

const FENCE = /^```(\w*)\s*$/
// Accepts h1-h6 and clamps to three; deeper headings inside a chat message
// carry no extra structure worth rendering.
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const ORDERED = /^\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join('\n')) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    const fence = FENCE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const language = fence[1] === undefined || fence[1] === '' ? null : fence[1]
      const body: string[] = []
      i++
      // An unterminated fence runs to the end — which is what a stream that was
      // interrupted mid-code-block looks like, and it must still render.
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        body.push(lines[i] ?? '')
        i++
      }
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = Math.min(3, heading[1]?.length ?? 1) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, content: parseInline(heading[2] ?? '') })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flushParagraph()
      const body = [quote[1] ?? '']
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1] ?? '')) {
        i++
        body.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '')
      }
      blocks.push({ kind: 'quote', content: parseInline(body.join('\n')) })
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph()
      const ordered = ORDERED.test(line)
      const items: Inline[][] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const match = ordered ? ORDERED.exec(current) : BULLET.exec(current)
        if (match === null) break
        items.push(parseInline(match[1] ?? ''))
        i++
      }
      i--
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }

  flushParagraph()
  return blocks
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let rest = source

  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (match === null) break

    if (match.index > 0) out.push({ kind: 'text', text: rest.slice(0, match.index) })
    const token = match[0]

    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (token.startsWith('**')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) })
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push({ kind: 'em', text: token.slice(1, -1) })
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      const href = link?.[2] ?? ''
      // Only these schemes become links. A `javascript:` or `data:` url would be
      // a live exploit path handed to us by the model.
      out.push(
        isSafeHref(href)
          ? { kind: 'link', text: link?.[1] ?? href, href }
          : { kind: 'text', text: token }
      )
    }
    rest = rest.slice(match.index + token.length)
  }

  if (rest.length > 0) out.push({ kind: 'text', text: rest })
  return coalesceText(out)
}

/**
 * Merges neighbouring text nodes.
 *
 * A rejected link leaves its literal characters split across several nodes;
 * joining them keeps the rendered output identical to what the model wrote.
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
 * Splitting on a blank line *inside* a fence would render an unterminated fence
 * as prose, so fence depth is tracked.
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

  for (const line of lines) {
    if (line.startsWith('```')) insideFence = !insideFence
    if (!insideFence && line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}
