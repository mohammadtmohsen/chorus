import { HostCapabilities } from './host-capabilities.js'
import {
  ActorSchema,
  AgentIdSchema,
  agentRecord,
  CONVERSATION_NOTE_MAX_LENGTH,
} from '@chorus/shared'
import { z } from 'zod'
import { TaskBundleShape } from './task-progress.js'
import { NOTE_SIZE, WorkspaceSnapshot } from './workspace-layout.js'
import type { WorkbenchShellApi } from './workbench-ipc.js'
import type { DetachedWindowApi } from './detached-window-ipc.js'
import type { BrowserApi } from './browser-ipc.js'
import type { ConsoleApi } from './console-ipc.js'
import type { RunApi } from './run-ipc.js'
import type { GitApi } from './git-ipc.js'
import type { TrafficApi } from './traffic-ipc.js'

/**
 * The single source of truth for the IPC surface.
 *
 * Main validates every inbound payload and every outbound result; the preload
 * validates too, so our own bugs surface at the boundary instead of deeper in.
 * A channel that is not in this map does not exist (plan §4.4).
 */

export const AgentProbeResult = z.object({
  id: AgentIdSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  /**
   * The raw error, kept for diagnostics rather than for reading.
   *
   * `spawn claude ENOENT` is what this holds, and it was the only thing the app
   * knew about a failed probe — so Settings could say "not installed" and
   * nothing else. `reason` and `foundAt` below are what a person can act on.
   */
  problem: z.string().nullable(),
  /**
   * Which kind of failure, as a key rather than a sentence.
   *
   * The two need different advice and the code already knows which is which:
   * `missing` is nothing at any candidate path, `failed` is something found
   * that would not run — a shim whose interpreter is absent, a binary too old
   * to understand `--version`. Telling a user to install what they already have
   * is worse than saying nothing.
   *
   * A key, because main has no translator: the renderer turns it into words.
   */
  /**
   * `needsKey` is the third state and is not a failure of the install.
   *
   * DeepSeek runs on the same `claude` binary, so "is it installed" is answered
   * by Claude's own probe and is usually yes. What is missing is an API key —
   * a state neither `missing` nor `failed` describes, and one whose advice is a
   * Settings field rather than an install command.
   */
  reason: z.enum(['missing', 'failed', 'needsKey']).nullable(),
  /** Where it was found, when it was found and still would not run. */
  foundAt: z.string().nullable(),
})
export type AgentProbeResult = z.infer<typeof AgentProbeResult>

export const AppInfo = z.object({
  capabilities: HostCapabilities,
  appVersion: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  chromeVersion: z.string(),
  platform: z.string(),
  /*
   * Home, so the renderer can tell "no folder chosen" from "a folder that
   * happens to be home".
   *
   * An empty directory has always meant "start at home" — the runtime resolves
   * it that way on `startConversationIn`, which adopts the result as a project,
   * because
   * a directory is a starting point rather than a boundary. But it resolves it
   * *before* the renderer ever sees it, so a session that was never given a
   * project looked identical to one deliberately pointed at home, and there was
   * no way to say "no particular folder" back.
   */
  home: z.string(),
})
export type AppInfo = z.infer<typeof AppInfo>

/** Mirrors `StoredEvent` from the event store, minus its branded types. */
export const TranscriptEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  conversationId: z.string(),
  actor: ActorSchema,
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int(),
})
export type TranscriptEvent = z.infer<typeof TranscriptEvent>

/** Defaults for a new session. Zoom is not here: it lasts one launch. */
/**
 * The longest a language may be.
 *
 * Not a guess at how long a language name is — a bound on what a free-text field
 * can do to everything downstream. The value reaches a prompt and, if the offer
 * ever names it, a button: unbounded, it makes one enormous and the other wider
 * than the pane, and no amount of measuring rescues a button that cannot fit.
 * Forty is comfortably past "Lebanese Arabic" and nowhere near a paragraph.
 */
export const MAX_EXPLAIN_LANGUAGE = 40

/**
 * What the field accepts, applied wherever it is read or written.
 *
 * Free text is the point — "Lebanese Arabic" and "simple Arabic" are answers a
 * locale list cannot express. Free is not unconstrained, though: a pasted
 * newline would make a one-line control look empty while holding content, and
 * whitespace alone would produce an action that appears to do nothing. Both
 * collapse to the same normalisation rather than being rejected, because a paste
 * should not become an error message.
 */
export function normaliseExplainLanguage(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_EXPLAIN_LANGUAGE)
}

export const DEFAULT_TRAFFIC_REQUEST_FRACTION = 0.5
export const MIN_TRAFFIC_REQUEST_FRACTION = 0.1
export const MAX_TRAFFIC_REQUEST_FRACTION = 0.9
export const TrafficRequestFraction = z
  .number()
  .min(MIN_TRAFFIC_REQUEST_FRACTION)
  .max(MAX_TRAFFIC_REQUEST_FRACTION)

/**
 * What main hands back: the stored settings, plus what it will say about the
 * credentials it holds.
 *
 * `deepseekKeySet` is not stored in `settings.json` and is not a preference — it
 * is derived, at every read, from whether `agent-secrets.ts` has a key. The
 * value itself never crosses the boundary in this direction.
 */
export const SettingsShape = z.object({
  /* `agents` was here, and went with the cast becoming main's. See the comment
     on the field's grave in `settings.ts`. */
  cwd: z.string(),
  profileId: z.string(),
  /** Empty means the provider's own choice, which is not a model name. */
  model: z.string().default(''),
  effortLevel: z.string().default(''),
  /** Per agent, because the two providers share no model. */
  models: z.object(agentRecord(() => z.string().default(''))).default(agentRecord(() => '')),
  efforts: z.object(agentRecord(() => z.string().default(''))).default(agentRecord(() => '')),
  /**
   * The language an explanation comes back in. Empty means the action is not
   * offered — see the plan: there is no sensible guess at someone's own language,
   * and the system locale is a fact about the machine rather than the person.
   */
  explainLanguage: z.string().default('').transform(normaliseExplainLanguage),
  /**
   * Whether a new conversation starts in the bilingual style.
   *
   * The default only. A conversation owns its own on/off from the moment it is
   * created, because the ordinary case is reading in one language while pasting a
   * reply to someone who reads another — one app-wide value cannot express that.
   */
  styleOnByDefault: z.boolean().default(false),
  /**
   * Appearance, global rather than per conversation.
   *
   * Must track `Settings` in `main/settings.ts`. `.default(...)` matters as much
   * here as there: a required field would reject every settings payload written
   * before this shipped.
   */
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  completionProvider: z.enum(['auto', 'deepseek', 'codestral']).default('auto'),
  notifications: z.boolean().default(true),
  trafficRequestFraction: TrafficRequestFraction.default(DEFAULT_TRAFFIC_REQUEST_FRACTION),
  trafficOrigin: z.string().default(''),
})

/**
 * The settings, plus whether main holds a credential — never which one.
 *
 * A separate shape rather than a field on `SettingsShape`, because the two
 * directions are genuinely different: `settings:write` takes a key and this
 * comes back without one. Folding them together would make the write request
 * accept `deepseekKeySet` and invite exactly the symmetry that is wrong here.
 */
export const SettingsWithSecrets = SettingsShape.extend({
  deepseekKeySet: z.boolean().default(false),
  /*
   * TypeSafe is not an agent and has no entry in `AGENT_IDS` — it is a service
   * the agents call, and Chorus holds its credential so they can. The boolean
   * is the same shape as DeepSeek's for the same reason: whether, never which.
   */
  typesafeKeySet: z.boolean().default(false),
  completionDeepseekKeySet: z.boolean().default(false),
  completionCodestralKeySet: z.boolean().default(false),
})
export type SettingsWithSecrets = z.infer<typeof SettingsWithSecrets>

/**
 * One side of a file comparison, mirroring `FileVersion` in `@chorus/workspace`.
 *
 * Restated rather than imported, the way `IdeStatusShape` mirrors the
 * protocol's statuses: the renderer must not take a dependency on the git
 * package. Drift is not silent — the handler builds this from a `FileVersion`
 * and would stop typechecking.
 */
export const FileVersionShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('absent') }),
  z.object({ kind: z.literal('binary') }),
  z.object({ kind: z.literal('tooLarge') }),
])
export type FileVersionShape = z.infer<typeof FileVersionShape>

export const ApprovalChoice = z.object({
  conversationId: z.string(),
  /** Which agent asked — several can have approvals pending at once. */
  agentId: AgentIdSchema,
  approvalId: z.string(),
  outcome: z.enum(['allow', 'deny', 'cancel']),
  /**
   * `always` outlives the app; `session` dies with it.
   *
   * The third is here because the second was a promise Chorus could not keep for
   * an MCP call: those may never be auto-decided, so "allow for this session" was
   * refused and the same tool asked again on every call, forever.
   */
  scope: z.enum(['once', 'session', 'always']),
  /**
   * What to tell the agent, when the answer is no.
   *
   * A denial already reaches the provider as a message — it is how an agent
   * learns to try something else rather than only that it was stopped. Until now
   * that message was a fixed string, so the one thing worth saying could not be
   * said. Optional: most denials have no words, and an empty one keeps the
   * default.
   */
  message: z.string().optional(),
})
export type ApprovalChoice = z.infer<typeof ApprovalChoice>

/**
 * An answer to a question set, on its way back to the agent that asked.
 *
 * `timeout` is not in the outcome list on purpose. The deadline belongs to the
 * orchestrator, which holds the timer; letting the window send one would let the
 * UI declare a question expired before it was.
 *
 * `values` is an array even for a single choice, because that is Codex's wire
 * format and flattening it here would lose multi-select on the way back.
 */
export const QuestionAnswer = z.object({
  conversationId: z.string(),
  /** Which agent asked — several can be waiting at once in a shared room. */
  agentId: AgentIdSchema,
  userInputId: z.string(),
  outcome: z.enum(['answered', 'cancel']),
  answers: z.array(z.object({ questionId: z.string(), values: z.array(z.string()) })),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

/**
 * One entry per operation, each with its own request/response schema. Adding a
 * channel means adding it here first — `contextBridge` is generated from this.
 */
/**
 * What Chorus can say about a conversation's editor (plan §3).
 *
 * Mirrors the protocol's status list exactly; the renderer gives every member
 * localized text, and `ready` is the only one that draws the card.
 */
export const IdeStatusShape = z.enum([
  'unavailable',
  'unmatched',
  'untrusted',
  'unsupported',
  'ambiguous',
  'tooLarge',
  'ready',
])
export type IdeStatusShape = z.infer<typeof IdeStatusShape>

/**
 * Which version of the file the selected lines are — mirroring the protocol's
 * `provenance`, the same way the status list above mirrors its statuses.
 *
 * Restated rather than imported so the renderer's dependencies stay where they
 * are. Drift is not silent: `toPushFile` builds this out of an `EditorMetadata`
 * and would stop typechecking.
 *
 * The renderer needs it because a selection from a merge request diff is not
 * the file on disk, and a pill that says `src/app.ts:120-134` and means
 * something else is worse than one that says nothing.
 */
export const IdeProvenanceShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worktree') }),
  z.object({ kind: z.literal('ref'), ref: z.string() }),
  z.object({ kind: z.literal('review'), commit: z.string() }),
])
export type IdeProvenanceShape = z.infer<typeof IdeProvenanceShape>

/**
 * The live frame the renderer sees.
 *
 * Note what is *not* here: no absolute path, no file URL, and no source text.
 * The renderer is given a path already relative to the conversation's own cwd,
 * so a pane cannot display — or leak into a screenshot — where the project sits
 * on disk, and cannot show a byte of code before Send.
 */
export const IdeContextPush = z.object({
  conversationId: z.string(),
  /**
   * Which editor this came from — Phase 6 slice 6f.
   *
   * **Two sources are live at once.** Chorus's embedded workbench reports through
   * `workbench:context`, and the external VS Code bridge still reports over its
   * socket. Before this field the renderer had no way to tell them apart, so the
   * composer labelled everything `VS Code` — including a selection made in
   * Chorus's own editor, which is a disclosure saying the wrong thing about where
   * a person's code is going.
   *
   * Disclosure is the reason this is in the payload rather than inferred. The
   * pill exists to answer "what am I about to send, and from where"; an answer
   * the renderer guesses is not an answer.
   */
  editor: z.enum(['workbench', 'external']),
  status: IdeStatusShape,
  file: z
    .object({
      relativePath: z.string(),
      /** One-based and inclusive; converted once, at the protocol boundary. */
      startLine: z.number().int(),
      endLine: z.number().int(),
      isEmpty: z.boolean(),
      isDirty: z.boolean(),
      languageId: z.string(),
      selectedBytes: z.number().int(),
      provenance: IdeProvenanceShape,
      /**
       * Whether this is the live selection or the last one remembered.
       *
       * Dropped here until 2026-08-13, which is why the pill could not say
       * `cached` even though the extension had been sending it since the
       * feature shipped — and why a remembered selection was indistinguishable
       * from a current one at the moment it mattered.
       */
      source: z.enum(['current', 'cached']),
    })
    .nullable(),
})
export type IdeContextPush = z.infer<typeof IdeContextPush>

/** The answer to a Send-time snapshot request. */
export const IdeSnapshotResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    relativePath: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    isEmpty: z.boolean(),
    isDirty: z.boolean(),
    languageId: z.string(),
    text: z.string(),
    preview: z.literal(true).optional(),
    /**
     * The editor's model version for this file — Phase 6e.
     *
     * **`modelVersion`, not `version`.** The compose path already has a
     * `version`, and it means something else entirely: which *revision* these
     * lines came from, working tree or a ref. Two fields called `version` in one
     * message, meaning "which commit" and "which buffer state", is a collision
     * that would be discovered by an agent quoting the wrong one.
     *
     * Absent from the external bridge, which has no notion of it. Optional
     * rather than nullable so the field simply is not there when it cannot be
     * known — a `null` would invite a caller to send it as `base_version`.
     */
    modelVersion: z.number().int().optional(),
    /**
     * Which editor answered — Phase 6.
     *
     * The two sources want different treatment and `provenance` cannot tell them
     * apart: both report `worktree`. The embedded workbench sends the selected
     * text because it is the editor in the person's window; the external bridge
     * keeps its existing behaviour of naming the lines and leaving the agent to
     * open the file.
     */
    editor: z.enum(['workbench', 'external']).optional(),
    provenance: IdeProvenanceShape,
  }),
  z.object({ outcome: z.literal('unavailable'), reason: IdeStatusShape }),
  z.object({ outcome: z.literal('tooLarge'), selectedBytes: z.number().int() }),
])
export type IdeSnapshotResult = z.infer<typeof IdeSnapshotResult>

/**
 * Which terminal — a discriminated union, never a nullable conversation id.
 *
 * The global terminal belongs to no conversation. Flattening that to a nullable
 * field, or to a `'global'` sentinel sharing a namespace with real ids, is how
 * it ends up deleted by something iterating conversations. As a union an unknown
 * scope is a parse failure at this boundary rather than a lookup miss three
 * layers in.
 *
 * **`id` names one shell within a scope**, because a session and the global
 * panel each hold several. It is part of the tuple rather than a replacement
 * for it: a session terminal is `(scope, conversationId, id)`. Minted by the
 * renderer, which owns the roster — main learns of a terminal when something
 * attaches to it and spawns the shell then.
 */
export const TerminalRefShape = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global'), id: z.string() }),
  z.object({ scope: z.literal('session'), conversationId: z.string(), id: z.string() }),
  z.object({ scope: z.literal('project'), projectId: z.string(), id: z.literal('run') }),
  z.object({ scope: z.literal('shell'), projectId: z.string(), id: z.string() }),
])
export type TerminalRefShape = z.infer<typeof TerminalRefShape>

const TeardownTerminalRefShape = TerminalRefShape.refine((ref) => ref.scope !== 'project', {
  message: 'a project run is stopped through run:stop',
})

/**
 * One terminal's identity, as a string.
 *
 * `id` alone is not it — two conversations may hold the same id, which is the
 * note above — so the whole tuple is. **One definition, because two processes
 * read it**: main keys a per-terminal partial-line buffer on this, and the
 * renderer keys its source selector's values on it. Two spellings of one
 * identity is how a line gets filed against the wrong terminal, which is the
 * defect the buffer is being keyed to fix.
 */
export const terminalRefKey = (ref: TerminalRefShape): string => {
  switch (ref.scope) {
    case 'global':
      return `global:${ref.id}`
    case 'session':
      return `session:${ref.conversationId}:${ref.id}`
    case 'project':
      return `project:${ref.projectId}:${ref.id}`
    case 'shell':
      return `shell:${ref.projectId}:${ref.id}`
  }
}

export const TrafficHttpRowShape = z.object({
  source: z.literal('http'),
  seq: z.number().int(),
  /*
   * Present from the moment the request starts, because a row is drawn before
   * its exchange has finished — that is what "pending rows immediately" means,
   * and a row that appeared only at settle would hide every slow request.
   */
  requestId: z.string(),
  m: z.string(),
  u: z.string(),
  dpop: z.boolean(),
  /** Null until upstream answered: a request in flight has no status yet. */
  status: z.number().int().nullable(),
  aborted: z.boolean(),
  parsed: z.boolean(),
  code: z.string().nullable(),
  nextAction: z.string().nullable(),
  /**
   * Why the exchange failed to happen — `ECONNREFUSED`, `upstream timeout`.
   *
   * Not folded into `code`, which is parsed from a response body and is null
   * exactly when there was no body. A transport failure is the other fact: no
   * answer, and this is why.
   */
  transport: z.string().nullable(),
})

export const TrafficLogRowShape = z.object({
  source: z.literal('log'),
  seq: z.number().int(),
  ref: TerminalRefShape,
  line: z.string(),
  exit: z.number().int().nullable(),
})

export const TrafficLogcatRowShape = z.object({
  source: z.literal('logcat'),
  seq: z.number().int(),
  line: z.string(),
})

export const TrafficRowShape = z.discriminatedUnion('source', [
  TrafficHttpRowShape,
  TrafficLogRowShape,
  TrafficLogcatRowShape,
])
export type TrafficRowShape = z.infer<typeof TrafficRowShape>

export const TrafficSourceShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('terminal'), ref: TerminalRefShape }),
  z.object({ kind: z.literal('logcat'), filters: z.string() }),
])
export type TrafficSourceShape = z.infer<typeof TrafficSourceShape>

export const TRAFFIC_CAPTURE = 1_000

export const DEFAULT_LOGCAT_FILTER = 'ReactNativeJS:V AndroidRuntime:E'

export const DEFAULT_TRAFFIC_PORT = 30_100

/**
 * What a paged transcript read cannot fold for itself.
 *
 * Kept beside the channel rather than derived from the store's own type, because
 * this is the wire contract: main validates it on the way out and preload on the
 * way in, and a shape imported from the store would make those two checks agree
 * with each other for the wrong reason.
 */
export const LiveStateShape = z.object({
  work: z.array(
    z.object({
      agentId: z.string(),
      generation: z.number().int(),
      startedAt: z.number().int(),
      evidenceAt: z.number().int(),
    })
  ),
  chat: z.array(
    z.object({
      requestId: z.string(),
      agentId: z.string(),
      startedAt: z.number().int(),
      evidenceAt: z.number().int(),
    })
  ),
  operations: z.array(
    z.object({
      agentId: z.string(),
      requestId: z.string().nullable(),
      generation: z.number().int(),
      itemRef: z.string(),
      kind: z.enum(['tool', 'command']),
      name: z.string(),
      detail: z.string().nullable(),
      startedAt: z.number().int(),
    })
  ),
  handoffs: z.array(
    z.object({
      handoffId: z.string(),
      from: z.string(),
      to: z.string(),
      sourceEventIds: z.array(z.string()),
      createdAt: z.number().int().nullable(),
      outcome: z.enum(['submitted', 'failed', 'cancelled', 'unavailable']).nullable(),
      outcomeAt: z.number().int().nullable(),
    })
  ),
})
export type LiveStateWire = z.infer<typeof LiveStateShape>

export const TranscriptAssignmentShape = z.object({
  linked: z.boolean(),
  boundTaskId: z.string().nullable(),
})

export type TranscriptAssignment = z.infer<typeof TranscriptAssignmentShape>

const TranscriptStateShape = z.object({
  replies: z.array(TranscriptEvent).optional(),
  live: LiveStateShape.optional(),
  task: TaskBundleShape.nullable().optional(),
  assignment: TranscriptAssignmentShape.optional(),
  approvals: z.array(
    z.object({
      approvalId: z.string(),
      agentId: z.string(),
      kind: z.string(),
      request: z.unknown(),
      expiresAt: z.number().int(),
      mode: z.literal('discussion').optional(),
      requestId: z.string().min(1).optional(),
    })
  ),
  questions: z.array(
    z.object({
      userInputId: z.string(),
      eventId: z.string(),
      agentId: z.string(),
      request: z.unknown(),
      expiresAt: z.number().int(),
      mode: z.literal('discussion').optional(),
      requestId: z.string().min(1).optional(),
    })
  ),
  working: z.array(z.string()),
  workingSince: z.record(z.string(), z.number()).optional(),
  usageByActor: z.record(
    z.string(),
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number().nullable(),
    })
  ),
})

export type TranscriptStatePayload = z.infer<typeof TranscriptStateShape>

/**
 * One project as the rail receives it.
 *
 * Named rather than written inline because two channels answer with it now —
 * `project:list` and `project:reorder`, the second so a drag redraws from the
 * same shape the first established rather than from a patch the renderer
 * assembles. Two inline copies of this object would be two schemas free to
 * disagree the next time a field is added, and the field most likely to be added
 * is one the rail draws.
 */
export const ListedProject = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  root: z.string(),
  lastOpenedAt: z.number(),
  /** How many of this project's conversations are open right now. */
  openConversations: z.number().int().min(0),
  /**
   * What agents in this project may do — one answer for every conversation in
   * it. Null means the project has never been asked and the renderer should show
   * whatever the app's default profile is, rather than inventing one of its own.
   */
  profileId: z.string().nullable(),
  /**
   * The cast. **Null is not an empty cast** — it is "never asked", which is every
   * project that predates the setting. An empty array is a project somebody
   * deliberately emptied, and the two must render differently or the second one
   * silently regains its agents.
   */
  agentIds: z.array(AgentIdSchema).nullable(),
  /**
   * The person's scratchpad for this project — pending work, things to check
   * after something.
   *
   * On the listing because the pad is drawn from the same array the rail is,
   * and a separate read would mean the note and the project it belongs to could
   * be one refresh apart. Null is a project that has never had one; `''` is one
   * that was emptied.
   */
  notes: z.string().nullable(),
  /**
   * How big that note's panel was left, as fractions of the window.
   *
   * On the listing for the same reason the note is: the pad and the box it is
   * read in are drawn from one array, so they cannot be one refresh apart. Null
   * on either axis is a note nobody has dragged, which leaves the size the
   * stylesheet picks.
   */
  noteWidth: z.number().nullable(),
  noteHeight: z.number().nullable(),
  /**
   * The folder is not on disk right now — renamed, deleted, or on a volume that
   * is not mounted.
   *
   * Carried on the listing so the renderer can *draw* the state instead of
   * discovering it by failing. Before this existed, the first thing that touched
   * a vanished root threw `ProjectRootMissingError`, and on launch that thing was
   * the auto-start — so one stale project replaced the whole app with an error
   * screen that had no way back to the project it was complaining about.
   *
   * Read fresh on every list rather than stored: it is a fact about the world and
   * not about the project, so remounting the volume makes it false again with
   * nothing written.
   */
  missing: z.boolean(),
})

export const OpenSessionSchema = z.object({
  conversationId: z.string(),
  participants: z.array(AgentIdSchema),
  profileId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  title: z.string(),
  /** Counted out of the log against the saved watermark, not remembered. */
  unread: z.number().int().min(0),
  /**
   * Decisions still outstanding, by id.
   *
   * Ids and not counts, because the renderer clears them by id when the
   * answer arrives. They are rows with no outcome rather than a memory
   * of what was asked, so they are as true after a relaunch as before
   * one — the transcript has always drawn them; the tab's mark had no
   * way to know.
   */
  pendingApprovalIds: z.array(z.string()).default([]),
  pendingQuestionIds: z.array(z.string()).default([]),
  /** A message typed and not sent when the app last closed. */
  draft: z.string().default(''),
  /** Reading and reasoning, executing nothing. Never survives a restart. */
  planning: z.boolean().default(false),
  starting: z.boolean().optional(),
})

const StartConversationRequest = z.object({
  /*
   * The project it belongs to, and the `cwd` that used to be here is gone.
   *
   * That field let the renderer name any directory, and an empty one meant
   * "start at home" — so a conversation could be created somewhere nobody
   * had adopted, which is the thing Phase 2 spent its whole length making
   * impossible everywhere else. A session is started **in a project** now,
   * and a project is only ever made by a person choosing a folder from a
   * native dialog.
   */
  projectId: z.string().min(1),
  profileId: z.string().optional(),
  /**
   * A conversation whose transcript the new room starts holding.
   *
   * An id, never the text. The renderer naming a conversation can only
   * choose between rooms the log already has, and main reads the transcript
   * out of the store itself — the same rule `aside:open` states for its
   * source event, and for the same reason: a caller that could pass prose
   * here could put words into an agent's history and have them believed as
   * something the user said earlier.
   *
   * Absent means a fresh start, which is what Restart relies on: it goes
   * through this channel too and simply does not name a source.
   */
  continueFrom: z.string().optional(),
  objective: z.string().trim().min(1).max(2000).optional(),
  sourceEventIds: z.array(z.string().min(1).max(128)).max(20).optional(),
})

const StartedConversationShape = z.object({
  conversationId: z.string(),
  participants: z.array(AgentIdSchema),
  profileId: z.string(),
  /** The project's root, resolved. Still returned because the UI shows it. */
  projectId: z.string(),
  cwd: z.string(),
  /** Defaults to the folder's name; the user can rename it. */
  title: z.string(),
})

const NoteFraction = z.number().min(0).max(1)

export const ConversationNoteShape = z
  .object({
    body: z.string(),
    revision: z.number().int().min(0),
    version: z.number().int().min(0),
    visible: z.boolean(),
    x: NoteFraction.nullable(),
    y: NoteFraction.nullable(),
    width: NoteFraction.nullable(),
    height: NoteFraction.nullable(),
    updatedBy: z.string().nullable(),
    updatedAt: z.number(),
  })
  .strict()
export type ConversationNoteShape = z.infer<typeof ConversationNoteShape>

export const IPC_CONTRACT = {
  'app:getInfo': { request: z.void(), response: AppInfo },
  /**
   * Reads the installed `codex` and `claude` versions. These get recorded on
   * `session.started` so a break after a CLI self-update is visible in the log
   * rather than a guess (plan §2.5).
   */
  'agents:probe': { request: z.void(), response: z.array(AgentProbeResult) },

  'conversation:start': {
    /**
     * Several agents share one conversation — that is the point of Chorus, and
     * it is no longer something the caller states.
     *
     * `agents` stood here and the renderer filled it from the settings file, so
     * a new chat opened with whatever that happened to hold and a project's own
     * cast was never consulted. Every conversation now seats every agent, which
     * is a fact main owns; the renderer cannot ask for less and cannot get it
     * wrong.
     */
    request: StartConversationRequest,
    response: StartedConversationShape,
  },
  'conversation:begin': {
    request: StartConversationRequest,
    response: StartedConversationShape,
  },
  'conversation:awaitStart': {
    request: z.object({ conversationId: z.string() }),
    response: z.discriminatedUnion('status', [
      z.object({ status: z.literal('ready'), conversation: StartedConversationShape }),
      z.object({ status: z.literal('failed'), message: z.string() }),
      z.object({ status: z.literal('cancelled') }),
    ]),
  },
  'conversation:send': {
    request: z.object({
      conversationId: z.string(),
      text: z.string().min(1),
      /**
       * An instruction to expand in main, rather than the instruction itself.
       *
       * `go` is the quick action under a reply that offered to do one thing. It
       * delivers `goPrompt()` while `text` — `@claude Go ahead.` — is what the
       * transcript keeps, the same split `sendUserMessage(text, delivered)` makes
       * for asides and for the same reason: logging the wrapper puts words in the
       * user's mouth in their own transcript.
       *
       * **A name, not a string.** The prompt is built in main because prompt
       * content from the renderer is the same class of problem as an unverified
       * source event — see `aside:open`'s note on exactly this. A renderer that
       * could name any intent can only choose between the ones main knows.
       */
      intent: z.enum(['go', 'collaborate']).optional(),
      mode: z.enum(['auto', 'ask', 'guide', 'discussion', 'work']).optional(),
    }),
    /** Which agents the mention router picked, so the UI can show it. */
    response: z.object({ targets: z.array(AgentIdSchema) }),
  },
  'conversation:interrupt': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  'conversation:getNote': {
    request: z.object({ conversationId: z.string().min(1) }).strict(),
    response: ConversationNoteShape,
  },
  'conversation:setNoteText': {
    request: z
      .object({
        conversationId: z.string().min(1),
        text: z.string().max(CONVERSATION_NOTE_MAX_LENGTH),
        baseRevision: z.number().int().min(0),
      })
      .strict(),
    response: z
      .object({ status: z.enum(['saved', 'conflict']), note: ConversationNoteShape })
      .strict(),
  },
  'conversation:setNoteView': {
    request: z
      .object({
        conversationId: z.string().min(1),
        visible: z.boolean().optional(),
        x: NoteFraction.optional(),
        y: NoteFraction.optional(),
        width: NoteFraction.optional(),
        height: NoteFraction.optional(),
      })
      .strict(),
    response: ConversationNoteShape,
  },
  /**
   * Replays from the log rather than from provider history — Codex discards
   * partial assistant output, so the log is the only complete record (S3).
   */
  /**
   * Ends one conversation. Others keep running — the grid holds several at once,
   * and closing one pane must not touch the agents in the next.
   */
  /*
   * `conversation:addAgent` and `conversation:removeAgent` stood here and both
   * are gone.
   *
   * They were the cast being chosen a room at a time. Every conversation holds
   * every agent now, so there is nobody to bring in and nobody to take out —
   * and a live channel would still let anything holding the preload bridge empty
   * a room, which is the state the cast being fixed exists to make unreachable.
   * An agent that is absent is a start that failed, and the fix for that is a
   * key or an install, not a channel.
   */

  /**
   * Asks for a directory with the system's folder chooser, and applies it.
   *
   * One call rather than "pick" then "set": the chosen path never has to cross
   * back through the renderer, and a cancelled dialog cannot leave the two
   * halves disagreeing about where the conversation is.
   */
  /**
   * Reopens what was on screen when the app last ran.
   *
   * Called once, at startup. Returns an empty list when nothing was open, which
   * is the same shape as a first launch.
   */
  'conversation:restore': {
    request: z.object({}),
    response: z.object({
      sessions: z.array(OpenSessionSchema),
      workspace: WorkspaceSnapshot.nullable(),
    }),
  },

  'conversation:active': {
    request: z.object({}),
    response: z.object({ sessions: z.array(OpenSessionSchema) }),
  },

  /**
   * How the inherited MCP servers are doing.
   *
   * Asked live every time, because a server's health is the thing that changes
   * — it can drop, or come back once authenticated — and a cached answer would
   * be worse than none.
   */
  'agents:mcp': {
    request: z.object({}),
    response: z.object({
      servers: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled']),
          error: z.string().optional(),
          tools: z.number().int().optional(),
        })
      ),
    }),
  },

  /**
   * Which account each agent is signed in as.
   *
   * Asked live for the same reason as the servers: signing in somewhere else
   * changes the answer while the app is running. Every field is optional
   * because off the first-party API most of them do not exist — a Bedrock
   * session has credentials, not a plan.
   */
  /**
   * Ends one thing an agent left running.
   *
   * Carries the agent because a task id belongs to the provider that issued it.
   * Answers `ok` once the request is delivered, not once the task is gone — the
   * next push is what reports that.
   */
  'tasks:stop': {
    request: z.object({
      conversationId: z.string(),
      agentId: AgentIdSchema,
      taskId: z.string(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * The user's installed plugins, and whether they are switched on.
   *
   * Read from the CLI each time rather than cached: a plugin can be enabled or
   * removed while Chorus is running, and the sheet is opened precisely when
   * someone wants to know the current answer.
   */
  'agents:plugins': {
    request: z.object({}),
    response: z.object({
      plugins: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          enabled: z.boolean(),
          scope: z.string(),
          version: z.string().optional(),
        })
      ),
    }),
  },

  /**
   * Installs one of the skills Chorus offers, through the user's own `claude`.
   *
   * **`skill` is an enum rather than a marketplace and a plugin name**, so a
   * renderer cannot ask for arbitrary code from an arbitrary repository — the
   * closed set lives in `plugins.ts` and this is its boundary.
   *
   * The answer is what was observed afterwards, not what the command exited
   * with. `detail` carries the CLI's own words on failure and is deliberately
   * not a translation key: it is another program's message, like the error an
   * API-key save shows.
   */
  'agents:installSkill': {
    request: z.object({ skill: z.enum(['typesafe']) }),
    response: z.object({
      state: z.enum(['installed', 'unavailable', 'unconfirmed', 'failed']),
      detail: z.string().default(''),
    }),
  },

  /**
   * Whether a stored service credential works, answered by using it once.
   *
   * **This call is billed**, because TypeSafe documents no free endpoint — see
   * `typesafe.ts`. So it is wired to a button and to nothing else: no launch
   * check, no poll, no revalidation when the sheet opens. A channel that looks
   * cheap and is not is the reason this comment exists.
   */
  'agents:checkServiceKey': {
    request: z.object({ service: z.enum(['typesafe']) }),
    response: z.object({
      state: z.enum(['valid', 'missing', 'rejected', 'malformed', 'busy', 'unreachable']),
      detail: z.string().default(''),
    }),
  },

  'agents:account': {
    request: z.object({}),
    response: z.object({
      accounts: z.array(
        z.object({
          agentId: z.string(),
          email: z.string().optional(),
          organization: z.string().optional(),
          plan: z.string().optional(),
          provider: z.string().optional(),
        })
      ),
    }),
  },

  /**
   * The model lists last reported by each agent, for the settings sheet.
   *
   * A cache rather than a live ask: `supportedModels()` is a control request to
   * a running CLI, and the sheet can be opened with nothing running. The list
   * does not change under an installed CLI, so the one a session already
   * answered with is the right one to remember.
   */
  'agents:models': {
    request: z.object({}),
    response: z.object({
      agents: z.array(
        z.object({
          agentId: AgentIdSchema,
          /**
           * Why the list is what it is. An empty `ready` and an empty `failed`
           * look identical without this, and the sheet has to say different
           * things about them.
           */
          status: z.enum(['unqueried', 'loading', 'ready', 'failed']),
          models: z.array(
            z.object({
              /** The provider's own default, when it names one. See `ModelChoice`. */
              isDefault: z.boolean().optional(),
              value: z.string(),
              label: z.string(),
              effortLevels: z.array(z.string()).default([]),
            })
          ),
        })
      ),
    }),
  },

  /**
   * Every conversation the log holds, most recently active first.
   *
   * A query rather than a push: it is only wanted when someone opens the list,
   * and the answer is a projection read that is cheap to repeat.
   */
  'conversation:list': {
    request: z.object({}),
    response: z.object({
      conversations: z.array(
        z.object({
          conversationId: z.string(),
          title: z.string(),
          projectId: z.string(),
          cwd: z.string(),
          agents: z.array(z.string()),
          updatedAt: z.number().int(),
          messages: z.number().int(),
          /** Already on screen, so choosing it focuses rather than reopens. */
          open: z.boolean(),
        })
      ),
    }),
  },

  /**
   * Brings a past conversation back with its transcript.
   *
   * Its agents are started rather than resumed — the provider threads died with
   * the session — so they read the history as catch-up on the first thing asked.
   */
  'conversation:reopen': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      conversationId: z.string(),
      participants: z.array(AgentIdSchema),
      profileId: z.string(),
      projectId: z.string(),
      cwd: z.string(),
      title: z.string(),
      unread: z.number().int().min(0),
      /**
       * Still outstanding, by id — the same fields `conversation:restore`
       * carries, for the same reason. A conversation reached from history is
       * the likeliest place to find a decision nobody answered.
       */
      pendingApprovalIds: z.array(z.string()).default([]),
      pendingQuestionIds: z.array(z.string()).default([]),
      starting: z.boolean().optional(),
    }),
  },

  /**
   * Files in the conversation's project, for the composer's `@` menu.
   *
   * The renderer has no filesystem access and the SDK gives no way to reach the
   * CLI's own matcher, so the search happens here. Asked per keystroke, which
   * is why it is a query rather than a list handed over once.
   */
  /*
   * `state` travels beside the list because an empty list is two different
   * answers. Git saying "nothing matches" is a result; git not running at all is
   * a question still outstanding, and folding both into `[]` is what let a menu
   * go empty and stay empty (C-003). `files` is always present and always empty
   * unless the state is `ready`.
   */
  'files:complete': {
    request: z.object({ conversationId: z.string(), query: z.string() }),
    response: z.object({
      state: z.enum(['ready', 'retryable', 'unavailable']),
      files: z.array(z.string()),
    }),
  },

  /**
   * The slash commands this conversation's agents accept.
   *
   * A query rather than a push: the menu asks when it opens, and the answer is
   * cached in the runtime for the life of each session.
   */
  'conversation:commands': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      commands: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          argumentHint: z.string(),
        })
      ),
    }),
  },

  /**
   * Puts a conversation's agents into plan mode, or takes them out.
   *
   * Returns what the mode actually is afterwards, so a control cannot show a
   * state the session did not reach.
   */
  /**
   * Turns the standing instruction on or off for one conversation.
   *
   * `planMode`'s twin, including the return: what the conversation actually is
   * afterwards, never what was asked for. The two differ in cost — this one
   * respawns each agent onto its existing thread, because a system prompt cannot
   * be changed on a live session — so a caller must not fire it while a turn is
   * streaming.
   */
  'conversation:answerStyle': {
    /*
     * `on` is optional, and omitting it is a read.
     *
     * The alternative was a second channel whose only job was to report a
     * boolean the setter already returns. This shape exists because the control
     * lives in the composer, which unmounts with its tab — so it has to be able
     * to ask what the conversation is currently doing, and the answer has to come
     * from the runtime rather than from a settings default the room may have been
     * toggled away from.
     */
    request: z.object({ conversationId: z.string(), on: z.boolean().optional() }),
    response: z.object({ styleOn: z.boolean() }),
  },

  'conversation:planMode': {
    request: z.object({ conversationId: z.string(), on: z.boolean() }),
    response: z.object({ planning: z.boolean() }),
  },

  /**
   * Remembers a message typed and not sent.
   *
   * Renderer-driven and debounced there, because it owns the keystrokes. Losing
   * one costs the last second of typing, which is why it is fire-and-forget.
   */
  'conversation:draft': {
    request: z.object({ conversationId: z.string(), draft: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Records how far a conversation's card has been read.
   *
   * Renderer-driven because only it knows which tab is in front, and "read"
   * means "was on screen". Fire-and-forget: losing one costs a card that says
   * two unread instead of none after the next launch.
   */
  'conversation:markSeen': {
    request: z.object({ conversationId: z.string(), seq: z.number().int().min(0) }),
    response: z.object({ ok: z.literal(true) }),
  },

  'conversation:reveal': {
    request: z.object({ projectId: z.string(), conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Writes pasted bytes down and returns the path.
   *
   * Base64 because the bridge carries JSON; a screenshot is a few megabytes
   * once, which is cheaper than teaching the whole protocol about binaries.
   */
  'files:stash': {
    request: z.object({ name: z.string(), base64: z.string() }),
    response: z.object({ path: z.string() }),
  },

  'files:stashNoteImage': {
    request: z.object({ url: z.string() }),
    response: z.object({ path: z.string() }),
  },

  /**
   * A folder to attach, chosen from a real dialog.
   *
   * It takes no conversation and changes no state; it returns a path.
   *
   * That used to distinguish it from `conversation:chooseCwd`, which opened the
   * same dialog and then repointed a conversation. That channel is gone — a
   * conversation belongs to a project and cannot be moved — so this is now the
   * only folder dialog in the product, and both callers ask it the same
   * question: attaching a folder to a message, and choosing where the next
   * session opens. Neither moves anything that already exists.
   */
  'files:chooseDirectory': {
    request: z.void(),
    response: z.object({ path: z.string().nullable() }),
  },

  /** Enough to show an attachment: its name, its size, and a preview if it has one. */
  'files:preview': {
    request: z.object({ path: z.string() }),
    response: z.object({
      name: z.string(),
      bytes: z.number(),
      dataUrl: z.string().nullable(),
    }),
  },

  /**
   * Persists the whole arrangement in one write.
   *
   * `order` is the **sidebar's** order of running conversations, and only that.
   * Each pane's tab order lives inside `workspace`, where it belongs — the two
   * were briefly both called "order", which is exactly how they would have
   * drifted apart.
   */
  /**
   * Asks every live agent to re-read its account's usage windows.
   *
   * The windows otherwise only arrive after a turn, so someone who has just
   * been cut off can only find out they are back by spending something. The
   * answer comes back on the limits push, not here — this only asks.
   */
  'limits:refresh': { request: z.void(), response: z.object({ ok: z.literal(true) }) },

  /**
   * The dock badge, set by the renderer because only it knows how many rooms are
   * blocked on a person. Main owns the API; the count is not main's to compute.
   */
  'app:setBadge': {
    request: z.object({ count: z.number().int().min(0) }),
    response: z.object({ ok: z.literal(true) }),
  },
  'app:notify': {
    request: z.object({ title: z.string(), body: z.string(), projectId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Puts text on the system clipboard, for the copy control on a code block.
   *
   * Main rather than the renderer, and it is not a preference. `security.ts`
   * answers every renderer permission request with `false`, which is what
   * `navigator.clipboard.writeText` has to ask for — and the preload runs
   * sandboxed, where Electron exposes `ipcRenderer` and `webUtils` but not
   * `clipboard`. Main is the only side of the bridge that can actually write.
   *
   * Write-only on purpose. Reading the clipboard would hand untrusted agent
   * output a way to ask what the user last copied, and nothing here needs it.
   */
  'app:copyText': {
    request: z.object({ text: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  'conversation:layout': {
    request: z.object({ order: z.array(z.string()), workspace: WorkspaceSnapshot }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Names a conversation. An empty name asks for the folder's name back. */
  'conversation:rename': {
    request: z.object({ conversationId: z.string(), title: z.string() }),
    response: z.object({ title: z.string() }),
  },

  /*
   * The project registry, reachable at last — Phase 2's exit criteria say a
   * project can be created, opened, renamed and removed, and until now the last
   * two existed only as methods nothing could call.
   *
   * **No channel here takes a path.** Creating one is `conversation:start`
   * adopting the folder a person picked from a native dialog; everything else
   * names a project by id. That is the same rule `workbench:open` follows, and
   * it is what stops the registry becoming a second way to say "open this
   * arbitrary directory".
   */
  /**
   * Add Project: the native chooser, and a project for whatever comes back.
   *
   * No arguments and no path in either direction's request, for the reason
   * `workbench:chooseProject` gives — choosing *is* the authorisation, and a
   * `defaultPath` would be the renderer naming a directory one indirection out.
   * `project` is null when the dialog was cancelled.
   *
   * Idempotent by way of `adopt`: picking a folder that is already a project
   * returns that project rather than a second one, and `created` says which
   * happened so the rail can say "you already have this" instead of quietly
   * doing nothing visible.
   */
  'project:adopt': {
    request: z.object({}).strict(),
    response: z.object({
      project: z
        .object({ id: z.string(), name: z.string(), root: z.string(), created: z.boolean() })
        .nullable(),
    }),
  },

  'project:adoptRemote': {
    request: z.object({ host: z.string(), root: z.string() }).strict(),
    response: z.object({
      project: z
        .object({ id: z.string(), name: z.string(), root: z.string(), created: z.boolean() })
        .nullable(),
    }),
  },

  'project:checkRemoteHost': {
    request: z.object({ host: z.string() }).strict(),
    response: z.object({
      reachable: z.boolean(),
      platform: z.string().nullable(),
      quotingHolds: z.boolean(),
      detail: z.string(),
    }),
  },

  'project:list': {
    request: z.object({}).strict(),
    response: z.object({ projects: z.array(ListedProject) }),
  },

  'workbench:target': {
    request: z.object({ projectId: z.string() }),
    response: z.object({ host: z.string(), root: z.string() }),
  },

  'workbench:projectOpened': {
    request: z.object({ projectId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  'workbench:terminalEnvFor': {
    request: z.object({
      place: z.object({ host: z.string(), root: z.string() }),
      ensure: z.boolean().optional(),
    }),
    response: z.object({ name: z.string(), value: z.string() }).nullable(),
  },

  'project:rename': {
    request: z.object({ projectId: z.string(), name: z.string() }),
    response: z.object({ name: z.string() }),
  },

  /**
   * A project moves to sit immediately before another, or to the end.
   *
   * **This was a swap and is now an insertion**, because a swap is not what
   * dragging a card means: dragging the last tile to the top exchanged it with
   * the first and left everything between untouched, so one gesture produced two
   * moves and the list you were looking at was not the list you were arranging.
   *
   * **Still ids and no index**, which is the property the swap had that was
   * worth keeping: a position would be the shell's opinion about an order main
   * owns, and a stale one — the rail redraws from a pushed list — would move the
   * wrong tile in silence. `beforeId` names the neighbour instead, so the worst
   * a stale drag can do is land beside a tile that is still there.
   *
   * `null` is the end of the list, which is the one position no neighbour can
   * name.
   *
   * Answers with the whole list rather than an acknowledgement, so one gesture
   * costs one round trip and the rail redraws from the store's order rather than
   * from its own guess at what moved. That matters more than it did for a swap:
   * an insertion renumbers everything between the two.
   */
  'project:reorder': {
    request: z.object({ projectId: z.string(), beforeId: z.string().nullable() }),
    response: z.object({ projects: z.array(ListedProject) }),
  },

  /**
   * Sets what agents may do in a project, and in everything running in it.
   *
   * This replaces `policy:set`'s role for a live conversation. A profile is an
   * answer about a *place* — "agents may write in this repository" — so asking
   * it once per conversation both repeated the question and allowed two rooms in
   * one directory to disagree about what could be run there.
   *
   * Main writes the project's row first and then moves its live conversations,
   * each of which appends its own `policy.changed`: the row is current state and
   * the log is what happened.
   */
  'project:setProfile': {
    request: z.object({ projectId: z.string(), profileId: z.string() }),
    response: z.object({ profileId: z.string() }),
  },

  /*
   * `project:setAgents` stood here and is gone with the two conversation-level
   * ones above.
   *
   * A project's cast was the setting the project card wrote, and it is what made
   * the bug possible: the card could say three agents while `conversation:start`
   * was handed two out of `settings.json`, and the two answers had no reason to
   * agree. There is one answer now and main holds it.
   *
   * The `agent_ids` column and `Project.agentIds` stay, unread. Dropping a column
   * is a migration, and nothing is served by running one to delete a value that
   * no longer decides anything.
   */

  /**
   * Sets the project's scratchpad.
   *
   * **Nothing is told about it**, which is what separates this from its two
   * neighbours: a profile reconciles live conversations and a cast starts and
   * stops agents, while a note changes nothing that is running. It is a write.
   *
   * Sent whole rather than as a patch. The pad is one text box with one writer,
   * so there is no merge to do and a diff would be ceremony over a string.
   */
  'project:setNotes': {
    request: z.object({ projectId: z.string(), notes: z.string() }),
    response: z.object({ notes: z.string() }),
  },

  /**
   * How big that project's note was left — the twin of `app:setNoteSize`.
   *
   * Nullable on both axes where the app's note is not, and that is the one real
   * difference between the two notes: this one has no size of its own until it
   * is given one, because a project's note is as wide as the column it sits in
   * until somebody drags it narrower.
   */
  'project:setNoteSize': {
    request: z.object({
      projectId: z.string(),
      width: z.number().min(NOTE_SIZE.width.min).max(NOTE_SIZE.width.max).nullable(),
      height: z.number().min(NOTE_SIZE.height.min).max(NOTE_SIZE.height.max).nullable(),
    }),
    response: z.object({ width: z.number().nullable(), height: z.number().nullable() }),
  },

  /**
   * The app's own note, and how big its panel was left.
   *
   * Read as one call because they are written to one row and wanted at one
   * moment — the panel cannot open at the right size without both. Written as
   * two, because they change for unrelated reasons: text on a debounce while
   * typing, size once at the end of a drag.
   *
   * `notes` is null for an app whose note has never been written, which the
   * renderer shows as an empty field. That is the same distinction
   * `project:setNotes` keeps, and nothing reads it yet here either.
   */
  'app:getNote': {
    request: z.object({}),
    response: z.object({
      notes: z.string().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
    }),
  },

  'app:setNote': {
    request: z.object({ notes: z.string() }),
    response: z.object({ notes: z.string() }),
  },

  /**
   * The notes the masthead's menu keeps, all of them.
   *
   * Whole rather than paged, because the list is read by looking down it. Each
   * row's `notes` is nullable for the same reason `app:getNote`'s is: null means
   * never written, which is not the same as emptied.
   *
   * No title field anywhere on this surface. A row is labelled by its note's own
   * first line, derived in the renderer from the document it already holds.
   */
  'app:listKeptNotes': {
    request: z.object({}),
    response: z.object({
      notes: z.array(
        z.object({
          id: z.string(),
          notes: z.string().nullable(),
          createdAt: z.number(),
          updatedAt: z.number(),
        })
      ),
    }),
  },

  /**
   * Makes an empty note and answers its id.
   *
   * The row is not returned, so the caller re-reads the list: where a new note
   * sits is the store's decision, and a caller that spliced it in would be
   * guessing at an order it does not own. One extra call on a deliberate action.
   */
  'app:createKeptNote': {
    request: z.object({}),
    response: z.object({ id: z.string() }),
  },

  /**
   * Records one, and answers whether there was still one to record.
   *
   * **False is not a failure.** The editor saves on a debounce, so a write can
   * land after its note was deleted, and the delete is the later intention. The
   * renderer drops it rather than reporting anything.
   */
  'app:setKeptNote': {
    request: z.object({ id: z.string(), notes: z.string() }),
    response: z.object({ saved: z.boolean() }),
  },

  'app:removeKeptNote': {
    request: z.object({ id: z.string() }),
    response: z.object({ removed: z.boolean() }),
  },

  /**
   * The order of the whole list, after a row has been dragged.
   *
   * **The sequence rather than one row's new index**, because a move changes
   * where everything after it sits — sending one would leave the renderer and
   * the store each doing half the arithmetic and agreeing about the half they
   * cannot see.
   *
   * Answers nothing but acknowledgement. The caller already knows the order: it
   * is the one it just sent, and it is already drawing it.
   */
  'app:reorderKeptNotes': {
    request: z.object({ ids: z.array(z.string()) }),
    response: z.object({ ordered: z.boolean() }),
  },

  /**
   * Stores an image the note will refer to, and answers with its URL.
   *
   * **Base64 rather than bytes**, because every payload on this surface is
   * validated by the schema beside it and a `Uint8Array` is not something zod
   * can describe at a boundary that also has to survive structured cloning. The
   * cost is a third more bytes on one IPC call, once per image.
   *
   * The renderer never learns a path. It hands over content and receives a
   * `chorus-note:` URL — see `note-images.ts` for why that is a scheme rather
   * than a file reference.
   */
  'app:addNoteImage': {
    request: z.object({ data: z.string(), extension: z.string() }),
    response: z.object({ url: z.string() }),
  },

  /**
   * Opens the picker in main and stores what was chosen.
   *
   * Null for a cancelled dialog, which is an answer rather than a failure — the
   * caller draws nothing and reports nothing.
   */
  'app:pickNoteImage': {
    request: z.object({}),
    response: z.object({ url: z.string().nullable() }),
  },

  /**
   * Brings a remote image across and stores it.
   *
   * The fetch is main's because it has to be: `connect-src 'self'` stops the
   * renderer reaching the network, and `img-src` would not display the result
   * anyway. What comes back is this process's own scheme, like every other way
   * an image gets in.
   */
  'app:fetchNoteImage': {
    request: z.object({ address: z.string() }),
    response: z.object({ url: z.string() }),
  },

  /**
   * Fractions of the window, bounded here rather than only in the panel.
   *
   * The panel clamps as you drag, so this can only ever be reached by a bug or
   * by something that is not the panel — and an unbounded write is how a stored
   * size becomes one nobody can drag back, since the handle would be off screen.
   *
   * Both axes in one call because one corner drag moves both, and a null height
   * is the value that means "never dragged" rather than a missing field.
   */
  'app:setNoteSize': {
    request: z.object({
      width: z.number().min(NOTE_SIZE.width.min).max(NOTE_SIZE.width.max),
      height: z.number().min(NOTE_SIZE.height.min).max(NOTE_SIZE.height.max).nullable(),
    }),
    response: z.object({ width: z.number(), height: z.number().nullable() }),
  },

  /**
   * Drops a project from the registry.
   *
   * Refused while any of its conversations is open, and that refusal is the
   * point rather than a convenience: those rooms resolve their root through this
   * record, so removing it under them would leave a conversation whose directory
   * cannot be answered — and the failure would surface later, somewhere else, as
   * an agent unable to start.
   */
  'project:forget': {
    request: z.object({ projectId: z.string() }),
    response: z.object({ forgotten: z.boolean() }),
  },

  /**
   * Points a project at a different folder, after the old one moved or went.
   *
   * **The recovery `ProjectRootMissingError` was always written for** — its own
   * comment says the product's answer is Relocate rather than an error dialog —
   * and until now nothing exposed it, so a project whose checkout was renamed
   * became a launch that failed with no way forward from the screen it failed on.
   *
   * Takes no path. Main opens the picker, for the same reason `project:adopt`
   * does: a root the renderer could name is a root the renderer chose, and this
   * one is the person's to choose. `root: null` means they cancelled, which is
   * an answer rather than an error.
   *
   * Refused while the project has open conversations — an agent already running
   * holds the directory it was spawned in and would not notice the move.
   */
  'project:relocate': {
    request: z.object({ projectId: z.string() }),
    response: z.object({ root: z.string().nullable() }),
  },

  /*
   * `conversation:chooseCwd` and `conversation:setCwd` were here, and both are
   * gone rather than reshaped.
   *
   * They were the two ways a conversation could change its own directory — one
   * from a native dialog, one from any string the renderer cared to send. A
   * Project now owns the development environment and a Conversation belongs to
   * exactly one Project, so neither operation has a meaning: the room cannot
   * move on its own, and moving the project moves every room in it at once,
   * which is `ProjectService.relocate` and not a conversation channel.
   *
   * **Choosing a folder still works and did not need a channel of its own.**
   * `files:chooseDirectory` below already opens the same dialog and is
   * documented as the deliberately non-mutating twin — "it takes no conversation
   * and changes no state; it returns a path". The renderer now uses it to decide
   * where the *next* conversation opens, which is the only question a folder
   * picker is still allowed to answer.
   */
  'project:close': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({ ok: z.literal(true) }),
  },
  'conversation:close': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  'conversation:history': {
    request: z.object({ conversationId: z.string(), afterSeq: z.number().int().optional() }),
    response: z.array(TranscriptEvent),
  },
  /**
   * The transcript's own read: only the events it draws, plus how far it got.
   *
   * Separate from `conversation:history` rather than a filter on it, because
   * that channel has three consumers with different appetites — `SummaryPanel`
   * counts failures from `command.completed`, and the e2e specs assert on
   * `repo.changed.byUser`. Narrowing the shared one would have broken both
   * without a word.
   *
   * **`throughSeq` is not decoration.** `Session` asks for everything after
   * `view.lastSeq`, and the reducer advances `lastSeq` from the events it
   * renders. Filter the newest events away — and `command.output` is the
   * commonest event in the log, so this is the normal case rather than an edge
   * — and the response is empty, `lastSeq` never moves, and the same rows are
   * queried again on every push. Forever. The caller advances to
   * `max(lastSeq, throughSeq)` *without* feeding the skipped events to the
   * reducer: a filter that forgets what it filtered is a loop.
   */
  'conversation:transcript': {
    request: z.object({
      conversationId: z.string(),
      /** Incremental catch-up: everything since. The live path. */
      afterSeq: z.number().int().optional(),
      /**
       * Paging: the newest `limit` events *before* this seq.
       *
       * Absent with `limit` present means the first page — the newest `limit`
       * events, which is what opening a conversation wants. `afterSeq` and
       * `beforeSeq` are different questions and never combine: one asks what has
       * happened since, the other what was said before.
       */
      beforeSeq: z.number().int().optional(),
      limit: z.number().int().positive().optional(),
      live: z.boolean().optional(),
    }),
    response: z.object({
      events: z.array(TranscriptEvent),
      /** The log position this read covered, including events it filtered out. */
      throughSeq: z.number().int(),
      /**
       * State a page cannot contain, queried rather than folded.
       *
       * Present only on a read that is not incremental — a catch-up already has
       * the state in the view it is being folded into. A page is a *suffix*, so
       * an approval requested before it, a question still waiting, or what has
       * been spent are all invisible to the events it returns.
       */
      state: TranscriptStateShape.optional(),
    }),
  },
  'task:state': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({ task: TaskBundleShape.nullable(), throughSeq: z.number().int() }),
  },
  'task:close': {
    request: z.object({
      conversationId: z.string(),
      taskId: z.string().min(1).max(64),
      reason: z.enum(['completed', 'abandoned']),
    }),
    response: z.object({ closed: z.boolean() }),
  },
  'task:bindAssignment': {
    request: z.object({
      conversationId: z.string(),
      taskId: z.string().min(1).max(64),
    }),
    response: z.object({ bound: z.boolean() }),
  },
  'approval:decide': {
    request: ApprovalChoice,
    response: z.object({ ok: z.literal(true) }),
  },
  'userinput:answer': {
    request: QuestionAnswer,
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * A small question about one passage of one reply, asked in a fork.
   *
   * `excerpt` is sent so main can check it against what the log actually holds,
   * not so main can trust it. The renderer is the least trustworthy thing in the
   * process tree — it renders untrusted agent output — and a caller that could
   * name any event and any excerpt could put words in an agent's mouth and have
   * them quoted back as its own.
   *
   * There is no `aside:history`: an aside is a conversation, so
   * `conversation:history` already reads it, and its events reach the renderer
   * on the same push channel as everything else.
   */
  'aside:open': {
    request: z.object({
      conversationId: z.string(),
      sourceEventId: z.string(),
      excerpt: z.string().min(1),
      /**
       * Usually absent. The card opens the aside as soon as it appears so the
       * CLI boots while the user types, and sends the question separately —
       * about two thirds of the measured wait was process startup rather than
       * the agent, and this is what moves it off the critical path.
       */
      question: z.string().min(1).optional(),
      /**
       * `explanation` carries its own first turn — main reads the language and
       * builds the prompt, because prompt content from the renderer is the same
       * class of problem as an unverified source event.
       */
      purpose: z.enum(['question', 'explanation', 'translation']).optional(),
    }),
    /**
     * The language main actually used, echoed back.
     *
     * The renderer keeps its own copy for the button's label, and that copy can
     * be a moment stale — long enough for a card to say Arabic while the prompt
     * and the log say French. Main is authoritative, so it says which it was.
     */
    response: z.object({ asideId: z.string(), language: z.string() }),
  },
  /** A follow-up, which only works while the fork is still alive. */
  /**
   * Explain or translate what the aside last said, in the same aside.
   *
   * No excerpt, and that is the guard: main reads the aside's own latest answer
   * out of the log, so the renderer chooses *which of two things to do* and
   * never what words the agent is handed. `aside:open` needs an excerpt because
   * it names a passage in someone else's conversation; this one cannot.
   */

  'aside:restate': {
    request: z.object({
      asideId: z.string(),
      purpose: z.enum(['explanation', 'translation']),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  'aside:ask': {
    request: z.object({ asideId: z.string(), question: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  /**
   * Turns an aside into a conversation of its own, able to act.
   *
   * The profile is chosen here rather than inherited: it is the explicit act
   * that makes acting safe, and a room that silently arrived with the parent's
   * permissions would be the thing the aside design refused.
   */
  'aside:promote': {
    request: z.object({ asideId: z.string(), profileId: z.string() }),
    /*
     * The whole session, as `conversation:reopen` returns — not just the id.
     *
     * Promotion decides the room's profile, title and cwd, and a renderer that
     * had to guess any of them would put a tab on screen describing something
     * other than what was opened.
     */
    response: z.object({
      conversationId: z.string(),
      participants: z.array(AgentIdSchema),
      profileId: z.string(),
      projectId: z.string(),
      cwd: z.string(),
      title: z.string(),
      unread: z.number().int().min(0),
    }),
  },
  /**
   * Sends what you decided in an aside back to the conversation it came from.
   *
   * The counterpart to `aside:promote`, and the opposite direction: promotion
   * takes the side question away into a room of its own, this returns a decision
   * to the work. What travels is the directive you typed plus one line naming
   * the passage it came from — never the side transcript, which would land in
   * the parent's log as prose every other agent must then be caught up on.
   *
   * It answers with the routing `conversation:send` answers with, because it is
   * that call: the renderer needs to know who picked it up, and a forward that
   * reached nobody is a failure the composer already knows how to report.
   */
  'aside:forward': {
    request: z.object({ asideId: z.string(), directive: z.string().min(1) }),
    response: z.object({ targets: z.array(AgentIdSchema) }),
  },
  /** Ends the fork. The transcript stays in the log. */
  'aside:close': {
    request: z.object({ asideId: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  /** What has already been asked about a conversation, or about one reply in it. */
  'aside:list': {
    request: z.object({ conversationId: z.string(), sourceEventId: z.string().optional() }),
    response: z.array(
      z.object({
        id: z.string(),
        sourceEventId: z.string(),
        title: z.string(),
        createdAt: z.number().int(),
      })
    ),
  },
  /** Recent log entries, already redacted as they were written. */
  /**
   * What a new session starts with. Defaults only — a session still chooses its
   * own agents, directory and profile.
   */
  'settings:read': {
    request: z.object({}),
    response: SettingsWithSecrets,
  },
  /** A patch: sending only what changed keeps one field from clobbering another. */
  'settings:write': {
    request: z.object({
      cwd: z.string().optional(),
      profileId: z.string().optional(),
      model: z.string().optional(),
      effortLevel: z.string().optional(),
      explainLanguage: z.string().transform(normaliseExplainLanguage).optional(),
      styleOnByDefault: z.boolean().optional(),
      theme: z.enum(['system', 'light', 'dark']).optional(),
      completionProvider: z.enum(['auto', 'deepseek', 'codestral']).optional(),
      notifications: z.boolean().optional(),
      trafficRequestFraction: TrafficRequestFraction.optional(),
      trafficOrigin: z.string().optional(),
      models: z
        .object(agentRecord(() => z.string()))
        .partial()
        .optional(),
      efforts: z
        .object(agentRecord(() => z.string()))
        .partial()
        .optional(),
      /**
       * Write-only, and the asymmetry with the response is the design.
       *
       * An empty string clears the stored key; absent leaves it alone. It is
       * never echoed back and never appears in `SettingsWithSecrets`, because a
       * renderer that can read a provider credential is a renderer that can put
       * one in a transcript.
       */
      deepseekApiKey: z.string().optional(),
      /** Same contract as `deepseekApiKey`: empty clears, absent leaves alone. */
      typesafeApiKey: z.string().optional(),
      completionDeepseekApiKey: z.string().optional(),
      completionCodestralApiKey: z.string().optional(),
    }),
    response: SettingsWithSecrets,
  },
  'diagnostics:read': {
    request: z.void(),
    response: z.array(
      z.object({
        at: z.number().int(),
        level: z.enum(['debug', 'info', 'warn', 'error']),
        message: z.string(),
        fields: z.record(z.string(), z.unknown()).optional(),
      })
    ),
  },
  /** Writes a bundle to disk and returns where it landed. */
  'diagnostics:export': {
    request: z.void(),
    response: z.object({ path: z.string() }),
  },
  /** The permission profiles a conversation can be started under. */
  /** Changes what agents may do without asking, in a conversation already open. */
  'policy:set': {
    request: z.object({ conversationId: z.string(), profileId: z.string() }),
    response: z.object({ profileId: z.string() }),
  },
  'policy:profiles': {
    request: z.void(),
    response: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })),
  },

  /**
   * The selected text, asked for at Send (plan §5).
   *
   * Separate from the live push because it is the only moment source code
   * crosses into Chorus, and it happens because the user pressed a button.
   */
  /**
   * Open one file from this conversation, in this project's own editor.
   *
   * **The request names a conversation and a path, never a directory.** Main
   * resolves the path against that conversation's own project directory and
   * refuses anything outside it — the same shape `ide:snapshot` uses, and for
   * the same reason: a path arriving from the renderer is untrusted input about
   * to be handed to a process.
   *
   * **The embedded workbench wins, and external VS Code is the fallback** for a
   * project whose Editor switch is off. `ide:snapshot` resolves the same way.
   *
   * **A position rides in `path`** as `file.ts:42`, rather than as fields of
   * its own. That is the form agents write and the form `code -g` already
   * takes, so the request shape did not have to grow to carry it;
   * `splitFileLocation` in `main/ipc.ts` is the one place it is taken apart.
   *
   * `reason` is `cli-missing`, `open-failed`, or `outside-project` for a path
   * that failed containment. A workbench that
   * refused — no such file, an editor that would not open it — reports
   * `open-failed`, which is what it is from the clicker's side.
   */
  'ide:openFile': {
    request: z.object({ conversationId: z.string(), path: z.string() }),
    /*
     * `path` and `project` are what the refusal is *about*, and they are here
     * because the message could not be acted on without them: "that file is not
     * inside this session's project folder" named neither the file nor the
     * folder, so a genuine escape and a bug in the check read identically.
     * Optional, because only the containment refusal has anything to say.
     */
    response: z.object({
      ok: z.boolean(),
      reason: z.string().nullable(),
      path: z.string().optional(),
      project: z.string().optional(),
    }),
  },

  'ide:snapshot': {
    request: z.object({ conversationId: z.string() }),
    response: IdeSnapshotResult,
  },

  /**
   * Mount a terminal view, spawning its shell if nothing has yet.
   *
   * Returns the screen as escape sequences rather than a suffix of raw output,
   * because VT state is cumulative and a trimmed byte ring loses the
   * alternate-screen entry and the colour that came before it — `vim` remounts
   * blank. The `epoch` supersedes any previous attachment and stamps everything
   * after it.
   */
  'terminal:attach': {
    request: z.object({
      ref: TerminalRefShape,
      cols: z.number().int().min(1).optional(),
      rows: z.number().int().min(1).optional(),
    }),
    response: z
      .object({
        epoch: z.number().int(),
        generation: z.number().int(),
        snapshot: z.string(),
        seq: z.number().int(),
        cols: z.number().int(),
        rows: z.number().int(),
        /*
         * How the shell ended, or null while it is running.
         *
         * On the attach rather than only on the push because `exit` fires once and
         * only the active tab of a panel is mounted: a shell that dies in the
         * background has no view to tell, and reopening its tab would show a dead
         * shell looking alive.
         */
        exitCode: z.number().int().nullable(),
      })
      .nullable(),
  },

  /**
   * Unmount a view. **This is not a kill** — the shell keeps running.
   *
   * React effect cleanup calls this, and only this. If it disposed, backgrounding
   * a tab would kill a running build, which is the whole reason the PTY lives in
   * main rather than beside the component.
   */
  'terminal:detach': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Kill the shell. A conversation ending, or the user asking explicitly. */
  'terminal:dispose': {
    request: z.object({ ref: TeardownTerminalRefShape, epoch: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Kill a shell the user pointed at in a list. **No epoch.**
   *
   * `terminal:dispose` is epoch-guarded because its caller is a mounted
   * `TerminalView`, and a dispose carrying a superseded epoch is a stale click
   * from a view that has already been replaced. A tab strip is a different actor
   * with a different lifetime: only the *active* tab is mounted, so a background
   * tab has no attachment and therefore no epoch to offer at all.
   *
   * Weakening `dispose` to a nullable epoch would take the guard off every
   * caller to serve this one. A separate channel keeps the guarantee where it
   * belongs and states, in its name and here, who may call it: a mounted strip
   * acting on a gesture.
   */
  'terminal:kill': {
    request: z.object({ ref: TeardownTerminalRefShape }),
    response: z.object({ ok: z.literal(true) }),
  },

  'terminal:write': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int(), data: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** New geometry, so `SIGWINCH` fires and `vim` reflows. */
  'terminal:resize': {
    request: z.object({
      ref: TerminalRefShape,
      epoch: z.number().int(),
      cols: z.number().int().min(1),
      rows: z.number().int().min(1),
    }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * The view has consumed output up to `seq`.
   *
   * The wire half of flow control. Without it the watermark can only see the
   * headless mirror in main, and a renderer that cannot keep up accumulates an
   * unbounded queue in the process that must not stall.
   */
  'terminal:ack': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int(), seq: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /**
   * Throw away the scrollback, as `⌘K` does in Terminal.app.
   *
   * Goes through main because the snapshot a remount restores from lives there:
   * clearing only the view would put every cleared line back on the next tab
   * switch. The shell is not told — `⌘K` is a display action, and a half-typed
   * command survives it.
   */
  'terminal:clear': {
    request: z.object({ ref: TerminalRefShape, epoch: z.number().int() }),
    response: z.object({ ok: z.literal(true) }),
  },

  /** Whether killing this would lose work, for a confirmation to decide on. */
  'terminal:describe': {
    request: z.object({ ref: TerminalRefShape }),
    response: z
      .object({
        running: z.boolean(),
        foreground: z.string(),
        busy: z.boolean(),
        exitCode: z.number().int().nullable(),
      })
      .nullable(),
  },
} as const

/**
 * Main-to-renderer push. Separate from the request/response contract because it
 * flows the other way and has no reply.
 */
export const EVENTS_PUSH_CHANNEL = 'conversation:events'

/**
 * The editor context for each open conversation, pushed as it changes.
 *
 * A push rather than a query because the whole point is that it follows what
 * the user is doing in another application; polling would show them where they
 * were.
 */
export const IDE_PUSH_CHANNEL = 'ide:context'

/**
 * A problem someone sent from VS Code, on its way to a composer.
 *
 * **The one push that begins outside Chorus.** Everything else on these channels
 * is Chorus reporting its own state; this is a person in another application
 * asking for something to appear here. It carries source text, which no other
 * push does — `IdeContextPush` deliberately carries none — and that is why it
 * lands in a draft for the user to send rather than reaching an agent.
 *
 * `conversationId` is decided in main, not by the extension, which knows only a
 * root. A root with no conversation open on it is dropped there: putting a
 * compiler error into a conversation about something else is worse than putting
 * it nowhere.
 *
 * The path is relative, as `IdeContextPush`'s is, so a pane cannot display —
 * or screenshot — where the project sits on disk.
 */
export const DIAGNOSTIC_PUSH_CHANNEL = 'ide:diagnostic'

export const DiagnosticPush = z.object({
  conversationId: z.string(),
  relativePath: z.string(),
  languageId: z.string(),
  severity: z.enum(['error', 'warning', 'information', 'hint']),
  source: z.string().optional(),
  code: z.string().optional(),
  message: z.string(),
  /** One-based and inclusive, converted once in main like every other range. */
  startLine: z.number().int(),
  endLine: z.number().int(),
  text: z.string(),
})
export type DiagnosticPush = z.infer<typeof DiagnosticPush>

/**
 * Settings, pushed to every window whenever any of them writes.
 *
 * **A read on mount is not enough for anything a pane draws continuously.**
 * `explainLanguage` decides whether an Explain button exists under every reply,
 * and it was being read when the settings sheet closed — which is the only path
 * a person takes, and not the only path there is. A second window, or anything
 * writing through the channel directly, left every open pane holding a value
 * that had stopped being true. The e2e suite is what found it.
 *
 * The whole settings object rather than the field that prompted this: the reason
 * generalises, nothing here is secret, and a channel per preference is how you
 * end up with five of them.
 */
export const SETTINGS_PUSH_CHANNEL = 'settings:changed'

/**
 * The window's zoom factor, pushed whenever it changes.
 *
 * Zoom is owned by the menu, so the renderer has no other way to learn it — and
 * it needs to, in order to say what just happened.
 */
export const SCALE_PUSH_CHANNEL = 'settings:scale'

/**
 * Account usage windows, pushed as providers report them.
 *
 * A push rather than a query because nothing asks: the numbers arrive when an
 * agent happens to talk to its provider, and a header that only updated when you
 * opened something would be showing you yesterday.
 */
export const LIMITS_PUSH_CHANNEL = 'agents:limits'

export const UsageWindowShape = z.object({
  id: z.string(),
  usedPercent: z.number().nullable(),
  windowMinutes: z.number().nullable(),
  resetsAt: z.number().nullable(),
})
export type UsageWindowShape = z.infer<typeof UsageWindowShape>

export const LimitsPush = z.object({
  agentId: AgentIdSchema,
  windows: z.array(UsageWindowShape),
})
export type LimitsPush = z.infer<typeof LimitsPush>

/**
 * How full each agent's context window is, pushed at the end of a turn.
 *
 * A push for the same reason limits are, and a separate channel from them
 * because the scope differs: a plan window belongs to the account and reads the
 * same from anywhere, while this belongs to one conversation's agent. Folding
 * them together would mean a number that is only true for the pane you happen
 * to be looking at arriving on a channel that is not about panes.
 */
/**
 * A nudge that a repository moved. **Not the diff.**
 *
 * State, not history, and it is never written to the log: git is already the
 * durable record of what is on disk, so a second copy in SQLite would be a
 * history of a number that goes backwards every time someone checks out a
 * branch. Reading it back a week later would be worse than having none.
 *
 * The payload is deliberately just an id. Each panel is showing its own base —
 * one may be against `develop`, another against the working tree — so main
 * cannot know what to recompute, and sending "something changed" lets every
 * panel re-ask for the thing it is actually displaying. It also keeps the
 * watcher cheap: no diff runs unless a panel is open to want one.
 */

export const CONTEXT_PUSH_CHANNEL = 'agents:context'

export const ContextUsagePush = z.object({
  conversationId: z.string(),
  agentId: AgentIdSchema,
  usedTokens: z.number().int(),
  maxTokens: z.number().int(),
  percentUsed: z.number(),
  autoCompactPercent: z.number().nullable(),
  autoCompactEnabled: z.boolean(),
})
export type ContextUsagePush = z.infer<typeof ContextUsagePush>

/**
 * What an agent has left running, for one conversation.
 *
 * A push and never a log row, for the reason on `TasksChanged`: it is a
 * snapshot of live processes, and they stop existing when the session does.
 * Scoped like the context window rather than like limits — tasks belong to one
 * conversation's agent, not to the account.
 *
 * The list replaces whatever came before, including when it is empty. An empty
 * push is the only thing that can say the last task finished.
 */
export const TASKS_PUSH_CHANNEL = 'agents:tasks'

export const TasksPush = z.object({
  conversationId: z.string(),
  agentId: AgentIdSchema,
  tasks: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      description: z.string(),
    })
  ),
})
export type TasksPush = z.infer<typeof TasksPush>

/**
 * What an agent says it is doing, for one conversation.
 *
 * The fourth of the same family and the one that arrives most often — many
 * times a turn, which is exactly why it is a push and never a `ChorusEventPayload`:
 * written down it would append to SQLite for the length of every turn, and
 * "claude was requesting at 09:23" read back a week later is worse than nothing.
 *
 * `activity: null` is a real value, not an absence. It says the agent has
 * stopped doing the thing it named — a finished compaction — and is what stops
 * the working line insisting on a word that is no longer true. The renderer
 * still shows its own rotating word underneath, because an agent says nothing
 * for most of a turn.
 *
 * It carries no notion of whether a turn is running. `turn.started` and
 * `turn.completed` are the boundaries and they are in the log where they can be
 * replayed; a second opinion travelling on a channel nothing persists is how
 * the two would drift apart.
 */
export const ACTIVITY_PUSH_CHANNEL = 'agents:activity'

export const ActivityPush = z.object({
  conversationId: z.string(),
  agentId: AgentIdSchema,
  activity: z.enum(['requesting', 'compacting', 'thinking', 'awaitingInput']).nullable(),
})
export type ActivityPush = z.infer<typeof ActivityPush>

export const ATTENTION_PUSH_CHANNEL = 'agents:attention'

const AttentionMode = z.enum(['toast', 'banner'])

const ApprovalAttention = z.object({
  reason: z.literal('approval'),
  conversationId: z.string(),
  projectId: z.string(),
  title: z.string(),
  agentId: AgentIdSchema,
  approvalId: z.string(),
  kind: z.enum(['command', 'fileChange', 'permissionGrant', 'mcpToolCall', 'editorEdit']),
  request: z.unknown(),
})

const QuestionAttention = z.object({
  reason: z.literal('question'),
  conversationId: z.string(),
  projectId: z.string(),
  title: z.string(),
  agentId: AgentIdSchema,
  userInputId: z.string(),
  request: z.unknown(),
})

const IdleAttention = z.object({
  reason: z.literal('idle'),
  conversationId: z.string(),
  projectId: z.string(),
  title: z.string(),
  agentId: AgentIdSchema,
})

export const AttentionPush = z.discriminatedUnion('reason', [
  ApprovalAttention.extend({ mode: AttentionMode }),
  QuestionAttention.extend({ mode: AttentionMode }),
  IdleAttention.extend({ mode: AttentionMode }),
])
export type AttentionPush = z.infer<typeof AttentionPush>

export type AttentionEvent =
  | z.infer<typeof ApprovalAttention>
  | z.infer<typeof QuestionAttention>
  | z.infer<typeof IdleAttention>

export const CONVERSATION_NOTE_PUSH_CHANNEL = 'conversation:note'

export const ConversationNotePush = z
  .object({ conversationId: z.string(), note: ConversationNoteShape.nullable() })
  .strict()
export type ConversationNotePush = z.infer<typeof ConversationNotePush>

export const CONVERSATION_NOTE_JOURNAL_CHANNEL = 'conversation:noteJournal'
export const CONVERSATION_NOTE_JOURNAL_ASYNC_CHANNEL = 'conversation:noteJournalAsync'
export const CONVERSATION_NOTE_JOURNAL_PUSH_CHANNEL = 'conversation:noteJournalChanged'

export const CONVERSATION_NOTE_JOURNAL_MAX_LENGTH = CONVERSATION_NOTE_MAX_LENGTH * 6 + 1_024

const NoteJournalConversation = z.string().min(1).max(128)
const NoteJournalRaw = z.string().max(CONVERSATION_NOTE_JOURNAL_MAX_LENGTH).nullable()

export const ConversationNoteJournalPush = z
  .object({ conversationId: NoteJournalConversation })
  .strict()
export type ConversationNoteJournalPush = z.infer<typeof ConversationNoteJournalPush>

export const ConversationNoteJournalRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('read'), conversationId: NoteJournalConversation }).strict(),
  z
    .object({
      op: z.literal('compare'),
      conversationId: NoteJournalConversation,
      expected: NoteJournalRaw,
      next: NoteJournalRaw,
    })
    .strict(),
])
export type ConversationNoteJournalRequest = z.infer<typeof ConversationNoteJournalRequest>

export const ConversationNoteJournalResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), matched: z.boolean(), current: NoteJournalRaw }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(512) }).strict(),
])
export type ConversationNoteJournalResponse = z.infer<typeof ConversationNoteJournalResponse>

export const SHELL_PRESENCE_CHANNEL = 'shell:presence'
export const ENGINE_STATUS_CHANNEL = 'engine:status'
export const ENGINE_UPDATE_CHANNEL = 'engine:update'

export const ShellPresence = z
  .object({
    projectIds: z.array(z.string()),
    focusedProjectId: z.string().nullable(),
    attentive: z.boolean(),
    visible: z.boolean(),
  })
  .strict()
export type ShellPresence = z.infer<typeof ShellPresence>

export const EngineStatus = z
  .object({
    state: z.enum(['connecting', 'connected', 'reconnecting', 'stopped', 'restart-required']),
  })
  .strict()
export type EngineStatus = z.infer<typeof EngineStatus>

export const EngineUpdate = z.object({ version: z.string(), build: z.string() }).strict()
export type EngineUpdate = z.infer<typeof EngineUpdate>

export interface DesktopShellApi {
  presence(report: ShellPresence): void
  onEngineStatus(listener: (status: EngineStatus) => void): () => void
  onEngineUpdate(listener: (update: EngineUpdate) => void): () => void
}

export const REVEAL_PUSH_CHANNEL = 'conversation:revealed'

export const RevealPush = IPC_CONTRACT['conversation:reveal'].request
export type RevealPush = z.infer<typeof RevealPush>

/**
 * Terminal output, and the shell's exit.
 *
 * A push and **never a log event**. The log records the conversation, a shell is
 * a second stream that happens to share a pane, and the global terminal has no
 * `conversationId` to file one under at all. It is also the sharpest instance of
 * the unsolved half of C-021 — `cat .env`, `env`, a pasted token — and nothing
 * scrubs a shell.
 *
 * `seq` is monotonic per terminal so a view can align a snapshot against the
 * live stream; `epoch` lets main's pushes be ignored by a view that has since
 * been superseded. One push carries a frame's worth of chunks, so `seq` is the
 * last one it contains.
 */
export const TERMINAL_PUSH_CHANNEL = 'terminal:output'

export const TerminalPush = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('data'),
    ref: TerminalRefShape,
    epoch: z.number().int(),
    generation: z.number().int(),
    seq: z.number().int(),
    data: z.string(),
  }),
  z.object({
    kind: z.literal('exit'),
    ref: TerminalRefShape,
    epoch: z.number().int(),
    generation: z.number().int(),
    code: z.number().int(),
  }),
  z.object({
    kind: z.literal('replaced'),
    ref: TerminalRefShape,
    generation: z.number().int(),
  }),
])
export type TerminalPush = z.infer<typeof TerminalPush>

export const EventsPush = z.array(TranscriptEvent)
export type EventsPush = z.infer<typeof EventsPush>

export type IpcContract = typeof IPC_CONTRACT
export type IpcChannel = keyof IpcContract

export type IpcRequest<C extends IpcChannel> = z.infer<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContract[C]['response']>

export const IPC_CHANNELS = Object.keys(IPC_CONTRACT) as IpcChannel[]

export function isIpcChannel(value: string): value is IpcChannel {
  return Object.hasOwn(IPC_CONTRACT, value)
}

/**
 * The shape exposed on `window.chorus`. It lives here rather than in the preload
 * so the renderer never has to import a module that pulls in Electron — the
 * renderer is sandboxed and that import would typecheck but fail at runtime.
 */
/**
 * `WorkbenchShellApi` is mixed in rather than declared here, because its four
 * channels are not in `IPC_CONTRACT` — they are answered by a registrar that
 * validates `event.sender`. The shape belongs beside the channels it names.
 */
export interface ChorusApi
  extends WorkbenchShellApi, DetachedWindowApi, TrafficApi, RunApi, GitApi, BrowserApi, ConsoleApi {
  readonly getAppInfo: () => Promise<AppInfo>
  /** Asks; the answer arrives on `onLimits`. */
  readonly refreshLimits: () => Promise<{ ok: true }>
  readonly setBadge: (request: { count: number }) => Promise<{ ok: true }>
  readonly notify: (request: {
    title: string
    body: string
    projectId: string
  }) => Promise<{ ok: true }>
  readonly revealConversation: (request: IpcRequest<'conversation:reveal'>) => Promise<{ ok: true }>
  readonly copyText: (request: { text: string }) => Promise<{ ok: true }>
  readonly probeAgents: () => Promise<AgentProbeResult[]>
  readonly startConversation: (
    request: IpcRequest<'conversation:start'>
  ) => Promise<IpcResponse<'conversation:start'>>
  readonly beginConversation: (
    request: IpcRequest<'conversation:begin'>
  ) => Promise<IpcResponse<'conversation:begin'>>
  readonly awaitStart: (
    request: IpcRequest<'conversation:awaitStart'>
  ) => Promise<IpcResponse<'conversation:awaitStart'>>
  readonly sendMessage: (
    request: IpcRequest<'conversation:send'>
  ) => Promise<IpcResponse<'conversation:send'>>
  readonly interrupt: (request: IpcRequest<'conversation:interrupt'>) => Promise<{ ok: true }>
  readonly closeProject: (request: IpcRequest<'project:close'>) => Promise<{ ok: true }>
  readonly closeConversation: (request: IpcRequest<'conversation:close'>) => Promise<{ ok: true }>
  readonly restoreConversations: () => Promise<IpcResponse<'conversation:restore'>>
  readonly readActiveSessions: () => Promise<IpcResponse<'conversation:active'>>
  readonly markSeen: (request: IpcRequest<'conversation:markSeen'>) => Promise<{ ok: true }>
  readonly rememberDraft: (request: IpcRequest<'conversation:draft'>) => Promise<{ ok: true }>
  readonly setPlanMode: (
    request: IpcRequest<'conversation:planMode'>
  ) => Promise<IpcResponse<'conversation:planMode'>>
  readonly setAnswerStyle: (
    request: IpcRequest<'conversation:answerStyle'>
  ) => Promise<IpcResponse<'conversation:answerStyle'>>
  readonly completeFiles: (
    request: IpcRequest<'files:complete'>
  ) => Promise<IpcResponse<'files:complete'>>
  readonly listCommands: (
    request: IpcRequest<'conversation:commands'>
  ) => Promise<IpcResponse<'conversation:commands'>>
  readonly listConversations: () => Promise<IpcResponse<'conversation:list'>>
  readonly reopenConversation: (
    request: IpcRequest<'conversation:reopen'>
  ) => Promise<IpcResponse<'conversation:reopen'>>
  readonly previewFile: (
    request: IpcRequest<'files:preview'>
  ) => Promise<IpcResponse<'files:preview'>>
  readonly stashFile: (request: IpcRequest<'files:stash'>) => Promise<IpcResponse<'files:stash'>>
  readonly stashNoteImage: (
    request: IpcRequest<'files:stashNoteImage'>
  ) => Promise<IpcResponse<'files:stashNoteImage'>>
  /** Opens a folder chooser and returns what was picked, or null if cancelled. */
  readonly chooseDirectory: () => Promise<IpcResponse<'files:chooseDirectory'>>
  /** The real path of a dropped file; `File.path` was removed in Electron 32. */
  readonly pathForFile: (file: File) => string
  readonly writeConversationLayout: (
    request: IpcRequest<'conversation:layout'>
  ) => Promise<{ ok: true }>
  readonly renameConversation: (
    request: IpcRequest<'conversation:rename'>
  ) => Promise<IpcResponse<'conversation:rename'>>
  readonly adoptProject: (
    request: IpcRequest<'project:adopt'>
  ) => Promise<IpcResponse<'project:adopt'>>
  readonly adoptRemoteProject: (
    request: IpcRequest<'project:adoptRemote'>
  ) => Promise<IpcResponse<'project:adoptRemote'>>
  readonly checkRemoteHost: (
    request: IpcRequest<'project:checkRemoteHost'>
  ) => Promise<IpcResponse<'project:checkRemoteHost'>>
  readonly listProjects: (
    request: IpcRequest<'project:list'>
  ) => Promise<IpcResponse<'project:list'>>
  readonly renameProject: (
    request: IpcRequest<'project:rename'>
  ) => Promise<IpcResponse<'project:rename'>>
  readonly reorderProjects: (
    request: IpcRequest<'project:reorder'>
  ) => Promise<IpcResponse<'project:reorder'>>
  readonly forgetProject: (
    request: IpcRequest<'project:forget'>
  ) => Promise<IpcResponse<'project:forget'>>
  readonly relocateProject: (
    request: IpcRequest<'project:relocate'>
  ) => Promise<IpcResponse<'project:relocate'>>
  readonly setProjectProfile: (
    request: IpcRequest<'project:setProfile'>
  ) => Promise<IpcResponse<'project:setProfile'>>
  readonly setProjectNotes: (
    request: IpcRequest<'project:setNotes'>
  ) => Promise<IpcResponse<'project:setNotes'>>
  readonly getConversationNote: (
    request: IpcRequest<'conversation:getNote'>
  ) => Promise<IpcResponse<'conversation:getNote'>>
  readonly setConversationNoteText: (
    request: IpcRequest<'conversation:setNoteText'>
  ) => Promise<IpcResponse<'conversation:setNoteText'>>
  readonly setConversationNoteView: (
    request: IpcRequest<'conversation:setNoteView'>
  ) => Promise<IpcResponse<'conversation:setNoteView'>>
  readonly prepareConversationNoteJournal: (request: {
    readonly conversationId: string
  }) => Promise<void>
  readonly readConversationNoteJournal: (request: {
    readonly conversationId: string
  }) => ConversationNoteJournalResponse
  readonly compareConversationNoteJournal: (request: {
    readonly conversationId: string
    readonly expected: string | null
    readonly next: string | null
  }) => ConversationNoteJournalResponse
  readonly getAppNote: (request: IpcRequest<'app:getNote'>) => Promise<IpcResponse<'app:getNote'>>
  readonly setAppNote: (request: IpcRequest<'app:setNote'>) => Promise<IpcResponse<'app:setNote'>>
  readonly listKeptNotes: (
    request: IpcRequest<'app:listKeptNotes'>
  ) => Promise<IpcResponse<'app:listKeptNotes'>>
  readonly createKeptNote: (
    request: IpcRequest<'app:createKeptNote'>
  ) => Promise<IpcResponse<'app:createKeptNote'>>
  readonly setKeptNote: (
    request: IpcRequest<'app:setKeptNote'>
  ) => Promise<IpcResponse<'app:setKeptNote'>>
  readonly removeKeptNote: (
    request: IpcRequest<'app:removeKeptNote'>
  ) => Promise<IpcResponse<'app:removeKeptNote'>>
  readonly reorderKeptNotes: (
    request: IpcRequest<'app:reorderKeptNotes'>
  ) => Promise<IpcResponse<'app:reorderKeptNotes'>>
  readonly setAppNoteSize: (
    request: IpcRequest<'app:setNoteSize'>
  ) => Promise<IpcResponse<'app:setNoteSize'>>
  readonly setProjectNoteSize: (
    request: IpcRequest<'project:setNoteSize'>
  ) => Promise<IpcResponse<'project:setNoteSize'>>
  readonly addNoteImage: (
    request: IpcRequest<'app:addNoteImage'>
  ) => Promise<IpcResponse<'app:addNoteImage'>>
  readonly pickNoteImage: (
    request: IpcRequest<'app:pickNoteImage'>
  ) => Promise<IpcResponse<'app:pickNoteImage'>>
  readonly fetchNoteImage: (
    request: IpcRequest<'app:fetchNoteImage'>
  ) => Promise<IpcResponse<'app:fetchNoteImage'>>
  readonly onScale: (listener: (scale: number) => void) => () => void
  readonly onSettings: (listener: (settings: IpcResponse<'settings:read'>) => void) => () => void
  readonly onDiagnostic: (listener: (diagnostic: DiagnosticPush) => void) => () => void
  readonly onLimits: (listener: (limits: LimitsPush) => void) => () => void
  readonly onContextUsage: (listener: (usage: ContextUsagePush) => void) => () => void
  readonly onTasks: (listener: (tasks: TasksPush) => void) => () => void
  readonly onConversationNote: (listener: (push: ConversationNotePush) => void) => () => void
  readonly onConversationNoteJournal: (
    listener: (push: ConversationNoteJournalPush) => void
  ) => () => void
  readonly onActivity: (listener: (activity: ActivityPush) => void) => () => void
  readonly onAttention: (listener: (attention: AttentionPush) => void) => () => void
  readonly onRevealConversation: (listener: (reveal: RevealPush) => void) => () => void

  /**
   * Subscribe **before** attaching, not after.
   *
   * `attach` returns a snapshot taken at a sequence number; anything the shell
   * writes between that snapshot being taken and a subscription going live would
   * otherwise be lost. Subscribing first and discarding pushes at or below the
   * snapshot's `seq` closes it from this side — the alternative, buffering
   * per-attachment in main, puts an unbounded queue in the process that must not
   * stall.
   */
  readonly onTerminalOutput: (listener: (push: TerminalPush) => void) => () => void
  readonly attachTerminal: (
    request: IpcRequest<'terminal:attach'>
  ) => Promise<IpcResponse<'terminal:attach'>>
  readonly detachTerminal: (
    request: IpcRequest<'terminal:detach'>
  ) => Promise<IpcResponse<'terminal:detach'>>
  readonly disposeTerminal: (
    request: IpcRequest<'terminal:dispose'>
  ) => Promise<IpcResponse<'terminal:dispose'>>
  readonly killTerminal: (
    request: IpcRequest<'terminal:kill'>
  ) => Promise<IpcResponse<'terminal:kill'>>
  readonly writeTerminal: (
    request: IpcRequest<'terminal:write'>
  ) => Promise<IpcResponse<'terminal:write'>>
  readonly resizeTerminal: (
    request: IpcRequest<'terminal:resize'>
  ) => Promise<IpcResponse<'terminal:resize'>>
  readonly ackTerminal: (
    request: IpcRequest<'terminal:ack'>
  ) => Promise<IpcResponse<'terminal:ack'>>
  readonly clearTerminal: (
    request: IpcRequest<'terminal:clear'>
  ) => Promise<IpcResponse<'terminal:clear'>>
  readonly describeTerminal: (
    request: IpcRequest<'terminal:describe'>
  ) => Promise<IpcResponse<'terminal:describe'>>

  readonly knownModels: () => Promise<IpcResponse<'agents:models'>>
  readonly mcpServers: () => Promise<IpcResponse<'agents:mcp'>>
  readonly accounts: () => Promise<IpcResponse<'agents:account'>>
  readonly plugins: () => Promise<IpcResponse<'agents:plugins'>>
  readonly installSkill: (
    request: IpcRequest<'agents:installSkill'>
  ) => Promise<IpcResponse<'agents:installSkill'>>
  readonly checkServiceKey: (
    request: IpcRequest<'agents:checkServiceKey'>
  ) => Promise<IpcResponse<'agents:checkServiceKey'>>
  readonly stopTask: (request: IpcRequest<'tasks:stop'>) => Promise<IpcResponse<'tasks:stop'>>
  readonly readSettings: () => Promise<IpcResponse<'settings:read'>>
  readonly writeSettings: (
    request: IpcRequest<'settings:write'>
  ) => Promise<IpcResponse<'settings:write'>>
  readonly history: (
    request: IpcRequest<'conversation:history'>
  ) => Promise<IpcResponse<'conversation:history'>>
  readonly transcript: (
    request: IpcRequest<'conversation:transcript'>
  ) => Promise<IpcResponse<'conversation:transcript'>>
  readonly taskState: (request: IpcRequest<'task:state'>) => Promise<IpcResponse<'task:state'>>
  readonly closeTask: (request: IpcRequest<'task:close'>) => Promise<IpcResponse<'task:close'>>
  readonly bindAssignment: (
    request: IpcRequest<'task:bindAssignment'>
  ) => Promise<IpcResponse<'task:bindAssignment'>>
  readonly decideApproval: (request: ApprovalChoice) => Promise<{ ok: true }>
  readonly answerQuestion: (request: QuestionAnswer) => Promise<{ ok: true }>
  readonly profiles: () => Promise<IpcResponse<'policy:profiles'>>
  readonly setProfile: (request: IpcRequest<'policy:set'>) => Promise<IpcResponse<'policy:set'>>
  readonly readDiagnostics: () => Promise<IpcResponse<'diagnostics:read'>>
  readonly exportDiagnostics: () => Promise<IpcResponse<'diagnostics:export'>>
  /** Fires when a conversation's repository moves. Carries no diff — see the channel. */
  readonly ideOpenFile: (
    request: IpcRequest<'ide:openFile'>
  ) => Promise<IpcResponse<'ide:openFile'>>
  readonly ideSnapshot: (
    request: IpcRequest<'ide:snapshot'>
  ) => Promise<IpcResponse<'ide:snapshot'>>
  readonly onIdeContext: (listener: (payload: IdeContextPush) => void) => () => void
  readonly openAside: (request: IpcRequest<'aside:open'>) => Promise<IpcResponse<'aside:open'>>
  readonly askAside: (request: IpcRequest<'aside:ask'>) => Promise<IpcResponse<'aside:ask'>>
  readonly restateAside: (
    request: IpcRequest<'aside:restate'>
  ) => Promise<IpcResponse<'aside:restate'>>
  readonly promoteAside: (
    request: IpcRequest<'aside:promote'>
  ) => Promise<IpcResponse<'aside:promote'>>
  readonly forwardAside: (
    request: IpcRequest<'aside:forward'>
  ) => Promise<IpcResponse<'aside:forward'>>
  readonly closeAside: (request: IpcRequest<'aside:close'>) => Promise<IpcResponse<'aside:close'>>
  readonly listAsides: (request: IpcRequest<'aside:list'>) => Promise<IpcResponse<'aside:list'>>
  /** Returns an unsubscribe function. */
  readonly onEvents: (listener: (events: TranscriptEvent[]) => void) => () => void
}
