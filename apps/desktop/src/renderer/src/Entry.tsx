import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseDiff } from '@chorus/workspace/diff'
import { CodeRun } from './CodeRun.js'
import { useTranslation } from 'react-i18next'
import { FileDiff } from './FileDiff.js'
import { MarkdownView } from './MarkdownView.js'
import type { TranscriptMessage } from './transcript.js'
import { useTypewriter } from './useTypewriter.js'

/**
 * One entry on the score: a dot on the rail, a speaker, and what was said.
 *
 * Memoised on purpose. The transcript hands down a fresh array on every streamed
 * delta, so without this every message in the conversation re-renders for each
 * token — the cost grows with the length of the conversation rather than with
 * the size of the change. With it, only the message actually receiving text
 * re-renders (plan §4.6).
 */
/** Agents are named, not identified — copy should read like a sentence. */
function displayName(actor: TranscriptMessage['actor'] | undefined): string {
  switch (actor) {
    case 'codex':
      return 'Codex'
    case 'claude':
      return 'Claude'
    case 'user':
      return 'you'
    case 'system':
    case undefined:
      return 'the system'
  }
}

/**
 * The diff an edit carried, drawn under its tool row.
 *
 * Open by default and with nothing to click, unlike `CommandEntry` — an edit is
 * the one thing in a turn you almost always want to see, and hiding it behind a
 * caret is the problem this solves. It stays affordable because a hunk is the
 * change plus three lines of context however large the file; only a *created*
 * file is capped, and then it says so.
 *
 * Memoised and parsed in a `useMemo`: the transcript hands down a fresh array on
 * every streamed delta, and re-parsing every visible diff on each one would make
 * typing next to a long turn cost more than the turn did.
 */
const ToolPatch = memo(function ToolPatch({
  patch,
  omittedLines,
  nested,
}: {
  patch: string
  omittedLines?: number | undefined
  nested: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const files = useMemo(() => parseDiff(patch), [patch])
  if (files.length === 0) return null

  return (
    <div className="tool-patch" data-nested={nested ? 'true' : undefined}>
      {files.map((file, i) => (
        <FileDiff key={i} file={file} />
      ))}
      {omittedLines !== undefined && omittedLines > 0 && (
        <p className="tool-patch-omitted">{t('tool.patchOmitted', { count: omittedLines })}</p>
      )}
    </div>
  )
})

/**
 * A command, folded to its first line.
 *
 * The whole text stays in the DOM only when open — a long heredoc is a lot of
 * highlighted spans, and a turn can hold a dozen of them.
 */
function CommandEntry(props: {
  text: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const lines = props.text.split('\n')
  const first = lines[0] ?? ''
  const rest = lines.length - 1
  return (
    <div className="command-fold" data-open={props.open}>
      <button
        type="button"
        className="command-summary"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span className="command-caret" aria-hidden="true">
          {props.open ? '⌄' : '›'}
        </span>
        <code className="command-first">{first}</code>
        {rest > 0 && !props.open && (
          <span className="command-more">{t('conversation.moreLines', { count: rest })}</span>
        )}
      </button>
      {props.open && (
        /* A command is shell, wherever it is shown. */
        <pre className="command">
          <CodeRun code={props.text} language="shell" />
        </pre>
      )}
    </div>
  )
}

/**
 * Holds a long message to a fraction of the view, with a way to see the rest.
 *
 * The control appears only when there is something hidden, and the measurement
 * is against the limit rather than against the element's own height — a clamp
 * that measures `scrollHeight > clientHeight` reports "fits" the moment it is
 * opened, and the button to close it again disappears with the overflow that
 * justified it.
 */
function Clamped(props: { children: React.ReactNode }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()

  useLayoutEffect(() => {
    const element = body.current
    if (element === null) return undefined
    const measure = (): void => {
      setTall(element.scrollHeight > window.innerHeight * LIMIT + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return (
    <div className="clamp" data-open={open || !tall ? 'true' : 'false'}>
      <div className="clamp-body" ref={body}>
        {props.children}
      </div>
      {tall && (
        <button
          type="button"
          className="clamp-toggle"
          onClick={() => {
            setOpen(!open)
          }}
        >
          {open ? t('conversation.showLess') : t('conversation.showMore')}
        </button>
      )}
    </div>
  )
}

/** A quarter of the view: enough to recognise, not enough to bury. */
const LIMIT = 0.25

export const Entry = memo(function Entry({
  message,
  onHandOff,
  answersThinking = false,
  final = false,
}: {
  message: TranscriptMessage
  /** Absent when there is nobody to hand to — a one-agent conversation. */
  onHandOff?: ((message: TranscriptMessage) => void) | undefined
  /** This reply follows the agent's own thinking, so it is worth marking as the answer. */
  answersThinking?: boolean
  /** The answer the finished turn arrived at, as opposed to the work it did. */
  final?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  /** Commands start folded: a turn is mostly steps, and they are skimmed. */
  const [showCommand, setShowCommand] = useState(false)

  /*
   * Messages already finished when the pane first drew them are never typed out.
   * That is history — a transcript reopened at launch, or one just restored —
   * and performing it as if it were happening now would be a lie about when.
   */
  const wasComplete = useRef(message.status !== 'streaming')
  const typed = useTypewriter(message.text, wasComplete.current)

  if (message.kind === 'handoff') {
    return (
      <article className={`entry entry--${message.actor} entry--handoff`}>
        <span className="tick" aria-hidden="true" />
        <span className="speaker">{message.actor}</span>
        <details className="handoff-card">
          <summary>
            {t('handoff.card', {
              from: displayName(message.actor),
              to: displayName(message.handoffTo),
            })}
          </summary>
          <pre>{message.text}</pre>
        </details>
      </article>
    )
  }

  if (message.kind === 'reasoning') {
    return (
      <article className={`entry entry--${message.actor} entry--reasoning`}>
        <span className="tick" aria-hidden="true" />
        <span className="speaker">{message.actor}</span>
        <button
          type="button"
          className="reasoning-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
          }}
        >
          {open ? t('conversation.hideThinking') : t('conversation.showThinking')}
        </button>
        {open && <div className="reasoning-body">{message.text}</div>}
      </article>
    )
  }

  return (
    <article
      className={`entry entry--${message.actor} entry--${message.kind}`}
      // Only ever set when thinking precedes it, so it marks the answer rather
      // than marking every message and therefore nothing.
      data-answer={answersThinking ? 'true' : undefined}
      /*
       * The one message a finished turn was for.
       *
       * A turn is mostly steps — commands, notices, thinking — and the reply
       * they were in service of is just another entry in the column, indented
       * the same and coloured the same. Set only on the latest finished turn's
       * last words, so it stays a mark of "this is the answer" rather than a
       * decoration every agent message wears.
       */
      data-final={final ? 'true' : undefined}
      /*
       * What a selection made inside this entry came out of.
       *
       * Always set, including on the rows an aside can never be asked about, so
       * that `askableSource` decides from facts rather than from absence — a
       * missing attribute and a streaming one would otherwise be the same thing
       * to the reader, and only one of them may become askable a second later.
       */
      data-event-id={message.eventId}
      data-actor={message.actor}
      data-kind={message.kind}
      data-status={message.status}
    >
      <span className="tick" aria-hidden="true" />
      <span className="speaker">{message.actor}</span>
      {onHandOff !== undefined && message.status === 'complete' && (
        <button
          type="button"
          className="handoff-action"
          onClick={() => {
            onHandOff(message)
          }}
        >
          {t('handoff.action')}
        </button>
      )}
      <div className="said" data-streaming={message.status === 'streaming'}>
        {message.kind === 'command' ? (
          /*
           * One line until asked otherwise.
           *
           * A turn that greps twelve times used to be twelve syntax-highlighted
           * blocks, and the answer they led to was somewhere below all of them.
           * Folded, the same turn reads as a list of what was done, which is
           * both the summary and — while it is still running — the only honest
           * answer to "what is it doing right now".
           *
           * Folded by default rather than folding when the turn ends: a
           * transcript that reflows the moment an agent stops would move the
           * pinned question, resize the rail, and change the very measurement
           * `makeRoom` uses to decide where the bottom is.
           */
          <CommandEntry
            text={message.text}
            open={showCommand}
            onToggle={() => {
              setShowCommand(!showCommand)
            }}
          />
        ) : message.kind === 'tool' ? (
          /*
           * One dense line per call, indented when it happened inside a
           * subagent.
           *
           * A turn that reads six files and greps twice is six-plus-two facts,
           * not eight paragraphs — the row has to cost about as much to skip as
           * it does to read, or the answer underneath it gets buried by its own
           * working.
           */
          <>
            <p
              className="tool-line"
              data-status={message.toolStatus ?? 'running'}
              data-nested={message.parentRef === undefined ? undefined : 'true'}
            >
              <span
                className="tool-dot"
                aria-label={t(`tool.${message.toolStatus ?? 'running'}`)}
              />
              <span className="tool-name">{message.text}</span>
              {message.detail !== undefined && (
                <span className="tool-detail">{message.detail}</span>
              )}
            </p>
            {message.patch !== undefined && (
              <ToolPatch
                patch={message.patch}
                omittedLines={message.omittedLines}
                nested={message.parentRef !== undefined}
              />
            )}
          </>
        ) : message.kind === 'notice' ? (
          /*
           * A label the eye can skip, then the harness's own words.
           *
           * `noticeSource` is a key rather than a phrase precisely so it can be
           * translated here: `transcript.ts` is a pure reducer with no
           * translator, and composing the sentence there would have written
           * English into the event log, where it would be replayed forever.
           */
          <div className="notice-line" data-level={message.level ?? 'info'}>
            {message.noticeSource !== undefined && message.noticeSource !== '' && (
              <span className="notice-source">
                {t(`notice.source.${message.noticeSource}`, { defaultValue: message.noticeSource })}
              </span>
            )}
            <span className="notice-text">
              {message.folded === undefined
                ? message.text
                : t('notice.hooksFolded', { count: message.folded.length })}
            </span>
            {message.folded !== undefined && (
              /*
               * The count is the row; the lines are behind it.
               *
               * Measured on the real CLI, six talkative hooks put six durable
               * rows between a command and its output. Only `info` reaches here
               * — a hook that failed keeps its own row and is never counted
               * away, which is the one case the transcript carries hooks for.
               */
              <details className="notice-detail">
                <summary>{t('notice.detail')}</summary>
                <pre>
                  {message.folded
                    .map((line) =>
                      line.detail === undefined ? line.text : `${line.text}\n${line.detail}`
                    )
                    .join('\n')}
                </pre>
              </details>
            )}
            {message.folded === undefined && message.detail !== undefined && (
              /*
               * Folded, for the same reason commands are: a hook that prints
               * forty lines of lint output would otherwise push the command it
               * was gating off the screen.
               */
              <details className="notice-detail">
                <summary>{t('notice.detail')}</summary>
                <pre>{message.detail}</pre>
              </details>
            )}
          </div>
        ) : message.actor === 'user' ? (
          /*
           * Capped, because what a person pastes has no upper bound.
           *
           * Quoting a long reply back is a normal thing to do and it filled the
           * whole view with something already read, pushing the answer it was
           * asking about off the bottom. A quarter of the height is enough to
           * recognise what was said without it becoming the screen.
           */
          <Clamped>
            <MarkdownView source={typed} />
          </Clamped>
        ) : (
          <MarkdownView source={typed} />
        )}
      </div>
    </article>
  )
})
