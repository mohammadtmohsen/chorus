import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IdeContextPush } from '../../shared/ipc.js'
import { quotePath } from './attach.js'
import { Attachments, type Attachment } from './Attachments.js'
import { formatContextBlock, withEditorContext } from './editor-context.js'
import {
  applyMention,
  findMentionQuery,
  mentionOptions,
  type MentionQuery,
} from './mention-menu.js'
import { withQuote } from './quote.js'

/**
 * The box you type into, and everything that decides what leaves it.
 *
 * Lifted out of `Session`, which was 1,653 lines with the composer's concerns —
 * the mention menu, attachments, the editor pill, submit — interleaved with the
 * transcript's: scroll following, turn pinning, the room made for a pinned
 * question. Two subjects sharing twenty-five pieces of state, where every
 * keystroke re-rendered the whole transcript because the draft lived beside it.
 *
 * It now does not. `draft` and `attached` are held here, so typing repaints a
 * textarea rather than a conversation, and the pane reads them back only when it
 * needs them — on unmount, for the carry.
 *
 * The seam is deliberately narrow: three imperative calls in (focus, quote,
 * attach), two notifications out, and one read. Anything wider and this is the
 * same file with a different name.
 */

export interface ComposerHandle {
  /** The pane focuses the box after approvals, drops, and its own mount. */
  focus: () => void
  /** Puts a passage from the transcript in the draft, as the quote offer does. */
  quote: (passage: string) => void
  /** A drop lands on the whole pane, not on the box. */
  attach: (items: DataTransfer) => Promise<void>
}

/** What the pane has to carry across an unmount on the composer's behalf. */
export interface ComposerState {
  draft: string
  attached: Attachment[]
  ideIncluded: boolean
}

export interface ComposerProps {
  readonly conversationId: string
  readonly participants: readonly string[]
  /** Drives whether the one button offers Send or Stop. */
  readonly busy: boolean
  readonly working: readonly string[]
  /** What VS Code is showing for this pane's project. Metadata only. */
  readonly ide: IdeContextPush | null
  readonly initial?: {
    readonly draft?: string
    readonly attached?: readonly Attachment[]
    readonly ideIncluded?: boolean
  }
  /**
   * Where to leave the draft, written on every render.
   *
   * A ref the *pane* owns, rather than something read back through the handle
   * on the way out: React detaches a child's ref before the parent's cleanup
   * runs, so by the time the pane wants the draft the handle is already null.
   * The e2e caught exactly that — a backgrounded tab came back empty.
   *
   * Assigning during render is the same thing the pane does for its own carry,
   * and it is what keeps a keystroke from re-rendering a conversation.
   */
  readonly report: { current: ComposerState }
  readonly onError: (error: unknown) => void
  /** A message is on its way: follow the transcript and say we are waiting. */
  readonly onSending: () => void
  /** It never left, so nothing is coming and the waiting row must go. */
  readonly onSendFailed: () => void
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref): React.JSX.Element {
    const { t } = useTranslation()
    const { conversationId, participants } = props

    const [draft, setDraft] = useState(props.initial?.draft ?? '')
    const [attached, setAttached] = useState<Attachment[]>([...(props.initial?.attached ?? [])])
    const [ideIncluded, setIncluded] = useState(props.initial?.ideIncluded ?? true)
    const [mention, setMention] = useState<MentionQuery | null>(null)
    const [highlighted, setHighlighted] = useState(0)
    const input = useRef<HTMLTextAreaElement | null>(null)

    const hasDraft = draft.trim() !== '' || attached.length > 0
    props.report.current = { draft, attached, ideIncluded }

    useEffect(() => {
      /*
       * The box grows with what is in it, up to a ceiling set in CSS.
       *
       * Collapsed to `auto` first: `scrollHeight` is the content height *or* the
       * current box height, whichever is larger, so without the reset the field
       * would grow and never shrink back.
       */
      const el = input.current
      if (el === null) return
      el.style.height = 'auto'
      el.style.height = `${String(el.scrollHeight)}px`
    }, [draft])

    /** Identifies one mention being typed, so a refresh can tell it from the next. */
    const queryKey = useRef<string | null>(null)
    /** The query Escape dismissed; it stays shut until you type a different one. */
    const dismissed = useRef<string | null>(null)

    /**
     * Re-reads the caret after any edit or cursor move.
     *
     * Runs on every keystroke *and* every selection change, so it has to be able
     * to tell "the same mention as a moment ago" from a new one — otherwise it
     * resets the highlight under an arrow key, and re-opens a menu that Escape
     * just closed. Both happened.
     */
    const refreshMention = useCallback(() => {
      const el = input.current
      if (el === null) return
      const found = findMentionQuery(el.value, el.selectionStart)
      const key = found === null ? null : `${String(found.start)}:${found.query}`

      if (key !== queryKey.current) {
        queryKey.current = key
        setHighlighted(0)
      }
      if (key !== null && key === dismissed.current) {
        setMention(null)
        return
      }
      dismissed.current = null
      setMention(found)
    }, [])

    const options = mention === null ? [] : mentionOptions(participants as never, mention.query)
    const menuOpen = options.length > 0

    const choose = useCallback(
      (index: number) => {
        const el = input.current
        const option = options[index]
        if (el === null || mention === null || option === undefined) return
        const next = applyMention(el.value, mention, el.selectionStart, option)
        setDraft(next.text)
        setMention(null)
        // After React has written the new value, or the caret lands wherever the
        // browser last left it.
        requestAnimationFrame(() => {
          el.focus()
          el.setSelectionRange(next.caret, next.caret)
        })
      },
      [mention, options]
    )

    /**
     * Files become paths in the draft, not attachments.
     *
     * An agent reads a file the same way you would, so a drop needs no upload and
     * no change to what a message is. A clipboard image has no path — only bytes —
     * so those are written down first and the path is what you get.
     */
    const attach = useCallback(async (items: DataTransfer): Promise<void> => {
      const files = [...items.files]
      if (files.length === 0) return

      const paths = await Promise.all(
        files.map(async (file) => {
          const path = window.chorus.pathForFile(file)
          if (path !== '') return path
          // Pasted rather than dragged: it exists nowhere until we put it somewhere.
          const bytes = new Uint8Array(await file.arrayBuffer())
          let binary = ''
          for (const byte of bytes) binary += String.fromCharCode(byte)
          const stashed = await window.chorus.stashFile({
            name: file.name === '' ? 'pasted' : file.name,
            base64: btoa(binary),
          })
          return stashed.path
        })
      )

      const previews = await Promise.all(
        paths.map(async (path) => ({ path, ...(await window.chorus.previewFile({ path })) }))
      )
      setAttached((current) => [
        ...current,
        ...previews.filter((p) => !current.some((c) => c.path === p.path)),
      ])
      input.current?.focus()
    }, [])

    const ideAttached = props.ide !== null && props.ide.status === 'ready' && ideIncluded
    const { onError, onSending, onSendFailed } = props

    const send = useCallback(() => {
      /*
       * The paths join the message on the way out, not while you are writing it.
       *
       * The agent still receives text with paths in it — that has not changed —
       * but a draft is no longer a place where a screenshot looks like forty
       * characters of noise.
       */
      const paths = attached.map((item) => quotePath(item.path)).join(' ')
      const text = [draft.trim(), paths].filter((part) => part !== '').join(' ')
      if (text === '') return

      /*
       * The editor context is captured now, not when the pill was drawn.
       *
       * The pill can be a few hundred milliseconds old — it is debounced — and
       * the user may have moved the selection since. Sending what the pill said
       * would attach the wrong lines to the question, which is worse than
       * attaching none.
       */
      const compose = async (): Promise<string> => {
        if (!ideAttached) return text
        const snapshot = await window.chorus.ideSnapshot({ conversationId })
        if (snapshot.outcome !== 'ok') {
          // The draft is never lost to this. The user is told what happened and
          // decides whether to retry or send without the context.
          throw new Error(
            snapshot.outcome === 'tooLarge'
              ? t('ide.error.tooLarge')
              : t('ide.error.unavailable', { reason: t(`ide.status.${snapshot.reason}`) })
          )
        }
        const block = formatContextBlock(
          { ...snapshot },
          { heading: t('ide.heading'), unsaved: t('ide.unsaved') }
        )
        return withEditorContext(text, block)
      }

      // You just spoke; you want to see the answer.
      onSending()
      compose()
        .then(async (body) => {
          // Cleared only once the context is in hand, so a failed snapshot leaves
          // the draft and its attachments exactly as they were.
          setDraft('')
          setAttached([])
          await window.chorus.sendMessage({ conversationId, text: body })
        })
        .catch((error: unknown) => {
          // Nothing is coming: the message never left, so the row would be
          // waiting for a turn that will not start.
          onSendFailed()
          onError(error)
        })
    }, [conversationId, draft, attached, ideAttached, t, onError, onSending, onSendFailed])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => input.current?.focus(),
        quote: (passage: string) => {
          setDraft((current) => withQuote(current, passage))
          input.current?.focus()
        },
        attach,
      }),
      [attach]
    )

    const ide = props.ide

    return (
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        {ide !== null && ide.status !== 'unavailable' && (
          <div className="ide-pill" data-status={ide.status}>
            <span className="ide-pill-what">
              {ide.status === 'ready' && ide.file !== null
                ? `${ide.file.relativePath}:${String(ide.file.startLine)}${
                    ide.file.isEmpty || ide.file.startLine === ide.file.endLine
                      ? ''
                      : `-${String(ide.file.endLine)}`
                  }`
                : t(`ide.status.${ide.status}`)}
            </span>
            {ide.status === 'ready' && (
              <button
                type="button"
                className="ide-pill-toggle"
                aria-pressed={ideIncluded}
                title={ideIncluded ? t('ide.exclude') : t('ide.include')}
                onClick={() => {
                  // Once excluded it stays excluded: a live selection change
                  // must never silently re-enable context the user turned off.
                  setIncluded((on) => !on)
                }}
              >
                {ideIncluded ? t('ide.on') : t('ide.off')}
              </button>
            )}
          </div>
        )}
        {menuOpen && (
          <ul className="mention-menu" id={`mentions-${conversationId}`} role="listbox">
            {options.map((option, i) => (
              <li key={option.label}>
                <button
                  type="button"
                  className="mention-option"
                  role="option"
                  aria-selected={i === highlighted}
                  data-on={i === highlighted}
                  // Pointer down, not click: the textarea blurs on click and
                  // the menu would be gone before the choice registered.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(i)
                  }}
                  onMouseEnter={() => {
                    setHighlighted(i)
                  }}
                >
                  <span className="mention-dots" aria-hidden="true">
                    {option.agents.map((agent) => (
                      <span key={agent} className={`voice-dot voice--${agent}`} />
                    ))}
                  </span>
                  <span className="mention-name">@{option.label}</span>
                  <span className="mention-detail">{option.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Attachments
          items={attached}
          onRemove={(path) => {
            setAttached((current) => current.filter((item) => item.path !== path))
          }}
        />
        {/*
        The box and the one control that acts on it, side by side.

        Send sat under the field while the row beneath still held six other
        controls; with those gone it was a button alone on a line of its
        own. Aligned to the bottom rather than the middle, because the field
        grows with what is typed into it and the button should stay where
        the last line is.
      */}
        <div className="composer-line">
          <textarea
            ref={input}
            value={draft}
            rows={1}
            aria-label={t('conversation.messageLabel')}
            placeholder={
              participants.length === 0
                ? t('conversation.nobodyHere')
                : t('conversation.placeholder')
            }
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={`mentions-${conversationId}`}
            aria-autocomplete="list"
            onChange={(e) => {
              setDraft(e.target.value)
              refreshMention()
            }}
            onSelect={refreshMention}
            onPaste={(e) => {
              // Text pastes as text; anything else becomes a path.
              if (e.clipboardData.files.length === 0) return
              e.preventDefault()
              void attach(e.clipboardData)
            }}
            onBlur={() => {
              setMention(null)
            }}
            onKeyDown={(e) => {
              /*
               * The menu takes the keys it needs first — Enter in particular.
               * Sending the message when the user meant to pick a name is the
               * failure this whole feature exists to prevent.
               */
              if (menuOpen) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : options.length - 1
                  setHighlighted((current) => (current + step) % options.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  choose(highlighted)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  dismissed.current = queryKey.current
                  setMention(null)
                  return
                }
              }
              if (e.key !== 'Enter') return
              // Mid-composition Enter commits the candidate — for Japanese,
              // Chinese or Korean input that keypress belongs to the IME, not
              // to us, and sending there would swallow the word being typed.
              if (e.nativeEvent.isComposing) return
              // Shift holds the line; every other Enter sends. Cmd and Ctrl keep
              // working because that is what they did before.
              if (e.shiftKey) return
              e.preventDefault()
              send()
            }}
          />
          {/*
          Everything about the session sits in the composer's own row.

          A separate strip above the transcript put who is here, where they
          are and what they may do at the top of the pane, while the thing you
          act with was at the bottom — so changing permissions meant crossing
          the whole transcript. Here it is all one place, and the keyboard hint
          that used to live in this row is gone: ↵ sends is the convention, and
          saying so forever is a label for the first minute.
        */}
          <div className="composer-tools">
            {/*
            One button, and what it does is decided by what you have typed.

            Sending mid-turn steers rather than restarts — the message reaches
            the running turn and the agent takes it in, verified against a
            real one — so Send and Stop are not the opposed pair they look
            like. Which leaves a rule simple enough to need no label: if there
            is something in the box the button sends it, and if there is not,
            the only thing left to want is to stop what is running.

            That also settles what the pair got wrong in both directions. One
            button that *became* Stop hid the way to steer and abandoned the
            turn when pressed; two buttons side by side asked which is which
            every time. Glyphs rather than words, because a label would crowd
            the text being written; the names live on `aria-label`.
          */}
            {props.busy && !hasDraft ? (
              <button
                type="button"
                className="send send--stop"
                aria-label={t('conversation.stopAll', { agents: props.working.join(', ') })}
                title={t('conversation.stopAll', { agents: props.working.join(', ') })}
                onClick={() => {
                  window.chorus.interrupt({ conversationId }).catch(onError)
                }}
              >
                <span className="send-square" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                aria-label={props.busy ? t('conversation.steer') : t('conversation.send')}
                title={props.busy ? t('conversation.steer') : undefined}
                disabled={!hasDraft || participants.length === 0}
              >
                <span aria-hidden="true">↑</span>
              </button>
            )}
          </div>
        </div>
      </form>
    )
  }
)
