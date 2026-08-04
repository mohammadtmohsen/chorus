import { memo, useMemo } from 'react'
import { parseMarkdown, splitBlocks, type Block, type Inline } from './markdown.js'

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
          <code>{block.text}</code>
        </pre>
      )

    case 'list':
      return block.ordered ? (
        <ol className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineRun content={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineRun content={item} />
            </li>
          ))}
        </ul>
      )

    case 'quote':
      return (
        <blockquote className="md-quote">
          <InlineRun content={block.content} />
        </blockquote>
      )
  }
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
            return <strong key={i}>{node.text}</strong>
          case 'em':
            return <em key={i}>{node.text}</em>
          case 'link':
            // The main process denies in-app navigation and hands https links to
            // the OS browser, so this cannot navigate the renderer anywhere.
            return (
              <a key={i} href={node.href} rel="noreferrer noopener" target="_blank">
                {node.text}
              </a>
            )
        }
      })}
    </>
  )
}
