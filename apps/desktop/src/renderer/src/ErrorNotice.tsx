import { useTranslation } from 'react-i18next'

/**
 * A failure you can put away.
 *
 * The banner existed already; what it never had was a way out. The pane's copy
 * is the worse of the two — nothing anywhere sets that error back to null, so a
 * single refused click left a red bar pinned above the transcript for the life
 * of the session, describing something that had stopped being true seconds
 * later. Reported from a screenshot where the message under it was the next
 * thing the user had gone on to do.
 *
 * A component rather than an `×` added twice, because the two call sites are in
 * different files and the one thing worse than a banner with no close button is
 * two that behave differently.
 *
 * `role="alert"` stays on the paragraph, so the message is still announced when
 * it appears. The button is labelled rather than titled alone: a bare `×` is
 * read out as "times" by a screen reader, which is not what it does.
 */
export function ErrorNotice({
  message,
  onDismiss,
  className,
}: {
  message: string
  onDismiss: () => void
  /** Extra classes for a caller that positions it — `notice--workspace`. */
  className?: string | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <p
      className={['notice', 'notice--bad', ...(className === undefined ? [] : [className])].join(
        ' '
      )}
      role="alert"
    >
      <span className="notice-message">{message}</span>
      <button
        type="button"
        className="notice-close"
        aria-label={t('notice.dismiss')}
        title={t('notice.dismiss')}
        onClick={onDismiss}
      >
        {/* Decorative: the button's accessible name carries the meaning. */}
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </p>
  )
}
