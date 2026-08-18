import { CodeRun } from './CodeRun.js'
import { createContext, memo, useContext, useMemo } from 'react'
import { shortenCodeSpan } from './shorten.js'
import {
  parseMarkdown,
  splitBlocks,
  type Align,
  type Block,
  type Inline,
} from '../../shared/markdown.js'

/**
 * Renders parsed markdown as React elements.
 *
 * Named `MarkdownView` rather than `Markdown` because `markdown.ts` sits beside
 * it, and two files differing only in case collide on a case-insensitive
 * filesystem — which is every Mac by default.
 *
 * There is no `dangerouslySetInnerHTML` anywhere in this file, and there never
 * should be: agent output is untrusted, and building elements from a typed tree
 * means injection is impossible by construction rather than filtered after the
 * fact (plan §4.4).
 */

/**
 * Whether long inline references in this message are cut down for display.
 *
 * A context rather than a prop, because the only place that needs it is
 * `InlineRun`'s `code` arm and that sits at the bottom of a recursion — a link
 * inside a list item inside a table cell. Threading a display option through
 * every one of those is how the option ends up missing from one of them.
 *
 * Off by default: an agent's reply says what it says, and shortening a path in
 * an answer would be editing it. It is `Entry` that turns this on, and only for
 * your own messages, where the long references were written by Chorus.
 */
const ShortenCode = createContext(false)

export function MarkdownView({
  source,
  shortenCode = false,
}: {
  source: string
  shortenCode?: boolean
}): React.JSX.Element {
  /*
   * Split first, then memoise each block on its own text.
   *
   * Memoising the whole message does not help while streaming: the source
   * changes on every delta, so the entire message re-parses each time and cost
   * grows with its length — 17% dropped frames on a 25k-character reply.
   * Per-block memoisation means only the block being written does any work; the
   * rest keep a stable element reference that React skips reconciling.
   */
  const blocks = useMemo(() => splitBlocks(source), [source])
  return (
    <ShortenCode.Provider value={shortenCode}>
      {blocks.map((raw, i) => (
        <MemoBlock key={i} source={raw} />
      ))}
    </ShortenCode.Provider>
  )
}

/** One markdown block, re-rendered only when its own text changes. */
const MemoBlock = memo(function MemoBlock({ source }: { source: string }): React.JSX.Element {
  const parsed = useMemo(() => parseMarkdown(source), [source])
  return (
    <>
      {parsed.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </>
  )
})

function BlockView({ block }: { block: Block }): React.JSX.Element {
  switch (block.kind) {
    case 'paragraph':
      /*
       * `dir="auto"` on every block that holds prose, and it is the markup that
       * has to carry it rather than the stylesheet.
       *
       * An agent answering in Arabic produces paragraphs whose base direction is
       * right-to-left, and without this they were laid out left-to-right: the
       * sentence read correctly but its full stop sat on the wrong end, a line
       * beginning with `useMemo(` dragged the whole paragraph the wrong way, and
       * a list's bullets stayed on the left of right-to-left items.
       *
       * `auto` takes the direction from the block's own first strong character,
       * which is right for Arabic, right for English, and right for a language
       * nobody thought of — there is no locale to consult, because the language
       * is free text the user typed. Per block, so one English identifier at the
       * top of an Arabic answer cannot decide the direction of everything under
       * it.
       *
       * The attribute rather than `unicode-bidi: plaintext` alone: that sets the
       * base direction for inline layout but leaves `direction` untouched, so
       * markers, alignment and anything nested keep pointing the old way. This
       * is the one that moves the bullet.
       */
      return (
        <p className="md-p" dir="auto">
          <InlineRun content={block.content} />
        </p>
      )

    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5'
      return (
        <Tag className="md-h" dir="auto">
          <InlineRun content={block.content} />
        </Tag>
      )
    }

    case 'code':
      return (
        /*
         * Code never flips, whatever the prose around it does.
         *
         * `dir="ltr"` explicitly rather than by inheritance: a fenced block
         * inside a right-to-left answer would otherwise take that direction and
         * move its punctuation — `);` to the left of the line, a leading `-` in
         * a diff to the right — which is code that no longer says what it says.
         */
        <pre className="md-code" dir="ltr">
          {block.language !== null && <span className="md-lang">{block.language}</span>}
          <code>
            <CodeRun code={block.text} language={block.language} />
          </code>
        </pre>
      )

    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'md-task'} dir="auto">
          {item.checked !== null && (
            /*
             * Disabled rather than interactive: this is a report of what an agent
             * wrote, and a checkbox you could tick would imply the transcript is
             * editable and that something downstream would hear about it.
             */
            <input type="checkbox" checked={item.checked} disabled readOnly />
          )}
          <InlineRun content={item.content} />
          {item.children.map((child, c) => (
            <BlockView key={c} block={child} />
          ))}
        </li>
      ))
      // `start` so an ordered list that begins at `3.` is not renumbered to one.
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      )
    }

    case 'quote':
      return (
        <blockquote className="md-quote" dir="auto">
          {block.blocks.map((child, i) => (
            <BlockView key={i} block={child} />
          ))}
        </blockquote>
      )

    case 'table':
      /*
       * Wrapped in its own scroller because a table is the one block that cannot
       * wrap, and the transcript column is narrow by design. Without this a wide
       * table either stretches the pane or gets clipped by `.grid`'s
       * `overflow-x: hidden`.
       */
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} dir="auto" style={alignStyle(block.align[i])}>
                    <InlineRun content={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} dir="auto" style={alignStyle(block.align[c])}>
                      <InlineRun content={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'rule':
      return <hr className="md-hr" />
  }
}

/** The value comes from a closed union, so there is nothing to sanitize. */
function alignStyle(align: Align | undefined): React.CSSProperties | undefined {
  return align === undefined || align === null ? undefined : { textAlign: align }
}

function InlineRun({ content }: { content: readonly Inline[] }): React.JSX.Element {
  const shorten = useContext(ShortenCode)
  return (
    <>
      {content.map((node, i) => {
        switch (node.kind) {
          case 'text':
            return <span key={i}>{node.text}</span>
          case 'code': {
            /*
             * The whole value stays on `title`, and it is the only copy of it
             * on screen — what the *agent* received is untouched either way,
             * since this shortens the drawing and not the message.
             */
            const shown = shorten ? shortenCodeSpan(node.text) : node.text
            return (
              <code
                key={i}
                className="md-inline-code"
                title={shown === node.text ? undefined : node.text}
              >
                {shown}
              </code>
            )
          }
          case 'strong':
            return (
              <strong key={i}>
                <InlineRun content={node.content} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <InlineRun content={node.content} />
              </em>
            )
          case 'del':
            return (
              <del key={i}>
                <InlineRun content={node.content} />
              </del>
            )
          case 'link':
            // The main process denies in-app navigation and hands https links to
            // the OS browser, so this cannot navigate the renderer anywhere.
            return (
              <a key={i} href={node.href} rel="noreferrer noopener" target="_blank">
                <InlineRun content={node.content} />
              </a>
            )
          case 'image':
            /*
             * A link, not an `<img>`.
             *
             * `security.ts` sets `img-src 'self' data:`, so a remote image would
             * render as a broken box — and loosening that would let a model
             * beacon your IP and read receipts out of the transcript with a
             * one-pixel image. The link keeps the reference usable: it opens in
             * the OS browser like every other link here.
             */
            return (
              <a
                key={i}
                className="md-image"
                href={node.href}
                rel="noreferrer noopener"
                target="_blank"
              >
                {node.alt === '' ? node.href : node.alt}
              </a>
            )
        }
      })}
    </>
  )
}
