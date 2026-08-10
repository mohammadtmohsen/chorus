import { CodeRun } from './CodeRun.js'
import { memo, useMemo } from 'react'
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

export function MarkdownView({ source }: { source: string }): React.JSX.Element {
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
    <>
      {blocks.map((raw, i) => (
        <MemoBlock key={i} source={raw} />
      ))}
    </>
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
      return (
        <p className="md-p">
          <InlineRun content={block.content} />
        </p>
      )

    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5'
      return (
        <Tag className="md-h">
          <InlineRun content={block.content} />
        </Tag>
      )
    }

    case 'code':
      return (
        <pre className="md-code">
          {block.language !== null && <span className="md-lang">{block.language}</span>}
          <code>
            <CodeRun code={block.text} language={block.language} />
          </code>
        </pre>
      )

    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'md-task'}>
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
        <blockquote className="md-quote">
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
                  <th key={i} style={alignStyle(block.align[i])}>
                    <InlineRun content={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={alignStyle(block.align[c])}>
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
  return (
    <>
      {content.map((node, i) => {
        switch (node.kind) {
          case 'text':
            return <span key={i}>{node.text}</span>
          case 'code':
            return (
              <code key={i} className="md-inline-code">
                {node.text}
              </code>
            )
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
