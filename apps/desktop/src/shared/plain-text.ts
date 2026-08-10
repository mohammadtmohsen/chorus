import { parseMarkdown, type Block, type Inline } from './markdown.js'

/**
 * Markdown as the transcript actually reads on screen.
 *
 * `openAside` has to decide whether a selection genuinely came from a reply, and
 * it was comparing two things that were never the same shape: the **source** in
 * the log against what `selection.toString()` returned, which is what the DOM
 * **renders**. Anything markdown removes on the way — backticks, emphasis, a
 * link's target — or changes, like a newline inside a paragraph becoming a
 * space, made the check fail on selections that were perfectly genuine.
 *
 * Measured against the running app: a selection over `` `docs/plan.md` — created
 * in my last turn. `` came back without its backticks, and one spanning a
 * hard-wrapped paragraph came back with a space where the log has a newline.
 * Both were refused. Agents write inline code constantly, so most selections
 * were (C-024).
 *
 * This projects the **same parse tree the renderer draws** rather than stripping
 * syntax with a second set of regexes. A stripper that disagreed with the real
 * parser would be a new way to be wrong, and the disagreements would be exactly
 * the passages nobody could ask about.
 */
export function plainTextOf(markdown: string): string {
  return parseMarkdown(markdown).map(blockText).join('\n')
}

/**
 * A paragraph's newlines become spaces; a code block's do not.
 *
 * That is not a detail — it is the whole reason this cannot be one rule.
 * `.md-p` inherits `white-space: normal`, so the browser collapses its line
 * breaks; `.md-code` is a `<pre>`, so it keeps them. A selection's text follows
 * whichever it came from.
 */
function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return collapse(inlineText(block.content))
    case 'code':
      return block.text
    case 'list':
      /*
       * `content` and `children` both, and `content` is the one that matters:
       * an item's own words live there, while `children` holds only nested
       * blocks. Reading `children` alone projected every flat list to nothing,
       * which a test caught.
       */
      return block.items
        .map((item) =>
          [collapse(inlineText(item.content)), ...item.children.map(blockText)]
            .filter((part) => part !== '')
            .join('\n')
        )
        .join('\n')
    case 'quote':
      return block.blocks.map(blockText).join('\n')
    case 'table':
      return [block.head, ...block.rows]
        .map((row) => row.map((cell) => collapse(inlineText(cell))).join(' '))
        .join('\n')
    case 'rule':
      return ''
  }
}

function inlineText(content: readonly Inline[]): string {
  return content
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          // A link renders as its text; the href is never on screen to select.
          return inlineText(node.content)
        case 'image':
          return node.alt
      }
    })
    .join('')
}

/**
 * What the browser does to whitespace in a `white-space: normal` element: runs
 * of spaces, tabs and newlines become one space.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
