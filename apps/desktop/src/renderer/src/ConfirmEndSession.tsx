import { useTranslation } from 'react-i18next'
import { useDialog } from './useDialog.js'

/**
 * The question asked before a conversation is ended with something still in it.
 *
 * **Asked only when there is something to lose**, which is the same rule
 * `ConfirmRestart` states and the reason either is worth asking at all. Ending a
 * quiet conversation loses nothing: the log is append-only and the transcript
 * stays in History. Three things are not quiet, and each is unrecoverable in its
 * own way — a turn in flight is discarded, a decision nobody answered is a room
 * that was waiting on a person, and a draft is text that exists nowhere else.
 *
 * **Naming what would be lost is the content.** "Are you sure?" is not
 * information. "Claude is mid-turn" is the sentence that decides the answer —
 * the argument `ConfirmKillTerminal` makes about a foreground process, and the
 * reason all three of these dialogs are shaped alike. Three destructive
 * confirmations that looked different would be three things to learn.
 *
 * One line per reason rather than a composed sentence: a translator gets whole
 * sentences to work with, and two reasons at once read as two facts rather than
 * as a clause somebody has to unpick.
 */
export interface ConfirmEndSessionProps {
  readonly project?: boolean
  /** Who is mid-turn, already joined for reading. Empty when nobody is. */
  readonly working: string
  /** Approvals and questions nobody has answered. */
  readonly decisions: number
  /** Whether the composer holds text that was never sent. */
  readonly draft: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmEndSession(props: ConfirmEndSessionProps): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onCancel)
  const title = t(
    props.project === true ? 'workspace.confirmCloseProjectTitle' : 'conversation.confirmEndTitle'
  )

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet sheet--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="confirm-title">{title}</h2>
        {props.project === true && (
          <p className="confirm-body">{t('workspace.confirmCloseProjectHint')}</p>
        )}
        {props.working !== '' && (
          <p className="confirm-body">
            {t('conversation.confirmEndWorking', { agents: props.working })}
          </p>
        )}
        {props.decisions > 0 && (
          <p className="confirm-body">
            {t('conversation.confirmEndDecisions', { count: props.decisions })}
          </p>
        )}
        {props.draft && <p className="confirm-body">{t('conversation.confirmEndDraft')}</p>}
        <div className="sheet-actions confirm-actions">
          {/*
            Cancel first in the DOM, so it is what `useDialog` focuses on open
            and what Enter takes. The destructive choice should never be the one
            a reflex lands on — the same ordering, and the same reason, as
            `ConfirmRestart`.
          */}
          <button type="button" onClick={props.onCancel}>
            {t('conversation.confirmEndCancel')}
          </button>
          <button type="button" className="confirm-go confirm-go--danger" onClick={props.onConfirm}>
            {t(
              props.project === true ? 'workspace.confirmCloseProject' : 'conversation.confirmEnd'
            )}
          </button>
        </div>
      </section>
    </div>
  )
}
