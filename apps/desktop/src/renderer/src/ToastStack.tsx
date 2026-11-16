import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { requiresExplicitUserDecision } from '@chorus/agent-protocol'
import { questionFields } from '../../shared/question-text.js'
import { summarize } from './transcript.js'
import { dismissToast, NOTICE_KEY, toastKey, toasts as toastSignal } from './toasts.js'
import { useSignal } from './workspace/signal.js'
import { useShellOverlayActive } from './workspace/overlay.js'
import { useToastWindow } from './useToastWindow.js'

export interface ToastMessage {
  readonly key: string
  readonly text: string
  readonly tone: 'bad' | 'status'
  readonly onDismiss: (() => void) | null
}

export function ToastStack({
  messages,
}: {
  readonly messages: readonly ToastMessage[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const shown = useSignal(toastSignal)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const inFlight = useRef<Set<string>>(new Set())
  const overlayActive = useShellOverlayActive()
  const dismissAll = useCallback(() => {
    toastSignal.set([])
  }, [])
  const { host, anchor, stack } = useToastWindow(
    (shown.length > 0 || messages.length > 0) && !overlayActive,
    dismissAll
  )

  const cards = (
    <div
      className="toast-stack"
      ref={stack}
      style={
        host === null
          ? undefined
          : { position: 'relative', top: 0, right: 0, width: '100%', maxHeight: 'inherit' }
      }
    >
      {messages.map((message) => (
        <div
          className={`toast toast--${message.tone}`}
          key={message.key}
          role={message.tone === 'bad' ? 'alert' : 'status'}
        >
          <div className="toast-head">
            <span className="toast-message">{message.text}</span>
            {message.onDismiss !== null && (
              <button
                type="button"
                className="toast-close"
                aria-label={t('notify.dismiss')}
                onClick={message.onDismiss}
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
      {shown.map((toast) => {
        const key = toastKey(toast)
        const held = busy.has(key)

        const hold = (): void => {
          inFlight.current.add(key)
          setBusy((current) => new Set([...current, key]))
        }
        const release = (): void => {
          inFlight.current.delete(key)
          setBusy((current) => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
        }

        const decide = (
          approvalId: string,
          outcome: 'allow' | 'deny',
          scope: 'once' | 'session'
        ): void => {
          if (inFlight.current.has(key)) return
          hold()
          void window.chorus
            .decideApproval({
              conversationId: toast.conversationId,
              agentId: toast.agentId,
              approvalId,
              outcome,
              scope,
            })
            .then(release, release)
        }

        const answer = (userInputId: string, questionId: string, value: string): void => {
          if (inFlight.current.has(key)) return
          hold()
          void window.chorus
            .answerQuestion({
              conversationId: toast.conversationId,
              agentId: toast.agentId,
              userInputId,
              outcome: 'answered',
              answers: [{ questionId, values: [value] }],
            })
            .then(release, release)
        }

        const reply = (): void => {
          if (inFlight.current.has(key)) return
          const text = (drafts[key] ?? '').trim()
          if (text === '') return
          hold()
          void window.chorus.sendMessage({ conversationId: toast.conversationId, text }).then(
            () => {
              setDrafts((current) => ({ ...current, [key]: '' }))
              release()
            },
            () => {
              release()
            }
          )
        }

        const open = (): void => {
          dismissToast(key)
          void window.chorus
            .revealConversation({
              projectId: toast.projectId,
              conversationId: toast.conversationId,
            })
            .catch(() => undefined)
        }

        const asked = toast.reason === 'question' ? questionFields(toast.request) : []
        const single = asked.length === 1 ? asked[0] : undefined
        const choosable =
          single !== undefined &&
          !single.multiSelect &&
          !single.isSecret &&
          single.options.length > 0
            ? single
            : undefined

        return (
          <div
            className={`toast toast--${toast.reason} voice--${toast.agentId}`}
            key={key}
            role="status"
          >
            <div className="toast-head">
              <span className="toast-title">
                {t(NOTICE_KEY[toast.reason], { agent: toast.agentId })}
              </span>
              <button
                type="button"
                className="toast-close"
                aria-label={t('notify.dismiss')}
                onClick={() => {
                  dismissToast(key)
                }}
              >
                ×
              </button>
            </div>
            <span className="toast-room">{toast.title}</span>

            {toast.reason === 'approval' && (
              <span className="toast-subject">
                {summarize({ kind: toast.kind, request: toast.request })}
              </span>
            )}

            {toast.reason === 'approval' && (
              <div className="toast-actions">
                <button
                  type="button"
                  className="btn btn--go"
                  disabled={held}
                  onClick={() => {
                    decide(toast.approvalId, 'allow', 'once')
                  }}
                >
                  {t('approval.allowOnce')}
                </button>
                {toast.kind !== 'fileChange' && !requiresExplicitUserDecision(toast.kind) && (
                  <button
                    type="button"
                    className="btn"
                    disabled={held}
                    onClick={() => {
                      decide(toast.approvalId, 'allow', 'session')
                    }}
                  >
                    {t('approval.allowAlways')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={held}
                  onClick={() => {
                    decide(toast.approvalId, 'deny', 'once')
                  }}
                >
                  {t('approval.deny')}
                </button>
                <button type="button" className="btn" onClick={open}>
                  {t('notify.open')}
                </button>
              </div>
            )}

            {choosable !== undefined && toast.reason === 'question' && (
              <div className="toast-actions">
                {choosable.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="btn"
                    disabled={held}
                    onClick={() => {
                      answer(toast.userInputId, choosable.id, option.label)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
                <button type="button" className="btn" onClick={open}>
                  {t('notify.open')}
                </button>
              </div>
            )}

            {toast.reason === 'question' && choosable === undefined && (
              <div className="toast-actions">
                <button type="button" className="btn" onClick={open}>
                  {t('notify.open')}
                </button>
              </div>
            )}

            {toast.reason === 'idle' && (
              <div className="toast-actions">
                <input
                  className="toast-reply"
                  type="text"
                  aria-label={t('notify.replyPlaceholder')}
                  placeholder={t('notify.replyPlaceholder')}
                  value={drafts[key] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value
                    setDrafts((current) => ({ ...current, [key]: value }))
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') reply()
                  }}
                />
                <button type="button" className="btn btn--go" disabled={held} onClick={reply}>
                  {t('notify.send')}
                </button>
                <button type="button" className="btn" onClick={open}>
                  {t('notify.open')}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  return (
    <>
      <div
        className="toast-stack"
        ref={anchor}
        aria-hidden="true"
        style={{ visibility: 'hidden', pointerEvents: 'none' }}
      />
      {host === null ? cards : createPortal(cards, host)}
    </>
  )
}
