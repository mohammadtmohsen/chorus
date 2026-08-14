import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseDiff } from '@chorus/workspace/diff'
import { clockTime } from './format.js'
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
 * The same names, as the label above a turn rather than as words in a sentence.
 *
 * `displayName` reads "you" and "the system" because it is used inside phrases;
 * a speaker mark is a heading and takes the standalone form. The label used to
 * be the raw actor id — `user`, `claude` — which is an identifier printed as
 * interface copy and reads exactly like one.
 *
 * A key rather than a translated string, so the switch stays exhaustive: a fifth
 * actor is a compile error here rather than an untranslated word in the
 * transcript.
 */
function speakerKey(actor: TranscriptMessage['actor']): string {
  switch (actor) {
    case 'codex':
      return 'actor.codex'
    case 'claude':
      return 'actor.claude'
    case 'user':
      return 'actor.user'
    case 'system':
      return 'actor.system'
  }
}

/**
 * Who is speaking, as a face rather than as a word.
 *
 * The approved composition opens every message with a round avatar, and the app
 * has no portrait for anybody — so the glyph says *what kind of speaker* this is:
 * a person for you, a machine for an agent. Tinted with the voice colour, which
 * is the same signal the name beside it carries, so the two agree without either
 * having to be read.
 *
 * `aria-hidden`: the name is right there in text, and a screen reader announcing
 * "image, person" before it would be repeating what it is about to say.
 */
function ActorAvatar({
  actor,
  streaming,
}: {
  actor: TranscriptMessage['actor']
  /** Only a message still being written pulses — see `.tick` in `styles.css`. */
  streaming: boolean
}): React.JSX.Element {
  return (
    <span className="entry-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" className="entry-face">
        {actor === 'user' ? (
          <>
            <circle cx="12" cy="8.5" r="3.5" />
            <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
          </>
        ) : (
          <>
            <rect x="4" y="7.5" width="16" height="12" rx="3.5" />
            <path d="M12 3.5v4" />
            <circle cx="9" cy="13" r="1.15" />
            <circle cx="15" cy="13" r="1.15" />
          </>
        )}
      </svg>
      {/*
        Only a voice that can be live wears one.

        The composition puts a dot on the agents and none on you, and the reason
        holds up: the dot says whose voice this is *and* whether it is still
        speaking. You are never mid-turn in your own transcript, and a mark that
        can only ever mean one thing is decoration.
      */}
      {actor !== 'user' && actor !== 'system' && (
        <span className="tick" data-streaming={streaming ? 'true' : undefined} />
      )}
    </span>
  )
}

/**
 * The line above what was said: who, and when.
 *
 * `time` is only passed for the kinds the composition gives one — a message and
 * a handoff. A command or a notice belongs to the turn above it and would be
 * a third timestamp on the same minute.
 */
function EntryHead({
  actor,
  at,
  silent = false,
  children,
}: {
  actor: TranscriptMessage['actor']
  at?: number | undefined
  /** The row above already said who this is, so the name is left out. */
  silent?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="entry-head" data-silent={silent ? 'true' : undefined}>
      {/*
        Kept in the tree, not dropped.

        A screen reader moving row by row through a turn's work still has to be
        told whose it is — the name is only redundant *visually*, because the row
        above is right there. `sr-only` is that distinction exactly.
      */}
      <span className={silent ? 'speaker sr-only' : 'speaker'}>{t(speakerKey(actor))}</span>
      {children}
      {at !== undefined && (
        <time className="entry-time" dateTime={new Date(at).toISOString()}>
          {clockTime(at)}
        </time>
      )}
    </div>
  )
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
 * The bullets an agent ended its reply with, as a card.
 *
 * Text, not markdown: a summary line is a line, and re-parsing it would render
 * arbitrary agent markup in a second place for no gain. The heading is the
 * app's own word rather than the agent's, so a reply that wrote `### summary`
 * still draws the same card.
 */
const SummaryCard = memo(function SummaryCard({
  items,
}: {
  items: readonly string[]
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="summary-card">
      <p className="summary-head">{t('summaryCard.heading')}</p>
      <ul className="summary-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
})

/**
 * A path as the project sees it.
 *
 * Providers report what they touched differently — Claude sends an absolute
 * path, Codex a workspace-relative one — and a card full of
 * `/var/folders/lh/…/T/chorus-changes-HWMPqb/src/rate.ts` says nothing that
 * `src/rate.ts` does not. The full path stays on the row's `title`, so nothing
 * is hidden, only shortened.
 */
function relativeTo(path: string, cwd: string): string {
  if (cwd === '' || !path.startsWith(cwd)) return path
  return path.slice(cwd.length).replace(/^\//, '')
}

/**
 * What a turn wrote, as a table under the reply.
 *
 * Counts rather than hunks: the diff for a file is already reachable from the
 * tool row that made it, and the card's job is the shape of the turn — which
 * files, how much, which way. `ToolPatch` is the other half of that pair and
 * neither replaces the other.
 *
 * The numbers count **what the turn wrote**, not the net result: a line added
 * and then removed inside one turn appears in both columns, so this can
 * legitimately disagree with `git diff --numstat`. The title says so, because a
 * number nobody can reconcile is worse than no number.
 */
const ChangesCard = memo(function ChangesCard({
  files,
  cwd,
}: {
  files: readonly NonNullable<TranscriptMessage['changes']>[number][]
  cwd: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="changes-card">
      <p className="changes-head">{t('changes.heading')}</p>
      <ul className="changes-list">
        {files.map((file) => (
          <li key={file.path} className="changes-row" data-change={file.change}>
            <span
              className="changes-letter"
              title={t(`changes.of.${file.change}`, { from: file.oldPath ?? '' })}
            >
              {t(`changes.letter.${file.change}`)}
            </span>
            <span className="changes-path" title={file.path}>
              {relativeTo(file.path, cwd)}
            </span>
            <span
              className="changes-count"
              title={t('changes.wrote', { added: file.added, removed: file.removed })}
            >
              {file.added > 0 && <span className="changes-added">+{file.added}</span>}
              {file.removed > 0 && <span className="changes-removed">−{file.removed}</span>}
            </span>
            {/*
              The diff, under the row it belongs to.

              Open, with nothing to click, for the reason `ToolPatch` is: an edit
              is the one thing in a turn you almost always want to see, and
              hiding it behind a caret is the problem the card was drawn to
              solve. A row from an older log carries no patch and simply shows
              its counts — an empty frame would be worse than none.
            */}
            {file.patch !== undefined && (
              <ToolPatch patch={file.patch} omittedLines={file.omittedLines} nested={false} />
            )}
          </li>
        ))}
      </ul>
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
        /* The row is one line of what may be a heredoc; the tooltip carries the
           whole command, which is the thing you hover it to find out. */
        title={props.text}
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
  cwd = '',
  onHandOff,
  answersThinking = false,
  final = false,
  grouped = false,
}: {
  message: TranscriptMessage
  /** The project directory, so a changed file reads as a project path. */
  cwd?: string
  /** Absent when there is nobody to hand to — a one-agent conversation. */
  onHandOff?: ((message: TranscriptMessage) => void) | undefined
  /** This reply follows the agent's own thinking, so it is worth marking as the answer. */
  answersThinking?: boolean
  /** The answer the finished turn arrived at, as opposed to the work it did. */
  final?: boolean
  /** This row carries on from the one above it: same speaker, no second header. */
  grouped?: boolean
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
  /*
   * The third argument is the end of the turn, not the start of the pane.
   *
   * `wasComplete` answers "was this already written when we first drew it";
   * `message.status` answers "is the agent still writing". They were the same
   * question while the only way to finish was to run the animation out, which
   * left every reply with a visible tail after the agent had stopped.
   */
  const typed = useTypewriter(message.text, wasComplete.current, message.status !== 'streaming')

  if (message.kind === 'handoff') {
    return (
      <article className={`entry entry--${message.actor} entry--handoff`}>
        <ActorAvatar actor={message.actor} streaming={false} />
        <EntryHead actor={message.actor} at={message.at} />
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

  if (message.kind === 'changes') {
    /*
     * No face and no name: the card belongs to the message above it, and a
     * second avatar would read as a second speaker. It keeps the entry element
     * so a selection made inside it is still attributed to a row.
     */
    return (
      <article
        className={`entry entry--${message.actor} entry--changes`}
        data-event-id={message.eventId}
        data-actor={message.actor}
        data-kind={message.kind}
      >
        <ChangesCard files={message.changes ?? []} cwd={cwd} />
      </article>
    )
  }

  if (message.kind === 'reasoning') {
    return (
      <article
        className={`entry entry--${message.actor} entry--reasoning`}
        data-grouped={grouped ? 'true' : undefined}
      >
        {/*
          A mark, not a face.

          Thinking is not a turn: it is the working behind the reply below it,
          and giving it the same avatar would make one turn look like two
          speakers. No time either — it belongs to the message it precedes.
        */}
        <span className="entry-mark" aria-hidden="true">
          <span className="tick" />
        </span>
        <EntryHead actor={message.actor} silent={grouped}>
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
        </EntryHead>
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
      data-grouped={grouped ? 'true' : undefined}
      /*
       * Whether this row has a head line at all.
       *
       * Set here rather than derived in CSS, because the CSS way needed
       * `:has(… :not(:has(button)))` — and `:has()` may not be nested inside
       * `:has()`, so the rule was invalid and silently dropped. The mark stayed
       * in the head's row, 15px above the line it marks, and nothing failed.
       */
      data-headless={grouped ? 'true' : undefined}
    >
      {message.kind === 'message' ? (
        <ActorAvatar actor={message.actor} streaming={message.status === 'streaming'} />
      ) : (
        /*
         * Commands, tools and notices keep the compact mark they have always
         * had. The composition being matched contains none of them — it is
         * messages and cards — so giving them an avatar and a time would be
         * inventing a treatment nobody has judged, and would make a turn's
         * twelve greps read as twelve speakers.
         */
        <span className="entry-mark" aria-hidden="true">
          <span className="tick" />
        </span>
      )}
      <EntryHead
        actor={message.actor}
        at={message.kind === 'message' ? message.at : undefined}
        silent={grouped}
      ></EntryHead>
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
        {/*
          Under the words, inside the same row.

          Its own entry — the way `Changes` is — would need the reducer to hold
          it somewhere and keep it beside the message it came out of; the
          summary was *part of that message's text*, so the row it was cut from
          is where it belongs.
        */}
        {message.summary !== undefined && <SummaryCard items={message.summary} />}
      </div>
      {/*
        Offered under the words, not beside the name.

        Two rules decide where this goes. The first is what it is *for*: only a
        message can be handed off — a notice saying "NOTE: tool_progress" carries
        nothing to the other agent — which is why the condition is unchanged from
        when it lived in the head.

        The second is when you decide. It sat top-right, level with the speaker,
        so the one control that moves a reply to the other agent was offered
        before the reply had been read. Handing off is a judgement about what was
        said; it belongs after the saying. Under the message it is also next to
        the composer, which is the other thing you might do instead — reply
        yourself — and those two choices now sit together rather than at opposite
        ends of the row.
      */}
      {onHandOff !== undefined && message.kind === 'message' && message.status === 'complete' && (
        <div className="entry-actions">
          <button
            type="button"
            className="handoff-action"
            onClick={() => {
              onHandOff(message)
            }}
          >
            {t('handoff.action')}
          </button>
        </div>
      )}
    </article>
  )
})
