import { CodeRun } from './CodeRun.js'
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { shortenCodeSpan } from './shorten.js'
import {
  isFileHref,
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

/**
 * How to open a file this message links to, when there is a way.
 *
 * A context for the same reason as `ShortenCode`: the only consumer is one arm
 * of `InlineRun`, at the bottom of a recursion that can nest a link inside a
 * list item inside a table cell. Undefined where a caller has no opener, and
 * the link then draws as plain words — a path nobody can act on should not
 * pretend to be pressable.
 */
const OpenFile = createContext<((path: string) => void) | undefined>(undefined)

export function MarkdownView({
  source,
  shortenCode = false,
  onOpenFile,
}: {
  source: string
  shortenCode?: boolean
  /** Opens a project file in the editor. Main resolves and refuses outside cwd. */
  onOpenFile?: ((path: string) => void) | undefined
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
      <OpenFile.Provider value={onOpenFile}>
        {blocks.map((raw, i) => (
          <MemoBlock key={i} source={raw} />
        ))}
      </OpenFile.Provider>
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
         * The wrapper exists so the corner controls are not inside the scroller.
         *
         * `.md-code` is `overflow-x: auto`, and an absolutely positioned child of
         * a scroll container scrolls with its content — the language label used
         * to slide off the right edge of a wide block and disappear. Anchoring
         * the tools to a static sibling wrapper instead pins them to the block,
         * which is what "top right" has to mean for a block you can scroll.
         */
        <div className="md-code-wrap">
          <div className="md-code-tools">
            {block.language !== null && <span className="md-lang">{block.language}</span>}
            <CopyCode text={block.text} />
          </div>
          {/*
           * Code never flips, whatever the prose around it does.
           *
           * `dir="ltr"` explicitly rather than by inheritance: a fenced block
           * inside a right-to-left answer would otherwise take that direction and
           * move its punctuation — `);` to the left of the line, a leading `-` in
           * a diff to the right — which is code that no longer says what it says.
           */}
          <pre className="md-code" dir="ltr">
            <code>
              <CodeRun code={block.text} language={block.language} />
            </code>
          </pre>
        </div>
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

/**
 * Copies a fenced block's source, and says so for a moment.
 *
 * Through the bridge rather than `navigator.clipboard`: `security.ts` answers
 * every renderer permission request with `false`, and the preload is sandboxed
 * where Electron withholds the `clipboard` module — main is the only side that
 * can write. `window.chorus` is touched in the handler and nowhere else, so this
 * still renders under `renderToStaticMarkup`, which has no bridge at all.
 *
 * The state flips only after main has confirmed. A tick that appears on the
 * click would claim a copy happened whether or not one did, and a clipboard the
 * user cannot see is exactly the case where a lie is not discovered until they
 * paste.
 */
function CopyCode({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  /*
   * The timer is held so unmounting clears it. Only the active tab of a pane is
   * mounted, so switching tab within the confirmation window unmounts this
   * button mid-flight — and a `setState` after that is a React warning plus a
   * leak per code block, of which a long transcript has hundreds.
   */
  const revert = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(revert.current)
    },
    []
  )

  const label = copied ? t('conversation.copied') : t('conversation.copyCode')
  return (
    <button
      type="button"
      className="md-copy"
      aria-label={label}
      title={label}
      data-copied={copied ? '' : undefined}
      onClick={() => {
        window.chorus
          .copyText({ text })
          .then(() => {
            setCopied(true)
            clearTimeout(revert.current)
            revert.current = setTimeout(() => {
              setCopied(false)
            }, 1600)
          })
          .catch(() => {
            // Nothing to say and nowhere to say it: the button stays on "Copy",
            // which is the truth. A toast for a failed clipboard write would be
            // more interruption than the failure is worth.
          })
      }}
    >
      {/* `aria-hidden`: the button's name carries the meaning, and a decorative
          glyph announced beside it is just noise. */}
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {copied ? (
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
          </>
        )}
      </svg>
    </button>
  )
}

/** The value comes from a closed union, so there is nothing to sanitize. */
function alignStyle(align: Align | undefined): React.CSSProperties | undefined {
  return align === undefined || align === null ? undefined : { textAlign: align }
}

function InlineRun({ content }: { content: readonly Inline[] }): React.JSX.Element {
  const shorten = useContext(ShortenCode)
  const openFile = useContext(OpenFile)
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
          case 'link': {
            /*
             * A path goes to the editor, never to a browser.
             *
             * Agents link project files constantly, and until `isFileHref`
             * existed every one of them rendered as its own source — brackets,
             * parens and all — because a relative path has no scheme to be
             * "safe". They are links now, and pressing one calls `onOpenFile`,
             * which main resolves against this conversation's directory and
             * refuses outside it.
             *
             * A button rather than an anchor, for the reason the tool rows give:
             * there is no URL here, and an `href` that goes nowhere is a link
             * that cannot be middle-clicked, copied or trusted. Without an
             * opener it is words, not a control.
             */
            if (isFileHref(node.href)) {
              return openFile === undefined ? (
                <span key={i}>
                  <InlineRun content={node.content} />
                </span>
              ) : (
                <button
                  key={i}
                  type="button"
                  className="md-file-link"
                  data-open-file={node.href}
                  title={node.href}
                  onClick={() => {
                    openFile(node.href)
                  }}
                >
                  <InlineRun content={node.content} />
                </button>
              )
            }
            // The main process denies in-app navigation and hands https links to
            // the OS browser, so this cannot navigate the renderer anywhere.
            return (
              <a key={i} href={node.href} rel="noreferrer noopener" target="_blank">
                <InlineRun content={node.content} />
              </a>
            )
          }
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
