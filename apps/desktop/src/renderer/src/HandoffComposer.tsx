import { useEffect, useState } from 'react'
import { useDialog } from './useDialog.js'
import { useTranslation } from 'react-i18next'

type AgentId = 'codex' | 'claude'
type Intent = 'implement' | 'review' | 'discuss'

/** Agents are named, not identified — copy should read like a sentence. */
const NAME: Record<AgentId, string> = { codex: 'Codex', claude: 'Claude' }

export interface HandoffDraft {
  readonly from: AgentId
  readonly to: AgentId
  readonly sourceEventIds: string[]
}

/**
 * Shows exactly what will cross to the other agent, and lets the user change it
 * before it does.
 *
 * This is the whole point of the feature, not a confirmation step. Agents keep
 * separate contexts, so this packet *is* what the receiving agent will know —
 * sending it unseen would make Chorus decide that on the user's behalf, which
 * the "explicit context sharing" principle exists to prevent (plan §4.5).
 */
export function HandoffComposer({
  conversationId,
  draft,
  onClose,
  onSent,
  onError,
}: {
  conversationId: string
  draft: HandoffDraft
  onClose: () => void
  onSent: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [intent, setIntent] = useState<Intent>('implement')
  const [includeDiff, setIncludeDiff] = useState(false)
  const [note, setNote] = useState('')
  const [brief, setBrief] = useState('')
  const [edited, setEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const dialog = useDialog<HTMLElement>(onClose)

  // Recompose whenever an input changes — unless the user has taken over the
  // text, in which case overwriting their edit would be the rudest possible
  // behaviour.
  useEffect(() => {
    if (edited) return
    window.chorus
      .prepareHandoff({
        conversationId,
        from: draft.from,
        to: draft.to,
        sourceEventIds: draft.sourceEventIds,
        includeDiff,
        intent,
        note,
      })
      .then((result) => {
        setBrief(result.brief)
      })
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
  }, [conversationId, draft, edited, includeDiff, intent, note, onError])

  const send = (): void => {
    setBusy(true)
    window.chorus
      .sendHandoff({
        conversationId,
        from: draft.from,
        to: draft.to,
        sourceEventIds: draft.sourceEventIds,
        brief,
      })
      .then(onSent)
      .catch((e: unknown) => {
        onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('handoff.heading')}
      >
        <header className="sheet-head">
          <span className={`voice-dot voice--${draft.from}`} aria-hidden="true" />
          <strong>{t('handoff.title', { from: NAME[draft.from], to: NAME[draft.to] })}</strong>
          <span className={`voice-dot voice--${draft.to}`} aria-hidden="true" />
        </header>

        <div className="handoff-controls">
          <label className="field">
            <span>{t('handoff.intent')}</span>
            <select
              value={intent}
              onChange={(e) => {
                setIntent(e.target.value as Intent)
              }}
            >
              <option value="implement">{t('handoff.intentImplement')}</option>
              <option value="review">{t('handoff.intentReview')}</option>
              <option value="discuss">{t('handoff.intentDiscuss')}</option>
            </select>
          </label>

          <label className="checkline">
            <input
              type="checkbox"
              checked={includeDiff}
              onChange={(e) => {
                setIncludeDiff(e.target.checked)
              }}
            />
            {t('handoff.includeDiff')}
          </label>
        </div>

        <label className="field">
          <span>{t('handoff.note')}</span>
          <input
            value={note}
            placeholder={t('handoff.notePlaceholder')}
            onChange={(e) => {
              setNote(e.target.value)
            }}
          />
        </label>

        <label className="field field--grow">
          <span>{t('handoff.brief')}</span>
          <textarea
            className="handoff-brief"
            value={brief}
            rows={14}
            onChange={(e) => {
              setEdited(true)
              setBrief(e.target.value)
            }}
          />
        </label>

        <div className="sheet-actions">
          <span className="hint">
            {edited ? t('handoff.editedHint') : t('handoff.previewHint')}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t('handoff.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--go"
            onClick={send}
            disabled={busy || brief.trim() === ''}
          >
            {busy ? t('handoff.sending') : t('handoff.send', { to: NAME[draft.to] })}
          </button>
        </div>
      </section>
    </div>
  )
}
