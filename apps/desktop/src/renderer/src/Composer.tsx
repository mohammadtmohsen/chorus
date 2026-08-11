import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IdeContextPush } from '../../shared/ipc.js'
import { quotePath } from './attach.js'
import { Attachments, type Attachment } from './Attachments.js'
import { formatContextBlock, withEditorContext } from './editor-context.js'
import {
  applyMention,
  commandOptions,
  fileOptions,
  findCommandQuery,
  findMentionQuery,
  mentionOptions,
  type CommandInfo,
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
  /**
   * Puts text in the draft exactly as given.
   *
   * Separate from `quote`, which wraps whatever it is handed in `>` markers. An
   * aside brought forward arrives already formatted — it carries its own
   * quoting, a mention that decides routing, and a line saying where the answer
   * came from. Re-quoting all of that would bury the instruction inside the
   * evidence for it.
   */
  insert: (text: string) => void
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
  /**
   * What was said before, oldest first.
   *
   * Taken from the transcript rather than kept separately: the messages are
   * already reduced from the log, so recall survives a restart and a reopened
   * conversation for free — and there is no second list to fall out of step.
   */
  readonly history: readonly string[]
  readonly report: { current: ComposerState }
  readonly onError: (error: unknown) => void
  /** A message is on its way: follow the transcript and say we are waiting. */
  readonly onSending: () => void
  /** It never left, so nothing is coming and the waiting row must go. */
  readonly onSendFailed: () => void
}

/**
 * How often an open, unanswered menu may ask again, and how long it keeps that
 * up.
 *
 * Both menus used to ask a bounded number of times and then stop *while the
 * question was still open* — the slash list five times over nine seconds, the
 * file list exactly once — after which no amount of waiting produced anything
 * and one more keystroke produced everything (C-003). The person looking at an
 * empty menu is the signal that the answer still matters, so that is what the
 * asking is tied to now.
 *
 * **The floor is a rate limit and the gap grows past it.** 800ms is the closest
 * two asks may ever be, which is what stops an open menu spawning `git ls-files`
 * in a loop; the gap then widens by that much each time, so eight attempts span
 * about twenty-two seconds rather than six. Both numbers matter: the first
 * bounds the cost per second, the second bounds how long a genuinely stuck CLI
 * is waited on.
 *
 * Measured against the reproduction: a CLI reporting its commands at twelve
 * seconds is inside this and outside the old nine.
 */
const ASK_FLOOR_MS = 800
const ASK_CEILING = 8

export const Composer = forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref): React.JSX.Element {
    const { t } = useTranslation()
    const { conversationId, participants } = props

    const [draft, setDraft] = useState(props.initial?.draft ?? '')
    const [attached, setAttached] = useState<Attachment[]>([...(props.initial?.attached ?? [])])
    const [ideIncluded, setIncluded] = useState(props.initial?.ideIncluded ?? true)
    const [mention, setMention] = useState<MentionQuery | null>(null)
    /**
     * What this conversation accepts, asked once and kept.
     *
     * Per conversation because the list is the project's: its own
     * `.claude/commands`, its skills, its plugins. Fetched on mount rather than
     * when the menu opens, so the first `/` shows a list instead of a pause.
     */
    const [commands, setCommands] = useState<CommandInfo[]>([])
    /**
     * Files matching the mention being typed.
     *
     * Asked of the main process per keystroke rather than held: the renderer has
     * no filesystem access, and a project's file list is both large and liable
     * to change under you. Debounced, because a keystroke is not a question
     * worth spawning `git ls-files` for on its own.
     */
    const [files, setFiles] = useState<string[]>([])
    /**
     * Whether the menu is still waiting on an answer, and if not, why it has
     * none.
     *
     * An empty menu used to be one thing on screen and three things underneath:
     * a lookup still running, a lookup that ran out of attempts, and a directory
     * that can never answer. They rendered identically — as nothing at all,
     * because the menu only opened when it had rows — so neither a person nor a
     * spec could tell "not yet" from "never" (C-003). A spec in particular could
     * only wait, and then time out saying nothing about which it had hit.
     *
     * One field rather than one per surface: a `/` menu and an `@` menu cannot
     * be open at the same time, because `refreshMention` resolves to a single
     * query.
     */
    const [lookup, setLookup] = useState<'asking' | 'exhausted' | 'unavailable' | null>(null)
    /**
     * How far back through what was said we are, counting from the end.
     *
     * Zero is the live draft. Entered only from an empty box and left the moment
     * anything is typed, which is what keeps arrow keys meaning "move the caret"
     * in a message being written — the alternative is a draft that jumps away
     * mid-sentence.
     */
    const recalled = useRef(0)
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

    useEffect(() => {
      /*
       * One warm-up ask, so the first `/` shows a list rather than a pause.
       *
       * A pane mounts the moment its conversation exists, which is before the
       * session has finished starting, so this answer is often empty — and that
       * is now fine. It used to carry its own retry, four tries over about nine
       * seconds, because it was the only thing asking; a CLI slower than that
       * budget left the menu empty for the life of the pane.
       *
       * **It is no longer what correctness rests on.** The menu asks for itself
       * while it is open and unanswered (`ASK_FLOOR_MS` below), which is bounded
       * by someone actually waiting rather than by a guess at how long a CLI
       * takes to start. Two independent retry loops asked the same question at
       * overlapping times — measured at 243ms apart, under the floor one of them
       * was enforcing — so this went back to being what its comment always said
       * it was: a warm-up, not a guarantee.
       */
      let live = true
      window.chorus
        .listCommands({ conversationId })
        .then((result) => {
          if (live && result.commands.length > 0) setCommands(result.commands)
        })
        .catch(() => {
          // No session to ask yet, or a CLI too old to be asked. Either way the
          // menu will ask again for itself when someone opens it.
        })
      return () => {
        live = false
      }
    }, [conversationId])

    /*
     * The query itself, not the object carrying it — the same reason as
     * `wantsCommands`, and here it is also literally what is being asked. Null
     * until there is an `@` with something after it: a bare `@` means the cast,
     * and offering the whole repository beside two agent names is not a menu.
     */
    const fileQuery = mention?.trigger === '@' && mention.query !== '' ? mention.query : null
    useEffect(() => {
      if (fileQuery === null) {
        setFiles([])
        return
      }
      let live = true
      let attempts = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      setLookup('asking')
      const again = (): void => {
        if (attempts >= ASK_CEILING) {
          setLookup('exhausted')
          return
        }
        timer = setTimeout(ask, attempts * ASK_FLOOR_MS)
      }
      const ask = (): void => {
        attempts += 1
        window.chorus
          .completeFiles({ conversationId, query: fileQuery })
          .then((result) => {
            if (!live) return
            /*
             * Where the three states pay for themselves.
             *
             * `ready` is an answer even when it is empty — git looked and found
             * nothing, and asking a second time is asking the same question.
             * `unavailable` is a directory with no git or no repository in it,
             * where every retry would spawn a process to be told the same thing.
             * Only `retryable` is a question that never got put, and only that
             * one is worth putting again.
             *
             * All three used to arrive as `[]`, which is why one failed lookup
             * emptied this menu for as long as the query stayed the same.
             */
            if (result.state === 'retryable') {
              again()
              return
            }
            setLookup(result.state === 'unavailable' ? 'unavailable' : null)
            setFiles(result.files)
          })
          .catch(() => {
            // The IPC call itself failed, which says nothing about git — the one
            // thing it cannot be is an answer.
            if (live) again()
          })
      }
      // Debounced: a keystroke is not a question worth spawning `git ls-files`
      // for on its own.
      timer = setTimeout(ask, 90)
      return () => {
        live = false
        if (timer !== undefined) clearTimeout(timer)
      }
    }, [conversationId, fileQuery])

    useEffect(() => {
      /*
       * Written down a second after you stop typing.
       *
       * Not on every keystroke: `open-sessions.json` is rewritten whole, and a
       * sentence would rewrite it forty times. A second of lag costs the last
       * second of typing in a crash, which is the right trade against making the
       * file the bottleneck for the box.
       */
      const timer = setTimeout(() => {
        void window.chorus.rememberDraft({ conversationId, draft })
      }, 1_000)
      return () => {
        clearTimeout(timer)
      }
    }, [conversationId, draft])

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
      /*
       * A command first, because its rule is the narrow one.
       *
       * `/` only counts leading the message, so at most one of these can match
       * and the order is really about which question to ask first. A mention
       * can appear anywhere, including after a command's arguments.
       */
      const found =
        findCommandQuery(el.value, el.selectionStart) ??
        findMentionQuery(el.value, el.selectionStart)
      // The trigger is part of the identity: `/x` and `@x` at the same offset
      // are different menus, and Escape on one must not silence the other.
      const key = found === null ? null : `${found.trigger}${String(found.start)}:${found.query}`

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

    /*
     * And asked again the moment someone actually wants them.
     *
     * The retry above races the session's start against a clock, which is the
     * wrong shape: on a loaded machine the CLI can take longer than any window
     * worth waiting, and the menu is then empty for the life of the pane. This
     * removes the timing question instead of tuning it — a slash typed against
     * an empty list asks for one right then, because a person opening the menu
     * is the only signal that the answer matters yet.
     *
     * Guarded by `asking` so a fast typist does not queue one request per
     * keystroke, and only for `/`: the cast and the files have their own
     * sources.
     */
    /*
     * A boolean rather than the `mention` object, and that is the fix.
     *
     * `refreshMention` builds a new object on every keystroke *and* every
     * selection change, so an effect depending on `mention` restarts constantly
     * — which would reset the attempt count and defeat the rate limit. What this
     * question actually turns on is whether a slash menu is open at all; the
     * query it carries never changes the answer, because the list is the
     * conversation's rather than the query's.
     */
    const wantsCommands = mention?.trigger === '/'
    useEffect(() => {
      if (!wantsCommands || commands.length > 0) return
      let live = true
      let attempts = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      setLookup('asking')
      const again = (): void => {
        // Widening, so eight attempts cover a CLI that is slow rather than only
        // one that is late. Never closer together than the floor.
        if (attempts >= ASK_CEILING) {
          setLookup('exhausted')
          return
        }
        timer = setTimeout(ask, attempts * ASK_FLOOR_MS)
      }
      const ask = (): void => {
        attempts += 1
        window.chorus
          .listCommands({ conversationId })
          .then((result) => {
            if (!live) return
            /*
             * An empty answer is asked about again rather than accepted, and
             * this is the ambiguity the plan takes on knowingly: the adapter
             * folds "no capability", "the request threw" and "this project has
             * no commands" into the same `[]`, so the renderer cannot tell them
             * apart. Both terminal cases short-circuit inside the adapter
             * without reaching a CLI, so asking again costs an IPC round trip
             * and nothing else — bounded by the ceiling above.
             */
            if (result.commands.length === 0) {
              again()
              return
            }
            setLookup(null)
            setCommands(result.commands)
          })
          .catch(() => {
            if (live) again()
          })
      }
      ask()
      return () => {
        live = false
        if (timer !== undefined) clearTimeout(timer)
      }
    }, [wantsCommands, commands.length, conversationId])

    /*
     * Agents first, then files.
     *
     * There are two agents and thousands of files, so ordering by count would
     * bury the thing `@` originally meant. Agents also match on a prefix and
     * files on a substring, which means a bare `@` shows the cast and typing
     * anything past a name starts finding files.
     */
    /*
     * Nobody is asking, so there is nothing to report.
     *
     * Each lookup sets its own state while it runs; this is what clears it when
     * the menu closes, so a `/` that gave up does not leave `exhausted` showing
     * under the `@` typed after it.
     */
    useEffect(() => {
      if (!wantsCommands && fileQuery === null) setLookup(null)
    }, [wantsCommands, fileQuery])

    const options =
      mention === null
        ? []
        : mention.trigger === '/'
          ? commandOptions(commands, mention.query)
          : [...mentionOptions(participants as never, mention.query), ...fileOptions(files)]
    /*
     * The menu opens for a state as well as for rows.
     *
     * `options.length > 0` alone is what made an unanswered question invisible:
     * there was nothing to draw, so nothing was drawn, so waiting looked exactly
     * like having nothing to offer. A menu carrying one status line says which of
     * the two it is — and gives a spec something to assert against other than a
     * timeout (C-003).
     *
     * Only when there are no rows. An `@` that already matches an agent is not
     * improved by a "looking…" line under it while git answers in thirty
     * milliseconds.
     */
    const menuOpen = options.length > 0 || (mention !== null && lookup !== null)

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
        insert: (text: string) => {
          setDraft((current) =>
            current.trim() === '' ? text : `${current.replace(/\s+$/, '')}\n\n${text}`
          )
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
        /*
         * What the composer believes, where a failing run can read it.
         *
         * The menu's own status row says whether a lookup is running, and on the
         * first real failure after that shipped it said `no status row` —
         * nothing in flight, nothing given up. Which is genuinely useful and
         * also the end of what the menu can tell anyone: if nobody was waiting,
         * the question is what the *composer* thought was being typed, and that
         * lives in state no spec can reach (C-003).
         *
         * Two attributes rather than a debug channel, because the alternative is
         * the shape that already failed here: instrumentation added during an
         * investigation, removed when it ended, and absent the next time the bug
         * appears. These cost two strings per render and are the difference
         * between a named cause and another afternoon.
         */
        data-mention={
          mention === null ? 'none' : `${mention.trigger}${String(mention.start)}:${mention.query}`
        }
        data-commands={commands.length}
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
                  <span className="mention-name">
                    {/* A bare option inserts no trigger, so it must not show
                        one: a file row reading "@src/a.ts" would promise a
                        mention it does not write. */}
                    {option.bare === true ? '' : (mention?.trigger ?? '@')}
                    {option.label}
                  </span>
                  <span className="mention-detail">{option.detail}</span>
                </button>
              </li>
            ))}
            {options.length === 0 && lookup !== null && (
              /*
               * `data-lookup` is not decoration. A spec asserting on the visible
               * words would be asserting on a translation, and the point of this
               * row is that a run can say *which* state it ended in rather than
               * timing out with nothing to report.
               */
              <li className="mention-status" data-lookup={lookup} aria-live="polite">
                {lookup === 'asking' && t('conversation.lookingUp')}
                {lookup === 'exhausted' && t('conversation.noneFound')}
                {lookup === 'unavailable' && t('conversation.lookupUnavailable')}
              </li>
            )}
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
              /*
               * Rows, not `menuOpen` — and the difference is now load-bearing.
               *
               * The menu also opens to say it is still looking, and that menu has
               * nothing to choose. Keeping this on `menuOpen` would make
               * `% options.length` a division by zero, and worse: Enter would be
               * swallowed by `preventDefault` and choose nothing, so a message
               * beginning with `/` could not be sent at all while the list was
               * still arriving. Caught by asking what an open-but-empty menu does
               * to the keyboard, not by a test.
               */
              if (options.length > 0) {
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
              }
              /*
               * Escape closes whatever is open, rows or not.
               *
               * Deliberately outside the block above: a menu saying "looking…"
               * is still a menu in your way, and one you could not dismiss would
               * be worse than the silence it replaced.
               */
              if (menuOpen && e.key === 'Escape') {
                e.preventDefault()
                dismissed.current = queryKey.current
                setMention(null)
                return
              }
              /*
               * Up brings back what was said, but only from an empty box.
               *
               * In a draft being written the arrows have to keep moving the caret;
               * a field that jumps to last week's message because the caret
               * reached line one is worse than no recall at all. Down walks back
               * towards the empty box and stops there.
               */
              if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                props.history.length > 0 &&
                (draft === '' || recalled.current > 0)
              ) {
                const step = e.key === 'ArrowUp' ? 1 : -1
                const next = Math.min(Math.max(recalled.current + step, 0), props.history.length)
                if (next === recalled.current) return
                e.preventDefault()
                recalled.current = next
                setDraft(next === 0 ? '' : (props.history[props.history.length - next] ?? ''))
                return
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
