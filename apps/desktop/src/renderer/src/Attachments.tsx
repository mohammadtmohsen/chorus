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
 * What is about to be sent, above the box you are typing in.
 *
 * A path in the draft was honest and unreadable — you could not tell a
 * screenshot from a log without reading the filename, and could not tell whether
 * you had grabbed the right screenshot at all. A thumbnail answers both.
 *
 * The path is still what the agent receives. This is only how it looks while it
 * is yours.
 */
export function Attachments(props: {
  items: readonly Attachment[]
  onRemove: (path: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [viewing, setViewing] = useState<Attachment | null>(null)

  if (props.items.length === 0) return null

  return (
    <div className="attachments">
      {props.items.map((item) => (
        <span key={item.path} className="attachment">
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
                setViewing(item)
              }}
            >
              <img src={item.dataUrl} alt={item.name} />
            </button>
          )}
          <span className="attachment-name" title={item.path}>
            {item.name}
          </span>
          <button
            type="button"
            className="attachment-remove"
            aria-label={t('attachments.remove', { name: item.name })}
            title={t('attachments.remove', { name: item.name })}
            onClick={() => {
              props.onRemove(item.path)
            }}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </span>
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
function Viewer(props: { item: Attachment; onClose: () => void }): React.JSX.Element {
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
