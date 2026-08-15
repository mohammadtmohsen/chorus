import { useTranslation } from 'react-i18next'
import { useDialog } from './useDialog.js'

/**
 * The one question asked before a shell is killed, and only when there is
 * something to lose.
 *
 * `describe()` reports `busy` as "something other than the shell itself is in
 * the foreground", so an idle `zsh` dies on the click and never reaches this.
 * Asking every time is the friction people learn to click through, which makes
 * the confirmation worthless on the one occasion it matters — a `pnpm build`
 * halfway done, an `ssh` session, a `psql` transaction.
 *
 * The process name is the whole content. "Are you sure?" is not information;
 * "`pnpm` is still running in it" is the sentence that decides the answer, and
 * it is the reason `terminal:describe` has existed unused since the original
 * plan's Phase 1.
 *
 * Shaped after `ConfirmSessionAction`, deliberately: two destructive
 * confirmations that looked different would be two things to learn.
 */
export interface ConfirmKillTerminalProps {
  /** The foreground process, as `describe()` named it. */
  readonly process: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmKillTerminal(props: ConfirmKillTerminalProps): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onCancel)
  const title = t('terminal.confirmKillTitle')

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
        <p className="confirm-body">{t('terminal.confirmKillBody', { process: props.process })}</p>
        <div className="sheet-actions confirm-actions">
          {/*
            Cancel first in the DOM, so it is what `useDialog` focuses on open and
            what Enter takes. The destructive choice should never be the one a
            reflex lands on — the same ordering, and the same reason, as
            `ConfirmSessionAction`.
          */}
          <button type="button" onClick={props.onCancel}>
            {t('terminal.confirmKillCancel')}
          </button>
          <button type="button" className="confirm-go confirm-go--danger" onClick={props.onConfirm}>
            {t('terminal.confirmKill')}
          </button>
        </div>
      </section>
    </div>
  )
}
