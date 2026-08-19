import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ClaudeAdapter, type ResolvedExecutable } from '@chorus/adapter-claude'
import { CodexAdapter } from '@chorus/adapter-codex'
import type {
  AccountSummary,
  AgentAdapter,
  AgentSession,
  ApprovalDecision,
  McpServerHealth,
  ModelChoice,
  SessionOpts,
  SlashCommandInfo,
  UsageWindow,
  UserInputResponse,
} from '@chorus/agent-protocol'
import {
  EventStore,
  openSqlite,
  type AsideSummary,
  type ConversationSummary,
  type SqliteHandle,
  type StoredEvent,
} from '@chorus/event-store'
import {
  composeBrief,
  ConversationService,
  DEFAULT_PROFILE_ID,
  defaultIntent,
  parseMentions,
  profileById,
  PROFILES,
  SessionGrants,
  SupervisedSession,
  summariseHandoff,
  withCatchup,
  type HandoffIntent,
  type HandoffSource,
  type PermissionProfile,
} from '@chorus/orchestrator'
import { newConversationId, newHandoffId, type AgentId, type Logger } from '@chorus/shared'
import {
  readWorkspace,
  relativeWithin,
  type DiffFile,
  type WorkspaceStatus,
} from '@chorus/workspace'
import type { ActivityPush, ContextUsagePush, TasksPush } from '../shared/ipc.js'
import { UNREAD_EVENT_TYPES } from '../shared/unread.js'
import { readOpenSessions, writeOpenSessions, type OpenSession } from './open-sessions.js'
import { containsPassage } from '../shared/plain-text.js'
import { readRemembered, writeRemembered } from './remembered.js'
import { readSettings } from './settings.js'
import {
  TerminalService,
  type TerminalAttachment,
  type TerminalDescription,
  type TerminalPush,
  type TerminalRef,
} from './terminal.js'
import type { WorkspaceSnapshot } from '../shared/workspace-layout.js'
import { sdkExecutablePath, spawnSpec } from './command.js'
import { resolveCommand } from './which.js'

/**
 * Wires the domain to real agents inside the main process.
 *
 * The orchestrator packages know nothing about Electron; this is where the
 * dependency direction turns around (plan §3.2). It owns the single SQLite
 * handle, so every write funnels through here — SQLite is single-writer, and
 * centralising that removes a class of lock contention.
 *
 * A conversation holds **several agents at once**. That is the product's whole
 * point: one shared transcript, separate agent contexts, and the user choosing
 * who sees what. Each agent gets its own `ConversationService` writing into the
 * same conversation id; the log's global sequence is what interleaves them.
 */

export interface StartConversationOptions {
  readonly agents: readonly AgentId[]
  readonly cwd: string
  readonly projectId?: string
  readonly title?: string
  /** Defaults to read-only. Permissive defaults ship by accident, not on purpose. */
  readonly profileId?: string
}

interface Participant {
  readonly agentId: AgentId
  readonly service: ConversationService
  readonly session: SupervisedSession
  /**
   * The last event in the shared log this agent has been shown.
   *
   * Agents keep separate contexts, so without this each one only knows the
   * messages addressed to it — which makes a shared transcript that isn't
   * actually shared. Everything past this mark is replayed as catch-up the next
   * time the agent is addressed.
   */
  seenSeq: number
  /**
   * Context this agent must be given, prepended to the **next** real message.
   *
   * Promotion cannot send it. `send` starts a turn: delivering the aside's
   * exchange at the moment of promotion would produce an answer nobody asked
   * for, possibly run tools under the profile just chosen, and make "open as a
   * conversation" behave like "ask that again, now, with permissions".
   *
   * Catch-up cannot carry it either — it skips events whose actor is the
   * recipient, and the aside's answer was written by this very agent, so the one
   * thing worth carrying is exactly what it drops.
   *
   * So it waits here, costs nothing, and rides along when the user next speaks.
   */
  seedContext?: string
  /**
   * A larger catch-up allowance, used once.
   *
   * An agent joining an hour-old conversation has to read all of it, and the
   * per-turn budget is sized for "what happened while you were not addressed",
   * not "everything". Cleared after the first delivery so the next turn is
   * ordinary again.
   */
  catchupBudget?: number
  /** The provider's command list, asked for once per session. */
  commands?: readonly SlashCommandInfo[]
}

/** What the renderer needs to draw a promoted aside as a tab. */
export interface PromotedConversation {
  readonly conversationId: string
  readonly participants: AgentId[]
  readonly profileId: string
  readonly cwd: string
  readonly title: string
  readonly unread: number
}

interface ActiveConversation {
  readonly conversationId: string
  readonly participants: Map<AgentId, Participant>
  /** Shared, so a grant given to one agent is not re-asked for the next to join. */
  readonly grants: SessionGrants
  profile: PermissionProfile
  cwd: string
  title: string
  /** Who the user last addressed, so an unaddressed follow-up stays with them. */
  lastAddressed: AgentId | undefined
  /** How far this conversation's card had been read. See `OpenSession`. */
  lastSeenSeq: number
  /** A message typed and not sent, so quitting does not lose it. */
  draft: string
  /** Reading and reasoning, executing nothing, until a plan is approved. */
  planning: boolean
}

/**
 * What a joining agent may be handed at once.
 *
 * Several times the ordinary per-turn allowance: it is paid once, and an agent
 * that has read half a conversation is worse than one that has read none, because
 * it does not know which half it is missing.
 */
const JOINING_CATCHUP_CHARS = 60_000

/**
 * What the fork is actually asked.
 *
 * The excerpt is quoted rather than described, for the same reason `quote.ts`
 * quotes into the composer: both CLIs already read `>` as quotation, so the
 * agent sees the passage and the question as two separate things without Chorus
 * inventing a convention to teach it.
 *
 * The framing is deliberate. Without it a fork treats the question as the next
 * turn of the work and starts *doing* things — which is the one behaviour an
 * aside must not have, and which no permission rule would catch because reading
 * files is allowed.
 */
/**
 * What stays in English when the answer is in another language.
 *
 * **One copy, because three prompts need it** — an explanation, a translation,
 * and every follow-up inside either card. Written out three times they drift,
 * and the drift is invisible: two of the three keep working and the third
 * quietly renders `commit` as a word the reader then has to translate back.
 *
 * Two rules, and the second is the one that was missing. Identifiers, paths and
 * file names were already protected — they are names, and a translated name
 * points at nothing. But the **vocabulary** was not: `event`, `status`,
 * `variable`, `props`, `endpoint`, `migration`. A translator renders those,
 * correctly, into ordinary words of the target language — and the result is
 * prose a developer cannot search, cannot paste into a terminal, and cannot
 * match against the code in front of them. Reported from the running app.
 *
 * The examples are deliberate rather than exhaustive: a list that tried to be
 * complete would be wrong tomorrow, and a model given six of the right shape
 * generalises to the seventh.
 */
const KEEP_IN_ENGLISH = [
  'Keep identifiers, file names and paths exactly as written, in their own',
  'script. Do not translate or transliterate them.',
  '',
  'Keep the technical vocabulary in English too, inside otherwise translated',
  'sentences — event, status, variable, commit, branch, props, hook, endpoint,',
  'cache, migration, and the names of tools, libraries, formats and APIs. A term',
  'translated is one the reader has to translate back before they can search for',
  'it, or match it against the code in front of them.',
]

function asideQuestion(excerpt: string, question: string, language = ''): string {
  return [
    'You are being asked a short side question about something you said.',
    'Answer it and nothing else: do not continue the work, do not change files.',
    /*
     * The language the card was opened in, repeated on every follow-up.
     *
     * A card opened by Explain or Translate answered in the chosen language and
     * then switched to English the moment a second question was typed — because
     * only the *first* prompt named a language, and a model answers in the
     * language it was asked in. That is the reported bug, and it makes the
     * feature useless for the person it exists for: someone who reads more
     * comfortably in their own language does not stop after one answer.
     *
     * **The question's own language is deliberately not the answer's.** Typing
     * in English is how a developer types; it says nothing about which language
     * they want to read. The setting says that, and it is the setting that wins
     * until the card is closed.
     *
     * Empty for an ordinary "Ask about this" — that card names no language, and
     * inventing one would answer a plain question in a language nobody chose.
     */
    ...(language === ''
      ? []
      : [
          `Answer in ${language}. Every sentence of it, whatever language the`,
          `question is written in — a question typed in English is still to be`,
          `answered in ${language}.`,
          ...KEEP_IN_ENGLISH,
        ]),
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
    '',
    question,
  ].join('\n')
}

/**
 * What a fork is asked when someone did not follow a reply.
 *
 * **The subject is the whole reply now, not a selection**, and the wording moved
 * with it. Explain was offered on a drag until the button under each reply
 * replaced it, so every "the passage below" here would have been pointing at an
 * entire answer while asking the model to treat it as a fragment — and the one
 * instruction that matters most, the length, only reads as a limit if the model
 * knows it is summarising something long.
 *
 * **Level first, language second**, and the ordering is the feature. A prompt
 * that leads with the language produces a faithful translation of something
 * still too dense — the reader is no better off, in a second language.
 *
 * Two failure modes the wording works against, both of which read as a bad
 * feature rather than a bad prompt. **Condescension**: "explain simply" invites
 * an answer starting from first principles, which is insulting to someone who
 * understood every word but one, so the reader is named as what they are — a
 * developer on this project who has not met this particular thing. And
 * **length**: a model asked to explain will keep explaining, while the card is
 * a few hundred pixels at its largest and a passage of one sentence deserves an
 * answer of three.
 *
 * The do-not-work clause is the same one `asideQuestion` carries, and for the
 * same measured reason: without it a fork treats the request as the next turn of
 * the work and starts doing things, which no permission rule catches because
 * reading files is allowed.
 */
export function explainPrompt(excerpt: string, language: string): string {
  return [
    'Someone reading this conversation did not follow your reply below.',
    'Say what it actually is here, what it means for the work, and — briefly — why',
    'it is that way. Nothing else.',
    '',
    // Lead position, because the list below said this and a real answer still
    // opened with "this is not a code unit you saw in the source". An opening
    // clause is the one the model commits to first.
    'Begin with what it *is*. Never open by saying what it is not.',
    '',
    // Also learned from a real answer: asked about a line in a task list, it
    // explained the line's punctuation rather than the task.
    'Explain the work the reply refers to, not how the reply is written.',
    '',
    // Two rounds of real answers taught this list. Each line is something that
    // arrived unasked and pushed the useful part off the card.
    'Leave out:',
    '- what the words mean in general, or one by one, or where they come from;',
    '- what something is *not*, or which other meaning is not intended;',
    '- anything the reply already says, restated;',
    '- remarks about this conversation, about your earlier messages, or about',
    '  what you were or were not offering to do;',
    '- background about the project or its conventions, unless the reply is',
    '  about them.',
    '',
    // Bounded by a number, because "short" drifted twice. Lists are allowed only
    // where the answer genuinely *is* a sequence — a real workflow, a real
    // ordering — and never as a way of getting more room.
    //
    // The second sentence arrived with the whole-reply subject: a long answer
    // invites a proportionally long explanation, which is a second long answer
    // to read rather than a way through the first.
    'Aim for about a hundred words. However long the reply is, the explanation is',
    'this short — the point is a way in, not a second version of it.',
    'Plain paragraphs, short sentences, no headings',
    'and no closing summary. Use a short numbered list only if the answer is a',
    'sequence of steps; otherwise prose.',
    '',
    'They are a developer working on this project who has not met this particular',
    'thing before — not a beginner. Do not start from first principles.',
    '',
    ...KEEP_IN_ENGLISH,
    '',
    `Write your explanation in ${language}. Every sentence of it — not bilingually,`,
    `and not only the first line. If you find yourself back in the reply's own`,
    `language, return to ${language}.`,
    '',
    'You have the whole conversation. Use it: say what this refers to *here*,',
    'rather than what it could mean in general.',
    '',
    // Each clause whole on its own line. A phrase split across a line break is
    // harder to read and easier to weaken by editing one half of it.
    'Do not restate the reply. Do not widen the subject.',
    'Do not continue the work or change anything. Answer this and stop.',
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
  ].join('\n')
}

/**
 * What a fork is asked when someone wants a passage in their own language.
 *
 * **Not `explainPrompt` with the language moved up.** The two are opposites.
 * Explain answers _what does this mean_ and its output is deliberately not the
 * passage — "Do not restate the passage" is its sharpest rule, and restating the
 * passage is precisely this job. Sharing a prompt would mean one string holding
 * two contradictory instructions, and the first bad answer would be fixed in a
 * direction that damaged the other feature.
 *
 * **The standard written form**, because the field it reads was built to accept
 * more than a language name — `ipc.ts` calls "Lebanese Arabic" and "simple
 * Arabic" the answers a locale list cannot express. Those are different kinds of
 * modifier: one names a variety, the other a reading level, and a reading level
 * fights the register rule below. Asked for as "standard arabic translation", so
 * the rule is stated rather than left to the model: take the language, render it
 * standard, and let the passage decide the register.
 *
 * **Code and prose are separated explicitly** because "keep code exactly" and
 * "translate the comments" contradict each other if comments count as code, and
 * a model handed both picks one per selection.
 *
 * The do-not-work clause is the same one `asideQuestion` and `explainPrompt`
 * carry, for the same measured reason: without it a fork treats the request as
 * the next turn of the work and starts doing things, which no permission rule
 * catches because reading files is allowed. A translation request looks more
 * like a task than a question does, not less.
 */
export function translatePrompt(excerpt: string, language: string): string {
  return [
    `Translate the passage below into ${language}.`,
    '',
    // Lead position: the first clause is the one a model commits to, and the
    // failure this guards against is an answer that explains instead.
    'Your reply is the passage itself, in another language. Nothing else.',
    'Do not explain it, summarise it, expand it, or comment on what it means.',
    '',
    `Use standard, professional ${language} — the standard written form of the`,
    'language, not a regional dialect and not a simplified reading level.',
    '',
    // Register belongs to the passage, which is what makes this a translation
    // rather than a rewrite.
    'Match the passage: terse stays terse, formal stays formal, a heading stays a',
    'heading, a list stays a list. Same length, same tone, same structure.',
    '',
    'Inside code, translate the prose and nothing else:',
    '- reproduce identifiers, keywords, file names, paths, string literals,',
    '  punctuation, delimiters and indentation exactly as written, in their own',
    '  script — never translated, never transliterated;',
    '- translate natural-language comments and docstrings;',
    '- change nothing else, so the code still runs.',
    '',
    ...KEEP_IN_ENGLISH,
    '',
    'No preamble, no "here is the translation", no notes about the choices you',
    'made, no alternatives in brackets.',
    '',
    // Otherwise a passage already in the target language comes back paraphrased,
    // which looks like a translation and is not one.
    `If the passage is already in ${language}, say so in one short line and stop.`,
    'Do not paraphrase it.',
    '',
    'Do not continue the work or change anything. Answer this and stop.',
    '',
    excerpt
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n'),
  ].join('\n')
}

/**
 * How much of the user's own words a recap may carry, and how much of any one.
 *
 * A third of `catchup.ts`'s 12,000, because this is one kind of line rather than
 * a whole transcript, and it is paid on every recap rather than once per turn.
 * The per-message cap is `catchup.ts`'s own `MAX_MESSAGE_CHARS`, deliberately —
 * both are answering "how much of one user message is enough to recognise it".
 * Guessed rather than measured; see the plan's open questions.
 */
const RECAP_ANCHOR_CHARS = 4_000
const RECAP_MESSAGE_CHARS = 1_500

/**
 * The user's own messages, newest-first under a budget.
 *
 * Pure, and separate from the prompt, because this is the part with judgement in
 * it — which end to keep, what happens at the boundary, and whether an
 * over-long single message survives at all.
 *
 * **Newest first, oldest rendered first.** Recency wins when the budget binds:
 * the task is defined by what was asked most recently, and a recap that anchored
 * on message one of forty would describe a task that finished hours ago. But the
 * kept messages are returned in their original order, because a reader and a
 * model both take a sequence of requests as a narrowing, and reversing it
 * reverses the narrowing.
 *
 * **One message always survives.** The `kept.length > 0` guard is `catchup.ts`'s
 * (`fitToBudget`, line 360) and exists for the same reason: a single message
 * longer than the whole budget must still anchor the recap, trimmed, rather than
 * leaving the prompt with no task in it at all.
 */
export function taskAnchor(
  asked: readonly string[],
  budget = RECAP_ANCHOR_CHARS,
  perMessage = RECAP_MESSAGE_CHARS
): { kept: readonly string[]; omitted: number } {
  const said = asked.map((text) => trimBothEnds(text, perMessage)).filter((text) => text !== '')

  const kept: string[] = []
  let used = 0
  for (let i = said.length - 1; i >= 0; i--) {
    const text = said[i]
    if (text === undefined) continue
    const cost = text.length + 1
    if (used + cost > budget && kept.length > 0) break
    used += cost
    kept.unshift(text)
  }

  return { kept, omitted: said.length - kept.length }
}

/**
 * `catchup.ts:368`'s trim, kept to the same shape.
 *
 * Both ends rather than a head: the opening says what the request is about and
 * the close usually carries the actual ask, and for a task anchor the close is
 * the half that matters most.
 */
function trimBothEnds(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const half = Math.floor((limit - 20) / 2)
  return `${trimmed.slice(0, half)}\n… [trimmed] …\n${trimmed.slice(-half)}`
}

/**
 * What the log says was actually done, for a recap to write `Done` and `Open`
 * from.
 *
 * **Not `summariseSession`**, and the reuse was weighed rather than skipped.
 * That function answers "what happened in this session, counted" for a panel —
 * turns, spend, per-agent totals, handoffs — and a board needs almost none of
 * it. Reusing it would mean moving it and `Spend` out of the renderer, typing
 * its `payload` as `Record<string, unknown>` where main has the real
 * discriminated union, and then discarding four fifths of the result. This is
 * smaller, better typed, and answers the question actually being asked.
 *
 * The three things a board can say and the log can prove: what changed, what
 * failed, what broke. Everything else on a board — whether it worked, what is
 * still missing, what comes next — is judgement, and the agent supplies that.
 * Denied approvals are deliberately absent: they need a join to
 * `approval.requested` for their description, and "the user refused something"
 * reads as blocked far more often than it is.
 */
export interface RecapLedger {
  /** Distinct paths actually written, most recent last. */
  readonly files: readonly string[]
  /** Commands that exited non-zero, as `command → exit N`. */
  readonly failed: readonly string[]
  /** Errors the log recorded, newest last. */
  readonly errors: readonly string[]
}

/** Bounds, because a board has four `Done` lines and this feeds them. */
const LEDGER_FILES = 12
const LEDGER_FAILURES = 5
const LEDGER_ERRORS = 3

/**
 * Tools that write files, so their `tool.started` names one.
 *
 * **Read out of a real log, not out of the schema**, and the difference was the
 * whole feature. `file.change.completed` is the event that looks like it records
 * a write, and this store — 183MB, 454 conversations — contains **zero** of
 * them. Files are written through the provider's own tools, whose
 * `tool.started.detail` is the absolute path. A ledger built on the obvious
 * event would have reported "no files changed" for every conversation that has
 * ever existed, which is worse than reporting nothing: it reads as a fact.
 */
const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/**
 * Commands where a non-zero exit is an answer rather than a fault.
 *
 * Also measured: of 38 "failed" commands in the busiest real conversation, most
 * were greps that matched nothing. A board that lists those as failures buries
 * the one that is real, and `grep` exiting 1 is the single most common event in
 * an agent's day.
 *
 * By name rather than by exit code, because 1 is also what a genuine build
 * failure returns — `pnpm check` and `grep` are indistinguishable by number.
 */
const SEARCH_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'diff', 'cmp', 'test'])

/**
 * Whether a command's exit code says anything about the command.
 *
 * **Measured, and it is the rule that made this list usable at all.** Over four
 * real conversations, every single non-zero exit belonged to a compound line —
 * `cd … && python3 - <<'PY' … | grep -E "×|Tests" | head`. The status of such a
 * line is the status of whatever ran *last*, which is almost always a `grep`
 * that matched nothing, and the line itself is far too long to read on a board.
 * Twenty of twenty sampled were noise.
 *
 * A simple line is different: `pnpm check → exit 1` is exactly the fact a board
 * wants. So the rule is not "guess harder about compound lines" — it is to
 * report only the ones whose exit code has a single unambiguous author.
 *
 * The cost is silence about a build that failed inside a `&&` chain. That is the
 * right way round: a board that says nothing is read as saying nothing, while a
 * board listing five greps is read as five failures.
 */
function simpleCommand(line: string): boolean {
  return !/[|&;\n]|<<|\$\(|`/.test(line)
}

/**
 * Strips the login shell both providers wrap a command in.
 *
 * Every command in a real log arrives as `/bin/zsh -lc '…'`. Left on, a board's
 * failure lines all begin with fourteen identical characters and the useful part
 * is what falls off the end of the trim.
 */
function unwrapShell(line: string): string {
  const wrapped = /^\S*\/?(?:ba|z|)sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/.exec(line.trim())
  return wrapped?.[2] ?? line
}

/**
 * Noise the supervisor makes, which is not news about the work.
 *
 * `agent claude exited unexpectedly; restarting` was the most common
 * `error.raised` in every real conversation sampled — three of three in one.
 * It is true, it is worth logging, and it tells a reader nothing about where the
 * task stands.
 */
const SUPERVISOR_NOISE = /exited unexpectedly|restarting|No completion record was found/i

/**
 * Pure, and exported for its own tests.
 *
 * `file.change.completed` rather than `.proposed`: a proposal is not a change,
 * which is the same distinction `catchup.ts` draws when it skips proposals
 * entirely. A `Done` line built from proposals would claim work that a denied
 * approval stopped.
 *
 * A command's line arrives on `command.started` and its exit code on
 * `command.completed`, so they are joined by `itemRef` — the same join
 * `summariseSession` makes, and for the same reason: without it the failures
 * cannot be named, only counted.
 */
export function recapLedger(events: readonly StoredEvent[], cwd = ''): RecapLedger {
  const files: string[] = []
  const failed: string[] = []
  const errors: string[] = []
  const commandLine = new Map<string, string>()

  /*
   * Inside the project only, and project-relative.
   *
   * Both halves were measured. Absolute paths make a board a column of identical
   * prefixes; and the busiest real conversation had half its "files changed"
   * list taken by `/tmp/promote.mjs`, `/tmp/deadline2.mjs` and other throwaway
   * probes, which crowded the actual source files out of a bounded list. A
   * scratch file outside the project is not what the task is about.
   */
  const touch = (path: string): void => {
    /*
     * With no project to measure against, everything is kept as written.
     * Filtering on an unknown `cwd` would silently drop every file, and a board
     * that says "no files changed" because it did not know where it was is the
     * failure mode this whole ledger exists to avoid.
     */
    /*
     * Through the shared containment rule, not a hand-rolled prefix test.
     *
     * This was `path.startsWith(`${cwd}/`)` and `path.slice(cwd.length + 1)` —
     * the third copy of the arithmetic already fixed in `path-safety.ts` and
     * `project-match.ts`, and the one that had no test until the Windows CI run
     * found it. A `/` that never appears in a Windows path meant the guard
     * dropped **every** file, so a recap reported "no files changed" for every
     * conversation — the exact failure mode the comment above says this ledger
     * exists to avoid.
     */
    const within = cwd === '' ? path : relativeWithin(cwd, path)
    if (within === null || within === '') return
    const relative = within
    const already = files.indexOf(relative)
    if (already !== -1) files.splice(already, 1)
    files.push(relative)
  }

  /**
   * A file that was written and later deleted was not work done.
   *
   * Reported from a real recap: three of its four `Done` lines named throwaway
   * probe scripts that had been created and removed in the same session. The
   * ledger read `Edit` and `Write` and never noticed the `rm` that followed, so
   * a board claimed as delivered several files that do not exist — which is the
   * worst line for a board to get wrong, because it is the one a reader acts on.
   *
   * Matched on the path the ledger is already holding rather than by parsing the
   * command: a shell line can be arbitrarily compound and its argument may be
   * quoted, globbed or built from a variable, so extracting "the file being
   * removed" is a guess. Asking "does this removal name something I am claiming"
   * is a question with an answer.
   */
  const untouchRemoved = (line: string): void => {
    if (!/(^|[\s;&|])(rm|del|Remove-Item)\b/i.test(line)) return
    for (let i = files.length - 1; i >= 0; i--) {
      const candidate = files[i]
      if (candidate !== undefined && line.includes(candidate)) files.splice(i, 1)
    }
  }

  for (const event of events) {
    const payload = event.payload
    switch (payload.type) {
      case 'command.started': {
        const line = payload.command.join(' ')
        commandLine.set(payload.itemRef, line)
        /*
         * On `started`, not on `completed`. A removal that failed leaves the
         * file, so this is the wrong event in principle — but a `command.started`
         * with no `completed` is a command still running or one whose turn was
         * interrupted, and dropping a claim about a file is the safe direction.
         * Over-claiming is what this exists to stop.
         */
        untouchRemoved(line)
        break
      }

      case 'command.completed': {
        if (payload.exitCode === null || payload.exitCode === 0) break
        // Unwrapped before the simplicity test, or every command looks compound
        // — the shell wrapper's own quotes are what `simpleCommand` would trip on.
        const line = unwrapShell(commandLine.get(payload.itemRef) ?? '').trim()
        if (line === '' || !simpleCommand(line)) break
        const tool = /([a-z0-9_-]+)/i.exec(line)?.[1] ?? ''
        if (payload.exitCode === 1 && SEARCH_TOOLS.has(tool)) break
        failed.push(`${trimBothEnds(line, 120)} → exit ${String(payload.exitCode)}`)
        break
      }

      case 'tool.started':
        // Where a written file actually shows up. See `WRITING_TOOLS`.
        if (WRITING_TOOLS.has(payload.name) && payload.detail !== null && payload.detail !== '') {
          touch(payload.detail)
        }
        break

      case 'tool.completed':
        if (payload.status === 'error' && !SUPERVISOR_NOISE.test(payload.summary ?? '')) {
          errors.push(trimBothEnds(payload.summary ?? 'a tool failed', 200))
        }
        break

      case 'file.change.completed':
        /*
         * Kept, though no log has ever contained one — see `WRITING_TOOLS`. If a
         * provider does start writing these, a board that ignored them would be
         * wrong in the direction that is hardest to notice.
         *
         * `applied`, not merely `completed`: the event is written for `failed`
         * and `declined` too, and a write the user refused is still a completed
         * *attempt*. Counting those puts a file on `Done` that was never changed,
         * which is the one line a reader acts on without re-checking.
         */
        if (payload.outcome !== 'applied') break
        for (const file of payload.files) touch(file.path)
        break

      case 'error.raised':
        if (!SUPERVISOR_NOISE.test(payload.message)) {
          errors.push(trimBothEnds(payload.message, 200))
        }
        break

      /*
       * Listed rather than defaulted, the way `projections.ts` and `catchup.ts`
       * list theirs, so a new event type has to be considered here instead of
       * silently failing to count.
       *
       * The reason they are no-ops is one reason, not twenty-seven: a ledger
       * carries **what the log can prove was done**, and none of these is
       * evidence of work. Speech is the conversation, not its outcome — and it
       * is deliberately absent, because a board built from what an agent *said*
       * it did is the drifted account this feature exists to replace. Proposals
       * and requests are intentions. Turn, session, usage and policy events are
       * bookkeeping about the room rather than about the work.
       *
       * The one worth revisiting is `approval.decided`: a denied approval is
       * genuinely "Open", and it is left out only because naming it needs a join
       * to `approval.requested` and "the user refused something" reads as blocked
       * far more often than it is. See the plan's open questions.
       */
      case 'conversation.created':
      case 'session.started':
      case 'session.ended':
      case 'user.message':
      case 'turn.started':
      case 'turn.completed':
      case 'agent.message.delta':
      case 'agent.message.completed':
      case 'agent.reasoning.delta':
      case 'command.output':
      case 'file.change.proposed':
      case 'diff.updated':
      case 'approval.requested':
      case 'approval.decided':
      case 'userinput.requested':
      case 'userinput.answered':
      case 'handoff.created':
      case 'context.compacted':
      case 'usage.updated':
      case 'conversation.renamed':
      case 'aside.promoted':
      case 'project.changed':
      case 'policy.changed':
      case 'tool.progress':
      case 'notice.raised':
        break
    }
  }

  return {
    files: files.slice(-LEDGER_FILES),
    failed: failed.slice(-LEDGER_FAILURES),
    errors: errors.slice(-LEDGER_ERRORS),
  }
}

/**
 * What a fork is asked when someone has lost the thread.
 *
 * **Not `explainPrompt` for a whole conversation.** Explain answers _what does
 * this mean_ about a passage in front of you. A recap answers _where are we_, and
 * its subject is the thing the conversation has drifted away from — so the
 * passage that triggered it is the one input the prompt must not lean on.
 * Nothing is quoted from the reply here, and that absence is the feature.
 *
 * **Everything it knows comes from the log, and it is told so.** This began as a
 * fork of the agent that spoke, on the theory that its memory was the cheapest
 * source of `Done`. Two things killed that. The memory is the thing that
 * *drifted* — asking a drifted context to describe the drift is asking the
 * symptom to diagnose itself — and, measured in the running app, a fork is
 * simply unavailable at the moment a recap is most wanted: Claude's session ref
 * only exists once it has spoken in this process, so right after reopening the
 * app there is nothing to fork and the whole feature was dead.
 *
 * So the reader is a **fresh** agent with no history, and the prompt carries
 * everything: the user's own messages as the task, and `recapLedger`'s counted
 * facts as the evidence. That is the project's own first rule applied properly —
 * the event log is the source of truth — and it is why the prompt has to say
 * "you were not part of this". A model handed a transcript it is told is its own
 * writes `I did X`; handed one it is told it is reading, it writes what the log
 * shows. Claude Code's own compaction prompt keeps an "All user messages"
 * section for the same reason the anchor exists.
 *
 * **The ledger is fenced off from the judgement.** Facts go in under a heading
 * that says they are Chorus's, not the model's recollection, the same way
 * `catchup.ts` marks its block `[Chorus]` rather than splicing another agent's
 * words in silently. Without the label the two blur and the board starts
 * asserting things the log never said.
 *
 * **Two numbers, not an adjective.** `explainPrompt` records that "short" drifted
 * twice before a number fixed it. A cap on lines alone produces four very long
 * lines, so lines and words are both bounded.
 *
 * **`Parked` exists because the complaint was "useful but scattered".** The
 * off-task material is worth something. Given nowhere to go it leaks back into
 * `Done` and the board stops being a board; given a bounded home it is preserved
 * and quarantined at once.
 *
 * The do-not-work clause is the same one `asideQuestion`, `explainPrompt` and
 * `translatePrompt` carry, for the same measured reason: without it a session
 * treats the request as the next turn of the work and starts doing things, which
 * no permission rule catches because reading files is allowed. A request for a
 * status board looks more like a task than any of the other three, and a reader
 * with no history has nothing else to be doing.
 */
export function recapPrompt(asked: readonly string[], ledger: RecapLedger): string {
  const { kept, omitted } = taskAnchor(asked)
  const quote = (text: string): string =>
    text
      .split('\n')
      .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
      .join('\n')

  return [
    'Someone has lost the thread of a conversation and needs to see where it',
    'stands. You were not part of it — everything you know about it is below.',
    '',
    // Lead position, because the first clause is the one the model commits to —
    // the same lesson `explainPrompt` records at its "Begin with what it *is*".
    'Your reply is a status board, not a message. Four headings, in this order —',
    'Task, Done, Open, Next. Nothing before them and nothing after them.',
    '',
    'Task — one line. What is being worked on, taken from the user’s own words',
    'below. Where they asked for several things, the most recent one wins.',
    '',
    'Done — up to four lines. Only what the log below shows was actually done,',
    'each naming the file or command it refers to. The log records that a file',
    'changed, never that the change was correct — so no line here may claim',
    'something works.',
    '',
    // Measured from a real board: told to mark unchecked work, and given a
    // ledger that says nothing about checking, an agent marks *everything*
    // unverified — including two things a Windows machine had confirmed that
    // morning. The instruction and the evidence disagreed about what the
    // evidence could show. Say when to use the word, and when to stay silent.
    'Write "unverified" after a line only when the log shows the work and shows',
    'no command that would have checked it. Where the log says nothing either',
    'way, say nothing about verification — an absent record is not evidence that',
    'nobody checked, and a board that marks everything unverified says as little',
    'as one that marks nothing.',
    '',
    'Open — up to three lines. What is unfinished, failing, or waiting on the user.',
    'Say what each one is waiting on.',
    '',
    'Next — exactly one line, beginning with a verb. The single action that comes',
    "next. It must follow from the user's most recent request, not from a tangent.",
    '',
    'Then, only if there is something for it, a fifth heading — Parked — up to two',
    'lines, for things raised that are worth keeping but are not part of this task.',
    'Anything off-task goes there and nowhere else.',
    '',
    'Fifteen words a line at most. No sub-bullets, no prose paragraphs, no preamble,',
    'no closing remark. Omit Done or Open entirely if there is nothing true to put',
    'in them; never pad a section to fill it.',
    '',
    // Seeded from the request this was built for — "it's useful but scattered" —
    // rather than from a real answer. Each line added later should say which
    // answer caused it, the way `explainPrompt`'s list does.
    'Leave out:',
    '- anything below that is not one of the five things above;',
    '- how something works, or why a decision was right;',
    '- suggestions, options or offers nobody asked for;',
    '- praise, apology, or remarks about the conversation itself;',
    "- restating the user's request beyond the one Task line.",
    '',
    'Work only from what is below. If something is not there, leave the line out',
    'rather than inferring it — you have no other source and a guess is',
    'indistinguishable from a fact on a board. A short board is correct. A padded',
    'one is not.',
    '',
    'Do not continue the work or change anything. Write the board and stop.',
    '',
    '--- what the user asked for, in their own words. This is the task. ---',
    '',
    // Disclosed rather than silent, as `catchup.ts:87` does it. A truncated
    // anchor that does not say so reads as a complete one.
    ...(omitted === 0 ? [] : [`(${String(omitted)} earlier messages omitted)`]),
    // A blank line between messages, not just between their quote blocks.
    // Consecutive `>` lines are one blockquote to every markdown reader and to
    // both CLIs, so without the separator four requests arrive as one paragraph
    // and the narrowing they describe is lost.
    ...kept.flatMap((text, index) => [...(index === 0 ? [] : ['']), quote(text)]),
    ...(kept.length === 0 ? ['(nothing has been asked in this conversation yet)'] : []),
    '',
    /*
     * Fenced and attributed, for the reason the doc comment gives: a reader told
     * these are its own recollections writes "I did X". Told they are Chorus's
     * record, it writes what the record shows.
     *
     * Each section says what its absence means, because an empty list is
     * ambiguous in exactly the direction that produces a wrong board — "no failed
     * commands" and "no commands were run" are different states, and a model
     * given a blank will pick the flattering one.
     */
    "--- what Chorus's log records. These are facts, not your recollection. ---",
    '',
    ledger.files.length === 0
      ? 'Files changed: none recorded.'
      : `Files changed, oldest first: ${ledger.files.join(', ')}`,
    '',
    ledger.failed.length === 0
      ? 'Failed commands: none recorded. This does not mean the tests passed — it'
      : 'Failed commands:',
    ...(ledger.failed.length === 0
      ? ['means nothing in this conversation exited non-zero.']
      : ledger.failed.map((line) => `- ${line}`)),
    '',
    ...(ledger.errors.length === 0
      ? ['Errors: none recorded.']
      : ['Errors:', ...ledger.errors.map((line) => `- ${line}`)]),
    '',
    '--- end of what you know ---',
  ].join('\n')
}

/**
 * What `Go` actually sends, in place of the word "go".
 *
 * Built here rather than passed in, for the reason `shared/ipc.ts` states about
 * the aside prompts: prompt content arriving from the renderer is the same class
 * of problem as an unverified source event. The IPC carries the *intent*; the
 * words are the log's side of the boundary.
 *
 * **Short on purpose, unlike its neighbours.** `explainPrompt` and `recapPrompt`
 * are long because they are asking for a shape the model would not otherwise
 * produce — a hundred words of plain prose, a five-heading board. This asks for
 * the thing the agent has *already said it would do*, so most of what could be
 * written here would be re-specifying work that is already specified one message
 * up. Every line below earns its place by naming a way that goes wrong.
 *
 * The last paragraph is the load-bearing one, and it exists because the trigger
 * is a heuristic. `offersToAct` reads prose and will sometimes be wrong; measured
 * over 1,276 real replies it shows on about one turn in nine and refuses far more
 * than it accepts, but "far more" is not "always". Without that paragraph a
 * misfire is an agent picking an option nobody chose; with it, a misfire is an
 * agent answering the question — which is what typing nothing would have got.
 * A heuristic that cannot be perfect is made survivable in the prompt rather
 * than by more regex.
 */
export function goPrompt(): string {
  return [
    'Go ahead with what you just proposed.',
    '',
    // The failure `recapPrompt` also had to name: asked to proceed, a model
    // frequently restates the plan first and calls that the turn.
    'You have already described it, so do not restate it and do not re-plan it.',
    'Start with the doing.',
    '',
    'Work to the end of what you proposed. Stop before the end only if a decision',
    'is genuinely blocking — and then ask that one question and nothing else.',
    '',
    // The trigger is a heuristic over prose. This is what makes it survivable.
    'If you were asking me something rather than offering to act, answer the',
    'question instead. If you are waiting on a decision only I can make, say which',
    'one. Do not guess at what I would have chosen.',
  ].join('\n')
}

/**
 * A decision reached in an aside, carried back into the conversation it came from.
 *
 * An aside is where you work out *whether* to go on — you ask "where are we",
 * read the answer, and conclude "run the tests" or "hold on". Until now that
 * conclusion had nowhere to go: `aside:promote` turns the side question into a
 * third conversation, which takes the thread further away from the work rather
 * than returning to it. This is the return.
 *
 * **The directive leads, and that is a routing constraint rather than a style
 * choice.** `parseMentions` reads mentions only at the *start* of the text, so a
 * provenance line above `@claude run the tests` would leave the mention
 * unparsed and the message routed by `lastAddressed` — to whichever agent
 * happened to speak last, which is exactly the wrong one often enough to matter.
 * Anything added therefore goes underneath.
 *
 * **A reference, not a transcript.** Forwarding the whole side exchange would
 * put its prose in the parent's log, where `catchup.ts` makes every other agent
 * read and summarise it — the cost C-004 exists to measure, paid on every side
 * question anyone ever asks. One line naming what the aside was about is enough
 * for the reply to make sense to a reader a week later, which is the bar the log
 * is held to.
 *
 * The excerpt is flattened and clipped because it is provenance, not content: it
 * says *which* passage this came from, and a paragraph of it in the composer's
 * own transcript would bury the instruction it is annotating.
 */
export function forwardedFromAside(directive: string, excerpt: string): string {
  const trimmed = directive.trim()
  const flat = excerpt.replace(/\s+/g, ' ').trim()
  if (flat === '') return trimmed
  const clipped = flat.length > 120 ? `${flat.slice(0, 119).trimEnd()}…` : flat
  return `${trimmed}\n\n_(from a side question about “${clipped}”)_`
}

/** Long enough for a cold provider start, short enough not to look like a hang. */
const REOPEN_TIMEOUT_MS = 20_000

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export interface SendResult {
  readonly targets: readonly AgentId[]
}

/** What a restore hands back. Named so the single-flight guard and the work it
 *  guards cannot drift apart. */
interface RestoredConversations {
  sessions: {
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
    unread: number
    draft: string
    planning: boolean
  }[]
  workspace: WorkspaceSnapshot | null
}

export class ChorusRuntime {
  private readonly active = new Map<string, ActiveConversation>()
  /**
   * The restore in flight, so two callers cannot both perform it.
   *
   * `restoreOpenConversations` deduplicates against `this.active`, which only
   * helps once a conversation has finished reopening and registered itself.
   * Two *concurrent* calls both find `active` empty and both start agents for
   * every saved conversation — measured as paired `sessions reopened` log lines
   * milliseconds apart, and two starts for one conversation at seq 159790 and
   * 159795.
   *
   * The second caller is React's Strict Mode, which invokes the startup effect
   * twice in development; but the guard belongs here rather than in the renderer
   * because "start one set of agents per conversation" is main's invariant to
   * keep, and any other caller — a reload, a second window — would break it the
   * same way.
   *
   * Held only for the duration of the call. A later restore is a real request
   * and gets its own run, where the `active` check is the right one.
   */
  private restoring: Promise<RestoredConversations> | null = null
  /**
   * Live asides, by their own conversation id.
   *
   * Separate from `active` on purpose: an aside is not a session. Nothing that
   * walks open conversations — restore, the sidebar, quit — should find one,
   * and keeping them in the same map is how they would.
   */
  private readonly asides = new Map<
    string,
    {
      service: ConversationService
      parentId: string
      excerpt: string
      agentId: AgentId
      /**
       * The language this card answers in, or `''` when it names none.
       *
       * Held for the follow-ups: only the opening prompt used to name it, so a
       * second question in the same card came back in English however the card
       * was opened.
       */
      language: string
    }
  >()
  /**
   * The terminal panels' shells.
   *
   * Held by the runtime because a session terminal's lifetime is a
   * conversation's, and because its working directory is one only the runtime
   * knows. The global terminal is inside the same service but outside that
   * lifetime — the service keeps it in its own field for the same reason
   * `asides` is not in `active`, and `close()` below drains it explicitly for
   * the same reason too.
   */
  private readonly terminals = new TerminalService({
    cwdFor: (ref) =>
      ref.scope === 'global' ? homedir() : (this.active.get(ref.conversationId)?.cwd ?? homedir()),
  })
  /** Last renderer-owned editor arrangement, persisted beside the active sessions. */
  private workspaceSnapshot: WorkspaceSnapshot | null = null
  /** The latest windows each provider reported, for a window opened later. */
  private readonly limits = new Map<AgentId, readonly UsageWindow[]>()
  private onLimits: ((push: { agentId: AgentId; windows: UsageWindow[] }) => void) | undefined
  private onContextUsage: ((push: ContextUsagePush) => void) | undefined
  private onTasks: ((push: TasksPush) => void) | undefined
  private onActivity: ((push: ActivityPush) => void) | undefined
  /**
   * The last model list each agent reported, for the settings sheet.
   *
   * The sheet can be opened with nothing running, and `supportedModels()` is a
   * control request to a live CLI. An installed CLI's list does not change, so
   * remembering what a session already answered is both cheaper and available
   * when no session is.
   */
  /**
   * What each agent's catalogue is doing, not just what is in it.
   *
   * A list and a length cannot say why it is empty. Discovery discarded an empty
   * answer and swallowed a failure, so "not asked yet", "asked and offered
   * nothing" and "asked and it broke" were one indistinguishable silence — and a
   * sheet cannot be honest about an agent that reports nothing until they are
   * separate facts.
   */
  private readonly knownModelsByAgent = new Map<
    AgentId,
    { status: 'unqueried' | 'loading' | 'ready' | 'failed'; models: readonly ModelChoice[] }
  >()

  private constructor(
    private readonly db: SqliteHandle,
    readonly store: EventStore,
    private readonly adapters: Map<AgentId, AgentAdapter>,
    readonly log: Logger,
    /** Where the note about what was open is kept, next to the log and the db. */
    private readonly userDataPath: string
  ) {}

  static open(
    userDataPath: string,
    log: Logger,
    adapters?: Map<AgentId, AgentAdapter>
  ): ChorusRuntime {
    const path = join(userDataPath, 'chorus.db')
    const { db, store, recovered } = openOrRecover(path, userDataPath)
    if (recovered !== null) log.warn('database was unreadable and was moved aside', { recovered })

    /*
     * Close sessions the log still believes are running.
     *
     * A crash leaves `session.started` with no `session.ended`, so without this
     * the app boots claiming agents are alive that died with the process — and
     * the UI would show them as live.
     */
    const { closed } = store.reconcileOrphanedSessions()
    if (closed > 0) log.warn('closed sessions orphaned by a crash', { closed })
    log.info('runtime ready', { events: store.lastSeq() })

    return new ChorusRuntime(db, store, adapters ?? defaultAdapters(), log, userDataPath)
  }

  /**
   * Grants for one conversation, seeded with what the user answered permanently.
   *
   * The remembered set is machine-wide and the same for every room — answered
   * once, which is the whole point — while the session half stays per
   * conversation as before. Written back on every addition rather than at quit,
   * because a decision lost to a crash is a decision the user has to make twice.
   */
  private newGrants(): SessionGrants {
    return new SessionGrants({
      keys: readRemembered(this.userDataPath),
      onRemember: (keys) => {
        writeRemembered(this.userDataPath, keys)
        this.log.info('remembered a permission permanently', { total: keys.length })
      },
    })
  }

  /** Told whenever a provider reports its account limits. */
  onLimitsReported(listener: (push: { agentId: AgentId; windows: UsageWindow[] }) => void): void {
    this.onLimits = listener
  }

  /**
   * Told how full a conversation's agent has filled its context window.
   *
   * Scoped by conversation, unlike limits: a plan window belongs to the account
   * and reads the same wherever it is asked from, while this belongs to one
   * agent in one conversation. Not remembered across restarts — a figure from
   * before a restart describes a context that no longer exists.
   */
  onContextUsageReported(listener: (push: ContextUsagePush) => void): void {
    this.onContextUsage = listener
  }

  /**
   * Told what each conversation's agents have left running.
   *
   * Not remembered across restarts, and deliberately not seeded on reopen: the
   * processes belonged to a session that has ended. The next change repopulates
   * it, and until then nothing running is the truthful answer.
   */
  onTasksReported(listener: (push: TasksPush) => void): void {
    this.onTasks = listener
  }

  /**
   * Told what each conversation's agents say they are doing.
   *
   * Nothing is remembered and nothing is seeded on reopen, for a stronger
   * version of the reason above: this describes an agent mid-turn, and there is
   * no turn in flight when a window opens. The next thing the provider says
   * repopulates it; until then, saying nothing in particular is the truth.
   */
  onActivityReported(listener: (push: ActivityPush) => void): void {
    this.onActivity = listener
  }

  /** What each provider last reported, so a new window is not born blank. */
  knownLimits(): { agentId: AgentId; windows: UsageWindow[] }[] {
    return [...this.limits].map(([agentId, windows]) => ({ agentId, windows: [...windows] }))
  }

  /** Push target for the renderer. Fires only after a commit. */
  subscribe(listener: (events: readonly StoredEvent[]) => void): () => void {
    return this.store.subscribe(listener)
  }

  availableAgents(): AgentId[] {
    return [...this.adapters.keys()]
  }

  availableProfiles(): { id: string; name: string; summary: string }[] {
    return PROFILES.map(({ id, name, summary }) => ({ id, name, summary }))
  }

  /** Everything the user has granted for this session, for the audit view. */
  sessionGrants(conversationId: string): { key: string; describe: string }[] {
    const first = [...this.require(conversationId).participants.values()][0]
    return first?.service.sessionGrants() ?? []
  }

  async startConversation(options: StartConversationOptions): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
  }> {
    if (options.agents.length === 0) throw new Error('A conversation needs at least one agent')

    /*
     * Check the directory before spawning anything.
     *
     * A missing cwd makes the spawn fail with ENOENT, and the Claude SDK
     * reports that as "the native binary failed to launch — this usually means
     * the binary does not match this system's libc". That message sent a real
     * user hunting a nonexistent architecture problem, and the supervisor then
     * retried it six times. Say what is actually wrong instead.
     */
    /*
     * An empty directory is allowed and means "start at home".
     *
     * The filesystem is not scoped to a project (§4.4), so a directory is a
     * starting point rather than a boundary — and requiring one up front asks
     * the user to decide something they can just tell the agent later.
     */
    const cwd = options.cwd.trim() === '' ? homedir() : options.cwd
    const problem = describeDirectory(cwd)
    if (problem !== null) throw new Error(problem)

    const conversationId = newConversationId()
    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'conversation.created',
        projectId: options.projectId ?? cwd,
        // The folder is what a conversation is about until you say otherwise,
        // and it is a better answer than "Untitled" for one you never rename.
        title: options.title ?? folderName(cwd),
      },
    })

    const profile = profileById(options.profileId ?? '')

    // One set of grants for the whole conversation: allowing something for
    // Codex should not mean being asked again the moment Claude does the same.
    const grants = this.newGrants()

    // Started in parallel: two agents booting sequentially doubles the wait for
    // no reason, and one failing should not hide the other.
    const started = await Promise.allSettled(
      options.agents.map((agentId) =>
        /*
         * Resolved per agent, and resolved *here*.
         *
         * This path used to build its own `SessionOpts` with a cwd, a sandbox
         * and no model at all — so the sheet headed "New sessions start with"
         * did nothing for new sessions, the one case its label promises. The
         * provider sandbox still mirrors the profile, for defence in depth
         * rather than relying only on our own gate (plan §4.4).
         */
        this.startParticipant(
          agentId,
          conversationId,
          (resuming) => this.sessionOptsFor({ cwd, profile }, agentId, resuming),
          profile,
          grants
        )
      )
    )

    const conversation: ActiveConversation = {
      conversationId,
      participants: new Map(),
      grants,
      profile,
      cwd,
      title: options.title ?? folderName(cwd),
      lastAddressed: undefined,
      // A new room has nothing unread in it, and the log's end is what "nothing"
      // means — seeding 0 would count the whole database as news.
      lastSeenSeq: this.store.lastSeq(),
      draft: '',
      planning: false,
    }
    const failures: string[] = []

    for (const outcome of started) {
      if (outcome.status === 'fulfilled') {
        conversation.participants.set(outcome.value.agentId, outcome.value)
      } else {
        failures.push(
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        )
      }
    }

    if (conversation.participants.size === 0) {
      throw new Error(failures.join('; ') || 'No agent could be started')
    }

    // A partial start belongs in the transcript: it should say why an agent the
    // user asked for is absent, rather than silently omitting it.
    for (const message of failures) {
      this.log.error('an agent could not be started', undefined, { conversationId, message })
      this.store.append({
        conversationId,
        actor: 'system',
        payload: { type: 'error.raised', message, recoverable: false },
      })
    }

    this.log.info('conversation started', {
      conversationId,
      agents: [...conversation.participants.keys()].join(','),
      profile: profile.id,
    })
    this.active.set(conversationId, conversation)
    this.rememberOpen()
    return {
      conversationId,
      participants: [...conversation.participants.keys()],
      profileId: profile.id,
      cwd,
      title: conversation.title,
    }
  }

  /**
   * Logs the user's message **once**, then routes it.
   *
   * Logging inside each participant would make the transcript show the user
   * repeating themselves once per agent.
   */
  async send(conversationId: string, text: string, intent?: 'go'): Promise<SendResult> {
    const conversation = this.require(conversationId)
    const participants = [...conversation.participants.keys()]
    const route = parseMentions(text, {
      participants,
      lastAddressed: conversation.lastAddressed,
    })

    if (route.targets.length === 0) throw new Error('No agent is available in this conversation')

    const stored = this.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text },
    })
    // Null only once the store is closed, which means the app is quitting.
    // Delivering a message the log has no record of would be worse than not.
    if (stored === null) throw new Error('Chorus is shutting down')
    conversation.lastAddressed = route.targets.at(-1)

    /*
     * Logged before the delivery is awaited, and again after it returns.
     *
     * C-043 is open because a send that neither lands nor fails leaves the pane
     * waiting for a turn that never starts — and the log said nothing at all
     * about it, so the only evidence was a screenshot. `deliver` is awaited
     * below and an adapter that hangs there hangs this call, which hangs the
     * IPC, which is invisible from every side.
     *
     * A pair of lines makes that shape readable after the fact: `accepted`
     * without a matching `delivered` is a delivery that hung, and neither line
     * is a send that never reached main at all. Cheap, and only once per turn.
     */
    this.log.info('message accepted', { conversationId, targets: route.targets.join(',') })

    // Filtered rather than optional-chained: `Promise.all` over a list that can
    // contain `undefined` is a silent no-op waiting to happen.
    await Promise.all(
      route.targets
        .map((agentId) => conversation.participants.get(agentId))
        .filter((p) => p !== undefined)
        .map(async (p) => {
          /*
           * Read up to — not including — the message being delivered: that one
           * is the live turn, not history. Anything appended after this read
           * keeps a higher `seq` than the watermark below, so it is caught up
           * next time rather than lost.
           */
          const missed = this.store
            .read(conversationId, { afterSeq: p.seenSeq })
            .filter((e) => e.seq < stored.seq)

          /*
           * The seed goes before the user's words, once.
           *
           * It is context about what already happened, so it reads as
           * background rather than as an instruction — and it is dropped after
           * one delivery whether or not the turn succeeds, because a seed that
           * could arrive twice is worse than one that arrives late.
           */
          /*
           * What the agent reads, which is not always what the log kept.
           *
           * `route.text` is the typed message with its leading mentions removed.
           * An intent replaces it: the transcript keeps `@claude Go ahead.` — a
           * line the user would recognise as their own — and the agent receives
           * `goPrompt()`. The same split `sendUserMessage(text, delivered)` makes
           * for asides, for the reason stated there: logging the wrapper puts
           * words in the user's mouth in their own transcript.
           *
           * Routing is unaffected. It was decided from the *logged* text above,
           * so the mention still picks the agent whose reply the button sat
           * under — and `lastAddressed` is not a reliable stand-in for that.
           */
          const body = intent === 'go' ? goPrompt() : route.text
          const seeded = p.seedContext === undefined ? body : `${p.seedContext}\n\n${body}`
          delete p.seedContext

          await p.service.deliver(
            withCatchup(
              {
                recipient: p.agentId,
                participants,
                events: missed,
                ...(p.catchupBudget === undefined ? {} : { maxTotalChars: p.catchupBudget }),
              },
              seeded
            )
          )
          p.seenSeq = stored.seq
          delete p.catchupBudget
        })
    )
    this.log.info('message delivered', { conversationId, targets: route.targets.join(',') })
    // Cheap, and it keeps the resume refs current if the app dies without a
    // clean quit.
    this.rememberOpen()
    return { targets: route.targets }
  }

  /**
   * Opens an aside: a fork of one agent, asked about one passage of one reply.
   *
   * Nothing here touches the parent. No `lastAddressed`, no `seenSeq`, no draft,
   * no `rememberOpen` — an aside is not a turn, and a conversation that
   * re-ordered its routing because someone asked a footnote would be exactly the
   * derailment this feature exists to avoid.
   *
   * **The source is re-resolved from the log, never trusted from the caller.**
   * The renderer sends an event id and the text it believes it selected; both
   * are checked against what the store actually holds. A caller that could name
   * any event and any excerpt could put words in an agent's mouth and have them
   * quoted back as its own.
   */
  async openAside(request: {
    conversationId: string
    sourceEventId: string
    excerpt: string
    /**
     * Why it is being opened, and therefore what the fork is first asked.
     *
     * `explanation` carries its own first turn: there is nothing for the user to
     * type, so opening and asking are one act. `question` opens empty and waits.
     * `translation` and `recap` behave as `explanation` does here.
     */
    purpose?: 'question' | 'explanation' | 'translation' | 'recap'
    /**
     * Optional, and usually absent.
     *
     * The card opens this the moment it appears, before the user has typed
     * anything, so the CLI is spawning and loading its config while they write
     * the question rather than afterwards. Measured, that is about 2.6 of the
     * 4.2 seconds — two thirds of the wait was a process starting, not an agent
     * thinking. Asking without a question is what lets that happen in parallel.
     */
    question?: string
  }): Promise<{ asideId: string; language: string }> {
    const parent = this.active.get(request.conversationId)
    if (parent === undefined) throw new Error('That conversation is not open')

    const source = this.store
      .read(request.conversationId)
      .find((e) => e.id === request.sourceEventId)
    if (source === undefined) throw new Error('That passage is no longer in the log')

    /*
     * Only a finished agent message. A fork inherits the session *as persisted*,
     * so it cannot see a turn still in flight — asked about a reply that is
     * still arriving it answers that no such reply exists. Measured, not assumed:
     * see the plan's STATUS.
     */
    if (source.payload.type !== 'agent.message.completed') {
      throw new Error('An aside can only be asked about a finished reply')
    }
    const said = source.payload.text
    const excerpt = request.excerpt.trim()
    /*
     * Checked against the reply as the transcript reads, not as the log stores
     * it — `containsPassage` carries both the projection and why the comparison
     * ignores serialization-only spacing, measured against the running app.
     *
     * The guard stays what it was for: the renderer is the least trustworthy
     * thing in the process tree, and a caller that could name any event and any
     * excerpt could put words in an agent's mouth and have them quoted back as
     * its own.
     */
    if (!containsPassage({ said, excerpt })) {
      throw new Error('That passage is not part of that reply')
    }

    const agentId = source.actor
    if (agentId !== 'codex' && agentId !== 'claude') {
      throw new Error('Only an agent can be asked about what it said')
    }
    const participant = parent.participants.get(agentId)
    if (participant === undefined) throw new Error(`${agentId} is no longer in this conversation`)

    const adapter = this.adapters.get(agentId)
    /*
     * A recap does not fork, so none of the three checks below apply to it.
     *
     * They all guard the same thing: that the branch being taken genuinely holds
     * the passage. A recap reads nothing from the agent's memory — its whole
     * input is the log — so there is no branch to get wrong.
     *
     * This is not tidiness. `sessionRef` is *live* state: Claude's real id only
     * arrives with its first message of the process, so an agent that has been
     * reopened and not yet spoken has none. `finalKey` comes from the log, which
     * survives a restart, so the button was offered on every replayed transcript
     * and then refused — dead at the one moment a recap is most wanted, which is
     * when you reopen the app and ask where you were. Found by driving it, not by
     * reading it.
     */
    const recapping = (request.purpose ?? 'question') === 'recap'
    if (!recapping) {
      if (adapter?.fork === undefined) throw new Error(`${agentId} cannot be forked`)
      if (participant.session.sessionRef === '') {
        throw new Error(`${agentId} has not started a session yet`)
      }
    }
    if (adapter === undefined) throw new Error(`${agentId} is not available`)

    /*
     * The passage must belong to the session about to be forked.
     *
     * Source authenticity says the reply is genuinely that agent's; it says
     * nothing about *which* of its sessions said it. An agent taken out of a
     * conversation and brought back gets a new session, and forking that one to
     * ask about a reply from the old one produces an agent politely explaining
     * something it has never seen — the same failure as forking mid-turn, and
     * just as hard to recognise as a bug rather than a bad answer.
     *
     * The check is the log's own: the last `session.started` for this agent at
     * or before the reply must name the ref the participant is running now.
     */
    /*
     * Only a session the agent *started afresh* can have missed the passage.
     *
     * Reopening a conversation writes a new `session.started` too, and the first
     * version of this refused on any newer start at all — so the option
     * disappeared after every relaunch, which is most of the time. A resume
     * rejoins the same provider session and holds the same context; it is
     * `addParticipant` that produces one which has never seen the reply.
     *
     * Compared by *event*, not by `sessionRef`. Claude's real id arrives with
     * its first message, so `session.started` is written with an empty string —
     * an earlier attempt skipped empty refs and therefore never fired for Claude
     * at all, the provider it most needed to fire for.
     *
     * `resumed` absent means an event written before the flag existed, and those
     * are treated as resumes. The two ways of being wrong are not equal: refusing
     * wrongly takes the feature away, while allowing wrongly is the behaviour
     * that existed before this guard did.
     */
    const freshStartAfter = recapping
      ? undefined
      : this.store
          .read(request.conversationId)
          .find(
            (e) =>
              e.seq > source.seq &&
              e.payload.type === 'session.started' &&
              e.payload.agentId === agentId &&
              e.payload.resumed === false
          )
    if (freshStartAfter !== undefined) {
      throw new Error(`${agentId} has started a new session since it said that`)
    }

    /*
     * The language is read here, and read **before** anything is spawned.
     *
     * Not accepted from the caller: the renderer already has its source event
     * re-resolved because it renders untrusted agent output, and a language
     * string is prompt content — the same class of problem wearing a smaller
     * word. And checked first, because a refusal after the fork leaves a CLI
     * running that nobody has a handle to.
     */
    const purpose = request.purpose ?? 'question'
    /*
     * Both language-bearing purposes read the same setting, and read it here.
     *
     * They use it differently — an explanation is written *in* it however the
     * user qualified it, a translation takes the language and renders its
     * standard form — but that distinction belongs in the prompts, not in which
     * value is fetched. One field, one read, two documented readings.
     */
    const needsLanguage = purpose === 'explanation' || purpose === 'translation'
    const language = needsLanguage ? readSettings(this.userDataPath).explainLanguage : ''
    if (needsLanguage && language === '') {
      throw new Error(
        purpose === 'translation'
          ? 'No language is set to translate into'
          : 'No language is set to explain in'
      )
    }

    /*
     * Everything a recap will know, read here, before anything is spawned.
     *
     * One read of the log for both halves: the user's own messages, which are the
     * task, and `recapLedger`'s counted facts, which are the evidence. Read from
     * the **store** rather than from an agent's memory, which is the whole design
     * — the memory is what drifted, and after a reopen there may not be one.
     *
     * `parseMentions` is used for its `text`, documented as "the message with its
     * leading mentions removed, as the agent should see it". `send` logs the raw
     * typed line (`user.message`, above), so `@claude ` is in there and is
     * routing scaffolding, not task. Both agent ids are named rather than the
     * live participants: the job here is stripping scaffolding, not routing, and
     * a mention of an agent since removed from the room is scaffolding too.
     */
    const history = recapping ? this.store.read(request.conversationId) : []
    const asked = history
      .filter((e) => e.payload.type === 'user.message')
      .map((e) =>
        e.payload.type === 'user.message'
          ? parseMentions(e.payload.text, { participants: ['codex', 'claude'] }).text
          : ''
      )
    const ledger = recapLedger(history, parent.cwd)

    const opts: SessionOpts = {
      cwd: parent.cwd,
      sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
    }
    /*
     * A recap starts a session; every other purpose branches one.
     *
     * `start` rather than `fork` because a recap must read the log and nothing
     * else — a reader carrying the conversation in its context would answer from
     * the memory this feature exists to stop trusting, and would be unavailable
     * whenever that memory is (see the guards above). It also costs no more: a
     * fork was already a cold CLI start, measured at about 2.6 seconds.
     *
     * `inherits: 'config'` has no counterpart on `start`, and needs none —
     * `settingSources` is deliberately omitted in the adapters, so a fresh
     * session loads the user's hooks, skills and CLAUDE.md anyway.
     */
    let forked: AgentSession
    if (recapping) {
      forked = await adapter.start(opts)
    } else if (adapter.fork !== undefined) {
      forked = await adapter.fork(participant.session.sessionRef, {
        ...opts,
        // Decided with the user: the aside inherits the user's configuration,
        // so hooks, skills and CLAUDE.md load exactly as they do in the room.
        inherits: 'config',
      })
    } else {
      // Unreachable — the guard above refuses this before anything is read. Kept
      // as a throw rather than an assertion so the narrowing is the compiler's
      // rather than a claim this file makes about a check fifty lines away.
      throw new Error(`${agentId} cannot be forked`)
    }

    const asideId = newConversationId()

    /*
     * Everything past the fork is wrapped, because everything past the fork can
     * fail with a provider process already running.
     *
     * Appending, attaching, the health check and the first send each have their
     * own way of going wrong, and any of them leaving a live CLI behind is a
     * leak nobody has a handle to — the caller never learns an id, so it cannot
     * close what it does not know about. The send is the sharp one: it happens
     * after the service is already in `this.asides`, so failing there strands an
     * entry as well as a process.
     */
    try {
      this.store.append({
        conversationId: asideId,
        actor: 'user',
        payload: {
          type: 'conversation.created',
          projectId: parent.cwd,
          /*
           * A recap titles itself with the task, not with the passage.
           *
           * Every other purpose is *about* the excerpt, so the excerpt is the
           * title. A recap's excerpt is the whole last reply — it is there to
           * authenticate the source, not to be the subject — and eighty
           * characters of it would title the row with whatever tangent the reply
           * happened to open on, which is the thing being escaped. The latest
           * user message is the closest the log has to "what this is about".
           */
          title:
            purpose === 'recap'
              ? (asked
                  .filter((text) => text !== '')
                  .at(-1)
                  ?.slice(0, 80) ?? 'Recap')
              : excerpt.slice(0, 80),
          aside: {
            parentId: request.conversationId,
            sourceEventId: request.sourceEventId,
            purpose,
            // The language as it was, not as it will be. Settings change.
            ...(language === '' ? {} : { language }),
          },
        },
      })

      const service = new ConversationService({
        store: this.store,
        conversationId: asideId,
        adapter,
        profile: profileById('read-only'),
        /*
         * Its own grants, deliberately empty — **not** the parent's.
         *
         * A grant outranks an `ask` and an aside never asks, so carrying them
         * would mean a previously allowed `npm publish`, or a granted MCP tool
         * that posts outward, running silently inside a fork nobody is watching.
         * Claude's sandbox is emulated, so nothing below would have stopped it.
         *
         * Little is lost. Grants exist to stop the user being re-asked, and an
         * aside does not ask; what they would add here is the power to act,
         * which is the one thing an explanation must not have. `SAFE_READS`
         * still lets it go and look. The user's *configuration* is a separate
         * thing and still inherited in full — see `ForkOpts.inherits`.
         */
        grants: new SessionGrants(),
        neverAsks: true,
      })
      await service.attach(forked, opts, await adapter.health())

      /*
       * `language` is held for the follow-ups, not for the first turn.
       *
       * The opening prompt names it and then the card stays open for as long as
       * the conversation in it lasts; without this, question two came back in
       * English. Empty for a question or a recap, which name no language.
       */
      this.asides.set(asideId, {
        service,
        parentId: request.conversationId,
        excerpt,
        agentId,
        language,
      })

      try {
        if (purpose === 'explanation') {
          await service.sendUserMessage(
            `Explain this in ${language}.`,
            explainPrompt(excerpt, language)
          )
        } else if (purpose === 'translation') {
          // Two arguments, as above: the log keeps the short line, the model
          // gets the prompt. What is read back later should be what was asked
          // for, not the instructions that carried it.
          await service.sendUserMessage(
            `Translate this into ${language}.`,
            translatePrompt(excerpt, language)
          )
        } else if (purpose === 'recap') {
          // The excerpt is not passed, and that is the branch. Every other
          // purpose quotes the passage into its prompt; a recap whose prompt
          // carried the reply would summarise the reply, which is the failure
          // this exists to fix rather than a smaller version of it.
          await service.sendUserMessage('Where are we?', recapPrompt(asked, ledger))
        } else if (request.question !== undefined && request.question !== '') {
          await service.sendUserMessage(request.question, asideQuestion(excerpt, request.question))
        }
      } catch (error) {
        this.asides.delete(asideId)
        await service.close('closed')
        throw error
      }

      return { asideId, language }
    } catch (error) {
      // The fork is ours until an id is handed back. Nobody else can close it.
      await forked.close()
      throw error
    }
  }

  /** A follow-up in an aside that is still alive. */
  async askAside(asideId: string, question: string): Promise<void> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) {
      // Its fork was ephemeral and is gone. The transcript survives in the log;
      // continuing it does not, which is why a reopened aside is view-only.
      throw new Error('That aside has ended — ask again to start a new one')
    }
    await aside.service.sendUserMessage(
      question,
      asideQuestion(aside.excerpt, question, aside.language)
    )
  }

  /**
   * Sends a decision from an aside into the conversation the aside came from.
   *
   * Deliberately `this.send` rather than a path of its own, and that is the
   * whole design: the routing, the log entry, the catch-up watermark and the
   * mention handling are the ones a typed message already gets, so a forwarded
   * directive cannot drift from a typed one. It is not a new kind of event
   * either — the user really did author these words, so `user.message` is what
   * it is, and the provenance line in the text is what says where they were
   * written rather than a new payload type three switches would have to learn.
   *
   * **The parent is revalidated, not trusted from when the aside opened.** It
   * may have been closed, or had its last agent removed, in the minutes someone
   * spent reading the side answer — `promoteAside` revalidates for the same
   * reason and `send` would otherwise throw something about a missing
   * conversation, which is true and useless.
   *
   * The aside is left open. Forwarding is not promoting and not closing: having
   * decided to run the tests, the next thing you want is usually to ask the same
   * fork what it thought about the result.
   */
  async forwardAside(asideId: string, directive: string): Promise<SendResult> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) {
      throw new Error('That aside has ended — ask again to start a new one')
    }
    if (this.active.get(aside.parentId) === undefined) {
      throw new Error('The conversation this came from is no longer open')
    }
    return this.send(aside.parentId, forwardedFromAside(directive, aside.excerpt))
  }

  /**
   * In flight promotions, so two clicks cannot make two permanent branches.
   *
   * Keyed by aside id and holding the promise rather than a boolean: a second
   * caller should get the same answer as the first, not a refusal and not a
   * second provider session on disk.
   */
  private readonly promoting = new Map<string, Promise<PromotedConversation>>()

  /**
   * Turns an aside into a conversation of its own.
   *
   * The aside stops being a tooltip and becomes a room: a pane, a profile, an
   * approval card, and a transcript that was already being kept. What it gains
   * is the ability to act — under permissions someone chose at this moment,
   * which is the explicit act that makes it safe.
   *
   * **The parent is forked, not the aside.** Both providers fork from disk and
   * an aside is deliberately never written there, so there is nothing of it to
   * fork. The parent is on disk, and forking it is what already gives an aside
   * its context — this one is simply kept.
   */
  async promoteAside(asideId: string, profileId: string): Promise<PromotedConversation> {
    const inFlight = this.promoting.get(asideId)
    if (inFlight !== undefined) return inFlight

    const run = this.runPromotion(asideId, profileId).finally(() => {
      this.promoting.delete(asideId)
    })
    this.promoting.set(asideId, run)
    return run
  }

  private async runPromotion(asideId: string, profileId: string): Promise<PromotedConversation> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) throw new Error('That aside has ended — ask again to start a new one')
    if (this.active.has(asideId)) throw new Error('That aside is already a conversation')

    /*
     * Not while it is still answering.
     *
     * Two services would otherwise write to one conversation — the ephemeral
     * fork finishing its turn and the promoted one starting — and the log would
     * interleave two agents' lifecycle events under a single id.
     */
    if (this.stillAnswering(asideId)) {
      throw new Error('Wait for the aside to finish answering, then open it as a conversation')
    }

    // Revalidated now, not trusted from when the aside was opened: the parent
    // may have been closed, the agent removed, or its session replaced since.
    const parent = this.active.get(aside.parentId)
    if (parent === undefined) throw new Error('The conversation this came from is no longer open')
    const { agentId } = aside
    const source = parent.participants.get(agentId)
    if (source === undefined) throw new Error(`${agentId} is no longer in that conversation`)
    if (source.session.sessionRef === '') {
      throw new Error(`${agentId} has not started a session yet`)
    }

    const profile = profileById(profileId)
    const seed = this.asideSeed(asideId, aside.excerpt)

    /*
     * The ephemeral fork is closed *before* the persistent one is opened.
     *
     * Ordering, not tidiness: it is the only way one conversation cannot have
     * two live services. If the fork below fails the aside is gone — but its
     * transcript is in the log, and losing the ability to continue a side
     * question is a smaller failure than two writers appending to one thread.
     */
    this.asides.delete(asideId)
    await aside.service.close('closed')

    const grants = this.newGrants()
    const where = { cwd: parent.cwd, profile }
    let participant
    try {
      participant = await this.startParticipant(
        agentId,
        asideId,
        (resuming) => this.sessionOptsFor(where, agentId, resuming),
        profile,
        grants,
        undefined,
        false,
        source.session.sessionRef
      )
    } catch (error) {
      throw new Error(
        `Could not open this as a conversation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }

    /*
     * The commit point. Everything above can fail and leave nothing but a
     * closed aside; from here the conversation exists.
     *
     * A failure to append is a failure to promote, so the branch just created is
     * closed rather than left running with nothing pointing at it — the same
     * reasoning as `openAside`'s cleanup.
     */
    try {
      this.store.append({
        conversationId: asideId,
        actor: 'user',
        payload: {
          type: 'aside.promoted',
          parentId: aside.parentId,
          sourceEventId: '',
        },
      })
    } catch (error) {
      await participant.service.close('closed')
      throw error
    }

    participant.seedContext = seed
    // Its watermark starts at the end: everything before this is either the
    // aside's own transcript, which the fork does not need told back to it, or
    // the seed above.
    participant.seenSeq = this.store.lastSeq()

    const conversation: ActiveConversation = {
      conversationId: asideId,
      participants: new Map([[agentId, participant]]),
      grants,
      profile,
      cwd: parent.cwd,
      title: aside.excerpt.slice(0, 80),
      lastAddressed: agentId,
      lastSeenSeq: 0,
      draft: '',
      planning: false,
    }
    this.active.set(asideId, conversation)
    this.rememberOpen()
    this.log.info('aside promoted', { asideId, parentId: aside.parentId, agentId, profileId })
    return {
      conversationId: asideId,
      participants: [agentId],
      profileId: profile.id,
      cwd: conversation.cwd,
      title: conversation.title,
      unread: 0,
    }
  }

  /**
   * Whether a conversation has a turn still in flight.
   *
   * Read off the log rather than asked of the service, which tracks no such
   * state — and the log is the thing that would be corrupted by a second writer,
   * so it is the right place to ask.
   */
  private stillAnswering(conversationId: string): boolean {
    let open = 0
    for (const event of this.store.read(conversationId)) {
      if (event.payload.type === 'turn.started') open += 1
      if (event.payload.type === 'turn.completed') open -= 1
    }
    return open > 0
  }

  /**
   * What the promoted room is told about where it came from.
   *
   * Its own transcript, framed as already handled. The fork it is built on has
   * the *work's* context but not the aside's — that conversation happened in a
   * branch this one is not descended from — so without this the room would not
   * know the question it was opened to continue.
   */
  private asideSeed(asideId: string, excerpt: string): string {
    const said = this.store
      .read(asideId)
      .flatMap((e) => (e.payload.type === 'agent.message.completed' ? [e.payload.text] : []))
      .join('\n\n')
      .trim()

    const quote = (text: string): string =>
      text
        .split('\n')
        .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
        .join('\n')

    return [
      'For context, this conversation began as a side question about a passage you',
      'had written. That exchange has already happened — you do not need to answer',
      'it again.',
      '',
      'The passage:',
      quote(excerpt),
      ...(said === '' ? [] : ['', 'What you said about it:', quote(said)]),
      '',
      'You are now in an ordinary conversation and may act on what is asked next.',
    ].join('\n')
  }

  /**
   * Holds a question's deadline off while someone is answering it.
   *
   * Asked of every participant rather than routed by agent: a `userInputId`
   * belongs to whichever service raised it, and the caller — a card — knows the
   * question but not which agent's queue it is sitting in. The first service
   * that recognises it answers; the rest return null, which is what "not mine"
   * means here.
   */

  /** Ends an aside's fork. Its transcript stays in the log. */
  async closeAside(asideId: string): Promise<void> {
    const aside = this.asides.get(asideId)
    if (aside === undefined) return
    this.asides.delete(asideId)
    await aside.service.close('closed')
  }

  /** The asides taken on a conversation, or on one reply within it. */
  listAsides(conversationId: string, sourceEventId?: string): AsideSummary[] {
    return this.store.listAsides(conversationId, sourceEventId)
  }

  /**
   * Builds the packet that would cross to another agent — without sending it.
   *
   * The user sees and edits this before anything moves. Agents keep separate
   * contexts, so a handoff *is* the cross-agent context; composing it silently
   * would be Chorus deciding what one agent knows about another (plan §4.5).
   */
  prepareHandoff(
    conversationId: string,
    options: {
      from: AgentId
      to: AgentId
      sourceEventIds: readonly string[]
      includeDiff?: boolean
      intent?: HandoffIntent
      note?: string
    }
  ): { brief: string; intent: HandoffIntent; summary: string; sourceCount: number } {
    const conversation = this.require(conversationId)
    if (!conversation.participants.has(options.to)) {
      throw new Error(`"${options.to}" is not in this conversation`)
    }

    const sources = this.sourcesFor(conversationId, options.sourceEventIds)
    if (sources.length === 0) throw new Error('Nothing was selected to hand off')

    const intent = options.intent ?? defaultIntent(options.from, options.to)
    const diff = options.includeDiff === true ? this.latestDiff(conversationId) : undefined

    return {
      intent,
      sourceCount: sources.length,
      brief: composeBrief({
        from: options.from,
        to: options.to,
        intent,
        sources,
        cwd: conversation.cwd,
        diff,
        note: options.note,
      }),
      summary: summariseHandoff({
        from: options.from,
        to: options.to,
        intent,
        sourceCount: sources.length,
        includesDiff: diff !== undefined && diff.trim() !== '',
      }),
    }
  }

  /** Records the handoff and delivers the brief the user approved. */
  async sendHandoff(
    conversationId: string,
    options: {
      from: AgentId
      to: AgentId
      sourceEventIds: readonly string[]
      brief: string
    }
  ): Promise<{ handoffId: string }> {
    const conversation = this.require(conversationId)
    const target = conversation.participants.get(options.to)
    if (target === undefined) throw new Error(`"${options.to}" is not in this conversation`)
    if (options.brief.trim() === '') throw new Error('The brief is empty')

    const handoffId = newHandoffId()
    this.store.append({
      conversationId,
      actor: 'user',
      payload: {
        type: 'handoff.created',
        handoffId,
        from: options.from,
        to: options.to,
        sourceEventIds: [...options.sourceEventIds],
        brief: options.brief,
      },
    })

    // The receiving agent is now the one an unaddressed follow-up continues with.
    conversation.lastAddressed = options.to
    // The brief is context the user curated by hand; replaying the same events
    // as catch-up on the next message would say it all twice.
    target.seenSeq = this.store.lastSeq()
    await target.service.deliver(options.brief)
    return { handoffId }
  }

  private sourcesFor(conversationId: string, eventIds: readonly string[]): HandoffSource[] {
    const wanted = new Set(eventIds)
    const sources: HandoffSource[] = []

    for (const event of this.store.read(conversationId)) {
      if (!wanted.has(event.id)) continue
      const payload = event.payload as { text?: string }
      if (typeof payload.text !== 'string' || payload.text.trim() === '') continue
      sources.push({ eventId: event.id, actor: event.actor, text: payload.text })
    }
    return sources
  }

  /** The most recent aggregate diff, when an agent produced one. */
  private latestDiff(conversationId: string): string | undefined {
    const diffs = this.store.read(conversationId, { types: ['diff.updated'] })
    const last = diffs.at(-1)?.payload as { unifiedDiff?: string } | undefined
    return last?.unifiedDiff
  }

  /**
   * Ends one conversation, leaving every other one running.
   *
   * Removed from `active` before its agents are closed, so a message sent into
   * the gap fails loudly rather than being handed to a session on its way out.
   */
  async closeConversation(conversationId: string): Promise<void> {
    const conversation = this.require(conversationId)
    this.active.delete(conversationId)
    this.rememberOpen()

    /*
     * The conversation's asides go with it. They fork its agents and are only
     * reachable from its transcript, so a closed conversation leaving live forks
     * behind is a leak with nothing left on screen to close them from.
     */
    const orphans = [...this.asides].filter(([, a]) => a.parentId === conversationId)
    for (const [id] of orphans) this.asides.delete(id)

    /*
     * The conversation's terminal goes with it, and only its own.
     *
     * Closing a *tab* must not reach this — that is a view operation and the
     * shell has to survive it, or backgrounding a tab would kill a running
     * build. This is the other thing: the conversation itself ending.
     */
    this.terminals.disposeSession(conversationId)

    await Promise.all([
      ...[...conversation.participants.values()].map((p) => p.service.close()),
      ...orphans.map(([, a]) => a.service.close()),
    ])
    this.log.info('conversation closed', {
      conversationId,
      remaining: this.active.size,
    })
  }

  /**
   * Reopens what was on screen last time.
   *
   * Called once at startup. A conversation whose directory has since been
   * deleted is dropped rather than failing the restore — the others are still
   * worth having, and the log keeps the one that could not come back.
   */
  async restoreOpenConversations(): Promise<RestoredConversations> {
    /* Single-flight: the second concurrent caller waits on the first rather than
       starting a duplicate set of agents. See `restoring`. */
    this.restoring ??= this.runRestore().finally(() => {
      this.restoring = null
    })
    return this.restoring
  }

  private async runRestore(): Promise<RestoredConversations> {
    const savedState = readOpenSessions(this.userDataPath)
    const saved = savedState.sessions
    this.workspaceSnapshot = savedState.workspace
    const restored: {
      conversationId: string
      participants: AgentId[]
      profileId: string
      cwd: string
      title: string
      unread: number
      draft: string
      planning: boolean
    }[] = []

    for (const entry of saved) {
      // Already open: restore is called once, but calling it twice must not
      // start a second set of agents for the same conversation.
      const open = this.active.get(entry.conversationId)
      if (open !== undefined) {
        restored.push({
          conversationId: entry.conversationId,
          participants: [...open.participants.keys()],
          profileId: open.profile.id,
          cwd: open.cwd,
          title: open.title,
          unread: this.unreadSince(entry.conversationId, open.lastSeenSeq),
          draft: open.draft,
          planning: open.planning,
        })
        continue
      }
      if (describeDirectory(entry.cwd) !== null) {
        this.log.warn('a session could not be reopened', {
          conversationId: entry.conversationId,
          cwd: entry.cwd,
        })
        continue
      }
      const conversation = await this.reopen(entry)
      if (conversation === null) continue
      restored.push({
        conversationId: entry.conversationId,
        participants: [...conversation.participants.keys()],
        profileId: conversation.profile.id,
        cwd: conversation.cwd,
        title: conversation.title,
        unread: this.unreadSince(entry.conversationId, entry.lastSeenSeq),
        draft: entry.draft,
        // Never restored: a mode is a property of a running session, and a
        // relaunch is a new one.
        planning: false,
      })
    }

    this.rememberOpen()
    if (restored.length > 0) this.log.info('sessions reopened', { count: restored.length })
    return { sessions: restored, workspace: this.workspaceSnapshot }
  }

  private async reopen(entry: OpenSession): Promise<ActiveConversation | null> {
    const profile = profileById(entry.profileId)
    const grants = this.newGrants()
    const conversation: ActiveConversation = {
      conversationId: entry.conversationId,
      participants: new Map(),
      grants,
      profile,
      cwd: entry.cwd,
      title: entry.title,
      lastAddressed: undefined,
      lastSeenSeq: entry.lastSeenSeq,
      draft: entry.draft,
      planning: false,
    }
    const started = await Promise.allSettled(
      entry.agents.map(async (agentId) => {
        /*
         * Resolved inside the loop, and left undecided about resuming.
         *
         * One object outside it meant every agent got the same model. Deciding
         * "this is a resume" out here was the second half of the same mistake:
         * an agent with no saved thread, or one whose resume fails, is started
         * fresh from this path and must get the configured model. Only
         * `startParticipant` knows which happened, so it asks.
         */
        const sessionOpts = (resuming: boolean): SessionOpts =>
          this.sessionOptsFor(conversation, agentId, resuming)
        /*
         * An empty ref is not a thread.
         *
         * Claude's session id only arrives with its first message, so an agent
         * that joined and never spoke is written down with `""`. Passing that to
         * `resume` asks the provider to continue a conversation with no name,
         * and it does not answer — which is what left the window blank rather
         * than falling back to a fresh session.
         */
        const saved = entry.sessionRefs[agentId]
        const ref = saved === undefined || saved.trim() === '' ? undefined : saved
        /*
         * Bounded, because reopening is the one place a provider can hold the
         * whole app hostage.
         *
         * A stale thread does not always fail — `thread/resume` on an id the
         * provider has forgotten can simply never answer, and the window stayed
         * blank waiting for it. One agent taking too long now costs that agent,
         * not the session and not the app.
         */
        const participant = await withTimeout(
          this.startParticipant(
            agentId,
            entry.conversationId,
            sessionOpts,
            profile,
            grants,
            ref,
            true
          ),
          REOPEN_TIMEOUT_MS,
          `${agentId} did not come back within ${String(Math.round(REOPEN_TIMEOUT_MS / 1000))}s`
        )
        /*
         * A resumed agent already holds its own side of the conversation, so it
         * starts at the end of the log. One that had to be restarted holds
         * nothing, so it starts at zero and reads the transcript on the first
         * thing it is asked — the same path an agent joining mid-conversation
         * takes.
         */
        if (ref === undefined || participant.session.sessionRef !== ref) {
          participant.seenSeq = 0
          participant.catchupBudget = JOINING_CATCHUP_CHARS
        }
        return participant
      })
    )

    for (const outcome of started) {
      if (outcome.status === 'fulfilled') {
        conversation.participants.set(outcome.value.agentId, outcome.value)
      } else {
        this.log.error('an agent could not be reopened', undefined, {
          conversationId: entry.conversationId,
          message:
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
    }

    if (conversation.participants.size === 0) return null
    this.active.set(entry.conversationId, conversation)
    return conversation
  }

  /** Written after anything that changes what is open, or what it is. */
  private rememberOpen(): void {
    writeOpenSessions(this.userDataPath, {
      sessions: [...this.active.values()].map((c) => ({
        conversationId: c.conversationId,
        agents: [...c.participants.keys()],
        cwd: c.cwd,
        profileId: c.profile.id,
        title: c.title,
        lastSeenSeq: c.lastSeenSeq,
        draft: c.draft,
        // Only real ones: an agent that has not spoken yet has no thread to
        // resume, and writing an empty string down makes it look like it does.
        sessionRefs: Object.fromEntries(
          [...c.participants.values()]
            .filter((p) => p.session.sessionRef.trim() !== '')
            .map((p) => [p.agentId, p.session.sessionRef])
        ),
      })),
      workspace: this.workspaceSnapshot,
    })
  }

  /**
   * Puts the conversations in the order the user arranged them.
   *
   * The map's insertion order is what gets written down and restored, so the
   * grid you arranged is the grid you get back. Unknown ids are ignored and any
   * conversation the caller forgot keeps its place at the end, so a stale list
   * cannot drop a live session.
   */
  reorderConversations(order: readonly string[]): void {
    const remaining = new Map(this.active)
    const next = new Map<string, ActiveConversation>()

    for (const id of order) {
      const conversation = remaining.get(id)
      if (conversation === undefined) continue
      next.set(id, conversation)
      remaining.delete(id)
    }
    for (const [id, conversation] of remaining) next.set(id, conversation)

    this.active.clear()
    for (const [id, conversation] of next) this.active.set(id, conversation)
    this.rememberOpen()
  }

  /**
   * Stores the editor arrangement and the sidebar's order together.
   *
   * `order` is the sidebar's list of running conversations; the panes' tab
   * orders travel inside `workspace`. The snapshot is set first so that
   * `reorderConversations`' single `rememberOpen()` writes both in one go
   * rather than leaving the file briefly holding a new order against an old
   * layout.
   */
  setConversationLayout(order: readonly string[], workspace: WorkspaceSnapshot): void {
    this.workspaceSnapshot = workspace
    this.reorderConversations(order)
  }

  /**
   * Starts the same room again, empty.
   *
   * A new conversation rather than a cleared one: the old transcript stays in
   * the log, where it is still the record of what happened, and the agents get
   * genuinely fresh sessions rather than a context we asked them to forget.
   * Same folder, same cast, same permissions, same name — the only thing that
   * changes is that nothing has been said yet.
   *
   * It keeps its place in the grid, because a pane that jumps to the end when
   * you restart it is a pane you then have to find again.
   */
  async restartConversation(conversationId: string): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
  }> {
    const existing = this.require(conversationId)
    /*
     * The default cast, not this conversation's.
     *
     * Restart is "start this session over, with nothing said in it" — a fresh
     * room, and a fresh room gets what a fresh room gets. Carrying the old cast
     * forward made restart the one action that could not recover from a
     * conversation whose agents were wrong: an agent that failed to start was
     * still in the participants, so restarting reproduced the state you were
     * restarting to escape.
     *
     * The directory and the profile still carry, because those are *where* and
     * *how much you trust it* — facts about the work rather than about the room.
     */
    const agents = readSettings(this.userDataPath).agents
    const { cwd, title } = existing
    const profileId = existing.profile.id
    const order = [...this.active.keys()]

    await this.closeConversation(conversationId)
    const started = await this.startConversation({ agents, cwd, profileId, title })
    this.reorderConversations(
      order.map((id) => (id === conversationId ? started.conversationId : id))
    )
    this.log.info('conversation restarted', { from: conversationId, to: started.conversationId })
    return started
  }

  /** Conversations with live agents right now, newest last. */
  /**
   * How much a card has to say happened while nobody was looking.
   *
   * Counted out of the log rather than remembered, which is the whole reason the
   * watermark is a sequence number instead of a tally: the log is the thing that
   * actually knows what happened, so the count cannot drift away from the
   * transcript underneath it.
   */
  private unreadSince(conversationId: string, lastSeenSeq: number): number {
    return this.store.read(conversationId, {
      afterSeq: lastSeenSeq,
      types: [...UNREAD_EVENT_TYPES],
    }).length
  }

  /**
   * Records that a conversation's card has been caught up to `seq`.
   *
   * The renderer is the only side that knows this: whether something has been
   * read depends on which tab is in front, which is not a fact the main process
   * has. Backwards moves are ignored — pushes and history replays interleave, so
   * a late report of an older position is expected rather than exceptional.
   */
  /**
   * Remembers a message typed and not sent.
   *
   * Debounced by the renderer, which owns the keystrokes; this only writes what
   * it is told. Silent for a conversation that is no longer open — a draft
   * arriving for a room that just ended is a race, not an error.
   */
  rememberDraft(conversationId: string, draft: string): void {
    const conversation = this.active.get(conversationId)
    if (conversation === undefined || conversation.draft === draft) return
    conversation.draft = draft
    this.rememberOpen()
  }

  markSeen(conversationId: string, seq: number): void {
    const conversation = this.active.get(conversationId)
    if (conversation === undefined) return
    if (seq <= conversation.lastSeenSeq) return
    conversation.lastSeenSeq = seq
    this.rememberOpen()
  }

  /**
   * Every conversation the log holds, with the open ones marked.
   *
   * The list is the log's, not the window's. `open-sessions.json` only records
   * what was on screen, so ending a conversation removed the last thing that
   * knew its name while its transcript stayed in the database forever.
   */
  listConversations(): (ConversationSummary & { open: boolean })[] {
    return this.store.listConversations().map((summary) => ({
      ...summary,
      open: this.active.has(summary.conversationId),
    }))
  }

  /**
   * Brings a past conversation back, transcript and all.
   *
   * Its agents are **started, not resumed**: the provider threads died with the
   * session, and a resume against a forgotten id is the one call that can hang
   * without failing. They pick the history up the way an agent joining
   * mid-conversation does — `reopen` sets their watermark to zero, so the first
   * thing asked arrives with the transcript attached.
   *
   * The permission profile deliberately falls back to the default rather than to
   * whatever the conversation last ran under. Reopening something from last week
   * should not silently restore permissions granted for a task nobody remembers.
   */
  async reopenConversation(conversationId: string): Promise<{
    conversationId: string
    participants: AgentId[]
    profileId: string
    cwd: string
    title: string
    unread: number
  }> {
    const open = this.active.get(conversationId)
    if (open !== undefined) {
      return {
        conversationId,
        participants: [...open.participants.keys()],
        profileId: open.profile.id,
        cwd: open.cwd,
        title: open.title,
        unread: this.unreadSince(conversationId, open.lastSeenSeq),
      }
    }

    const summary = this.store
      .listConversations()
      .find((candidate) => candidate.conversationId === conversationId)
    if (summary === undefined) throw new Error('That conversation is not in the log.')

    const problem = describeDirectory(summary.cwd)
    if (problem !== null) throw new Error(problem)

    const agents = summary.agents.filter((id): id is AgentId => this.adapters.has(id as AgentId))
    if (agents.length === 0) throw new Error('No agent from that conversation is available.')

    const conversation = await this.reopen({
      conversationId,
      agents,
      cwd: summary.cwd,
      profileId: DEFAULT_PROFILE_ID,
      title: summary.title,
      // Nothing to resume: those threads ended with their sessions.
      sessionRefs: {},
      draft: '',
      // Opened in order to be read, so it starts caught up rather than shouting
      // about every message it already contains.
      lastSeenSeq: this.store.lastSeq(),
    })
    if (conversation === null) throw new Error('That conversation could not be reopened.')

    this.rememberOpen()
    return {
      conversationId,
      participants: [...conversation.participants.keys()],
      profileId: conversation.profile.id,
      cwd: conversation.cwd,
      title: conversation.title,
      unread: 0,
    }
  }

  /**
   * The commands a conversation's agents accept.
   *
   * Per conversation, unlike models: the list is built from the project's own
   * `.claude/commands`, its skills and its plugins, so two rooms in two
   * repositories offer different things. Cached per participant because asking
   * is a control request and the menu asks every time it opens.
   */
  async listCommands(conversationId: string): Promise<SlashCommandInfo[]> {
    const conversation = this.require(conversationId)
    const perAgent = await Promise.all(
      [...conversation.participants.values()].map(async (participant) => {
        /*
         * Remembered only once there is something to remember.
         *
         * `??=` looked like the cache this wants and is not: an empty array is
         * not nullish, so the first answer is kept even when it is empty — and
         * it is empty exactly while the session is still starting, which is
         * when a freshly opened pane asks. That would leave the menu
         * permanently empty for a participant whose CLI had fifty commands to
         * offer a second later.
         *
         * Latent rather than observed: found while chasing a flaky spec that
         * turned out to be the test's own doing, and kept because an empty
         * answer means "could not ask yet" rather than "there are none", and
         * caching the two as the same thing is wrong however rarely it bites.
         */
        const known = participant.commands
        if (known !== undefined && known.length > 0) return known
        const asked = await participant.session.supportedCommands()
        if (asked.length > 0) participant.commands = asked
        return asked
      })
    )

    /*
     * Merged by name across agents, first one wins.
     *
     * Two agents in a room usually report overlapping sets, and a menu that
     * lists `/compact` twice because two CLIs both have it is a menu that looks
     * broken. Which agent runs it is decided by the routing that already
     * governs every other message.
     */
    const byName = new Map<string, SlashCommandInfo>()
    for (const command of perAgent.flat()) {
      if (!byName.has(command.name)) byName.set(command.name, command)
    }
    return [...byName.values()]
  }

  /**
   * Puts a conversation's agents into plan mode, or takes them out.
   *
   * Per conversation rather than per message, which is how Chorus already
   * models what a room may do: the permission profile lives here too, and a
   * mode that reset itself every turn would be a checkbox nobody could rely on.
   *
   * Every participant together. A room where one agent plans and the other
   * edits is not a mode, it is a disagreement.
   */
  async setPlanMode(conversationId: string, on: boolean): Promise<void> {
    const conversation = this.require(conversationId)
    conversation.planning = on
    await Promise.all(
      [...conversation.participants.values()].map((participant) =>
        participant.session.setPermissionMode(on ? 'plan' : 'default')
      )
    )
  }

  /** Whether this conversation is planning, for a control that has to say so. */
  planning(conversationId: string): boolean {
    return this.active.get(conversationId)?.planning ?? false
  }

  /**
   * How the inherited MCP servers are doing, asked of whichever session can say.
   *
   * Asked live rather than cached, unlike the model list. A model list does not
   * change under a running CLI; a server's health is exactly the thing that
   * does — it can drop, or come back once you authenticate it, and a remembered
   * answer would be the one state worse than none.
   *
   * Any live conversation will do: the servers come from the user's own config,
   * so every session in the app has the same ones.
   */
  async mcpServers(): Promise<McpServerHealth[]> {
    for (const conversation of this.active.values()) {
      for (const participant of conversation.participants.values()) {
        const servers = await participant.session.mcpServerStatus()
        if (servers.length > 0) return [...servers]
      }
    }
    return []
  }

  /**
   * Which account each agent is signed in as.
   *
   * Per agent rather than first-answer-wins, unlike the MCP servers: those come
   * from one config file and every session inherits the same ones, but claude
   * and codex are separate logins and the whole point of asking is that they
   * can differ. Asked live, because signing in elsewhere changes the answer
   * under a running app.
   *
   * One conversation per agent is enough — a second session for the same agent
   * is the same login — so this stops at the first that answers for each.
   */
  async accounts(): Promise<{ agentId: AgentId; account: AccountSummary }[]> {
    const found = new Map<AgentId, AccountSummary>()
    for (const conversation of this.active.values()) {
      for (const [agentId, participant] of conversation.participants) {
        if (found.has(agentId)) continue
        const account = await participant.session.accountInfo()
        if (account !== null) found.set(agentId, account)
      }
    }
    return [...found].map(([agentId, account]) => ({ agentId, account }))
  }

  /**
   * Ends one background task, on the agent that owns it.
   *
   * Routed by agent rather than broadcast: task ids come from one provider's
   * snapshot and mean nothing to the other, so asking both would be asking a
   * stranger to stop something it never started.
   *
   * No confirmation is returned. The provider's next snapshot is what says the
   * task is gone, and it is the only thing that can — a success here would only
   * mean the request was delivered.
   */
  async stopTask(conversationId: string, agentId: AgentId, taskId: string): Promise<void> {
    const participant = this.active.get(conversationId)?.participants.get(agentId)
    await participant?.session.stopTask(taskId)
  }

  /** What the settings sheet offers, from whichever session last answered. */
  /**
   * One row per adapter, whether or not it has ever been asked.
   *
   * Seeded from `adapters` rather than from what discovery happened to record,
   * so the sheet can draw a row for an agent that has never run — which is the
   * common case on a machine where only one agent has been used.
   */
  knownModels(): {
    agentId: AgentId
    status: 'unqueried' | 'loading' | 'ready' | 'failed'
    models: ModelChoice[]
  }[] {
    return [...this.adapters.keys()].map((agentId) => {
      const known = this.knownModelsByAgent.get(agentId)
      return {
        agentId,
        status: known?.status ?? 'unqueried',
        models: [...(known?.models ?? [])],
      }
    })
  }

  openConversations(): { conversationId: string; participants: AgentId[]; cwd: string }[] {
    return [...this.active.values()].map((c) => ({
      conversationId: c.conversationId,
      participants: [...c.participants.keys()],
      cwd: c.cwd,
    }))
  }

  /**
   * Brings an agent into a conversation already under way.
   *
   * Its watermark starts at zero, so the first thing it is asked comes with the
   * whole conversation attached — including what the agent it is replacing said.
   * That is the point: catching up should cost nothing until the agent is
   * actually used, and then cost exactly one turn.
   */
  async addParticipant(conversationId: string, agentId: AgentId): Promise<{ agentId: AgentId }> {
    const conversation = this.require(conversationId)
    if (conversation.participants.has(agentId)) return { agentId }

    const participant = await this.startParticipant(
      agentId,
      conversationId,
      (resuming) => this.sessionOptsFor(conversation, agentId, resuming),
      conversation.profile,
      conversation.grants
    )
    participant.seenSeq = 0
    participant.catchupBudget = JOINING_CATCHUP_CHARS
    conversation.participants.set(agentId, participant)
    this.rememberOpen()
    this.log.info('agent joined', { conversationId, agentId })
    return { agentId }
  }

  /**
   * Takes an agent out without ending the conversation.
   *
   * Its session closes, which appends `session.ended` — the transcript keeps
   * everything it said, and the log explains the silence that follows.
   */
  async removeParticipant(conversationId: string, agentId: AgentId): Promise<{ agentId: AgentId }> {
    const conversation = this.require(conversationId)
    const participant = conversation.participants.get(agentId)
    if (participant === undefined) return { agentId }

    conversation.participants.delete(agentId)
    if (conversation.lastAddressed === agentId) conversation.lastAddressed = undefined
    await participant.service.close()
    this.rememberOpen()
    this.log.info('agent left', {
      conversationId,
      agentId,
      remaining: conversation.participants.size,
    })
    return { agentId }
  }

  /** The provider sandbox mirrors the profile, so it is rebuilt when either moves. */
  /**
   * The default model for one agent, from that agent's own entry.
   *
   * The setting was a single string until this, and that string was always
   * chosen from **Claude's** list — the only catalogue the sheet ever showed —
   * so handing it to Codex sent a value from one provider's catalogue to
   * another's API. The schema's transform folds the old scalar onto Claude for
   * exactly that reason; this only has to read the map.
   */
  private preferredModelFor(agentId: AgentId): string {
    return readSettings(this.userDataPath).models[agentId]
  }

  /**
   * What one agent starts with.
   *
   * Per agent, which it was not: this returned one object for whichever agent
   * happened to be starting, so a Claude model reached Codex's `thread/start`.
   *
   * `resuming` drops the model entirely. A resumed session already has one —
   * it is in the provider's own record of the thread — and passing today's
   * preference would silently re-point a conversation that already exists at a
   * different model, days after anyone chose it.
   */
  private sessionOptsFor(
    /*
     * The two fields this actually needs, rather than a whole conversation.
     * `startConversation` has them before an `ActiveConversation` exists, and a
     * cast to pretend otherwise would be a lie the type system believed.
     */
    where: { readonly cwd: string; readonly profile: PermissionProfile },
    agentId: AgentId,
    resuming = false
  ): SessionOpts {
    // Read at call time rather than held: changing the sheet should affect the
    // next session without the app having to be restarted.
    const preferred = resuming ? '' : this.preferredModelFor(agentId)
    return {
      cwd: where.cwd,
      ...(preferred === '' ? {} : { model: preferred }),
      sandbox:
        where.profile.id === 'read-only'
          ? { mode: 'readOnly', writableRoots: [], networkAccess: false }
          : { mode: 'workspaceWrite', writableRoots: [where.cwd], networkAccess: false },
    }
  }

  /**
   * Names a conversation.
   *
   * Recorded like everything else: a name is how you will refer to this in a
   * week, and the log is the only thing that will still have it.
   */
  renameConversation(conversationId: string, title: string): { title: string } {
    const conversation = this.require(conversationId)
    // Emptying the field is a request for the default back, not for no name.
    const next = title.trim() === '' ? folderName(conversation.cwd) : title.trim()
    if (next === conversation.title) return { title: next }

    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'conversation.renamed', title: next, previousTitle: conversation.title },
    })
    conversation.title = next
    this.rememberOpen()
    /*
     * Carried through to each provider's own record of the session.
     *
     * Chorus's log stays authoritative for Chorus's history — this is so a room
     * named here is recognisable if the same session is later resumed in the
     * provider's own client, instead of appearing under an auto-generated
     * summary of its first prompt.
     *
     * Not awaited, and failures are the adapter's to swallow: a rename is a
     * local fact that has already happened, and it must not wait on, or be
     * undone by, another program's bookkeeping.
     */
    for (const participant of conversation.participants.values()) {
      const adapter = this.adapters.get(participant.agentId)
      void adapter?.renameSession?.(participant.session.sessionRef, next, conversation.cwd)
    }
    return { title: next }
  }

  /** What a conversation is called right now. */
  conversationTitle(conversationId: string): string {
    return this.require(conversationId).title
  }

  /** Where a conversation is, for anything that needs the path rather than the id. */
  projectDirectory(conversationId: string): string {
    return this.require(conversationId).cwd
  }

  /**
   * Points the conversation at another directory.
   *
   * This moves what *Chorus* means by the project — the review panel and the
   * handoff brief follow it. It does not move an agent's shell: those were
   * started with a working directory and keep it. The filesystem is not scoped
   * (§4.4), so the agent can work anywhere it is told to, and the change is
   * replayed as catch-up so the next one addressed is told.
   */
  setProjectDirectory(conversationId: string, cwd: string): { cwd: string; title: string } {
    const conversation = this.require(conversationId)
    const next = cwd.trim() === '' ? homedir() : cwd.trim()
    const problem = describeDirectory(next)
    if (problem !== null) throw new Error(problem)

    const previous = conversation.cwd
    if (next === previous) return { cwd: previous, title: conversation.title }

    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'project.changed', cwd: next, previousCwd: previous },
    })
    conversation.cwd = next
    // A title nobody has touched is still the folder's name, so it follows the
    // folder. One that was chosen deliberately is left alone.
    if (conversation.title === folderName(previous)) {
      this.renameConversation(conversationId, folderName(next))
    }
    this.rememberOpen()
    this.log.info('project directory changed', { conversationId, from: previous, to: next })
    return { cwd: next, title: conversation.title }
  }

  /**
   * Changes what agents may do without asking, mid-conversation.
   *
   * Every participant moves together: two agents in one room under different
   * rules would make "what may happen here" unanswerable. Recorded in the log
   * before it takes effect, so the transcript shows the widening above the
   * actions it permitted rather than below them.
   */
  setProfile(conversationId: string, profileId: string): { profileId: string } {
    const conversation = this.require(conversationId)
    const profile = profileById(profileId)
    const previous = conversation.profile

    this.store.append({
      conversationId,
      actor: 'system',
      payload: { type: 'policy.changed', profileId: profile.id, previousProfileId: previous.id },
    })

    conversation.profile = profile
    for (const participant of conversation.participants.values()) {
      participant.service.setProfile(profile)
    }
    this.rememberOpen()
    this.log.info('policy changed', { conversationId, from: previous.id, to: profile.id })
    return { profileId: profile.id }
  }

  /**
   * Re-reads every live agent's account windows.
   *
   * Across conversations, not just one: the windows are the account's, so the
   * answer is the same wherever it is asked from, and asking once per session
   * would report the same number several times over.
   */
  async refreshLimits(): Promise<void> {
    const asked = new Set<AgentId>()
    const reads: Promise<void>[] = []
    for (const conversation of this.active.values()) {
      for (const [agentId, participant] of conversation.participants) {
        if (asked.has(agentId)) continue
        asked.add(agentId)
        reads.push(participant.service.refreshLimits())
      }
    }
    await Promise.allSettled(reads)
  }

  /** Interrupts every agent mid-turn; the user pressed one Stop button. */
  async interrupt(conversationId: string): Promise<void> {
    const conversation = this.require(conversationId)
    await Promise.all([...conversation.participants.values()].map((p) => p.service.interrupt()))
  }

  async decideApproval(
    conversationId: string,
    agentId: AgentId,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const participant = this.require(conversationId).participants.get(agentId)
    if (participant === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await participant.service.decideApproval(approvalId, decision)
  }

  /**
   * Carries an answer back to the agent that asked for it.
   *
   * A sibling of `decideApproval` rather than part of it: a permission is a
   * question a rule can be given an opinion about, and what the user *wants* is
   * not — which is why the service refuses to auto-answer these and why they
   * come back through their own path.
   *
   * `timeout` is deliberately not reachable from here. The deadline belongs to
   * the orchestrator, which owns the timer; a UI that could claim a question had
   * expired would be able to say so before it had.
   */
  async answerUserInput(
    conversationId: string,
    agentId: AgentId,
    userInputId: string,
    response: UserInputResponse
  ): Promise<void> {
    const participant = this.require(conversationId).participants.get(agentId)
    if (participant === undefined) throw new Error(`"${agentId}" is not in this conversation`)
    await participant.service.answerUserInput(userInputId, response)
  }

  /**
   * Reads the repository as it stands right now.
   *
   * Deliberately not derived from the event log: the log records what agents
   * *proposed*, git records what is actually on disk. After a crash, a manual
   * edit, or an approval that was denied, those differ — and the one worth
   * reviewing is the disk.
   */
  async readWorkspace(
    conversationId: string
  ): Promise<{ status: WorkspaceStatus; diff: DiffFile[]; problem: string | null }> {
    return readWorkspace({ cwd: this.require(conversationId).cwd })
  }

  /** Replays a conversation from the log — the only complete record (S3). */
  history(conversationId: string, afterSeq?: number): StoredEvent[] {
    return this.store.read(conversationId, afterSeq === undefined ? {} : { afterSeq })
  }

  /**
   * The terminal panels, delegated straight through.
   *
   * Thin on purpose: the runtime owns the service's lifetime and knows where a
   * shell should open, and that is all it contributes. Everything else is the
   * service's, and putting logic here would be the second place to look for it.
   */
  onTerminalOutput(listener: (push: TerminalPush) => void): () => void {
    return this.terminals.subscribe(listener)
  }

  async attachTerminal(
    ref: TerminalRef,
    size?: { cols: number; rows: number }
  ): Promise<TerminalAttachment> {
    return await this.terminals.attach(ref, size)
  }

  detachTerminal(ref: TerminalRef, epoch: number): void {
    this.terminals.detach(ref, epoch)
  }

  /**
   * Kill a terminal on request.
   *
   * Guarded by the epoch like every other write: a `dispose` from a view that
   * has already been superseded is a stale click, and killing a shell is the
   * least recoverable thing this surface can do.
   */
  disposeTerminal(ref: TerminalRef, epoch: number): void {
    this.terminals.disposeIfCurrent(ref, epoch)
  }

  /**
   * Kill a shell the user pointed at in a list, with no epoch to check.
   *
   * Not a weakening of the guard above — a different caller. Only the active tab
   * of a panel is mounted, so a background tab has no attachment and no epoch to
   * offer; the guard exists to stop a *superseded view* acting, and a tab strip
   * is mounted at the moment of the gesture. `dispose` on a shell that has
   * already exited is a no-op that still forgets it, so a stale click here costs
   * nothing.
   */
  killTerminal(ref: TerminalRef): void {
    this.terminals.dispose(ref)
  }

  writeTerminal(ref: TerminalRef, epoch: number, data: string): void {
    this.terminals.write(ref, epoch, data)
  }

  resizeTerminal(ref: TerminalRef, epoch: number, cols: number, rows: number): void {
    this.terminals.resize(ref, epoch, cols, rows)
  }

  clearTerminal(ref: TerminalRef, epoch: number): void {
    this.terminals.clear(ref, epoch)
  }

  ackTerminal(ref: TerminalRef, epoch: number, seq: number): void {
    this.terminals.ack(ref, epoch, seq)
  }

  describeTerminal(ref: TerminalRef): TerminalDescription | null {
    return this.terminals.describe(ref)
  }

  async close(): Promise<void> {
    /*
     * Refs are read here, not only when a session starts.
     *
     * Claude's real session id arrives with its first message rather than at
     * `start`, so the list written when a conversation opened holds a
     * placeholder. Quitting is the last and most accurate moment to record what
     * to resume from — without this, every restored Claude began again with no
     * memory of the conversation it was supposedly continuing.
     */
    this.rememberOpen()

    /*
     * Terminals first, and the global one is why this line exists.
     *
     * It belongs to no conversation, so nothing below reaches it — the same
     * shape as the aside bug recorded underneath, where separate storage was
     * right and quitting still left the processes running. `close()` on the
     * service drains both kinds.
     */
    this.terminals.close()

    /*
     * Asides are closed alongside participants, not forgotten.
     *
     * They live in their own map so nothing that walks open conversations finds
     * one — which is right, and which also meant quitting drained the main
     * services and left these running. A `DeltaBuffer` that never flushes loses
     * the tail of whatever it held, no `session.ended` is written, and the pump
     * outlives the database it writes into.
     */
    const services = [
      ...[...this.active.values()].flatMap((c) =>
        [...c.participants.values()].map((p) => p.service)
      ),
      ...[...this.asides.values()].map((a) => a.service),
    ]
    await Promise.all(services.map((service) => service.close('shutdown')))
    this.asides.clear()
    this.active.clear()
    await Promise.all([...this.adapters.values()].map((a) => a.dispose()))

    /*
     * Drained after the adapters are gone, not before.
     *
     * Disposing a session emits its last events, and those travel through a
     * pump nobody awaits. Closing the database first left them writing into a
     * dead handle. This waits for each pump to finish, so the log gets the end
     * of the story rather than an exception.
     */
    await Promise.all(services.map((service) => service.drain()))

    const dropped = this.store.droppedWrites()
    if (dropped > 0) this.log.warn('events arrived after the log closed', { dropped })
    this.db.close()
  }

  private async startParticipant(
    agentId: AgentId,
    conversationId: string,
    /*
     * A factory, not an object, because only this method knows which it needs.
     *
     * Resuming strips the model — a rejoined thread already carries the one it
     * was started with, and passing today's preference would re-point a
     * conversation that already exists. But three paths inside here start
     * *fresh* while reopening: an agent with no saved thread, a past
     * conversation whose refs are deliberately empty, and a resume that failed
     * and fell back. Resolved once outside, all three started with no model at
     * all — the reopen half of the bug this phase was meant to fix.
     */
    sessionOpts: (resuming: boolean) => SessionOpts,
    profile: PermissionProfile,
    grants: SessionGrants,
    /** A provider thread to rejoin instead of starting a new one. */
    resumeFrom?: string,
    /*
     * Whether this is the app reopening the conversation.
     *
     * Not the same question as "did we have a thread to resume": an agent that
     * never spoke has no thread and is started fresh, but the app is still
     * reopening — and announcing it as somebody joining put a "claude joined" in
     * the transcript on every launch.
     */
    reopening = false,
    /*
     * A session to branch from, kept, instead of starting or resuming.
     *
     * Promotion needs the *work's* context, and Chorus's log cannot supply it —
     * `tool.completed` stores a summary capped at 120 characters, so a room
     * rebuilt from the log cannot answer a question about a file the agent read
     * (measured; see the plan's STATUS). A fork of the parent can.
     */
    forkFrom?: string
  ): Promise<Participant> {
    const adapter = this.adapters.get(agentId)
    if (adapter === undefined) throw new Error(`No adapter registered for "${agentId}"`)

    const health = await adapter.health()
    if (health.state !== 'ready') {
      const detail = health.state === 'unauthenticated' ? health.hint : health.reason
      throw new Error(`${agentId} is not ready: ${detail}`)
    }

    /*
     * Resume when there is a thread to resume.
     *
     * A resumed agent still has its own reasoning about the work; a restarted
     * one has only what the transcript can tell it. Falling back rather than
     * failing, because a thread the provider has forgotten is a normal thing to
     * find after a day away — and a session that opens without its context beats
     * one that refuses to open.
     */
    const opened = await (forkFrom !== undefined
      ? (async () => {
          const opts = sessionOpts(false)
          return {
            session: await SupervisedSession.fork(adapter, forkFrom, {
              ...opts,
              // The user's own hooks, skills and project instructions, as
              // everywhere else. A promoted room is an ordinary room.
              inherits: 'config' as const,
              // Kept, because this one is going to be saved and reopened.
              persist: true,
            }),
            opts,
          }
        })()
      : resumeFrom === undefined
        ? (async () => {
            const opts = sessionOpts(false)
            return { session: await SupervisedSession.start(adapter, opts), opts }
          })()
        : (async () => {
            const resumeOpts = sessionOpts(true)
            try {
              return {
                session: await SupervisedSession.resume(adapter, resumeFrom, resumeOpts),
                opts: resumeOpts,
              }
            } catch {
              // Fresh options on the fallback: this is now a new session, and it
              // should start with what the sheet says new sessions start with.
              const opts = sessionOpts(false)
              return { session: await SupervisedSession.start(adapter, opts), opts }
            }
          })())
    // The options actually used, so what is attached matches what was opened
    // rather than a second guess at which branch ran.
    const { session, opts: usedOpts } = opened
    /*
     * The preferred effort, applied once the session exists.
     *
     * Unlike the model it is not a `SessionOpts` field — the CLI takes it as a
     * settings override after the query is open — so it is a call rather than a
     * construction argument. Failing to apply a preference must not cost the
     * session, so it is awaited but not allowed to throw.
     */
    /*
     * Asked once, here, rather than when something wants to draw a picker.
     *
     * The settings sheet is the only place a model is chosen now, and it can be
     * opened with nothing running — so the list has to be collected as a side
     * effect of having a session at all, not of rendering a control. One control
     * request per participant, and the answer does not change under a running
     * CLI.
     */
    /*
     * Recorded as a state, including when the answer is nothing.
     *
     * The previous version kept the result only when it was non-empty and
     * swallowed a failure, which made an agent that offers no models
     * indistinguishable from one nobody has asked — and from one whose CLI is
     * too old to be asked. The sheet needs to tell a user which of those it is.
     */
    this.knownModelsByAgent.set(agentId, {
      status: 'loading',
      models: this.knownModelsByAgent.get(agentId)?.models ?? [],
    })
    void session
      .supportedModels()
      .then((models) => {
        this.knownModelsByAgent.set(agentId, { status: 'ready', models })
      })
      .catch((error: unknown) => {
        this.knownModelsByAgent.set(agentId, { status: 'failed', models: [] })
        this.log.warn('could not read the model catalogue', {
          agentId,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    /*
     * That agent's own, for the same reason the model is. Codex's levels differ
     * per model — `ultra` exists on some and not others — so the two providers'
     * lists are not interchangeable even where they appear to overlap.
     *
     * Applied on a reopen as well as a fresh start, which is deliberately *not*
     * what the model does. A resumed thread carries its own model in the
     * provider's record, so passing one would override it; effort is not
     * recorded anywhere, so not applying it does not restore what the
     * conversation had — it silently drops to the provider default. Neither
     * choice is "what it was", and losing the preference is the worse of the
     * two. Recording effort per conversation is the real answer and is not this
     * phase.
     */
    const effort = readSettings(this.userDataPath).efforts[agentId]
    if (effort !== '') {
      await session.setEffort(effort).catch((error: unknown) => {
        this.log.warn('could not apply the preferred effort level', {
          agentId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    }

    const service = new ConversationService({
      store: this.store,
      conversationId,
      adapter,
      profile,
      grants,
      // Account state, not conversation history: it goes to the window, not the log.
      onLimits: (windows) => {
        this.limits.set(agentId, windows)
        this.onLimits?.({ agentId, windows: [...windows] })
      },
      // Conversation state, not account state: it goes to the pane that asked.
      onContextUsage: (usage) => {
        this.onContextUsage?.({ conversationId, agentId, ...usage })
      },
      /*
       * Live processes, not history — pushed to the pane like the context
       * window, and never logged.
       *
       * Passed on even when empty. The provider replaces rather than merges, so
       * an empty list is the only way anyone learns the last task finished; a
       * falsy guard here would leave the indicator stuck on forever.
       */
      onTasks: (tasks) => {
        this.onTasks?.({ conversationId, agentId, tasks: tasks.map((task) => ({ ...task })) })
      },
      /*
       * What it says it is doing, pushed to the pane and never written down.
       *
       * `null` is forwarded like an empty task list is: it is the only thing
       * that says a compaction finished, and swallowing it would leave the
       * working line insisting on a word that stopped being true.
       */
      onActivity: (activity) => {
        this.onActivity?.({ conversationId, agentId, activity })
      },
      // An approved plan ends the mode for the room, not just for the agent
      // whose plan it was.
      onPlanExited: () => {
        const conversation = this.active.get(conversationId)
        if (conversation !== undefined) conversation.planning = false
      },
    })
    await service.attach(session, usedOpts, health, reopening)
    // Joining mid-conversation is not a case yet, but starting at the current
    // end of the log is what makes it one when it is.
    return { agentId, service, session, seenSeq: this.store.lastSeq() }
  }

  private require(conversationId: string): ActiveConversation {
    const found = this.active.get(conversationId)
    if (found === undefined) throw new Error(`Conversation "${conversationId}" is not active`)
    return found
  }
}

/**
 * Opens the database, and gets out of the way if it cannot be read.
 *
 * A corrupt SQLite file would otherwise make the app unstartable — the worst
 * possible failure for a local-first tool, because the data is only here. The
 * file is moved aside rather than deleted: it is the user's history, and a
 * later `sqlite3 .recover` may still get it back.
 */
function openOrRecover(
  path: string,
  userDataPath: string
): { db: SqliteHandle; store: EventStore; recovered: string | null } {
  /**
   * A snapshot, taken by SQLite rather than by the filesystem.
   *
   * The first version of this copied the main file and then its `-wal` and
   * `-shm` in turn, which is not a snapshot: the three are copied at three
   * different moments, and nothing stops another process — Chorus has no
   * single-instance lock — writing between them. What that produces is a backup
   * that looks fine and restores to a moment that never existed.
   *
   * `VACUUM INTO` is SQLite's own answer. It writes one consistent file from a
   * live database, with no sidecars to keep in step, and it is synchronous,
   * which `migrate` requires.
   */
  const snapshot = (db: SqliteHandle, from: number): string => {
    const destination = join(userDataPath, `chorus.pre-v${String(from)}.db`)
    // A leftover from an interrupted attempt would make VACUUM INTO fail.
    if (existsSync(destination)) rmSync(destination)
    // The path is ours, not a user's, but a quote in it would end the literal
    // and the rest would be executed.
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
    return destination
  }

  /*
   * Only *opening* may be treated as corruption.
   *
   * This catch used to wrap the migration too, and it recovers by renaming the
   * database aside and starting an empty one. So a disk-full or a permission
   * error while backing up — or any migration failure at all — presented as "your
   * database was unreadable", and the user's history was moved out of the way to
   * make room for nothing. A migration that cannot run has to fail loudly with
   * the database untouched.
   */
  let db: SqliteHandle
  let recovered: string | null = null
  try {
    db = openSqlite({ path })
  } catch (error) {
    if (!existsSync(path)) throw error
    const moved = join(userDataPath, `chorus.unreadable-${String(Date.now())}.db`)
    renameSync(path, moved)
    db = openSqlite({ path })
    recovered = moved
  }

  return { db, store: EventStore.open(db, (from) => snapshot(db, from)).store, recovered }
}

/** Returns why a directory cannot be used, or null when it is fine. */
/**
 * The last piece of a path, which is what anyone calls the project.
 *
 * Falls back to the whole thing at the filesystem root, where there is no last
 * piece and "/" is a better name than nothing.
 */
function folderName(cwd: string): string {
  const name = basename(cwd)
  return name === '' ? cwd : name
}

function describeDirectory(cwd: string): string | null {
  if (!existsSync(cwd)) return `That directory does not exist: ${cwd}`
  try {
    if (!statSync(cwd).isDirectory()) return `That path is a file, not a directory: ${cwd}`
  } catch (error) {
    return `That directory cannot be read: ${error instanceof Error ? error.message : String(error)}`
  }
  return null
}

function defaultAdapters(): Map<AgentId, AgentAdapter> {
  return new Map<AgentId, AgentAdapter>([
    // The command is resolved lazily, on first use: asking a login shell at
    // module load would delay the window for something not needed until a
    // session starts.
    [
      'codex',
      new CodexAdapter({
        resolveCommand: async () => {
          const resolved = await resolveCommand('codex')
          return resolved === null ? null : spawnSpec(resolved)
        },
      }),
    ],
    ['claude', new ClaudeAdapter(claudeOptions())],
  ])
}

/**
 * The SDK needs an absolute path; `claude` on PATH is not enough once the app
 * runs outside a login shell, where PATH is much smaller than a terminal's.
 *
 * The same lookup as Codex's, deliberately: taking the first install that
 * happens to exist is what picked a `codex` too old to start, and there is no
 * reason `claude` cannot end up in the same state. Falls back to the SDK's own
 * lookup when nothing is found.
 *
 * **Two answers, because there are two consumers.** The SDK takes
 * `pathToClaudeCodeExecutable`, a plain string with no slot for an argument
 * prefix — `executableArgs` is flags for the JS runtime, not a command prefix —
 * so on Windows it gets the script behind the `.cmd` shim, and null when the
 * shim could not be read. The adapter's own version probe gets the spawnable
 * pair instead, because `execFile` cannot run a `.js` on Windows and handing it
 * the SDK's answer reported every npm install as unavailable.
 */
function claudeOptions(): { resolveExecutable: () => Promise<ResolvedExecutable | null> } {
  return {
    resolveExecutable: async () => {
      const resolved = await resolveCommand('claude')
      if (resolved === null) return null
      return { sdkPath: sdkExecutablePath(resolved), launch: spawnSpec(resolved) }
    },
  }
}

export interface Diagnostics {
  readonly bundle: string
  readonly path: string
}
