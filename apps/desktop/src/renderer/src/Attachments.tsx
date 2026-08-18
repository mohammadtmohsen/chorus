import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialog } from './useDialog.js'

export interface Attachment {
  readonly path: string
  readonly name: string
  readonly bytes: number
  /** Null for anything that is not a showable image. */
  readonly dataUrl: string | null
}

/**
 * How much of the stem survives in a tile's caption.
 *
 * Five, and it was measured rather than picked: the caption may not be wider
 * than the tile, and at 9px the tile fits about eleven characters. Seven put
 * `1787033….png` in a 56px box, CSS ellipsis took the overflow, and the caption
 * rendered `178703…` — the extension cut off after all, which is the exact
 * failure this function exists to prevent. If `--thumb` changes, re-measure.
 */
const STEM = 5

/**
 * The name, cut down to a glance, with the extension kept.
 *
 * Pasted images arrive as `1787033349300-3-image.png` — a millisecond timestamp
 * nobody reads. Left to CSS, `text-overflow: ellipsis` keeps the front and so
 * throws away the only readable part; every pasted screenshot then captions as
 * `17870333…`, which is both unreadable *and* identical to the one beside it.
 *
 * The picture is what identifies the file now that the thumbnail is large
 * enough to show it. The caption's remaining job is to say what *kind* of thing
 * this is, so the extension is what is protected and the stem is what is cut.
 * The full name is still on `title`, and the path under it.
 */
export function shortName(name: string): string {
  const dot = name.lastIndexOf('.')
  // `dot > 0` rather than `!== -1`: a dotfile's leading dot is not an extension,
  // so `.env` keeps its whole name instead of captioning as an empty stem.
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return stem.length > STEM ? `${stem.slice(0, STEM)}…${ext}` : name
}

/**
 * One tile: the picture, its caption, and whatever the caller lets you do to it.
 *
 * **A square tile rather than a pill**, and the change is about the picture
 * rather than the shape. At 22px in a round crop the thumbnail showed a few
 * dozen pixels from the middle of a screenshot — for a dark one, an empty
 * circle — so the chip was in practice a filename with a dot in front of it,
 * which is the state the thumbnail existed to fix. A square is also the honest
 * frame: images are rectangles, and a circle crops the corners of every one.
 *
 * So the tile is the picture, and the name is a caption under it rather than
 * the main event.
 *
 * Its own component because the same tile appears in two places — above the box
 * while it is still a draft, and inside the message once it has been sent — and
 * those must not drift apart. What differs is only whether there is a ✕, which
 * is `onRemove` being there or not: a sent message cannot have its attachment
 * taken back, because the agent already has the path.
 */
export function AttachmentTile(props: {
  item: Attachment
  onOpen: (item: Attachment) => void
  onRemove?: (path: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { item, onRemove } = props
  return (
    <span className="attachment">
      {item.dataUrl === null ? (
        <span className="attachment-file" aria-hidden="true">
          ◆
        </span>
      ) : (
        <button
          type="button"
          className="attachment-thumb"
          title={t('attachments.view', { name: item.name })}
          onClick={() => {
            props.onOpen(item)
          }}
        >
          <img src={item.dataUrl} alt={item.name} />
        </button>
      )}
      <span className="attachment-name" title={`${item.name}\n${item.path}`}>
        {shortName(item.name)}
      </span>
      {onRemove !== undefined && (
        <button
          type="button"
          className="attachment-remove"
          aria-label={t('attachments.remove', { name: item.name })}
          title={t('attachments.remove', { name: item.name })}
          onClick={() => {
            onRemove(item.path)
          }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </span>
  )
}

/**
 * What is about to be sent, above the box you are typing in.
 *
 * A path in the draft was honest and unreadable — you could not tell a
 * screenshot from a log without reading the filename, and could not tell whether
 * you had grabbed the right screenshot at all. A thumbnail answers both.
 *
 * The path is still what the agent receives. This is only how it looks while it
 * is yours — and, since `SentAttachments`, how it looks afterwards too.
 */
export function Attachments(props: {
  items: readonly Attachment[]
  onRemove: (path: string) => void
}): React.JSX.Element | null {
  const [viewing, setViewing] = useState<Attachment | null>(null)

  if (props.items.length === 0) return null

  return (
    <div className="attachments">
      {props.items.map((item) => (
        <AttachmentTile key={item.path} item={item} onOpen={setViewing} onRemove={props.onRemove} />
      ))}

      {viewing?.dataUrl != null && (
        <Viewer
          item={viewing}
          onClose={() => {
            setViewing(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * The image, as large as the window allows.
 *
 * Its own dialog rather than an inline expansion: a picture you are checking is
 * the only thing you are doing, and the transcript underneath is not competing
 * for the space.
 */
export function Viewer(props: { item: Attachment; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onClose)

  useEffect(() => {
    // Clicking the backdrop is the other way out; Escape is handled by useDialog.
  }, [])

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <section
        ref={dialog}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={props.item.name}
      >
        <img src={props.item.dataUrl ?? ''} alt={props.item.name} />
        <footer className="viewer-foot">
          <span className="hint" title={props.item.path}>
            {props.item.name}
          </span>
          <button type="button" className="btn btn--go" onClick={props.onClose}>
            {t('attachments.done')}
          </button>
        </footer>
      </section>
    </div>
  )
}
